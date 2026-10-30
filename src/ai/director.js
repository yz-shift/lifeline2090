// The AI director: glue between the simulation and the AI layer. Every method returns usable output whether or not
// AI is available: AI answers are validated (validate.js) and anything missing, failed or invalid falls back to the
// offline engine (core/decisions.js) or to templated Chinese text written here.
//
// API (dependency-injected factory, see docs/CHANGES.md):
//   const director = createDirector({ data, world, ai, decisions, engine });
//   director.setWorld(world)
//   director.getDecision(state, ctx?, {decision?}) -> { decision /* offline, immediate */, upgrade: Promise<Decision|null> }
//   director.prefetch(state) -> boolean                 // call after every stepYear; prefetches next year's milestone
//   director.resolveChoice(state, decision, choice, {onText, signal}?) -> Promise<{resolution, source, streamText?, error?}>
//   director.customAction(state, text, onText?, {signal}?) -> Promise<{resolution, source, streamText?, decision, choice}>
//   director.parseCustomBirth(text, {signal}?) -> Promise<partial BirthSpec | null>
//   director.birthStory(state, {signal}?) -> Promise<{text, tagline, source}>
//   director.biography(state, onText?, {signal}?) -> Promise<{title, bio, epitaph, highlights, source}>
//   director.usable(state) / director.status()
// Module-level: parseCustomBirth(text, data, opts?) for screens without a director instance.
// Model tier: the life's settings.aiMode ('off' never calls) unless claude.js's global tier is 'off'.

import * as defaultAI from './claude.js';
import * as P from './prompts.js';
import * as V from './validate.js';
import { Rng, hashString } from '../core/rng.js';
import { DECISION_FREQUENCY, HISTORY_END, STATS } from '../core/constants.js';

const isObj = V.isObj;
const toNum = V.toNum;
const TIERS = ['quick', 'default', 'complex'];

function cut(s, n) {
  if (s == null) return '';
  const a = Array.from(String(s).replace(/\s+/g, ' ').trim());
  return a.length <= n ? a.join('') : a.slice(0, Math.max(1, n - 1)).join('') + '…';
}

function warn(where, e) {
  try { console.warn('[director]', where, e && (e.message || e.code || e)); } catch { /* no console */ }
}

function cn(n) {
  const v = toNum(n);
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (a >= 1e4) return (v / 1e4).toFixed(a >= 1e6 ? 0 : 1).replace(/\.0$/, '') + '万';
  return String(Math.round(v));
}

