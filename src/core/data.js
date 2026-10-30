// Data layer: loads the prebuilt JSON files and exposes the DataStore (CONTRACT §3).
// Pure module: no DOM, no fetch (the caller passes fetchJson), no Math.random, no Date.
//
// Mortality: data/mortality.json holds WPP 2024 abridged life-table mx (central death rates) by
// country × grid year × sex × age group, Uint16 LE base64 (mx = exp(1 - v/4000)).
// mx() interpolates log-linearly between grid years; qx() = 1 - exp(-mx) is the annual death probability.
// Life-expectancy helpers assume a constant hazard inside each single year of age (exact for the abridged
// table's piecewise-constant mx) and close the table at age 115 with the 100+ hazard.

import { INCOME_THRESHOLDS, MAX_AGE, REGIONS } from './constants.js';

const YEAR_MIN = 2000;
const YEAR_MAX = 2100;
const AGE_TABLE_MAX = 130;

/* ------------------------------------------------------------------ base64 / Uint16 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Uint8Array(128).fill(255);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  t[45] = 62; // '-' (URL-safe alphabet)
  t[95] = 63; // '_'
  return t;
})();

/** Decode standard or URL-safe base64 into bytes. Works in browsers and Node without Buffer/atob. */
export function decodeBase64(str) {
  let s = String(str || '');
  if (/[^A-Za-z0-9+/=_-]/.test(s)) s = s.replace(/[^A-Za-z0-9+/=_-]/g, '');
  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61) len--; // strip '=' padding
  const out = new Uint8Array((len * 3) >> 2);
  let o = 0;
  let i = 0;
  const T = B64_LOOKUP;
  for (; i + 4 <= len; i += 4) {
    const n = (T[s.charCodeAt(i)] << 18) | (T[s.charCodeAt(i + 1)] << 12) | (T[s.charCodeAt(i + 2)] << 6) | T[s.charCodeAt(i + 3)];
    out[o++] = (n >>> 16) & 255;
    out[o++] = (n >>> 8) & 255;
    out[o++] = n & 255;
  }
  const rem = len - i;
  if (rem >= 2) {
    const n = (T[s.charCodeAt(i)] << 18) | (T[s.charCodeAt(i + 1)] << 12) | (rem === 3 ? T[s.charCodeAt(i + 2)] << 6 : 0);
    out[o++] = (n >>> 16) & 255;
    if (rem === 3) out[o++] = (n >>> 8) & 255;
  }
  return o === out.length ? out : out.subarray(0, o);
}

/** Little-endian Uint16 values from a byte array (endianness independent of the host). */
export function decodeUint16LE(bytes) {
  const n = bytes.length >> 1;
  const out = new Uint16Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 2) out[i] = bytes[j] | (bytes[j + 1] << 8);
  return out;
}

/* ------------------------------------------------------------------ small helpers */

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
/** obj[key] only when it is an own plain-object entry (guards against "__proto__"-style keys). */
const ownEntry = (obj, key) => (Object.prototype.hasOwnProperty.call(obj, key) && isPlainObject(obj[key]) ? obj[key] : undefined);

function cloneDeep(v) {
  if (Array.isArray(v)) return v.map(cloneDeep);
  if (isPlainObject(v)) {
    const o = {};
    for (const k of Object.keys(v)) o[k] = cloneDeep(v[k]);
    return o;
  }
  return v;
}

/** Merge `over` onto a deep copy of `base`: plain objects merge recursively, arrays/scalars replace, null/undefined skip. */
function mergeOver(base, over) {
  const out = isPlainObject(base) ? cloneDeep(base) : {};
  if (!isPlainObject(over)) return out;
  for (const k of Object.keys(over)) {
    const v = over[k];
    if (v == null) continue;
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeOver(out[k], v);
    else out[k] = cloneDeep(v);
  }
  return out;
}

/**
 * Year lookup table for a grid of years: integer years in [YEAR_MIN, YEAR_MAX] map to (lower grid index, weight).
 * locate() handles fractional / out-of-range years without allocating (results in .yi/.w).
 */
