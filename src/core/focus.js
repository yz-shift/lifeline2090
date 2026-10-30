// The year's focus (人生重心, CONTRACT §10): what a year of life is mostly spent on.
//
// From age 6 the player can pick a focus under the timeline; it applies to that year and the following ones until it
// is changed. Without a choice (or when the chosen focus no longer fits the life) the engine picks one automatically,
// biased by the auto-choose texture (settings.autoTexture) and the stage of life.
// A focus has modest yearly stat effects (+1..+3 primary, -1 secondary) and shifts probabilities inside the engine
// (exam results, university entry, promotion, finding a partner, health risks ...) through `mods`.
// Pure module: no DOM, no Math.random, no Date.

import { STAT_LABELS } from './constants.js';
import { Rng, hashString } from './rng.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const num = (v, d = 0) => (isNum(v) ? v : d);
const clampN = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export const FOCUS_IDS = ['study', 'play', 'hobby', 'friends', 'family', 'love', 'work', 'money', 'health', 'rest', 'care', 'kids', 'help'];
export const FOCUS_MIN_AGE = 6;

/** Short neutral names (for summaries and settings); the option labels change with the stage of life. */
export const FOCUS_NAMES = {
  study: '读书学习', play: '玩耍', hobby: '兴趣爱好', friends: '朋友', family: '家人', love: '感情', work: '工作',
  money: '攒钱', health: '健康', rest: '休息', care: '照顾父母', kids: '孩子', help: '帮助他人',
};

/**
 * Auto-choose textures (settings.autoTexture): how automatic choices lean when the player lets the life run.
 * `focus` multiplies the base weight of each focus; `tags` multiplies small-choice options carrying that tag.
 */
export const TEXTURES = {
  normal: { label: '寻常', hint: '像大多数人那样，随遇而安', focus: {}, tags: {} },
  steady: { label: '稳妥', hint: '求稳，少冒险，多储蓄', focus: { study: 1.4, work: 1.4, money: 2, health: 1.5, rest: 0.8, hobby: 0.7, friends: 0.8, love: 0.8, play: 0.8 },
    tags: { safe: 2.4, money: 1.8, health: 1.5, study: 1.3, bold: 0.35, free: 0.6 } },
  adventure: { label: '闯荡', hint: '敢尝试，爱新鲜，走得远', focus: { hobby: 1.8, friends: 1.6, love: 1.6, work: 1.2, money: 0.5, rest: 0.6, family: 0.7, health: 0.8 },
    tags: { bold: 2.6, free: 1.6, social: 1.4, safe: 0.5, comfort: 0.6 } },
  family: { label: '顾家', hint: '家人永远排在第一位', focus: { family: 2.6, kids: 2.6, care: 2.6, love: 1.5, work: 0.8, friends: 0.8, hobby: 0.8 },
    tags: { family: 3, give: 1.3, safe: 1.2, bold: 0.7, free: 0.8 } },
  career: { label: '事业心', hint: '把力气花在学业和工作上', focus: { work: 2.5, study: 2, money: 1.3, family: 0.6, rest: 0.4, hobby: 0.6, kids: 0.7, play: 0.6, friends: 0.8 },
    tags: { career: 2.6, study: 2, money: 1.4, comfort: 0.5, free: 0.7 } },
  free: { label: '随性', hint: '想做什么就做什么', focus: { hobby: 2.2, rest: 1.8, friends: 1.5, play: 1.8, work: 0.6, study: 0.6, money: 0.5 },
    tags: { free: 2.6, social: 1.3, comfort: 1.3, safe: 0.7, career: 0.6 } },
  comfort: { label: '安逸', hint: '过舒服日子，照顾好自己', focus: { rest: 2.5, health: 1.8, family: 1.3, work: 0.6, study: 0.6, hobby: 1.2 },
    tags: { comfort: 2.6, health: 1.5, safe: 1.3, bold: 0.45, career: 0.6 } },
  giving: { label: '利他', hint: '常常想着别人', focus: { help: 3, care: 1.8, family: 1.4, kids: 1.3, money: 0.6 },
    tags: { give: 3, family: 1.4, social: 1.2, free: 0.8 } },
};
export const TEXTURE_IDS = Object.keys(TEXTURES);