function seriesOf(data, iso, key, year) {
  try {
    const v = data && typeof data.series === 'function' ? data.series(iso, key, year) : null;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function zeroEffects() {
  return { health: 0, happiness: 0, knowledge: 0, relationships: 0, wealthDelta: 0 };
}

function validDecisionShape(d) {
  return isObj(d) && typeof d.id === 'string' && d.title && Array.isArray(d.options) && d.options.length >= 2;
}

/* ------------------------------------------------------------------ offline: generic decisions and outcomes */

const GENERIC_DECISIONS = [
  { max: 11, title: '家里的安排', situation: '家里在商量你接下来几年的安排：是把更多时间和钱花在学习上，还是让你多些自由，多陪陪家人。',
    options: [['多上一些课外班', '学得更多，也更累', 'mid'], ['顺其自然地长大', '轻松一些，少些压力', 'low'], ['多帮家里做事', '更早懂事，也少了玩耍', 'low']] },
  { max: 17, title: '学业的方向', situation: '升学的关口越来越近，你要决定接下来把精力放在哪里。',
    options: [['埋头准备升学', '为考试全力以赴', 'mid'], ['学一门实用手艺', '更早找到饭碗', 'low'], ['发展自己的爱好', '也许能找到真正热爱的事', 'high']] },
  { max: 24, title: '走向社会', situation: '学生时代接近尾声，你站在了人生的岔路口。',
    options: [['继续深造', '用时间和钱换更高的学历', 'mid'], ['尽快找份工作', '先养活自己', 'low'], ['去大城市闯一闯', '机会多，压力也大', 'high']] },
  { max: 44, title: '生活的重心', situation: '工作和生活都在往前推，你要决定接下来几年把重心放在哪里。',
    options: [['专心发展事业', '收入可能提高，陪伴变少', 'mid'], ['多照顾家庭', '日子更踏实', 'low'], ['换个方向重新开始', '风险不小，也可能更好', 'high']] },
  { max: 64, title: '中年的抉择', situation: '人到中年，身体、家人和工作都在向你要时间。',
    options: [['保持现状', '稳稳当当，不折腾', 'low'], ['认真调理身体', '为后半生打基础', 'low'], ['去做一件一直想做的事', '可能圆梦，也可能留下遗憾', 'mid']] },
  { max: 200, title: '晚年的安排', situation: '退休前后，你在想剩下的日子要怎样过。',
    options: [['和家人住得近一些', '互相照应', 'low'], ['培养新的爱好', '让日子有盼头', 'low'], ['四处走走看看', '见识世界，也要量力而行', 'mid']] },
];

/** Stage-based generic decision, used only when core/decisions.js is unavailable or throws. */
export function genericDecision(state) {
  const age = toNum(state && state.age) ?? 30;
  const year = toNum(state && state.year) ?? 2025;
  const g = GENERIC_DECISIONS.find((x) => age <= x.max) || GENERIC_DECISIONS[GENERIC_DECISIONS.length - 1];
  return {
    id: `gen-${year}-${age}`, year, age, kind: 'milestone', title: g.title, situation: g.situation,
    options: g.options.map(([label, detail, risk], i) => ({ id: 'abcd'[i], label, detail, risk })),
    allowCustom: true, source: 'local',
  };
}

const GOOD_LINES = [
  '你选择了“{x}”。事情比预想的顺利一些，你也更清楚自己想要什么了。',
  '你选择了“{x}”。起初并不容易，但几个月后，日子慢慢走上了轨道。',
  '你选择了“{x}”。身边的人给了你不少支持，这一步走得还算踏实。',
];
const BAD_LINES = [
  '你选择了“{x}”。现实比想象中难，你走了些弯路，但也学到了东西。',
  '你选择了“{x}”。结果不尽如人意，你花了一段时间才重新振作起来。',
  '你选择了“{x}”。计划被现实打乱了几次，你只能边走边调整。',
];

/** Neutral templated outcome, used only when core/decisions.js is unavailable or throws. */
export function genericResolution(state, decision, choice, rng) {
  const opts = isObj(decision) && Array.isArray(decision.options) ? decision.options : [];
  const opt = isObj(choice) && choice.optionId ? opts.find((o) => o && o.id === choice.optionId) : null;
  const label = isObj(choice) && choice.customText ? cut(choice.customText, 24) : (opt && opt.label) || '顺其自然';
  const risk = (opt && opt.risk) || 'mid';
  const r = rng || new Rng(hashString(String((decision && decision.id) || 'x') + label));
  const good = r.next() < ({ low: 0.8, mid: 0.6, high: 0.4 }[risk] || 0.6);
  const lines = good ? GOOD_LINES : BAD_LINES;
  const narrative = lines[Math.floor(r.next() * lines.length)].replace('{x}', label);
  const size = risk === 'high' ? 6 : risk === 'mid' ? 4 : 2;
  const effects = zeroEffects();
  effects.happiness = good ? size : -Math.ceil(size / 2);
  effects.knowledge = 1;
  effects.relationships = good ? 1 : 0;
  return { narrative, effects, set: {}, threads: [], feasible: true };
}

/* ------------------------------------------------------------------ offline: custom birth text */

const CN_DIGITS = { '〇': '0', '零': '0', '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' };
const CN_SMALL = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

const PLACE_ALIASES = {
  大陆: 'CHN', 内地: 'CHN', 北京: 'CHN', 上海: 'CHN', 广州: 'CHN', 深圳: 'CHN', 成都: 'CHN', 重庆: 'CHN', 武汉: 'CHN',
  杭州: 'CHN', 南京: 'CHN', 西安: 'CHN', 天津: 'CHN', 东北: 'CHN', 台湾: 'TWN', 台北: 'TWN', 香港: 'HKG', 澳门: 'MAC',
  东京: 'JPN', 大阪: 'JPN', 首尔: 'KOR', 釜山: 'KOR', 平壤: 'PRK', 纽约: 'USA', 洛杉矶: 'USA', 旧金山: 'USA', 加州: 'USA',
  硅谷: 'USA', 芝加哥: 'USA', 德州: 'USA', 美利坚: 'USA', 伦敦: 'GBR', 英格兰: 'GBR', 苏格兰: 'GBR', 威尔士: 'GBR',
  巴黎: 'FRA', 柏林: 'DEU', 慕尼黑: 'DEU', 罗马: 'ITA', 米兰: 'ITA', 马德里: 'ESP', 莫斯科: 'RUS', 圣彼得堡: 'RUS',
  基辅: 'UKR', 孟买: 'IND', 新德里: 'IND', 德里: 'IND', 班加罗尔: 'IND', 卡拉奇: 'PAK', 拉合尔: 'PAK', 达卡: 'BGD',
  拉各斯: 'NGA', 开罗: 'EGY', 内罗毕: 'KEN', 约翰内斯堡: 'ZAF', 开普敦: 'ZAF', 圣保罗: 'BRA', 里约热内卢: 'BRA',
  墨西哥城: 'MEX', 布宜诺斯艾利斯: 'ARG', 悉尼: 'AUS', 墨尔本: 'AUS', 多伦多: 'CAN', 温哥华: 'CAN', 曼谷: 'THA',
  雅加达: 'IDN', 马尼拉: 'PHL', 河内: 'VNM', 胡志明市: 'VNM', 吉隆坡: 'MYS', 伊斯坦布尔: 'TUR', 德黑兰: 'IRN',
  迪拜: 'ARE', 利雅得: 'SAU', 加沙: 'PSE', 喀布尔: 'AFG', 巴格达: 'IRQ', 大马士革: 'SYR',
};

const NOTE_PATTERNS = [
  [/双胞胎|龙凤胎/, '双胞胎'], [/三胞胎/, '三胞胎'], [/单亲/, '单亲家庭'], [/孤儿/, '孤儿'], [/难民/, '难民家庭'],
  [/移民/, '移民家庭'], [/留守/, '留守儿童'], [/领养|收养/, '被收养'], [/早产/, '早产儿'], [/残疾|残障|先天/, '先天健康问题'],
  [/军人|军队|部队/, '军人家庭'], [/农民|务农|种地|种田/, '农民家庭'], [/渔民|打鱼/, '渔民家庭'], [/牧民|放牧/, '牧民家庭'],
  [/医生|护士/, '医护家庭'], [/教师|老师/, '教师家庭'], [/商人|做生意|经商|开店/, '经商家庭'], [/工人|工厂|打工/, '务工家庭'],
  [/少数民族/, '少数民族'], [/宗教|信仰/, '有宗教信仰的家庭'],
];

const aliasCache = new WeakMap();
function aliasIndex(data) {
  if (data && aliasCache.has(data)) return aliasCache.get(data);
  const list = [];
  for (const iso of V.isoListOf(data)) {
    const c = V.countryOf(data, iso);
    if (!c) continue;
    if (typeof c.name === 'string' && c.name.length >= 2) {
      list.push({ key: c.name, iso });
      const short = c.name.replace(/[（(].*?[）)]/g, '').trim();
      if (short.length >= 2 && short !== c.name) list.push({ key: short, iso });
    }
    if (typeof c.en === 'string' && c.en.length >= 4) list.push({ key: c.en.toLowerCase(), iso, latin: true });
  }
  for (const [k, iso] of Object.entries(PLACE_ALIASES)) if (V.hasIso(data, iso)) list.push({ key: k, iso });
  list.sort((a, b) => b.key.length - a.key.length);
  if (data && typeof data === 'object') aliasCache.set(data, list);
  return list;
}

function findCountry(text, data) {
  const low = text.toLowerCase();
  const taken = [];
  const hits = [];
  for (const a of aliasIndex(data)) {
    const hay = a.latin ? low : text;
    let from = 0;
    for (;;) {
      const at = hay.indexOf(a.key, from);
      if (at < 0) break;
      from = at + a.key.length;
      if (a.latin && (/[a-z]/.test(hay[at - 1] || '') || /[a-z]/.test(hay[at + a.key.length] || ''))) continue;
      const end = at + a.key.length;
      if (taken.some(([s, e]) => at < e && end > s)) continue;
      taken.push([at, end]);
      hits.push({ at, iso: a.iso });
    }
  }
  if (!hits.length) return null;
  const kw = /(出生在|出生于|生在|生于|出生地|长在|来自|born in)/gi;
  let best = null;
  let m;
  while ((m = kw.exec(text))) {
    const after = m.index + m[0].length;
    for (const h of hits) {
      const d = h.at - after;
      if (d >= 0 && d <= 12 && (!best || d < best.d)) best = { d, iso: h.iso };
    }
  }
  if (best) return best.iso;
  return hits.sort((a, b) => a.at - b.at)[0].iso;
}

function smallNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s in CN_SMALL) return CN_SMALL[s];
  if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN_SMALL[s[1]];
  return null;
}

