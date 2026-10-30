// Birth: random and custom birth specs, names and background notes (CONTRACT §2, §3 BirthSpec, §9).
// Pure module: no DOM, no Math.random, no Date.now. All randomness comes from the Rng passed in.

import { FIRST_YEAR, HISTORY_END, DATA_DATE, REGIONS } from './constants.js';
import { Rng, hashString } from './rng.js';

export const LAST_BIRTH_YEAR = 2070;
export const YEAR_MODES = ['2000', 'history', 'now', 'future', 'any'];
export const PARENT_EDU = ['none', 'primary', 'secondary', 'tertiary'];
export const PARENT_EDU_LABELS = { none: '没有上过学', primary: '小学', secondary: '中学', tertiary: '大学及以上' };

/* ------------------------------------------------------------------ small helpers */

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clampN = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
function safe(fn, fb = null) {
  try {
    const v = fn();
    return v === undefined || v === null ? fb : v;
  } catch {
    return fb;
  }
}
function toNum(v) {
  if (isNum(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v)) return +v;
  return null;
}
const pad2 = (n) => String(n).padStart(2, '0');

function rngOf(rng, label) {
  if (rng && typeof rng.next === 'function') return rng;
  return new Rng(hashString(`birth:${label || ''}`));
}

/** Indicator from the world line when available (projections), else the raw data series. */
function ind(data, world, iso, key, year) {
  const w = safe(() => (world && typeof world.indicator === 'function' ? world.indicator(iso, key, year) : null));
  if (isNum(w)) return w;
  const d = safe(() => data.series(iso, key, year));
  return isNum(d) ? d : null;
}

function countryOf(data, iso) {
  return safe(() => data.country(iso)) || safe(() => data.countries[iso]) || null;
}

/* ------------------------------------------------------------------ dates */

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInYear = (y) => (isLeap(y) ? 366 : 365);
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 0-based day index within the year -> {month (1-12), day} */
export function dateFromDayIndex(year, idx) {
  let d = clampN(Math.floor(idx), 0, daysInYear(year) - 1);
  for (let m = 0; m < 12; m++) {
    const len = m === 1 && isLeap(year) ? 29 : MONTH_DAYS[m];
    if (d < len) return { month: m + 1, day: d + 1 };
    d -= len;
  }
  return { month: 12, day: 31 };
}
/** 0-based day index of month/day in year (Feb 29 in a common year maps to Feb 28). */
export function dayIndexOf(year, month, day) {
  let idx = 0;
  for (let m = 0; m < month - 1; m++) idx += m === 1 && isLeap(year) ? 29 : MONTH_DAYS[m];
  const len = month === 2 && isLeap(year) ? 29 : MONTH_DAYS[month - 1];
  return idx + clampN(day, 1, len) - 1;
}
export function formatDate(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}
/** 'YYYY-MM-DD' -> {year, month, day} or null */
export function parseDate(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const year = +m[1];
  const month = +m[2];
  const day = +m[3];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const len = month === 2 && isLeap(year) ? 29 : MONTH_DAYS[month - 1];
  if (day > len) return null;
  return { year, month, day };
}
function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = +m[1];
  const mi = +m[2];
  const se = m[3] != null ? +m[3] : 0;
  if (h > 23 || mi > 59 || se > 59) return null;
  return `${pad2(h)}:${pad2(mi)}:${pad2(se)}`;
}
function randomDate(year, rng, maxDate) {
  let n = daysInYear(year);
  const cap = parseDate(maxDate);
  if (cap && cap.year === year) n = dayIndexOf(year, cap.month, cap.day) + 1;
  const { month, day } = dateFromDayIndex(year, rng.int(0, Math.max(0, n - 1)));
  return formatDate(year, month, day);
}
function randomTime(rng) {
  return `${pad2(rng.int(0, 23))}:${pad2(rng.int(0, 59))}:${pad2(rng.int(0, 59))}`;
}

/* ------------------------------------------------------------------ years and countries */

function birthsTotal(data, year) {
  return num0(safe(() => data.birthsWeights(year).total));
}
function num0(v) {
  return isNum(v) ? v : 0;
}

/** Birth year for a year mode (CONTRACT §9). */
export function pickBirthYear(data, rng, mode = '2000') {
  const R = rngOf(rng, 'year');
  const range = (a, b) => {
    const ys = [];
    const ws = [];
    for (let y = a; y <= b; y++) {
      ys.push(y);
      ws.push(Math.max(1, birthsTotal(data, y)));
    }
    return R.weighted(ys, ws) ?? a;
  };
  switch (String(mode)) {
    case 'history': return range(FIRST_YEAR, HISTORY_END);
    case 'now': return HISTORY_END;
    case 'future': return range(HISTORY_END + 1, LAST_BIRTH_YEAR);
    case 'any': return range(FIRST_YEAR, LAST_BIRTH_YEAR);
    default: return FIRST_YEAR;
  }
}