function makeYearLookup(years) {
  const n = years.length;
  const first = Math.max(YEAR_MIN, years[0]);
  const last = Math.min(YEAR_MAX, years[n - 1]);
  const span = YEAR_MAX - YEAR_MIN;
  const lo = new Int32Array(span + 1);
  const wt = new Float64Array(span + 1);
  const lk = { years, lo, wt, first, last, yi: 0, w: 0 };
  lk.locate = function locate(year) {
    let y = +year;
    if (!(y >= first)) y = first; // also catches NaN
    if (y > last) y = last;
    let i = 0;
    while (i < n - 2 && years[i + 1] <= y) i++;
    const a = years[i];
    const b = years[i + 1];
    let w = b > a ? (y - a) / (b - a) : 0;
    if (w >= 1) { i++; w = 0; }
    if (i >= n - 1) { i = n - 1; w = 0; }
    lk.yi = i;
    lk.w = w < 1e-12 ? 0 : w;
  };
  for (let k = 0; k <= span; k++) {
    lk.locate(YEAR_MIN + k);
    lo[k] = lk.yi;
    wt[k] = lk.w;
  }
  return lk;
}

const sexIndex = (sex) => (sex === 'female' || sex === 'f' || sex === 'F' || sex === 1 ? 1 : 0);

/* ------------------------------------------------------------------ built-in fallbacks */

const CURRENCY_FALLBACK = Object.freeze({ code: '', name: '本地货币', symbol: '' });

