// Personal life events (CONTRACT §4 "Personal events", §7 EventInstance).
//
//  - EVENT_LIBRARY: 450+ offline Chinese event templates covering every life stage, both sexes, all income groups,
//    city and village life, regions and cultures, technology eras, real history (2000–2026) and projected world
//    lines (2027–2090, gated by world branches and year).
//  - pickPersonalEvents(data, world, state, ctx, rng) -> EventInstance[]  (0–3 per year, once/cooldown via
//    state.person.flags['ev:'+id] = year, no contradictions with the life state).
//  - fillText(template, state, ctx, rng, extraVars?) resolves {name} {partner} {child} {sibling} {country} {city}
//    {year} {age} and a few more ({bigcity} {festival} {homefood} {crop} {sport} {lang} {storm} {exam} {origin}
//    {granny} {oldsib} {newpartner} {event} {birthyear} and real-data numbers {inflation} {youthUnemp} {unemp}).
//  - lifeFacts(data, world, state, ctx) -> flat precomputed view of one life (shared with decisions.js).
//
// Template shape (CONTRACT §7): { id, when(state, ctx, data, world) -> boolean|number, weight, text: string|string[],
//   tone, tags, tag, effects:{health,happiness,knowledge,relationships}, wealthMonths, set?, hazard?, once?, cooldown? }
// `wealthMonths` is converted to EventInstance.effects.wealthDelta (intl $) from the person's (or household's)
// monthly income, so a windfall means the same thing in Burundi and in Norway. A template whose wording depends on
// the life uses `textFn(facts)` instead of `text`.
//
// Pure module: no DOM, no Math.random, no Date.

import { YEAR_TAGS } from './constants.js';
import { hashString, Rng } from './rng.js';

/* ------------------------------------------------------------------ small helpers */

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
function num(...xs) {
  for (const x of xs) {
    if (isNum(x)) return x;
    if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(+x)) return +x;
  }
  return null;
}
const clampN = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const SET = (s) => new Set(s.split(/\s+/).filter(Boolean));
const stableIndex = (key, n) => (n > 0 ? hashString(String(key)) % n : 0);
/** stable pick skewed to the front of the list (bigger cities are likelier homes) */
function stableFront(key, arr) {
  if (!arr || !arr.length) return undefined;
  const u = (hashString(String(key)) % 10007) / 10007;
  return arr[Math.min(arr.length - 1, Math.floor(Math.pow(u, 1.7) * arr.length))];
}
const safe = (fn, fb = null) => { try { const v = fn(); return v === undefined ? fb : v; } catch { return fb; } };

/* ------------------------------------------------------------------ places and culture */

/** Major cities (Chinese names) for the 40+ most populous countries. Other countries use generic places. */
export const CITIES = {
  IND: ['孟买', '德里', '班加罗尔', '加尔各答', '金奈', '海得拉巴', '艾哈迈达巴德', '浦那', '斋浦尔', '勒克瑙'],
  CHN: ['上海', '北京', '广州', '深圳', '成都', '重庆', '武汉', '杭州', '西安', '南京', '郑州', '长沙', '天津', '苏州'],
  USA: ['纽约', '洛杉矶', '芝加哥', '休斯敦', '菲尼克斯', '费城', '西雅图', '亚特兰大', '达拉斯', '丹佛'],
  IDN: ['雅加达', '泗水', '万隆', '棉兰', '三宝垄', '望加锡', '日惹'],
  PAK: ['卡拉奇', '拉合尔', '费萨拉巴德', '拉瓦尔品第', '伊斯兰堡', '白沙瓦', '木尔坦'],
  NGA: ['拉各斯', '卡诺', '伊巴丹', '阿布贾', '哈科特港', '贝宁城'],
  BRA: ['圣保罗', '里约热内卢', '巴西利亚', '萨尔瓦多', '福塔莱萨', '贝洛奥里藏特', '累西腓', '阿雷格里港'],
  BGD: ['达卡', '吉大港', '库尔纳', '拉杰沙希', '锡尔赫特'],
  RUS: ['莫斯科', '圣彼得堡', '新西伯利亚', '叶卡捷琳堡', '喀山', '下诺夫哥罗德'],
  ETH: ['亚的斯亚贝巴', '德雷达瓦', '默克莱', '贡德尔', '阿瓦萨', '巴赫达尔'],
  MEX: ['墨西哥城', '瓜达拉哈拉', '蒙特雷', '普埃布拉', '蒂华纳', '莱昂'],
  JPN: ['东京', '大阪', '横滨', '名古屋', '札幌', '福冈', '神户', '京都'],
  EGY: ['开罗', '亚历山大', '吉萨', '塞得港', '苏伊士', '卢克索'],
  PHL: ['马尼拉', '奎松城', '宿务', '达沃', '卡加延德奥罗'],
  COD: ['金沙萨', '卢本巴希', '姆布吉马伊', '基桑加尼', '戈马', '布卡武'],
  VNM: ['胡志明市', '河内', '海防', '岘港', '芹苴'],
  IRN: ['德黑兰', '马什哈德', '伊斯法罕', '设拉子', '大不里士'],
  TUR: ['伊斯坦布尔', '安卡拉', '伊兹密尔', '布尔萨', '安塔利亚'],
  DEU: ['柏林', '汉堡', '慕尼黑', '科隆', '法兰克福', '斯图加特', '莱比锡'],
  THA: ['曼谷', '清迈', '孔敬', '合艾', '呵叻'],
  TZA: ['达累斯萨拉姆', '姆万扎', '阿鲁沙', '多多马', '桑给巴尔城'],
  GBR: ['伦敦', '伯明翰', '曼彻斯特', '利兹', '格拉斯哥', '利物浦', '布里斯托'],
  FRA: ['巴黎', '马赛', '里昂', '图卢兹', '尼斯', '南特', '里尔'],
  ZAF: ['约翰内斯堡', '开普敦', '德班', '比勒陀利亚', '伊丽莎白港'],
  ITA: ['罗马', '米兰', '那不勒斯', '都灵', '巴勒莫', '博洛尼亚'],
  KEN: ['内罗毕', '蒙巴萨', '基苏木', '纳库鲁', '埃尔多雷特'],
  MMR: ['仰光', '曼德勒', '内比都', '毛淡棉'],
  COL: ['波哥大', '麦德林', '卡利', '巴兰基亚', '卡塔赫纳'],
  KOR: ['首尔', '釜山', '仁川', '大邱', '大田', '光州'],
  SDN: ['喀土穆', '恩图曼', '苏丹港', '卡萨拉'],
  UGA: ['坎帕拉', '古卢', '姆巴拉拉', '金贾'],
  ESP: ['马德里', '巴塞罗那', '瓦伦西亚', '塞维利亚', '毕尔巴鄂'],
  DZA: ['阿尔及尔', '奥兰', '君士坦丁', '安纳巴'],
  IRQ: ['巴格达', '巴士拉', '摩苏尔', '埃尔比勒', '纳杰夫'],
  ARG: ['布宜诺斯艾利斯', '科尔多瓦', '罗萨里奥', '门多萨'],
  AFG: ['喀布尔', '坎大哈', '赫拉特', '马扎里沙里夫'],
  YEM: ['萨那', '亚丁', '塔伊兹', '荷台达'],
  CAN: ['多伦多', '蒙特利尔', '温哥华', '卡尔加里', '渥太华'],
  AGO: ['罗安达', '万博', '本格拉', '卢班戈'],
  UKR: ['基辅', '哈尔科夫', '敖德萨', '第聂伯', '利沃夫'],
  MAR: ['卡萨布兰卡', '拉巴特', '马拉喀什', '菲斯', '丹吉尔'],
  POL: ['华沙', '克拉科夫', '罗兹', '弗罗茨瓦夫', '格但斯克'],
  UZB: ['塔什干', '撒马尔罕', '纳曼干', '布哈拉'],
  MYS: ['吉隆坡', '新山', '槟城', '怡保', '古晋'],
  MOZ: ['马普托', '贝拉', '楠普拉'],
  AUS: ['悉尼', '墨尔本', '布里斯班', '珀斯', '阿德莱德'],
  SAU: ['利雅得', '吉达', '达曼', '麦加'],
  NPL: ['加德满都', '博卡拉', '比拉德讷格尔'],
  GHA: ['阿克拉', '库马西', '塔马利'],
  PER: ['利马', '阿雷基帕', '特鲁希略'],
  VEN: ['加拉加斯', '马拉开波', '巴伦西亚'],
  CHL: ['圣地亚哥', '瓦尔帕莱索', '康塞普西翁'],
  TWN: ['台北', '高雄', '台中', '台南', '新北'],
  HKG: ['香港'], MAC: ['澳门'], SGP: ['新加坡'],
  NLD: ['阿姆斯特丹', '鹿特丹', '海牙', '乌得勒支'],
  LKA: ['科伦坡', '康提', '加勒'],
  KAZ: ['阿拉木图', '阿斯塔纳', '奇姆肯特'],
  ARE: ['迪拜', '阿布扎比', '沙迦'],
  SYR: ['大马士革', '阿勒颇', '霍姆斯'],
  CMR: ['杜阿拉', '雅温得'], CIV: ['阿比让', '布瓦凯'], NZL: ['奥克兰', '惠灵顿', '基督城'],
  KHM: ['金边', '暹粒'], ECU: ['瓜亚基尔', '基多'], GTM: ['危地马拉城'], ZWE: ['哈拉雷', '布拉瓦约'],
  SEN: ['达喀尔'], RWA: ['基加利'], ISR: ['特拉维夫', '耶路撒冷', '海法'], JOR: ['安曼'], LBN: ['贝鲁特'],
  PRT: ['里斯本', '波尔图'], GRC: ['雅典', '塞萨洛尼基'], SWE: ['斯德哥尔摩', '哥德堡'], CUB: ['哈瓦那'],
};

const FESTIVALS = {
  CHN: ['春节', '中秋节'], TWN: ['春节', '中秋节'], HKG: ['春节', '中秋节'], MAC: ['春节', '中秋节'], SGP: ['春节', '开斋节'],
  VNM: ['春节', '中秋节'], KOR: ['春节', '秋夕'], JPN: ['新年', '盂兰盆节'], MNG: ['白月节', '那达慕'],
  IND: ['排灯节', '洒红节'], NPL: ['德赛节', '排灯节'], LKA: ['僧伽罗和泰米尔新年'], BTN: ['洛萨节'],
  THA: ['宋干节'], LAO: ['宋干节'], MMR: ['泼水节'], KHM: ['高棉新年'], PHL: ['圣诞节'], MYS: ['开斋节', '春节'],
  IRN: ['诺鲁孜节'], AFG: ['诺鲁孜节', '开斋节'], TJK: ['诺鲁孜节'], AZE: ['诺鲁孜节'], KAZ: ['诺鲁孜节', '新年'],
  UZB: ['诺鲁孜节', '开斋节'], KGZ: ['诺鲁孜节'], TKM: ['诺鲁孜节'], ISR: ['逾越节', '光明节'], LBN: ['开斋节', '圣诞节'],
  ETH: ['埃塞俄比亚新年', '主显节'], NGA: ['圣诞节', '开斋节'], TZA: ['圣诞节', '开斋节'],
  RUS: ['新年', '东正教复活节'], UKR: ['新年', '复活节'], BLR: ['新年'], MDA: ['新年'], BGR: ['新年', '复活节'], ROU: ['圣诞节', '复活节'],
  USA: ['感恩节', '圣诞节'], CAN: ['圣诞节', '感恩节'], MEX: ['亡灵节', '圣诞节'], BRA: ['狂欢节', '圣诞节'],
  TTO: ['狂欢节'], ESP: ['圣诞节', '三王节'], ITA: ['圣诞节', '复活节'],
};
const MUSLIM = SET('AFG PAK BGD MDV IDN MYS BRN IRN TUR AZE ARE SAU QAT KWT BHR OMN JOR IRQ SYR YEM PSE DZA EGY LBY MAR TUN SDN SEN MLI NER GIN GMB SOM MRT DJI COM KAZ UZB KGZ TJK TKM ALB XKX');

const HOMEFOOD = {
  CHN: ['饺子', '红烧肉', '番茄炒蛋', '手擀面'], TWN: ['卤肉饭', '牛肉面'], HKG: ['云吞面', '煲仔饭'], SGP: ['海南鸡饭'],
  JPN: ['味噌汤', '咖喱饭', '饭团'], KOR: ['大酱汤', '泡菜炒饭'], VNM: ['河粉', '春卷'], THA: ['冬阴功汤', '绿咖喱'],
  IDN: ['炒饭', '巴东牛肉'], PHL: ['阿斗波炖肉'], MYS: ['椰浆饭'], IND: ['豆子咖喱', '烙饼', '香料奶茶'], PAK: ['抓饭', '烤馕'],
  BGD: ['鱼咖喱饭'], NPL: ['扁豆汤配米饭'], LKA: ['椰子咖喱'], IRN: ['藏红花饭'], TUR: ['扁豆汤', '烤肉'], EGY: ['库沙里'],
  MAR: ['塔吉锅'], NGA: ['乔洛夫饭'], ETH: ['英杰拉配炖菜'], KEN: ['玉米糊配羽衣甘蓝'], ZAF: ['烤肉和玉米粥'],
  MEX: ['玉米饼', '莫莱酱鸡'], BRA: ['黑豆饭'], ARG: ['烤牛肉'], COL: ['土豆鸡肉汤'], PER: ['柠汁腌鱼'],
  USA: ['苹果派', '烤鸡'], CAN: ['肉汁薯条'], GBR: ['周日烤肉'], FRA: ['蔬菜炖肉'], ITA: ['番茄意面'], ESP: ['西班牙海鲜饭'],
  DEU: ['土豆炖肉'], RUS: ['红菜汤', '饺子'], UKR: ['红菜汤'], POL: ['波兰饺子'],
};
const REGION_FOOD = {
  EAS: ['米饭和家常菜'], SEA: ['米饭和咸鱼'], SAS: ['咖喱'], CAS: ['抓饭'], WAS: ['烤饼和豆泥'], NAF: ['古斯米'],
  SSA: ['玉米糊'], EEU: ['土豆炖肉'], WEU: ['家常炖菜'], NAM: ['烤鸡'], LAC: ['豆子炖肉'], OCE: ['烤肉'],
};
const REGION_CROPS = {
  EAS: ['水稻', '玉米', '小麦'], SEA: ['水稻', '木薯'], SAS: ['水稻', '小麦'], CAS: ['棉花', '小麦'], WAS: ['小麦', '大麦'],
  NAF: ['小麦', '橄榄'], SSA: ['玉米', '木薯', '高粱'], EEU: ['小麦', '土豆'], WEU: ['小麦', '葡萄'], NAM: ['玉米', '小麦'],
  LAC: ['玉米', '豆子', '咖啡'], OCE: ['小麦', '甘蔗'],
};
const SPORTS = {
  IND: '板球', PAK: '板球', BGD: '板球', LKA: '板球', AFG: '板球', USA: '篮球', CAN: '冰球', CHN: '乒乓球', JPN: '棒球',
  NZL: '橄榄球', FJI: '橄榄球', WSM: '橄榄球', TON: '橄榄球', AUS: '板球', CUB: '棒球', DOM: '棒球', VEN: '棒球',
  PHL: '篮球', TWN: '棒球', KEN: '长跑', ETH: '长跑', LTU: '篮球',
};
const MONSOON = SET('IND BGD PAK NPL LKA MMR THA VNM LAO KHM PHL BTN');
const TYPHOON = SET('PHL VNM CHN TWN JPN KOR HKG MAC');
const HURRICANE = SET('USA MEX CUB HTI DOM JAM HND NIC BHS PRI GTM BLZ SLV ATG DMA GRD KNA LCA VCT BRB TTO');
const CYCLONE = SET('IND BGD MMR MOZ MDG LKA PAK OMN AUS FJI VUT TON WSM');
const QUAKE = SET('JPN CHN TWN IDN PHL NPL TUR IRN CHL PER ECU MEX NZL HTI PAK AFG ITA GRC GTM SLV COL MMR');
const REMIT = SET('PHL NPL BGD IND PAK LKA MEX SLV GTM HND NIC DOM HTI JAM TJK KGZ UZB MDA UKR EGY MAR NGA GHA SEN KEN LBR GMB VNM IDN MMR LBN JOR YEM SOM ZWE LSO ARM GEO ALB XKX TON WSM KHM');
export const GULF = SET('ARE SAU QAT KWT OMN BHR');
const ENGLISH = SET('USA GBR CAN AUS NZL IRL');
const SNOW = SET('RUS UKR BLR KAZ MNG CAN FIN SWE NOR EST LVA LTU POL KOR JPN USA DEU AUT CHE CZE SVK ISL KGZ');
const DUST = SET('MNG CHN EGY SAU IRQ KWT IRN SDN NER TCD MLI KAZ UZB TKM ARE QAT');
const SMOG = SET('CHN IND PAK BGD EGY NPL MNG IRN');
const WILDFIRE = SET('USA CAN AUS GRC PRT ESP TUR RUS CHL BOL ITA');
const LOCUST = SET('ETH KEN SOM PAK IND YEM SAU IRN UGA SDN ERI DJI');
const SINIC = SET('CHN TWN HKG MAC SGP');
const EXAM_CULTURE = SET('CHN TWN HKG MAC SGP KOR JPN VNM');
const NORDIC_LEAVE = SET('SWE NOR DNK FIN ISL DEU NLD');
const CHRISTMAS = SET('PHL TLS KEN UGA GHA ZAF ZMB ZWE MWI COD COG AGO NAM BWA RWA BDI CMR PNG FJI POL CZE SVK HUN HRV SVN LTU LVA EST');
const EUROZONE = SET('DEU FRA ITA ESP PRT NLD BEL AUT IRL FIN GRC LUX');
/** Theravada / Tibetan Buddhist majorities: alms rounds and temple visits, not church or incense in a Chinese temple */
const BUDDHIST = SET('THA MMR KHM LAO LKA BTN MNG');

const KIN_OLD = ['哥哥', '姐姐'];
const KIN_ANY = ['哥哥', '姐姐', '弟弟', '妹妹'];

/* ------------------------------------------------------------------ names */

const FALLBACK_NAMES = {
  sinic: { s: ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '林', '何', '郭', '高', '罗', '郑', '梁', '谢'],
    male: ['浩然', '子轩', '宇航', '俊杰', '明轩', '嘉豪', '博文', '思远', '一鸣', '天佑', '志强', '建华'],
    female: ['欣怡', '梓涵', '雨桐', '诗琪', '思雨', '可欣', '佳怡', '若曦', '雅静', '晓彤', '婉清', '丽娟'] },
  JPN: { s: ['佐藤', '铃木', '高桥', '田中', '渡边', '伊藤'], male: ['大翔', '莲', '悠真', '阳翔', '拓海', '健太'], female: ['结衣', '阳菜', '葵', '美咲', '凛', '优子'] },
  KOR: { s: ['金', '李', '朴', '崔', '郑', '姜'], male: ['敏俊', '志勋', '贤宇', '东贤', '俊浩', '在民'], female: ['智恩', '秀妍', '瑞贤', '敏智', '惠真', '恩惠'] },
  VNM: { s: ['阮', '陈', '黎', '范', '黄'], male: ['文安', '明德', '国俊', '清松', '光海'], female: ['氏兰', '玉华', '秋香', '美玲', '青心'] },
  SAS: { male: ['拉胡尔', '阿米特', '阿尔琼', '维克拉姆', '拉维', '萨米尔'], female: ['普丽娅', '阿妮塔', '苏妮塔', '卡维娅', '迪维娅', '妮莎'] },
  MUS: { male: ['阿里', '优素福', '奥马尔', '哈桑', '穆斯塔法', '卡里姆'], female: ['法蒂玛', '莱拉', '阿伊莎', '萨拉', '努尔', '玛丽亚姆'] },
  SSA: { male: ['科菲', '奇迪', '约瑟夫', '姆万吉', '阿马杜', '塞缪尔'], female: ['阿玛', '法图玛', '格蕾丝', '恩戈齐', '阿伊莎', '埃丝特'] },
  LAC: { male: ['胡安', '卡洛斯', '路易斯', '迭戈', '马特奥', '何塞'], female: ['玛丽亚', '卡米拉', '瓦伦蒂娜', '露西亚', '伊莎贝拉', '索菲亚'] },
  EEU: { male: ['伊万', '德米特里', '安德烈', '谢尔盖', '阿列克谢', '马克西姆'], female: ['安娜', '奥尔加', '娜塔莉亚', '叶卡捷琳娜', '玛丽亚', '伊琳娜'] },
  CAS: { male: ['阿利舍尔', '努尔兰', '铁木尔', '鲁斯兰'], female: ['迪尔诺扎', '艾达', '古丽', '玛迪娜'] },
  SEA: { male: ['阿里夫', '达尼', '颂猜', '约翰', '班尼'], female: ['阿雅', '玛丽', '西蒂', '妮拉', '安娜'] },
  WEST: { male: ['卢卡斯', '丹尼尔', '托马斯', '詹姆斯', '马克', '本杰明'], female: ['艾玛', '索菲亚', '奥利维亚', '汉娜', '劳拉', '克洛伊'] },
};

/**
 * A plausible Chinese-transliterated name for someone from iso3 (partners, adopted children, friends).
 * Uses content.names when present, otherwise a regional fallback. Never returns an empty string.
 */
export function personName(data, iso3, sex, rng) {
  const pick = (arr) => (rng && typeof rng.pick === 'function' ? rng.pick(arr) : arr[0]);
  const sx = sex === 'female' ? 'female' : 'male';
  const N = safe(() => data.content.names.countries[iso3]);
  if (N && Array.isArray(N[sx])) {
    const given = N[sx].filter((x) => typeof x === 'string' && x.trim());
    if (given.length) {
      const g = pick(given);
      const sur = Array.isArray(N.surnames) ? N.surnames.filter((x) => typeof x === 'string' && x.trim()) : [];
      if (N.format === 'surname+given' && sur.length) return pick(sur) + g;
      return g;
    }
  }
  const region = safe(() => data.country(iso3).region) || safe(() => data.countries[iso3].region) || '';
  let key = 'WEST';
  if (SINIC.has(iso3)) key = 'sinic';
  else if (iso3 === 'JPN' || iso3 === 'KOR' || iso3 === 'VNM') key = iso3;
  else if (region === 'SAS' && !MUSLIM.has(iso3)) key = 'SAS';
  else if (MUSLIM.has(iso3) || region === 'WAS' || region === 'NAF') key = region === 'CAS' ? 'CAS' : 'MUS';
  else if (region === 'SSA') key = 'SSA';
  else if (region === 'LAC') key = 'LAC';
  else if (region === 'EEU') key = 'EEU';
  else if (region === 'CAS') key = 'CAS';
  else if (region === 'SEA') key = 'SEA';
  else if (region === 'EAS') key = 'sinic';
  const T = FALLBACK_NAMES[key];
  const g = pick(T[sx]);
  return T.s ? pick(T.s) + g : g;
}

/* ------------------------------------------------------------------ world-line branch reading */

function branchText(world) {
  const out = [];
  const b = world && world.branches && typeof world.branches === 'object' ? world.branches : {};
  for (const [dim, br] of Object.entries(b)) out.push([String(dim).toLowerCase(), String(br).toLowerCase()]);
  if (world && Array.isArray(world.dims)) {
    for (const d of world.dims) {
      if (!d) continue;
      const br = d.branch || {};
      out.push([`${d.id || ''} ${d.title || ''}`.toLowerCase(), `${br.id || ''} ${br.title || ''}`.toLowerCase()]);
    }
  }
  return out;
}
/** 'high' | 'mid' | 'low' for the first world dimension whose id/title matches dimRe. */
function branchLevel(pairs, dimRe, highRe, lowRe, lowFirst = false) {
  for (const [dim, br] of pairs) {
    if (!dimRe.test(dim)) continue;
    if (lowFirst && lowRe.test(br)) return 'low';
    if (highRe.test(br)) return 'high';
    if (lowRe.test(br)) return 'low';
    return 'mid';
  }
  return 'mid';
}

/* ------------------------------------------------------------------ world events */

function evText(e) { return `${e.id || ''} ${e.refId || ''} ${e.title || ''} ${e.summary || ''}`; }
const evHead = (e) => `${e.id || ''} ${e.refId || ''} ${e.title || ''}`;
const isArmed = (e) => e && (e.category === 'war' || e.category === 'conflict');

/**
 * The engine's test for a war that reaches the whole country (Context.conflict 3), used only for a context built
 * without a conflict level: an event of the highest importance or a national casualty estimate of +10 % deaths.
 */
function nationwideWar(e, iso) {
  if (num(e.importance, 2) >= 5) return true;
  const m = e.mortality && typeof e.mortality === 'object' ? e.mortality : null;
  if (!m || (Array.isArray(m.applies_to) && m.applies_to.length && !m.applies_to.includes(iso))) return false;
  return num(m.mult, 1) >= 1.1;
}
/** share of a country's people who live where one of its regional armed conflicts is fought (10-22 %) */
const zoneShare = (e) => clampN(0.04 * num(e.importance, 3) + (num(e.effects && e.effects.safety, -2) <= -3 ? 0.02 : 0), 0.1, 0.22);
const ZONE_CAP = 0.25;
/**
 * The regional conflict (if any) fought where this life is lived: one deterministic draw per life and event against
 * the share of the population in the affected area. Conflicts are taken oldest first and together never cover more
 * than a quarter of the country, so a life inside a war zone stays inside it while that conflict lasts.
 */
function warZoneOf(lifeKey, evs) {
  if (!evs.length) return null;
  const list = evs.slice().sort((a, b) => num(a.year, 0) - num(b.year, 0) || String(a.id || a.title || '').localeCompare(String(b.id || b.title || '')));
  let room = ZONE_CAP;
  for (const e of list) {
    const s = Math.min(zoneShare(e), room);
    if (s <= 0) break;
    if ((hashString(`${lifeKey}|zone|${e.id || e.title || ''}`) % 10007) / 10007 < s) return e;
    room -= s;
  }
  return null;
}

const isCovid = (e) => /covid|新冠|冠状/i.test(evText(e));
/**
 * An epidemic event that is an outbreak people live through this year: it harms health, and it is not a treatment
 * roll-out, a vaccination campaign or a slow chronic burden (opioids, AIDS, malaria, TB, drug resistance, polio).
 */
const isOutbreak = (e) => e && e.category === 'epidemic' && num(e.effects && e.effects.health, -1) < 0
  && !/阿片|芬太尼|opioid|艾滋|hiv|aids|疟疾|malaria|结核|耐药|amr|丙肝|脊灰|polio/i.test(evHead(e));
/** a projected pandemic on the COVID scale or worse (masks, distancing, closed schools) */
const PANDEMIC_RE = /pandemic_covid|pandemic_severe|新的全球大流行|严重大流行/i;

/* ------------------------------------------------------------------ life facts */

const EDU_ORDER = ['none', 'preschool', 'primary', 'secondary', 'vocational', 'tertiary', 'postgrad'];
const factCache = new WeakMap();

/**
 * Flat, precomputed view of a life in its current year (used by every template and by decisions.js).
 * Robust to partial states and to missing data/world/content.
 */
export function lifeFacts(data, world, state, ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const sig = factSig(state);
  if (ctx && typeof ctx === 'object') {
    const m = factCache.get(ctx);
    if (m && m.state === state && m.world === world && m.sig === sig) return m.f;
  }
  const f = computeFacts(data, world, state || {}, c);
  if (ctx && typeof ctx === 'object') factCache.set(ctx, { state, world, sig, f });
  return f;
}
/** cheap signature of everything in a life that the facts depend on and that can change within a year */
function factSig(state) {
  if (!state || typeof state !== 'object') return '';
  const p = state.person || {};
  const fl = p.flags && typeof p.flags === 'object' ? p.flags : {};
  const fk = Object.keys(fl);
  const e = p.education || {};
  const cr = p.career || {};
  const r = p.relationship || {};
  const st = state.stats || {};
  const m = p.money || {};
  return [state.year, state.age, p.country, p.urban, e.level, e.inSchool, e.field, cr.status, cr.incomePct, cr.title, r.status, r.partner && r.partner.name,
    Array.isArray(p.children) ? p.children.length : 0, Array.isArray(p.conditions) ? p.conditions.length : 0, fk.length,
    fk.filter((k) => !k.startsWith('ev:') && !k.startsWith('hook:')).map((k) => `${k}=${fl[k]}`).join(','),
    st.health, st.happiness, st.knowledge, st.relationships, st.wealth, m.cash, m.debt].join('|');
}

