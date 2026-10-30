// Rare moments (CONTRACT §10): hidden easter eggs that real people meet about as often as they do in the world —
// saving a stranger's life, meeting an astronaut, a stem-cell match, a hole in one, going viral, a new species, an
// Olympic medal, a lottery jackpot, a Nobel prize. Each is gated by plausibility (age, education, career, country,
// era, flags) and has a yearly probability for an eligible person; together roughly 1–3 % of lives find one.
// Each can happen once per life, at most one a year and two a life.
// Pure module: no DOM, no Math.random, no Date.

import { Rng, hashString } from './rng.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const num = (v, d = 0) => (isNum(v) ? v : d);
const clampN = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// countries with an astronaut corps or a crewed spaceflight programme whose astronauts often visit schools
const SPACE = new Set(['USA', 'RUS', 'CHN', 'JPN', 'FRA', 'DEU', 'ITA', 'CAN', 'GBR', 'KAZ', 'ESP', 'NLD', 'BEL', 'SWE', 'CHE', 'AUT', 'DNK', 'ARE', 'IND', 'KOR', 'SAU', 'ISR', 'BRA', 'POL', 'HUN', 'TUR']);
// countries where state or licensed lotteries are not part of ordinary life
const NO_LOTTERY = new Set(['SAU', 'IRN', 'AFG', 'YEM', 'QAT', 'KWT', 'BRN', 'LBY', 'SDN', 'SOM', 'MDV', 'PAK', 'OMN']);
// golf is played by a meaningful number of people
const GOLF = new Set(['USA', 'CAN', 'GBR', 'IRL', 'AUS', 'NZL', 'JPN', 'KOR', 'ZAF', 'SWE', 'DEU', 'FRA', 'ESP', 'NLD', 'DNK', 'NOR', 'FIN', 'CHE', 'AUT', 'BEL', 'ITA', 'PRT', 'ARG', 'MEX', 'CHN', 'TWN', 'THA', 'MYS', 'SGP', 'ARE', 'IND']);
const RESEARCH_RE = /研究|科学|教授|医生|工程师|AI|学者|技术员/;

const HIC_UMC = (f) => f.hic || f.umc;
/** the medal events: summer games every 4 years (2000, 2004 ...), winter games in between (2002, 2006 ...) */
const olympicYear = (y) => y % 2 === 0;

/**
 * RARE = [{id, title, p(f, mods) -> yearly probability (0 when not eligible), text(f, R) -> zh, fx:[h,hap,know,rel],
 *          cash?(f) -> intl $, flags?}]
 * f = events.lifeFacts; mods = the year's focus mods (mods.rare multiplies the good-deed ones).
 */