// Compact built-in currency table, used when research/life_paths*.json has no entry for a country.
// Format per item: "ISO3[,ISO3...]:CODE:中文名:symbol"
const BUILTIN_CURRENCIES = [
  'CHN:CNY:人民币:¥', 'HKG:HKD:港元:HK$', 'MAC:MOP:澳门元:MOP$', 'TWN:TWD:新台币:NT$', 'JPN:JPY:日元:円',
  'KOR:KRW:韩元:₩', 'PRK:KPW:朝鲜元:₩', 'MNG:MNT:图格里克:₮',
  'IND:INR:印度卢比:₹', 'PAK:PKR:巴基斯坦卢比:Rs', 'BGD:BDT:孟加拉塔卡:৳', 'LKA:LKR:斯里兰卡卢比:Rs',
  'NPL:NPR:尼泊尔卢比:Rs', 'AFG:AFN:阿富汗尼:؋', 'BTN:BTN:努尔特鲁姆:Nu.', 'MDV:MVR:马尔代夫拉菲亚:Rf',
  'IDN:IDR:印尼盾:Rp', 'PHL:PHP:菲律宾比索:₱', 'VNM:VND:越南盾:₫', 'THA:THB:泰铢:฿', 'MYS:MYR:林吉特:RM',
  'SGP:SGD:新加坡元:S$', 'MMR:MMK:缅元:K', 'KHM:KHR:瑞尔:៛', 'LAO:LAK:基普:₭', 'BRN:BND:文莱元:B$',
  'USA,ECU,SLV,TLS,PRI,PAN,ZWE,GUM,VIR,ASM,MHL,FSM,PLW,TCA,VGB,BES:USD:美元:$',
  'CAN:CAD:加元:C$', 'MEX:MXN:墨西哥比索:Mex$', 'BRA:BRL:巴西雷亚尔:R$', 'ARG:ARS:阿根廷比索:$',
  'COL:COP:哥伦比亚比索:$', 'CHL:CLP:智利比索:$', 'PER:PEN:秘鲁索尔:S/', 'VEN:VES:玻利瓦尔:Bs.',
  'GTM:GTQ:格查尔:Q', 'CUB:CUP:古巴比索:$', 'DOM:DOP:多米尼加比索:RD$', 'HTI:HTG:古德:G', 'BOL:BOB:玻利维亚诺:Bs',
  'PRY:PYG:瓜拉尼:₲', 'URY:UYU:乌拉圭比索:$U', 'HND:HNL:伦皮拉:L', 'NIC:NIO:科多巴:C$', 'CRI:CRC:科朗:₡',
  'JAM:JMD:牙买加元:J$', 'TTO:TTD:特立尼达和多巴哥元:TT$', 'BHS:BSD:巴哈马元:B$', 'BRB:BBD:巴巴多斯元:Bds$',
  'GUY:GYD:圭亚那元:G$', 'SUR:SRD:苏里南元:$', 'BLZ:BZD:伯利兹元:BZ$',
  'ATG,DMA,GRD,KNA,LCA,VCT,AIA,MSR:XCD:东加勒比元:EC$',
  'GBR:GBP:英镑:£',
  'DEU,FRA,ITA,ESP,PRT,NLD,BEL,AUT,IRL,FIN,GRC,LUX,SVK,SVN,EST,LVA,LTU,MLT,CYP,HRV,AND,MCO,SMR,VAT,MNE,GLP,MTQ,GUF,REU,MYT,SPM,BLM,MAF:EUR:欧元:€',
  'CHE,LIE:CHF:瑞士法郎:Fr.', 'SWE:SEK:瑞典克朗:kr', 'NOR:NOK:挪威克朗:kr', 'DNK,GRL,FRO:DKK:丹麦克朗:kr',
  'ISL:ISK:冰岛克朗:kr', 'POL:PLN:兹罗提:zł', 'CZE:CZK:捷克克朗:Kč', 'HUN:HUF:福林:Ft', 'ROU:RON:罗马尼亚列伊:lei',
  'BGR:BGN:保加利亚列弗:лв', 'RUS:RUB:卢布:₽', 'UKR:UAH:格里夫纳:₴', 'BLR:BYN:白俄罗斯卢布:Br',
  'MDA:MDL:摩尔多瓦列伊:L', 'SRB:RSD:塞尔维亚第纳尔:дин', 'ALB:ALL:列克:L', 'MKD:MKD:代纳尔:ден',
  'BIH:BAM:可兑换马克:KM', 'GEO:GEL:拉里:₾', 'ARM:AMD:德拉姆:֏', 'AZE:AZN:阿塞拜疆马纳特:₼', 'TUR:TRY:土耳其里拉:₺',
  'KAZ:KZT:坚戈:₸', 'UZB:UZS:苏姆:soʻm', 'KGZ:KGS:索姆:с', 'TJK:TJS:索莫尼:SM', 'TKM:TMT:土库曼斯坦马纳特:m',
  'IRN:IRR:伊朗里亚尔:﷼', 'IRQ:IQD:伊拉克第纳尔:ع.د', 'SAU:SAR:沙特里亚尔:﷼', 'ARE:AED:迪拉姆:د.إ',
  'ISR,PSE:ILS:新谢克尔:₪', 'JOR:JOD:约旦第纳尔:JD', 'LBN:LBP:黎巴嫩镑:L£', 'SYR:SYP:叙利亚镑:£S',
  'YEM:YER:也门里亚尔:﷼', 'OMN:OMR:阿曼里亚尔:﷼', 'QAT:QAR:卡塔尔里亚尔:﷼', 'KWT:KWD:科威特第纳尔:KD',
  'BHR:BHD:巴林第纳尔:BD',
  'EGY:EGP:埃及镑:E£', 'MAR,ESH:MAD:摩洛哥迪拉姆:DH', 'DZA:DZD:阿尔及利亚第纳尔:DA', 'TUN:TND:突尼斯第纳尔:DT',
  'LBY:LYD:利比亚第纳尔:LD', 'SDN:SDG:苏丹镑:£',
  'NGA:NGN:奈拉:₦', 'ETH:ETB:埃塞俄比亚比尔:Br', 'ZAF:ZAR:兰特:R', 'KEN:KES:肯尼亚先令:KSh',
  'TZA:TZS:坦桑尼亚先令:TSh', 'UGA:UGX:乌干达先令:USh', 'GHA:GHS:塞地:₵', 'COD:CDF:刚果法郎:FC',
  'AGO:AOA:宽扎:Kz', 'MOZ:MZN:梅蒂卡尔:MT', 'MDG:MGA:阿里亚里:Ar',
  'CMR,TCD,CAF,COG,GAB,GNQ:XAF:中非法郎:FCFA', 'CIV,SEN,MLI,BFA,NER,BEN,TGO,GNB:XOF:西非法郎:CFA',
  'ZMB:ZMW:赞比亚克瓦查:K', 'RWA:RWF:卢旺达法郎:FRw', 'SOM:SOS:索马里先令:Sh', 'SSD:SSP:南苏丹镑:£',
  'MWI:MWK:马拉维克瓦查:MK', 'BDI:BIF:布隆迪法郎:FBu', 'GIN:GNF:几内亚法郎:FG', 'SLE:SLE:利昂:Le',
  'LBR:LRD:利比里亚元:L$', 'BWA:BWP:普拉:P', 'NAM:NAD:纳米比亚元:N$', 'LSO:LSL:洛蒂:L', 'SWZ:SZL:里兰吉尼:E',
  'ERI:ERN:纳克法:Nfk', 'MRT:MRU:乌吉亚:UM', 'GMB:GMD:达拉西:D', 'CPV:CVE:佛得角埃斯库多:Esc',
  'MUS:MUR:毛里求斯卢比:Rs', 'SYC:SCR:塞舌尔卢比:SR', 'COM:KMF:科摩罗法郎:CF', 'DJI:DJF:吉布提法郎:Fdj',
  'STP:STN:多布拉:Db',
  'AUS,KIR,NRU,TUV:AUD:澳元:A$', 'NZL,COK,NIU,TKL:NZD:新西兰元:NZ$', 'PNG:PGK:基那:K', 'FJI:FJD:斐济元:FJ$',
  'WSM:WST:塔拉:WS$', 'TON:TOP:潘加:T$', 'SLB:SBD:所罗门群岛元:SI$', 'VUT:VUV:瓦图:VT',
  'NCL,PYF,WLF:XPF:太平洋法郎:F',
];
const CURRENCY_TABLE = (() => {
  const t = Object.create(null);
  for (const row of BUILTIN_CURRENCIES) {
    const [isos, code, name, symbol] = row.split(':');
    for (const iso of isos.split(',')) t[iso] = Object.freeze({ code, name, symbol });
  }
  return t;
})();