/** Offline parser for the "特殊出身" free text. Conservative: only explicit mentions. -> partial BirthSpec | null */
export function offlineBirthParse(text, data) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const t = text.slice(0, 600).replace(/[〇零一二三四五六七八九]{4}(?=\s*年)/g, (s) => s.replace(/./g, (ch) => CN_DIGITS[ch]));
  const raw = { notes: [] };

  const ym = /(19\d{2}|20\d{2}|21\d{2})\s*年/.exec(t) || /(?:^|[^\d])(20[0-7]\d)(?:[^\d]|$)/.exec(t);
  if (ym) raw.year = Number(ym[1]);
  const md = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(t);
  if (md && raw.year) raw.date = `${raw.year}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`;

  const iso = findCountry(t, data);
  if (iso) raw.country = iso;

  const female = /(女孩|女婴|女儿|女生|女性|姑娘|闺女|胞胎(中的)?(妹妹|姐姐)|\bgirl\b|\bfemale\b|性别[:：\s]*女)/i.test(t);
  const male = /(男孩|男婴|儿子|男生|男性|小伙|胞胎(中的)?(哥哥|弟弟)|\bboy\b|\bmale\b|性别[:：\s]*男)/i.test(t);
  if (female !== male) raw.sex = female ? 'female' : 'male';

  if (/(农村|乡下|村里|村子|山区|牧区|乡村|渔村|山村|草原|部落|村庄)/.test(t)) raw.urban = false;
  else if (/(城市|大城市|市区|都市|首都|城里|市中心|省会)/.test(t)) raw.urban = true;

  const wealth = [
    [/(亿万|首富|豪门|顶级富豪|财阀|王室|皇室|贵族)/, 0.99], [/(富裕|有钱|富二代|富商|优渥|富有|殷实|富贵)/, 0.88],
    [/(中产|小康)/, 0.62], [/(贫困|贫穷|很穷|穷苦|贫寒|低保|赤贫|难民|流浪|一贫如洗|贫民)/, 0.08], [/(穷|拮据|困难|清贫)/, 0.2],
    [/(普通|工薪|一般家庭|平凡)/, 0.45],
  ];
  for (const [re, v] of wealth) if (re.test(t)) { raw.familyPct = v; break; }

  for (const sentence of t.split(/[。！？；;,，\n]/)) {
    if (!/(父母|爸|妈|父亲|母亲|双亲|家长)/.test(sentence)) continue;
    if (/(文盲|没读过书|不识字|没上过学|没念过书)/.test(sentence)) raw.parentsEdu = 'none';
    else if (/(博士|教授|硕士|研究生|大学|学者|医生|工程师|律师|名校|本科)/.test(sentence)) raw.parentsEdu = 'tertiary';
    else if (/(高中|中专|初中|中学)/.test(sentence)) raw.parentsEdu = 'secondary';
    else if (/小学/.test(sentence)) raw.parentsEdu = 'primary';
    if (raw.parentsEdu) break;
  }

  if (/独生/.test(t)) raw.siblings = 0;
  else if (/三胞胎/.test(t)) raw.siblings = 2;
  else if (/双胞胎|龙凤胎/.test(t)) raw.siblings = 1;
  else {
    const sm = /(\d+|[一两二三四五六七八九十])\s*个\s*(兄弟姐妹|哥哥|姐姐|弟弟|妹妹|兄弟|姐妹)/.exec(t);
    const nth = /第\s*(\d+|[二三四五六七八九十])\s*个孩子/.exec(t);
    if (sm && smallNum(sm[1]) != null) raw.siblings = smallNum(sm[1]);
    else if (nth && smallNum(nth[1]) != null) raw.siblings = Math.max(0, smallNum(nth[1]) - 1);
  }
  const mom = /(母亲|妈妈)[^。，,；]{0,6}?(\d{2})\s*岁/.exec(t);
  if (mom) raw.motherAge = Number(mom[2]);
  const dad = /(父亲|爸爸)[^。，,；]{0,6}?(\d{2})\s*岁/.exec(t);
  if (dad) raw.fatherAge = Number(dad[2]);
  const nm = /(名叫|叫做|名字是|取名为?|名字叫)\s*[“"「]?([一-龥·]{2,6})/.exec(t);
  if (nm) raw.name = nm[2];
  for (const [re, note] of NOTE_PATTERNS) if (re.test(t) && raw.notes.length < 4) raw.notes.push(note);
  return V.validateBirthParse(raw, data);
}