export const RARE = [
  {
    id: 'save_life', title: '救人一命',
    p: (f, m) => (f.in(16, 78) && f.health >= 35 ? 0.00016 * num(m.rare, 1) * (f.flags.volunteer ? 1.5 : 1)
      * (/医|护/.test(`${f.title}${f.field || ''}`) ? 3 : 1) * (f.military || f.veteran ? 1.6 : 1) : 0),
    text: (f, R) => {
      if (/医|护/.test(`${f.title}${f.field || ''}`)) return '航班上，广播里在找医生。你解开安全带走了过去，一直守着那位突然昏倒的乘客，直到飞机落地、救护车开走。几个月后，你收到了一封手写的感谢信。';
      return R.pick(f.r
        ? ['夏天的傍晚，你听见河边有孩子在呼救。你没有多想就跳了下去，把孩子托上了岸。孩子的母亲跪在地上哭着道谢，你浑身湿透，手一直在抖。', '田埂上，一位老人突然倒地不起。你一边喊人一边按照学过的办法做心肺复苏，直到乡里的医生赶来。老人后来出院时，特意来看了你。']
        : ['地铁站里，一个人突然倒在你面前。你跪下来做心肺复苏，一下一下数着，直到急救人员接手。后来你才知道，他活了下来。', '你在商场里看见一位老人被食物噎住，脸色发紫。你冲上去用学过的急救法从背后抱住他，几次用力之后，那块食物终于咳了出来。']);
    },
    fx: [0, 6, 1, 3],
  },
  {
    id: 'astronaut', title: '见到宇航员',
    p: (f) => (SPACE.has(f.iso) && f.in(8, 70) && f.year >= 2000 ? 0.00012 * (f.inSchool && f.age <= 18 ? 3 : 1) * (f.eduRank >= 5 ? 1.5 : 1) * (f.u ? 1.3 : 0.6) : 0),
    text: (f) => (f.age <= 18
      ? '学校请来了一位真正的宇航员。他讲了在太空里怎么睡觉、怎么喝水，还说从太空看地球，看不见国与国之间的线。你举手问了一个问题，他认真地回答了你。那天晚上，你很久都睡不着。'
      : '你在一场科普讲座上见到了一位刚从太空回来的宇航员。散场后你挤到前面，和他握了握手。他的手很有力，你回家后把那张合影设成了手机屏保。'),
    fx: [0, 4, 3, 1],
  },
  {
    id: 'marrow', title: '生命的配型',
    p: (f) => (f.in(18, 50) && f.health >= 55 && (HIC_UMC(f) || f.u) && f.year >= 2002 ? 0.00004 * (f.flags.donor ? 6 : 1) * (f.flags.volunteer ? 2 : 1) : 0),
    text: () => '多年前登记的造血干细胞捐献信息，在这一年和一位素不相识的病人配型成功了。你躺在采集室里，看着自己的血慢慢流过机器，想着远方那个正在等待的人。一年后，你收到消息：那个人康复了。',
    fx: [-1, 6, 1, 3],
    flags: { donor: true },
  },
  {
    id: 'hole_in_one', title: '一杆进洞',
    p: (f) => (GOLF.has(f.iso) && f.in(28, 82) && f.incomePct >= 0.8 && f.u && HIC_UMC(f) && f.health >= 45 ? 0.0006 : 0),
    text: () => '一个周末的清晨，你在球场上挥出一杆，球落地、弹跳、滚动，然后——消失在了洞里。一起打球的朋友愣了两秒，才大叫起来。按照老规矩，那天晚上你请所有人喝了一杯。',
    fx: [1, 6, 0, 2],
  },
  {
    id: 'viral', title: '意外走红',
    p: (f) => (f.in(12, 75) && f.year >= 2012 && f.internet >= 50 && f.social ? 0.00009 : 0),
    text: (f) => (f.age >= 60
      ? '孙辈随手拍下你跳舞的视频发到了网上，没想到被转发了几十万次。好多陌生人留言说“想有个这样的爷爷奶奶”。几个星期后热度散了，你说：“还是过日子要紧。”'
      : '你随手发的一段视频突然被转发了几十万次，一夜之间，很多陌生人知道了你的名字。有人夸你，也有人说难听的话。几个星期后，热度慢慢散去，生活又回到了原样。'),
    fx: [0, 3, 0, 2],
  },
  {
    id: 'species', title: '发现新物种',
    p: (f) => {
      if (!f.in(22, 75)) return 0;
      if (f.eduRank >= 6) return 0.00006 * (/农|生物|医/.test(`${f.field || ''}${f.sector}`) ? 5 : 1);
      if (f.eduRank >= 5 && /摄影/.test(String(f.flags.hobby || ''))) return 0.00001;
      return 0;
    },
    text: (f) => (f.eduRank >= 6
      ? '你在一次野外考察中采到了一只从没见过的小甲虫。经过两年的比对，它被确认是科学上的新物种。论文发表时，它的学名里带着你的名字。'
      : '你在山里拍到了一种从没见过的小兰花，把照片发给了研究所的朋友。一年后，专家确认那是一个新物种，论文的致谢里写着你的名字。'),
    fx: [0, 6, 4, 2],
  },
  {
    id: 'fossil', title: '石头里的秘密',
    p: (f) => (f.in(7, 15) && f.r ? 0.00004 : f.in(16, 80) && /摄影|钓鱼|爬山/.test(String(f.flags.hobby || '')) ? 0.00001 : 0),
    text: (f) => (f.age <= 15
      ? '你在河滩上捡到一块带着奇怪纹路的石头，老师把它送去了博物馆。专家说，那是一块很少见的古生物化石。现在它就陈列在展柜里，标签上写着你的名字。'
      : '你在山间小路上踢到一块石头，翻过来一看，上面印着一条小鱼的骨架。博物馆的研究员说，那是几千万年前的鱼化石，你把它捐了出去。'),
    fx: [0, 5, 3, 1],
  },
  {
    id: 'olympic', title: '奥运奖牌',
    p: (f) => (f.flags.athlete && f.in(17, 34) && f.health >= 70 && olympicYear(f.year) ? 0.004 * (f.flags.athleteTalent ? 2 : 1) * (HIC_UMC(f) ? 1.4 : 0.7) : 0),
    text: (f, R) => {
      const medal = R.pick(['金牌', '银牌', '铜牌', '铜牌']);
      return `你站上了奥运会的领奖台，脖子上挂着一枚${medal}。那一刻，你想起了无数个天不亮就去训练的清晨，眼泪止不住地往下掉。回到${f.country}时，机场里有人举着写有你名字的牌子。`;
    },
    fx: [2, 10, 1, 4],
    cash: (f) => 2 * Math.max(4000, f.monthRef * 12),
  },
  {
    id: 'lottery', title: '彩票头奖',
    p: (f) => (!NO_LOTTERY.has(f.iso) && !f.muslim && f.in(25, 85) ? 0.000004 * (f.flags.gambler ? 4 : 1) : 0),
    text: () => '你随手买的一张彩票中了头奖。兑奖那天，你戴着帽子和口罩，签字时手一直在抖。消息不知怎么传开了，好多多年不联系的亲戚都打来了电话。你想了很久，决定先把钱存起来，慢慢想清楚再用。',
    fx: [0, 8, 0, -1],
    // a headline jackpot: about 80 years of the country's average consumption per head
    cash: (f) => 80 * Math.max(2000, num(f.gdp, 10000) * num(f.cons, 0.6)),
  },
  {
    id: 'nobel', title: '诺贝尔奖',
    p: (f) => (f.eduRank >= 6 && f.know >= 88 && f.in(48, 90) && RESEARCH_RE.test(`${f.title}${f.sector}${f.field || ''}`) ? 0.00002 : 0),
    text: (f) => `十月的一个清晨，一通来自斯德哥尔摩的电话把你叫醒：你几十年前的一项研究获得了诺贝尔奖。你在电话这头愣了很久，第一个念头是想告诉${f.parentAlive ? '父母' : f.hasPartner ? '{partner}' : '当年的老师'}。`,
    fx: [0, 10, 5, 4],
    cash: () => 400000,
  },
];
const BY_ID = new Map(RARE.map((r) => [r.id, r]));
export function rareDef(id) { return BY_ID.get(id); }