// Typical emigration destinations by game region (used when a country has no researched list).
const REGION_DESTINATIONS = {
  EAS: ['USA', 'CAN', 'AUS', 'JPN', 'KOR', 'GBR', 'SGP'],
  SEA: ['USA', 'AUS', 'JPN', 'SGP', 'KOR', 'MYS', 'SAU'],
  SAS: ['ARE', 'SAU', 'USA', 'GBR', 'CAN', 'QAT', 'AUS'],
  CAS: ['RUS', 'KAZ', 'TUR', 'DEU', 'KOR', 'POL'],
  WAS: ['DEU', 'TUR', 'USA', 'GBR', 'CAN', 'SWE', 'ARE'],
  NAF: ['FRA', 'ESP', 'ITA', 'DEU', 'SAU', 'ARE', 'CAN'],
  SSA: ['ZAF', 'GBR', 'FRA', 'USA', 'CAN', 'ARE', 'DEU'],
  EEU: ['DEU', 'POL', 'GBR', 'CZE', 'USA', 'ITA', 'CAN'],
  WEU: ['GBR', 'DEU', 'USA', 'CHE', 'AUS', 'CAN', 'NLD'],
  NAM: ['CAN', 'USA', 'GBR', 'MEX', 'AUS', 'DEU'],
  LAC: ['USA', 'ESP', 'CAN', 'CHL', 'ARG', 'MEX', 'ITA'],
  OCE: ['AUS', 'NZL', 'USA', 'GBR', 'CAN'],
};

const BASE_LIFE_PATH = Object.freeze({
  currency: CURRENCY_FALLBACK,
  school_start_age: 6,
  compulsory_years: 9,
  key_exams: [],
  conscription: { exists: false, sex: 'male', months: 0, since: null, until: null, note: '' },
  legal_marriage_age: { male: 18, female: 18 },
  median_first_marriage_age: { male: 28, female: 25, year: 2020 },
  retirement_age: [{ from: 2000, male: 60, female: 60 }],
  common_destinations: [],
  notes: [],
  sources: [],
});