/** Country of birth weighted by births that year. */
export function pickCountry(data, year, rng) {
  const R = rngOf(rng, 'country');
  const bw = safe(() => data.birthsWeights(year));
  if (bw && Array.isArray(bw.isos) && bw.isos.length) {
    const iso = R.weighted(bw.isos, bw.weights);
    if (iso) return iso;
  }
  const list = safe(() => data.isoList) || Object.keys(safe(() => data.countries) || {});
  return list.includes('CHN') ? 'CHN' : list[0] || 'CHN';
}

/** Sex at birth by the sex ratio at birth (males per 100 females). */
export function pickSex(data, iso, year, rng) {
  const srb = clampN(num0(safe(() => data.series(iso, 'srb', year))) || 105, 95, 125);
  return rngOf(rng, 'sex').chance(srb / (100 + srb)) ? 'male' : 'female';
}

/** 0..1 share of the population living in cities. */
export function urbanShare(data, world, iso, year) {
  const u = ind(data, world, iso, 'urban', year);
  return isNum(u) ? clampN(u / 100, 0.02, 1) : 0.55;
}

/**
 * A series value for an era that may precede the data (years before 2000 are extrapolated backwards from the
 * 2000–2010 trend, never above the 2000 value and never below a quarter of it).
 */
function eraValue(data, iso, key, year) {
  if (year >= FIRST_YEAR) return safe(() => data.series(iso, key, year));
  const v0 = safe(() => data.series(iso, key, FIRST_YEAR));
  if (!isNum(v0)) return null;
  const v10 = safe(() => data.series(iso, key, FIRST_YEAR + 10));
  const slope = isNum(v10) ? clampN((v10 - v0) / 10, 0, 2.2) : 0.6;
  const est = v0 - slope * (FIRST_YEAR - year) * 0.85;
  return clampN(est, v0 * 0.25, v0);
}