export function textureOf(state) {
  const t = state && state.settings && state.settings.autoTexture;
  return TEXTURE_IDS.includes(t) ? t : 'normal';
}

/** child 6–11, teen 12–17, young 18–29, adult 30–59, old 60+ */
export function stageOf(age) {
  const a = num(age, 0);
  return a < 12 ? 'child' : a < 18 ? 'teen' : a < 30 ? 'young' : a < 60 ? 'adult' : 'old';
}

/* ------------------------------------------------------------------ situation */

const WORKING = ['employed', 'self_employed', 'military'];

/**
 * The situation the focus options depend on, for the year `ahead` years from now (focusOptions looks at the year
 * about to be lived, the engine at the year being lived: ahead 0).
 */
export function focusSituation(state, ahead = 0) {
  const p = (state && state.person) || {};
  const year = num(state && state.year, 2000) + ahead;
  const age = num(state && state.age, 0) + ahead;
  const e = p.education || {};
  const c = p.career || {};
  const rel = (p.relationship && p.relationship.status) || 'single';
  const kids = (Array.isArray(p.children) ? p.children : []).filter((k) => isObj(k) && k.alive !== false)
    .map((k) => ({ age: year - num(k.birthYear, year) })).filter((k) => k.age >= 0);
  const par = isObj(p.parents) ? p.parents : {};
  const parentAges = ['mother', 'father'].map((r) => par[r]).filter((x) => isObj(x) && x.alive !== false).map((x) => num(x.age, age + 30) + ahead);
  const flags = isObj(p.flags) ? p.flags : {};
  const status = c.status || (age < 15 ? 'child' : 'unemployed');
  return {
    age, year, stage: stageOf(age),
    inSchool: !!e.inSchool,
    noSchool: !!flags.noSchool,
    status,
    working: WORKING.includes(status),
    unemployed: status === 'unemployed',
    homemaker: status === 'homemaker',
    retired: status === 'retired',
    student: status === 'student',
    income: num(p.money && p.money.income, 0) > 0 || WORKING.includes(status) || status === 'retired',
    rel,
    single: rel === 'single' || rel === 'divorced' || rel === 'widowed',
    dating: rel === 'dating',
    couple: rel === 'married' || rel === 'partnered',
    kids: kids.length,
    youngKids: kids.filter((k) => k.age < 18).length,
    adultKids: kids.filter((k) => k.age >= 18).length,
    grandkids: !!flags.grandparent || kids.some((k) => k.age >= 27),
    parentsAlive: parentAges.length,
    parentOld: parentAges.some((a) => a >= 65),
    siblings: num(p.siblings, 0),
    sick: Array.isArray(p.conditions) && p.conditions.length > 0,
  };
}

/* ------------------------------------------------------------------ definitions */

/**
 * Each definition returns, for a situation x, null (not offered at this stage) or
 * {label, stats, mods, w (base auto weight), notes:[short zh effect words], available?:false, why?}.
 * mods: exam (score), school (+p of moving up a school level), tertiary (+p of university), promo (+p of promotion),
 * raise (z per year), jobLoss (×), findJob (+p), union (× first-union / new-partner hazard), marry (× dating->married),
 * breakup (×), divorce (×), cond (× chronic disease incidence), smokeStart (×), smokeQuit (+p), parentQ (× parents'
 * yearly death risk), depr (× depression risk), save (+ savings rate), spendParents / spendCharity (+ share of
 * income), returnWork (+p homemaker back to work), rare (× chance of meeting a rare good deed).
 */