// Sane, deliberately generic defaults by income group, used under researched defaults.
const BUILTIN_BY_INCOME = {
  LIC: {
    school_start_age: 7, compulsory_years: 6,
    median_first_marriage_age: { male: 25, female: 19, year: 2020 },
    retirement_age: [{ from: 2000, male: 60, female: 60 }],
    notes: ['正规就业比例低，多数人在农业或非正式部门谋生，养老主要依靠家庭。'],
  },
  LMC: {
    school_start_age: 6, compulsory_years: 8,
    median_first_marriage_age: { male: 27, female: 22, year: 2020 },
    retirement_age: [{ from: 2000, male: 60, female: 58 }],
    notes: ['城乡差距明显，非正式就业仍然普遍。'],
  },
  UMC: {
    school_start_age: 6, compulsory_years: 9,
    median_first_marriage_age: { male: 28, female: 25, year: 2020 },
    retirement_age: [{ from: 2000, male: 62, female: 60 }],
    notes: [],
  },
  HIC: {
    school_start_age: 6, compulsory_years: 10,
    median_first_marriage_age: { male: 32, female: 30, year: 2020 },
    retirement_age: [{ from: 2000, male: 65, female: 65 }],
    notes: [],
  },
};

const INCOME_IDS = INCOME_THRESHOLDS.map((t) => t.id);

/* ------------------------------------------------------------------ content normalisation */

function normaliseContent(raw) {
  const c = isPlainObject(raw) ? raw : {};
  const fut = isPlainObject(c.future) ? c.future : {};
  const lp = isPlainObject(c.lifePaths) ? c.lifePaths : {};
  const names = isPlainObject(c.names) ? c.names : {};
  return {
    ...c,
    meta: isPlainObject(c.meta) ? c.meta : {},
    history: Array.isArray(c.history) ? c.history.filter(isPlainObject) : [],
    future: {
      ...fut,
      baseline_assumptions: Array.isArray(fut.baseline_assumptions) ? fut.baseline_assumptions : [],
      dimensions: Array.isArray(fut.dimensions) ? fut.dimensions.filter(isPlainObject) : [],
      milestones: Array.isArray(fut.milestones) ? fut.milestones.filter(isPlainObject) : [],
      random_shocks: Array.isArray(fut.random_shocks) ? fut.random_shocks.filter(isPlainObject) : [],
    },
    econ: isPlainObject(c.econ) ? c.econ : {},
    lifePaths: {
      ...lp,
      countries: isPlainObject(lp.countries) ? lp.countries : {},
      defaults_by_income_group: isPlainObject(lp.defaults_by_income_group) ? lp.defaults_by_income_group : {},
    },
    names: { ...names, countries: isPlainObject(names.countries) ? names.countries : {} },
  };
}

/* ------------------------------------------------------------------ loading */

/**
 * Load the three data files in parallel. fetchJson(url) -> Promise<parsed JSON>.
 * countries/mortality are required (rejects with a descriptive Error); content failure -> empty content.
 */
export async function loadData(fetchJson) {
  const get = (url) => Promise.resolve().then(() => fetchJson(url));
  const [countries, mortality, content] = await Promise.all([
    get('data/countries.json').catch((e) => { throw new Error('无法载入国家数据 data/countries.json：' + (e && e.message ? e.message : e)); }),
    get('data/mortality.json').catch((e) => { throw new Error('无法载入死亡率数据 data/mortality.json：' + (e && e.message ? e.message : e)); }),
    get('data/content.json').catch(() => null),
  ]);
  return makeDataStore({ countries, mortality, content });
}

/* ------------------------------------------------------------------ the store */

/**
 * Build the DataStore from already-parsed JSON (used by loadData and by Node tests).
 * @param {{countries: object, mortality: object, content?: object}} raw
 */