/**
 * Roll for a rare moment this year. state.rare lists what was already found. Returns
 * {id, title, text, effects:{health,happiness,knowledge,relationships}, cash, flags?} or null.
 * fillText (optional) fills {partner} and other variables.
 */
export function rollRare(state, f, mods, rng, fillText) {
  if (!f || !state) return null;
  const found = Array.isArray(state.rare) ? state.rare : [];
  if (found.length >= 2) return null;
  if (found.some((r) => r && r.year === f.year)) return null;
  const R = rng && typeof rng.next === 'function' ? rng : new Rng(hashString(`${state.id}|rare|${f.year}`));
  const m = mods && typeof mods === 'object' ? mods : {};
  for (const def of RARE) {
    if (found.some((r) => r && r.id === def.id)) continue;
    let p = 0;
    try { p = num(def.p(f, m), 0); } catch { p = 0; }
    if (!(p > 0)) continue;
    if (!R.chance(clampN(p, 0, 0.05))) continue;
    let text = '';
    try { text = def.text(f, R); } catch { text = ''; }
    if (!text) continue;
    if (typeof fillText === 'function') text = fillText(text);
    const [h, hap, know, rel] = def.fx;
    let cash = 0;
    try { cash = def.cash ? Math.round(num(def.cash(f), 0)) : 0; } catch { cash = 0; }
    const out = { id: def.id, title: def.title, text, effects: { health: h, happiness: hap, knowledge: know, relationships: rel }, cash };
    if (def.flags) out.flags = { ...def.flags };
    return out;
  }
  return null;
}