const DEF = {
  study(x) {
    let label;
    if (x.inSchool) label = x.stage === 'child' ? '用心读书' : x.stage === 'teen' ? '埋头苦读' : '专心学业';
    else label = x.stage === 'old' ? '老有所学' : x.stage === 'child' ? '自学认字' : x.stage === 'teen' ? '自学充电' : '进修充电';
    if (x.inSchool) {
      return { label, stats: { knowledge: 2, happiness: -1 }, mods: { exam: 5, school: 0.05, tertiary: 0.07 }, w: 3.2, notes: ['升学机会↑'] };
    }
    if (x.stage === 'old') return { label, stats: { knowledge: 2, happiness: 1 }, mods: { depr: 0.9 }, w: 0.4, notes: [] };
    const work = x.working || x.unemployed;
    return {
      label, stats: { knowledge: 2, happiness: -1 }, mods: { promo: 0.004, findJob: 0.05, raise: 0.004 },
      w: x.stage === 'child' ? 1 : x.stage === 'teen' ? 0.8 : x.stage === 'young' ? 0.7 : 0.4,
      notes: work ? [x.unemployed ? '找到工作↑' : '晋升略↑'] : [],
    };
  },
  play(x) {
    if (x.stage !== 'child') return null;
    return { label: '尽情玩耍', stats: { happiness: 3, relationships: 1, knowledge: x.inSchool ? -1 : 0 }, mods: { exam: -2 }, w: 2.6, notes: [] };
  },
  hobby(x) {
    const label = x.stage === 'old' ? '寄情爱好' : '培养爱好';
    const w = { child: 1.2, teen: 1.5, young: 1, adult: 0.7, old: 1.3 }[x.stage];
    if (x.inSchool) return { label, stats: { happiness: 3, knowledge: -1 }, mods: { exam: -3, tertiary: -0.03, depr: 0.85 }, w, notes: [] };
    return { label, stats: { happiness: 3, knowledge: 1 }, mods: { depr: 0.85 }, w, notes: [] };
  },
  friends(x) {
    const label = x.stage === 'child' ? '交朋友' : x.stage === 'teen' ? '和朋友在一起' : x.stage === 'old' ? '老友相伴' : '多交朋友';
    const mods = { depr: 0.8, findJob: 0.03, smokeStart: 1.25 };
    if (x.inSchool) mods.exam = -2;
    if (x.age >= 16) mods.union = 1.25;
    return {
      label, stats: { relationships: 3, happiness: 1, knowledge: x.inSchool ? -1 : 0 }, mods,
      w: { child: 1.2, teen: 2, young: 1.5, adult: 0.8, old: 1.2 }[x.stage], notes: x.age >= 18 && x.single ? ['遇见缘分略↑'] : [],
    };
  },
  family(x) {
    const label = x.stage === 'adult' && (x.couple || x.kids) ? '顾家' : x.stage === 'old' ? '守着一家人' : '陪伴家人';
    const anyone = x.parentsAlive || x.couple || x.dating || x.kids || x.siblings > 0;
    if (!anyone) return { label, stats: {}, mods: {}, w: 0, notes: [], available: false, why: '身边已经没有家人了' };
    const child = x.stage === 'child' || x.stage === 'teen';
    return {
      label, stats: child ? { relationships: 3, happiness: 1 } : { relationships: 2, happiness: 2 },
      mods: child ? { exam: -1 } : { divorce: 0.6, breakup: 0.8, promo: -0.004, depr: 0.85 },
      w: { child: 1, teen: 0.8, young: x.couple || x.kids ? 1.6 : 0.8, adult: x.couple || x.kids ? 2 : 0.8, old: 2 }[x.stage],
      notes: x.couple ? ['婚姻更稳'] : [],
    };
  },
  love(x) {
    if (x.age < 18) return null;
    if (x.age >= 80 && !x.couple) return null;
    if (x.single) {
      const label = x.rel === 'single' ? '寻找爱情' : '再寻良伴';
      return { label, stats: { happiness: 1, relationships: 1 }, mods: { union: 1.9 }, w: x.stage === 'young' ? 2 : x.stage === 'adult' ? 1.1 : 0.3, notes: ['遇见缘分↑'] };
    }
    if (x.dating) return { label: '用心恋爱', stats: { happiness: 2, relationships: 1 }, mods: { marry: 1.35, breakup: 0.7 }, w: x.stage === 'young' ? 1.2 : 0.8, notes: ['走进婚姻↑'] };
    return { label: '经营感情', stats: { happiness: 2, relationships: 1 }, mods: { divorce: 0.65 }, w: 0.6, notes: ['婚姻更稳'] };
  },
  work(x) {
    if (x.age < 15) return null;
    if (x.inSchool) {
      if (x.stage === 'old') return null;
      return { label: '打工挣钱', stats: { knowledge: -1, happiness: 0 }, mods: { exam: -3, tertiary: -0.04, pocket: 1.5 }, w: 0.4, notes: ['零花钱↑'] };
    }
    if (x.unemployed) return { label: '找工作', stats: { happiness: -1 }, mods: { findJob: 0.15 }, w: 3.5, notes: ['找到工作↑'] };
    if (x.homemaker) {
      if (x.age >= 60) return null;
      return { label: '重新工作', stats: { happiness: -1 }, mods: { returnWork: 0.15 }, w: 0.5, notes: ['回到职场↑'] };
    }
    if (x.retired || x.status === 'unable') {
      if (x.status === 'unable') return { label: '拼事业', stats: {}, mods: {}, w: 0, notes: [], available: false, why: '身体还撑不住工作' };
      return null;
    }
    if (!x.working) {
      if (x.stage === 'child') return null;
      return { label: '干活挣钱', stats: { happiness: -1 }, mods: { findJob: 0.1 }, w: 1, notes: [] };
    }
    return {
      label: x.stage === 'old' ? '继续工作' : '拼事业', stats: { health: -1, relationships: -1 },
      mods: { promo: 0.015, raise: 0.01, jobLoss: 0.75, cond: 1.08, divorce: 1.15, depr: 1.1 },
      w: x.stage === 'old' ? 1 : x.stage === 'teen' ? 1.5 : 3, notes: ['收入↑', '晋升↑'],
    };
  },
  money(x) {
    if (x.age < 18) return null;
    if (!x.income) return { label: '攒钱理财', stats: {}, mods: {}, w: 0, notes: [], available: false, why: '还没有自己的收入' };
    return { label: '攒钱理财', stats: { happiness: -1 }, mods: { save: 0.08 }, w: { young: 0.8, adult: 1.2, old: 0.3 }[x.stage] || 0.5, notes: ['存款↑'] };
  },
  health(x) {
    const label = x.stage === 'child' || x.stage === 'teen' ? '多运动' : x.stage === 'old' ? '养生保健' : '注重健康';
    const w = { child: 0.8, teen: 0.8, young: 0.7, adult: x.age >= 45 || x.sick ? 1.6 : 1, old: 2.2 }[x.stage];
    return { label, stats: { health: 2, happiness: 1 }, mods: { cond: 0.8, smokeStart: 0.4, smokeQuit: 0.06, depr: 0.85 }, w, notes: ['患病风险↓'] };
  },
  rest(x) {
    if (x.age < 15) return null;
    const label = x.stage === 'old' ? '安享晚年' : '放慢脚步';
    return {
      label, stats: { happiness: 3, health: 1 }, mods: { promo: -0.008, jobLoss: 1.1, depr: 0.7, cond: 0.95, save: -0.02 },
      w: { teen: 0.3, young: 0.5, adult: 0.7, old: 2.2 }[x.stage] || 0.5, notes: x.working ? ['晋升略↓'] : [],
    };
  },
  care(x) {
    if (x.age < 18) return null;
    if (!x.parentsAlive) {
      if (x.stage === 'old') return null;
      return { label: '照顾父母', stats: {}, mods: {}, w: 0, notes: [], available: false, why: '父母都已不在了' };
    }
    if (!x.parentOld) return { label: '照顾父母', stats: {}, mods: {}, w: 0, notes: [], available: false, why: '父母还年轻，身体硬朗' };
    return { label: '照顾父母', stats: { relationships: 2, happiness: -1 }, mods: { parentQ: 0.85, spendParents: 0.03, promo: -0.004 }, w: x.stage === 'young' ? 0.6 : 1.5, notes: ['父母更安康'] };
  },
  kids(x) {
    if (x.age < 18) return null;
    if (x.youngKids) return { label: '陪伴孩子', stats: { relationships: 2, happiness: 2 }, mods: { promo: -0.006, kidsCare: 1 }, w: x.stage === 'young' ? 2 : 2.5, notes: ['孩子更有出息'] };
    if (x.kids && x.stage === 'old' && x.grandkids) return { label: '含饴弄孙', stats: { relationships: 2, happiness: 2 }, mods: {}, w: 1, notes: [] };
    if (x.kids) return { label: '帮衬儿女', stats: { relationships: 2, happiness: 1 }, mods: { save: -0.02 }, w: x.stage === 'old' ? 0.8 : 0.5, notes: [] };
    if (x.age < 22) return null;
    return { label: '陪伴孩子', stats: {}, mods: {}, w: 0, notes: [], available: false, why: '还没有孩子' };
  },
  help(x) {
    if (x.age < 12) return null;
    return {
      label: x.stage === 'old' ? '发挥余热' : '帮助他人', stats: { relationships: 2, happiness: 2 },
      mods: { spendCharity: x.income ? 0.02 : 0, rare: 2 }, w: 0.3, notes: [],
    };
  },
};