export function makeDataStore({ countries: countriesJson, mortality: mortalityJson, content: contentJson } = {}) {
  if (!countriesJson || !isPlainObject(countriesJson.countries)) throw new Error('countries.json 格式不正确');
  if (!mortalityJson || !isPlainObject(mortalityJson.meta) || typeof mortalityJson.b64 !== 'string') {
    throw new Error('mortality.json 格式不正确');
  }

  const meta = countriesJson.meta || {};
  const countries = countriesJson.countries;
  const years = Array.isArray(meta.years) && meta.years.length > 1 ? meta.years.slice() : null;
  if (!years) throw new Error('countries.json 缺少年份网格');
  const isoList = Object.keys(countries).sort();
  const content = normaliseContent(contentJson);
  const seriesLookup = makeYearLookup(years);

  /* ---------- mortality decode ---------- */
  const mm = mortalityJson.meta;
  const mYears = mm.years;
  const mAges = mm.ages;
  const mIsos = mm.countries;
  const nY = mYears.length;
  const nA = mAges.length;
  const perYear = 2 * nA;            // both sexes
  const perCountry = nY * perYear;
  const expected = mIsos.length * perCountry;
  const u16 = decodeUint16LE(decodeBase64(mortalityJson.b64));
  if (u16.length < expected) throw new Error(`mortality.json 数据长度不足（${u16.length} < ${expected}）`);
  const LN = new Float64Array(expected); // ln(mx)
  for (let i = 0; i < expected; i++) LN[i] = 1 - u16[i] / 4000;

  const cOff = new Map();
  mIsos.forEach((iso, i) => cOff.set(iso, i * perCountry));

  const mortLookup = makeYearLookup(mYears);
  const Y_LO = mortLookup.lo;
  const Y_W = mortLookup.wt;

  // integer age -> age-group index (0, 1-4, 5-9, ..., 100+)
  const AGE_G = new Uint8Array(AGE_TABLE_MAX + 1);
  for (let a = 0; a <= AGE_TABLE_MAX; a++) {
    let g = 0;
    for (let i = 0; i < nA; i++) if (mAges[i] <= a) g = i;
    AGE_G[a] = g;
  }

  // world reference schedule (births-weighted mean ln mx) for ISO codes without a life table
  let REF = null;
  function refTable() {
    if (REF) return REF;
    REF = new Float64Array(perCountry);
    const wsum = new Float64Array(nY);
    for (let ci = 0; ci < mIsos.length; ci++) {
      const c = countries[mIsos[ci]];
      const births = c && c.wpp && c.wpp.births;
      const base = ci * perCountry;
      for (let yi = 0; yi < nY; yi++) {
        const gi = years.indexOf(mYears[yi]);
        const w = births && gi >= 0 && births[gi] > 0 ? births[gi] : 0;
        if (!w) continue;
        wsum[yi] += w;
        const o = yi * perYear;
        for (let k = 0; k < perYear; k++) REF[o + k] += w * LN[base + o + k];
      }
    }
    for (let yi = 0; yi < nY; yi++) {
      const o = yi * perYear;
      const w = wsum[yi] || 1;
      for (let k = 0; k < perYear; k++) REF[o + k] = wsum[yi] ? REF[o + k] / w : -4;
    }
    return REF;
  }

  function mx(iso3, year, sex, age) {
    let arr = LN;
    let off = cOff.get(iso3);
    if (off === undefined) { arr = refTable(); off = 0; }
    let yi, w;
    const k = year - YEAR_MIN;
    if (k >= 0 && k <= YEAR_MAX - YEAR_MIN && (k | 0) === k) {
      yi = Y_LO[k];
      w = Y_W[k];
    } else {
      mortLookup.locate(year);
      yi = mortLookup.yi;
      w = mortLookup.w;
    }
    const a = age > 0 ? (age < AGE_TABLE_MAX ? age | 0 : AGE_TABLE_MAX) : 0;
    const idx = off + yi * perYear + (sexIndex(sex) === 1 ? nA : 0) + AGE_G[a];
    const la = arr[idx];
    if (w === 0) return Math.exp(la);
    return Math.exp(la + (arr[idx + perYear] - la) * w);
  }

  function qx(iso3, year, sex, age) {
    return 1 - Math.exp(-mx(iso3, year, sex, age));
  }

  /* ---------- life expectancy and survival ---------- */

  // person-years lived in one year of age with constant hazard m starting from survivorship l
  const lived = (l, m, p) => (m > 1e-12 ? (l * (1 - p)) / m : l);

  function lifeTable(iso3, sex, yearAt, fromAge, multFn) {
    const start = Math.max(0, Math.min(MAX_AGE, Math.floor(+fromAge || 0)));
    let l = 1;
    let e = 0;
    for (let x = start; x < MAX_AGE; x++) {
      const y = yearAt(x);
      let m = mx(iso3, y, sex, x);
      if (multFn) m *= Math.max(0, +multFn(y, x) || 0);
      const p = Math.exp(-m);
      e += lived(l, m, p);
      l *= p;
    }
    const y = yearAt(MAX_AGE);
    let m = mx(iso3, y, sex, MAX_AGE);
    if (multFn) m *= Math.max(0, +multFn(y, MAX_AGE) || 0);
    e += m > 1e-9 ? l / m : 0;
    return e;
  }

  const leCache = new Map();

  /** Period life expectancy at birth (or remaining at fromAge) for calendar year `year`. multFn(year, age) scales the hazard. */
  function periodLifeExpectancy(iso3, year, sex, multFn, fromAge = 0) {
    const y = clampYear(year);
    if (!multFn && !fromAge) {
      const key = `${iso3}|${y}|${sexIndex(sex)}`;
      let v = leCache.get(key);
      if (v === undefined) {
        v = lifeTable(iso3, sex, () => y, 0, null);
        leCache.set(key, v);
      }
      return v;
    }
    return lifeTable(iso3, sex, () => y, fromAge, multFn || null);
  }

  /**
   * Cohort life expectancy for people born in birthYear, following the diagonal year = birthYear + age
   * (rates beyond 2100 held at 2100). Optional fromAge returns remaining years for survivors at that age.
   */
  function cohortLifeExpectancy(iso3, birthYear, sex, multFn, fromAge = 0) {
    const b = +birthYear;
    if (!multFn && !fromAge) {
      const key = `c|${iso3}|${b}|${sexIndex(sex)}`;
      let v = leCache.get(key);
      if (v === undefined) {
        v = lifeTable(iso3, sex, (x) => clampYear(b + x), 0, null);
        leCache.set(key, v);
      }
      return v;
    }
    return lifeTable(iso3, sex, (x) => clampYear(b + x), fromAge, multFn || null);
  }

  /**
   * Survival curve along the cohort diagonal. Returns an array indexed by exact age 0..MAX_AGE (length 116):
   * out[a] = probability of being alive at exact age a given alive at fromAge (1 for a <= fromAge).
   */
  function cohortSurvival(iso3, birthYear, sex, fromAge = 0, multFn) {
    const b = +birthYear;
    const start = Math.max(0, Math.min(MAX_AGE, Math.floor(+fromAge || 0)));
    const out = new Array(MAX_AGE + 1);
    for (let a = 0; a <= start; a++) out[a] = 1;
    let l = 1;
    for (let x = start; x < MAX_AGE; x++) {
      const y = clampYear(b + x);
      let m = mx(iso3, y, sex, x);
      if (multFn) m *= Math.max(0, +multFn(y, x) || 0);
      l *= Math.exp(-m);
      out[x + 1] = l;
    }
    return out;
  }

  /* ---------- series ---------- */

  function series(iso3, key, year) {
    const c = countries[iso3];
    if (!c) return null;
    const arr = (c.wb && c.wb[key]) || (c.wpp && c.wpp[key]);
    if (!arr) return null;
    let yi, w;
    const k = year - YEAR_MIN;
    if (k >= 0 && k <= YEAR_MAX - YEAR_MIN && (k | 0) === k) {
      yi = seriesLookup.lo[k];
      w = seriesLookup.wt[k];
    } else {
      seriesLookup.locate(year);
      yi = seriesLookup.yi;
      w = seriesLookup.w;
    }
    const a = arr[yi];
    if (w === 0) return a == null || !Number.isFinite(a) ? null : a;
    const b = arr[yi + 1];
    const aOk = a != null && Number.isFinite(a);
    const bOk = b != null && Number.isFinite(b);
    if (aOk && bOk) return a + (b - a) * w;
    if (aOk) return a;
    if (bOk) return b;
    return null;
  }

  /* ---------- births ---------- */

  const birthsCache = new Map();
  function birthsWeights(year) {
    const y = clampYear(year);
    let v = birthsCache.get(y);
    if (v) return v;
    const isos = [];
    const weights = [];
    let total = 0;
    for (const iso of isoList) {
      const b = series(iso, 'births', y);
      if (b != null && b > 0) {
        isos.push(iso);
        weights.push(b);
        total += b;
      }
    }
    v = { isos, weights, total };
    birthsCache.set(y, v);
    return v;
  }

  /* ---------- income group ---------- */

  function incomeGroup(iso3, year) {
    const gdp = series(iso3, 'gdp_pc_ppp', year == null ? 2025 : year);
    if (gdp == null) {
      const now = countries[iso3] && countries[iso3].income_now;
      return INCOME_IDS.includes(now) ? now : 'LMC';
    }
    for (const t of INCOME_THRESHOLDS) if (gdp < t.max) return t.id;
    return 'HIC';
  }

  /* ---------- life paths and currency ---------- */

  const lpCache = new Map();

  function currency(iso3) {
    const own = ownEntry(content.lifePaths.countries, iso3);
    const cur = own && isPlainObject(own.currency) ? own.currency : null;
    const builtin = CURRENCY_TABLE[iso3];
    if (cur && (cur.code || cur.name)) {
      return {
        code: String(cur.code || (builtin ? builtin.code : '')),
        name: String(cur.name || (builtin ? builtin.name : CURRENCY_FALLBACK.name)),
        symbol: String(cur.symbol != null ? cur.symbol : builtin ? builtin.symbol : ''),
      };
    }
    if (builtin) return { ...builtin };
    return { ...CURRENCY_FALLBACK };
  }

  /** Country life-path institutions merged over income-group defaults over built-in defaults. Treat as read-only. */
  function lifePath(iso3) {
    let v = lpCache.get(iso3);
    if (v) return v;
    const group = incomeGroup(iso3, 2025);
    const c = countries[iso3];
    const region = c && c.region;
    let base = mergeOver(BASE_LIFE_PATH, BUILTIN_BY_INCOME[group] || {});
    base.common_destinations = (REGION_DESTINATIONS[region] || REGION_DESTINATIONS.WEU).filter((d) => d !== iso3);
    base = mergeOver(base, content.lifePaths.defaults_by_income_group[group]);
    const researched = ownEntry(content.lifePaths.countries, iso3);
    v = mergeOver(base, researched);
    if (!Array.isArray(v.common_destinations)) v.common_destinations = [];
    v.common_destinations = v.common_destinations.filter((d) => typeof d === 'string' && d !== iso3);
    if (!Array.isArray(v.key_exams)) v.key_exams = [];
    if (!Array.isArray(v.notes)) v.notes = [];
    if (!Array.isArray(v.retirement_age) || !v.retirement_age.length) v.retirement_age = cloneDeep(BASE_LIFE_PATH.retirement_age);
    v.currency = currency(iso3);
    v.incomeGroup = group;
    v.researched = !!researched;
    lpCache.set(iso3, v);
    return v;
  }

  function country(iso3) {
    return Object.prototype.hasOwnProperty.call(countries, iso3) ? countries[iso3] : undefined;
  }

  function regionName(iso3) {
    const c = country(iso3);
    return c ? REGIONS[c.region] || '' : '';
  }

  return {
    years,
    countries,
    isoList,
    content,
    meta,
    mortalityMeta: mm,
    country,
    regionName,
    series,
    mx,
    qx,
    birthsWeights,
    incomeGroup,
    lifePath,
    currency,
    periodLifeExpectancy,
    cohortLifeExpectancy,
    cohortSurvival,
  };
}

function clampYear(year) {
  const y = +year;
  if (!(y >= YEAR_MIN)) return YEAR_MIN;
  return y > YEAR_MAX ? YEAR_MAX : y;
}