/* ------------------------------------------------------------------ offline: birth story and biography templates */

const PARENT_EDU_PHRASE = {
  none: '父母都没怎么上过学', primary: '父母读完了小学', secondary: '父母都读过中学', tertiary: '父母都受过高等教育',
};

function familyPhrase(p) {
  const v = toNum(p);
  if (v == null) return { long: '', short: '' };
  if (v < 0.1) return { long: '家里非常贫困，常常要为下一顿饭发愁', short: '家境贫困' };
  if (v < 0.3) return { long: '家里并不宽裕，每一笔钱都要精打细算', short: '家境清贫' };
  if (v < 0.6) return { long: '家里过着普通人家的日子', short: '普通人家' };
  if (v < 0.85) return { long: '家里过得还算宽裕', short: '小康之家' };
  if (v < 0.97) return { long: '家境富裕，不必为生计发愁', short: '家境富裕' };
  return { long: '家里非常富有，在当地数一数二', short: '显赫之家' };
}

function dateZh(date, year) {
  const m = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  return m ? `${m[1]} 年 ${Number(m[2])} 月 ${Number(m[3])} 日` : `${year} 年`;
}

function timeZh(time) {
  const h = typeof time === 'string' ? Number(time.slice(0, 2)) : NaN;
  if (!Number.isFinite(h)) return '';
  if (h < 5) return '凌晨';
  if (h < 8) return '清晨';
  if (h < 11) return '上午';
  if (h < 13) return '中午';
  if (h < 17) return '午后';
  if (h < 19) return '傍晚';
  return '夜里';
}

function topEvent(data, world, ctx, iso, year) {
  const list = [...(isObj(ctx) && Array.isArray(ctx.events) ? ctx.events : [])];
  try {
    const h = world && typeof world.headlines === 'function' ? world.headlines(year, iso, 3) : [];
    if (Array.isArray(h)) list.push(...h);
  } catch { /* ignore */ }
  if (!list.length) list.push(...P.historyEvents(data, iso, year));
  return list.filter((e) => isObj(e) && e.title).sort((a, b) => (toNum(b.importance) || 0) - (toNum(a.importance) || 0))[0] || null;
}

/** Templated birth story (second person). -> {text, tagline} */
export function templateBirthStory(state, data, world, ctx) {
  const b = isObj(state && state.birth) ? state.birth : {};
  const p = isObj(state && state.person) ? state.person : {};
  const iso = b.country || p.country;
  const year = toNum(b.year) ?? toNum(state && state.year) ?? 2000;
  const cname = P.countryName(data, iso);
  const place = b.urban === false ? '乡村' : b.urban ? '城市' : '';
  const fam = familyPhrase(b.familyPct ?? p.familyPct);
  const seed = hashString(String((state && (state.id || state.seed)) || cname + year));
  const when = `${dateZh(b.date, year)}${timeZh(b.time)}`;
  const s = [];
  s.push(`${when}，你出生在${cname}${place ? '的' + place : ''}${fam.long ? '，' + fam.long : ''}。`);
  const name = p.name || b.name;
  const parents = PARENT_EDU_PHRASE[b.parentsEdu];
  const sib = toNum(b.siblings);
  const famBits = [];
  if (name) famBits.push(`家人给你取名${name}`);
  if (parents) famBits.push(parents);
  if (sib != null) famBits.push(sib > 0 ? `你有 ${sib} 个兄弟姐妹` : '你是家里唯一的孩子');
  if (famBits.length) s.push(famBits.join('，') + '。');
  if (Array.isArray(b.notes) && b.notes.length) s.push(`你的出身有些特别：${b.notes.slice(0, 3).map((x) => cut(x, 20)).join('，')}。`);
  else if (b.customText) s.push(`你的出身有些特别：${cut(b.customText, 60)}。`);
  const ev = topEvent(data, world, ctx, iso, year);
  if (ev) {
    const proj = year > HISTORY_END || ev.projection || ev.source !== 'history';
    s.push(seed % 2 ? `那一年${proj ? '，在这条世界线上' : ''}，${cut(ev.title, 30)}——不过对刚出生的你来说，世界只有父母的臂弯那么大。`
      : `这一年${proj ? '（这条世界线上）' : ''}的大事是${cut(ev.title, 30)}，而家里最大的事，是你的到来。`);
  }
  const births = seriesOf(data, iso, 'births', year);
  if (births && births > 0) s.push(`这一年，${cname}大约有 ${cn(births * 1000)}个婴儿出生，你是其中之一。`);
  const le = toNum(ctx && ctx.lifeExp) ?? seriesOf(data, iso, 'le', year);
  if (le) s.push(`按${year > HISTORY_END ? '推演' : '当年'}的统计，这里的人平均能活到 ${le.toFixed(0)} 岁左右。`);
  return { text: s.join(''), tagline: cut(`${year} · ${cname}${place} · ${fam.short || '平常人家'}`, 24) };
}

function pronoun(state) {
  const sex = (state && state.person && state.person.sex) || (state && state.birth && state.birth.sex);
  return sex === 'female' ? '她' : '他';
}