/** Arrows for a hint: ↑ for +2 or more, 略↑ for +1, ↓ / 略↓ likewise. */
export function effectWords(stats, max = 2) {
  const list = Object.entries(isObj(stats) ? stats : {}).filter(([k, v]) => STAT_LABELS[k] && isNum(v) && Math.abs(v) >= 0.5)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || b[1] - a[1]);
  return list.slice(0, max).map(([k, v]) => `${STAT_LABELS[k]}${v >= 1.5 ? '↑' : v > 0 ? '略↑' : v <= -1.5 ? '↓' : '略↓'}`);
}

function hintOf(spec) {
  const words = effectWords(spec.stats, spec.notes && spec.notes.length ? 2 : 3);
  if (spec.notes && spec.notes.length) words.push(spec.notes[0]);
  let h = words.join(' ');
  if (h.length > 16) h = words.slice(0, 2).join(' ');
  return h || '顺其自然';
}

/** The full specification of one focus for a situation, or null when it is not offered at this stage. */
export function focusSpec(id, x) {
  const fn = DEF[id];
  if (!fn || !x || x.age < FOCUS_MIN_AGE) return null;
  const s = fn(x);
  if (!s) return null;
  const out = { id, label: s.label, stats: s.stats || {}, mods: s.mods || {}, w: num(s.w, 0), notes: s.notes || [], available: s.available !== false };
  if (!out.available) out.why = s.why || '现在还不适合';
  out.hint = out.available ? hintOf(out) : out.why;
  return out;
}