function computeFacts(data, world, state, ctx) {
  const p = state.person || {};
  const birth = state.birth || {};
  const year = Math.round(num(state.year, ctx.year, birth.year, 2000));
  const age = Math.max(0, Math.round(num(state.age, year - num(birth.year, year), 0)));
  const iso = p.country || ctx.iso3 || birth.country || 'CHN';
  const C = safe(() => data.country(iso)) || safe(() => data.countries[iso]) || {};
  const region = ctx.region || C.region || 'EAS';
  const ser = (k) => {
    const v = safe(() => (world && typeof world.indicator === 'function' ? world.indicator(iso, k, year) : null));
    if (isNum(v)) return v;
    const d = safe(() => data.series(iso, k, year));
    return isNum(d) ? d : null;
  };
  const inc = ctx.incomeGroup || safe(() => data.incomeGroup(iso, year)) || C.income_now || 'UMC';
  const flags = p.flags && typeof p.flags === 'object' ? p.flags : {};
  const sex = p.sex === 'female' || birth.sex === 'female' ? 'female' : 'male';
  const urban = p.urban != null ? !!p.urban : !!birth.urban;
  const fam = clampN(num(p.familyPct, birth.familyPct, 0.5), 0, 1);
  const edu = (p.education && p.education.level) || 'none';
  const inSchool = !!(p.education && p.education.inSchool);
  const career = p.career || {};
  const status = career.status || (age < 15 ? 'child' : 'unemployed');
  const relS = (p.relationship && p.relationship.status) || 'single';
  const partner = p.relationship && p.relationship.partner;
  const kids = (Array.isArray(p.children) ? p.children : [])
    .filter((k) => k && k.alive !== false)
    .map((k) => ({ name: k.name || '孩子', sex: k.sex, birthYear: num(k.birthYear, year), age: year - num(k.birthYear, year) }))
    .filter((k) => k.age >= 0);
  const par = p.parents || {};
  const mom = par.mother || {};
  const dad = par.father || {};
  const momAlive = mom.alive !== false && mom.alive != null ? true : mom.alive === undefined ? age < 60 : false;
  const dadAlive = dad.alive !== false && dad.alive != null ? true : dad.alive === undefined ? age < 55 : false;
  const parentAgeMax = Math.max(momAlive ? num(mom.age, age + 28) : 0, dadAlive ? num(dad.age, age + 31) : 0);
  const money = p.money || {};
  const pf = money.portfolio || {};
  const portfolio = ['stocks', 'bonds', 'gold', 'property', 'crypto'].reduce((s, k) => s + (num(pf[k]) || 0), 0);
  const stats = state.stats || {};
  const conds = Array.isArray(p.conditions) ? p.conditions.filter(Boolean) : [];
  const lp = safe(() => data.lifePath(iso)) || {};

  const internet = num(ctx.internet, ser('internet'), year < 2010 ? 20 : 60);
  const mobile = num(ser('mobile'), internet * 1.5);
  const gdp = num(ctx.gdp, ser('gdp_pc_ppp'), inc === 'HIC' ? 50000 : inc === 'UMC' ? 15000 : inc === 'LMC' ? 6000 : 2000);
  const cons = num(C.consumption_share, 0.6);
  const famIncome = Math.max(300, gdp * cons * (0.3 + 1.7 * fam));
  const income = num(money.income) || 0;
  const evs = Array.isArray(ctx.events) ? ctx.events.filter(Boolean)
    : (safe(() => world.events(iso, year)) || []).filter(Boolean);
  const mods = safe(() => world.modifiers(iso, year)) || {};
  const pairs = branchText(world);
  const aiL = branchLevel(pairs, /(^|[^a-z])ai|artificial|tech|automat|智能|技术/, /transform|fast|rapid|break|agi|super|accel|boom|explos|surge|激进|突破|爆发|快速/, /stall|slow|winter|plateau|restrict|regulat|backlash|frag|ban|pause|停滞|放缓|管制/);
  const climL = branchLevel(pairs, /clim|warm|carbon|temp|气候|升温/, /hot|severe|high|fail|delay|overshoot|worst|bad|tipping|3c|4c|失控|严重|高排放/, /net.?zero|1\.?5|green|paris|good|transition|success|low|达标|绿色|转型/, true);
  const healthL = branchLevel(pairs, /health|longev|bio|medic|aging|健康|医疗|长寿/, /break|longev|cure|radical|fast|rejuv|boom|revolution|突破|长寿/, /stall|slow|crisis|resist|amr|停滞|危机|耐药/);
  const geoL = branchLevel(pairs, /geo|conflict|war|order|politic|secur|地缘|冲突|格局/, /cold|bloc|frag|conflict|war|tension|split|decoupl|escalat|对抗|分裂|冲突/, /cooperat|multilateral|peace|stable|detente|integr|合作|和平|稳定/);
  const ubiBranch = pairs.some(([d, b]) => /work|labor|welfare|income|social|就业|福利/.test(d) && /ubi|basic|universal|基本收入/.test(b));
  const spaceL = branchLevel(pairs, /space|太空|航天/, /boom|fast|mars|settle|colony|繁荣|火星/, /slow|stall|停滞/);
  const aiDelay = aiL === 'high' ? 0 : aiL === 'mid' ? 6 : 15;
  const healthDelay = healthL === 'high' ? 0 : healthL === 'mid' ? 12 : 25;

  const findEv = (re, cats) => evs.find((e) => (!cats || cats.includes(e.category)) && re.test(evText(e))) || null;
  const conflict = num(ctx.conflict, 0);
  // War at home. The engine reserves Context.conflict 3 for a war that reaches the whole country: then every life is
  // in it. A regional conflict of this country (an insurgency in some provinces, Donbas 2014-21, Boko Haram in the
  // north-east) reaches a life only when it is lived in the war zone (warZoneOf: a deterministic draw per life and
  // event, about the population share of the area). Everyone else, like the other listed countries (neighbours
  // hosting refugees, distant belligerents), is "near" a war: mobilisation, refugees, prices, news.
  const armed = evs.filter(isArmed);
  const severe = (e) => num(e.effects && e.effects.safety, -2) <= -2;
  const listedIn = (e) => Array.isArray(e.countries) && e.countries.includes(iso);
  const unlisted = (e) => (!Array.isArray(e.countries) || !e.countries.length) && e.scope !== 'global';
  const ownWars = armed.filter((e) => severe(e) && Array.isArray(e.countries) && e.countries[0] === iso);
  const regionalWar = armed.some((e) => severe(e) && unlisted(e));
  const anySevere = armed.some(severe);
  const warNation = anySevere && (num(ctx.conflict) != null ? conflict >= 3 : ownWars.some((e) => nationwideWar(e, iso)));
  const zoneWars = ownWars.concat(conflict >= 2 ? armed.filter((e) => severe(e) && unlisted(e)) : []);
  const zoneEv = warNation ? null : warZoneOf(String(state.id || state.seed || p.name || 'life'), zoneWars);
  const warLocal = warNation || !!zoneEv;
  const warNear = !warLocal && (armed.some((e) => severe(e) && listedIn(e)) || regionalWar || (conflict >= 2 && anySevere));
  const warAny = armed.length > 0;
  const covid = year >= 2020 && year <= 2022 && evs.some((e) => e.category === 'epidemic' && isCovid(e));
  // a pandemic of the COVID kind (masks, distancing, the old most at risk): COVID itself or a projected pandemic
  const pandemic = covid || evs.some((e) => isOutbreak(e) && PANDEMIC_RE.test(evHead(e)));
  const finCrisis = evs.some((e) => e.category === 'economy' && num(e.effects && e.effects.economy, 0) <= -2);
  const gdpGrowth = num(ctx.gdpGrowth, ser('gdp_growth'), 2);
  // A disaster touches this life only when it targets this country (or its region), matched on id/title, not on
  // words that happen to appear in the summary of some global trend.
  const targets = (e) => (Array.isArray(e.countries) && e.countries.includes(iso)) || (e.scope === 'regions' && (!Array.isArray(e.regions) || !e.regions.length || e.regions.includes(region)));
  // local outbreaks (SARS, cholera, Ebola, dengue ...) where they actually spread; COVID only as the pandemic
  const outbreaks = evs.filter((e) => isOutbreak(e) && !isCovid(e) && targets(e));
  // schools actually closed for months: such a pandemic, or an outbreak like West Africa's Ebola epidemic
  const lockdown = pandemic || outbreaks.some((e) => num(e.importance, 0) >= 4 && /埃博拉|ebola/i.test(evHead(e)));
  const disasterEv = (re) => evs.find((e) => ['disaster', 'climate', 'environment'].includes(e.category) && targets(e) && re.test(`${e.id || ''} ${e.refId || ''} ${e.title || ''}`)) || null;
  const quake = disasterEv(/地震|海啸|earthquake|quake|tsunami/i);
  const flood = disasterEv(/洪|水灾|内涝|季风|暴雨|flood|monsoon/i);
  const storm = disasterEv(/台风|飓风|气旋|风暴|typhoon|hurricane|cyclone/i);
  const drought = disasterEv(/旱|饥荒|drought|famine/i);
  const heatEv = disasterEv(/热浪|高温|酷热|heat/i);
  const fireEv = disasterEv(/山火|野火|林火|wildfire|bushfire/i);
  // chronic risks of the world line become occasional bad years (deterministic per country, year and world)
  const yearRoll = (salt) => (hashString(`${iso}|${year}|${(world && world.seed) || 0}|${salt}`) % 10007) / 10007;
  const autoEv = year > 2026 ? evs.find((e) => /(^|[^a-z])ai([^a-z]|$)|自动化|机器人|人工智能|智能体|失业潮|automation|robot/i.test(`${e.id || ''} ${e.refId || ''} ${e.title || ''}`) && num(e.effects && e.effects.economy, 0) <= 0) : null;
  const automation = !!autoEv || (year >= 2032 && (aiL === 'high' ? yearRoll('auto') < 0.3 : aiL === 'mid' && year >= 2040 ? yearRoll('auto') < 0.08 : false));
  const refugees = !warLocal && evs.some((e) => num(e.migration_push, 0) >= 2 && (e.countries || [])[0] !== iso);
  const inflation = num(ser('inflation'));
  const heatRisk = num(mods.heat_risk, 0);
  const seaRisk = num(mods.sea_level_risk, 0);
  const hot = ['SAS', 'WAS', 'NAF', 'SSA', 'SEA', 'LAC'].includes(region);
  const heatP = clampN(0.02 + 0.06 * heatRisk + (climL === 'high' && hot && year >= 2035 ? 0.05 : 0), 0, 0.3);
  const heat = !!heatEv || (year > 2026 && yearRoll('heat') < heatP);
  const surge = year >= 2035 && seaRisk >= 1 && yearRoll('surge') < 0.025 * seaRisk;

  const consc = conscriptionFor(lp, iso, year, sex);
  const eduRank = Math.max(0, EDU_ORDER.indexOf(edu));
  const famRich = fam >= 0.75;
  const famPoor = fam < 0.3;
  const poorC = inc === 'LIC' || inc === 'LMC';
  const smart = (year >= 2010 && internet >= 25) || (year >= 2014 && internet >= 12);
  const st = (k, d = 50) => num(stats[k], d);

  // When the life's own milestones happened. partner.sinceYear is the year a couple met; pickPersonalEvents notes the
  // year a union began, the wedding and widowhood in flags rel:* (trackUnion). Without them (a life built by hand or
  // an older save) the union is dated from the year the couple met or the first union, whichever is later.
  const couple = (relS === 'married' || relS === 'partnered') && !!partner;
  const tracked = couple && flags['rel:with'] === partner.name;
  const metYear = Math.min(year, Math.max(num(partner && partner.sinceYear, year), num(flags.firstUnion, -9999)));
  const unionStart = !couple ? null : tracked && num(flags['rel:union']) != null ? num(flags['rel:union']) : metYear;
  const wedStart = relS !== 'married' || !couple ? null : tracked && num(flags['rel:wed']) != null ? num(flags['rel:wed']) : unionStart;
  const retiredYear = num(flags.retiredYear);
  // Farming: a farm job, or a rural adult with no other work whom life made a farmer (flags.farmer, set by the
  // farming choice) or the homemaker of a poor farming household. Children of poor rural households help on the
  // family farm (farmKid); students and people with other jobs are not farmers.
  const title = String(career.title || '');
  const farmJob = /农|牧|渔/.test(`${career.sector || ''}${title}`) && !/技师|维修|工程师|技术员|研究|教师|兽医|经理|销售/.test(title);
  const otherJob = ['employed', 'self_employed', 'military'].includes(status) && !!title && !farmJob;
  const farmHome = !urban && (poorC || fam < 0.35);
  const farmer = age >= 15 && !inSchool && !['retired', 'student', 'child'].includes(status)
    && (farmJob || (!urban && !otherJob && (flags.farmer === true || (status === 'homemaker' && farmHome && poorC))));
  const farmKid = age >= 5 && age <= 17 && !farmer && !otherJob && (farmHome || flags.farmer === true);

  const f = {
    data, world, state, ctx, lp,
    iso, year, y: year, age, a: age, sex, m: sex === 'male', fe: sex === 'female',
    in: (lo, hi) => age >= lo && age <= hi,
    stage: age <= 2 ? 'infant' : age <= 11 ? 'child' : age <= 17 ? 'teen' : age <= 25 ? 'youth' : age <= 39 ? 'adult' : age <= 59 ? 'midlife' : age <= 79 ? 'senior' : 'elder',
    u: urban, r: !urban, ruralOrigin: birth.urban === false, cityBorn: birth.urban === true,
    inc, lic: inc === 'LIC', lmc: inc === 'LMC', umc: inc === 'UMC', hic: inc === 'HIC', poorC, richC: inc === 'HIC',
    fam, famPoor, famRich, famMid: !famPoor && !famRich,
    reg: region, eas: region === 'EAS', sea: region === 'SEA', sas: region === 'SAS', cas: region === 'CAS', was: region === 'WAS',
    naf: region === 'NAF', ssa: region === 'SSA', eeu: region === 'EEU', weu: region === 'WEU', nam: region === 'NAM',
    lac: region === 'LAC', oce: region === 'OCE', west: region === 'WEU' || region === 'NAM' || region === 'OCE',
    mena: region === 'WAS' || region === 'NAF',
    chn: iso === 'CHN', sinic: SINIC.has(iso), examCulture: EXAM_CULTURE.has(iso), muslim: MUSLIM.has(iso), buddhist: BUDDHIST.has(iso),
    monsoon: MONSOON.has(iso), typhoon: TYPHOON.has(iso), hurricane: HURRICANE.has(iso), cyclone: CYCLONE.has(iso),
    quakeZone: QUAKE.has(iso), remitC: REMIT.has(iso), gulf: GULF.has(iso), english: ENGLISH.has(iso), snow: SNOW.has(iso),
    dusty: DUST.has(iso), smoggy: SMOG.has(iso), fireZone: WILDFIRE.has(iso), locustZone: LOCUST.has(iso),
    nordicLeave: NORDIC_LEAVE.has(iso), euro: EUROZONE.has(iso),
    christmas: CHRISTMAS.has(iso) || ['WEU', 'NAM', 'LAC', 'OCE'].includes(region),
    edu, eduRank, inSchool, field: (p.education && p.education.field) || null,
    uni: inSchool && (eduRank >= 5 || age >= 19),
    school: inSchool && age < 19 && eduRank < 5,
    status, working: ['employed', 'self_employed', 'military'].includes(status), employed: status === 'employed',
    selfEmp: status === 'self_employed', unemployed: status === 'unemployed', retired: status === 'retired',
    homemaker: status === 'homemaker', military: status === 'military', student: status === 'student',
    sector: String(career.sector || ''), title, incomePct: clampN(num(career.incomePct, fam), 0, 1),
    careerYears: num(career.years, 0),
    // years in the current job (career.since is set by the engine when a job starts)
    jobYears: num(career.since) != null ? year - num(career.since) : num(career.years, 0),
    retiredYear, retiredFrom: typeof flags.retiredFrom === 'string' ? flags.retiredFrom : null,
    retiredYears: status === 'retired' && retiredYear != null ? year - retiredYear : null,
    schoolStart: schoolStartAge(lp, year),
    rel: relS, single: relS === 'single' || relS === 'divorced' || relS === 'widowed', neverMarried: relS === 'single',
    dating: relS === 'dating', married: relS === 'married', partnered: relS === 'partnered',
    couple: relS === 'married' || relS === 'partnered', hasPartner: ['dating', 'married', 'partnered'].includes(relS) && !!partner,
    divorced: relS === 'divorced', widowed: relS === 'widowed',
    partnerName: (partner && partner.name) || null, partnerSince: num(partner && partner.sinceYear, year),
    unionYears: unionStart == null ? 0 : year - unionStart, wedYears: wedStart == null ? 0 : year - wedStart,
    widowYears: relS === 'widowed' ? year - Math.min(year, num(flags['rel:widow'], year)) : null,
    kids, nKids: kids.length, hasKids: kids.length > 0,
    nKidsEver: (Array.isArray(p.children) ? p.children : []).filter((k) => k && num(k.birthYear, year) <= year).length,
    kidBaby: kids.some((k) => k.age <= 2), kidSmall: kids.some((k) => k.age >= 3 && k.age <= 5),
    kidSchool: kids.some((k) => k.age >= 6 && k.age <= 17), kidTeen: kids.some((k) => k.age >= 12 && k.age <= 17),
    kidAdult: kids.some((k) => k.age >= 18), newborn: kids.some((k) => k.age === 0),
    kidsAllAdult: kids.length > 0 && kids.every((k) => k.age >= 18),
    momAlive, dadAlive, parentAlive: momAlive || dadAlive, orphan: !momAlive && !dadAlive,
    parentOld: (momAlive || dadAlive) && parentAgeMax >= 68, parentAgeMax,
    sibs: Math.max(0, Math.round(num(p.siblings, birth.siblings, 0))), hasSib: num(p.siblings, birth.siblings, 0) > 0,
    cash: num(money.cash, 0), debt: num(money.debt, 0), income, portfolio, assets: num(money.cash, 0) + portfolio - num(money.debt, 0),
    famIncome, monthRef: Math.max(25, (income > 0 ? income : famIncome) / 12),
    health: st('health', 70), happy: st('happiness', 60), know: st('knowledge', 40), relSt: st('relationships', 55), wealth: st('wealth', 40),
    conds, hasCond: (id) => conds.some((x) => x.id === id), condSince: (id) => num((conds.find((x) => x.id === id) || {}).sinceYear, year),
    sick: conds.some((x) => num(x.severity, 1) >= 2),
    flags, smoker: flags.smoker === true, migrant: !!flags.migrant && flags.migrant !== 'false',
    displaced: !!flags.displaced, veteran: !!flags.veteran, leftBehind: flags.leftBehind === true,
    homeowner: !!flags.homeowner, track: flags.track || null, business: !!flags.business,
    origin: flags.origin || birth.country || iso,
    internet, mobile, gdp, gdpGrowth, cons,
    unemp: num(ctx.unemployment, ser('unemployment')), youthUnemp: num(ctx.youthUnemp, ser('youth_unemp')),
    inflation, smokeRate: num(ser('smoking'), 20), homicide: num(ser('homicide'), 4), road: num(ser('road_deaths'), 15),
    water: num(ser('water'), 90), elec: num(ser('electricity'), 95), femaleLfp: num(ser('female_lfp'), 50),
    adolFert: num(ser('adol_fert'), 40), maternal: num(ser('maternal_mort'), 100), physicians: num(ser('physicians'), 1.5),
    secEnroll: num(ctx.secEnroll, ser('sec_enroll'), 70), terEnroll: num(ctx.terEnroll, ser('ter_enroll'), 30),
    tfr: num(ctx.tfr, ser('tfr')), lifeExp: num(ctx.lifeExp, ser('le')),
    phone: year >= 2004 || mobile >= 30,
    smart, social: year >= 2007 && internet >= 30, shortVideo: year >= 2017 && internet >= 40,
    mobilePay: (iso === 'CHN' && year >= 2014) || (['KEN', 'TZA', 'UGA'].includes(iso) && year >= 2009) || (iso === 'IND' && year >= 2017) || (year >= 2016 && internet >= 75) || (year >= 2022 && internet >= 50),
    ecommerce: year >= 2005 && internet >= 40, videoCall: year >= 2010 && internet >= 40,
    genAI: year >= 2023 && internet >= 35,
    ev: year >= 2020 && (inc === 'HIC' || iso === 'CHN'),
    aiL, climL, healthL, geoL, spaceL, proj: year > 2026,
    aiTutor: year >= 2027 + aiDelay / 2 && internet >= 50,
    robots: year >= 2034 + aiDelay && (inc === 'HIC' || (inc === 'UMC' && urban)),
    aiDoctor: year >= 2030 + aiDelay && internet >= 50,
    selfDriving: year >= 2030 + aiDelay && (inc === 'HIC' || (iso === 'CHN' && urban)),
    bci: aiL === 'high' && year >= 2045 && inc === 'HIC',
    longevity: year >= 2040 + healthDelay && (inc === 'HIC' || famRich),
    ubi: (ubiBranch && year >= 2033) || (aiL === 'high' && year >= 2045 && inc === 'HIC'),
    vr: year >= 2033 && internet >= 70,
    spaceTour: year >= (spaceL === 'high' ? 2040 : 2050) && inc === 'HIC',
    mars: year >= (spaceL === 'high' ? 2048 : spaceL === 'mid' ? 2062 : 2080),
    climateBad: climL === 'high', climateGood: climL === 'low',
    events: evs, findEv, conflict,
    war: warLocal, warNation, warZone: !!zoneEv, warNear, warAny, warFar: !warLocal && !warNear && armed.some((e) => !listedIn(e)),
    // this country fights a regional war somewhere else than where this life is lived
    warElsewhere: !warLocal && ownWars.length > 0,
    warMild: !warLocal && !warNear && armed.some((e) => listedIn(e) && !severe(e)), pandemic, lockdown, covid, outbreaks, epidemic: outbreaks.length > 0 && !pandemic,
    finCrisis, recession: gdpGrowth <= -1.5 || finCrisis,
    quake: !!quake, flood: !!flood, storm: !!storm, drought: !!drought, heat, fire: !!fireEv,
    automation, refugees, disaster: !!(quake || flood || storm || drought || fireEv),
    hiInfl: isNum(inflation) && inflation >= 12, hyperInfl: isNum(inflation) && inflation >= 40,
    heatRisk, seaRisk: year >= 2035 && seaRisk >= 1, surge,
    consc,
    farmer, farmKid,
  };
  f.worldActive = f.war || f.pandemic || f.finCrisis || f.disaster || f.heat || f.automation;
  return f;
}

/** Conscription status from the life path (falls back to a small built-in table). */
const CONSCRIPTION_FALLBACK = {
  KOR: { sex: 'male', months: 18 }, ISR: { sex: 'all', months: 30 }, TWN: { sex: 'male', months: 12 }, SGP: { sex: 'male', months: 24 },
  RUS: { sex: 'male', months: 12 }, UKR: { sex: 'male', months: 18 }, TUR: { sex: 'male', months: 6 }, IRN: { sex: 'male', months: 21 },
  EGY: { sex: 'male', months: 18 }, CHE: { sex: 'male', months: 6 }, AUT: { sex: 'male', months: 6 }, FIN: { sex: 'male', months: 9 },
  GRC: { sex: 'male', months: 12 }, CYP: { sex: 'male', months: 14 }, THA: { sex: 'male', months: 12 }, VNM: { sex: 'male', months: 24 },
  PRK: { sex: 'all', months: 96 }, ERI: { sex: 'all', months: 18 }, CUB: { sex: 'male', months: 24 }, DZA: { sex: 'male', months: 12 },
  NOR: { sex: 'all', months: 12, since: 2015 }, SWE: { sex: 'all', months: 11, since: 2018 }, DNK: { sex: 'male', months: 4 },
  EST: { sex: 'male', months: 11 }, LTU: { sex: 'male', months: 9, since: 2015 }, LVA: { sex: 'male', months: 11, since: 2023 },
  DEU: { sex: 'male', months: 9, until: 2010 }, POL: { sex: 'male', months: 9, until: 2008 }, ITA: { sex: 'male', months: 10, until: 2004 },
  BRA: { sex: 'male', months: 12 }, MEX: { sex: 'male', months: 12 }, BLR: { sex: 'male', months: 18 }, KAZ: { sex: 'male', months: 12 },
  UZB: { sex: 'male', months: 12 }, GEO: { sex: 'male', months: 12 }, ARM: { sex: 'male', months: 24 }, AZE: { sex: 'male', months: 18 },
  SYR: { sex: 'male', months: 24 }, QAT: { sex: 'male', months: 12, since: 2014 }, ARE: { sex: 'male', months: 12, since: 2014 },
  KWT: { sex: 'male', months: 12, since: 2017 }, MAR: { sex: 'male', months: 12, since: 2019 }, MMR: { sex: 'male', months: 24, since: 2024 },
};
export function conscriptionFor(lp, iso, year, sex) {
  let c = lp && lp.conscription && typeof lp.conscription === 'object' ? lp.conscription : null;
  if (!c || (!c.exists && !(lp && lp.researched))) {
    const fb = CONSCRIPTION_FALLBACK[iso];
    c = fb ? { exists: true, sex: fb.sex, months: fb.months, since: fb.since || null, until: fb.until || null } : c;
  }
  if (!c || !c.exists) return null;
  const sx = String(c.sex || 'male');
  if (!(sx === 'all' || sx === sex || (sx === 'male' && sex === 'male'))) return null;
  const since = num(c.since);
  const until = num(c.until);
  if (since != null && year < since) return null;
  if (until != null && year > until) return null;
  let months = num(c.months, 12);
  if (Array.isArray(c.history)) for (const h of c.history) if (h && num(h.from, 9999) <= year && isNum(num(h.months))) months = num(h.months);
  return { months: Math.max(1, Math.round(months)), sex: sx, note: c.note || '' };
}

/** Age at which primary school starts (life path, with its history of reforms), as the engine reads it. */
function schoolStartAge(lp, year) {
  let a = num(lp && lp.school_start_age, 6);
  const hist = lp && Array.isArray(lp.school_start_age_history) ? lp.school_start_age_history : [];
  for (const h of hist) if (h && typeof h === 'object' && num(h.from, 9999) <= year && isNum(h.value)) a = h.value;
  return clampN(Math.round(a), 4, 8);
}

/* ------------------------------------------------------------------ text variables */

function fmtNum(x, d = 1) {
  if (!isNum(x)) return null;
  const v = Math.round(x * Math.pow(10, d)) / Math.pow(10, d);
  return String(v);
}

/** Key exam names by age for a country (life path first, then a small built-in table). */
const EXAM_FALLBACK_RAW = {
  CHN: [[15, '中考'], [18, '高考']], KOR: [[18, '大学修学能力考试']], JPN: [[15, '高中入学考试'], [18, '大学入学共通考试']],
  TWN: [[15, '会考'], [18, '学测']], VNM: [[15, '高中入学考试'], [18, '高中毕业考试']], IND: [[16, '十年级会考'], [18, '十二年级会考']],
  USA: [[17, 'SAT 考试']], GBR: [[16, 'GCSE 考试'], [18, 'A-Level 考试']], FRA: [[18, '高中会考']], DEU: [[18, '高中毕业考试']],
  TUR: [[18, '大学入学考试']], IRN: [[18, '大学入学考试']], BRA: [[18, '全国高中考试']], NGA: [[17, '西非高中毕业考试']],
  KEN: [[14, '小学毕业考试'], [18, '中学毕业考试']], GHA: [[17, '西非高中毕业考试']], EGY: [[18, '高中毕业考试']],
};
const EXAM_GENERIC = [[15, '初中毕业考试'], [18, '中学毕业考试']];
/** [{age, name, from, until}] from the life path (names without parentheses), or the built-in table */
function examList(lp, iso) {
  const raw = lp && Array.isArray(lp.key_exams) ? lp.key_exams : [];
  const clean = (s) => String(s).replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  const out = raw.map((e) => ({ age: num(e && e.age), name: e && typeof e.name === 'string' && clean(e.name) ? clean(e.name) : null, from: num(e && e.from), until: num(e && e.until) }))
    .filter((e) => e.age != null && e.name);
  if (out.length) return out;
  return (EXAM_FALLBACK_RAW[iso] || EXAM_GENERIC).map(([age, name]) => ({ age, name, from: null, until: null }));
}
const examOpenIn = (e, year) => year == null || ((e.from == null || e.from <= year) && (e.until == null || e.until >= year));
/**
 * [[age, name]] key exams of a country. With `year`, only the exams that existed that year (JPN's 大学入试中心考试
 * became 大学入学共通测试 in 2021, Taiwan's 基测 became 会考 in 2014 ...). Without it, the whole list (old callers).
 */
export function keyExams(lp, iso, year) {
  const all = examList(lp, iso);
  const y = num(year);
  const list = y == null ? all : all.filter((e) => examOpenIn(e, y));
  const out = (list.length ? list : all).map((e) => [e.age, e.name]);
  return out.length ? out : EXAM_GENERIC.map((e) => e.slice());
}
/** the exam a person of `age` in `year` is heading for (or has just taken), valid in the year it is sat */
function examAhead(lp, iso, age, year) {
  const all = examList(lp, iso);
  const at = (e) => year + Math.max(0, e.age - age);
  const next = all.find((e) => e.age >= age - 1 && examOpenIn(e, at(e))) || all.filter((e) => examOpenIn(e, year)).pop() || all[all.length - 1];
  return next ? next.name : '升学考试';
}
function examFor(f) {
  return examAhead(f.lp, f.iso, f.age, f.year);
}

function cityOf(f) {
  if (f.flags.city && typeof f.flags.city === 'string') return f.flags.city;
  const list = CITIES[f.iso];
  if (!f.u) return f.chn ? '县城' : '镇上';
  if (list && list.length) return stableFront(`${f.state.id || f.state.seed || ''}|${f.iso}|city`, list);
  return '城里';
}
function bigCityOf(f) {
  const list = CITIES[f.iso];
  if (list && list.length) return list[stableIndex(`${f.state.id || f.state.seed || ''}|${f.iso}|big`, Math.min(3, list.length))];
  return '首都';
}
function countryName(data, iso, fb) {
  return safe(() => data.country(iso).name) || safe(() => data.countries[iso].name) || fb;
}

/** Build the variable map for fillText. f may be null (then it is derived from state/ctx only). */
function textVars(state, ctx, f, rng) {
  const s = state || {};
  const p = s.person || {};
  const c = ctx || {};
  const iso = p.country || c.iso3 || (s.birth && s.birth.country) || '';
  const region = c.region || (f && f.reg) || '';
  const key = String(s.id || s.seed || p.name || 'life');
  const birthIso = (s.birth && s.birth.country) || iso;
  const kids = (Array.isArray(p.children) ? p.children : []).filter((k) => k && k.alive !== false && k.name);
  const sibs = num(p.siblings, s.birth && s.birth.siblings, 0);
  const pick = (arr) => (rng && typeof rng.pick === 'function' ? rng.pick(arr) : arr[stableIndex(key + arr.length, arr.length)]);
  const festOf = (i, reg) => FESTIVALS[i] || (MUSLIM.has(i) ? ['开斋节', '宰牲节'] : ['WEU', 'NAM', 'LAC', 'OCE'].includes(reg) || CHRISTMAS.has(i) ? ['圣诞节', '新年'] : ['新年']);
  const fest = festOf(iso, region);
  const birthRegion = (birthIso !== iso && safe(() => (f && f.data ? f.data.country(birthIso).region : null))) || region;
  const foodList = HOMEFOOD[birthIso] || REGION_FOOD[safe(() => (f && f.data ? f.data.country(birthIso).region : null)) || region] || REGION_FOOD[region] || ['家常菜'];
  const v = {
    name: p.name || '你',
    partner: (p.relationship && p.relationship.partner && p.relationship.partner.name) || '伴侣',
    child: kids.length ? kids[kids.length - 1].name : '孩子',
    sibling: sibs > 0 ? KIN_ANY[stableIndex(key + '|sib', 4)] : '表亲',
    oldsib: sibs > 0 ? KIN_OLD[stableIndex(key + '|osib', 2)] : '表哥',
    country: c.country || (f && countryName(f.data, iso, null)) || '这个国家',
    city: f ? cityOf(f) : (p.flags && typeof p.flags.city === 'string' ? p.flags.city : p.urban ? (CITIES[iso] ? CITIES[iso][0] : '城里') : iso === 'CHN' ? '县城' : '镇上'),
    bigcity: f ? bigCityOf(f) : (CITIES[iso] ? CITIES[iso][0] : '首都'),
    year: num(s.year, c.year),
    age: num(s.age, 0),
    birthyear: num(s.birth && s.birth.year, s.year),
    festival: pick(fest),
    // the festival of the place a migrant comes from (homesickness is for one's own holidays)
    homefest: pick(festOf(birthIso, birthRegion)),
    homefood: pick(foodList),
    crop: pick(REGION_CROPS[region] || ['庄稼']),
    sport: SPORTS[iso] || '足球',
    lang: ENGLISH.has(iso) ? (stableIndex(key + 'lang', 2) ? '西班牙语' : '中文') : region === 'LAC' || SINIC.has(iso) || region !== 'NAM' ? '英语' : '英语',
    storm: TYPHOON.has(iso) ? '台风' : HURRICANE.has(iso) ? '飓风' : CYCLONE.has(iso) ? '热带气旋' : '暴风雨',
    exam: f ? examFor(f) : '升学考试',
    origin: f ? countryName(f.data, f.origin, '家乡') : '家乡',
    // the grandparents who appear in the story come from one side of the family, so 奶奶 goes with 爷爷
    granny: SINIC.has(iso) ? (stableIndex(key + 'gran', 2) ? '奶奶' : '外婆') : (stableIndex(key + 'gran', 2) ? '祖母' : '外祖母'),
    grandpa: SINIC.has(iso) ? (stableIndex(key + 'gran', 2) ? '爷爷' : '外公') : (stableIndex(key + 'gran', 2) ? '祖父' : '外祖父'),
    inflation: fmtNum(f ? f.inflation : null, 0),
    youthUnemp: fmtNum(f ? f.youthUnemp : num(c.youthUnemp), 1),
    unemp: fmtNum(f ? f.unemp : num(c.unemployment), 1),
    internet: fmtNum(f ? f.internet : num(c.internet), 0),
    tfr: fmtNum(f ? f.tfr : num(c.tfr), 2),
    newpartner: 'TA',
    event: '那件大事',
  };
  return v;
}
const VAR_FALLBACK = {
  name: '你', partner: '伴侣', child: '孩子', sibling: '兄弟姐妹', oldsib: '哥哥', country: '这个国家', city: '城里',
  bigcity: '首都', year: '那一年', age: '', birthyear: '', festival: '新年', homefood: '家常菜', crop: '庄稼', sport: '足球',
  lang: '英语', storm: '暴风雨', exam: '升学考试', origin: '家乡', homefest: '家乡的节日', granny: '祖母', grandpa: '祖父', inflation: '很高',
  youthUnemp: '不低', unemp: '不低', internet: '', tfr: '', newpartner: 'TA', event: '那件大事', dest: '国外',
};

/**
 * Fill {variables} in a template string. extra (optional) overrides any variable; f (optional) is a lifeFacts object.
 * Unknown variables resolve to a neutral fallback so no braces ever reach the player.
 */
export function fillText(template, state, ctx, rng, extra, f) {
  if (template == null) return '';
  const tpl = String(template);
  if (tpl.indexOf('{') < 0) return tpl;
  const vars = textVars(state, ctx, f || null, rng);
  if (extra && typeof extra === 'object') for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') vars[k] = v;
  return tpl.replace(/\{(\w+)\}/g, (m, k) => {
    let v = vars[k];
    if (v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) v = VAR_FALLBACK[k];
    if (v == null) v = '';
    const sv = String(v);
    return sv === 'undefined' || sv === 'NaN' || sv === 'null' ? (VAR_FALLBACK[k] || '') : sv;
  });
}

/* ------------------------------------------------------------------ template DSL */

const RAW = [];
/**
 * E(id, cond(f) -> boolean|weight, text: string|string[]|fn(f)->string|string[], tone -2..2, tags 'tag more',
 *   fx [health, happiness, knowledge, relationships, wealthMonths], opt {once, cd, w, set, hz, g, world, prep, ev})
 */
function E(id, cond, text, tone, tags, fx, opt) { RAW.push({ id, cond, text, tone, tags, fx, opt: opt || {} }); }

/** prep helper: name a matching child as {child} */
const kidP = (filter) => (f, rng) => {
  const ks = f.kids.filter(filter);
  return ks.length ? { child: (rng ? rng.pick(ks) : ks[0]).name } : {};
};
/** the given name of a full name ("名·姓" transliterations put the given name first) */
const givenOf = (n) => String(n || '').split('·')[0].trim();
/**
 * A name for someone new in a life's love story (f = lifeFacts): never the name, or the given name, of a former
 * partner (person.pastPartners, kept by the engine), the current partner, the person or a child. null when every
 * draw clashes.
 */