/** Templated biography. -> {title, bio, epitaph, highlights} */
export function templateBiography(state, data) {
  const p = isObj(state && state.person) ? state.person : {};
  const b = isObj(state && state.birth) ? state.birth : {};
  const dead = isObj(state && state.dead) ? state.dead : null;
  const ta = pronoun(state);
  const name = p.name || b.name || '这个人';
  const age = toNum(dead && dead.age) ?? toNum(state && state.age) ?? 0;
  const endYear = toNum(dead && dead.year) ?? toNum(state && state.year) ?? 2000;
  const birthYear = toNum(b.year) ?? endYear - age;
  const birthC = P.countryName(data, b.country || p.country);
  const nowIso = p.country || b.country;
  const nowC = P.countryName(data, nowIso);
  const migrated = b.country && p.country && b.country !== p.country;
  const fam = familyPhrase(b.familyPct ?? p.familyPct);
  const paras = [];

  const p1 = [`${birthYear} 年，${name}出生在${birthC}${b.urban === false ? '的乡村' : b.urban ? '的城市' : ''}${fam.long ? '，' + fam.long : ''}。`];
  if (PARENT_EDU_PHRASE[b.parentsEdu]) p1.push(`${PARENT_EDU_PHRASE[b.parentsEdu]}。`);
  if (state && state.aiNotes && state.aiNotes.birthStory) p1.push(cut(state.aiNotes.birthStory, 120));
  paras.push(p1.join(''));

  const ed = isObj(p.education) ? p.education : {};
  const cr = isObj(p.career) ? p.career : {};
  const p2 = [];
  const EDU_PHRASE = { none: '没有机会进学校读书', preschool: '只读过学前班', primary: '读完了小学', secondary: '读完了中学', vocational: '上了职业学校', tertiary: '读完了大学', postgrad: '一直读到了研究生' };
  if (age >= 7 && EDU_PHRASE[ed.level]) p2.push(`${ta}${EDU_PHRASE[ed.level]}${ed.field ? '，学的是' + cut(ed.field, 12) : ''}。`);
  if (age >= 18) {
    if (cr.title) p2.push(`${ta}做过${cut(cr.title, 14)}${cr.sector ? '，在' + cut(cr.sector, 10) + '行业' : ''}${toNum(cr.years) ? `，前后工作了 ${cr.years} 年` : ''}。`);
    else if (cr.status === 'retired') p2.push(`${ta}工作了大半辈子，晚年退休在家。`);
    else if (cr.status === 'homemaker') p2.push(`${ta}把很多年的时间给了家务和家人。`);
  }
  if (migrated) p2.push(`后来，${ta}离开${birthC}，在${nowC}安顿下来。`);
  if (p2.length) paras.push(p2.join(''));

  const ds = Array.isArray(state && state.decisions) ? state.decisions.filter(isObj) : [];
  if (ds.length) {
    const pick = ds.length <= 4 ? ds : [0, 1, 2, 3].map((i) => ds[Math.round((i * (ds.length - 1)) / 3)]);
    paras.push(`回头看，几个选择改变了${ta}的路：${pick.map((d) => `${d.age} 岁那年，${cut(d.choice || d.title, 20)}`).join('；')}。`);
  }

  const rl = isObj(p.relationship) ? p.relationship : {};
  const kids = Array.isArray(p.children) ? p.children.filter(isObj) : [];
  const p4 = [];
  if (isObj(rl.partner) && rl.partner.name && (rl.status === 'married' || rl.status === 'partnered' || rl.status === 'widowed')) {
    p4.push(`${ta}和${cut(rl.partner.name, 10)}${rl.partner.sinceYear ? `从 ${rl.partner.sinceYear} 年起` : ''}相伴${rl.status === 'widowed' ? '，后来独自走完了剩下的路' : ''}。`);
  } else if (rl.status === 'divorced') {
    p4.push(`${ta}结过婚，后来分开了。`);
  } else if (age >= 30 && (!rl.status || rl.status === 'single')) {
    p4.push(`${ta}一生没有结婚，把时间留给了自己在意的人和事。`);
  }
  if (kids.length) p4.push(`${ta}有 ${kids.length} 个孩子。`);
  if (p4.length) paras.push(p4.join(''));

  const hist = Array.isArray(state && state.history) ? state.history.filter(isObj) : [];
  const heads = [];
  for (const h of hist) if (h.headline && !heads.includes(h.headline) && heads.length < 3) heads.push(cut(h.headline, 18));
  const realYears = hist.filter((h) => toNum(h.year) <= HISTORY_END).length;
  const projYears = hist.length - realYears;
  const p5 = [];
  if (heads.length) p5.push(`${ta}经历过${heads.join('、')}。`);
  if (realYears && projYears) p5.push(`${ta}的一生有 ${realYears} 年在真实的历史里，${projYears} 年在这条推演的世界线上。`);
  if (dead) {
    const cause = cut(dead.cause && dead.cause.name, 14) || '疾病';
    p5.push(`${endYear} 年，${name}因${cause}在${P.countryName(data, dead.place || nowIso)}离世，享年 ${age} 岁。`);
    const le = toNum(dead.lifeExpAtBirth);
    if (le) p5.push(age >= le ? `这比${ta}出生时的预期寿命多活了 ${Math.round(age - le)} 年。` : `${ta}出生时，人们预期能活到 ${Math.round(le)} 岁。`);
  }
  if (p5.length) paras.push(p5.join(''));

  const st = isObj(state && state.stats) ? state.stats : {};
  const top = STATS.filter((k) => toNum(st[k]) != null).sort((a, c) => st[c] - st[a])[0];
  let epitaph = {
    health: '认真吃饭，认真睡觉，认真地活了很久。', happiness: '笑过的日子，比哭过的多。',
    knowledge: '一生都在读书，也一生都在学着生活。', relationships: '被很多人爱过，也认真爱过很多人。',
    wealth: '把日子一点一点经营好，也照顾好了身边的人。',
  }[top] || '平凡地来过，认真地活过。';
  if (age < 18) epitaph = '来过，被爱过。';
  else if (migrated && hashString(name) % 2) epitaph = '走过很远的路，也记得回家的路。';

  let title = `${name}的${age}年`;
  if (migrated) title = `从${cut(birthC, 6)}到${cut(nowC, 6)}`;
  else if (cr.title && age >= 25) title = `${cut(nowC, 6)}的${cut(cr.title, 8)}`;

  const highlights = [];
  for (const d of ds.slice(0, 3)) highlights.push(cut(`${d.year} 年 · ${d.choice || d.title}`, 24));
  const log = Array.isArray(state && state.log) ? state.log.filter(isObj) : [];
  for (const e of log) {
    if (highlights.length >= 5) break;
    if ((e.kind === 'milestone' || (toNum(e.tone) || 0) >= 2) && e.text) highlights.push(cut(`${e.year} 年 · ${e.text}`, 24));
  }
  return { title: cut(title, 16), bio: paras.join('\n\n'), epitaph, highlights };
}