/** Every focus offered for a situation (available or not), in display order. */
export function focusList(x) {
  const out = [];
  for (const id of FOCUS_IDS) {
    const s = focusSpec(id, x);
    if (s) out.push(s);
  }
  return out;
}

/** True when the focus can be lived in this situation. */
export function focusFits(id, x) {
  const s = focusSpec(id, x);
  return !!(s && s.available);
}

/**
 * The automatic focus for a year: weighted by stage and situation, multiplied by the texture, and with a pull to keep
 * last year's automatic focus (people rarely change what their days are about every single year). Deterministic for
 * a life and a year.
 */
export function autoFocus(state, x, texture, lastAuto) {
  const list = focusList(x).filter((s) => s.available && s.w > 0);
  if (!list.length) return null;
  const T = TEXTURES[texture] || TEXTURES.normal;
  const R = new Rng(hashString(`${(state && state.id) || ''}|focus|${x.year}|${texture}`));
  if (lastAuto && list.some((s) => s.id === lastAuto) && R.chance(0.62)) return lastAuto;
  const pick = R.weighted(list, (s) => s.w * num(T.focus[s.id], 1));
  return pick ? pick.id : list[0].id;
}

/** Sum of a modifier over the year's focus mods (additive keys) or product (multiplicative keys). */
const MULT_KEYS = new Set(['jobLoss', 'union', 'marry', 'breakup', 'divorce', 'cond', 'smokeStart', 'parentQ', 'depr', 'rare']);
export function modValue(mods, key) {
  const v = isObj(mods) ? mods[key] : undefined;
  if (MULT_KEYS.has(key)) return isNum(v) ? clampN(v, 0.2, 5) : 1;
  return isNum(v) ? v : 0;
}
export { MULT_KEYS };