export function newPartnerName(f, rng) {
  const p = (f && f.state && f.state.person) || {};
  const taken = [p.name, f.partnerName, ...(Array.isArray(p.pastPartners) ? p.pastPartners : []), ...(Array.isArray(p.children) ? p.children.map((k) => k && k.name) : [])]
    .filter((x) => typeof x === 'string' && x.trim());
  const clash = (n) => taken.some((x) => x === n || givenOf(x) === givenOf(n));
  const sex = f.m ? 'female' : 'male';
  let name = personName(f.data, f.iso, sex, rng);
  for (let i = 0; i < 12 && clash(name); i++) name = personName(f.data, f.iso, sex, rng);
  return clash(name) ? null : name;
}
/** prep helper: a new partner's name as {newpartner} (the template is skipped when no fresh name is found) */
const partnerP = (f, rng) => {
  const name = newPartnerName(f, rng);
  return name ? { newpartner: name } : {};
};
const dateSet = (f, v) => ({ relationship: { status: 'dating', partner: { name: v.newpartner || 'TA', sinceYear: f.year } } });
const ev = (re) => (e) => re.test(evText(e));
const PCT = (f, d) => clampN(Math.round((f.incomePct + d) * 1000) / 1000, 0.02, 0.98);
/** prep helper: a child of exam age as {child} and that exam's name as {exam} */
const kidExamP = (f, rng) => {
  const ks = f.kids.filter((k) => k.age >= 14 && k.age <= 18);
  if (!ks.length) return {};
  const k = rng ? rng.pick(ks) : ks[0];
  const ex = keyExams(f.lp, f.iso, f.year);
  const hit = ex.find((e) => Math.abs(e[0] - k.age) <= 1 && !/硕士|研究生|公务员|资格/.test(e[1])) || ex.find((e) => e[0] >= k.age) || ex[ex.length - 1];
  return { child: k.name, exam: hit ? hit[1] : '升学考试' };
};
/** a world event is quoted at most once per life; repeated shocks share a title, so the title is the key */
const hookKey = (e) => String(e.title || e.id || '').slice(0, 60);
/** first active world event matching re (and categories) that this life has not yet "quoted" in a story */
const freshEv = (f, re, cats) => f.events.find((e) => e && e.title && (!cats || cats.includes(e.category)) && re.test(`${e.id || ''} ${e.refId || ''} ${e.title}`) && !f.flags[`hook:${hookKey(e)}`]) || null;
/** prep helper: an armed event that lists this country (listed=true) or does not (listed=false), as {event}/{hookid} */
const armedP = (listed) => (f) => {
  const e = f.events.find((x) => x && x.title && isArmed(x) && (Array.isArray(x.countries) && x.countries.includes(f.iso)) === listed && !f.flags[`hook:${hookKey(x)}`]);
  return e ? { event: plainTitle(e.title), hookid: hookKey(e) } : {};
};
/** prep helper: title of that event as {event} (quotes stripped; templates wrap it in 「」) and its id as {hookid} */
const evP = (re, cats) => (f) => {
  const e = freshEv(f, re, cats);
  return e ? { event: plainTitle(e.title), hookid: hookKey(e) } : {};
};
const who = (f) => (f.momAlive && f.dadAlive ? (stableIndex(`${f.state.id || ''}|par|${f.year}`, 2) ? '母亲' : '父亲') : f.momAlive ? '母亲' : '父亲');
const unwedKid = (f) => (k) => k.age >= 24 && k.age <= 38 && !f.flags[`kidwed:${k.name}`];
/** strip trailing punctuation from a research hook so it can be embedded in a sentence */
const hookLine = (s) => String(s || '').trim().replace(/[。．.!！；;，,]+$/u, '');
const HOOK_TAG = { war: 'war', conflict: 'war', disaster: 'crisis', epidemic: 'crisis', economy: 'crisis', technology: 'calm', science: 'calm', sport: 'calm', culture: 'calm', politics: 'calm', policy: 'calm', society: 'calm', climate: 'crisis', environment: 'crisis' };
/** prep helper: a personal hook from an active history/future event ({hookline} is a complete sentence) */
/** world events whose hooks may be told from this person's point of view (once per event per life) */
function hookEvents(f, projection) {
  return f.events.filter((e) => e && e.title && !!e.projection === projection
    && Array.isArray(e.personal_hooks) && e.personal_hooks.some((h) => typeof h === 'string' && h.trim())
    // hooks are written for the people most affected: the listed countries, or everyone for big global events
    && ((Array.isArray(e.countries) && e.countries.includes(f.iso) && num(e.importance, 3) >= 2) || (e.scope === 'global' && num(e.importance, 3) >= 4) || (e.scope === 'regions' && num(e.importance, 3) >= 4))
    && !f.flags[`hook:${hookKey(e)}`]);
}
/** event title safe to wrap in 「」 (inner “” become 『』) */
const plainTitle = (t) => String(t || '').trim().replace(/^「(.*)」$/u, '$1').replace(/[“"]/g, '『').replace(/[”]/g, '』');
const titleOf = (e) => `「${plainTitle(e.title)}」`;
/** prep helper: a personal hook from an active history/future event ({hookline} is a complete sentence) */
const hookP = (projection) => (f, rng) => {
  const evs = hookEvents(f, projection);
  if (!evs.length) return {};
  const e = rng ? rng.weighted(evs, (x) => num(x.importance, 2)) || evs[0] : evs[0];
  const hooks = e.personal_hooks.filter((h) => typeof h === 'string' && h.trim());
  const hook = hookLine(rng ? rng.pick(hooks) : hooks[0]);
  const title = titleOf(e);
  const v = rng ? rng.int(0, 2) : 0;
  const line = projection
    ? [`在这条世界线上，${title}成了这一年的大事。推演中，${hook}。`, `${title}——这是世界线推演里的这一年。${hook}，你也在其中。`, `这一年的推演新闻里反复出现${title}。${hook}。`][v]
    : [`这一年，${title}。${hook}。`, `${title}的消息传来。${hook}——这些变化，你也看在眼里。`, `${f.year}年，${title}。${hook}。后来回想那一年，你总会先想起这件事。`][v];
  const eco = num(e.effects && e.effects.economy, 0) + num(e.effects && e.effects.happiness, 0) + num(e.effects && e.effects.safety, 0);
  return { hookline: line, hookid: hookKey(e), _tag: HOOK_TAG[e.category] || 'calm', _tone: eco <= -3 ? -1 : eco >= 2 ? 1 : 0, _sign: eco < 0 ? -1 : eco > 0 ? 1 : 0 };
};
const hookSet = (f, v) => (v && v.hookid ? { flags: { [`hook:${v.hookid}`]: f.year } } : undefined);
/** first active local outbreak (isOutbreak, not COVID) this life has not yet quoted; prep helper as {event}/{hookid} */
const freshOutbreak = (f) => (f.outbreaks || []).find((e) => e && e.title && !f.flags[`hook:${hookKey(e)}`]) || null;
const outbreakP = (f) => {
  const e = freshOutbreak(f);
  return e ? { event: plainTitle(e.title), hookid: hookKey(e) } : {};
};

/* ================================================================== CONTENT ================================== */
/* Infancy 0-2 */

E('inf_first_word', (f) => f.in(1, 2), ['你一岁时说出了第一个词，家里人为它到底是“妈妈”还是“爸爸”争论了好几天。', '你含糊地叫出了第一声“妈妈”，母亲把这一刻讲了很多年。'], 1, 'childhood', [0, 2, 1, 2, 0], { once: true, w: 2 });
E('inf_first_steps', (f) => f.in(1, 2), '你扶着墙迈出了人生的第一步，又一屁股坐回地上。一家人都笑了。（这些事你当然不会记得，是后来听大人讲的。）', 1, 'childhood', [1, 2, 0, 1, 0], { once: true, w: 2 });
E('inf_vaccine', (f) => f.in(0, 1) && !(f.lic && f.r && f.physicians < 0.3), '护士给你打了疫苗，你哭了一小会儿，母亲把日期仔细记在了接种本上。', 0, 'childhood', [2, 0, 0, 0, 0], { once: true });
E('inf_vaccine_missed', (f) => f.in(0, 2) && f.poorC && f.r && f.physicians < 0.5 && 1.5, '离最近的诊所要走大半天的路，那年你错过了一次疫苗接种。', -1, 'childhood', [-2, 0, 0, 0, 0], { once: true, hz: { mult: 1.1, years: 3, reason: '错过疫苗接种' } });
E('inf_fever', (f) => f.in(0, 2), (f) => (f.r && f.poorC ? `你半夜发起高烧，${f.dadAlive ? '父亲' : '家里人'}抱着你走夜路去${f.chn ? '乡里' : '附近'}的诊所。烧退了，大人们却一夜没合眼。` : `你半夜发起高烧，${f.momAlive && f.dadAlive ? '父母' : '家里人'}抱着你冲进医院急诊。烧退了，他们却一夜没合眼。`), -1, 'illness', [-2, -1, 0, 1, -0.3], { cd: 2 });
E('inf_diarrhea', (f) => f.in(0, 3) && f.water < 80 && (f.water < 60 ? 2.5 : 1), '因为饮用水不干净，你得了一场严重的腹泻，母亲用口服补液盐一勺一勺地喂你。', -1, 'illness', [-5, -1, 0, 1, -0.2], { cd: 2, hz: { mult: 1.3, years: 1, reason: '腹泻' } });
E('inf_malaria', (f) => f.in(0, 4) && f.ssa && f.poorC && 1.5, '雨季来临，你染上了疟疾，高烧了好几天。幸好诊所还有药，你挺了过来。', -2, 'illness', [-6, -1, 0, 1, -0.3], { cd: 3, hz: { mult: 1.3, years: 1, reason: '疟疾' } });
E('inf_bednet', (f) => f.in(0, 3) && (f.ssa || (f.sas && f.r)) && f.poorC, '家里领到了一顶浸药蚊帐，母亲每晚都仔细地把它掖好。', 0, 'childhood', [2, 0, 0, 0, 0], { once: true });
E('inf_malnutrition', (f) => f.in(0, 3) && f.lic && f.famPoor && 1.5, '那一年收成不好，家里的口粮紧张，你比同龄的孩子瘦小一些。', -1, 'crisis', [-4, -1, -1, 0, 0], { once: true, hz: { mult: 1.15, years: 3, reason: '营养不良' } });
E('inf_grandma', (f) => f.in(0, 3), '父母白天忙着生计，你大部分时间是{granny}抱大的。她哼的那首童谣，你后来还能唱出几句。', 1, 'family', [0, 2, 0, 3, 0], { once: true });
E('inf_daycare', (f) => f.in(1, 3) && (f.hic || (f.umc && f.u)), '你被送进了托儿所，第一天哭得撕心裂肺，第三天已经会和别的小朋友抢玩具了。', 0, 'childhood', [0, 1, 1, 2, -0.5], { once: true });
E('inf_mom_work', (f) => f.in(0, 1) && f.femaleLfp >= 40 && f.momAlive, '母亲的产假结束了，她回去上班。你开始习惯每天傍晚在门口等她回来。', 0, 'family', [0, -1, 0, 1, 0.5], { once: true });
E('inf_left_behind_cn', (f) => f.in(1, 4) && f.chn && f.r && f.year <= 2020 && f.fam < 0.55 && !f.leftBehind && 2, '父母去{bigcity}打工了，你留在村里跟着{granny}和{grandpa}。电话那头的声音，成了你对父母最早的印象。', -1, 'family', [0, -3, 0, -1, 1], { once: true, set: { flags: { leftBehind: true } } });
E('inf_parent_abroad', (f) => f.in(1, 5) && f.remitC && f.r && f.fam < 0.5 && !f.chn && !f.leftBehind && !f.flags.parentAway && f.dadAlive, '父亲先去外地、后来又去了海外打工，每隔几个月寄一次钱回来。你对他的样子印象模糊，只记得电话里的声音。', -1, 'family', [0, -2, 0, -1, 1.5], { once: true, set: { flags: { parentAway: true } } });
E('inf_move_house', (f) => f.in(0, 4), '家里搬了一次家。在新房间的第一晚你怎么也睡不着，抱着旧枕头才安下心来。', 0, 'childhood', [0, -1, 0, 0, 0], { once: true, w: 0.6 });
E('inf_photo_digital', (f) => f.in(0, 2) && f.smart, '家人给你拍了成百上千张照片和视频，你的童年会比父母的童年留下多得多的影像。', 1, 'childhood', [0, 1, 0, 1, 0], { once: true });
E('inf_photo_studio', (f) => f.in(0, 2) && !f.smart, '父母带你去照相馆拍了一张周岁照，照片在相框里放了很多年。', 1, 'childhood', [0, 1, 0, 1, -0.1], { once: true });
E('inf_zhuazhou', (f) => f.age === 1 && f.sinic && 2, ['周岁那天家里给你“抓周”，你一把抓住了毛笔，全家人都说你将来要读书。', '周岁那天家里给你“抓周”，你抓起了算盘就不撒手，长辈们笑着说你将来会做生意。', '周岁那天家里给你“抓周”，你绕过所有东西，抓住了一个苹果啃了起来，大家笑成一团。'], 1, 'family', [0, 2, 0, 2, 0], { once: true });
E('inf_naming', (f) => f.age === 0 && (f.ssa || f.sas || f.mena) && 1.5, '家里为你办了取名仪式，亲戚和邻居都来了，每个人都给了你一句祝福。', 1, 'family', [0, 1, 0, 3, -0.2], { once: true });
E('inf_flood', (f) => f.in(0, 4) && f.monsoon && f.r && f.poorC && (f.flood ? 4 : 0.3), '季风带来的洪水漫进了村子，大人们把你抱到高处，全家在邻居家的阁楼上住了好几天。', -2, 'crisis', [-2, -2, 0, 1, -2], { cd: 4, world: true });
E('inf_cold_winter', (f) => f.in(0, 2) && (f.snow || f.cas || f.eeu), '那年冬天特别冷，家里把炉子边最暖和的位置留给了你。', 0, 'childhood', [0, 0, 0, 1, 0], { once: true });
E('inf_heat', (f) => f.in(0, 3) && f.heat && 2, '热浪持续了好几周，父母轮流给你扇风，后来社区开放了有空调的避暑点，母亲每天抱着你去那里待一下午。', -1, 'crisis', [-2, -1, 0, 1, -0.2], { cd: 2, world: true });
E('inf_oldsib', (f) => f.in(0, 3) && f.hasSib, '{oldsib}很喜欢逗你玩，常把自己的零食偷偷塞给你。', 1, 'family', [0, 2, 0, 3, 0], { once: true });
E('inf_sleepless', (f) => f.age === 0, '你是个难哄睡的婴儿，父母那一年几乎没睡过一个整觉。', 0, 'family', [0, 0, 0, 1, 0], { once: true, w: 0.7 });
E('inf_picture_book', (f) => f.in(1, 3) && (f.fam > 0.4 || f.hic), '母亲每晚给你读绘本，你最喜欢的那一本被翻得卷了边。', 1, 'childhood', [0, 2, 2, 2, 0], { once: true });
E('inf_cartoon', (f) => f.in(2, 4), '你迷上了电视里的动画片，片头曲能从头唱到尾。', 1, 'childhood', [0, 2, 0, 0, 0], { once: true, w: 0.7 });
E('inf_tablet', (f) => f.in(2, 4) && f.smart && f.year >= 2012, '你两岁就会用手指划屏幕找动画片看，大人们既惊讶又有点担心。', 0, 'childhood', [-1, 2, 0, 0, 0], { once: true });
E('inf_ai_monitor', (f) => f.in(0, 2) && f.year >= 2030 && (f.hic || (f.umc && f.u)), '家里的智能看护设备会在你踢被子时提醒父母，夜里还会放轻柔的白噪音哄你入睡。', 0, 'childhood', [1, 0, 0, 0, -0.2], { once: true });
E('inf_pandemic', (f) => f.in(0, 2) && f.pandemic, '你出生在疫情的年份，你最早见过的大人，很多都戴着口罩。', 0, 'childhood', [0, 0, 0, -1, 0], { once: true, world: true });
E('inf_war', (f) => f.in(0, 4) && f.war && 3, '远处的炮声让你在夜里惊醒，母亲把你抱在怀里，轻轻哼着歌等天亮。', -2, 'war', [-2, -3, 0, 1, -1], { cd: 2, world: true });
E('inf_quake', (f) => f.in(0, 4) && f.quake && 3, (f) => `地震那天，${f.dadAlive ? '父亲' : f.momAlive ? '母亲' : '家里人'}抱着你冲出了家门。房子受了损，全家在帐篷里住了一段时间。`, -2, 'crisis', [-2, -2, 0, 2, -2], { cd: 3, world: true });
E('inf_milk_2008', (f) => f.chn && f.year === 2008 && f.in(0, 3) && 3, '2008年奶粉安全事件曝光后，父母连夜检查了家里的奶粉罐，之后很长一段时间都只敢买托人带回来的奶粉。', -1, 'crisis', [0, -1, 0, 0, -0.3], { once: true });
E('inf_twin_cousins', (f) => f.in(1, 4) && (f.sas || f.ssa || f.mena || f.lac), '你在一个热闹的大家庭里长大，堂兄弟姐妹一大群，谁家做了好吃的，孩子们就一窝蜂地跑过去。', 1, 'family', [0, 3, 0, 3, 0], { once: true });
E('inf_crawl_fall', (f) => f.in(0, 2), '你爬到床边一头栽了下去，额头肿起一个包。母亲心疼了好几天，从此在床边铺上了软垫。', 0, 'childhood', [-1, -1, 0, 1, 0], { once: true, w: 0.6 });
E('inf_newyear_born', (f) => f.age === 0 && f.sinic, '你出生的那一年，家里的春联换上了新写的“添丁进口”。', 1, 'family', [0, 1, 0, 2, 0], { once: true, w: 0.6 });
E('inf_water_far', (f) => f.in(0, 3) && f.r && f.water < 65, '母亲每天背着你去很远的地方挑水，你在她背上摇摇晃晃地睡着。', 0, 'family', [0, 0, 0, 2, 0], { once: true });
E('inf_clinic_scale', (f) => f.in(0, 2) && f.poorC && f.year >= 2005, '社区卫生员定期来村里给婴儿称体重，你每次都被吊在秤上蹬腿大哭。', 0, 'childhood', [1, 0, 0, 0, 0], { once: true });

/* Childhood 3-11 */

// only before primary school starts and while the child has not been to any school yet (the engine then enrols them)
E('ch_kindergarten', (f) => f.in(3, 5) && f.age < f.schoolStart && f.edu === 'none' && !f.inSchool && (f.u || f.umc || f.hic), '你上幼儿园了。第一天你拉着门不肯松手，放学时却舍不得和新朋友分开。', 1, 'study', [0, 1, 2, 3, -0.3], { once: true, w: 1.5 });
E('ch_first_school', (f) => f.in(6, 7) && f.inSchool, (f) => (f.sinic ? '你背着新书包走进了小学教室。老师让你做自我介绍，你紧张得把自己的名字说错了一个字。' : '你背着新书包走进了小学教室。老师让你做自我介绍，你紧张得连自己的名字都说得磕磕巴巴。'), 1, 'study', [0, 1, 2, 2, 0], { once: true, w: 2 });
E('ch_walk_far', (f) => f.in(6, 11) && f.inSchool && f.r && f.poorC, '去学校要走一个多小时的土路，雨天鞋子总是湿的，但你很少缺课。', 0, 'study', [1, -1, 1, 0, 0], { once: true, w: 1.5 });
E('ch_no_school', (f) => f.in(7, 11) && !f.inSchool && f.poorC && 2, '村里的同龄孩子有的去上学了，你在家帮忙干活，偶尔趴在教室窗外听上一会儿。', -1, 'childhood', [0, -2, 0, 0, 0], { once: true });
E('ch_school_fees', (f) => f.in(6, 14) && f.inSchool && (f.lic || (f.ssa && f.poorC)) && f.famPoor && 1.5, (f) => `学费和校服钱又要交了，${f.momAlive ? '母亲' : f.dadAlive ? '父亲' : '{granny}'}卖掉了家里的一只羊才凑够。`, -1, 'family', [0, -1, 0, 1, -0.5], { cd: 3 });
E('ch_school_meal', (f) => f.in(6, 11) && f.inSchool && f.poorC, '学校开始提供免费午餐，很多同学因为这顿饭坚持来上学，你也不例外。', 1, 'study', [2, 1, 1, 0, 0.1], { once: true });
E('ch_kerosene', (f) => f.in(6, 14) && f.inSchool && f.elec < 75 && f.r && 1.5, '村里经常停电，你借着煤油灯的光写作业，眼睛常常被熏得发酸。', -1, 'study', [-1, -1, 1, 0, 0], { once: true });
E('ch_solar', (f) => f.in(6, 14) && f.inSchool && f.elec < 85 && f.r && f.year >= 2012, '家里装上了一块小太阳能板，晚上终于有了一盏明亮的灯，你可以多读一会儿书了。', 1, 'study', [0, 2, 2, 0, -0.2], { once: true });
E('ch_fetch_water', (f) => f.in(5, 13) && f.r && f.water < 70 && 1.5, (f) => (f.hasSib ? '每天清晨你都要和{sibling}去很远的水井打水，回来时肩膀被水桶压得生疼。' : '每天清晨你都要跟着母亲去很远的水井打水，回来时肩膀被水桶压得生疼。'), -1, 'childhood', [-1, -1, 0, 1, 0], { once: true });
E('ch_field_help', (f) => f.in(7, 13) && f.farmKid, '农忙时节，你跟着大人下地收{crop}，晒得黝黑，也第一次知道粮食来得有多不容易。', 0, 'family', [1, 0, 1, 1, 0.2], { cd: 3 });
E('ch_herding', (f) => f.in(6, 12) && f.r && (f.ssa || f.cas || f.iso === 'MNG' || f.mena || f.sas) && f.poorC, '放学后你负责放羊，在山坡上一边看着羊群，一边大声背课文。', 1, 'childhood', [1, 1, 1, 0, 0], { once: true });
E('ch_child_labor', (f) => f.in(8, 13) && f.lic && f.famPoor && 1.2, '家里欠了债，你开始在附近的作坊里帮工，每天的工钱只够买几斤粮食。', -2, 'crisis', [-3, -3, -1, 0, 0.3], { once: true });
E('ch_first_friend', (f) => f.in(4, 8), '你交到了第一个好朋友。你们交换了各自最宝贝的东西，发誓要当一辈子的朋友。', 1, 'childhood', [0, 3, 0, 4, 0], { once: true, w: 1.5 });
E('ch_bullied', (f) => f.in(7, 13) && f.inSchool, '班上几个孩子总拿你开玩笑。你回家没说，只是那段时间话少了很多。', -1, 'childhood', [0, -4, 0, -2, 0], { once: true });
E('ch_stood_up', (f) => f.in(8, 13) && f.inSchool, '你看到同学被欺负，鼓起勇气站了出来。那天你被推倒在地，却多了一个真心的朋友。', 1, 'childhood', [-1, 1, 0, 4, 0], { once: true });
E('ch_essay_prize', (f) => f.in(7, 11) && f.inSchool && f.know > 45, '你在全校作文比赛中拿了奖，奖状被父母贴在了家里最显眼的墙上。', 2, 'success', [0, 4, 2, 1, 0], { once: true });
E('ch_math_contest', (f) => f.in(9, 12) && f.inSchool && f.know > 55, '你参加了数学竞赛，虽然没拿到名次，却第一次感受到解开难题时的那种兴奋。', 1, 'study', [0, 2, 3, 0, 0], { once: true });
E('ch_broken_arm', (f) => f.in(5, 12), (f) => `你从树上摔下来，摔断了胳膊，打了六个星期的石膏，${f.inSchool ? '同学们' : '小伙伴们'}在上面画满了图案。`, -1, 'illness', [-4, -1, 0, 2, -0.3], { once: true, w: 0.8 });
E('ch_chickenpox', (f) => f.in(3, 10), '你出了水痘，在家躺了一周，浑身痒得睡不着，母亲用棉签给你一点点涂药。', -1, 'illness', [-3, -1, 0, 1, 0], { once: true, w: 0.7 });
E('ch_lost_tooth', (f) => f.in(6, 7), (f) => (f.eas ? '你掉了第一颗乳牙。按老家的说法，下牙要扔到屋顶上，上牙要丢进床底下。' : f.west ? '你掉了第一颗乳牙，把它放在了枕头底下。第二天早上，那里多了一枚硬币。' : f.lac ? '你掉了第一颗乳牙，把它藏在枕头下等“小老鼠佩雷斯”来取，第二天换来了一枚硬币。' : '你掉了第一颗乳牙，咧着漏风的嘴笑了一整天。'), 1, 'childhood', [0, 2, 0, 0, 0], { once: true, w: 1.5 });
E('ch_pet', (f) => f.in(5, 11) && !(f.lic && f.famPoor), ['家里收养了一只小狗，你给它起了名字，每天放学第一件事就是去找它。', '家里来了一只小猫，它总在你写作业时跳上书桌，趴在作业本上睡觉。'], 1, 'childhood', [1, 4, 0, 1, -0.2], { once: true, set: (f) => ({ flags: { pet: f.year } }) });
E('ch_pet_gone', (f) => f.in(8, 18) && f.flags.pet && f.year - f.flags.pet >= 5, '陪你长大的那只小动物老了，在一个安静的早晨离开了。你第一次认真地和一个生命告别。', -1, 'loss', [0, -4, 1, 0, 0], { once: true, w: 2 });
E('ch_grandma_stories', (f) => f.in(5, 10), '{granny}常给你讲她年轻时候的事，那些故事里有饥荒、迁徙，也有一场热热闹闹的婚礼。', 1, 'family', [0, 2, 1, 3, 0], { once: true });
E('ch_grandparent_death', (f) => f.in(6, 16), '疼爱你的{grandpa}去世了。葬礼上，你第一次看见家里的大人哭成那样，也隐约懂得了“再也见不到”是什么意思。', -2, 'loss', [0, -5, 0, -1, 0], { once: true, w: 0.8 });
E('ch_parents_quarrel', (f) => f.in(5, 14) && f.fam < 0.6 && f.momAlive && f.dadAlive && !f.flags.parentsDivorced, '父母为了钱的事吵得很凶，你躲在被子里，假装自己已经睡着了。', -1, 'family', [0, -3, 0, -1, 0], { cd: 4, w: 0.8 });
E('ch_parents_divorce', (f) => f.in(4, 15) && !f.flags.parentsDivorced && f.momAlive && f.dadAlive && (f.hic || f.umc || f.lac || f.eeu) && 0.5, '父母离婚了。他们都说这不是你的错，你还是花了很久才真正相信。', -2, 'family', [0, -6, 0, -2, 0], { once: true, set: { flags: { parentsDivorced: true } } });
E('ch_stepparent', (f) => f.in(6, 17) && f.flags.parentsDivorced && f.momAlive, '母亲再婚了，你多了一位继父。你们之间一直客客气气，直到你生病那晚，他在床边守了一整夜。', 1, 'family', [0, 1, 0, 2, 0], { once: true, w: 1.5 });
E('ch_to_city', (f) => f.in(5, 12) && f.r && f.parentAlive && (f.leftBehind || f.flags.parentAway || f.fam > 0.35) && 0.6, '父母在{bigcity}站稳了脚跟，把你接到了城里。新学校里，你的口音让你紧张了好一阵子。', 1, 'migration', [0, 2, 1, -1, 0], { once: true, set: (f) => ({ urban: true, flags: { leftBehind: false, city: bigCityOf(f) } }) });
E('ch_spring_return', (f) => f.in(4, 13) && f.leftBehind && f.sinic && f.momAlive && f.dadAlive && 2, '春节前，你每天都跑到村口张望。父母回来时提着大包小包，你却突然害羞得不敢叫人。', 1, 'family', [0, 3, 0, 2, 0], { cd: 2 });
E('ch_lb_meeting', (f) => f.in(6, 14) && f.leftBehind && f.inSchool, (f) => (f.chn ? '开家长会时只有{grandpa}来了，他听不太懂老师的普通话，你在旁边小声给他翻译。' : '开家长会时只有{grandpa}来了，他看不太懂老师发的成绩单，你在旁边一行一行地念给他听。'), -1, 'family', [0, -2, 0, 1, 0], { cd: 3 });
E('ch_lb_video', (f) => f.in(4, 15) && (f.leftBehind || f.flags.parentAway) && f.smart && f.parentAlive, (f) => (f.leftBehind && f.momAlive && f.dadAlive ? '{granny}学会了用手机视频，你每个周末都能看到父母在工地宿舍里的样子。' : `家里学会了用手机视频，你每个周末都能看到${f.dadAlive ? '父亲' : '母亲'}在外地宿舍里的样子，屏幕那头总是很吵。`), 1, 'family', [0, 2, 0, 2, 0], { once: true });
E('ch_tv_family', (f) => f.in(4, 11) && f.year < 2012, '晚饭后全家围着电视看连续剧，你总是在大结局前就睡着了。', 1, 'family', [0, 2, 0, 2, 0], { once: true });
E('ch_games', (f) => f.in(7, 13), (f) => (f.year < 2008 ? '你迷上了掌上游戏机，在同学家一玩就是一下午，晚饭都忘了回家吃。' : f.year < 2015 ? `你偷偷在电脑上玩网络游戏，被${f.parentAlive ? '家里大人' : '{granny}'}抓了个正着。` : `你迷上了手机游戏，为了多玩半小时，天天和${f.parentAlive ? '家里大人' : '{granny}'}讨价还价。`), 0, 'childhood', [0, 3, -1, 1, 0], { cd: 4 });
E('ch_netcafe', (f) => f.in(10, 15) && ['CHN', 'VNM', 'KOR', 'IDN', 'PHL'].includes(f.iso) && f.year >= 2004 && f.year <= 2014 && f.u, '你第一次溜进网吧，烟雾缭绕里，屏幕的光让你觉得世界很大。', 0, 'childhood', [-1, 2, 1, 1, -0.1], { once: true });
E('ch_first_computer', (f) => f.in(7, 14) && f.internet >= 8 && f.year <= 2014 && f.fam > 0.5, (f) => (f.year <= 2006 ? '家里买了第一台电脑，拨号上网时“嘀嘀嘀”的声音，你一辈子都记得。' : '家里买了第一台电脑，你用它查资料、看动画，也第一次知道了“网速”这个词。'), 1, 'study', [0, 3, 3, 0, -1], { once: true });
E('ch_first_phone', (f) => f.in(9, 13) && f.smart && f.fam > 0.3, (f) => (f.hasSib ? '你有了人生第一部手机，是{sibling}用旧了的那一部，屏幕上还有一道裂纹。' : '你有了人生第一部手机，是家里大人用旧了的那一部，屏幕上还有一道裂纹。'), 1, 'childhood', [0, 3, 0, 1, 0], { once: true });
E('ch_online_class', (f) => f.in(6, 17) && f.inSchool && f.lockdown && f.internet >= 40 && 3, (f) => (f.r ? '学校停课了，你对着屏幕上网课。家里信号不好时，你得跑到屋顶或者村口找网络。' : '学校停课了，你对着屏幕上网课，课间就在客厅里转圈，想念操场和同学。'), -1, 'study', [0, -3, -1, -2, 0], { cd: 2, world: true });
E('ch_no_internet_lockdown', (f) => f.in(6, 17) && f.inSchool && f.lockdown && f.internet < 40 && 3, '学校停课了，可家里没有网，也没有电脑。你只能靠广播课程和老师偶尔送来的作业单学习。', -2, 'study', [0, -3, -3, 0, 0], { cd: 2, world: true });
E('ch_library', (f) => f.in(7, 12) && (f.u || f.hic), '你在社区图书馆办了借书证，每周借满五本，有些书你只是喜欢闻它们的味道。', 1, 'study', [0, 2, 4, 0, 0], { once: true });
E('ch_flashlight_novel', (f) => f.in(7, 13) && f.inSchool, '你在被窝里打着手电筒看小说，第二天上课哈欠连天。', 0, 'childhood', [-1, 3, 3, 0, 0], { once: true });
E('ch_cram', (f) => f.in(7, 12) && f.examCulture && f.u && f.fam > 0.35 && !(f.chn && f.year >= 2021) && 1.5, (f) => `周末被排满了补习班：${f.chn || ['TWN', 'HKG', 'MAC'].includes(f.iso) ? '奥数、英语' : f.iso === 'SGP' ? '数学、华文' : '数学、英语'}、钢琴。你羡慕那些能在楼下疯玩的孩子。`, -1, 'study', [0, -3, 3, -1, -1], { cd: 3 });
E('cn_double_reduction', (f) => f.chn && f.year >= 2021 && f.year <= 2022 && f.in(6, 15) && f.inSchool && f.u && 3, '“双减”政策出台后，你的校外补习班停了大半，周末突然多出了大把时间。', 1, 'study', [1, 3, 0, 1, 0.3], { once: true });
E('ch_piano', (f) => f.in(5, 10) && f.fam > 0.6, '父母给你报了钢琴课。你每天练琴半小时，偶尔偷偷把厨房的闹钟拨快几分钟。', 0, 'study', [0, 0, 2, 0, -1], { once: true, set: { flags: { instrument: true } } });
E('ch_swim', (f) => f.in(5, 10), '你学会了游泳。第一次不靠游泳圈浮在水面上时，你觉得自己像一条鱼。', 1, 'childhood', [2, 2, 0, 0, 0], { once: true });
E('ch_sport_team', (f) => f.in(8, 12) && f.inSchool, '你加入了学校的{sport}队，虽然大部分时间坐在替补席上，但每场比赛你都喊哑了嗓子。', 1, 'childhood', [2, 3, 0, 3, 0], { once: true });
E('ch_lost_market', (f) => f.in(4, 8), '你在热闹的集市上和家人走散了，被一位好心的摊主领到了广播站。母亲找到你时，腿都软了。', -1, 'childhood', [0, -2, 0, 1, 0], { once: true, w: 0.6 });
E('ch_festival', (f) => f.in(3, 12), '{festival}到了，你穿上新衣服，跟着大人走亲访友，口袋里塞满了糖果。', 1, 'childhood', [0, 3, 0, 2, 0], { cd: 3 });
E('ch_birthday', (f) => f.in(5, 11) && f.fam > 0.4, '你过了一个热闹的生日，蛋糕上的蜡烛你吹了三次才吹灭。', 1, 'childhood', [0, 3, 0, 2, -0.1], { cd: 4, w: 0.7 });
E('ch_museum', (f) => f.in(8, 12) && f.inSchool && f.fam > 0.25, '学校组织去{bigcity}参观博物馆，你第一次看到了恐龙化石，回来就宣布要当考古学家。', 1, 'study', [0, 3, 2, 2, -0.2], { once: true });
E('ch_clock', (f) => f.in(7, 11), '你把家里的闹钟拆开，想看看里面到底有什么，结果怎么也装不回去了。', 0, 'childhood', [0, 1, 2, 0, -0.1], { once: true, set: { flags: { tinkerer: true } } });
E('ch_teacher_kind', (f) => f.in(7, 12) && f.inSchool, '一位老师发现你的作业本总是写到最后一页，悄悄塞给你几本新的。你记了她一辈子。', 1, 'study', [0, 2, 1, 2, 0], { once: true });
E('ch_girl_pressure', (f) => f.in(10, 14) && f.fe && f.famPoor && f.lic && f.r && f.inSchool && 1.5, '家里商量着让你别再读书了，留在家帮忙照看弟妹、做家务。你哭着把课本藏进了床底。', -2, 'family', [0, -5, 0, -1, 0], { once: true, set: { flags: { schoolPressure: true } } });
E('ch_glasses', (f) => f.in(8, 14) && f.inSchool && (f.eas || (f.u && f.know > 50)), '你的视力越来越差，配上了第一副眼镜。戴上的那一刻，黑板上的字突然清清楚楚。', 0, 'study', [-1, 1, 1, 0, -0.2], { once: true });
E('ch_dengue', (f) => f.in(3, 15) && (f.sea || f.lac || f.sas) && 0.8, '你得了登革热，高烧和全身酸痛折磨了你一个多星期。', -1, 'illness', [-5, -2, 0, 0, -0.3], { cd: 4, hz: { mult: 1.1, years: 1, reason: '登革热' } });
E('ch_measles', (f) => f.in(1, 10) && f.lic, (f) => `${f.r ? '村里' : '街坊里'}爆发了麻疹，好几个孩子病倒了。好在你打过疫苗，没有被传染，可大人们好几个星期都不让你出门玩。`, 0, 'childhood', [0, -1, 0, -1, 0], { once: true, w: 0.6 });
E('ch_asthma', (f) => f.in(3, 12) && f.u && f.smoggy && 0.5, '城市的雾霾天里，你常常咳得睡不着，医生说那是哮喘。', -1, 'illness', [-3, -1, 0, 0, -0.3], { once: true, set: { addCondition: { id: 'asthma', name: '哮喘', severity: 1 } } });
E('ch_flood_school', (f) => f.in(6, 13) && f.monsoon && f.poorC && (f.flood ? 3 : 0.25), '季风雨冲垮了通往学校的路，学校停课了两周，你在家帮忙把被泡湿的粮食搬到高处。', -1, 'crisis', [-1, -2, -1, 1, -0.5], { cd: 3, world: true });
E('ch_typhoon', (f) => f.in(4, 14) && f.typhoon && (f.storm ? 3 : 0.6), '台风过境，窗外的树被吹得东倒西歪。你和家人在停电的屋子里点着蜡烛，听着收音机里的播报。', -1, 'crisis', [0, -1, 0, 1, -0.2], { cd: 3, world: true });
E('ch_hurricane', (f) => f.in(4, 14) && f.hurricane && (f.storm ? 3 : 0.6), '飓风逼近，全家用木板封住了窗户，在客厅里打着地铺度过了漫长的一夜。', -1, 'crisis', [0, -2, 0, 1, -0.5], { cd: 3, world: true });
E('ch_snow_day', (f) => f.in(5, 12) && f.snow, '一场大雪让学校停课一天，你和小伙伴们堆了一个比人还高的雪人。', 1, 'childhood', [1, 3, 0, 2, 0], { cd: 3 });
E('ch_drought', (f) => f.in(5, 14) && f.r && (f.ssa || f.cas || f.naf || f.was || f.iso === 'AUS') && f.poorC && (f.drought ? 3 : 0.6), '连续几个月没有下雨，井里的水越来越浅，家里的牲口瘦得能看见肋骨。', -2, 'crisis', [-2, -3, 0, 0, -1], { cd: 4, world: true });
E('ch_world_cup', (f) => f.in(6, 15) && f.year % 4 === 2 && f.year >= 2002, (f) => (f.hasSib ? '这一年的世界杯，你和{sibling}熬夜看球，学会了好多球员的名字。' : f.dadAlive ? '这一年的世界杯，你和父亲熬夜看球，学会了好多球员的名字。' : '这一年的世界杯，你和小伙伴们挤在一起看球，学会了好多球员的名字。'), 1, 'childhood', [0, 3, 0, 2, 0], { cd: 4 });
E('ch_beijing_2008', (f) => f.chn && f.year === 2008 && f.in(3, 15) && 4, '2008年北京奥运会开幕那晚，全家守在电视机前，你数着屏幕上沿中轴线一步步走来的“烟花脚印”。', 2, 'childhood', [0, 4, 1, 2, 0], { once: true });
E('ch_home_olympics', (f) => f.in(5, 16) && ((f.iso === 'GBR' && f.year === 2012) || (f.iso === 'BRA' && f.year === 2016) || (f.iso === 'JPN' && f.year === 2021) || (f.iso === 'FRA' && f.year === 2024) || (f.iso === 'USA' && f.year === 2028) || (f.iso === 'AUS' && f.year === 2032)) && 4, '{country}举办了奥运会，学校组织大家看比赛转播，你在本子上画满了五环。', 1, 'childhood', [0, 3, 1, 1, 0], { once: true });
E('ch_robot_toy', (f) => f.in(4, 10) && f.year >= 2030 && (f.hic || f.umc), '你收到一个会聊天的机器人玩具，它能耐心地回答你没完没了的“为什么”。', 1, 'childhood', [0, 3, 2, 0, -0.3], { once: true });
E('ch_ai_tutor', (f) => f.in(7, 15) && f.inSchool && f.aiTutor && 1.5, '学校给每个学生配了 AI 学习助手。它很有耐心，但老师提醒大家：会提问，比会找答案更重要。', 1, 'study', [0, 1, 3, 0, 0], { once: true });
E('ch_vr_class', (f) => f.in(7, 15) && f.inSchool && f.vr && (f.hic || (f.umc && f.u)), '你在虚拟现实课堂里“走进”了一座古城的街道，那一堂历史课你记得格外清楚。', 1, 'study', [0, 2, 3, 0, 0], { once: true });
E('ch_heat_school', (f) => f.in(6, 15) && f.inSchool && f.heat && 2, '热浪来袭，学校把上课时间改到了清晨，到了下午，所有人都躲在屋里不敢出门。', -1, 'crisis', [-1, -1, -1, 0, 0], { cd: 3, world: true });
E('ch_war_school', (f) => f.in(6, 15) && f.war && f.inSchool && 3, '战事逼近，学校关了门。你和其他孩子在地下室里继续上课，老师讲课时不时被远处的响声打断。', -2, 'war', [-2, -4, -2, 1, 0], { cd: 2, world: true });
E('ch_war_flee', (f) => f.in(3, 15) && f.war && f.conflict >= 2 && !f.displaced && 3, '全家收拾了几件衣服就上了路，在一个陌生小镇的亲戚家落了脚。你只来得及带上一本书。', -2, 'war', [-2, -5, -1, 0, -2], { once: true, world: true, set: (f) => ({ flags: { displaced: f.year } }) });
E('ch_tent_school', (f) => f.in(6, 15) && f.displaced, '在临时安置点，志愿者办起了帐篷学校。你重新拿起了铅笔，在本子上一遍遍写自己的名字。', 1, 'study', [0, 2, 2, 2, 0], { once: true, w: 2 });
E('ch_quake', (f) => f.in(3, 15) && f.quake && 3, (f) => (f.inSchool ? '地震发生时你正在教室里，老师带着大家躲到桌下，又冲到了操场上。从那以后，你走进任何房间都会先找出口。' : '地震发生时你正在屋里，大人一把拉起你冲到了空地上。从那以后，你走进任何房间都会先找出口。'), -2, 'crisis', [-2, -3, 1, 2, -1], { cd: 3, world: true });
E('ch_sars', (f) => ['CHN', 'HKG', 'TWN', 'SGP'].includes(f.iso) && f.year === 2003 && f.in(2, 15) && 4, (f) => `2003年非典期间，${f.age <= 5 ? '幼儿园' : '学校'}每天给你量体温，空气里总有一股消毒水的味道。`, -1, 'childhood', [0, -1, 0, 0, 0], { once: true });
E('ch_ebola', (f) => ['GIN', 'LBR', 'SLE'].includes(f.iso) && f.year >= 2014 && f.year <= 2015 && f.in(3, 15) && 4, '埃博拉疫情期间，学校停课了好几个月，大人们反复叮嘱你不要和别人握手，回家先用氯水洗手。', -2, 'crisis', [-1, -3, -2, -1, 0], { once: true });
E('ch_mpesa', (f) => ['KEN', 'TZA', 'UGA'].includes(f.iso) && f.year >= 2009 && f.in(7, 14) && f.momAlive, '母亲第一次用手机收到了在城里打工的舅舅转来的钱，她给你买了一双新鞋。', 1, 'family', [0, 2, 0, 1, 0.3], { once: true });
E('ch_chores', (f) => f.in(6, 11), '你被分配了人生第一项家务：每天洗碗。你偷偷发明了一套“最快洗碗法”。', 0, 'childhood', [0, 0, 1, 1, 0], { once: true, w: 0.7 });
E('ch_piggy_bank', (f) => f.in(7, 11), '你攒下了第一笔零花钱，在小卖部门口犹豫了半天，最后还是把它投进了存钱罐。', 0, 'childhood', [0, 1, 1, 0, 0.05], { once: true, w: 0.7 });
E('ch_stars', (f) => f.in(6, 12) && f.r, (f) => (f.hasSib ? '夏夜躺在屋顶上数星星，{sibling}指给你看哪一颗是北极星。' : '夏夜躺在屋顶上数星星，{grandpa}指给你看哪一颗是北极星。'), 1, 'childhood', [0, 3, 1, 2, 0], { once: true });
E('ch_parent_injured', (f) => f.in(5, 15) && (f.poorC || f.fam < 0.4) && f.dadAlive, '父亲在工地上受了伤，住了一个月的院。你第一次学着给大人端水、递药。', -1, 'family', [0, -3, 1, 2, -1], { once: true, w: 0.7 });
E('ch_talent_show', (f) => f.in(7, 12) && f.inSchool, '你在学校的文艺汇演上唱了一首歌，下台时腿还在发抖，掌声却很响。', 1, 'success', [0, 3, 0, 2, 0], { once: true });
E('ch_hukou_school', (f) => f.chn && f.u && f.in(6, 12) && f.fam < 0.35 && f.year <= 2020 && 1.5, '因为没有本地户口，你只能去城郊的打工子弟学校上学，教室是一排铁皮房，夏天热得像蒸笼。', -1, 'study', [0, -2, -1, 0, 0], { once: true });
E('ch_worship', (f) => f.in(5, 12) && (f.muslim || f.christmas || f.sas || f.iso === 'THA' || f.iso === 'MMR'), (f) => (f.muslim ? '周五你跟着家人去清真寺，大人们在里面礼拜，你在院子里和别的孩子追着跑。' : f.sas ? '节日里你跟着家人去寺庙上供，人群里飘着花环和焚香的味道。' : f.iso === 'THA' || f.iso === 'MMR' ? '清晨你跟着家人给化缘的僧人布施，捧着饭碗的手小心翼翼。' : '周末你跟着家人去教堂，大人们在唱诗，你在长椅上偷偷数彩色玻璃窗上的格子。'), 0, 'childhood', [0, 1, 0, 2, 0], { once: true, w: 0.6 });
E('ch_demonetization', (f) => f.iso === 'IND' && f.year === 2016 && f.in(6, 16) && 3, '政府宣布大面额纸币作废，家里的大人在银行门口排了好几个小时的队兑换现金，家里那几天连买菜都要精打细算。', -1, 'family', [0, -1, 0, 0, -0.2], { once: true });
E('ch_mobile_pay_cn', (f) => f.chn && f.year >= 2014 && f.year <= 2018 && f.in(8, 17), '你发现出门越来越不需要带钱了，连街边卖煎饼的阿姨都贴着付款二维码。', 0, 'childhood', [0, 1, 1, 0, 0], { once: true });
E('ch_moon_night', (f) => f.in(4, 11) && f.sinic, '中秋夜，一家人在阳台上吃月饼，你盯着月亮看了很久，想找出里面的兔子。', 1, 'family', [0, 2, 0, 2, 0], { cd: 4 });
E('ch_bike', (f) => f.in(6, 11), (f) => (f.dadAlive ? '你学会了骑自行车，父亲在后面扶着车座跑了很远，你回头时才发现他早就松手了。' : `你学会了骑自行车，${f.momAlive ? '母亲' : '{oldsib}'}在后面扶着车座跑了很远，你回头时才发现早就没人扶了。`), 1, 'childhood', [1, 3, 0, 2, 0], { once: true });
E('ch_scared_dark', (f) => f.in(4, 8), '你开始怕黑，每晚都要开着一盏小灯才肯睡觉。', 0, 'childhood', [0, -1, 0, 0, 0], { once: true, w: 0.5 });
E('ch_poor_egg', (f) => f.in(4, 11) && f.famPoor && f.poorC, (f) => `月底家里的${f.eas || f.sea || f.sas ? '米缸' : '粮袋'}见了底，${f.momAlive ? '母亲' : '{granny}'}把最后一个鸡蛋煮给了你，自己说不饿。`, -1, 'family', [0, -1, 0, 3, 0], { once: true });
E('ch_rich_tutor', (f) => f.in(5, 14) && f.famRich && (f.poorC || f.umc), '家里请了家庭教师，你从小就拥有很多同龄人没有的机会，可放学后的大房子里，常常只有你一个人。', 0, 'childhood', [0, -1, 3, -1, 0], { once: true });
E('ch_new_road', (f) => f.in(5, 14) && f.r && f.poorC && f.year >= 2008, '村里通了水泥路，去镇上的时间从两个小时缩短到了二十分钟，你第一次坐上了去镇上的班车。', 1, 'childhood', [0, 3, 1, 0, 0.3], { once: true });
E('ch_electricity_arrives', (f) => f.in(3, 14) && f.r && f.elec < 80, '村里第一次通了电。那天晚上，全村人聚在一起看着灯泡亮起来，有人鼓起了掌。', 2, 'success', [1, 5, 1, 1, 0], { once: true });
E('ch_kite', (f) => f.in(5, 10) && f.r, (f) => (f.eas || f.sea || f.sas ? '春天风大，{grandpa}用竹篾和旧报纸给你扎了一只风筝，你在田埂上一直跑到天黑。' : '起风的日子，{grandpa}用细木条和旧塑料袋给你扎了一只风筝，你在田边一直跑到天黑。'), 1, 'childhood', [1, 3, 0, 2, 0], { once: true, w: 0.7 });
E('ch_market_day', (f) => f.in(5, 11) && f.r && f.poorC, '赶集的日子，你跟着母亲把自家种的{crop}背到集市上卖，换回了盐、肥皂和一小包糖。', 1, 'family', [0, 2, 1, 1, 0], { once: true });
E('ch_ramadan_first', (f) => f.in(9, 12) && f.muslim, '这一年斋月，你第一次试着从日出斋戒到日落。傍晚开斋时，那一口椰枣甜得让你记了很久。', 1, 'family', [0, 2, 0, 2, 0], { once: true });
E('ch_summer_village', (f) => f.in(6, 12) && f.chn && f.u && !f.famRich, '暑假你被送回乡下的{granny}家，抓知了、下河摸鱼，晒得黑黑的才回城。', 1, 'childhood', [2, 3, 0, 2, 0], { once: true });
E('ch_parent_gulf', (f) => f.in(3, 14) && f.remitC && (f.sas || f.sea) && f.poorC && !f.flags.parentAway && f.dadAlive && 0.8, '父亲去海湾国家的工地打工了，每个月往家里寄一次钱。你只能在电话里听见他的声音，一年才见上一面。', -1, 'family', [0, -2, 0, -1, 0], { once: true, set: { flags: { parentAway: true } } });
E('ch_scholarship_child', (f) => f.in(8, 12) && f.inSchool && f.famPoor && f.know >= 60, '你的成绩一直排在前面，学校为你申请到一份助学金，书本和校服终于不用再发愁了。', 2, 'success', [0, 3, 2, 1, 0], { once: true });
E('ch_war_news', (f) => f.in(7, 12) && f.warFar, '电视新闻里每天都在播远方的战事。你问大人：那些和你一样大的孩子，现在在哪里上学？', 0, 'childhood', [0, -1, 1, 0, 0], { cd: 4, world: true, w: 0.6 });
E('ch_ai_story', (f) => f.in(4, 10) && f.genAI && (f.hic || f.umc), '睡前，你让家里的 AI 助手编了一个关于恐龙和宇航员的故事，第二天又缠着它讲续集。', 1, 'childhood', [0, 2, 1, 0, 0], { once: true });
E('ch_screen_limit', (f) => f.in(6, 12) && f.year >= 2015 && f.smart && f.u && f.momAlive && f.dadAlive, '父母给你的平板电脑设了使用时间限制，你和他们为“再看五分钟”展开了旷日持久的谈判。', 0, 'family', [0, -1, 0, 0, 0], { once: true, w: 0.6 });
E('ch_first_movie', (f) => f.in(5, 10) && f.u, '你第一次走进电影院，灯一黑下来，你就紧紧抓住了身边大人的手。', 1, 'childhood', [0, 3, 1, 1, 0], { once: true, w: 0.7 });
E('ch_robot_dog', (f) => f.in(5, 11) && f.robots, '邻居家买了一只机器狗，它会摇尾巴、会认人。可你还是更喜欢楼下那只真正的流浪猫。', 0, 'childhood', [0, 1, 1, 0, 0], { once: true });
E('ch_climate_class', (f) => f.in(8, 12) && f.year >= 2030 && f.inSchool, '学校开了气候课，老师带你们在操场边种树、记录每天的气温。你在作文里写：希望长大以后，夏天不要再那么热。', 1, 'study', [0, 1, 2, 1, 0], { once: true, w: 0.6 });
E('ch_school_shoes', (f) => f.in(6, 11) && f.inSchool && f.famPoor && f.poorC, '你的鞋子破了个洞，下雨天脚趾总是湿的。直到学期末，母亲才攒够钱给你买了一双新鞋。', -1, 'childhood', [-1, -1, 0, 1, 0], { once: true });
E('ch_girl_chores', (f) => f.in(7, 12) && f.fe && f.poorC && f.r && f.hasSib, '放学后你要先做饭、照看更小的孩子，常常等到天黑才有时间写作业。', -1, 'family', [0, -2, -1, 1, 0], { once: true });
E('ch_board_game', (f) => f.in(6, 11) && f.dadAlive, (f) => (f.sinic ? '父亲教你下象棋，每次你快输的时候，他都会悄悄让你一步。' : '父亲教你下棋，每次你快输的时候，他都会悄悄让你一步。'), 1, 'family', [0, 2, 2, 2, 0], { once: true, w: 0.7 });
E('ch_power_cut', (f) => f.in(5, 12) && f.elec >= 50 && (f.lmc || f.lic) && f.u, '停电又来了。一家人点着蜡烛吃晚饭，你借着手电筒的光把作业写完。', 0, 'childhood', [0, -1, 0, 1, 0], { cd: 4, w: 0.6 });
E('ch_dream_job', (f) => f.in(7, 11) && f.inSchool, (f) => `老师让大家写“我的理想”。你写的是：长大要当${f.year >= 2030 ? '太空工程师' : f.year >= 2016 ? '科学家' : '医生'}。`, 1, 'childhood', [0, 2, 1, 0, 0], { once: true, w: 0.6 });

/* Adolescence 12-17 */

E('tn_growth', (f) => f.in(12, 14), (f) => (f.m ? `这一年你一下子蹿高了十厘米，嗓音也变了，${f.dadAlive ? '接电话时常被人错认成父亲' : '连自己都快认不出电话录音里的声音'}。` : '这一年你长高了不少，开始在意镜子里的自己，也有了不愿跟大人说的心事。'), 0, 'childhood', [1, 0, 0, 0, 0], { once: true });
E('tn_acne', (f) => f.in(13, 16), '脸上冒出了一片青春痘，你每天早上都要对着镜子发好一会儿愁。', 0, 'childhood', [0, -2, 0, 0, 0], { once: true, w: 0.6 });
E('tn_crush', (f) => f.in(13, 17), ['你偷偷喜欢上了班里的一个同学，把对方的名字写在课本最后一页，又用涂改液盖掉。', '你开始留意某个人每天几点经过操场，心事写满了一整本日记。'], 1, 'love', [0, 2, 0, 1, 0], { once: true });
E('tn_first_love', (f) => f.in(15, 17), '你和一个同学谈起了青涩的恋爱。放学一起走一段路，就是一天里最好的时光。', 1, 'love', [0, 4, -1, 2, 0], { once: true, w: 0.7 });
E('tn_heartbreak', (f) => f.in(15, 18) && !!f.flags['ev:tn_first_love'] && 1.5, '那段青涩的感情无疾而终。你在被子里哭了一整晚，第二天还是照常去上学。', -1, 'love', [0, -4, 0, -1, 0], { once: true });
E('tn_exam_stress', (f) => f.in(14, 17) && f.inSchool && f.examCulture && 1.5, '离{exam}越来越近，教室后墙上的倒计时牌每天都在变小，你常常学到深夜。', -1, 'study', [-2, -3, 4, 0, 0], { cd: 2 });
E('tn_gaokao_year', (f) => f.chn && f.age === 17 && f.inSchool && 2, '高三这一年，你每天五点半起床，晚自习上到十点。{granny}打来电话，只叮嘱你一句：“别熬坏了身子。”', 0, 'study', [-2, -2, 5, 1, 0], { once: true });
E('tn_boarding', (f) => f.chn && f.r && f.in(12, 15) && f.inSchool, '你去县城的中学寄宿，每周日下午背着一周的咸菜和米出门，周五傍晚才回家。', 0, 'study', [0, -1, 2, -1, 0], { once: true });
E('tn_dropout_friends', (f) => f.in(13, 16) && f.poorC && f.secEnroll < 75 && f.inSchool, '班上又有几个同学没来上学，听说是去城里打工，或者回家帮忙干农活了。教室里的空座位越来越多。', -1, 'study', [0, -2, 0, -1, 0], { once: true });
E('tn_classmate_married', (f) => f.fe && f.in(14, 17) && f.adolFert >= 60 && f.poorC, '和你一起长大的一个女同学被家里安排嫁了人，那年她才十五岁。你在人群里看着她，心里说不出是什么滋味。', -1, 'loss', [0, -3, 1, 0, 0], { once: true });
E('tn_girls_health', (f) => f.fe && f.in(12, 15) && f.lic, '学校来了一个女童健康项目，发放了可以反复使用的卫生用品。从那以后，你每个月不用再请几天假了。', 1, 'study', [1, 2, 1, 0, 0], { once: true });
E('tn_sports_win', (f) => f.in(12, 17) && f.inSchool, (f) => (f.u ? '你所在的{sport}校队赢得了全市联赛冠军，终场哨响时你们抱在一起又哭又笑。' : '你在学校运动会上跑了第一名，冲过终点时全班都在喊你的名字。'), 2, 'success', [2, 4, 0, 2, 0], { once: true, w: 0.8 });
E('tn_band', (f) => f.in(14, 17) && f.u && (f.hic || f.umc), '你和几个朋友组了一支乐队，在车库里排练。弹得不怎么样，但吵得很开心。', 1, 'childhood', [0, 4, 1, 3, 0], { once: true, w: 0.6, set: { flags: { instrument: true } } });
E('tn_fight_parents', (f) => f.in(13, 17) && f.parentAlive, (f) => `你和${f.momAlive && f.dadAlive ? '父母' : f.momAlive ? '母亲' : '父亲'}大吵了一架，摔门而去，在外面走到深夜才回家。${f.momAlive ? '母亲' : '父亲'}什么也没说，给你热了一份{homefood}。`, -1, 'family', [0, -2, 0, -1, 0], { once: true });
E('tn_part_time', (f) => f.in(15, 17) && (f.hic || f.umc) && f.u, ['暑假你在快餐店打工，第一次领到自己挣的钱，给家里每个人都买了一样小礼物。', '你周末在超市理货，攒下的钱买了那样一直想要的东西。'], 1, 'work', [0, 2, 1, 1, 0], { once: true });
E('tn_driver_license', (f) => f.in(16, 17) && (f.nam || f.oce), '你考到了驾照，第一次独自开车出门时，手心全是汗。', 1, 'success', [0, 3, 1, 0, 0], { once: true });
E('tn_social_media', (f) => f.in(12, 16) && f.social, (f) => (f.year < 2016 ? '你注册了自己的社交网络账号，每天发状态、刷评论，生怕错过朋友们的动态。' : '你开始在社交平台上发照片和短视频，一条动态的点赞数能让你开心或失落一整天。'), 0, 'childhood', [0, 1, 0, 1, 0], { once: true });
E('tn_cyberbully', (f) => f.in(12, 17) && f.inSchool && f.social && f.year >= 2010 && 0.6, '有人在网上传了你的难堪照片，评论区里的嘲笑让你好几天不想去学校。一位老师发现后，帮你处理了这件事。', -2, 'crisis', [-1, -6, 0, -2, 0], { once: true });
E('tn_game_addict', (f) => f.in(12, 17) && f.year >= 2008 && f.internet >= 30, (f) => `你沉迷于一款网络游戏，成绩一落千丈。${f.parentAlive ? '家里大人' : '{granny}'}断了家里的网，你们冷战了一个月。`, -1, 'childhood', [-1, -1, -3, -2, 0], { once: true, w: 0.7 });
E('tn_short_video', (f) => f.in(12, 17) && f.shortVideo, '你发现自己一刷短视频就停不下来，一抬头已经是凌晨一点。', 0, 'childhood', [-1, 1, -1, 0, 0], { once: true, w: 0.7 });
E('tn_military_training', (f) => f.chn && f.in(15, 16) && f.inSchool, '高中开学前的军训，你在烈日下站军姿、叠被子，晒脱了一层皮，也认识了第一批高中朋友。', 0, 'study', [1, 0, 0, 3, 0], { once: true });
E('tn_olympiad', (f) => f.in(13, 17) && f.inSchool && f.know >= 70 && 0.8, '你参加了数学竞赛，拿到了不错的名次。老师说，这也许会成为你升学的敲门砖。', 2, 'success', [0, 4, 4, 1, 0], { once: true, set: { flags: { olympiad: true } } });
E('tn_science_fair', (f) => f.in(12, 16) && f.inSchool && (f.hic || f.umc), '你在科技节上展示了自己做的净水装置。评委问了很多问题，你一个都没答错。', 1, 'success', [0, 3, 3, 1, 0], { once: true, w: 0.6, set: { flags: { tinkerer: true } } });
E('tn_reading', (f) => f.in(12, 17), '你在图书馆里发现了一本改变你看世界方式的书，那个周末你一口气把它读完了。', 1, 'study', [0, 2, 3, 0, 0], { once: true, w: 0.7 });
E('tn_anxiety', (f) => f.in(14, 17) && f.inSchool && (f.examCulture || f.social) && 0.7, '你开始失眠、心慌，在课堂上也集中不了注意力。学校的心理老师和你谈了几次，你才明白这不是你一个人的问题。', -1, 'illness', [-2, -4, 0, 1, 0], { once: true });
E('tn_smoke', (f) => f.in(14, 17) && !f.smoker && (f.smokeRate >= 20 ? f.smokeRate / 25 : 0.3) * (f.m ? 1 : 0.35), '你跟着几个朋友点了第一支烟，被呛得直咳嗽，却没想到这会慢慢变成习惯。', -1, 'childhood', [-1, 1, 0, 1, 0], { once: true, set: { flags: { smoker: true } } });
E('tn_drink', (f) => f.in(15, 17) && !f.muslim && (f.weu || f.eeu || f.nam || f.oce || f.lac), '你在朋友的生日聚会上第一次喝醉，第二天头疼欲裂，发誓再也不这样了。', -1, 'childhood', [-1, 1, 0, 1, 0], { once: true, w: 0.6 });
E('tn_friend_accident', (f) => f.in(13, 18) && f.road >= 15 && 0.5, (f) => (f.inSchool ? '一位同学在放学路上遭遇车祸，再也没能回到教室。大家在那张空座位上放了一束花。' : '一起长大的一个伙伴在路上遭遇车祸，再也没能回来。你们几个在路口放了一束花，很久都没有说话。'), -2, 'loss', [0, -5, 0, -1, 0], { once: true });
E('tn_parent_layoff', (f) => f.in(12, 17) && (f.recession || (isNum(f.unemp) && f.unemp >= 12)) && !f.famRich && f.parentAlive, (f) => `${f.dadAlive ? '父亲' : '母亲'}丢了工作，家里的饭桌上很少再见到肉。你开始学着不再向家里要零花钱。`, -1, 'crisis', [0, -3, 0, 1, 0], { once: true, world: true });
E('tn_family_debt', (f) => f.in(12, 17) && f.famPoor && f.parentAlive, (f) => (f.momAlive && f.dadAlive ? '你无意中听到父母深夜在厨房里商量还债的事，第一次知道这个家有多不容易。' : `你无意中看见${f.momAlive ? '母亲' : '父亲'}深夜一个人在厨房里算还债的账，第一次知道这个家有多不容易。`), -1, 'family', [0, -2, 1, 2, 0], { once: true });
E('tn_scholarship', (f) => f.in(14, 17) && f.inSchool && f.know >= 65 && !f.famRich && 0.8, (f) => `你拿到了一份奖学金，校长在全校大会上念了你的名字。${f.parentAlive ? '家里人' : '{granny}'}把那张证书装进相框，挂在了墙上。`, 2, 'success', [0, 4, 2, 2, 0], { once: true });
E('tn_tutoring_cn', (f) => f.chn && f.in(12, 17) && f.year < 2021 && f.u && f.fam >= 0.4 && f.inSchool, '你的周末被各种补习班填满了，从一个教室赶到另一个教室，在地铁上啃面包当午饭。', -1, 'study', [-1, -3, 4, -1, 0], { once: true });
E('tn_climate_strike', (f) => f.in(13, 17) && f.year >= 2019 && f.year <= 2020 && (f.weu || f.oce || f.nam), '你和同学们一起参加了青年气候游行，举着自己画的标语牌走过市中心。', 1, 'childhood', [0, 2, 2, 2, 0], { once: true });
E('tn_covid_youth', (f) => f.in(12, 17) && f.covid, '戴着口罩上学、隔着屏幕考试、取消了的毕业旅行——你的青春里有好几年被疫情改写了。', -1, 'crisis', [0, -3, -1, -2, 0], { once: true, world: true });
E('tn_war_shelter', (f) => f.in(12, 17) && f.war && 3, '空袭警报响起时，你和家人躲进地下室。黑暗里你默背着单词，好让自己不去想外面的声音。', -2, 'war', [-2, -5, 0, 2, 0], { cd: 2, world: true });
E('tn_refugee_classmate', (f) => f.in(10, 17) && f.refugees && f.inSchool, '班上来了一位从战乱地区逃出来的新同学，TA话不多。你把自己的笔记借给了TA，两人慢慢成了朋友。', 1, 'childhood', [0, 1, 1, 2, 0], { once: true, world: true });
E('tn_genai_homework', (f) => f.in(12, 17) && f.inSchool && f.genAI && f.year <= 2030, '你第一次用 AI 帮忙写作文，交上去后被老师一眼看了出来。老师没有罚你，而是让你当着全班讲讲 AI 哪里写得不对。', 0, 'study', [0, 0, 2, 0, 0], { once: true });
E('tn_ai_mentor', (f) => f.in(13, 17) && f.inSchool && f.aiTutor && f.year >= 2030, 'AI 导师根据你的错题排好了每天的练习，成绩稳步提升。可你偶尔也会怀念和同学一起熬夜对答案的日子。', 1, 'study', [0, 0, 3, -1, 0], { once: true });
E('tn_heat_exam', (f) => f.in(14, 17) && f.inSchool && f.heat && f.proj, '考试季遇上创纪录的高温，学校把考场搬进了有空调的体育馆，可窗外的热浪还是让人头昏脑涨。', -1, 'crisis', [-1, -2, 0, 0, 0], { cd: 3, world: true });
E('tn_quinceanera', (f) => f.fe && f.age === 15 && f.lac, (f) => `你迎来了十五岁成年礼。家人为你办了一场派对，你穿着长裙和${f.dadAlive ? '父亲' : f.hasSib ? '{oldsib}' : '{grandpa}'}跳了第一支舞。`, 2, 'family', [0, 4, 0, 3, 0], { once: true });
E('tn_bar_mitzvah', (f) => f.iso === 'ISR' && f.in(12, 13), '你在亲友面前完成了成年礼的诵读，紧张得声音都在发抖。结束后，大家把糖果撒向了你。', 2, 'family', [0, 3, 1, 3, 0], { once: true });
E('tn_ramadan_fast', (f) => f.in(12, 17) && f.muslim, '整个斋月你都坚持了下来。白天上课时肚子咕咕叫，傍晚和全家一起开斋的那一刻格外温暖。', 1, 'family', [0, 1, 0, 2, 0], { cd: 4, w: 0.7 });
E('tn_market_seller', (f) => f.in(12, 16) && f.r && f.poorC && !f.inSchool, '你不再上学了，每天清晨在路边摆摊卖菜，学会了讨价还价，也学会了算账。', 0, 'work', [0, -1, 1, 1, 0], { once: true });
E('tn_harvest', (f) => f.in(12, 17) && f.farmKid && f.inSchool && f.r, '农忙时节，你请了几天假回家帮忙收{crop}，腰酸得直不起来，可看着粮食进仓，心里很踏实。', 0, 'family', [-1, 0, 0, 2, 0], { cd: 2 });
E('tn_motorbike', (f) => f.in(15, 17) && (f.sea || f.ssa || f.sas) && f.road >= 12, (f) => `你学会了骑摩托车，载着朋友在乡间小路上飞驰，风灌满了衬衫。${f.momAlive ? '母亲' : '家里人'}为此念叨了很久。`, 1, 'childhood', [-1, 3, 0, 2, 0], { once: true, w: 0.7 });
E('tn_sport_dream', (f) => f.in(12, 16), '你每天放学后都去空地上练{sport}，梦想有一天能代表{country}出赛。', 1, 'childhood', [2, 3, 0, 2, 0], { once: true, w: 0.7 });
E('tn_idol_fandom', (f) => f.in(12, 17) && (f.eas || f.sea) && f.year >= 2010 && f.social, '你成了一个偶像团体的粉丝，攒了好久的零花钱买专辑，和网上的同好们彻夜聊天。', 1, 'childhood', [0, 3, 0, 2, 0], { once: true, w: 0.6 });
E('tn_exchange', (f) => f.in(15, 17) && f.inSchool && f.famRich && (f.hic || f.umc), '你参加了交换生项目，在国外的寄宿家庭住了一个学期，第一次用外语做了梦。', 2, 'study', [0, 3, 4, 1, 0], { once: true });
E('tn_volunteer', (f) => f.in(14, 17), '你周末去社区做志愿者，陪养老院的老人聊天、下棋。有位老人每次都把你认成自己的孙辈，你也就笑着应下。', 1, 'childhood', [0, 2, 1, 3, 0], { once: true, w: 0.7 });
E('tn_sibling_leaves', (f) => f.in(12, 17) && f.hasSib, '{oldsib}离家去外地了。你第一次独占了那个房间，却发现家里安静得有点不习惯。', 0, 'family', [0, -1, 0, -1, 0], { once: true, w: 0.7 });
E('tn_grandparent_ill', (f) => f.in(12, 17) && !f.flags['ev:ch_grandparent_death'], '{grandpa}生了一场大病，你第一次在医院的走廊里看见家里的大人红着眼睛。', -1, 'family', [0, -3, 0, 2, 0], { once: true, w: 0.6 });
E('tn_factory_teen', (f) => f.in(15, 17) && !f.inSchool && f.poorC && f.r && (f.status === 'unemployed' || f.status === 'child'), '你跟着同乡去{bigcity}打工，在工厂流水线上一站就是十二个小时。第一个月的工资，你几乎全寄回了家。', -1, 'work', [-2, -2, 0, 0, 0], { once: true, set: (f) => ({ urban: true, career: { status: 'employed', title: '流水线工人', sector: '制造业', incomePct: PCT(f, -0.1) }, flags: { city: bigCityOf(f) } }) });
E('tn_flood', (f) => f.in(12, 17) && f.flood && 3, '洪水淹了家里的田和半间屋子。你和家人把能抢出来的东西都搬到高处，又在救济点排了几天队领粮食。', -2, 'crisis', [-2, -4, 0, 2, 0], { cd: 3, world: true });
E('tn_dream_job', (f) => f.in(14, 17) && f.inSchool, (f) => `有人问你长大想做什么。你想了想，说想当${f.proj && f.aiL === 'high' ? '人工智能伦理师' : f.year >= 2016 ? '工程师' : '老师'}。说出口后，你自己也愣了一下。`, 1, 'study', [0, 2, 1, 0, 0], { once: true, w: 0.6 });
E('tn_phone_confiscated', (f) => f.in(12, 16) && f.smart && f.examCulture && f.inSchool, '你上课偷玩手机，被班主任没收了，直到学期末才还给你。', -1, 'study', [0, -2, 1, 0, 0], { once: true, w: 0.6 });
E('tn_coding', (f) => f.in(12, 17) && f.internet >= 50 && f.year >= 2012 && f.know >= 55, '你跟着网上的免费课程学会了写代码。第一个能运行的小游戏，让你兴奋得一夜没睡着。', 1, 'study', [0, 3, 4, 0, 0], { once: true, set: { flags: { coder: true } } });
E('tn_girl_keep_school', (f) => f.fe && f.r && f.poorC && f.in(13, 16) && f.inSchool && f.know >= 55 && f.momAlive, '有亲戚劝你父母别让女孩读太多书，母亲却坚持：“只要她考得上，再难也供。”', 1, 'family', [0, 2, 2, 3, 0], { once: true });
E('tn_first_phone_teen', (f) => f.in(12, 15) && f.phone && !f.smart && f.year <= 2012, (f) => (f.sinic ? '你有了第一部按键手机，学会了用九宫格飞快地发短信。每条短信都要钱，你总想把七十个字塞得满满的。' : '你有了第一部按键手机，拇指在键盘上飞快地按来按去。每条短信都要钱，你总想把一条短信塞得满满的。'), 1, 'childhood', [0, 3, 0, 2, 0], { once: true, w: 0.7 });
E('tn_dorm_friend', (f) => f.in(12, 17) && f.inSchool && f.examCulture, '宿舍熄灯后，你们几个躺在床上聊理想、聊喜欢的人，一直聊到宿管来敲门。那几个人后来成了你一辈子的朋友。', 1, 'childhood', [0, 3, 0, 4, 0], { once: true, w: 0.7 });
E('tn_teacher_mentor', (f) => f.in(13, 17) && f.inSchool && 0.6, '一位老师看出了你的潜力，下课后常留你多讲一会儿。TA说的一句话你记了很多年：“别让别人替你决定你能走多远。”', 1, 'study', [0, 2, 3, 2, 0], { once: true });

/* Youth 18-25 */

E('y_dorm_first_night', (f) => f.in(17, 20) && f.uni, '大学第一晚，宿舍里几个来自天南海北的人互相报了家乡，又为谁睡靠窗的床位笑闹了半天。', 1, 'study', [0, 3, 1, 3, 0], { once: true });
E('y_club', (f) => f.in(18, 22) && f.uni, ['你加入了登山社，周末跟着学长学姐去爬附近的山，看到了从未见过的日出。', '你加入了辩论社。第一次站上讲台时声音发抖，一学期后已经能面不改色地反驳对手。'], 1, 'study', [1, 3, 2, 3, 0], { once: true, w: 0.8 });
E('y_uni_scholar', (f) => f.in(18, 23) && f.uni && f.know >= 65 && 0.8, '你拿到了一等奖学金，第一次觉得自己可以不靠家里。', 2, 'success', [0, 4, 2, 0, 1], { once: true });
E('y_uni_fail', (f) => f.in(18, 23) && f.uni && f.know < 50 && 0.8, '你有一门专业课挂了。补考前一个月你天天泡在图书馆，成绩出来那天，你长长地舒了一口气。', -1, 'study', [0, -3, 2, 0, 0], { once: true });
E('y_student_loan', (f) => f.in(18, 24) && f.uni && ['USA', 'GBR', 'CAN', 'AUS', 'NZL'].includes(f.iso) && !f.famRich, '你签下了学生贷款合同。看着上面的数字，你意识到这笔账可能要还上十几年。', -1, 'study', [0, -2, 0, 0, -3], { once: true });
E('y_uni_parttime', (f) => f.in(18, 23) && f.uni && !f.famRich, ['你在学校食堂打工，每天中午给同学们打饭，换来一顿免费午餐和一点生活费。', '你同时做着三份家教，在城市的公交线路上来回奔波。'], 0, 'work', [-1, 0, 1, 1, 1], { once: true });
E('y_uni_exchange', (f) => f.in(19, 23) && f.uni && (f.famRich || f.know >= 75) && (f.hic || f.umc), '你申请到去国外交换一学期的机会，在陌生的城市里学会了独自生活，也学会了想家。', 2, 'study', [0, 3, 4, 1, -1], { once: true });
E('y_thesis', (f) => f.in(21, 24) && f.uni, '为了毕业论文，你在实验室和图书馆之间连轴转了好几个月。答辩结束那天，你在校园里走了很久。', 1, 'study', [-1, 1, 4, 0, 0], { once: true });
E('y_graduation', (f) => f.in(21, 25) && f.uni && !!f.flags['ev:y_thesis'] && 2, '毕业典礼上，你把学位帽抛向天空。拍完最后一张合影，宿舍里的人各奔东西。', 2, 'success', [0, 4, 1, 2, 0], { once: true });
E('y_kaoyan', (f) => f.chn && f.in(21, 23) && f.uni && f.know >= 55 && 1.2, '你决定考研，每天天不亮就去自习室占座。冬天的清晨，你在路灯下背着复习提纲。', 0, 'study', [-2, -2, 4, -1, 0], { once: true });
E('y_civil_exam', (f) => f.chn && f.in(22, 30) && (f.unemployed || f.uni) && f.eduRank >= 4, '你报名了公务员考试，考场外排着长长的队伍。一个岗位，几百人竞争。', 0, 'work', [0, -1, 2, 0, 0], { cd: 2 });
E('y_job_hunt', (f) => f.in(19, 27) && f.unemployed && !f.inSchool, (f) => (isNum(f.youthUnemp) && f.youthUnemp >= 8 ? `你投出了几十份简历，大多石沉大海。新闻里说，${f.year <= 2026 ? '' : '推演中'}这一年{country}的青年失业率是{youthUnemp}%。` : '你投出了几十份简历，大多石沉大海。你开始怀疑，是不是自己哪里做得不够好。'), -1, 'work', [0, -4, 1, -1, 0], { cd: 2 });
E('y_first_salary', (f) => f.in(16, 26) && f.employed && f.careerYears <= 1, (f) => `你领到了人生第一份正式工资，先给${f.momAlive && f.dadAlive ? '父母各买了一件礼物' : f.parentAlive ? `${f.momAlive ? '母亲' : '父亲'}买了一件礼物` : '家里人买了些东西'}，${f.smart ? '剩下的钱在手机银行里看了好几遍。' : '又把信封里剩下的钱数了好几遍。'}`, 2, 'work', [0, 4, 0, 2, 0.5], { once: true });
E('y_first_rent', (f) => f.in(18, 28) && f.u && f.working && !f.homeowner && (f.hic || f.umc), '你租下了人生第一个属于自己的小房间。房子很小，窗外是别人家的墙，但钥匙在你手里。', 1, 'work', [0, 3, 0, 0, -1], { once: true });
E('y_rent_hike', (f) => f.in(20, 35) && f.u && !f.homeowner && f.working && (f.hic || f.umc) && 0.8, '房东通知下个季度要涨房租。你算了算，只好搬去离公司更远的地方，每天通勤多了一个小时。', -1, 'crisis', [-1, -3, 0, 0, -1], { cd: 4 });
E('y_996', (f) => f.chn && f.in(22, 35) && f.employed && f.year >= 2016 && f.year <= 2022 && f.u && 0.8, '公司实行“大小周”，你常常加班到深夜，在回家的出租车上睡着。工资不低，可你已经很久没在白天见过自己的家了。', -1, 'work', [-3, -3, 1, -2, 1], { once: true });
E('y_delivery', (f) => f.in(18, 35) && f.u && (f.unemployed || f.incomePct < 0.35) && f.year >= 2015 && f.mobilePay && !f.military && !/骑手|外卖|快递|配送|跑腿/.test(f.title), (f) => (f.working ? '为了多挣一点，你在本职之外又注册成了外卖骑手，常常在城市的大街小巷里穿梭到深夜。系统算出的送达时间越来越短，你闯过的黄灯越来越多。'
  : f.student || f.inSchool ? '为了多挣点生活费，你课余注册成了外卖骑手，在城市的大街小巷里穿梭。系统算出的送达时间越来越短，你闯过的黄灯越来越多。' : '你注册成为外卖骑手，在城市的大街小巷里穿梭。系统算出的送达时间越来越短，你闯过的黄灯越来越多。'), -1, 'work', [-2, -1, 0, 0, 1], { once: true, set: (f) => (f.unemployed ? { career: { status: 'employed', title: '外卖骑手', sector: '平台服务', incomePct: PCT(f, 0) } } : undefined) });
E('y_factory', (f) => f.in(16, 35) && f.employed && /制造|工厂|流水线/.test(f.sector + f.title), '车间里的机器从早响到晚。你和工友们在食堂吃完饭就趴在桌上眯一会儿，下午接着干。', 0, 'work', [-1, -1, 0, 2, 0.3], { cd: 3 });
E('y_construction', (f) => f.in(18, 45) && f.m && f.poorC && f.r && !f.inSchool && !f.military && 0.5, '农闲时你跟着包工头去城里的工地干活，扎钢筋、搬水泥，晒得黝黑。工钱有时要等到年底才能结清。', -1, 'work', [-2, -1, 0, 1, 1], { cd: 3 });
E('y_gulf_dorm', (f) => f.in(18, 55) && f.migrant && GULF.has(f.iso) && f.poorC === false && REMIT.has(f.origin), '你和十几个来自不同国家的工友挤在一间宿舍里。白天在四十多度的高温下干活，晚上用手机和家人视频。', -1, 'migration', [-2, -2, 0, 1, 1], { cd: 3 });
E('y_remit', (f) => f.in(18, 65) && f.migrant && f.working && REMIT.has(f.origin), (f) => {
  const who = f.momAlive ? '母亲' : f.couple ? '{partner}' : f.hasSib ? '{sibling}' : '亲戚';
  const what = f.flags['ev:y_remit'] ? (f.hasKids ? '孩子的学费交上了，还给家里添了一辆摩托车' : '家里还清了旧债，饭桌上也常能见到肉了') : '家里的房顶终于换成了新的';
  return f.mobilePay ? `发薪日，你第一件事就是用手机给家里汇钱。${who}在视频里说，${what}。` : `发薪日，你第一件事就是去汇款点给家里寄钱。${who}在电话里说，${what}。`;
}, 1, 'migration', [0, 2, 0, 2, -1], { cd: 2 });
E('y_spring_rush', (f) => f.chn && f.in(18, 55) && f.u && f.ruralOrigin && f.working, (f) => (f.year >= 2014 ? '春运时，你在手机上抢了好几天票，才抢到一张回家的车票。车开进县城时，你远远看见了来接你的家人。' : `春运时，你在火车站排了几个小时的队，才买到一张站票。挤了一夜火车回到家，看见${f.momAlive ? '母亲' : '家里人'}正站在村口张望。`), 1, 'family', [-1, 3, 0, 3, -0.5], { cd: 3 });
E('y_blind_date', (f) => (f.sinic || f.iso === 'KOR' || f.sas) && f.in(23, 33) && f.neverMarried && !f.hasPartner, (f) => `${f.parentAlive ? '家里' : '亲戚'}托人给你安排了一场相亲。你们在咖啡馆里坐了一个小时，聊得客客气气，散场时都松了一口气。`, 0, 'love', [0, -1, 0, 0, 0], { cd: 2 });
E('y_marry_pressure', (f) => (f.sinic || f.sas || f.mena || f.iso === 'KOR') && f.in(25, 35) && f.neverMarried && f.parentAlive, '{festival}回家，亲戚们轮番问你什么时候结婚。你笑着打岔，回城的车上却一直望着窗外。', -1, 'family', [0, -3, 0, -1, 0], { cd: 3 });
E('y_meet', (f) => f.in(18, 34) && f.neverMarried && !f.hasPartner, ['你在朋友的聚会上认识了{newpartner}，你们聊到散场还意犹未尽。', '你和{newpartner}在一次志愿活动中相识，后来才发现两人住得只隔两条街。'], 2, 'love', [0, 5, 0, 3, 0], { cd: 3, prep: partnerP, set: dateSet });
E('y_dating_app', (f) => f.in(20, 38) && f.single && !f.hasPartner && !(f.widowed && f.widowYears < 2) && f.year >= 2013 && f.u && f.smart && (f.hic || f.umc), '你在交友软件上和{newpartner}聊得很投缘。第一次见面前，你紧张得换了三套衣服。', 1, 'love', [0, 4, 0, 2, 0], { cd: 4, w: 0.8, prep: partnerP, set: dateSet });
E('y_breakup', (f) => f.in(18, 45) && f.dating && f.hasPartner && f.year - f.partnerSince >= 1 && 0.6, '你和{partner}分手了。删掉合照的那天晚上，你把那首你们都喜欢的歌听了一遍又一遍。', -2, 'love', [0, -6, 0, -2, 0], { cd: 3, set: { relationship: { status: 'single', partner: null } } });
E('y_love_sweet', (f) => f.in(18, 45) && f.dating && f.hasPartner, (f) => (f.year - f.partnerSince <= 1 ? '你和{partner}一起过了第一个生日。TA送了你一件亲手做的小礼物，你一直留着。' : ['你和{partner}在一起又是一年。你们去了第一次约会的那家小店，老板居然还记得你们。', '{partner}陪你熬过了一段难挨的日子。你没说谢谢，只是那天的晚饭多做了一个TA爱吃的菜。', '你和{partner}一起学会了一道新菜，厨房被弄得一团糟，两个人却笑得停不下来。'][(f.year + f.age) % 3]), 2, 'love', [0, 4, 0, 3, 0], { cd: 3 });
E('y_long_distance', (f) => f.in(18, 35) && f.dating && f.hasPartner && 0.5, (f) => (f.videoCall ? '你和{partner}分隔两座城市，靠每晚的视频通话和偶尔的周末相聚维系着感情。' : '你和{partner}分隔两地，靠电话和偶尔的见面维系着感情，电话卡用掉了一张又一张。'), 0, 'love', [0, -1, 0, 1, -0.3], { cd: 4 });
E('y_friend_wedding', (f) => f.in(22, 35), '你去参加了老同学的婚礼，在台下看着新人交换誓言，想起了你们一起逃课的那个下午。', 1, 'love', [0, 2, 0, 2, -0.3], { cd: 3, w: 0.7 });
E('y_bride_price', (f) => f.in(22, 34) && f.dating && f.hasPartner && ((f.chn && f.r) || ((f.ssa || f.sas) && f.poorC)), (f) => (f.sas ? '谈婚论嫁时，嫁妆和婚礼开销成了两家人反复商量的话题，你和{partner}夹在中间左右为难。' : '谈婚论嫁时，彩礼成了绕不过去的话题。两家人坐下来谈了好几次，你和{partner}夹在中间左右为难。'), -1, 'love', [0, -2, 0, -1, -1], { once: true });
E('y_military_life', (f) => f.military && f.in(17, 35), '军营里的日子从起床号开始。你学会了在三分钟内叠好被子，也学会了在深夜站岗时想家。', 0, 'work', [3, -1, 1, 3, 0], { cd: 2 });
E('y_army_buddy', (f) => f.military && f.in(17, 35), '服役期间，你交到了一个可以托付后背的战友。分别那天，你们在车站抱了很久。', 1, 'work', [0, 2, 0, 4, 0], { once: true });
E('y_music_fest', (f) => f.in(18, 28) && (f.hic || f.umc) && f.u, '你和朋友们去了一场户外音乐节，在泥地里跳了一整夜，嗓子喊哑了也不在乎。', 1, 'calm', [0, 4, 0, 3, -0.5], { once: true, w: 0.7 });
E('y_backpack', (f) => f.in(19, 30) && (f.hic || (f.umc && f.fam > 0.5)), '你背着包独自旅行了一个月，睡过青年旅舍的上铺，也在陌生人的指引下找到过最好吃的小店。', 2, 'calm', [1, 5, 2, 2, -1.5], { once: true });
E('y_first_flight', (f) => f.in(18, 45) && !f.lic && (f.fam > 0.45 || f.incomePct > 0.5) && 0.4, '你第一次坐飞机。起飞时你死死抓着扶手，等穿出云层，又把脸贴在舷窗上看了很久。', 1, 'calm', [0, 3, 1, 0, -0.5], { once: true });
E('y_first_car', (f) => f.in(20, 40) && f.working && (f.hic || f.umc) && f.incomePct >= 0.4, (f) => (f.ev && f.year >= 2023 ? '你买了人生第一辆车，是辆电动车。第一次在夜里插上充电枪时，你在车边站了好一会儿。' : '你买了人生第一辆车，是辆二手车，可你每个周末都把它擦得锃亮。'), 1, 'success', [0, 3, 0, 0, -3], { once: true });
E('y_moto_accident', (f) => f.in(16, 40) && f.road >= 18 && 0.4, '你在雨天骑车摔了一跤，腿上缝了十几针。那之后，你出门都会戴好头盔。', -1, 'illness', [-4, -2, 0, 0, -0.5], { once: true, hz: { mult: 1.05, years: 1, reason: '交通事故受伤' } });
E('y_gym', (f) => f.in(18, 40) && f.u && (f.hic || f.umc), '你办了一张健身卡，前三个月风雨无阻，后来去的次数越来越少——但身体确实比以前结实了。', 1, 'calm', [3, 1, 0, 0, -0.3], { once: true, w: 0.7 });
E('y_burnout', (f) => f.in(22, 45) && f.employed && (f.examCulture || f.hic) && 0.5, '连续几个月的高强度工作后，你在一个普通的周一早上怎么也起不来床。医生说，你需要好好休息。', -2, 'illness', [-4, -5, 0, -1, -0.5], { once: true });
E('y_tangping', (f) => f.chn && f.in(20, 32) && f.year >= 2021 && f.year <= 2026 && 0.6, '“躺平”成了流行词。你也认真想过：拼命往上爬和好好过日子，到底哪个更重要？', 0, 'calm', [1, 1, 1, 0, 0], { once: true });
E('y_livestream', (f) => f.in(18, 35) && f.year >= 2018 && f.shortVideo && f.u && 0.5, (f) => `你${f.working ? '下班后' : '晚上'}开始做直播。开播第一晚只有七个观众，其中两个是你的朋友。`, 0, 'work', [0, 1, 1, 1, 0], { once: true });
E('y_crypto_hype', (f) => f.in(18, 50) && (f.year === 2017 || f.year === 2021) && f.internet >= 50, '身边好几个人都在谈论加密货币，有人说自己的钱翻了好几倍。你看着那些曲线，心里痒痒的。', 0, 'calm', [0, 0, 1, 0, 0], { once: true });
E('y_first_stock', (f) => f.in(20, 45) && f.working && f.incomePct >= 0.4 && f.year >= 2005 && f.u, '你开了第一个证券账户，买了一点指数基金。看着屏幕上红红绿绿的数字，你提醒自己要做长期投资。', 0, 'work', [0, 0, 1, 0, 0], { once: true });
E('y_gfc_job', (f) => f.in(18, 30) && f.year >= 2008 && f.year <= 2010 && f.finCrisis && (f.unemployed || f.uni), '金融危机让招聘会冷清了大半，你投出去的简历几乎都没有回音。', -2, 'crisis', [0, -4, 0, 0, -1], { once: true, world: true });
E('y_covid_grad', (f) => f.in(20, 25) && f.covid && (f.uni || f.unemployed), '你在疫情中毕业。毕业典礼改成了线上直播，面试也全在视频里进行，你对着电脑屏幕说了好多遍“您好”。', -1, 'crisis', [0, -3, 0, -2, 0], { once: true, world: true });
E('y_lockdown_alone', (f) => f.in(18, 45) && f.covid && f.single && f.u, (f) => (f.chn ? '封控期间，你一个人在出租屋里待了好几个星期。阳台上的那几盆葱，成了你最用心照料的东西。' : '居家隔离的那几个星期，你一个人待在出租屋里。窗台上的那几盆绿植，成了你最用心照料的东西。'), -1, 'crisis', [-1, -4, 0, -2, 0], { once: true, world: true });
E('y_wfh', (f) => f.in(22, 64) && f.employed && f.covid && f.incomePct >= 0.4 && f.internet >= 60, '公司改为居家办公，你的餐桌成了办公桌。省下了通勤时间，却也很难再分清哪里是工作、哪里是生活。', 0, 'work', [0, 0, 1, 1, 0], { once: true, world: true });
E('y_ai_job_fear', (f) => f.in(20, 50) && f.genAI && f.employed && f.incomePct >= 0.35 && f.year <= 2032, '公司开始用 AI 写报告、做客服。你一边学着用这些新工具，一边暗暗担心自己的岗位还能留多久。', -1, 'work', [0, -2, 2, 0, 0], { once: true });
E('y_ai_tool', (f) => f.in(18, 64) && f.genAI && (f.working || f.uni) && f.internet >= 50, '你开始用 AI 助手查资料、写初稿，原本要一天的活半天就能干完。可省下来的时间，很快又被安排了新任务。', 0, 'work', [0, 0, 2, 0, 0], { once: true });
E('y_climate_anxiety', (f) => f.in(16, 30) && f.year >= 2019 && f.internet >= 60, '又一个“有记录以来最热的一年”。你和朋友聊起将来要不要孩子，话题不知不觉就转到了气候上。', -1, 'calm', [0, -2, 1, 0, 0], { once: true, w: 0.5 });
E('y_roommate', (f) => f.in(18, 30) && f.u && !f.homeowner && !f.couple && 0.5, '你的合租室友是个夜猫子，每天凌晨两点才开始做饭。你们从互相忍耐，慢慢变成了无话不谈的朋友。', 0, 'calm', [0, 1, 0, 3, 0], { once: true });
E('y_cooking', (f) => f.in(18, 30) && !f.couple && 0.6, (f) => (f.parentAlive ? `你照着${f.momAlive ? '母亲' : '父亲'}在电话里讲的步骤，第一次自己做{homefood}。味道差了很远，可你还是吃得一点不剩。` : '你凭着记忆里家里饭菜的样子，第一次自己做{homefood}。味道差了很远，可你还是吃得一点不剩。'), 1, 'calm', [0, 2, 1, 1, 0], { once: true });
E('y_grandparent_death', (f) => f.in(18, 32) && !f.flags['ev:ch_grandparent_death'] && 0.6, '{granny}去世了。你赶回老家时已经晚了一步。整理遗物时，你发现她把你从小到大的照片都收在一个铁盒里。', -2, 'loss', [0, -5, 0, 1, 0], { once: true });
E('y_parent_ill', (f) => f.in(20, 40) && f.parentOld && 0.8, (f) => `${who(f)}住院做了手术。你请假回家陪护，在病床边的折叠椅上睡了一个星期。`, -1, 'family', [-1, -3, 0, 3, -1], { once: true });
E('y_sibling_wedding', (f) => f.in(24, 38) && f.hasSib, (f) => `{sibling}结婚了。婚礼上你负责招呼客人，忙得脚不沾地，${f.parentAlive ? `看着${f.momAlive && f.dadAlive ? '父母' : f.momAlive ? '母亲' : '父亲'}笑得合不拢嘴` : '心里却一直想着：要是爸妈能看到就好了'}。`, 1, 'family', [0, 3, 0, 3, -0.5], { once: true });
E('y_hometown_change', (f) => f.in(20, 45) && f.ruralOrigin && f.u && f.year >= 2010, '回到老家，村口修起了新路，老房子拆了不少。小时候常去的那条河，如今已经认不出来了。', 0, 'calm', [0, -1, 1, 1, 0], { once: true });
E('y_mobile_money', (f) => f.in(18, 45) && (f.ssa || f.sas) && f.year >= 2010 && f.phone && f.poorC, '你用手机开了一个移动钱包账户，第一次不用走两个小时去镇上的银行，就把钱转给了家里。', 1, 'work', [0, 2, 1, 1, 0.2], { once: true });
E('y_microloan', (f) => f.fe && f.in(20, 45) && f.poorC && (f.sas || f.ssa) && !f.employed && !f.inSchool, '你和村里另外四位女性组成了互助小组，申请到一笔小额贷款，买了一台缝纫机开始接活。', 1, 'work', [0, 3, 1, 3, 1], { once: true, set: (f) => ({ career: { status: 'self_employed', title: '裁缝', sector: '小生意', incomePct: PCT(f, 0.05) } }) });
E('y_scam_call', (f) => f.in(18, 70) && f.phone && f.year >= 2012 && 0.4, '你接到一个自称“客服”的电话，说你的账户有异常。好在你多留了个心眼，挂断后打给银行确认，才知道是诈骗。', 0, 'calm', [0, -1, 1, 0, 0], { cd: 8, w: 0.5 });
E('y_house_price', (f) => f.in(22, 35) && f.u && !f.homeowner && ((f.chn && f.year >= 2010 && f.year <= 2021) || (f.hic && f.year >= 2015)), '你算了一笔账：不吃不喝，也要攒二十多年才够在{city}买一套小房子。房价新闻底下的评论里，越来越多的人在自嘲。', -1, 'work', [0, -3, 1, 0, 0], { once: true });
E('y_mentor', (f) => f.in(20, 30) && f.employed && 0.6, '部门里一位前辈手把手地带你，把多年的经验毫无保留地教给了你。你暗暗记下：将来也要这样对待新人。', 1, 'work', [0, 2, 3, 2, 0], { once: true });
E('y_first_project', (f) => f.in(21, 32) && f.employed && f.know >= 55 && 0.7, '你独立负责的第一个项目顺利完成，老板在全组面前点名表扬了你。', 2, 'success', [0, 4, 2, 1, 0.5], { once: true });
E('y_job_found', (f) => f.in(18, 30) && f.unemployed && !f.inSchool && 0.7, '找了好几个月，你终于收到一份录用通知。签合同那天，你在公司楼下给家里打了个电话。', 2, 'work', [0, 5, 0, 1, 0], { cd: 3, set: (f) => ({ career: { status: 'employed', title: f.eduRank >= 5 ? '职员' : f.u ? '店员' : '工人', sector: f.u ? '服务业' : '农业', incomePct: PCT(f, 0) } }) });
E('y_learn_trade', (f) => f.in(16, 25) && !f.inSchool && f.eduRank <= 3 && f.poorC && 0.6, ['你跟着一位老师傅学修摩托车，满手油污，三个月后已经能独立修好发动机。', '你在镇上的裁缝铺当学徒，从钉扣子开始，一年后已经能独立做一件衬衫。'], 1, 'work', [0, 2, 3, 1, 0.3], { once: true });
E('y_heat_work', (f) => f.in(18, 64) && f.heat && (f.farmer || (f.working && f.poorC)) && 2, '热浪中，你只能在清晨和傍晚干活。中午最热的时候，你和工友们躲在阴凉处，一遍遍往头上浇水。', -1, 'crisis', [-3, -2, 0, 1, -0.5], { cd: 2, world: true, hz: { mult: 1.05, years: 1, reason: '高温劳动' } });
E('y_war_fear', (f) => f.in(18, 45) && f.m && (f.war || f.warNear) && !!f.consc && !f.military, '战事吃紧，征兵的消息一天比一天多。你每天出门前，都会下意识地摸一摸口袋里的证件。', -2, 'war', [-1, -5, 0, 1, 0], { cd: 2, world: true });
E('y_refugee_volunteer', (f) => f.in(18, 45) && f.refugees && !f.war, '你在难民接待站做志愿者，帮刚下车的一家人找到落脚的地方。那家的小女孩临走时，把一幅画塞进了你手里。', 1, 'calm', [0, 2, 1, 3, 0], { once: true, world: true });
E('y_pilgrimage', (f) => f.in(20, 65) && f.muslim && (f.fam > 0.4 || f.incomePct > 0.5) && 0.3, '你完成了一次朝觐之旅。在人潮之中，你觉得自己既渺小，又被某种更大的东西拥抱着。', 2, 'calm', [0, 4, 1, 2, -2], { once: true });
E('y_pet', (f) => f.in(20, 40) && f.u && !f.flags.pet && (f.hic || f.umc), (f) => `你收养了一只流浪猫。它刚来时在床底下躲了三天，现在每天都在门口等你${f.working ? '下班' : '回家'}。`, 1, 'calm', [1, 4, 0, 1, -0.3], { once: true, set: (f) => ({ flags: { pet: f.year } }) });

/* Adulthood 26-39 (many also fit later ages) */

E('a_promotion', (f) => f.in(25, 58) && f.employed && f.careerYears >= 3 && f.know >= 45 && 0.8, '你升职了。新的职位意味着更多的责任，也意味着工资条上的数字终于往上跳了一截。', 2, 'success', [0, 4, 1, 0, 2], { cd: 5, set: (f) => ({ career: { incomePct: PCT(f, 0.06) } }) });
E('a_raise_denied', (f) => f.in(25, 58) && f.employed && f.careerYears >= 2 && 0.5, '你鼓起勇气向主管提了加薪，得到的是一句“明年再说”。那天你在楼梯间站了很久。', -1, 'work', [0, -3, 0, 0, 0], { cd: 5 });
E('a_boss_conflict', (f) => f.in(23, 60) && f.employed && 0.6, '你和新来的上司理念不合，例会上当众争执了起来。之后的几个月，你在办公室里如履薄冰。', -1, 'work', [-1, -3, 0, -1, 0], { cd: 5 });
E('a_layoff', (f) => f.in(22, 62) && f.employed && f.jobYears >= 1 && (f.recession || f.covid) && 0.9, (f) => (f.covid ? '疫情冲击下，公司大幅裁员，你的名字也在名单上。你抱着纸箱走出大楼，一时不知道该往哪里去。' : '经济不景气，公司宣布裁员，你收到了解约通知。抱着纸箱走出大楼时，阳光刺得你睁不开眼。'), -2, 'crisis', [-1, -6, 0, -1, -1], { cd: 5, world: true, set: { career: { status: 'unemployed' } } });
E('a_reemployed', (f) => f.in(23, 62) && f.unemployed && !f.inSchool && 0.8, '失业几个月后，你终于找到了一份新工作。工资比以前低一些，但你格外珍惜每天出门上班的感觉。', 1, 'work', [0, 4, 0, 1, 0], { cd: 3, set: (f) => ({ career: { status: 'employed', incomePct: PCT(f, -0.05) } }) });
E('a_business_good', (f) => f.in(22, 75) && (f.selfEmp || f.business) && f.gdpGrowth > 2 && 0.7, '小店的生意越来越好。你雇了第一个员工，还把营业执照端端正正地挂在了墙上。', 2, 'success', [0, 4, 1, 1, 3], { cd: 4 });
E('a_business_bad', (f) => f.in(22, 75) && (f.selfEmp || f.business) && (f.recession || f.gdpGrowth < 1 || f.covid) && 0.8, '生意一落千丈，房租却一分没少。你每天算账到深夜，最后不得不把积蓄也填了进去。', -2, 'crisis', [-2, -5, 0, -1, -4], { cd: 3, world: true });
E('a_side_hustle', (f) => f.in(22, 50) && f.employed && f.incomePct < 0.6 && 0.5, (f) => (f.year >= 2016 && f.internet >= 40 ? '下班后，你在网上开了一家小店，卖自己做的手工小物件。第一单发货时，你包了三层泡泡纸。' : '周末你在夜市摆了个小摊，卖自己做的小吃。收摊时手冻得通红，口袋里却多了些零钱。'), 1, 'work', [-1, 1, 1, 1, 1], { once: true });
// looking back at the wedding: only once it lies some years back
E('a_wedding_photo', (f) => f.married && f.hasPartner && f.wedYears >= 5 && f.in(20, 70), '你和{partner}翻出了婚礼那天的照片：你笑得有点僵，TA的眼睛却亮晶晶的。那天的很多细节都记不清了，只记得交换誓言时，两个人的手都在发抖。', 2, 'love', [0, 4, 0, 3, 0], { once: true, w: 1.5 });
E('a_marriage_quarrel', (f) => f.in(22, 75) && f.couple && f.hasPartner && 0.6, '你和{partner}为了一件小事吵得不可开交，冷战了三天。最后是谁先开口道歉的，你们后来都说是自己。', -1, 'family', [0, -3, 0, -2, 0], { cd: 3 });
E('a_marriage_sweet', (f) => f.in(22, 85) && f.couple && f.hasPartner, (f) => (f.age >= 60
  ? ['你和{partner}每天早上一起去买菜，为了谁挑的西红柿更好争上两句，回家路上又手挽着手。', '{partner}的老花镜又找不到了，你笑着从TA头顶上摘下来递过去。这样的玩笑，你们开了很多年。', '天气好的午后，你和{partner}坐在窗边晒太阳，一个看报，一个打盹，谁也不说话，却觉得很安稳。']
  : ['纪念日那天，{partner}悄悄订了你们第一次约会的那家小馆子。', '下雨天，{partner}拿着伞在车站等你。你忽然觉得，日子就是这样一天天过成了家。', '你加班到很晚，回家时{partner}给你留了一盏灯和一碗热汤。你没说什么，心里却暖了很久。', f.hasKids ? '孩子睡着以后，你和{partner}在厨房里分吃一碗面，小声聊着这一天的琐事。' : '周末你和{partner}骑车去城外，在河边坐了一下午，说了很多从没说过的话。']), 2, 'love', [0, 4, 0, 3, -0.2], { cd: 3 });
E('a_newborn_nights', (f) => f.in(16, 60) && f.kids.some((k) => k.age <= 1), '{child}出生后的头几个月，你几乎没睡过一个整觉。可每当TA攥住你的手指，所有的疲惫都烟消云散。', 1, 'family', [-2, 3, 0, 3, -1], { cd: 2, w: 2, prep: kidP((k) => k.age <= 1) });
E('a_child_first_word', (f) => f.kids.some((k) => k.age >= 1 && k.age <= 2), (f) => `{child}第一次清清楚楚地叫出了“${f.m ? '爸爸' : '妈妈'}”。${f.smart ? '你激动得赶紧录了下来，发给了所有亲戚。' : '你激动得逢人就讲，讲了整整一个星期。'}`, 2, 'family', [0, 5, 0, 3, 0], { cd: 3, prep: kidP((k) => k.age >= 1 && k.age <= 2) });
E('a_childcare_cost', (f) => f.kids.some((k) => k.age <= 5) && (f.hic || (f.chn && f.u)) && f.working, (f) => `托儿所的费用比你预想的高得多。${f.hasPartner ? '你和{partner}' : '你'}算了一晚上账，${f.parentAlive ? '最后决定请老人来帮忙带孩子。' : '最后决定换一份时间更灵活的工作，自己多带一带孩子。'}`, -1, 'family', [0, -2, 0, 1, -2], { once: true });
E('a_kid_sick', (f) => f.kids.some((k) => k.age <= 10), '{child}半夜发高烧，你抱着TA在医院急诊室排了三个小时的队。天亮时烧退了，你却一夜没合眼。', -1, 'family', [-1, -2, 0, 2, -0.3], { cd: 3, prep: kidP((k) => k.age <= 10) });
E('a_kid_school_start', (f) => f.kids.some((k) => k.age === 6), '{child}背上新书包去上学了。你在校门口看着TA的背影，想起了自己第一天上学时的样子。', 1, 'family', [0, 3, 0, 2, -0.3], { cd: 2, w: 2, prep: kidP((k) => k.age === 6) });
E('a_school_district', (f) => f.chn && f.u && f.kids.some((k) => k.age >= 3 && k.age <= 6) && f.year >= 2008 && f.fam >= 0.3 && f.working, (f) => (f.homeowner ? '为了让{child}上一所好小学，你们咬牙卖掉了原来的房子，换了一套学区里的“老破小”。' : '为了让{child}上一所好小学，你们掏空了积蓄，又背上一笔贷款，买下了学区里一套“老破小”。'), -1, 'family', [0, -2, 0, 1, -6], { once: true, prep: kidP((k) => k.age >= 3 && k.age <= 6), set: { flags: { homeowner: true } } });
E('a_parent_meeting', (f) => f.kidSchool && 0.6, '你去参加{child}的家长会，老师夸了TA几句，你回家的路上一直哼着歌。', 1, 'family', [0, 3, 0, 2, 0], { cd: 4, prep: kidP((k) => k.age >= 6 && k.age <= 17) });
E('a_homework', (f) => f.kids.some((k) => k.age >= 6 && k.age <= 14) && f.examCulture, '晚上辅导{child}写作业，你从耐心讲解到拍桌子，只用了二十分钟。事后你又悄悄去给TA道了歉。', -1, 'family', [-1, -2, 0, 0, 0], { cd: 3, prep: kidP((k) => k.age >= 6 && k.age <= 14) });
E('a_kid_left_behind', (f) => f.chn && f.u && f.ruralOrigin && f.kids.some((k) => k.age >= 1 && k.age <= 10) && f.working && f.incomePct < 0.5 && f.year <= 2025 && f.parentAlive, (f) => `城里的房租和学费太贵，你们只好把{child}送回老家，托老人照看。${f.videoCall ? '每次视频通话结束，' : '每次打完电话，'}TA都哭着不肯挂。`, -2, 'family', [0, -5, 0, -2, 1], { once: true, prep: kidP((k) => k.age >= 1 && k.age <= 10) });
E('a_infertility', (f) => f.couple && f.hasPartner && f.nKidsEver === 0 && f.unionYears >= 3 && f.in(30, 42) && !f.flags.childfree && 0.5, '你们努力了好几年，孩子一直没有来。医院的走廊里，你和{partner}握着彼此的手，谁也没说话。', -2, 'family', [-1, -4, 0, 1, -1], { once: true });
E('a_childfree_talk', (f) => f.couple && f.hasPartner && !f.hasKids && f.in(28, 40) && (f.hic || f.umc) && 0.5, '你和{partner}认真谈过，决定暂时不要孩子。亲戚们的追问，你们学会了笑着带过。', 0, 'family', [0, 1, 0, 0, 0], { once: true });
E('a_mortgage_rate', (f) => f.homeowner && f.in(25, 65) && f.year >= 2022 && f.year <= 2024 && f.hic, '利率一路上调，你的月供涨了一大截。你取消了今年的旅行计划。', -1, 'crisis', [0, -2, 0, 0, -1], { once: true, world: true });
E('a_house_keys', (f) => f.homeowner && f.in(22, 65) && isNum(num(f.flags.mortgage)) && f.year - num(f.flags.mortgage) <= 2 && 3, '你在自己家空荡荡的客厅里坐了很久。墙是自己选的颜色，灯是自己挑的样子——这串钥匙后面，是漫长的还款日子。', 1, 'success', [0, 4, 0, 1, 0], { once: true });
E('a_eviction', (f) => f.in(22, 65) && !f.homeowner && f.u && f.poorC && 0.3, '房东要卖房，限你一个月内搬走。你找了三个周末，才找到一间价钱合适的屋子。', -1, 'crisis', [0, -3, 0, 0, -1], { cd: 6 });
E('a_move_house', (f) => f.in(22, 70) && 0.4, '你搬了一次家。打包时翻出一堆旧物，每一件都让你在地板上坐了好一会儿。', 0, 'calm', [0, 0, 0, 0, -0.5], { cd: 6, w: 0.5 });
E('a_friend_drift', (f) => f.in(26, 50), (f) => `你翻着通讯录，发现很多曾经无话不谈的朋友已经好几年没联系了。你给其中一个${f.smart ? '发了条消息' : '打了个电话'}，对方很快就回了过来。`, 0, 'calm', [0, 1, 0, 2, 0], { once: true });
E('a_class_reunion', (f) => f.in(28, 60) && 0.6, '同学聚会上，有人发了财，有人离了婚，有人已经不在了。散场时大家都喝多了，唱起了当年的歌。', 0, 'calm', [0, 2, 0, 3, -0.3], { cd: 10 });
E('a_sibling_loan', (f) => f.in(25, 65) && f.hasSib && f.working && 0.5, '{sibling}开口向你借钱周转。你犹豫了一晚，还是把钱转了过去。', 0, 'family', [0, -1, 0, 2, -2], { cd: 8 });
E('a_gift_money', (f) => f.chn && f.in(25, 55) && f.working, '这个月你收到了三张婚礼请柬，份子钱一交，工资就去了一小半。', -1, 'calm', [0, -1, 0, 2, -0.8], { cd: 3, w: 0.6 });
E('a_back_pain', (f) => f.in(28, 60) && (f.employed || f.farmer), (f) => (f.farmer ? '常年弯腰干活，你的腰开始一阵阵地疼。镇上的医生给你贴了膏药，让你少扛重物——可农活哪能不干。' : '久坐让你的腰开始隐隐作痛，医生让你每坐一小时就站起来走走。'), -1, 'illness', [-3, -1, 0, 0, -0.2], { once: true });
E('a_weight', (f) => f.in(30, 55) && (f.hic || f.umc) && 0.6, '体检报告上多了几个向上的箭头。你下定决心少吃夜宵，坚持了整整两个星期。', 0, 'illness', [-1, -1, 0, 0, 0], { once: true });
E('a_marathon', (f) => f.in(25, 60) && f.u && (f.hic || f.umc) && f.health >= 60 && 0.5, '你跑完了人生第一个马拉松。最后五公里几乎是挪过终点的，可挂上完赛奖牌的那一刻，你哭了。', 2, 'success', [4, 5, 0, 1, -0.3], { once: true });
E('a_depression', (f) => f.in(18, 70) && f.happy < 35 && !f.hasCond('depression') && 0.8, (f) => `你很长一段时间提不起劲，对什么都没兴趣。在朋友的劝说下，你${f.physicians >= 1 ? '去看了心理医生' : '去找了社区里的健康工作者'}。第一次说出“我不太好”的时候，你哭了。`, -1, 'illness', [-2, -2, 0, 2, -0.5], { once: true, set: { addCondition: { id: 'depression', name: '抑郁症', severity: 1 } } });
E('a_commute', (f) => f.in(22, 60) && f.employed && f.u && (f.chn || f.hic || f.umc) && 0.5, '你每天通勤要将近三个小时。一年下来，你在路上学完了一门外语课，也读完了十几本书。', 0, 'work', [-1, -1, 2, 0, 0], { once: true });
E('a_hybrid_work', (f) => f.in(25, 64) && f.employed && f.year >= 2023 && f.internet >= 75 && f.incomePct >= 0.5 && 0.5, '公司实行混合办公，你每周有两天在家工作，终于能在傍晚陪家人散步了。', 1, 'work', [1, 2, 0, 2, 0], { once: true });
E('a_ai_reskill', (f) => f.in(25, 64) && f.employed && f.genAI && 0.6, '公司要求所有人参加 AI 工具培训。你在一群年轻同事中间认真记笔记，下课后又把演示视频看了两遍。', 0, 'work', [0, -1, 3, 0, 0], { once: true });
E('a_auto_layoff', (f) => f.in(25, 64) && f.employed && f.jobYears >= 1 && f.automation && f.incomePct < 0.7 && 1.5, (f) => (f.flags['ev:a_auto_layoff'] ? '又一轮自动化改造开始了，这一次，你的岗位也没能留下。你把工牌交回人事部，心里比上一次平静了许多。' : '你所在的岗位被自动化系统取代了。人事部门给了你一份补偿金，还有一张再就业培训的报名表。'), -2, 'crisis', [-1, -6, 0, -1, 2], { cd: 12, world: true, set: { career: { status: 'unemployed' } } });
E('a_robot_coworker', (f) => f.in(20, 64) && f.employed && f.robots, '单位里来了几台新机器人，它们不吃饭、不休息。你的工作从“干活”，慢慢变成了“看着它们干活”。', 0, 'work', [0, -1, 2, 0, 0], { once: true });
E('a_gulf_contract_end', (f) => f.migrant && GULF.has(f.iso) && REMIT.has(f.origin) && f.origin !== f.iso && f.in(25, 60) && 0.4, '工作合同到期了，雇主没有续签。你收拾好行李，带着这几年的积蓄回到了{origin}。', 0, 'migration', [0, 1, 0, 3, 0], { once: true, set: (f) => ({ country: f.origin, flags: { migrant: false, returnee: f.year } }) });
E('a_visa', (f) => f.migrant && f.in(20, 65) && !f.flags.citizen && 0.6, '你的居留许可又到了续签的时候。你在移民局排了一上午的队，把一沓厚厚的材料递进窗口，心里七上八下。', -1, 'migration', [0, -3, 0, 0, -0.5], { cd: 3 });
E('a_language', (f) => f.migrant && f.in(16, 70), '你终于能用当地语言和邻居聊天气、开玩笑了。那天你在超市里和收银员多聊了好几句，心里很得意。', 1, 'migration', [0, 3, 2, 2, 0], { once: true });
E('a_homesick', (f) => f.migrant && f.in(16, 95), '{homefest}到了，你在异乡的小厨房里试着做{homefood}。配料不全，味道也不对，可你还是吃得很慢很慢。', -1, 'migration', [0, -2, 0, 0, 0], { cd: 3 });
E('a_citizenship', (f) => f.migrant && !f.flags.citizen && isNum(num(f.flags.migrantSince)) && f.year - num(f.flags.migrantSince) >= 5 && 0.8, '宣誓入籍那天，你穿上了最好的一件衣服。手续办完了，可“我是哪里人”这个问题，你还没有完全想清楚。', 1, 'migration', [0, 2, 0, 1, 0], { once: true, set: { flags: { citizen: true } } });
E('a_discrimination', (f) => f.migrant && f.in(16, 75) && 0.5, '有人因为你的口音冲你翻了个白眼。你没有争辩，回家后却难受了很久。', -1, 'migration', [0, -3, 0, -1, 0], { once: true });
E('a_remit_house', (f) => f.migrant && REMIT.has(f.origin) && f.origin !== f.iso && f.in(25, 60) && f.working && 0.6, (f) => `靠着你这些年寄回去的钱，家里在{origin}盖起了一栋两层小楼。${f.videoCall ? '视频里' : '电话里'}，${f.momAlive ? '母亲' : '家里人'}${f.videoCall ? '带着你看了每一个房间' : '把每一个房间都细细讲给你听'}。`, 2, 'success', [0, 4, 0, 3, -2], { once: true });
E('a_harvest_good', (f) => f.farmer && f.in(16, 80) && !f.drought && !f.flood && !f.heat, '今年风调雨顺，{crop}收成很好。粮食卖了个好价钱，你给家里添置了一样念叨了很久的大件。', 2, 'success', [0, 4, 0, 1, 2], { cd: 3 });
E('a_harvest_bad', (f) => f.farmer && f.in(16, 80) && (f.drought || f.flood || f.heat ? 2.5 : 0.4), '一场突如其来的天灾毁了大半庄稼。你蹲在地头，看着倒伏的{crop}，半天没说话。', -2, 'crisis', [-1, -5, 0, 0, -3], { cd: 3 });
E('a_livestock', (f) => f.farmer && f.in(16, 80) && (f.ssa || f.sas || f.cas || f.lac || f.iso === 'MNG') && 0.5, '家里的牛病倒了，兽医来了两趟也没能救回来。那是全家最值钱的家当。', -2, 'crisis', [0, -4, 0, 0, -3], { cd: 5 });
E('a_seed_loan', (f) => f.farmer && f.in(18, 75) && f.poorC && 0.5, '为了买种子和化肥，你向信用社借了一笔钱。整个生长季，你每天都要去地里看上好几遍。', -1, 'work', [0, -2, 0, 0, -1], { cd: 4 });
E('a_monsoon_crop', (f) => f.farmer && f.monsoon && f.in(16, 80) && (f.flood ? 3 : 0.25), ['季风雨来得太猛，河水漫进了稻田。你和邻居们连夜加固田埂，还是没能保住低处的那几块地。', '雨季迟迟不来，来了又下个不停。秧苗先是干得打蔫，后来又泡在水里。你算了算，这一季只能收回往年的一半。'], -2, 'crisis', [-1, -4, 0, 2, -2], { cd: 3, world: true });
E('a_locust', (f) => f.farmer && f.locustZone && (f.year === 2020 || f.year === 2021) && 2, '蝗虫群像一片乌云压过来，几个小时里就把地里的庄稼啃得精光。', -2, 'crisis', [0, -5, 0, 1, -3], { once: true, world: true });
E('a_drought_farm', (f) => f.farmer && f.drought && 3, '旱情持续了整整一个季度，井越挖越深，水却越来越少。你卖掉了一半牲口，才熬过了这个年景。', -2, 'crisis', [-2, -5, 0, 1, -3], { cd: 2, world: true, hz: { mult: 1.05, years: 2, reason: '旱灾' } });
E('a_farm_phone', (f) => f.farmer && f.smart && f.in(18, 75) && 0.6, '你开始用手机查天气预报和粮价，还在网上学会了一种新的育苗方法。今年的收成比往年好了一截。', 1, 'work', [0, 2, 3, 0, 1], { once: true });
E('a_rice_transplant', (f) => f.farmer && (f.eas || f.sea || f.sas) && f.in(14, 75) && 0.6, '插秧的季节，你挽起裤腿站在水田里，一行行秧苗从你手里插下去。直起腰时，田里映着整片天空。', 0, 'work', [-1, 1, 0, 1, 0], { cd: 4 });
E('a_coffee_harvest', (f) => f.farmer && (f.lac || ['ETH', 'KEN', 'UGA', 'RWA', 'VNM'].includes(f.iso)) && f.in(14, 75) && 0.6, (f) => (f.kids.some((k) => k.age <= 17) ? '咖啡果红了，全家人背着筐上山采摘。今年的收购价不错，你给孩子们添了新鞋。' : '咖啡果红了，全家人背着筐上山采摘。今年的收购价不错，你给家里添了几样早就想买的东西。'), 1, 'work', [-1, 2, 0, 2, 1], { cd: 4 });
E('a_war_job', (f) => f.war && f.in(18, 64) && f.working && 2, '战事让工厂停工、店铺关门，你的收入一下子断了。每天的头等大事，变成了去哪里找到干净的水和面包。', -2, 'war', [-2, -5, 0, 1, -3], { cd: 2, world: true });
E('a_war_flee', (f) => f.war && f.conflict >= 2 && f.in(18, 75) && !f.displaced && 2.5, (f) => (f.hasKids ? '战火逼近，你带着孩子们挤上了最后一班离城的大巴。回头看时，家的方向正冒着黑烟。' : '战火逼近，你只带了一个背包，跟着人流离开了这座城市。回头看时，家的方向正冒着黑烟。'), -2, 'war', [-3, -6, 0, 1, -4], { once: true, world: true, set: (f) => ({ flags: { displaced: f.year } }) });
E('a_inflation', (f) => f.in(18, 95) && f.hiInfl && !f.hyperInfl, (f) => `物价一路上涨，${f.year <= 2026 ? '新闻说' : '推演中'}这一年的通胀率达到了${Math.round(f.inflation)}%。你去市场时总要多带一些钱，买回来的东西却越来越少。`, -1, 'crisis', [0, -3, 0, 0, -1], { cd: 3, world: true });
E('a_hyperinflation', (f) => f.in(16, 95) && f.hyperInfl && 2, '钞票一天比一天不值钱。早上能买一袋面粉的钱，到了下午只够买半袋，大家开始用外币或实物交换。', -2, 'crisis', [-1, -5, 0, 0, -3], { cd: 2, world: true });
E('a_lottery', (f) => f.in(18, 85) && 0.15, '你随手买的一张彩票中了个小奖，不多不少，刚好够请全家人吃一顿好的。', 2, 'calm', [0, 3, 0, 2, 0.5], { cd: 10 });
E('a_inheritance', (f) => f.in(25, 70) && 0.15, (f) => (f.debt > 0 ? '一位远房长辈去世，给你留下了一小笔遗产。你用它还清了一部分欠款，心里对那位长辈多了几分思念。' : '一位远房长辈去世，给你留下了一小笔遗产。你把它存了起来，心里对那位长辈多了几分思念。'), 0, 'family', [0, 1, 0, 0, 3], { once: true });
E('a_night_school', (f) => f.in(20, 45) && f.eduRank <= 3 && f.working && 0.5, '你报名了夜校，下班后去教室上课。第一次交作业时，你的手因为一整天的体力活还在微微发抖。', 1, 'study', [-1, 1, 4, 1, -0.5], { once: true, set: { flags: { nightSchool: true } } });
E('a_literacy', (f) => f.fe && f.in(18, 65) && f.eduRank <= 1 && f.poorC, '你参加了村里的识字班，第一次一笔一画写下了自己的名字。你把那张纸叠好，放进了衣柜最深处。', 2, 'success', [0, 4, 4, 2, 0], { once: true });
E('a_mobile_biz', (f) => f.fe && f.in(20, 55) && f.ssa && f.mobilePay && f.poorC && 0.6, '你用手机接单、收款，把自家做的点心卖到了邻近的几个村子。月底一算账，比种地多挣了不少。', 1, 'work', [0, 3, 1, 2, 1], { once: true });
E('a_volunteer', (f) => f.in(25, 75) && 0.4, '你周末去社区做志愿者，帮老人填表格、教孩子读书。忙了一天回到家，心里反倒满满的。', 1, 'calm', [0, 3, 0, 3, 0], { cd: 5 });
E('a_faith', (f) => f.in(25, 75) && 0.35, (f) => (f.muslim ? '你开始更常去清真寺，在礼拜的寂静里，你找到了一种久违的安宁。' : f.buddhist ? '你开始在清晨给化缘的僧人布施，节日里去寺院静坐、听经，心慢慢静了下来。' : f.sas ? '你开始在清晨去附近的寺庙上供，在钟声和花香里，心慢慢静了下来。' : f.sinic || f.iso === 'JPN' || f.iso === 'KOR' || f.iso === 'VNM' ? '你开始在周末去山上的寺庙走走，听听钟声，看看云。' : f.iso === 'ISR' ? '你开始在安息日去犹太会堂，在熟悉的祷文里，心慢慢静了下来。' : f.christmas || f.eeu || f.ssa || f.iso === 'ETH' ? '你开始在周末去教堂，坐在长椅上听唱诗班唱歌，心慢慢静了下来。' : '你开始在周末去郊外走走，或者一个人安静地坐一会儿，心慢慢静了下来。'), 1, 'calm', [0, 3, 0, 2, 0], { once: true });
E('a_abroad_trip', (f) => f.in(25, 70) && (f.hic || (f.umc && f.incomePct >= 0.6)) && f.working, '你第一次出国旅行，在陌生的街头迷了路，却因此遇见了一家后来念念不忘的小餐馆。', 2, 'calm', [0, 5, 2, 1, -2], { once: true });
E('a_instrument', (f) => f.in(28, 65) && f.u && 0.4, '你报了一个成人钢琴班，和一群小朋友一起上课。弹完第一首完整的曲子那天，你给自己鼓了掌。', 1, 'calm', [0, 3, 2, 1, -0.5], { once: true });

/* Lives that otherwise get few stories of their own: running a home, raising children alone, displacement,
   living with a chronic illness, retirement, life after military service */
E('a_homemaker_day', (f) => f.homemaker && f.in(20, 64) && 1.2, (f) => (f.kids.some((k) => k.age <= 12) ? '你的一天从天不亮开始：做早饭、送孩子、买菜、洗衣、接孩子、辅导作业。没有工资条，也没有下班时间，可这个家的每一处都有你的手笔。' : '你把家里打理得井井有条：一日三餐、四季衣物、老人的药和亲戚间的人情，样样记在心里。这些活没有工资，却一刻也离不开人。'), 0, 'family', [-1, 0, 0, 3, 0], { cd: 5 });
E('a_homemaker_skill', (f) => f.homemaker && f.in(22, 60) && 0.8, (f) => (f.internet >= 40 && f.year >= 2012 ? '你把拿手的{homefood}拍成视频发到网上，没想到有人来问能不能订购。你开始在家接一些小单，第一次靠自己挣到了零花钱。' : '你做的{homefood}在街坊里出了名，常有人来请你帮忙做席面。你收一点辛苦钱，心里格外踏实。'), 1, 'work', [0, 3, 1, 2, 0.6], { once: true });
E('a_homemaker_return', (f) => f.homemaker && f.in(30, 55) && f.hasKids && f.kids.every((k) => k.age >= 6) && 0.7, '孩子们都上学了，家里白天忽然安静下来。你翻出了多年前的证书，报了一个技能培训班，想看看自己还能做些什么。', 1, 'study', [0, 2, 3, 1, -0.3], { once: true, set: { flags: { reskilling: true } } });
E('a_single_parent', (f) => (f.divorced || f.widowed) && !f.hasPartner && f.kids.some((k) => k.age <= 15) && f.in(20, 60), '一个人带孩子，你学会了同时做三件事：一边炒菜，一边听孩子背课文，一边回工作上的消息。累的时候你也想哭，可孩子一句“你真厉害”，又让你撑了下来。', 0, 'family', [-1, 0, 0, 3, -0.5], { cd: 4 });
E('a_coparent', (f) => f.divorced && f.kids.some((k) => k.age <= 17) && f.in(22, 60) && 0.8, '每个周末交接{child}的时候，你和前任都客客气气地点头。离婚时你们只约定了一件事：孩子面前，不说对方一句坏话。这一点，你们都做到了。', 0, 'family', [0, 0, 0, 2, 0], { once: true, prep: kidP((k) => k.age <= 17) });
E('a_displaced_camp', (f) => f.displaced && f.year - num(f.flags.displaced, f.year) <= 4 && f.in(16, 85), (f) => (f.hasKids ? '在临时安置点的日子里，你学会了在领物资的长队里和陌生人互相照应。孩子们在帐篷之间追跑，好像已经忘了害怕，你却常常在夜里醒来。' : '在临时安置点的日子里，你学会了在领物资的长队里和陌生人互相照应。有人分给你半块面包，后来你把一条毯子留给了更需要的人。'), -1, 'migration', [-1, -2, 0, 3, 0], { cd: 3 });
E('a_displaced_papers', (f) => f.displaced && f.in(18, 85) && 0.8, '逃难时丢掉的证件，你跑了十几趟才补办下来。拿到新证件的那一刻，你觉得自己终于又是一个“有地方可去”的人了。', 1, 'migration', [0, 3, 0, 1, 0], { once: true });
E('a_displaced_return', (f) => f.displaced && !f.migrant && !f.war && !f.warNear && f.year - num(f.flags.displaced, f.year) >= 2 && f.in(16, 90) && 0.6, '战事平息后，你回到了离开多年的家乡。房子受了损，街上的店铺换了招牌，可还是有老邻居认出了你，拉着你的手说：“回来就好。”', 1, 'migration', [0, 4, 0, 4, -1], { once: true, set: (f) => ({ flags: { displaced: false, returnee: f.year } }) });
E('ch_new_school_displaced', (f) => f.displaced && f.in(6, 15) && f.inSchool && 1.5, '你在新学校里做了插班生，课本不一样，口音也不一样。同桌把自己的笔记借给你抄，你们后来成了最好的朋友。', 1, 'study', [0, 1, 1, 3, 0], { once: true });
E('m_diabetes_life', (f) => f.hasCond('diabetes') && f.year - f.condSince('diabetes') >= 1 && f.in(30, 100), '和糖尿病打交道几年了，你已经能一眼看出一盘菜里藏着多少糖。饭后散步成了雷打不动的习惯，复查时医生说你控制得不错。', 1, 'illness', [2, 1, 1, 0, 0], { once: true, hz: { mult: 0.95, years: 5, reason: '血糖控制良好' } });
E('m_bp_routine', (f) => f.hasCond('hypertension') && f.year - f.condSince('hypertension') >= 1 && f.in(30, 105) && 0.8, '你每天早晚各量一次血压，把数字工工整整地记在小本子上。少盐的菜吃惯了，偶尔在外面吃饭，反倒嫌别人做得太咸。', 0, 'illness', [2, 0, 1, 0, 0], { once: true, hz: { mult: 0.95, years: 5, reason: '规律服药控压' } });
E('a_depression_day', (f) => f.hasCond('depression') && f.year - f.condSince('depression') >= 1 && 0.6, '有些早上，起床本身就像一场仗。你给自己定了很小的目标：拉开窗帘、出门走十分钟、给一个朋友回条消息。做到了，就算赢了一天。', 0, 'illness', [0, 1, 0, 1, 0], { once: true });
E('m_depression_better', (f) => f.hasCond('depression') && f.year - f.condSince('depression') >= 2 && 0.7, '情绪还是会有起伏，但你学会了在低落的日子里对自己宽容一些。医生说你恢复得不错，可以在指导下慢慢减药了。那天你给自己买了一束花。', 2, 'success', [1, 5, 0, 2, 0], { once: true, set: { removeCondition: 'depression' } });
E('s_stroke_rehab', (f) => f.hasCond('stroke') && f.year - f.condSince('stroke') >= 1 && 0.8, '康复训练一天也没落下。从扶着栏杆挪步，到能自己下楼买菜，你用了整整一年。康复师说，你是她见过最有耐心的病人之一。', 1, 'illness', [3, 3, 0, 2, 0], { once: true });
E('s_dementia_family', (f) => f.hasCond('dementia') && f.year - f.condSince('dementia') >= 1 && (f.hasKids || f.hasPartner) && 0.8, (f) => `你有时会叫错家人的名字，也会把刚说过的话再说一遍。${f.hasPartner ? '{partner}' : '孩子们'}从不纠正你，只是耐心地再回答一次。那些很久以前的歌，你倒还一句不落地记得。`, 0, 'family', [0, 0, -1, 3, 0], { once: true });
E('s_retired_hobby', (f) => f.retired && f.in(58, 90) && 0.8, (f) => (f.sinic ? '退休后你迷上了书法，每天早饭后铺开毛毡写上一个钟头。字写得一天比一天稳，心也一天比一天静。' : f.u ? '退休后你加入了社区合唱团，每周排练两次。年轻时不敢开口唱歌的你，如今站在了第二排的正中间。' : '退休后你把院子收拾成了一片小菜园，西红柿、豆角、辣椒轮着长。吃不完的，就分给左邻右舍。'), 1, 'retire', [2, 4, 1, 3, 0], { once: true });
E('s_retired_routine', (f) => f.retired && f.in(58, 95) && !!f.flags['ev:s_retire_day'] && f.year - num(f.flags['ev:s_retire_day'], f.year) >= 1 && 0.6, '退休一段时间后，你给自己排了一张作息表：早上锻炼，上午读报，下午见朋友，晚上早早睡下。日子松了下来，却没有散。', 1, 'retire', [2, 2, 1, 2, 0], { once: true });
E('a_veteran_reunion', (f) => f.veteran && f.in(25, 85) && 0.6, '每年到了退伍的那一天，你都会和老战友们聚一聚。饭桌上，大家又说起当年站岗时的那些夜晚，说着说着，有人红了眼眶。', 1, 'calm', [0, 3, 0, 4, -0.2], { cd: 5 });

/* Midlife 40-59 */

E('m_reflect', (f) => (f.age === 40 || f.age === 50) && 2, (f) => `${f.age}岁生日那天，你一个人在楼下坐了很久，想起年轻时对自己的那些期许：有些实现了，有些早已忘了。`, 0, 'calm', [0, 0, 1, 0, 0], { cd: 9 });
E('m_gray_hair', (f) => f.in(38, 50), '你在镜子里发现了第一根白头发，顺手拔掉了。过了几个月，你发现已经拔不过来了。', 0, 'calm', [0, -1, 0, 0, 0], { once: true, w: 0.6 });
E('m_presbyopia', (f) => f.in(43, 52), (f) => `你发现看${f.smart ? '手机' : '报纸'}时得把它拿远一点了。配老花镜那天，你在店里试了好久，才挑中一副不那么“显老”的。`, 0, 'illness', [-1, -1, 0, 0, -0.2], { once: true });
E('m_bp', (f) => f.in(38, 75) && !f.hasCond('hypertension') && (f.smoker ? 0.9 : 0.6), '体检时医生说你的血压偏高，要少盐、多运动、按时吃药。你把降压药放在了牙刷旁边。', -1, 'illness', [-3, -2, 0, 0, -0.3], { once: true, set: { addCondition: { id: 'hypertension', name: '高血压', severity: 1 } } });
E('m_diabetes', (f) => f.in(40, 78) && !f.hasCond('diabetes') && (f.hic || f.umc || f.u) && 0.4, '你被诊断出二型糖尿病。从那天起，你学会了看食品标签，也学会了给自己扎手指测血糖。', -1, 'illness', [-4, -3, 1, 0, -0.5], { once: true, set: { addCondition: { id: 'diabetes', name: '糖尿病', severity: 1 } } });
E('m_heart_scare', (f) => f.in(42, 78) && (f.smoker || f.hasCond('hypertension') ? 1 : 0.3), '一天夜里你胸口发闷，被送进了急诊。检查结果是虚惊一场，可医生的话让你后怕：“再这样下去，下次就不一定了。”', -1, 'illness', [-4, -3, 0, 2, -0.5], { once: true, hz: { mult: 1.15, years: 3, reason: '心脏预警' } });
E('m_cancer', (f) => f.in(45, 82) && !f.hasCond('cancer') && 0.25, (f) => (f.poorC && f.physicians < 0.8 ? '你被查出了肿瘤。县里的医院建议去大城市治疗，为了凑医药费，家里四处借钱。漫长的治疗里，你学会了感谢每一个平常的早晨。' : '你被查出患了早期癌症。手术、化疗……那一年你掉光了头发，也学会了感谢每一个平常的早晨。'), -2, 'illness', [-8, -6, 0, 3, -4], { once: true, set: { addCondition: { id: 'cancer', name: '癌症', severity: 2 } } });
E('m_cancer_remission', (f) => f.hasCond('cancer') && f.year - f.condSince('cancer') >= 3 && 0.6, '复查结果一切正常，医生笑着说：“可以把复查间隔拉长了。”你走出医院，觉得那天的天特别蓝。', 2, 'success', [4, 6, 0, 1, 0], { once: true, set: { removeCondition: 'cancer' } });
E('m_menopause', (f) => f.fe && f.in(47, 54), (f) => (f.internet >= 50 ? '更年期来了。潮热、失眠和莫名的烦躁让你有些措手不及，后来你在一个同龄人的线上小组里找到了共鸣。' : '更年期来了。潮热、失眠和莫名的烦躁让你有些措手不及，和几位同龄的朋友聊开了，才发现大家都一样。'), 0, 'illness', [-2, -2, 1, 1, 0], { once: true });
E('m_kid_exam', (f) => f.kids.some((k) => k.age >= 14 && k.age <= 18) && f.examCulture && 0.8, '{child}要参加{exam}了。考试那几天，你在考场外的树荫下一站就是大半天，比自己当年考试还紧张。', 0, 'family', [-1, -1, 0, 2, 0], { cd: 2, prep: kidExamP });
E('m_kid_leaves', (f) => f.kids.some((k) => k.age === 18 || k.age === 19), '{child}离家去外地了。送TA上车后，你回到家，在TA的房间门口站了很久。', -1, 'family', [0, -3, 0, 0, 0], { cd: 2, w: 1.5, prep: kidP((k) => k.age === 18 || k.age === 19) });
E('m_kid_wedding', (f) => f.kids.some(unwedKid(f)) && 0.4, '{child}结婚了。婚礼上你本来准备了一段致辞，可刚说了两句，就哽咽得说不下去了。', 2, 'family', [0, 5, 0, 3, -3], { cd: 2, prep: (f, rng) => kidP(unwedKid(f))(f, rng), set: (f, v) => ({ flags: { [`kidwed:${v.child}`]: f.year } }) });
E('m_kid_jobless', (f) => f.kids.some((k) => k.age >= 20 && k.age <= 30) && isNum(f.youthUnemp) && f.youthUnemp >= 15 && 0.6, '{child}毕业后一直没找到合适的工作，整天待在房间里。你想说点什么，话到嘴边又咽了回去。', -1, 'family', [0, -3, 0, -1, -0.5], { cd: 4, prep: kidP((k) => k.age >= 20 && k.age <= 30) });
E('m_grandchild', (f) => f.kids.some((k) => k.age >= 22) && f.in(40, 95) && 0.5, (f) => (f.flags.grandparent ? '{child}家又添了一个小宝宝。你抱着这个软软的小家伙，又一次感到了当年的那种惊喜。' : '{child}的孩子出生了。你第一次抱起那个小小的婴儿，忽然明白了当年父母看你的眼神。'), 2, 'family', [0, 6, 0, 4, -0.5], { cd: 4, prep: kidP((k) => k.age >= 22), set: { flags: { grandparent: true } } });
E('m_empty_nest', (f) => f.kidsAllAdult && f.in(45, 70), (f) => (f.hasPartner ? '孩子们都离开了家。饭桌上只剩你和{partner}两个人，你们一时竟不知道该聊些什么。' : '孩子们都离开了家。饭桌上只剩你一个人，你把电视的声音开得大了一点。'), -1, 'family', [0, -2, 0, -1, 0], { once: true });
E('m_parent_dementia', (f) => f.parentOld && f.in(40, 75) && 0.5, (f) => `${who(f)}开始记不清事情，有一次出门买菜，在熟悉的街口迷了路。确诊那天，你在医院门口哭了一场。`, -2, 'family', [-1, -5, 0, 2, -1], { once: true, set: { flags: { parentDementia: true } } });
E('m_parent_care', (f) => f.parentOld && f.in(35, 75) && 0.7, (f) => (f.momAlive && f.dadAlive ? '你每个周末都回去照看年迈的父母：修水管、换灯泡、陪他们去医院复查。临走时，他们总要往你包里塞点吃的。' : `你每个周末都回去照看年迈的${f.momAlive ? '母亲' : '父亲'}：修水管、换灯泡、陪${f.momAlive ? '她' : '他'}去医院复查。临走时，${f.momAlive ? '她' : '他'}总要往你包里塞点吃的。`), 0, 'family', [-1, -1, 0, 3, -0.5], { cd: 3 });
E('m_parent_hospital', (f) => f.parentOld && f.in(35, 78) && 0.5, (f) => (f.hasSib ? `${who(f)}突发急病住院，你和{sibling}轮流守在病床边，在走廊的长椅上分着吃一份盒饭。` : `${who(f)}突发急病住院，你一个人在医院和${f.working ? '单位' : '家'}之间来回奔波，累得在缴费窗口前打了个盹。`), -2, 'family', [-2, -4, 0, 3, -2], { cd: 4 });
E('m_old_friend_dies', (f) => f.in(45, 85) && 0.4, (f) => `一位多年的老朋友因病去世了。葬礼回来，你把${f.smart ? '手机里你们的聊天记录' : '你们年轻时的合影'}从头翻到了尾。`, -2, 'loss', [0, -5, 0, -1, 0], { cd: 6 });
E('m_plateau', (f) => f.in(40, 55) && f.employed && f.careerYears >= 10, '你在同一个岗位上已经待了很多年。年轻同事升得比你快，你开始思考：剩下的职业生涯，要不要换一种活法？', 0, 'work', [0, -2, 1, 0, 0], { once: true });
E('m_young_boss', (f) => f.in(42, 62) && f.employed && 0.5, '新来的部门经理比你小十几岁。开会时TA客客气气地称呼你“老师”，你一时分不清这是尊重，还是客套。', 0, 'work', [0, -1, 0, 0, 0], { once: true });
E('m_age_threshold', (f) => f.chn && f.in(35, 45) && (f.unemployed || (f.employed && f.recession)) && 1.2, '招聘启事上清一色写着“35岁以下”。你把简历上的出生年份看了又看，最后还是如实填了。', -2, 'work', [0, -4, 0, 0, 0], { once: true });
E('m_business_expand', (f) => f.in(35, 68) && (f.selfEmp || f.business) && f.gdpGrowth > 2.5 && 0.5, '你的小生意扩大成了一家公司。第一次给员工发年终奖时，你比他们还高兴。', 2, 'success', [-1, 4, 1, 2, 6], { once: true });
E('m_debt', (f) => f.in(30, 75) && f.income > 0 && f.debt > f.income * 2 && 0.8, '每个月的还款日像一座山压在心头。你把所有账单摊在桌上，排了一张详细的还债计划表。', -1, 'crisis', [-1, -4, 1, 0, 0], { cd: 4 });
E('m_mortgage_paid', (f) => f.homeowner && f.in(45, 75) && 0.4, '最后一笔房贷还清了。你在银行办完手续，给自己买了一份小小的礼物——还有一份久违的轻松。', 2, 'success', [0, 5, 0, 1, 1], { once: true });
E('m_invest_loss', (f) => f.in(28, 85) && f.portfolio > 0 && f.finCrisis && 1.5, (f) => `股市暴跌，你账户里的数字一夜之间缩水了一大截。你${f.smart ? '删掉了手机上的交易软件' : '把对账单塞进了抽屉'}，决定一个月不看。`, -2, 'crisis', [0, -4, 0, 0, 0], { cd: 3, world: true });
E('m_invest_gain', (f) => f.in(30, 85) && f.portfolio > Math.max(1000, f.income) && !f.finCrisis && f.gdpGrowth > 2 && 0.4, '这几年的投资收益不错。你看着账户，第一次觉得退休以后的日子有了底。', 1, 'success', [0, 3, 0, 0, 0], { cd: 5 });
E('m_crypto_crash', (f) => f.in(20, 75) && (f.year === 2018 || f.year === 2022) && (f.portfolio > 0 || !!f.flags['ev:y_crypto_hype']), '加密货币市场崩盘，你认识的好几个人血本无归。夜里你翻来覆去地想：幸好当初没有投太多。', 0, 'crisis', [0, -2, 1, 0, 0], { once: true, world: true });
E('m_property_slump', (f) => f.chn && f.year >= 2022 && f.year <= 2026 && f.homeowner && f.in(28, 75), '小区里挂牌出售的房子越来越多，价格一降再降。你算了算，自家的房子已经比买入时便宜了不少。', -1, 'crisis', [0, -3, 0, 0, 0], { once: true });
E('m_pension_worry', (f) => f.in(45, 60) && (f.poorC || f.selfEmp || f.farmer) && 0.5, '你开始认真算退休以后的日子：保险交了几年？存款够花几年？想来想去，只能先把身体顾好。', -1, 'work', [0, -2, 1, 0, 0], { once: true });
E('m_new_skill', (f) => f.in(40, 62) && f.internet >= 40 && 0.5, (f) => (f.genAI ? `你开始跟着网课学用 AI 工具做设计和剪辑。${f.hasKids ? '孩子们' : '年轻的朋友们'}笑你“与时俱进”，你却学得津津有味。` : '你报名学了摄影，周末背着相机走街串巷，拍下了很多从前没注意过的风景。'), 1, 'study', [0, 3, 3, 1, -0.5], { once: true });
E('m_ai_replace', (f) => f.in(40, 64) && f.automation && f.employed, '公司上线了新的 AI 系统，你们组从十二个人缩减到了三个。你留了下来，却总觉得下一个就轮到自己。', -1, 'work', [-1, -4, 1, -1, 0], { once: true, world: true });
E('m_robot_home', (f) => f.in(35, 95) && f.robots && f.incomePct >= 0.5 && 0.6, '家里添了一台家务机器人，它会叠衣服、拖地，还会提醒你吃药。不过泡茶这件事，你还是习惯自己来。', 1, 'calm', [1, 2, 0, 0, -2], { once: true });
E('m_square_dance', (f) => f.chn && f.fe && f.in(45, 78) && 0.7, '傍晚，你跟着小区的姐妹们在广场上跳舞。音乐一响，一天的烦心事都散了。', 1, 'calm', [3, 4, 0, 4, 0], { once: true });
E('m_fishing', (f) => f.m && f.in(40, 80) && 0.4, '你迷上了钓鱼，周末天不亮就出门，一坐就是一整天。鱼钓得不多，心却静了不少。', 1, 'calm', [1, 3, 0, 0, -0.2], { once: true });
E('m_garden', (f) => f.in(40, 85) && 0.4, (f) => `你在${f.u ? '阳台上' : '院子里'}种了一小片菜。西红柿红了的那天，你忍不住拍了好多张照片。`, 1, 'calm', [1, 3, 0, 1, 0], { once: true });
E('m_marriage_strain', (f) => f.couple && f.hasPartner && f.in(38, 65) && f.happy < 50 && 0.5, (f) => `你和{partner}之间的话越来越少，晚饭后各自盯着${f.smart ? '手机' : '电视'}，像住在同一屋檐下的室友。`, -1, 'family', [0, -3, 0, -2, 0], { cd: 5 });
E('m_rekindle', (f) => f.couple && f.hasPartner && f.in(40, 75) && 0.5, '你和{partner}报了一个双人舞蹈班。笨手笨脚地踩了对方好几脚，却笑得像刚认识时一样。', 2, 'love', [1, 4, 0, 3, -0.3], { once: true });
// a new love comes at the earliest a couple of years after the spouse died
E('m_late_love', (f) => (f.divorced || (f.widowed && f.widowYears >= 2)) && !f.hasPartner && f.in(35, 75) && 0.5, '你在朋友的介绍下认识了{newpartner}。你们都经历过一些事，所以格外懂得珍惜。', 2, 'love', [0, 5, 0, 3, 0], { cd: 4, prep: partnerP, set: dateSet });
E('m_divorce_friend', (f) => f.in(30, 65) && 0.3, '一对你看着走到一起的朋友离婚了。你两边都去陪着说了话，回家的路上想了很多。', 0, 'calm', [0, -1, 0, 1, 0], { once: true });
E('m_return_hometown', (f) => f.chn && f.ruralOrigin && f.u && f.in(45, 62) && f.working && f.incomePct < 0.5 && 0.4, '在城里打拼了大半辈子，你决定回老家。你用攒下的钱翻修了老屋，在院子里种上了果树。', 1, 'migration', [1, 3, 0, 2, -3], { once: true, set: { urban: false, flags: { returnedHome: true } } });
E('m_long_covid', (f) => f.covid && f.in(25, 85) && 0.3, '感染新冠后，你很长时间都容易疲惫、气短，爬两层楼就要歇一歇。', -1, 'illness', [-4, -2, 0, 0, -0.3], { once: true, world: true, set: { addCondition: { id: 'long_covid', name: '新冠后遗症', severity: 1 } } });
E('m_lockdown_family', (f) => f.covid && f.couple && f.hasKids && f.in(25, 60), (f) => `${f.chn ? '封控' : '居家隔离'}的那几个月，一家人整天挤在屋子里，吵过、哭过，也一起学会了做${f.sinic ? '馒头' : '面包'}。`, 0, 'family', [0, -1, 0, 3, -0.5], { once: true, world: true });
E('m_sea_level', (f) => f.surge && f.in(16, 110) && 2.5, ['一场风暴潮漫过了海堤，街道成了河。你在楼上看着水一点点退去，地下室里的东西全泡了汤。', '大潮加上暴雨，海水倒灌进了你家附近的街区。清淤花了整整一个月，邻居们开始认真讨论搬家的事。'], -2, 'crisis', [-1, -3, 0, 2, -2], { cd: 3, world: true });
E('m_sea_level_plan', (f) => f.seaRisk && f.in(25, 95) && 0.4, '海平面一年年上升，你家附近的街道每逢大潮就会积水。政府开始讨论整片社区的搬迁计划，你在听证会上第一次举手发了言。', -1, 'crisis', [0, -2, 1, 2, -0.5], { once: true, world: true, soft: true });
E('m_wildfire', (f) => (f.fire || (f.fireZone && f.heat && f.proj)) && f.in(18, 95) && 2, (f) => (!f.flags['ev:m_wildfire'] ? '山火的浓烟笼罩了整座城市，天空变成了橘红色。你关紧门窗，戴着口罩，看着新闻里被吞噬的山林。'
  : f.r ? '山火又一次逼近。你们按照演练过的路线把牲口和证件转移出去，在镇上的体育馆里等了三天，才等到解除警报。'
    : '又到了山火季。你早早备好了空气净化器和撤离包，手机里的火情地图一天要刷好几遍。'), -1, 'crisis', [-2, -3, 0, 0, -0.5], { cd: 2, world: true });
E('m_community', (f) => f.in(40, 78) && 0.3, (f) => `邻居们推举你当了${f.u ? '楼栋' : '村里'}的联络人。从调解邻里纠纷到组织清理垃圾，你忙得团团转，却很有成就感。`, 1, 'calm', [0, 3, 1, 4, 0], { once: true });
E('m_charity', (f) => f.in(35, 85) && f.wealth >= 60 && 0.4, '你开始每年固定拿出一部分收入，资助家乡的几个孩子上学。收到他们的来信时，你会读上好几遍。', 1, 'calm', [0, 4, 0, 3, -2], { once: true });

/* Old age 60-79 */

// retirement stories key on the engine's bookkeeping (flags.retiredYear / retiredFrom): only in the first year or
// two after leaving work, a farewell party only for someone who had colleagues, a pension only after a formal job
// (or where pensions are the rule)
E('s_retire_day', (f) => f.retired && f.retiredYears != null && f.retiredYears <= 1 && ['employed', 'military'].includes(f.retiredFrom) && f.in(45, 80) && 2, '退休那天，同事们给你办了个小小的欢送会。第二天早上你照常六点醒来，躺在床上，一时不知道该做些什么。', 0, 'retire', [0, 1, 0, 1, 0], { once: true });
E('s_pension', (f) => f.retired && f.retiredYears != null && f.retiredYears <= 1 && f.retiredFrom !== 'homemaker' && (!f.poorC || ['employed', 'military'].includes(f.retiredFrom)), '第一笔养老金到账了。数字不算多，你还是认认真真地记进了家里的账本。', 1, 'retire', [0, 2, 0, 0, 0], { once: true });
E('s_no_pension', (f) => f.in(60, 85) && f.poorC && !f.retired && (f.farmer || f.selfEmp || f.unemployed), '没有退休金，你只能继续干活。腰腿不如从前了，你还是每天早早出门。', -1, 'work', [-2, -2, 0, 0, 0], { cd: 4 });
E('s_grandkid_care', (f) => f.in(50, 85) && !!f.flags.grandparent && 0.8, '你每天接送孙辈上下学、做饭、陪着写作业，忙得比上班时还累。可孩子一扑进你怀里，你就什么都忘了。', 1, 'family', [-1, 4, 0, 4, -0.5], { cd: 3 });
E('s_senior_uni', (f) => f.in(58, 82) && f.eas && f.u && 0.6, '你报名了老年大学，学书法、学摄影。同学们的年纪加起来上千岁，课堂上却总是笑声不断。', 1, 'study', [1, 4, 3, 4, -0.3], { once: true });
E('s_taichi', (f) => f.in(55, 88) && f.sinic && 0.6, '每天清晨，你在公园里跟着一群老伙计打太极拳。一招一式慢慢悠悠，打完浑身舒坦。', 1, 'calm', [3, 2, 0, 3, 0], { once: true });
E('s_walking_club', (f) => f.in(60, 88) && !f.sinic && 0.5, '你加入了社区的晨走小组，每天绕着公园走两圈，顺便交换各家的新闻。', 1, 'calm', [3, 2, 0, 3, 0], { once: true });
E('s_tour', (f) => f.in(60, 82) && (f.hic || (f.umc && f.wealth >= 50)) && f.health >= 50 && 0.6, '你跟着旅行团去了年轻时一直想去的地方。站在那里的时候你想：原来真的不算晚。', 2, 'calm', [0, 5, 2, 2, -3], { cd: 4 });
E('s_smartphone', (f) => f.in(60, 95) && f.year >= 2013 && f.smart, (f) => `${f.flags.grandparent ? '孙辈' : '年轻的邻居'}手把手地教你用智能手机：怎么视频、怎么付款、怎么发语音。你在小本子上记了满满两页。`, 1, 'calm', [0, 3, 2, 2, 0], { once: true });
E('s_video_call', (f) => f.in(60, 100) && f.videoCall && f.kids.some((k) => k.age >= 20) && 0.6, '每个周末的晚上，你都会和{child}视频。屏幕那头的小辈们长得太快，每次都像换了一个人。', 1, 'family', [0, 3, 0, 3, 0], { cd: 4, prep: kidP((k) => k.age >= 20) });
E('s_scam', (f) => f.in(62, 95) && f.year >= 2008 && 0.4, (f) => `你在一场“健康讲座”上买了一大箱号称能治百病的保健品。${f.hasKids ? '孩子们' : '老朋友们'}知道后，又气又心疼。`, -1, 'crisis', [0, -3, 0, -1, -2], { once: true });
E('s_hearing', (f) => f.in(65, 95) && 0.5, '你的耳朵越来越背，家人说话常要重复两三遍。配上助听器后，你第一次听清了窗外的鸟叫。', 0, 'illness', [-1, 1, 0, 2, -1], { once: true });
E('s_cataract', (f) => f.in(62, 95) && 0.5, (f) => (f.poorC && f.physicians < 0.8 ? '你的视力越来越模糊。一个流动眼科医疗队来到镇上，为你做了白内障手术。拆掉纱布那天，你看清了家人的脸。' : '你做了白内障手术。拆掉纱布那天，世界忽然亮了许多，你这才发现家里的墙早该刷了。'), 1, 'illness', [2, 3, 0, 0, -0.5], { once: true });
E('s_knee', (f) => f.in(58, 92) && !f.hasCond('arthritis') && 0.5, '膝盖疼得越来越厉害，上下楼都得扶着栏杆。医生说是骨关节炎，叮嘱你别再爬山了。', -1, 'illness', [-3, -2, 0, 0, -0.3], { once: true, set: { addCondition: { id: 'arthritis', name: '骨关节炎', severity: 1 } } });
E('s_fall', (f) => f.in(68, 105) && 0.5, '你在浴室里滑了一跤，摔伤了手腕。家人连夜在家里装上了扶手和防滑垫。', -1, 'illness', [-4, -2, 0, 1, -0.5], { cd: 5, hz: { mult: 1.1, years: 2, reason: '跌倒受伤' } });
E('s_stroke', (f) => f.in(62, 98) && !f.hasCond('stroke') && (f.hasCond('hypertension') ? 1 : 0.3), (f) => `一天早上，你说话突然含糊不清，被紧急送进了医院——是一次中风。经过几个月的康复训练，你又能自己${f.sinic ? '拿筷子吃饭' : '扣上衬衫的扣子'}了。`, -2, 'illness', [-7, -4, 0, 2, -1], { once: true, set: { addCondition: { id: 'stroke', name: '中风后遗症', severity: 2 } } });
E('s_stent', (f) => f.in(58, 92) && (f.hasCond('hypertension') || f.smoker) && (f.hic || f.umc) && 0.4, (f) => (f.smoker ? '你做了心脏支架手术，第二天就能下床走路了。医生把话说得很清楚：烟，必须戒了。你把最后半包烟扔进了垃圾桶。' : '你做了心脏支架手术，第二天就能下床走路了。医生叮嘱你清淡饮食、按时吃药。'), -1, 'illness', [-3, -2, 0, 1, -1], { once: true, set: (f) => (f.smoker ? { flags: { smoker: false, exSmoker: true } } : undefined) });
E('s_dementia', (f) => f.in(72, 110) && !f.hasCond('dementia') && 0.35, '你开始忘事：钥匙放在哪儿，刚才要说什么。医生说是轻度认知障碍，你在家里贴满了便利贴。', -1, 'illness', [-3, -3, -3, 0, 0], { once: true, set: { addCondition: { id: 'dementia', name: '认知障碍', severity: 1 } } });
E('s_hospital', (f) => f.in(65, 105) && f.sick && 0.8, '你又一次住进了医院。病房窗外有一棵树，你每天看着它的叶子一片片变黄。', -1, 'illness', [-3, -3, 0, 1, -1], { cd: 3 });
E('s_spouse_ill', (f) => f.couple && f.hasPartner && f.in(60, 98) && 0.5, '{partner}病倒了，你成了TA的全职照顾者。喂饭、翻身、陪着做康复，你从没想过自己能做到这些。', -1, 'family', [-2, -3, 0, 4, -1], { cd: 5 });
// grief in the first years of widowhood, never once a new courtship has begun (group 'courtship')
E('s_widow_grief', (f) => f.widowed && !f.hasPartner && f.widowYears <= 3 && f.in(40, 110), (f) => `${f.age >= 60 ? '老伴' : '爱人'}走后，家里一下子空了。你还是习惯性地多摆一副碗筷，摆好了，才想起来。`, -2, 'loss', [-1, -5, 0, -1, 0], { once: true, w: 2 });
E('s_late_companion', (f) => ((f.widowed && f.widowYears >= 2) || f.divorced) && !f.hasPartner && f.in(60, 88) && 0.4, (f) => `你在老年活动中心认识了{newpartner}。两个人一起散步、下棋，${f.hasKids ? '子女们起初有些意外，后来也替你们高兴' : '老朋友们都说，你的气色一下子好了起来'}。`, 2, 'love', [1, 5, 0, 3, 0], { once: true, prep: partnerP, set: dateSet });
E('s_reunion', (f) => f.in(60, 88) && 0.4, '老同学们又聚了一次，来的人比上次少了许多。大家互相辨认着当年的模样，说着说着又笑出了眼泪。', 1, 'calm', [0, 3, 0, 3, -0.3], { once: true });
E('s_memoir', (f) => f.in(65, 98) && f.eduRank >= 2 && 0.4, '你开始写回忆录，从小时候的家乡写起。写着写着，好多早已忘记的人和事又回来了。', 1, 'calm', [0, 3, 2, 1, 0], { once: true, set: { flags: { memoir: true } } });
E('s_photo_album', (f) => f.in(65, 110) && 0.5, '你整理旧相册，一张张地翻：{birthyear}年出生的那个婴儿，后来竟走过了这么长的路。', 0, 'calm', [0, 2, 0, 1, 0], { once: true });
E('s_hometown_visit', (f) => f.in(60, 92) && (f.migrant || (f.u && f.ruralOrigin)) && 0.5, '你回了一趟故乡。老房子早已不在，认识你的人也没剩几个，可空气里的味道，还和小时候一样。', 0, 'calm', [0, 2, 0, 1, -1], { once: true });
E('s_move_to_kids', (f) => f.in(65, 95) && f.kids.some((k) => k.age >= 25) && (f.widowed || f.health < 45) && 0.4, '你搬去和{child}一家同住。新地方不认识人，你每天在楼下转悠，慢慢和几个老人成了棋友。', 0, 'family', [0, 0, 0, 2, 0], { once: true, prep: kidP((k) => k.age >= 25) });
E('s_lonely', (f) => f.in(65, 110) && (f.single || !f.hasKids) && f.relSt < 45 && 0.6, '很多个晚上，屋子里只有电视的声音。你开始给自己找点事做，免得一天说不上一句话。', -1, 'calm', [-1, -3, 0, -1, 0], { cd: 3 });
E('s_pet', (f) => f.in(60, 92) && !f.flags.pet && 0.4, '你养了一只小狗，每天早晚带它下楼散步。它让你的日子又有了规律。', 1, 'calm', [2, 4, 0, 1, -0.3], { once: true, set: (f) => ({ flags: { pet: f.year } }) });
E('s_volunteer', (f) => f.in(60, 82) && f.health >= 50 && 0.4, (f) => `你在社区当起了义务${f.u ? '图书管理员' : '调解员'}，大家有事都愿意来找你说一说。`, 1, 'retire', [0, 3, 1, 3, 0], { once: true });
E('s_heat', (f) => f.in(65, 115) && f.heat && 2, (f) => (f.flags['ev:s_heat'] ? '又是一个酷热的夏天。你已经摸出了门道：清晨把窗户打开，中午拉紧窗帘，傍晚才下楼走一走。' : f.hic || f.umc ? '热浪来袭，社区志愿者每天上门看你，提醒你多喝水、别出门。你在空调房里熬过了最热的那几天。' : '热浪来袭，医生反复叮嘱老人别出门。你拉上窗帘，一遍遍用湿毛巾擦脸，熬过了最热的那几天。'), -1, 'crisis', [-3, -2, 0, 1, 0], { cd: 3, world: true, hz: { mult: 1.08, years: 1, reason: '极端高温' } });
E('s_cold', (f) => f.in(65, 115) && f.snow && (f.poorC || f.eeu) && 0.4, '那年冬天特别冷，暖气时有时无。你裹着两层棉被，在屋里也戴着帽子。', -1, 'illness', [-2, -1, 0, 0, 0], { cd: 4, hz: { mult: 1.05, years: 1, reason: '严寒' } });
E('s_pandemic', (f) => f.in(60, 115) && f.pandemic && 2, (f) => (f.videoCall ? `疫情对老年人格外凶险。你几个月没出门，靠家人和邻居帮忙送菜，只能隔着手机屏幕看看${f.flags.grandparent ? '孙辈' : '想念的人'}。` : '疫情对老年人格外凶险。你几个月没出门，靠家人和邻居帮忙送菜，隔着窗户和来看你的亲人挥手。'), -2, 'crisis', [-2, -4, 0, -2, 0], { cd: 2, world: true });
E('s_vaccine', (f) => f.in(60, 115) && f.year === 2021 && f.covid && (f.hic || f.umc), '你排队打了新冠疫苗。接种点的志愿者扶你坐下，问你紧不紧张，你说：“活了这么大岁数，不紧张。”', 1, 'calm', [2, 1, 0, 1, 0], { once: true, world: true });
E('s_war', (f) => f.in(60, 115) && f.war && 2.5, '战火又一次逼近。你年纪大了，走不动远路，只好和几位老邻居守在地下室里，听着外面的动静。', -2, 'war', [-3, -5, 0, 2, -1], { cd: 2, world: true, hz: { mult: 1.1, years: 1, reason: '战乱' } });
E('s_flood', (f) => f.in(60, 115) && (f.flood || f.storm) && 2, '洪水来的那天夜里，邻居家的年轻人背着你蹚水转移到了安置点。你在临时帐篷里住了半个月。', -2, 'crisis', [-2, -4, 0, 3, -1], { cd: 2, world: true });
E('s_robot_carer', (f) => f.in(70, 115) && f.robots && 1.2, '家里来了一台护理机器人，它会提醒你吃药、扶你起身，还会陪你聊天。有时候，你会忘了它不是人。', 1, 'calm', [3, 2, 0, 0, -1], { once: true });
E('s_ai_companion', (f) => f.in(65, 115) && f.year >= 2030 && f.internet >= 60 && (f.single || f.widowed) && 0.6, '你开始每天和一个 AI 陪伴程序聊天，它记得你的口味、你的老朋友、你年轻时的故事。你知道它不是人，可它让夜晚没那么长了。', 0, 'calm', [0, 2, 0, 1, 0], { once: true });
E('s_longevity', (f) => f.in(55, 98) && f.longevity && 1.2, '你参加了一项新型抗衰老疗法。几个月后，体检报告上的“生物年龄”比实际年龄年轻了好几岁。', 2, 'success', [6, 3, 1, 0, -4], { once: true, hz: { mult: 0.85, years: 15, reason: '抗衰老疗法' } });
E('s_smart_home', (f) => f.in(65, 115) && f.aiDoctor && 0.8, '家里的健康监测系统提前发现了你心律的异常，医生及时调整了药物。你开玩笑说：这房子比你自己还了解你。', 1, 'calm', [3, 1, 0, 0, -0.5], { once: true, hz: { mult: 0.95, years: 5, reason: '智能健康监测' } });
E('s_will', (f) => f.in(70, 105) && f.hasKids && 0.4, '你请人帮忙立下了遗嘱，把能想到的事情都写清楚了。签完字，你反而觉得一身轻松。', 0, 'family', [0, 1, 0, 1, -0.2], { once: true, set: { flags: { will: true } } });

/* Very old age 80+ */

E('e_birthday_80', (f) => f.age === 80 && 3, (f) => (f.hasKids ? '八十大寿，儿孙们从各地赶回来，给你摆了满满一桌。吹蜡烛前你许了一个愿，谁问你都不说。' : '八十岁生日，老朋友和邻居们给你做了一桌菜。吹蜡烛前你许了一个愿，谁问你都不说。'), 2, 'family', [0, 5, 0, 4, -0.5], { once: true });
E('e_birthday_90', (f) => f.age === 90 && 3, '九十岁了。你看着满屋子的人，有些名字一时叫不上来，可每一张笑脸你都觉得亲切。', 2, 'success', [0, 5, 0, 4, 0], { once: true });
E('e_centenarian', (f) => f.age >= 100 && 3, '你满一百岁了。从{birthyear}年到{year}年，这个世界变了很多很多，你都亲眼看过。', 2, 'success', [0, 6, 0, 4, 0], { once: true });
E('e_slow_morning', (f) => f.in(80, 120), '你的一天从一杯热茶开始：在窗边晒太阳，看楼下的孩子们放学。日子过得很慢，你一点也不着急。', 1, 'calm', [1, 2, 0, 0, 0], { cd: 3 });
E('e_memory', (f) => f.in(82, 120) && 0.6, '你常常记不清今天是星期几，却能清清楚楚地讲出几十年前的某一个下午。', 0, 'calm', [0, 0, -2, 1, 0], { cd: 4 });
E('e_great_grandchild', (f) => f.in(75, 120) && !!f.flags.grandparent && f.kids.some((k) => k.age >= 45) && 0.5, '你抱上了重孙辈。四代人挤在一张照片里，你坐在正中间，笑得合不拢嘴。', 2, 'family', [0, 6, 0, 4, 0], { once: true });
E('e_last_friend', (f) => f.in(85, 120) && 0.5, '你送走了最后一位同龄的老朋友。回来的路上你想：这世上记得你年轻时模样的人，又少了一个。', -2, 'loss', [-1, -5, 0, -2, 0], { once: true });
E('e_care_home', (f) => f.in(80, 120) && f.health < 40 && (f.hic || f.umc) && 0.5, '你搬进了养老院。房间不大，护工很耐心，每周都有人来唱歌。你把家人的照片摆满了窗台。', 0, 'family', [1, -1, 0, 1, -2], { once: true, set: { flags: { careHome: true } } });
E('e_home_carer', (f) => f.in(80, 120) && f.health < 45 && !f.flags.careHome && 0.5, (f) => (f.hasKids && f.poorC ? '{child}辞掉了外地的工作，回来照顾你的起居。你嘴上说着“不用不用”，心里却很踏实。' : '家里请了一位护工照顾你的起居。TA话不多、手脚麻利，渐渐地你们像家人一样拉起了家常。'), 0, 'family', [2, 0, 0, 2, -1], { once: true, prep: kidP((k) => k.age >= 30) });
E('e_hip', (f) => f.in(80, 120) && 0.4, '你摔了一跤，髋骨骨折。手术很成功，但从此你走路离不开助行器了。', -2, 'illness', [-6, -3, 0, 1, -1], { once: true, hz: { mult: 1.3, years: 2, reason: '髋部骨折' } });
E('e_pneumonia', (f) => f.in(85, 120) && 0.4, '一场肺炎让你住了半个月院。出院那天，你让家人推着你在医院的花园里多绕了一圈。', -2, 'illness', [-5, -2, 0, 2, -0.5], { cd: 3, hz: { mult: 1.2, years: 1, reason: '肺炎' } });
E('e_stories', (f) => f.in(78, 120) && (f.hasKids || !!f.flags.grandparent), (f) => `孩子们围在你身边，听你讲小时候的世界：${(f.state.birth && f.state.birth.year) < 2010 ? '那时候手机还只能打电话，出门要带纸质地图' : (f.state.birth && f.state.birth.year) < 2030 ? '那时候人们得自己开车，手机还要用手指一下一下地点' : '那时候家里的机器人还不会做饭，AI 还常常答非所问'}。他们听得目瞪口呆。`, 1, 'family', [0, 4, 0, 3, 0], { once: true });
E('e_dream_parents', (f) => f.in(80, 120) && f.orphan, '你梦见了自己的父母。他们还是年轻时的样子，站在老房子门口喊你回家吃饭。醒来时，枕头湿了一片。', 0, 'calm', [0, -1, 0, 0, 0], { once: true });
E('e_old_songs', (f) => f.in(80, 120), (f) => `${f.year >= 2040 ? '家里的音箱' : '收音机'}里放起了你年轻时的流行歌，你跟着轻轻哼了起来，每一句歌词都还记得。`, 1, 'calm', [0, 3, 0, 0, 0], { once: true });
E('e_letter', (f) => f.in(80, 120) && f.eduRank >= 2 && 0.5, '你给二十岁的自己写了一封信。信里说：别太着急，也别太害怕，后来的日子，比你想的要好一些。', 1, 'calm', [0, 3, 1, 0, 0], { once: true });
E('e_hometown_changed', (f) => f.in(80, 120) && 0.4, '有人给你看了家乡如今的照片：高楼、新路、陌生的店名。你看了很久，指着一个角落说，那里原来有一棵大树。', 0, 'calm', [0, 0, 0, 1, 0], { once: true });
E('e_spouse_still', (f) => f.couple && f.hasPartner && f.in(78, 120), '你和{partner}已经相伴了大半辈子。每天傍晚，你们还是会手牵着手，在楼下慢慢走一圈。', 2, 'love', [1, 5, 0, 3, 0], { cd: 4 });
E('e_peaceful', (f) => f.in(85, 120) && f.health >= 35, '这一年平平静静地过去了。没有什么大事发生，你觉得这就是最好的事。', 1, 'calm', [0, 2, 0, 0, 0], { cd: 3 });
E('e_oral_history', (f) => f.in(80, 120) && 0.3, '一群大学生来采访你，记录普通人经历过的年代。你讲了整整一个下午，他们说这些故事会被收进档案馆。', 1, 'calm', [0, 3, 0, 2, 0], { once: true });
E('e_vr_home', (f) => f.in(75, 120) && f.vr, '家人给你戴上虚拟现实眼镜，带你“回到”了按老照片复原的故乡街道。你伸出手，想摸一摸那扇早已不在的木门。', 1, 'calm', [0, 4, 0, 2, 0], { once: true });
E('e_voice_archive', (f) => f.in(75, 120) && f.year >= 2035 && f.genAI && f.hasKids && 0.4, '孩子们帮你录下了很多段讲话，说是要做成“声音档案”。你对着话筒讲完了自己的一辈子，最后说：“别太难过。”', 0, 'family', [0, 1, 0, 2, 0], { once: true });

/* World events (any age 16+) */

E('w_hook_history', (f) => f.age >= 10 && !f.proj && hookEvents(f, false).length > 0 && 1.5, '{hookline}', 0, 'calm', [0, 0, 1, 0, 0], { cd: 2, world: true, soft: true, prep: hookP(false), set: hookSet, dyn: (f, v) => ({ tag: v._tag, tone: v._tone, fx: [0, v._sign, 1, 0, 0] }) });
E('w_hook_future', (f) => f.age >= 10 && f.proj && hookEvents(f, true).length > 0 && 1.2, '{hookline}', 0, 'calm', [0, 0, 1, 0, 0], { cd: 2, world: true, soft: true, prep: hookP(true), set: hookSet, dyn: (f, v) => ({ tag: v._tag, tone: v._tone, fx: [0, v._sign, 1, 0, 0] }) });
E('w_lockdown', (f) => f.in(18, 64) && f.covid && 2, (f) => (!f.u ? '疫情蔓延到了附近，村口拉起了隔离线，进出都要登记。你在家里待了好几个星期，靠邻里互相送菜过日子。' : `${f.chn ? '城市封控' : '城里实行了居家令'}，你被困在家里好几个星期。${f.smart && f.chn ? '每天的日程是：做核酸、抢菜、开视频会议。' : f.smart ? '每天的日程是：网上下单、开视频会议、在阳台上和邻居隔空聊天。' : '每天的日程是：听广播、排队领物资、隔着阳台和邻居说话。'}窗外安静得能听见鸟叫。`), -1, 'crisis', [-1, -3, 0, 0, -0.5], { once: true, world: true });
E('w_frontline', (f) => f.in(18, 65) && f.employed && f.pandemic && /医|护|卫生|快递|骑手|司机|超市|环卫|保安/.test(f.sector + f.title) && 3, '疫情最严重的那段日子，你作为一线人员每天照常出门。回家后，你先在门口把衣服换掉，才敢去抱家人。', -1, 'crisis', [-3, -2, 1, 3, 0.5], { once: true, world: true, hz: { mult: 1.05, years: 1, reason: '一线工作' } });
E('w_vaccine', (f) => f.in(18, 59) && f.year === 2021 && f.covid && !f.lic, '你打上了新冠疫苗，胳膊酸了两天。接种点外面排着长队，大家都戴着口罩，眼神里有一点久违的轻松。', 1, 'calm', [2, 1, 0, 0, 0], { once: true, world: true });
E('w_pandemic_loss', (f) => f.in(18, 110) && f.pandemic && 0.6, '一位亲人在疫情中离世。因为防疫规定，你没能见上最后一面，只能隔着屏幕参加了简短的告别。', -2, 'loss', [0, -6, 0, -1, 0], { once: true, world: true });
E('w_epidemic_local', (f) => f.in(5, 110) && f.epidemic && 2, (f) => (freshOutbreak(f) ?`「{event}」的消息传开后，${f.u ? '街上的人明显少了，药店门口排起了队' : '村里的卫生员挨家挨户地上门宣传'}。你勤洗手、少出门，心里一直绷着一根弦。` : '一场传染病在当地蔓延开来。你勤洗手、少出门，心里一直绷着一根弦。'), -1, 'crisis', [-1, -2, 1, 0, 0], { cd: 2, world: true, prep: outbreakP, set: hookSet });
E('w_fin_crisis', (f) => f.in(20, 85) && f.finCrisis && !f.unemployed && 1.5, (f) => {
  const lead = freshEv(f, /./, ['economy']) ? '「{event}」的消息铺天盖地。' : f.flags['ev:w_fin_crisis'] ? '经济又一次掉头向下。' : '经济不景气的消息铺天盖地。';
  const again = !!f.flags['ev:w_fin_crisis'];
  const life = f.retired ? (again ? '你的养老钱经历过上一次风浪，这一回你没有慌，只是把每月的开销又细细排了一遍。' : '你盯着养老金和存款算了又算，把出门旅行的计划往后推了推。')
    : f.selfEmp || f.business ? (again ? '店里的客人又少了。有过上一次的经验，你提前压了库存、跟房东谈了缓交租金。' : '店里的客人一天比一天少，你每天关门后都要把账本翻上好几遍。')
      : f.homeowner && f.flags.mortgage ? '你最担心的是每个月的房贷。你把能省的开支都省了下来，生怕下一个坏消息落到自己头上。'
        : again ? '这样的年景你经历过，你学会了先稳住饭碗、再看机会，没有像上一次那样整夜睡不着。' : '你开始记账、少下馆子，把能省的开支都省了下来，生怕下一个坏消息落到自己头上。';
  return lead + life;
}, -1, 'crisis', [0, -3, 1, 0, 0], { cd: 2, world: true, prep: evP(/./, ['economy']), set: hookSet });
E('w_quake', (f) => f.in(16, 110) && f.quake && 3, '地震发生时，屋里的东西哗啦啦往下掉。你冲到空地上，和邻居们一起在露天里熬过了余震不断的那一夜。', -2, 'crisis', [-2, -4, 0, 3, -2], { cd: 3, world: true, hz: { mult: 1.05, years: 1, reason: '地震' } });
E('w_storm', (f) => f.in(15, 110) && f.storm && 3, '{storm}登陆前，你和家人加固了门窗，囤好了水和干粮。狂风吹了一整夜，第二天推开门，满街都是断枝。', -1, 'crisis', [-1, -3, 0, 2, -1], { cd: 2, world: true });
E('w_flood', (f) => f.in(18, 59) && f.flood && 3, '暴雨下了几天几夜，水漫进了街道和屋子。你把家里的东西搬到高处，在齐膝深的水里帮邻居转移老人。', -2, 'crisis', [-2, -4, 0, 3, -2], { cd: 2, world: true });
E('w_drought', (f) => f.in(16, 110) && f.drought && !f.farmer && 2, '旱灾让水价和粮价一路上涨。你家开始限时用水，洗菜的水留着冲厕所。', -1, 'crisis', [-1, -2, 0, 0, -1], { cd: 2, world: true });
E('w_heat', (f) => f.in(16, 64) && f.heat && !f.farmer && 2, (f) => (f.flags['ev:w_heat'] && f.proj ? (f.u ? `又一个破纪录的夏天。${f.working ? '单位把上班时间提前到了清晨' : '城里把集市和公交的时间都挪到了清晨'}，午后的街道空空荡荡，只有洒水车慢慢开过。` : '又一个破纪录的夏天。午后谁也不敢出门，傍晚太阳落山后，整条街的人才搬着凳子出来乘凉。') : f.hic || f.umc ? '热浪持续了好几个星期，空调昼夜不停地转，电网几次告急。夜里你热得睡不着，就把凉席铺在地板上。' : '热浪持续了好几个星期，屋里像蒸笼一样。夜里你热得睡不着，和邻居们一起把席子铺到屋顶上。'), -1, 'crisis', [-2, -2, 0, 1, -0.3], { cd: 3, world: true, hz: { mult: 1.03, years: 1, reason: '高温' } });
E('w_refugee_neighbors', (f) => f.in(16, 95) && f.refugees && !f.war, '几户逃离战乱的家庭搬进了你们社区。你送去了一些旧衣服和锅碗，那家的母亲反复向你道谢。', 1, 'calm', [0, 1, 0, 3, -0.3], { once: true, world: true });
E('w_war_far', (f) => f.in(18, 95) && f.warFar && 0.8, '「{event}」的新闻每天都在滚动播出。远方的战事让油价和粮价都涨了一截，你看着那些画面，久久说不出话。', -1, 'calm', [0, -2, 1, 0, -0.3], { cd: 3, world: true, soft: true, prep: armedP(false), set: hookSet });
E('w_war_mild', (f) => f.in(16, 95) && f.warMild && 0.8, '「{event}」的消息占满了新闻。你盯着屏幕上的地图看了很久，心里一阵发紧，好在日子还是照常过。', -1, 'calm', [0, -1, 1, 0, 0], { cd: 3, world: true, soft: true, prep: armedP(true), set: hookSet });
// a war next door, or one fought in another part of the own country (news, mobilisation, people fleeing from there)
E('w_war_near', (f) => f.in(16, 95) && f.warNear && (f.warElsewhere ? 0.9 : 1.5), (f) => (f.warElsewhere
  ? (f.consc && f.m && f.in(18, 50) ? '国内另一头的战事还没有停。征兵的告示贴到了街口，你身边有人收到了入伍通知，你每天都会下意识地看一眼新闻。' : '战事发生在国内的另一头，离你住的地方很远。可物价还是涨了，从那边逃出来的人投奔到附近的亲戚家，你和邻居们把旧衣服、被褥收拾出来送了过去。')
  : f.consc && f.m && f.in(18, 50) ? '战事就在不远处。征兵的消息一天比一天多，街上穿军装的人多了，你每天都会下意识地看一眼新闻。' : '战事就在不远处。物价涨了，逃难的人一批批经过这里，你和邻居们把旧衣服、被褥收拾出来送去了接待站。'), -1, 'crisis', [-1, -3, 1, 2, -0.5], { cd: 2, world: true });
E('w_war_home', (f) => f.in(18, 64) && f.war && 2.5, (f) => `战争改变了一切：${f.hasKids ? '你每天最担心的是孩子们的安全，' : ''}停电成了常态，你学会了听声音判断远近，学会了在地下室里过夜。`, -2, 'war', [-3, -6, 0, 2, -2], { cd: 2, world: true, hz: { mult: 1.15, years: 1, reason: '战乱' } });
E('w_war_endure', (f) => f.in(18, 95) && f.war && 2, ['战事拖进了又一年。你学会了在排队领水的间隙和邻居交换消息，也学会了不去想太远的以后。', '炮声远了又近，近了又远。这一年，你把能做的都做了：照顾家人，帮邻居修窗户，在停电的夜里听收音机。'], -2, 'war', [-2, -4, 0, 3, -1], { cd: 2, world: true });
E('w_retrain', (f) => f.in(20, 62) && f.unemployed && f.automation && 2, '政府开设了再就业培训班。你和一群同样被机器替代的人坐在教室里，从头学起一门新手艺。', 0, 'study', [0, -1, 4, 2, 0], { once: true, world: true });
E('w_ubi', (f) => f.ubi && f.in(18, 115) && 1.5, '每月的基本收入准时到账了。钱不算多，却让很多人有了喘口气、重新选择的余地——包括你。', 1, 'calm', [0, 3, 0, 0, 1], { once: true, world: true });
E('w_space', (f) => f.in(8, 115) && !!freshEv(f, /月球|火星|太空|登月|空间站|航天|探月|moon|mars|space/i) && 1.2, '屏幕上直播着「{event}」的消息。你抬头望向夜空，想起小时候对星星问过的那些问题。', 1, 'calm', [0, 2, 1, 0, 0], { cd: 5, world: true, soft: true, prep: evP(/月球|火星|太空|登月|空间站|航天|探月|moon|mars|space/i), set: hookSet });
E('w_sport', (f) => f.in(6, 110) && !!freshEv(f, /奥运|世界杯|亚运|olympic|world cup/i) && 1, '「{event}」期间，街头巷尾都在讨论比赛。决赛那晚，你和朋友们挤在一起看直播，喊哑了嗓子。', 1, 'calm', [0, 3, 0, 2, 0], { cd: 4, world: true, soft: true, prep: evP(/奥运|世界杯|亚运|olympic|world cup/i), set: hookSet });
E('w_tech_news', (f) => f.in(12, 100) && !!freshEv(f, /./, ['technology', 'science']) && 0.8, '「{event}」成了这一年街头巷尾的话题。你一边看着新闻，一边琢磨它会怎样改变自己的日子。', 0, 'calm', [0, 1, 2, 0, 0], { cd: 3, world: true, soft: true, prep: evP(/./, ['technology', 'science']), set: hookSet });
E('w_blackout', (f) => f.in(10, 110) && !!freshEv(f, /网络攻击|太阳风暴|停电|电网|cyber|blackout|solar storm/i) && 2, (f) => (f.u ? '一场大规模停电让城市瘫痪了好几天：手机没有信号，付款用不了，超市门口排起了长队。你翻出了压箱底的手电筒和现金。' : '一场大停电持续了好几天，镇上的手机信号和付款都断了。你点起蜡烛，把冰箱里的东西先分给了邻居。'), -1, 'crisis', [-1, -3, 1, 2, -0.3], { cd: 3, world: true, prep: evP(/网络攻击|太阳风暴|停电|电网|cyber|blackout|solar storm/i), set: hookSet });
E('w_climate_migrants', (f) => f.in(18, 100) && f.proj && f.climateBad && f.year >= 2040 && (f.hic || f.umc) && 0.6, '越来越多因气候灾害背井离乡的人来到了你所在的城市。有人担忧，有人帮忙，你在社区的接待处做过几次翻译。', 0, 'calm', [0, -1, 1, 2, 0], { once: true, world: true });

/* Technology eras */

E('t_first_mobile', (f) => f.in(16, 70) && f.year <= 2012 && f.phone && !f.smart && !f.flags['ev:tn_first_phone_teen'] && !f.flags['ev:ch_first_phone'], '你买了人生第一部手机，小小的黑白屏，按键一按就“嘀”一声。一条短信要斟酌半天才舍得发出去。', 1, 'calm', [0, 3, 1, 2, -0.5], { once: true });
E('t_first_smartphone', (f) => f.in(16, 80) && f.smart && f.year <= 2018 && !f.flags['ev:ch_first_phone'], '你换上了第一部智能手机。地图、相机、聊天全装进了一块屏幕里，你在被窝里刷到半夜。', 1, 'calm', [-1, 3, 2, 1, -0.5], { once: true });
E('t_social_join', (f) => f.in(18, 70) && f.social && f.year <= 2018 && !f.flags['ev:tn_social_media'], '你注册了社交网络账号，没几天就找回了好几个失联多年的老同学。', 1, 'calm', [0, 2, 0, 3, 0], { once: true });
E('t_mobile_pay', (f) => f.in(18, 85) && f.mobilePay && f.year <= 2025 && !f.flags['ev:ch_mobile_pay_cn'], '你第一次用手机付款，“滴”的一声就买好了东西。没过几年，你连钱包放在哪儿都忘了。', 0, 'calm', [0, 1, 1, 0, 0], { once: true });
E('t_ecommerce', (f) => f.in(18, 75) && f.ecommerce && f.year <= 2016, '你第一次在网上买东西，等快递的那几天天天刷物流。收到包裹时，你像拆礼物一样小心。', 1, 'calm', [0, 2, 1, 0, -0.2], { once: true });
E('t_ride_hailing', (f) => f.in(18, 80) && f.u && f.year >= 2014 && f.internet >= 50 && f.smart, '你第一次用手机叫车，看着地图上的小车一点点开到楼下，觉得未来好像真的来了。', 0, 'calm', [0, 1, 1, 0, 0], { once: true, w: 0.5 });
E('t_ev', (f) => f.in(22, 80) && f.ev && f.working && f.incomePct >= 0.5 && !f.flags['ev:y_first_car'], '你买了一辆电动汽车。第一次在安静得出奇的车厢里起步时，你还以为它没发动。', 1, 'calm', [0, 2, 1, 0, -3], { once: true });
E('t_genai_first', (f) => f.in(14, 90) && f.genAI && f.year <= 2027, '你第一次和生成式 AI 对话，问了它一个憋了很久的问题。它答得头头是道，你却忍不住又追问：“你确定吗？”', 0, 'calm', [0, 1, 2, 0, 0], { once: true });
E('t_self_driving', (f) => f.in(16, 100) && f.selfDriving, '你第一次坐上了没有司机的出租车。方向盘自己在转，你一路都没敢松开扶手。', 0, 'calm', [0, 1, 1, 0, 0], { once: true });
E('t_robot_delivery', (f) => f.in(10, 100) && f.robots && f.u, '小区里的快递开始由机器人送上门。它在楼下等电梯的样子，让你忍不住笑出了声。', 0, 'calm', [0, 1, 0, 0, 0], { once: true });
E('t_bci', (f) => f.in(30, 85) && f.bci && 0.3, '你参加了一项脑机接口的康复试验，用意念移动了屏幕上的光标。那一刻，你既兴奋，又有点说不出的不安。', 0, 'calm', [0, 1, 2, 0, 0], { once: true });
E('t_vr_meeting', (f) => f.in(20, 70) && f.vr && f.working, '公司的例会改在虚拟空间里开。你的虚拟形象坐在会议桌旁，真实的你却穿着拖鞋窝在沙发里。', 0, 'work', [0, 1, 1, 0, 0], { once: true });
E('t_space_tour', (f) => f.in(25, 85) && f.spaceTour && (f.famRich || f.wealth >= 80) && f.health >= 60 && 0.5, '你花了一大笔钱，乘坐亚轨道飞船上了一趟太空。失重的那几分钟里，你看着蓝色的地球边缘，忽然觉得很多烦恼都不值一提。', 2, 'success', [0, 6, 2, 0, -8], { once: true });
E('t_smart_glasses', (f) => f.in(18, 75) && f.year >= 2032 && f.internet >= 70 && 0.5, '你戴上了智能眼镜，和外国游客聊天时，对方的话会实时翻译成字幕浮在眼前。', 0, 'calm', [0, 1, 2, 1, -0.5], { once: true });
E('t_mars', (f) => f.in(10, 110) && f.mars && f.spaceL === 'high' && f.year >= 2050 && !freshEv(f, /火星|mars/i) && 0.8, '新闻直播里，人类在火星上的第一座小型基地开始运转。你看着那片红色的荒原，想起了小时候读过的科幻小说。', 1, 'calm', [0, 3, 1, 0, 0], { once: true, world: true, soft: true });
E('t_ai_doctor', (f) => f.in(16, 110) && f.aiDoctor && 0.6, '你第一次让 AI 医生做了问诊。它问得比你想象的仔细，最后还提醒你：“请务必去医院做进一步检查。”', 0, 'calm', [1, 0, 1, 0, 0], { once: true });

/* Regional life and seasons */

E('r_festival_adult', (f) => f.in(18, 110), (f) => (f.migrant ? ['{homefest}到了。你在异乡找到几个同乡，凑在一起做了一桌家乡菜，聊到深夜。', '{homefest}到了。你给远在{origin}的家人打了很长的电话，挂断后一个人做了一碗{homefood}。']
  : f.age >= 65 ? [f.hasKids ? '{festival}到了，孩子们拖家带口地回来，屋里一下子挤满了人。你在厨房里忙个不停，心里却乐开了花。' : '{festival}到了，老邻居们互相串门，你把攒了好久的好茶拿出来招待大家。', '{festival}到了。热闹散去以后，你一个人收拾碗筷，想起了很多年前过节的样子。']
    : f.hasKids && f.kids.some((k) => k.age <= 12) ? ['{festival}到了，你带着孩子们去走亲戚，看着他们和你小时候一样满屋子乱跑。', '{festival}到了，你学着长辈当年的样子，给孩子们讲这个节日的来历。他们听得半懂不懂，只惦记着好吃的。']
      : ['{festival}到了，一家人难得聚齐。屋里吵吵嚷嚷，你却觉得这样的热闹，一年里只嫌太少。', f.working ? '{festival}到了，可你因为工作没能回家。你在电话里听着家里的热闹，嘴上说着“明年一定回”。' : '{festival}到了，你和老朋友们约在一起吃了顿饭，聊起各自的这一年。']), 1, 'family', [0, 3, 0, 3, -0.3], { cd: 4, w: 0.8 });
E('r_typhoon_prep', (f) => f.in(16, 110) && f.typhoon && !f.storm && 0.5, '台风季又到了。你熟练地往窗户上贴好胶带，把阳台上的花盆搬进屋里，又囤了几箱矿泉水。', 0, 'calm', [0, -1, 0, 1, 0], { cd: 4 });
E('r_hurricane_prep', (f) => f.in(16, 110) && f.hurricane && !f.storm && 0.5, '飓风预警发布后，你加固了门窗，把车加满了油。好在这一次风暴在海上转了向。', 0, 'calm', [0, -1, 0, 1, -0.2], { cd: 4 });
E('r_dust_storm', (f) => f.in(5, 110) && f.dusty && 0.4, '一场沙尘暴遮天蔽日，白天也得开灯。你用湿毛巾堵住门缝，可第二天桌上还是落了一层黄沙。', -1, 'calm', [-1, -1, 0, 0, 0], { cd: 4 });
E('r_smog', (f) => f.in(5, 110) && f.smoggy && f.u && f.year >= 2008 && f.year <= 2020 && 0.6, '连着好几天雾霾，对面的楼都看不清了。你戴上口罩出门，回家后第一件事就是打开空气净化器。', -1, 'illness', [-2, -1, 0, 0, -0.2], { cd: 3 });
E('r_snowstorm', (f) => f.in(10, 110) && f.snow && 0.4, '一场暴雪封住了道路，城市一下子安静下来。你和邻居们一起铲雪，铲完后站在路边喘着白气相视而笑。', 0, 'calm', [0, 1, 0, 2, 0], { cd: 4 });
E('r_power_outage', (f) => f.in(10, 110) && (f.lic || f.lmc) && f.elec >= 40 && f.elec < 95 && 0.5, '又停电了，这一次停了整整两天。冰箱里的东西坏了一半，你在烛光下把剩下的菜吃完。', -1, 'calm', [0, -2, 0, 1, -0.2], { cd: 3 });
E('r_water_queue', (f) => f.in(10, 110) && f.water < 70 && 0.6, (f) => (f.r ? '村里的水井又干了。你天不亮就提着水桶去几里外的水站排队，回来时肩膀被勒出了红印。' : '街区的自来水又停了好几天。你天不亮就提着水桶去几条街外的供水点排队，回来时肩膀被勒出了红印。'), -1, 'calm', [-2, -2, 0, 1, 0], { cd: 3 });
E('r_malaria_adult', (f) => f.in(16, 90) && f.ssa && f.poorC && 0.5, '雨季一来，你又打起了摆子，浑身发冷发热。诊所的快速检测确认是疟疾，吃了几天药才缓过来。', -1, 'illness', [-4, -2, 0, 0, -0.3], { cd: 3, hz: { mult: 1.1, years: 1, reason: '疟疾' } });
E('r_dengue_adult', (f) => f.in(16, 90) && (f.sea || f.lac || f.sas) && f.u && 0.3, '你得了登革热，高烧、骨头疼了一个多星期。病好后，你把家里所有能积水的瓶瓶罐罐都清理了一遍。', -1, 'illness', [-4, -2, 0, 0, -0.3], { cd: 5, hz: { mult: 1.05, years: 1, reason: '登革热' } });
E('r_cholera', (f) => f.in(5, 110) && f.water < 60 && (f.flood || f.war) && 2, (f) => `${f.flood ? '洪水退去后' : '战乱中供水中断'}，霍乱在附近蔓延开来。你只喝烧开的水，看着救援人员在${f.r ? '村口' : '街口'}发放净水片。`, -2, 'illness', [-3, -3, 1, 1, 0], { cd: 3, world: true, hz: { mult: 1.15, years: 1, reason: '霍乱流行' } });
E('r_hukou', (f) => f.chn && f.u && f.ruralOrigin && f.in(20, 60) && f.working && f.year <= 2024 && 0.6, '没有本地户口，你在社保、看病、孩子上学上处处要多跑几趟手续。你把那摞证明材料装进一个专门的文件袋，随时备着。', -1, 'work', [0, -2, 1, 0, 0], { once: true });
E('r_spring_planting', (f) => f.farmer && f.in(14, 85) && 0.6, '春耕时节，你天一亮就下地，翻土、播种、引水。傍晚收工时，地里一行行新苗整整齐齐。', 0, 'work', [0, 1, 0, 0, 0], { cd: 3 });
E('r_pastoral', (f) => f.farmer && (f.ssa || f.cas || f.iso === 'MNG' || f.was) && f.r && 0.4, '你赶着羊群去更远的草场。夜里在星空下守着篝火，听着远处的狗叫，心里格外安静。', 0, 'work', [1, 1, 0, 0, 0], { cd: 4 });
E('r_nowruz', (f) => f.in(5, 110) && ['IRN', 'AFG', 'TJK', 'AZE', 'UZB', 'KGZ', 'TKM', 'KAZ'].includes(f.iso) && 0.5, (f) => (['IRN', 'AFG', 'TJK', 'AZE'].includes(f.iso) ? '诺鲁孜节到了，家里摆上了象征新年的七样东西。你换上新衣，挨家挨户去拜访亲友。' : '诺鲁孜节到了，邻居们支起大锅，轮流守着熬了一整夜的麦芽甜粥。你换上新衣，挨家挨户去拜访亲友。'), 1, 'family', [0, 3, 0, 3, 0], { cd: 4 });
E('r_carnival', (f) => f.in(10, 90) && ['BRA', 'TTO'].includes(f.iso) && 0.5, '狂欢节的鼓点从早响到晚，你跟着桑巴的队伍走了好几条街，脚都跳麻了。', 1, 'calm', [1, 4, 0, 3, -0.3], { cd: 4 });
E('r_day_of_dead', (f) => f.in(5, 110) && f.iso === 'MEX' && 0.5, '亡灵节那天，你在家里的祭坛上摆了万寿菊和亲人的照片。烛光里，你觉得离开的人好像从没走远。', 0, 'family', [0, 2, 0, 3, 0], { cd: 4 });
E('r_diwali', (f) => f.in(5, 110) && ['IND', 'NPL'].includes(f.iso) && 0.5, '排灯节的夜晚，家家户户的窗台上都点起了小油灯，孩子们在街上放烟花，空气里满是甜食的香气。', 1, 'family', [0, 3, 0, 3, -0.3], { cd: 4 });
E('r_eid', (f) => f.in(5, 110) && f.muslim && 0.5, (f) => (f.age < 16 ? '开斋节的早上，你穿上新衣服去礼拜，然后挨家挨户地拜访亲友，口袋里塞满了别人给的糖果。' : f.age >= 60 ? '开斋节的早上，晚辈们一个个来给你拜节。你把准备好的节日钱和点心分给孩子们，看着满屋子的人，心里很满足。' : '开斋节的早上，你穿上新衣服去礼拜，然后带着点心挨家挨户地拜访亲友，又给孩子们发了节日的零花钱。'), 1, 'family', [0, 3, 0, 3, -0.2], { cd: 4 });

/* Quiet years (fill gaps) */

/** the shape of an ordinary day, by what the person does for a living */
function dailyRound(f) {
  const tail = '回想起来，竟记不起什么特别的事——也许这就是好日子。';
  if (f.retired) return `这一年过得平平淡淡：散步、买菜、做饭、午睡。${tail}`;
  if (f.inSchool || f.student) return `这一年过得平平淡淡：上课、自习、食堂、宿舍。${tail}`;
  if (f.farmer) return `这一年过得平平淡淡：春种、夏管、秋收、冬藏。${tail}`;
  if (f.military) return `这一年过得平平淡淡：出操、训练、站岗、熄灯。${tail}`;
  if (f.employed) return `这一年过得平平淡淡：上班、回家、做饭、睡觉。${tail}`;
  if (f.selfEmp) return `这一年过得平平淡淡：一早开张，招呼客人，晚上关门算账。${tail}`;
  if (f.homemaker) return `这一年过得平平淡淡：买菜、做饭、收拾屋子、照顾一家老小。${tail}`;
  if (f.unemployed) return '这一年没什么大事：四处打听活计，等消息，在家里帮帮忙。日子过得紧巴巴的，好在也没出什么岔子。';
  if (f.status === 'unable') return '这一年过得平平淡淡：吃药、休息、在窗边坐一坐。身体没有更好，也没有更坏——这已经算是好消息了。';
  return `这一年过得平平淡淡，日子一天接着一天。${tail}`;
}
E('g_quiet_year', (f) => f.in(18, 110), (f) => {
  const young = f.kids.filter((k) => k.age <= 17).length;
  return [
    dailyRound(f),
    '这一年没有什么大事。你在小事里过日子：一顿好饭，一场好觉，一个晴天。',
    young ? `这一年没什么大起大落。孩子${young > 1 ? '们' : ''}又长高了一截，你又多了几根白发，日子就这样不紧不慢地往前走。` : '这一年没什么大起大落。你把房间重新收拾了一遍，扔掉了一些旧东西，也留下了一些舍不得的。',
  ];
}, 0, 'calm', [0, 1, 0, 0, 0], { cd: 4, w: 0.6 });
E('g_neighbor', (f) => f.in(20, 110) && 0.5, (f) => (!f.flags['ev:g_neighbor'] ? `${f.u ? '楼下' : '隔壁'}的邻居送来一碗自家做的菜，你回赠了一袋水果。一来二去，你们成了能互相托付钥匙的交情。`
  : ['邻居家的孩子考上了学校，你准备了一份小礼物送过去，那家人非要留你吃饭。', '你出门那几天，邻居帮你收了快递、浇了花。回来时，门口还放着一袋刚摘的菜。', '新搬来的一户邻居还不熟悉这里，你带着他们认了认菜市场和诊所。'][(f.year + f.age) % 3]), 1, 'calm', [0, 2, 0, 3, 0], { cd: 8 });
E('g_good_book', (f) => f.in(16, 100) && f.eduRank >= 2 && 0.5, '你读到一本好书，合上最后一页时，窗外天已经亮了。你把其中一句话抄在了本子上。', 1, 'calm', [0, 2, 3, 0, 0], { cd: 6 });
E('g_rain_walk', (f) => f.in(16, 100) && 0.4, '一个下雨的傍晚，你没带伞，干脆慢慢走回了家。湿透了，心里却莫名地轻快。', 0, 'calm', [0, 2, 0, 0, 0], { cd: 8 });
E('g_cook_skill', (f) => f.in(25, 90) && 0.4, '你终于做出了和记忆里一模一样的{homefood}。家人吃完说了句“就是这个味儿”，你高兴了好几天。', 1, 'calm', [0, 3, 1, 2, 0], { once: true });
E('g_stranger_help', (f) => f.in(16, 100) && 0.4, '你在路上帮一位迷路的老人找到了家，老人拉着你的手说了好多遍谢谢。那一天，你走路都带着风。', 1, 'calm', [0, 2, 0, 1, 0], { cd: 10 });
E('g_old_friend_call', (f) => f.in(30, 110) && 0.4, (f) => `一个多年没联系的老朋友突然${f.smart ? '发来消息' : '打来电话'}，你们聊了两个小时，好像从来没有分开过。`, 1, 'calm', [0, 3, 0, 3, 0], { cd: 8 });
E('g_sick_week', (f) => f.in(16, 90) && 0.4, '你得了一场重感冒，在床上躺了一个星期。病好后第一次出门，觉得阳光格外好。', -1, 'illness', [-2, -1, 0, 0, 0], { cd: 5 });
E('g_learn_cook', (f) => f.in(18, 60) && !f.flags['ev:y_cooking'] && 0.3, '你认真学会了做饭。第一次做出一整桌菜时，你给自己拍了张照。', 1, 'calm', [0, 2, 1, 1, 0], { once: true });
E('g_sunrise', (f) => f.in(16, 95) && 0.3, '你起了个大早去看日出。天边一点点亮起来的时候，你想起了很多人，也想通了一些事。', 1, 'calm', [1, 3, 0, 0, 0], { cd: 10 });

/* ================================================================== LIBRARY COMPILER ========================== */

const TAGSET = new Set(YEAR_TAGS);
const FX_KEYS = ['health', 'happiness', 'knowledge', 'relationships'];
const DEFAULT_CD = 3;

// Mutually exclusive clusters: at most one template of a group fires in the same year (no double floods, no three
// diagnoses at once, one piece of soft news).
const GROUPS = {
  cropyear: 'a_harvest_good a_harvest_bad a_monsoon_crop a_drought_farm a_locust a_livestock',
  flood: 'inf_flood ch_flood_school tn_flood w_flood s_flood a_monsoon_crop r_cholera',
  storm: 'ch_typhoon ch_hurricane w_storm r_typhoon_prep r_hurricane_prep s_flood',
  heat: 'inf_heat ch_heat_school tn_heat_exam y_heat_work w_heat s_heat',
  war: 'inf_war ch_war_school ch_war_flee tn_war_shelter a_war_job a_war_flee w_war_home w_war_endure s_war y_war_fear w_war_near',
  quake: 'inf_quake ch_quake w_quake',
  pandemic: 'inf_pandemic ch_online_class ch_no_internet_lockdown tn_covid_youth w_lockdown s_pandemic y_lockdown_alone y_covid_grad m_lockdown_family y_wfh',
  layoff: 'a_layoff a_auto_layoff m_ai_replace a_business_bad y_job_found a_reemployed',
  elders: 'ch_grandparent_death tn_grandparent_ill y_grandparent_death',
  parents: 'y_parent_ill m_parent_hospital m_parent_dementia m_parent_care',
  diagnosis: 'm_cancer m_heart_scare s_stroke s_stent m_diabetes m_bp s_dementia s_knee a_depression m_long_covid',
  festival: 'ch_festival r_festival_adult r_diwali r_eid r_nowruz ch_moon_night r_day_of_dead r_carnival a_homesick',
  money: 'a_inflation a_hyperinflation w_fin_crisis m_invest_loss',
  news: 'w_hook_history w_hook_future w_tech_news w_space w_sport t_mars w_war_far w_war_mild',
  firstphone: 'ch_first_phone tn_first_phone_teen t_first_mobile t_first_smartphone',
  displaced: 'a_displaced_camp a_displaced_papers a_displaced_return ch_tent_school ch_new_school_displaced',
  homemaker: 'a_homemaker_day a_homemaker_skill a_homemaker_return',
  illness_life: 'm_diabetes_life m_bp_routine a_depression_day m_depression_better s_stroke_rehab s_dementia_family',
  // a new courtship and grief for a late spouse never share a year
  courtship: 'y_meet y_dating_app m_late_love s_late_companion s_widow_grief',
};
const GROUP_OF = new Map();
for (const [g, ids] of Object.entries(GROUPS)) for (const id of ids.split(' ')) GROUP_OF.set(id, [...(GROUP_OF.get(id) || []), g]);

function compileTemplate(raw) {
  const o = raw.opt || {};
  const tags = String(raw.tags || '').split(/\s+/).filter(Boolean);
  if (o.world && !tags.includes('world')) tags.push('world');
  const fx = Array.isArray(raw.fx) ? raw.fx : [];
  const effects = {};
  FX_KEYS.forEach((k, i) => { effects[k] = Math.round(clampN(num(fx[i], 0), -15, 15)); });
  const cond = raw.cond;
  return {
    id: raw.id,
    when: (state, ctx, data, world) => {
      const v = cond(lifeFacts(data, world, state, ctx));
      return v === true ? true : typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : false;
    },
    cond,
    weight: num(o.w, 1),
    text: typeof raw.text === 'function' ? null : raw.text,
    textFn: typeof raw.text === 'function' ? raw.text : null,
    tone: clampN(Math.round(num(raw.tone, 0)), -2, 2),
    tags,
    tag: TAGSET.has(tags[0]) ? tags[0] : undefined,
    effects,
    wealthMonths: num(fx[4], 0),
    set: o.set || undefined,
    hazard: o.hz || undefined,
    once: !!o.once,
    // world-linked templates repeat at most every 5 years: one flood or market crash should not become a yearly ritual
    cooldown: o.once ? undefined : Math.max(o.world ? 5 : 1, num(o.cd, DEFAULT_CD)),
    world: !!o.world,
    soft: !!o.soft,
    groups: GROUP_OF.get(raw.id) || [],
    prep: typeof o.prep === 'function' ? o.prep : null,
    dyn: typeof o.dyn === 'function' ? o.dyn : null,
  };
}

/** All personal-event templates (CONTRACT §7). Order is stable; ids are unique. */
export const EVENT_LIBRARY = RAW.map(compileTemplate);
const EVENT_BY_ID = new Map(EVENT_LIBRARY.map((t) => [t.id, t]));
export function eventTemplate(id) { return EVENT_BY_ID.get(id); }

/* ================================================================== PICKER ==================================== */

const clone = (x) => (x == null || typeof x !== 'object' ? x : JSON.parse(JSON.stringify(x)));
const SET_KEYS = ['education', 'career', 'relationship', 'country', 'urban'];
const COUNT_P = {
  infant: [0.38, 0.44, 0.16, 0.02], child: [0.18, 0.44, 0.3, 0.08], teen: [0.16, 0.42, 0.32, 0.1],
  youth: [0.16, 0.42, 0.32, 0.1], adult: [0.18, 0.42, 0.3, 0.1], midlife: [0.2, 0.44, 0.28, 0.08],
  senior: [0.22, 0.46, 0.25, 0.07], elder: [0.3, 0.46, 0.2, 0.04],
};

/** Weight of a template for this life-year, or 0 if it cannot fire (once/cooldown/condition). */
function eligibleWeight(t, f, flags) {
  const last = flags['ev:' + t.id];
  if (last != null && last !== false) {
    if (t.once) return 0;
    const ly = num(last);
    if (ly != null && f.year - ly < t.cooldown) return 0;
  }
  let w;
  try { w = t.cond(f); } catch { return 0; }
  w = w === true ? 1 : typeof w === 'number' && Number.isFinite(w) ? w : 0;
  return w > 0 ? w * t.weight : 0;
}

/** Build one EventInstance from a template, or null if its text would contradict the life. */
function instantiate(t, f, state, ctx, rng) {
  let vars = {};
  if (t.prep) {
    try { vars = t.prep(f, rng) || {}; } catch { return null; }
  }
  let raw;
  try { raw = t.textFn ? t.textFn(f) : t.text; } catch { return null; }
  if (Array.isArray(raw)) raw = rng.pick(raw);
  if (typeof raw !== 'string' || !raw.trim()) return null;
  if (raw.includes('{hookline}') && !vars.hookline) return null;
  if (raw.includes('{event}') && !vars.event) return null;
  if (raw.includes('{partner}') && !f.hasPartner) return null;
  if (raw.includes('{child}') && !f.hasKids && !vars.child) return null;
  if (raw.includes('{newpartner}') && !vars.newpartner) return null;
  const pub = {};
  for (const [k, v] of Object.entries(vars)) if (k[0] !== '_') pub[k] = v;
  const text = fillText(raw, state, ctx, rng, pub, f);
  if (!text || /\{\w+\}|undefined|NaN/.test(text)) return null;

  let set;
  try { set = typeof t.set === 'function' ? t.set(f, pub) : clone(t.set); } catch { set = undefined; }
  if (set && typeof set === 'object' && !Object.keys(set).length) set = undefined;
  let tone = t.tone;
  let tag = t.tag;
  const effects = { ...t.effects };
  if (t.dyn) {
    try {
      const d = t.dyn(f, vars) || {};
      if (isNum(d.tone)) tone = clampN(Math.round(d.tone), -2, 2);
      if (d.tag && TAGSET.has(d.tag)) tag = d.tag;
      if (Array.isArray(d.fx)) FX_KEYS.forEach((k, i) => { if (isNum(d.fx[i])) effects[k] = Math.round(clampN(d.fx[i], -15, 15)); });
    } catch { /* keep static values */ }
  }
  const tags = t.tags.slice();
  if (tag && tags[0] !== tag) tags.unshift(tag);
  // wealth: months of the person's own (or household) income; minors' events never move their own money
  if (t.wealthMonths && f.age >= 16) {
    const wd = Math.round(t.wealthMonths * f.monthRef);
    if (wd) effects.wealthDelta = wd;
  }
  const inst = { id: t.id, text, tone, tags, tag, effects };
  if (set) inst.set = set;
  if (t.hazard) inst.hazard = { mult: clampN(num(t.hazard.mult, 1), 0.5, 2), years: clampN(Math.round(num(t.hazard.years, 1)), 1, 30), reason: String(t.hazard.reason || '') };
  return inst;
}

/**
 * Bookkeeping for the timing of the life's own relationships, in flags: 'rel:with' (partner of the current union,
 * false once it ended), 'rel:union' (year the union began), 'rel:wed' (year of the wedding), 'rel:widow' (year the
 * spouse died). partner.sinceYear is the year a couple met, so these are noted the first year they are seen: the
 * engine runs its family step before the events, so for a life followed year by year that is the year it happened.
 * A union already there when tracking starts (an older save, a life built by hand) is dated from the year the couple
 * met or the first union, whichever is later.
 */
function trackUnion(state) {
  const p = state.person;
  const fl = p.flags;
  const y = num(state.year);
  if (y == null) return;
  const rel = p.relationship && typeof p.relationship === 'object' ? p.relationship : {};
  const st = rel.status;
  const partner = rel.partner && typeof rel.partner === 'object' ? rel.partner : null;
  const nm = partner && typeof partner.name === 'string' && partner.name ? partner.name : null;
  const was = fl['rel:with'];
  if ((st === 'married' || st === 'partnered') && nm) {
    if (was !== nm) {
      const start = was === undefined ? Math.min(y, Math.max(num(partner.sinceYear, y), num(fl.firstUnion, -9999))) : y;
      fl['rel:with'] = nm;
      fl['rel:union'] = start;
      if (st === 'married') fl['rel:wed'] = start;
      else delete fl['rel:wed'];
    } else if (st === 'married' && num(fl['rel:wed']) == null) fl['rel:wed'] = y;
    return;
  }
  // the tracked spouse died this year; a widowhood seen for the first time counts from now
  if (st === 'widowed' && ((typeof was === 'string' && was) || num(fl['rel:widow']) == null)) fl['rel:widow'] = y;
  if (typeof was === 'string') {
    fl['rel:with'] = false;
    delete fl['rel:union'];
    delete fl['rel:wed'];
  }
}

function setKeysOf(inst) {
  if (!inst.set) return [];
  return SET_KEYS.filter((k) => inst.set[k] !== undefined);
}

/**
 * 0-3 personal events for the current life-year (CONTRACT §4, §7).
 * Marks each picked template in state.person.flags['ev:'+id] = year so once/cooldown hold across years and saves.
 * Never throws; returns [] for a dead or malformed state.
 */
export function pickPersonalEvents(data, world, state, ctx, rng) {
  if (!state || typeof state !== 'object' || state.dead || !state.person || typeof state.person !== 'object') return [];
  const R = rng && typeof rng.next === 'function' ? rng : new Rng(hashString(`${state.id || state.seed || 'life'}:${state.year}:events`));
  if (!state.person.flags || typeof state.person.flags !== 'object') state.person.flags = {};
  try { trackUnion(state); } catch { /* bookkeeping only */ }
  let f;
  try { f = lifeFacts(data, world, state, ctx); } catch { return []; }
  const flags = state.person.flags;

  const pool = [];
  for (const t of EVENT_LIBRARY) {
    const w = eligibleWeight(t, f, flags);
    if (w > 0) pool.push({ t, w });
  }
  if (!pool.length) return [];
  const worldPool = pool.filter((c) => c.t.world);
  const probs = COUNT_P[f.stage] || COUNT_P.adult;
  let n = R.weighted([0, 1, 2, 3], probs) ?? 1;
  if (n === 0 && worldPool.some((c) => !c.t.soft && c.w >= 1.5)) n = 1;
  n = Math.min(n, pool.length, 3);

  const out = [];
  const used = new Set();
  const usedKeys = new Set();
  const usedGroups = new Set();
  const take = (cands) => {
    let guard = 0;
    while (guard++ < 12) {
      const live = cands.filter((c) => !used.has(c.t.id) && !c.t.groups.some((g) => usedGroups.has(g)));
      if (!live.length) return false;
      const c = R.weighted(live, (x) => x.w);
      if (!c) return false;
      used.add(c.t.id);
      const inst = instantiate(c.t, f, state, ctx, R);
      if (!inst) continue;
      const keys = setKeysOf(inst);
      if (keys.some((k) => usedKeys.has(k))) continue;
      c.t.groups.forEach((g) => usedGroups.add(g));
      keys.forEach((k) => usedKeys.add(k));
      out.push(inst);
      return true;
    }
    return false;
  };
  // serious world events (war, disasters, crises) usually make it into the year; soft news only sometimes
  // (seasonal fallbacks of world templates have small weights; only event-driven ones get priority)
  const hardWorld = worldPool.filter((c) => !c.t.soft && c.w >= 1.5 && !used.has(c.t.id));
  // real history is felt more often than abstract projected shocks
  if (hardWorld.length && R.chance(f.proj ? 0.5 : 0.8)) take(hardWorld);
  else if (worldPool.length && R.chance(f.proj ? 0.15 : 0.3)) take(worldPool);
  // at most one world-linked personal event per year; the rest of the year is the person's own life
  const ownPool = pool.filter((c) => !c.t.world);
  let tries = 0;
  while (out.length < n && tries++ < 6) if (!take(out.length ? ownPool : pool)) break;
  for (const e of out) {
    flags['ev:' + e.id] = f.year;
    // bookkeeping flags must hold even if the engine does not apply event `set`
    const sf = e.set && e.set.flags;
    if (sf) for (const [k, v] of Object.entries(sf)) if (k.startsWith('hook:') || k.startsWith('kidwed:')) flags[k] = v;
  }
  return out;
}