/* ------------------------------------------------------------------ normal helpers */

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function normInv(p) {
  const q = clampN(p, 1e-9, 1 - 1e-9);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (q < pl) {
    const r = Math.sqrt(-2 * Math.log(q));
    return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  if (q > 1 - pl) {
    const r = Math.sqrt(-2 * Math.log(1 - q));
    return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  const r = q - 0.5;
  const s = r * r;
  return ((((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r) / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
}
export { normCdf, normInv };

/* ------------------------------------------------------------------ family background */

/**
 * Highest education of the parents. Population shares come from the country's enrolment and literacy rates about
 * 25 years before the birth; the family's wealth percentile and city/village shift a latent rank (rho ≈ 0.6).
 */
export function parentsEducation(data, iso, birthYear, familyPct, urban, rng) {
  const R = rngOf(rng, 'pedu');
  const era = birthYear - 25;
  const sec = toNum(eraValue(data, iso, 'sec_enroll', era));
  const ter = toNum(eraValue(data, iso, 'ter_enroll', era));
  const lit = toNum(eraValue(data, iso, 'literacy', era));
  const pSec = clampN(isNum(sec) ? (sec / 100) * 0.82 : 0.5, 0.02, 0.97);
  const pTer = clampN(isNum(ter) ? (ter / 100) * 0.75 : 0.12, 0.003, Math.min(0.85, pSec));
  let pPrim = isNum(lit) ? clampN(lit / 100, 0.08, 0.995) : clampN(pSec + 0.3, 0.2, 0.99);
  pPrim = Math.max(pPrim, Math.min(0.995, pSec + 0.02));
  const us = urbanShare(data, null, iso, Math.max(FIRST_YEAR, birthYear));
  const z = 0.6 * normInv(clampN(familyPct, 0.005, 0.995)) + 0.8 * R.normal(0, 1) + 0.35 * ((urban ? 1 : 0) - us);
  if (z >= normInv(1 - pTer)) return 'tertiary';
  if (z >= normInv(1 - pSec)) return 'secondary';
  if (z >= normInv(1 - pPrim)) return 'primary';
  return 'none';
}

/** Brothers and sisters from the period TFR (size-biased), fewer in cities and well-off families where TFR is high. */
export function siblingsFor(data, iso, year, familyPct, urban, rng) {
  const R = rngOf(rng, 'sibs');
  const tfr = toNum(safe(() => data.series(iso, 'tfr', year))) ?? 2.3;
  let mean = Math.max(0.05, tfr - 0.55);
  if (tfr > 2.3) mean *= 1 + 0.35 * (0.5 - familyPct) + (urban ? -0.12 : 0.1);
  else mean *= urban ? 0.92 : 1.12;
  return clampN(R.poisson(Math.max(0.02, mean)), 0, 14);
}

const AGE_GAP = { SSA: 7, SAS: 5, WAS: 5.5, NAF: 6, CAS: 3.5, SEA: 3, EAS: 2.5, EEU: 2.5, WEU: 2.5, NAM: 2.2, LAC: 3.5, OCE: 2.3 };

/** Mother's and father's ages at the birth, from the mean age at childbearing (MAC) and the regional spousal gap. */
export function parentAges(data, iso, year, siblings, rng) {
  const R = rngOf(rng, 'pages');
  const mac = toNum(safe(() => data.series(iso, 'mac', year))) ?? 28;
  const tfr = toNum(safe(() => data.series(iso, 'tfr', year))) ?? 2.3;
  // about half of the brothers and sisters are older, born roughly two years apart after a first birth at 15 or later
  const sibs = Math.max(0, Math.round(num0(siblings)));
  const minAge = Math.min(40, 15 + Math.round(0.9 * sibs));
  const mother = Math.round(clampN(R.normal(mac + 0.9 * (sibs - Math.max(0, tfr - 1)), 5.2), minAge, 49));
  const region = safe(() => countryOf(data, iso).region) || '';
  const gap = AGE_GAP[region] ?? 3;
  const father = Math.round(clampN(mother + R.normal(gap, 3.5), Math.max(Math.min(40, 16 + Math.round(0.9 * sibs)), mother - 6), 75));
  return { motherAge: mother, fatherAge: father };
}

/* ------------------------------------------------------------------ names */

// Era-agnostic fallback lists per naming region: "汉字|Latin" pairs.
const P = (s) => s.split(',').map((x) => x.split('|'));
const FALLBACK = {
  sinic: { fmt: 'sg', sur: P('王|Wang,李|Li,张|Zhang,刘|Liu,陈|Chen,杨|Yang,黄|Huang,赵|Zhao,吴|Wu,周|Zhou,徐|Xu,孙|Sun,马|Ma,朱|Zhu,胡|Hu,郭|Guo,何|He,林|Lin,高|Gao,罗|Luo'),
    male: P('浩然|Haoran,子轩|Zixuan,宇航|Yuhang,俊杰|Junjie,明轩|Mingxuan,嘉豪|Jiahao,博文|Bowen,思远|Siyuan,一鸣|Yiming,天佑|Tianyou,志强|Zhiqiang,建华|Jianhua'),
    female: P('欣怡|Xinyi,梓涵|Zihan,雨桐|Yutong,诗琪|Shiqi,思雨|Siyu,可欣|Kexin,佳怡|Jiayi,若曦|Ruoxi,雅静|Yajing,晓彤|Xiaotong,婉清|Wanqing,丽娟|Lijuan') },
  JPN: { fmt: 'sg', sur: P('佐藤|Sato,铃木|Suzuki,高桥|Takahashi,田中|Tanaka,渡边|Watanabe,伊藤|Ito,山本|Yamamoto,中村|Nakamura'),
    male: P('大翔|Hiroto,莲|Ren,悠真|Yuma,阳翔|Haruto,拓海|Takumi,健太|Kenta'), female: P('结衣|Yui,阳菜|Hina,葵|Aoi,美咲|Misaki,凛|Rin,优子|Yuko') },
  KOR: { fmt: 'sg', sur: P('金|Kim,李|Lee,朴|Park,崔|Choi,郑|Jung,姜|Kang,赵|Cho,尹|Yoon'),
    male: P('敏俊|Min-jun,志勋|Ji-hoon,贤宇|Hyun-woo,东贤|Dong-hyun,俊浩|Jun-ho,在民|Jae-min'), female: P('智恩|Ji-eun,秀妍|Soo-yeon,瑞贤|Seo-hyun,敏智|Min-ji,惠真|Hye-jin,恩惠|Eun-hye') },
  VNM: { fmt: 'sg', sur: P('阮|Nguyen,陈|Tran,黎|Le,范|Pham,黄|Hoang,武|Vu'),
    male: P('文安|Van An,明德|Minh Duc,国俊|Quoc Tuan,清松|Thanh Tung,光海|Quang Hai,德勇|Duc Dung'), female: P('氏兰|Thi Lan,玉华|Ngoc Hoa,秋香|Thu Huong,美玲|My Linh,青心|Thanh Tam,金英|Kim Anh') },
  SAS: { fmt: 'gs', sur: P('夏尔马|Sharma,辛格|Singh,库马尔|Kumar,帕特尔|Patel,古普塔|Gupta,雷迪|Reddy,达斯|Das,拉奥|Rao'),
    male: P('拉胡尔|Rahul,阿米特|Amit,阿尔琼|Arjun,维克拉姆|Vikram,拉维|Ravi,萨米尔|Sameer,罗汉|Rohan,阿迪蒂亚|Aditya'),
    female: P('普丽娅|Priya,阿妮塔|Anita,苏妮塔|Sunita,卡维娅|Kavya,迪维娅|Divya,妮莎|Nisha,普贾|Pooja,内哈|Neha') },
  MUS: { fmt: 'gs', sur: P('哈桑|Hassan,侯赛因|Hussein,阿卜杜拉|Abdullah,易卜拉欣|Ibrahim,优素福|Yusuf,萨利赫|Saleh,卡里姆|Karim,拉希德|Rashid'),
    male: P('穆罕默德|Mohammed,艾哈迈德|Ahmed,阿里|Ali,奥马尔|Omar,优素福|Youssef,哈立德|Khalid,穆斯塔法|Mustafa,哈姆扎|Hamza'),
    female: P('法蒂玛|Fatima,阿伊莎|Aisha,莱拉|Layla,努尔|Nour,玛丽亚姆|Maryam,扎伊纳布|Zainab,萨拉|Sara,哈迪杰|Khadija') },
  CAS: { fmt: 'gs', sur: P('卡里莫夫|Karimov,阿利耶夫|Aliyev,努尔兰诺夫|Nurlanov,拉希莫夫|Rakhimov,伊斯梅洛夫|Ismailov,优素波夫|Yusupov'),
    surF: P('卡里莫娃|Karimova,阿利耶娃|Aliyeva,努尔兰诺娃|Nurlanova,拉希莫娃|Rakhimova,伊斯梅洛娃|Ismailova,优素波娃|Yusupova'),
    male: P('阿利舍尔|Alisher,努尔兰|Nurlan,铁木尔|Timur,鲁斯兰|Ruslan,达尼亚尔|Daniyar,法尔霍德|Farkhod'),
    female: P('迪尔诺扎|Dilnoza,艾达|Aida,古丽|Guli,玛迪娜|Madina,阿依古丽|Aigul,扎丽娜|Zarina') },
  SSA: { fmt: 'gs', sur: P('奥孔克沃|Okonkwo,姆万吉|Mwangi,迪亚洛|Diallo,恩科西|Nkosi,奥蒂诺|Otieno,特拉奥雷|Traore,门萨|Mensah,班达|Banda'),
    male: P('科菲|Kofi,奇迪|Chidi,约瑟夫|Joseph,阿马杜|Amadou,塞缪尔|Samuel,卡马乌|Kamau,伊曼纽尔|Emmanuel,西兹韦|Sizwe'),
    female: P('阿玛|Ama,法图玛|Fatuma,格蕾丝|Grace,恩戈齐|Ngozi,阿米娜塔|Aminata,埃丝特|Esther,瓦恩吉鲁|Wanjiru,诺姆萨|Nomsa') },
  LAC: { fmt: 'gs', sur: P('加西亚|Garcia,罗德里格斯|Rodriguez,马丁内斯|Martinez,洛佩斯|Lopez,冈萨雷斯|Gonzalez,席尔瓦|Silva,桑托斯|Santos,佩雷斯|Perez'),
    male: P('胡安|Juan,卡洛斯|Carlos,路易斯|Luis,迭戈|Diego,马特奥|Mateo,何塞|Jose,加布里埃尔|Gabriel,圣地亚哥|Santiago'),
    female: P('玛丽亚|Maria,卡米拉|Camila,瓦伦蒂娜|Valentina,露西亚|Lucia,伊莎贝拉|Isabella,索菲亚|Sofia,加布里埃拉|Gabriela,达妮埃拉|Daniela') },
  EEU: { fmt: 'gs', sur: P('伊万诺夫|Ivanov,彼得罗夫|Petrov,斯米尔诺夫|Smirnov,科瓦连科|Kovalenko,诺瓦克|Novak,波波夫|Popov'),
    surF: P('伊万诺娃|Ivanova,彼得罗娃|Petrova,斯米尔诺娃|Smirnova,科瓦连科|Kovalenko,诺瓦克|Novak,波波娃|Popova'),
    male: P('伊万|Ivan,德米特里|Dmitry,安德烈|Andrei,谢尔盖|Sergei,阿列克谢|Alexei,马克西姆|Maxim'),
    female: P('安娜|Anna,奥尔加|Olga,娜塔莉亚|Natalia,叶卡捷琳娜|Ekaterina,玛丽亚|Maria,伊琳娜|Irina') },
  SEA: { fmt: 'gs', sur: P('拉赫曼|Rahman,哈伦|Harun,桑托斯|Santos,雷耶斯|Reyes,翁萨|Wongsa,西里|Siri'),
    male: P('阿里夫|Arif,达尼|Dani,颂猜|Somchai,约翰|John,班尼|Benny,里兹基|Rizky'), female: P('阿尤|Ayu,玛丽|Mary,西蒂|Siti,妮拉|Nila,安娜|Ana,普特丽|Putri') },
  WEST: { fmt: 'gs', sur: P('史密斯|Smith,米勒|Miller,施密特|Schmidt,马丁|Martin,伯纳德|Bernard,罗西|Rossi,琼斯|Jones,穆勒|Muller'),
    male: P('卢卡斯|Lucas,丹尼尔|Daniel,托马斯|Thomas,詹姆斯|James,马克|Mark,本杰明|Benjamin,利亚姆|Liam,诺亚|Noah'),
    female: P('艾玛|Emma,索菲亚|Sophia,奥利维亚|Olivia,汉娜|Hannah,劳拉|Laura,克洛伊|Chloe,米娅|Mia,夏洛特|Charlotte') },
};
const SET = (s) => new Set(s.split(' '));
const SINIC = SET('CHN TWN HKG MAC SGP');
const MUSLIM_SAS = SET('PAK BGD AFG MDV');
const NON_MUSLIM_WAS = SET('ISR CYP GEO ARM');
const TURKIC = SET('TUR AZE');

function fallbackKey(data, iso) {
  if (SINIC.has(iso)) return 'sinic';
  if (iso === 'JPN') return 'JPN';
  if (iso === 'KOR' || iso === 'PRK') return 'KOR';
  if (iso === 'VNM') return 'VNM';
  const region = safe(() => countryOf(data, iso).region) || '';
  if (region === 'SAS') return MUSLIM_SAS.has(iso) ? 'MUS' : 'SAS';
  if (TURKIC.has(iso)) return 'MUS';
  if (region === 'WAS') return NON_MUSLIM_WAS.has(iso) ? (iso === 'GEO' || iso === 'ARM' ? 'EEU' : 'WEST') : 'MUS';
  if (region === 'NAF') return 'MUS';
  if (region === 'CAS' || iso === 'MNG') return 'CAS';
  if (region === 'SSA') return 'SSA';
  if (region === 'LAC') return 'LAC';
  if (region === 'EEU') return 'EEU';
  if (region === 'SEA') return 'SEA';
  if (region === 'EAS') return 'sinic';
  return 'WEST';
}

const cleanList = (arr) => (Array.isArray(arr) ? arr.map((x) => (typeof x === 'string' ? x.trim() : '')) : []);

/**
 * A name for someone born in iso3 (content.names first, then era-agnostic regional lists).
 * Returns {name, latin, surname, given}; latin may be '' when no romanisation is known.
 */
export function makeName(data, iso3, sex, birthYear, rng) {
  const R = rngOf(rng, `name:${iso3}:${sex}:${birthYear}`);
  const sx = sex === 'female' ? 'female' : 'male';
  const N = safe(() => data.content.names.countries[iso3]);
  if (isObj(N)) {
    const given = cleanList(N[sx]);
    const gi = given.map((g, i) => (g ? i : -1)).filter((i) => i >= 0);
    if (gi.length) {
      const L = isObj(N.latin) ? N.latin : {};
      const gIdx = R.pick(gi);
      const g = given[gIdx];
      const gLat = cleanList(L[sx])[gIdx] || '';
      const femSur = sx === 'female' && Array.isArray(N.surnames_female) && cleanList(N.surnames_female).some(Boolean);
      const surs = cleanList(femSur ? N.surnames_female : N.surnames);
      const surLats = cleanList(femSur ? L.surnames_female : L.surnames);
      const si = surs.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
      const sIdx = si.length ? R.pick(si) : -1;
      const sur = sIdx >= 0 ? surs[sIdx] : '';
      const sLat = sIdx >= 0 ? surLats[sIdx] || '' : '';
      const fmt = String(N.format || 'given·surname');
      let name;
      let latin;
      if (!sur) {
        name = g;
        latin = gLat;
      } else if (fmt === 'surname+given') {
        name = sur + g;
        latin = sLat && gLat ? `${sLat} ${gLat}` : '';
      } else if (fmt === 'given surname' && /不加间隔号|连写/.test(String(N.era_note || ''))) {
        name = g + sur;
        latin = gLat && sLat ? `${gLat} ${sLat}` : '';
      } else {
        name = `${g}·${sur}`;
        latin = gLat && sLat ? `${gLat} ${sLat}` : '';
      }
      return { name, latin, surname: sur, given: g };
    }
  }
  const T = FALLBACK[fallbackKey(data, iso3)] || FALLBACK.WEST;
  const [g, gLat] = R.pick(T[sx]);
  const surList = sx === 'female' && T.surF ? T.surF : T.sur;
  const [s, sLat] = R.pick(surList);
  if (T.fmt === 'sg') return { name: s + g, latin: `${sLat} ${gLat}`, surname: s, given: g };
  return { name: `${g}·${s}`, latin: `${gLat} ${sLat}`, surname: s, given: g };
}

/** Name for a child of a family that already has a surname (keeps the family surname where names have one). */
export function childName(data, iso3, sex, birthYear, rng, surname) {
  const nm = makeName(data, iso3, sex, birthYear, rng);
  const sur = typeof surname === 'string' ? surname.trim() : '';
  if (!sur || !nm.surname || nm.surname === sur) return nm;
  const N = safe(() => data.content.names.countries[iso3]);
  const fmt = isObj(N) ? String(N.format || '') : (FALLBACK[fallbackKey(data, iso3)] || {}).fmt === 'sg' ? 'surname+given' : 'given·surname';
  if (fmt === 'surname+given') return { name: sur + nm.given, latin: '', surname: sur, given: nm.given };
  if (nm.name.includes('·')) return { name: `${nm.given}·${sur}`, latin: '', surname: sur, given: nm.given };
  return nm;
}

/* ------------------------------------------------------------------ notes */

function pctText(x, d = 0) {
  return `${(Math.round(x * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d)}%`;
}
function bigCn(n) {
  if (!isNum(n)) return '';
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${Math.round(n / 1e4)} 万`;
  return String(Math.round(n));
}

/** 3–7 short zh background notes about the circumstances of a birth. */
export function birthNotes(data, world, spec) {
  const notes = [];
  const iso = spec.country;
  const y = spec.year;
  const C = countryOf(data, iso);
  const cname = (C && C.name) || iso;
  const proj = y > HISTORY_END;
  const tag = proj ? '（推演值）' : '';
  if (proj) notes.push('你出生在推演中的未来：2026 年以后的世界是根据今天的趋势推演出来的情景，不是预言，更不是事实。');
  const total = birthsTotal(data, y);
  const own = toNum(safe(() => data.series(iso, 'births', y)));
  if (total > 0 && isNum(own)) {
    const share = (own / total) * 100;
    notes.push(`${y} 年全世界约有 ${bigCn(total * 1000)} 个婴儿出生${tag}，其中约 ${share >= 0.1 ? pctText(share, share >= 10 ? 0 : 1) : '不到 0.1%'} 出生在${cname}。`);
  }
  const le = safe(() => (world && typeof world.lifeExpectancy === 'function' ? world.lifeExpectancy(iso, y, spec.sex) : null))
    ?? toNum(safe(() => data.series(iso, spec.sex === 'female' ? 'le_f' : 'le_m', y)));
  const imr = toNum(ind(data, world, iso, 'imr', y));
  if (isNum(le)) {
    notes.push(`按出生那年的死亡水平，${cname}${spec.sex === 'female' ? '女' : '男'}婴的预期寿命约为 ${le.toFixed(1)} 岁${tag}${isNum(imr) ? `；每 1000 个新生儿中约有 ${Math.max(1, Math.round(imr))} 个活不到一岁` : ''}。`);
  }
  const us = urbanShare(data, world, iso, y);
  notes.push(`${cname}约有 ${pctText(us * 100)} 的人住在城镇${tag}，你出生在${spec.urban ? '城市' : '农村'}。`);
  const fam = Math.round(clampN(spec.familyPct, 0, 1) * 100);
  notes.push(`你家的经济条件大约好于全国 ${fam}% 的家庭；父母中学历最高的${spec.parentsEdu === 'none' ? '没有上过学' : `读到了${PARENT_EDU_LABELS[spec.parentsEdu] || '中学'}`}。`);
  const tfr = toNum(safe(() => data.series(iso, 'tfr', y)));
  if (isNum(tfr)) {
    notes.push(`那一年，${cname}平均每位女性一生生育约 ${tfr.toFixed(1)} 个孩子${tag}；你${spec.siblings > 0 ? `有 ${spec.siblings} 个兄弟姐妹` : '是家里唯一的孩子'}。`);
  }
  const lp = safe(() => data.lifePath(iso));
  const lpNote = lp && Array.isArray(lp.notes) ? lp.notes.find((n) => typeof n === 'string' && n.trim() && n.length <= 90) : null;
  if (lpNote) notes.push(`当地背景：${lpNote.trim()}`);
  return notes;
}

/* ------------------------------------------------------------------ birth specs */

function isoExists(data, iso) {
  return typeof iso === 'string' && !!countryOf(data, iso);
}

/** Accept ISO3 codes (any case) or a country's Chinese / English name. */
export function resolveCountry(data, v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (/^[A-Z]{3}$/.test(up) && isoExists(data, up)) return up;
  const list = safe(() => data.isoList) || Object.keys(safe(() => data.countries) || {});
  const low = s.toLowerCase();
  for (const iso of list) {
    const c = countryOf(data, iso);
    if (!c) continue;
    if (c.name === s || (typeof c.en === 'string' && c.en.toLowerCase() === low) || c.iso2 === up) return iso;
  }
  return null;
}

function normSex(v) {
  if (v === 'male' || v === 'female') return v;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['m', 'man', 'boy', '男', '男孩', '男性'].includes(s)) return 'male';
  if (['f', 'w', 'woman', 'girl', '女', '女孩', '女性'].includes(s)) return 'female';
  return null;
}
function normUrban(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['urban', 'city', 'town', '城市', '城镇', 'true', '1'].includes(s)) return true;
  if (['rural', 'village', 'countryside', '农村', '乡村', 'false', '0'].includes(s)) return false;
  return null;
}
function normPct(v) {
  const n = toNum(v);
  if (!isNum(n)) return null;
  const x = n > 1 && n <= 100 ? n / 100 : n;
  return x >= 0 && x <= 1 ? clampN(Math.round(x * 1000) / 1000, 0.005, 0.995) : null;
}
function normEdu(v) {
  if (PARENT_EDU.includes(v)) return v;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['postgrad', 'university', 'college', '大学', '研究生', 'tertiary'].includes(s)) return 'tertiary';
  if (['vocational', 'high school', 'secondary', '中学', '高中', '初中', '职业教育'].includes(s)) return 'secondary';
  if (['primary', 'elementary', '小学'].includes(s)) return 'primary';
  if (['none', 'no school', '未上学', '没上过学', '文盲'].includes(s)) return 'none';
  return null;
}
function normInt(v, lo, hi) {
  const n = toNum(v);
  if (!isNum(n)) return null;
  const r = Math.round(n);
  return r >= lo && r <= hi ? r : null;
}
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Fill a BirthSpec from any subset of fields. Invalid fields are ignored; missing ones are drawn at random. */
function buildSpec(data, world, rng, input, mode) {
  const R = rngOf(rng, 'spec');
  const inp = isObj(input) ? input : {};
  const parsedDate = parseDate(inp.date);
  let year = normInt(inp.year, FIRST_YEAR, LAST_BIRTH_YEAR);
  if (year == null && parsedDate && parsedDate.year >= FIRST_YEAR && parsedDate.year <= LAST_BIRTH_YEAR) year = parsedDate.year;
  if (year == null) year = pickBirthYear(data, R, YEAR_MODES.includes(String(inp.yearMode)) ? String(inp.yearMode) : mode === 'custom' ? 'any' : '2000');
  const date = parsedDate && parsedDate.year === year ? formatDate(year, parsedDate.month, parsedDate.day)
    : randomDate(year, R, year === HISTORY_END ? DATA_DATE : null);
  const time = parseTime(inp.time) || randomTime(R);
  const country = resolveCountry(data, inp.country) || pickCountry(data, year, R);
  const sex = normSex(inp.sex) || pickSex(data, country, year, R);
  let urban = normUrban(inp.urban);
  if (urban == null) urban = R.chance(urbanShare(data, world, country, year));
  let familyPct = normPct(inp.familyPct);
  if (familyPct == null) familyPct = Math.round(R.float(0.005, 0.995) * 1000) / 1000;
  const parentsEdu = normEdu(inp.parentsEdu) || parentsEducation(data, country, year, familyPct, urban, R);
  let siblings = normInt(inp.siblings, 0, 20);
  if (siblings == null) siblings = siblingsFor(data, country, year, familyPct, urban, R);
  const ages = parentAges(data, country, year, siblings, R);
  let motherAge = normInt(inp.motherAge, 12, 60);
  let fatherAge = normInt(inp.fatherAge, 13, 90);
  if (motherAge == null) motherAge = ages.motherAge;
  if (fatherAge == null) fatherAge = Math.max(14, ages.fatherAge + (normInt(inp.motherAge, 12, 60) != null ? motherAge - ages.motherAge : 0));
  const given = cleanText(inp.name, 24);
  let name;
  let nameLatin = '';
  let surname = '';
  if (given) {
    name = given;
    nameLatin = cleanText(inp.nameLatin, 48);
    surname = cleanText(inp.surname, 12) || guessSurname(data, country, given);
  } else {
    const nm = makeName(data, country, sex, year, R);
    name = nm.name;
    nameLatin = nm.latin;
    surname = nm.surname;
  }
  const spec = {
    mode, year, date, time, country, sex, urban, familyPct, parentsEdu, siblings, motherAge, fatherAge, name,
  };
  if (nameLatin) spec.nameLatin = nameLatin;
  if (surname) spec.surname = surname;
  const extra = Array.isArray(inp.notes) ? inp.notes.map((n) => cleanText(n, 200)).filter(Boolean).slice(0, 5) : [];
  spec.notes = [...extra, ...birthNotes(data, world, spec)].slice(0, 10);
  const custom = cleanText(inp.customText, 600);
  if (custom) spec.customText = custom;
  return spec;
}

/**
 * Random birth (CONTRACT §9). opts.yearMode: '2000' (default) | 'history' | 'now' | 'future' | 'any';
 * opts.year forces the year.
 */
export function randomBirth(data, world, rng, opts = {}) {
  const o = isObj(opts) ? opts : {};
  const input = {};
  const y = normInt(o.year, FIRST_YEAR, LAST_BIRTH_YEAR);
  if (y != null) input.year = y;
  else input.yearMode = YEAR_MODES.includes(String(o.yearMode)) ? String(o.yearMode) : '2000';
  return buildSpec(data, world, rng, input, 'random');
}

/**
 * Custom birth: any subset of BirthSpec fields (+ customText, yearMode). Missing or invalid fields are random,
 * conditioned on the ones given (e.g. sex by the chosen country's sex ratio).
 */
export function customBirth(data, world, rng, input) {
  const inp = isObj(input) ? input : {};
  return buildSpec(data, world, rng, inp, inp.mode === 'random' ? 'random' : 'custom');
}

const COMPOUND_SURNAMES = ['欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '尉迟', '公孙', '慕容', '长孙', '宇文', '司徒', '夏侯', '令狐', '端木', '南宫'];

/** Best guess of the family name inside a full name (used to name children after the family). */
export function guessSurname(data, iso, name) {
  const s = typeof name === 'string' ? name.trim() : '';
  if (!s) return '';
  if (s.includes('·')) return s.slice(s.lastIndexOf('·') + 1).trim();
  if (/\s/.test(s)) return s.split(/\s+/).pop();
  const N = safe(() => data.content.names.countries[iso]);
  const sg = isObj(N) ? N.format === 'surname+given' : (FALLBACK[fallbackKey(data, iso)] || {}).fmt === 'sg';
  if (!sg || s.length < 2) return '';
  const known = isObj(N) ? cleanList(N.surnames).filter(Boolean) : [];
  const hit = known.filter((k) => s.startsWith(k) && s.length > k.length).sort((a, b) => b.length - a.length)[0];
  if (hit) return hit;
  const comp = COMPOUND_SURNAMES.find((k) => s.startsWith(k) && s.length > 2);
  if (comp) return comp;
  if (iso === 'JPN' && s.length >= 3) return s.slice(0, 2);
  return s.slice(0, 1);
}

/**
 * Validate a BirthSpec handed to the engine. A complete, valid spec is kept as it is (notes included);
 * otherwise the missing or invalid fields are filled the same way customBirth does.
 */
export function normalizeBirth(data, world, rng, spec) {
  const s = isObj(spec) ? spec : {};
  const pd = parseDate(s.date);
  const year = normInt(s.year, FIRST_YEAR, LAST_BIRTH_YEAR);
  const ok = year != null && pd && pd.year === year && parseTime(s.time) && isoExists(data, s.country)
    && (s.sex === 'male' || s.sex === 'female') && typeof s.urban === 'boolean' && normPct(s.familyPct) != null
    && PARENT_EDU.includes(s.parentsEdu) && normInt(s.siblings, 0, 20) != null && normInt(s.motherAge, 12, 60) != null
    && normInt(s.fatherAge, 13, 90) != null && cleanText(s.name, 24);
  const mode = s.mode === 'custom' ? 'custom' : 'random';
  if (ok) {
    const out = {
      mode, year, date: formatDate(pd.year, pd.month, pd.day), time: parseTime(s.time), country: s.country, sex: s.sex,
      urban: s.urban, familyPct: normPct(s.familyPct), parentsEdu: s.parentsEdu, siblings: normInt(s.siblings, 0, 20),
      motherAge: normInt(s.motherAge, 12, 60), fatherAge: normInt(s.fatherAge, 13, 90), name: cleanText(s.name, 24),
    };
    const lat = cleanText(s.nameLatin, 48);
    if (lat) out.nameLatin = lat;
    out.surname = cleanText(s.surname, 12) || guessSurname(data, out.country, out.name);
    if (!out.surname) delete out.surname;
    out.notes = Array.isArray(s.notes) ? s.notes.map((n) => cleanText(n, 240)).filter(Boolean).slice(0, 10) : birthNotes(data, world, out);
    const custom = cleanText(s.customText, 600);
    if (custom) out.customText = custom;
    return out;
  }
  const built = buildSpec(data, world, rng, { ...s, notes: undefined, mode }, mode);
  if (Array.isArray(s.notes) && s.notes.some((n) => typeof n === 'string' && n.trim())) {
    built.notes = s.notes.map((n) => cleanText(n, 240)).filter(Boolean).slice(0, 10);
  }
  return built;
}

/** Region label (zh) for a country, '' when unknown. */
export function regionLabel(data, iso) {
  const r = safe(() => countryOf(data, iso).region);
  return r ? REGIONS[r] || '' : '';
}