/* ------------------------------------------------------------------ streak lines */

// A line now and then when a focus has shaped several years in a row, so the player sees the choice at work.
const STREAK = {
  study: { child: ['这几年你把心思都放在了功课上，作业本上的红勾越来越多，老师也常常表扬你。'], teen: ['这几年你几乎把所有时间都给了书本。台灯下的夜晚很长，成绩单上的名次一点点往前挪。'],
    young: ['这几年你一直在给自己充电。学到的东西不声不响，却在一次次机会面前派上了用场。'], adult: ['这几年你没停下学习：下班后的网课、周末的证书班。同事们开始有问题就来问你。'],
    old: ['这几年你像个老学生一样学这学那，脑子越用越灵，连孙辈都夸你"跟得上时代"。'] },
  play: { child: ['这几年你玩得很尽兴：田野、街巷、操场，到处都留下了你和伙伴们的笑声。'] },
  hobby: { any: ['这几年你一直坚持着自己的爱好。它不能当饭吃，却让日子有了光。'] },
  friends: { any: ['这几年你身边的朋友越来越多。遇到难处时，总有人第一时间站出来。'] },
  family: { any: ['这几年你把很多时间留给了家人。饭桌上的话多了，家里的笑声也多了。'] },
  love: { any: ['这几年你认真地对待感情，学会了倾听，也学会了表达。'] },
  work: { any: ['这几年你一门心思扑在工作上，加班成了常态。收入和职位都在往上走，只是陪家人的时间少了。'] },
  money: { any: ['这几年你精打细算，每个月雷打不动地先存下一笔钱。账户里的数字慢慢变厚，你心里也越来越踏实。'] },
  health: { any: ['这几年你一直很注意身体：按时作息、坚持运动、定期体检。镜子里的自己精神了不少。'] },
  rest: { any: ['这几年你有意放慢了脚步，不再和别人比快慢。睡得好了，笑得也多了。'] },
  care: { any: ['这几年你常常回去陪父母：陪他们看病、说话、吃饭。他们老了，也因为有你，老得从容一些。'] },
  kids: { any: ['这几年你把很多时间给了孩子：接送、陪读、讲睡前故事。孩子长得飞快，你都记在心里。'] },
  help: { any: ['这几年你常常去帮助别人。你没想过要回报，可身边的人都记着你的好。'] },
};

/** The streak line for a focus at a stage, or null. */
export function streakLine(id, stage, rng) {
  const t = STREAK[id];
  if (!t) return null;
  const list = t[stage] || t.any;
  if (!list || !list.length) return null;
  return rng && typeof rng.pick === 'function' ? rng.pick(list) : list[0];
}