/* ------------------------------------------------------------------ factory */

/**
 * createDirector({data, world?, ai?, decisions?, engine?})
 * - ai: object with aiJSON/aiStream/aiStatus/getTier (defaults to ./claude.js)
 * - decisions: core/decisions.js namespace (buildDecisionOffline, resolveOffline, nextDecisionAge)
 * - engine: core/engine.js namespace (countryContext)
 */
export function createDirector({ data, world = null, ai = defaultAI, decisions = null, engine = null } = {}) {
  let curWorld = world;
  let lifeKey = null;
  const prefetched = new Map(); // target age -> {promise<raw|null>, fp, year}
  const upgrades = new Map();   // decision id -> Promise<Decision|null>

  function ensureLife(state) {
    const k = state ? String(state.id ?? state.seed ?? '') : '';
    if (k !== lifeKey) {
      lifeKey = k;
      prefetched.clear();
      upgrades.clear();
    }
  }

  function aiTier() {
    try { return typeof ai.getTier === 'function' ? ai.getTier() : 'default'; } catch { return 'default'; }
  }

  /** Model tier for a call: the life's settings.aiMode when it names a tier, else the global tier from claude.js. */
  function tierFor(kind, state, override) {
    const g = aiTier();
    if (g === 'off') return 'off';
    const own = override || (state && state.settings && state.settings.aiMode);
    const t = own === 'off' ? 'off' : TIERS.includes(own) ? own : g;
    if (t === 'off') return 'off';
    if (kind === 'birthParse') return t === 'complex' ? 'default' : 'quick';
    if (kind === 'birth') return t === 'complex' ? 'default' : t;
    return t;
  }

  function usable(state) {
    if (state && state.settings && state.settings.aiMode === 'off') return false;
    if (aiTier() === 'off') return false;
    try {
      const s = typeof ai.aiStatus === 'function' ? ai.aiStatus() : null;
      return !!(s && (s.usable ?? s.available));
    } catch {
      return false;
    }
  }

  function homeIso(state) {
    return (state && state.person && state.person.country) || (state && state.birth && state.birth.country);
  }

  function ctxFor(state, year) {
    const iso = homeIso(state);
    if (engine && typeof engine.countryContext === 'function') {
      try {
        const c = engine.countryContext(data, curWorld, iso, year);
        if (isObj(c)) return c;
      } catch (e) { warn('countryContext', e); }
    }
    return P.basicContext(data, curWorld, iso, year);
  }

  function rngFor(state, label) {
    let base;
    try {
      base = Array.isArray(state && state.rng) && state.rng.length === 4 ? new Rng(state.rng) : new Rng(String((state && (state.seed ?? state.id)) ?? 'life'));
    } catch {
      base = new Rng(1);
    }
    return base.fork(label);
  }

  function fingerprint(state) {
    const p = (state && state.person) || {};
    return [
      p.country, p.relationship && p.relationship.status, p.career && p.career.status,
      Array.isArray(p.children) ? p.children.length : 0,
      Array.isArray(p.conditions) ? p.conditions.map((c) => c && c.id).join('+') : '',
      state && state.dead ? 1 : 0,
    ].join('|');
  }

  function offlineDecision(state, ctx) {
    if (validDecisionShape(state && state.pending)) return state.pending;
    if (decisions && typeof decisions.buildDecisionOffline === 'function') {
      try {
        const d = decisions.buildDecisionOffline(data, curWorld, state, ctx, rngFor(state, `decision:${state.year}:${state.age}`));
        if (validDecisionShape(d)) return d;
      } catch (e) { warn('buildDecisionOffline', e); }
    }
    return genericDecision(state);
  }

  function offlineResolution(state, decision, choice) {
    const key = isObj(choice) ? (choice.optionId || 'custom:' + hashString(String(choice.customText || ''))) : String(choice);
    const rng = rngFor(state, `resolve:${(decision && decision.id) || 'x'}:${key}`);
    if (decisions && typeof decisions.resolveOffline === 'function') {
      try {
        const r = decisions.resolveOffline(data, curWorld, state, decision, choice, rng);
        if (isObj(r) && typeof r.narrative === 'string' && r.narrative) return r;
      } catch (e) { warn('resolveOffline', e); }
    }
    return genericResolution(state, decision, choice, rng);
  }

  function isDecisionAge(state, age) {
    const freq = (state.settings && state.settings.decisionFreq) || 'standard';
    const list = Array.isArray(DECISION_FREQUENCY[freq]) ? DECISION_FREQUENCY[freq] : null;
    if (decisions && typeof decisions.nextDecisionAge === 'function') {
      try {
        const n = toNum(decisions.nextDecisionAge(state, freq));
        if (n === age) return true;
        if (n === state.age && list) return list.includes(age); // ">=" semantics while the current age is itself a decision age
        if (n != null) return false;
      } catch (e) { warn('nextDecisionAge', e); }
    }
    return list ? list.includes(age) : false;
  }

  function projectedSeed(state, year, age, ctx) {
    if (!decisions || typeof decisions.buildDecisionOffline !== 'function') return null;
    try {
      const person = typeof structuredClone === 'function' ? structuredClone(state.person) : JSON.parse(JSON.stringify(state.person));
      const proj = { ...state, year, age, person, pending: null };
      const d = decisions.buildDecisionOffline(data, curWorld, proj, ctx, rngFor(state, `prefetch:${year}:${age}`));
      return validDecisionShape(d) ? d : null;
    } catch (e) {
      warn('projectedSeed', e);
      return null;
    }
  }

  function streamer(onText) {
    if (typeof onText !== 'function') return undefined;
    let last = '';
    return ({ text }) => {
      // what the player sees while it streams is cleaned like the final narrative (no markup, no control characters)
      const shown = V.cleanText(V.visibleNarrative(text), 4000, { multiline: true, ellipsis: false });
      if (!shown || shown === last) return;
      const delta = shown.startsWith(last) ? shown.slice(last.length) : shown;
      last = shown;
      try { onText({ text: shown, delta }); } catch (e) { warn('onText', e); }
    };
  }

  function normChoice(decision, choice) {
    if (typeof choice === 'string') {
      const opts = isObj(decision) && Array.isArray(decision.options) ? decision.options : [];
      return opts.some((o) => o && o.id === choice) ? { optionId: choice } : { customText: V.cleanText(choice, 200) };
    }
    if (isObj(choice) && typeof choice.customText === 'string') return { customText: V.cleanText(choice.customText, 200) };
    if (isObj(choice) && choice.optionId) return { optionId: String(choice.optionId) };
    return { optionId: 'a' };
  }

  async function streamResolution(state, prompt, kind, opts) {
    let shown = '';
    const onText = streamer(opts.onText);
    const r = await ai.aiStream(prompt, {
      tier: tierFor(kind, state), kind, signal: opts.signal, cache: false,
      onText: (u) => { shown = V.visibleNarrative(u.text); if (onText) onText(u); },
    });
    const { narrative, json } = V.splitNarrativeJSON(r.text);
    const merged = { ...(json || {}), narrative: narrative || (json && json.narrative) };
    return { resolution: json ? V.validateResolution(merged, state, data) : null, narrative: narrative || shown };
  }

  /** -> {spec: partial BirthSpec|null, source:'ai'|'local'} */
  async function parseCustomBirthDetailed(text, opts = {}) {
    const clean = typeof text === 'string' ? text.trim().slice(0, 600) : '';
    if (!clean) return { spec: null, source: 'local' };
    let spec = null;
    let source = 'local';
    if (usable(null) && !(opts && opts.aiMode === 'off')) {
      try {
        const raw = await ai.aiJSON(P.buildCustomBirthPrompt(clean, data), {
          tier: tierFor('birthParse', null, opts && opts.aiMode), kind: 'birthParse', signal: opts && opts.signal,
        });
        spec = V.validateBirthParse(raw, data);
        if (spec) source = 'ai';
      } catch { /* offline below */ }
    }
    if (!spec) spec = offlineBirthParse(clean, data);
    if (!spec) return { spec: null, source };
    return { spec: { ...spec, mode: 'custom', customText: V.cleanText(clean, 300) }, source };
  }

  return {
    /** Swap the world (new life with a new world seed). */
    setWorld(w) { curWorld = w; prefetched.clear(); upgrades.clear(); },
    getWorld() { return curWorld; },
    /** AI status passthrough for the UI. */
    status() { try { return ai.aiStatus(); } catch { return { available: false, usable: false, mode: 'off' }; } },
    usable,
    /** Forget per-life caches (e.g. when abandoning a life). */
    resetLife() { lifeKey = null; prefetched.clear(); upgrades.clear(); },

    getDecision(state, ctx, opts = {}) {
      ensureLife(state);
      const c = isObj(ctx) ? ctx : ctxFor(state, state.year);
      const offline = validDecisionShape(opts && opts.decision) ? opts.decision : offlineDecision(state, c);
      if (!usable(state) || offline.source === 'ai') return { decision: offline, upgrade: Promise.resolve(null) };
      if (upgrades.has(offline.id)) return { decision: offline, upgrade: upgrades.get(offline.id) };
      let upgrade;
      const pre = prefetched.get(state.age);
      if (pre && pre.year === state.year && offline.kind !== 'triggered' && pre.fp === fingerprint(state)) {
        prefetched.delete(state.age);
        upgrade = pre.promise.then((raw) => (raw ? V.validateDecision(raw, offline) : null));
      } else {
        if (pre) prefetched.delete(state.age);
        const prompt = P.buildDecisionPrompt(state, data, curWorld, c, { seed: offline, kind: offline.kind, year: state.year, age: state.age });
        upgrade = ai.aiJSON(prompt, { tier: tierFor('decision', state), kind: 'decision' }).then((raw) => V.validateDecision(raw, offline));
      }
      upgrade = upgrade.catch(() => null);
      upgrades.set(offline.id, upgrade);
      if (upgrades.size > 60) upgrades.delete(upgrades.keys().next().value);
      return { decision: offline, upgrade };
    },

    prefetch(state) {
      ensureLife(state);
      if (!isObj(state) || state.dead || !isObj(state.person) || !usable(state)) return false;
      const age = state.age + 1;
      const year = state.year + 1;
      if (prefetched.has(age) || !isDecisionAge(state, age)) return false;
      const ctx = ctxFor(state, year);
      const seed = projectedSeed(state, year, age, ctx);
      const prompt = P.buildDecisionPrompt(state, data, curWorld, ctx, { seed, kind: 'milestone', year, age });
      const promise = ai.aiJSON(prompt, { tier: tierFor('decision', state), kind: 'decision', background: true }).then((raw) => raw, () => null);
      prefetched.set(age, { promise, fp: fingerprint(state), year });
      for (const k of [...prefetched.keys()]) if (k < state.age) prefetched.delete(k);
      return true;
    },

    async resolveChoice(state, decision, choice, opts = {}) {
      ensureLife(state);
      const o = typeof opts === 'function' ? { onText: opts } : isObj(opts) ? opts : {};
      const ch = normChoice(decision, choice);
      if (!usable(state) || !isObj(decision)) return { resolution: offlineResolution(state, decision, ch), source: 'local' };
      let narrative = '';
      try {
        const ctx = ctxFor(state, state.year);
        const prompt = P.buildResolutionPrompt(state, data, curWorld, ctx, decision, ch);
        const r = await streamResolution(state, prompt, 'resolution', o);
        narrative = r.narrative;
        if (r.resolution) return { resolution: r.resolution, source: 'ai', streamText: r.narrative };
        return { resolution: offlineResolution(state, decision, ch), source: 'local', streamText: narrative || undefined, error: 'invalid' };
      } catch (e) {
        const partial = e && typeof e.text === 'string' && e.code !== 'refused' ? V.visibleNarrative(e.text) : '';
        return { resolution: offlineResolution(state, decision, ch), source: 'local', streamText: partial || undefined, error: (e && e.code) || 'error' };
      }
    },

    async customAction(state, text, onText, opts = {}) {
      ensureLife(state);
      const clean = V.cleanText(text, 200);
      const year = state.year;
      const age = state.age;
      const decision = {
        id: `act-${year}-${age}-${hashString(clean || 'empty').toString(36)}`, year, age, kind: 'custom', title: '主动选择',
        situation: clean || '（未填写）', options: [], allowCustom: true, source: 'local',
      };
      const choice = { customText: clean };
      if (!clean) {
        return {
          resolution: { narrative: '你想了想，决定暂时什么也不做，先把眼前的日子过好。', effects: zeroEffects(), set: {}, threads: [], feasible: true },
          source: 'local', decision, choice,
        };
      }
      if (!usable(state)) return { resolution: offlineResolution(state, decision, choice), source: 'local', decision, choice };
      try {
        const ctx = ctxFor(state, year);
        const prompt = P.buildCustomActionPrompt(state, data, curWorld, ctx, clean);
        const r = await streamResolution(state, prompt, 'custom', { onText, signal: opts && opts.signal });
        if (r.resolution) return { resolution: r.resolution, source: 'ai', streamText: r.narrative, decision: { ...decision, source: 'ai' }, choice };
        return { resolution: offlineResolution(state, decision, choice), source: 'local', streamText: r.narrative || undefined, decision, choice, error: 'invalid' };
      } catch (e) {
        return { resolution: offlineResolution(state, decision, choice), source: 'local', decision, choice, error: (e && e.code) || 'error' };
      }
    },

    parseCustomBirthDetailed,

    async parseCustomBirth(text, opts = {}) {
      return (await parseCustomBirthDetailed(text, opts)).spec;
    },

    async birthStory(state, opts = {}) {
      ensureLife(state);
      const year = toNum(state && state.birth && state.birth.year) ?? state.year;
      const ctx = ctxFor(state, year);
      const tpl = templateBirthStory(state, data, curWorld, ctx);
      if (!usable(state)) return { ...tpl, source: 'local' };
      try {
        const raw = await ai.aiJSON(P.buildBirthStoryPrompt(state, data, curWorld, ctx), { tier: tierFor('birth', state), kind: 'birth', signal: opts && opts.signal });
        const v = V.validateBirthStory(raw);
        if (v) return { text: v.story, tagline: v.tagline || tpl.tagline, source: 'ai' };
      } catch { /* template below */ }
      return { ...tpl, source: 'local' };
    },

    async biography(state, onText, opts = {}) {
      ensureLife(state);
      const tpl = templateBiography(state, data);
      if (!usable(state)) return { ...tpl, source: 'local' };
      try {
        const r = await ai.aiStream(P.buildBiographyPrompt(state, data, curWorld), {
          tier: tierFor('biography', state), kind: 'biography', signal: opts && opts.signal, onText: streamer(onText),
        });
        const { narrative, json } = V.splitNarrativeJSON(r.text);
        const v = V.validateBiography({ ...(json || {}), bio: narrative || (json && json.bio) });
        if (v) {
          return {
            title: v.title || tpl.title, bio: v.bio, epitaph: v.epitaph || tpl.epitaph,
            highlights: v.highlights.length ? v.highlights : tpl.highlights, source: 'ai',
          };
        }
      } catch { /* template below */ }
      return { ...tpl, source: 'local' };
    },
  };
}

/* ------------------------------------------------------------------ module-level helpers for screens */

const birthDirectors = new WeakMap();
function birthDirector(data) {
  let d = birthDirectors.get(data);
  if (!d) {
    d = createDirector({ data });
    birthDirectors.set(data, d);
  }
  return d;
}

/**
 * Module-level form used by the birth screen: parseCustomBirth(text, data, {signal, aiMode}?) -> partial BirthSpec | null.
 * Uses the default AI (claude.js) when usable, else the offline parser.
 */
export async function parseCustomBirth(text, data, opts = {}) {
  if (!data || typeof data !== 'object') return null;
  return birthDirector(data).parseCustomBirth(text, opts);
}

/** Same as parseCustomBirth but resolves {spec, source:'ai'|'local'}. */
export async function parseCustomBirthDetailed(text, data, opts = {}) {
  if (!data || typeof data !== 'object') return { spec: null, source: 'local' };
  return birthDirector(data).parseCustomBirthDetailed(text, opts);
}
