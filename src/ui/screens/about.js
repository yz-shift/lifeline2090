// About screen: what is real, what is projected, what is fiction, method notes, sources and a searchable library of
// the verified history events. Everything is computed from the loaded data so the page stays honest as content grows.
//
// mount(root, params, app) — params (all optional): { section: 'what'|'real'|'proj'|'fiction'|'method'|'sources'|
//   'library'|'disclaimer'|'origin', country: ISO3, year: number, q: string } (country/year/q preset the library).

import { h, clear, fmt, reducedMotion } from '../dom.js';
import { lineChart } from '../charts.js';
import { DATA_DATE, FIRST_YEAR, HISTORY_END, LAST_YEAR, REGIONS, AI_MODES } from '../../core/constants.js';

const WPP_URL = 'https://population.un.org/wpp/';
const WDI_URL = 'https://databank.worldbank.org/source/world-development-indicators';
const WHO_GHE_URL = 'https://www.who.int/data/gho/data/themes/mortality-and-global-health-estimates';
const ORIGINAL_URL = 'https://1in8b.life/';

const CATEGORY_ORDER = ['economy', 'war', 'conflict', 'disaster', 'epidemic', 'technology', 'politics', 'policy', 'society', 'science', 'sport', 'culture'];
const CATEGORY_LABELS = {
  economy: '经济', war: '战争', conflict: '冲突', disaster: '灾害', epidemic: '疫病', technology: '科技', politics: '政治',
  policy: '政策', society: '社会', science: '科学', sport: '体育', culture: '文化', health: '健康', climate: '气候',
  energy: '能源', demography: '人口', geopolitics: '地缘政治', space: '航天',
};
const SCOPE_LABELS = { global: '全球', regions: '区域', countries: '国家' };
const DOMAIN_LABELS = {
  demography: '人口', economy: '经济', technology: '技术', climate: '气候', health: '健康', geopolitics: '地缘政治',
  energy: '能源', society: '社会', space: '航天',
};
const WPP_LABELS = {
  pop: '总人口', births: '出生人数', le: '出生时预期寿命', le_m: '男性预期寿命', le_f: '女性预期寿命', tfr: '总和生育率',
  med_age: '年龄中位数', imr: '婴儿死亡率', q5: '五岁以下死亡率', srb: '出生性别比', cnmr: '净迁移率', mac: '平均生育年龄',
  cdr: '粗死亡率', q1560_m: '男性 15–60 岁死亡概率', q1560_f: '女性 15–60 岁死亡概率',
};
// used only when the data store does not expose countries.json meta
const WB_FALLBACK = {
  gdp_pc_ppp: '人均GDP(购买力平价)', gdp_growth: 'GDP增长率', gini: '基尼系数', poverty: '极端贫困率', unemployment: '失业率',
  youth_unemp: '青年失业率', internet: '互联网使用率', mobile: '每百人移动电话', electricity: '通电率', water: '基本饮用水普及率',
  urban: '城镇化率', sec_enroll: '中学毛入学率', ter_enroll: '高等教育毛入学率', literacy: '成人识字率',
  health_exp_pc: '人均卫生支出', physicians: '每千人医生数', homicide: '凶杀率', suicide: '自杀率', road_deaths: '道路交通死亡率',
  inflation: '通货膨胀率', ppp_factor: '购买力平价换算因子', fx_rate: '官方汇率', female_lfp: '女性劳动参与率',
  adol_fert: '青少年生育率', maternal_mort: '孕产妇死亡率', ncd_mort: '慢性病早死概率', smoking: '吸烟率',
};
const KNOBS = {
  gdp_growth_add: { label: 'GDP 年增速', unit: ' 个百分点' },
  unemployment_add: { label: '失业率', unit: ' 个百分点' },
  life_exp_add_by_2090: { label: '2090 年预期寿命', unit: ' 岁' },
  mortality_mult: { label: '死亡率', mult: true },
  inequality_add: { label: '基尼系数', unit: '' },
  internet_ceiling: { label: '互联网普及上限', unit: '%', abs: true },
  heat_risk: { label: '高温风险', unit: ' 级', abs: true },
  sea_level_risk: { label: '海平面风险', unit: ' 级', abs: true },
  conflict_risk_add: { label: '每年冲突风险', pct: true },
  migration_push_add: { label: '迁出压力', unit: ' 级' },
  retirement_age_add: { label: '退休年龄（至 2060）', unit: ' 岁' },
  education_years_add: { label: '受教育年限', unit: ' 年' },
  happiness_add: { label: '幸福感漂移', unit: '' },
};

const SECTIONS = [
  ['what', '这是什么'], ['real', '哪些是真实的'], ['proj', '哪些是推演'], ['fiction', '哪些是虚构'], ['method', '方法'],
  ['sources', '数据来源'], ['library', '历史事件库'], ['disclaimer', '免责声明'], ['origin', '与原作'],
];

const PAGE = 40;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// ---------------------------------------------------------------------------------------------------------------
// source handling

const URL_RE = /https?:\/\/[^\s<>"'，。；、）)\]]+/g;

function urlsIn(str) {
  return (String(str ?? '').match(URL_RE) || []).map((u) => u.replace(/[.,;:]+$/, ''));
}

function domainOf(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.replace(/^www\./, '');
  } catch { return null; }
}

function safeHref(u) {
  return domainOf(u) ? u : null;
}

function extLink(href, text, cls = 'c-link') {
  const ok = safeHref(href);
  if (!ok) return h('span', { class: cls }, text);
  return h('a', { class: cls, href: ok, target: '_blank', rel: 'noopener noreferrer' }, text);
}

/** Source line items: URL -> link labelled by its domain; plain citation -> text. */
function sourceNodes(sources) {
  const out = [];
  for (const src of arr(sources)) {
    const str = String(src ?? '').trim();
    if (!str) continue;
    const urls = urlsIn(str);
    if (urls.length) {
      for (const u of urls) {
        const d = domainOf(u);
        if (d) out.push(extLink(u, d, 'c-src'));
      }
    } else {
      out.push(h('span.c-src.is-cite', str.length > 90 ? `${str.slice(0, 88)}…` : str));
    }
  }
  return out;
}

function collectSources(data, content, meta) {
  const all = [];
  const push = (list) => { for (const s of arr(list)) all.push(String(s ?? '')); };
  for (const e of arr(content.history)) push(e?.sources);
  const fut = obj(content.future);
  for (const key of ['baseline_assumptions', 'milestones', 'random_shocks']) for (const x of arr(fut[key])) push(x?.sources);
  for (const d of arr(fut.dimensions)) { push(d?.sources); for (const b of arr(d?.branches)) push(b?.sources); }
  const econ = obj(content.econ);
  for (const s of Object.values(obj(obj(econ.asset_returns).series))) push(s?.sources);
  push(obj(econ.causes_of_death).sources);
  for (const lp of Object.values(obj(obj(content.lifePaths).countries))) push(lp?.sources);
  for (const v of Object.values(obj(meta.sources))) all.push(String(v ?? ''));
  const byDomain = new Map();
  for (const s of all) {
    for (const u of urlsIn(s)) {
      const d = domainOf(u);
      if (!d) continue;
      const cur = byDomain.get(d) || { domain: d, count: 0, sample: u };
      cur.count++;
      byDomain.set(d, cur);
    }
  }
  return [...byDomain.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

// ---------------------------------------------------------------------------------------------------------------
// data summaries

function countriesMeta(data) {
  return obj(data.meta?.wb_indicators ? data.meta : data.countriesMeta?.wb_indicators ? data.countriesMeta : data.raw?.countries?.meta);
}

function indicatorCoverage(data, keys) {
  const countries = obj(data.countries);
  const isos = Object.keys(countries);
  const out = {};
  for (const k of keys) {
    const years = new Map();
    let observed = 0, imputed = 0, min = Infinity, max = -Infinity;
    for (const iso of isos) {
      const c = countries[iso] || {};
      const y = c.lastObs?.[k];
      if (isNum(y)) {
        observed++;
        years.set(y, (years.get(y) || 0) + 1);
        if (y < min) min = y;
        if (y > max) max = y;
      }
      if (arr(c.imputed).includes(k)) imputed++;
    }
    let mode = null, best = -1;
    for (const [y, n] of years) if (n > best || (n === best && y > mode)) { best = n; mode = y; }
    out[k] = { observed, imputed, mode, modeShare: observed ? best / observed : 0, min: isFinite(min) ? min : null, max: isFinite(max) ? max : null, total: isos.length };
  }
  return out;
}

function knobText(key, v) {
  const k = KNOBS[key];
  if (!k || !isNum(v)) return null;
  if (k.mult ? Math.abs(v - 1) < 1e-9 : v === 0) return null; // no change from the baseline
  if (k.mult) return `${k.label} ×${v.toFixed(2)}`;
  if (k.pct) return `${k.label} ${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  if (k.abs) return `${k.label} ${trimNum(v)}${k.unit}`;
  return `${k.label} ${v > 0 ? '+' : ''}${trimNum(v)}${k.unit}`;
}
function trimNum(v) {
  const t = Math.abs(v) >= 10 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2);
  return t.includes('.') ? t.replace(/\.?0+$/, '') : t;
}

function pctText(p) {
  if (!isNum(p)) return '—';
  const v = p * 100;
  return v > 0 && v < 1 ? '<1%' : `${Math.round(v)}%`;
}

// ---------------------------------------------------------------------------------------------------------------
// building blocks

function section(id, no, title, lede, ...body) {
  return h('section.c-sec', { id: `c-about-${id}`, 'aria-labelledby': `c-about-${id}-h`, dataset: { section: id } },
    h('header.c-sec-head',
      h('span.c-sec-no.c-mono', { 'aria-hidden': 'true' }, `§${no}`),
      h('h2.c-sec-title', { id: `c-about-${id}-h` }, title)),
    lede ? h('p.c-sec-lede', lede) : null,
    ...body);
}

function tile(value, label, note) {
  return h('div.c-tile', h('div.c-tile-v', value), h('div.c-tile-l', label), note ? h('div.c-tile-n', note) : null);
}

function card(title, ...body) {
  return h('div.c-card', title ? h('h3.c-card-title', title) : null, ...body);
}

function badge(kind, text) {
  return h(`span.c-badge.c-badge-${kind}`, text);
}

function para(...children) { return h('p.c-p', ...children); }

function domainList(items) {
  return h('ul.c-domain-list', items.map((d) => h('li', extLink(d.sample, d.domain, 'c-src'), h('span.c-mono.c-dim-note', `×${d.count}`))));
}

// ---------------------------------------------------------------------------------------------------------------

export function mount(root, params = {}, app = {}) {
  const data = app?.data || {};
  const content = obj(data.content);
  const meta = countriesMeta(data);
  const history = arr(content.history).filter((e) => e && e.title);
  const future = obj(content.future);
  const dims = arr(future.dimensions);
  const milestones = arr(future.milestones);
  const shocks = arr(future.random_shocks);
  const assumptions = arr(future.baseline_assumptions);
  const econ = obj(content.econ);
  const lifePaths = obj(obj(content.lifePaths).countries);
  const names = obj(obj(content.names).countries);
  const countries = obj(data.countries);
  const nCountries = arr(data.isoList).length || Object.keys(countries).length;
  const timers = new Set();
  const cleanups = [];

  const countryName = (iso) => {
    try { return data.country?.(iso)?.name || countries[iso]?.name || iso; } catch { return countries[iso]?.name || iso; }
  };

  const wbMeta = obj(meta.wb_indicators);
  const wbKeys = Object.keys(wbMeta).length ? Object.keys(wbMeta) : (() => {
    const first = Object.values(countries)[0];
    return first?.wb ? Object.keys(first.wb) : Object.keys(WB_FALLBACK);
  })();
  const coverage = indicatorCoverage(data, wbKeys);
  const withSources = history.filter((e) => arr(e.sources).some((s) => String(s ?? '').trim()));
  const highConf = history.filter((e) => e.confidence === 'high').length;
  const life = safe(() => app.getLife?.(), null);

  // ---- page head + table of contents
  const toc = h('nav.c-toc', { 'aria-label': '本页目录' },
    SECTIONS.map(([id, title], i) => h('button.c-toc-item', { type: 'button', onclick: () => jump(id) }, h('span.c-mono', `§${i + 1}`), title)));
  const head = h('header.c-about-head',
    h('p.c-kicker', '人生长河 · 档案说明'),
    h('h1.c-about-title', '关于这条长河'),
    h('p.c-about-lede', `一条人生由三种材料写成：真实的数据、推演的世界与虚构的个人故事。这一页把它们分开说明。数据截至 ${DATA_DATE}。`),
    h('div.c-about-actions',
      app.back ? h('button.c-btn', { type: 'button', onclick: () => app.back() }, '返回') : null,
      app.go ? h('button.c-btn.is-primary', { type: 'button', onclick: () => app.go('home') }, '回到首页') : null),
    toc);

  // ---- §1 what
  const sWhat = section('what', 1, '这是什么', null,
    para(`人生长河是一个人生模拟游戏。你会在 ${FIRST_YEAR} 至 2070 年间的某一秒，降生在地球上的某个地方，按照那里真实的人口与经济条件长大、求学、工作、相爱、老去，直到离开。`),
    para(`${FIRST_YEAR}–${HISTORY_END} 年的世界使用真实历史：联合国人口数据、世界银行发展指标与逐条核实的历史事件。${HISTORY_END} 年之后的世界是一条“世界线”——由今天的趋势推演出的众多可能之一；每一次新的人生都可能走上不同的世界线。`),
    para('你可以随机降生，也可以自定义出生；在人生的关键时刻，可以选择给出的选项，也可以写下自己想做的事。AI 可用时，它会根据你之前的每一个选择编织后续的故事线，让新的抉择从你自己的过去中长出来；AI 不可用时，内置推演引擎同样会记住你的选择，并让它们影响后来的人生。'),
    h('div.c-tiles',
      tile(fmt.int(nCountries), '个国家和地区'),
      tile(`${FIRST_YEAR}–${HISTORY_END}`, '真实历史'),
      tile(`${HISTORY_END + 1}–${LAST_YEAR}`, '世界线推演'),
      tile(fmt.int(history.length), '条历史事件', withSources.length ? `${fmt.int(withSources.length)} 条附来源` : '整理中'),
      tile(fmt.int(dims.length), '个世界线维度', dims.length ? `${fmt.int(milestones.length)} 个里程碑 · ${fmt.int(shocks.length)} 种冲击` : '整理中')));

  // ---- §2 real
  const wppKeys = Object.keys(obj(meta.wpp_fields)).length ? Object.keys(meta.wpp_fields) : Object.keys(WPP_LABELS);
  const wppUnits = obj(meta.wpp_units);
  const wppList = h('ul.c-chips', wppKeys.map((k) => h('li.c-chip', WPP_LABELS[k] || k, wppUnits[k] ? h('span.c-chip-u', wppUnits[k]) : null)));
  const wbRows = wbKeys.map((k) => {
    const m = obj(wbMeta[k]);
    const c = coverage[k] || {};
    const label = m.label || WB_FALLBACK[k] || k;
    const modelled = !c.observed;
    const lastObs = !modelled
      ? `${c.mode} 年${c.modeShare < 0.999 && c.min != null && c.max != null && c.min !== c.max ? `（${c.min}–${c.max}）` : ''}`
      : m.rule === 'derived' ? '由人均 GDP 推导' : m.rule === 'model' ? '模型推算，按观测校准' : '无观测';
    const cov = modelled ? '—' : `${fmt.int(c.observed)} / ${fmt.int(c.total)}${c.imputed ? `，${fmt.int(c.imputed)} 个补齐` : ''}`;
    return h('tr', h('th', { scope: 'row' }, label, m.unit && m.unit !== '$' && m.unit !== '%' ? h('span.c-unit', ` ${m.unit}`) : null), h('td.c-mono', lastObs), h('td.c-mono', cov));
  });
  const totalImputed = wbKeys.reduce((a, k) => a + (coverage[k]?.imputed || 0), 0);
  const assetSeries = obj(obj(econ.asset_returns).series);
  const assetYears = arr(obj(econ.asset_returns).years);
  const cod = obj(econ.causes_of_death);
  const catCounts = new Map();
  for (const e of history) catCounts.set(e.category || 'other', (catCounts.get(e.category || 'other') || 0) + 1);
  const cats = [...catCounts.entries()].sort((a, b) => b[1] - a[1]);

  const sReal = section('real', 2, '哪些是真实的', `${HISTORY_END} 年及以前的世界背景来自公开的权威数据；你出生的国家、那一年有多少孩子出生、你能活多久的基准概率，都来自这里。`,
    card('联合国《世界人口展望 2024》（UN WPP 2024）',
      para('全部 ', h('strong', fmt.int(nCountries)), ' 个国家和地区的人口序列与分年龄、分性别的生命表。“你出生在哪里”按当年各国的真实出生人数抽样，“你能活多久”的基准概率来自这些生命表。'),
      wppList,
      h('p.c-note', 'WPP 对 2023 年及以前给出估计值，此后为联合国中方案预测；游戏把 2026 年及以前当作真实背景，之后的人口与寿命沿中方案并叠加世界线调整。'),
      h('p.c-links', extLink(WPP_URL, 'population.un.org/wpp'))),
    card('世界银行《世界发展指标》（WDI）',
      para(`${fmt.int(wbKeys.length)} 项国家指标，每个国家保留到最后一次真实观测；表中是多数国家的最近观测年份与有观测的国家数。`),
      h('div.c-table-wrap', h('table.c-table',
        h('caption.c-sr', '世界银行指标的最近观测年份与覆盖范围'),
        h('thead', h('tr', h('th', { scope: 'col' }, '指标'), h('th', { scope: 'col' }, '最近观测'), h('th', { scope: 'col' }, '有观测的国家'))),
        h('tbody', wbRows))),
      totalImputed ? h('p.c-note', `个别国家缺少某项指标时，用同一地区的中位数补齐（共 ${fmt.int(totalImputed)} 项次），这些数值不是该国的真实观测。`) : null,
      meta.sources?.twn ? h('p.c-note', '中国台湾地区：WDI 未覆盖，人均 GDP 按韩国数据与 IMF 购买力平价比例估算，其余缺口参照韩国。') : null,
      h('p.c-links', extLink(WDI_URL, 'databank.worldbank.org'))),
    card('核实过的历史事件',
      history.length
        ? para(`${fmt.int(history.length)} 条 ${FIRST_YEAR}–${HISTORY_END} 年的全球、区域与国家事件，`, h('strong', `${fmt.int(withSources.length)} 条附有来源链接`), `，${fmt.int(highConf)} 条可信度为“高”。它们出现在新闻栏里、影响所在国家的经济与安全，也会进入你的人生记录。`)
        : para('历史事件库仍在整理中，稍后再来看看。'),
      cats.length ? h('ul.c-chips', cats.map(([c, n]) => h('li.c-chip', CATEGORY_LABELS[c] || c, h('span.c-chip-u.c-mono', String(n))))) : null,
      history.length ? h('p.c-links', h('button.c-btn.is-small', { type: 'button', onclick: () => jump('library') }, '打开历史事件库')) : null),
    (Object.keys(assetSeries).length || arr(cod.causes).length) ? card('经济与死因参考',
      Object.keys(assetSeries).length ? para(`资产回报：${Object.values(assetSeries).map((s) => s?.name).filter(Boolean).join('、')}`, assetYears.length ? `，${assetYears[0]}–${assetYears[assetYears.length - 1]} 年的真实年度回报，用于你的储蓄与投资。` : '。') : null,
      arr(cod.causes).length ? para(`死因构成：世界卫生组织全球卫生估计（GHE），按年龄段 × 收入组的 ${arr(cod.causes).length} 类死因。`, ' ', extLink(WHO_GHE_URL, 'who.int')) : null) : null,
    Object.keys(lifePaths).length ? card('各国制度路径',
      para(`${fmt.int(Object.keys(lifePaths).length)} 个国家的入学年龄、义务教育年限、关键考试、兵役、法定婚龄、初婚年龄中位数与退休年龄，其余国家按收入组使用默认值。`)) : null);

  // ---- §3 projection
  const lifeLine = life?.worldLabel ? h('p.c-callout', '你当前人生所在的世界线：', h('strong', String(life.worldLabel))) : null;
  const ruleList = h('dl.c-rules', wbKeys.filter((k) => wbMeta[k]?.projection).map((k) => [
    h('dt', wbMeta[k].label || WB_FALLBACK[k] || k), h('dd', String(wbMeta[k].projection)),
  ]));
  const dimList = dims.length ? h('div.c-dims', dims.map((d) => h('div.c-dim',
    h('h4.c-dim-title', String(d.title || d.id || '')),
    d.description ? h('p.c-small.c-dim-desc', String(d.description)) : null,
    h('ul.c-branches', arr(d.branches).map((b) => {
      const mods = Object.entries(obj(b.modifiers)).map(([k, v]) => knobText(k, Number(v))).filter(Boolean);
      const p = Number(b.prob);
      return h('li.c-branch',
        h('div.c-branch-row',
          h('span.c-branch-name', String(b.title || b.id || '')),
          h('span.c-prob', { role: 'img', 'aria-label': `概率 ${pctText(p)}` }, h('i', { style: { width: `${Math.max(2, Math.min(100, p * 100 || 0))}%` } })),
          h('span.c-prob-v.c-mono', pctText(p))),
        (b.description || b.basis || mods.length) ? h('details.c-branch-more',
          h('summary', '展开说明'),
          b.description ? h('p', String(b.description)) : null,
          mods.length ? h('p.c-mods', `参数：${mods.join(' · ')}`) : null,
          b.basis ? h('p.c-mods', `依据：${String(b.basis)}`) : null,
          arr(b.sources).length ? h('p.c-srcs', sourceNodes(b.sources)) : null) : null);
    }))))) : para(`世界线维度仍在整理中；在此之前，${HISTORY_END} 年之后沿用下面的指标外推规则。`);

  const shockList = shocks.length ? h('ul.c-list', shocks.map((sk) => h('li',
    h('strong', String(sk.title || sk.id)),
    h('span.c-mono.c-dim-note', ` 每年 ${isNum(Number(sk.annual_prob)) ? `${(Number(sk.annual_prob) * 100).toFixed(Number(sk.annual_prob) < 0.01 ? 1 : 0)}%` : '—'}${sk.duration_years ? ` · 持续约 ${sk.duration_years} 年` : ''}`),
    sk.basis ? h('p.c-small', String(sk.basis)) : null))) : null;
  const msSorted = milestones.slice().sort((a, b) => (Number(a.year) || 0) - (Number(b.year) || 0));
  const msList = msSorted.length ? h('details.c-more',
    h('summary', `查看全部 ${msSorted.length} 个可能的里程碑`),
    h('ul.c-list', msSorted.map((m) => h('li',
      h('span.c-mono.c-ms-year', String(m.year ?? '')),
      h('strong', String(m.title || m.id)),
      isNum(Number(m.prob)) ? h('span.c-mono.c-dim-note', ` 概率 ${pctText(Number(m.prob))}`) : null,
      Object.keys(obj(m.requires)).length ? h('span.c-dim-note', ' · 仅在特定世界线') : null,
      m.basis ? h('p.c-small', String(m.basis)) : null)))) : null;
  const assumptionList = assumptions.length ? h('ul.c-list', assumptions.map((a) => h('li',
    a.domain ? h('span.c-chip.is-inline', DOMAIN_LABELS[a.domain] || String(a.domain)) : null,
    ' ', String(a.statement || ''),
    arr(a.sources).length ? h('span.c-srcs', sourceNodes(a.sources)) : null))) : null;

  const exampleChart = (() => {
    const years = arr(meta.years).length ? arr(meta.years) : arr(data.years);
    if (!years.length || typeof data.birthsWeights !== 'function') return null;
    const ys = years.filter((y) => y <= LAST_YEAR);
    const vals = ys.map((y) => { const t = safe(() => data.birthsWeights(y)?.total, null); return isNum(t) ? t * 1000 : null; });
    if (!vals.some(isNum)) return null;
    return h('figure.c-figure',
      lineChart([{ name: '全球出生人数', values: vals, color: 'var(--accent)' }], {
        years: ys, height: 200, projectionFrom: HISTORY_END + 1, title: '全球每年出生人数', format: (v) => `${fmt.cn(v)}`,
      }),
      h('figcaption.c-figcap', `示例：全球每年出生人数（UN WPP 2024）。斜纹区域为 ${HISTORY_END + 1} 年起的推演部分，游戏中所有图表都用同样的方式区分真实与推演。`));
  })();

  const sProj = section('proj', 3, '哪些是推演', `${HISTORY_END} 年 10 月之后的一切都是推演：根据今天的数据与趋势构造的情景，用来给人生故事一个可信的背景。推演不是预测。`,
    lifeLine,
    h('div.c-legend-demo', badge('real', '真实历史'), badge('proj', '推演'), h('span.c-small', '新闻栏、人生地图与图表都会这样标注。')),
    exampleChart,
    card('国家指标如何外推', para('每项指标在最后一次真实观测之后，按下面的规则延伸到 2100 年；人口、出生与寿命沿用联合国中方案。'), ruleList),
    card('世界线：每个维度抽一个分支',
      para(dims.length
        ? `每次新的人生会抽取一条世界线：${dims.length} 个维度各按概率选出一个分支。分支通过一组参数（经济增速、失业、寿命、不平等、气候与冲突风险等）改变 ${HISTORY_END + 1} 年之后的国家指标与死亡率。`
        : '每次新的人生会抽取一条世界线：各维度按概率选出一个分支，分支通过一组参数改变之后的国家指标与死亡率。'),
      dimList),
    card('里程碑与随机冲击',
      para(`里程碑 ${fmt.int(milestones.length)} 个：在满足世界线条件时按概率在某个年份发生；随机冲击 ${fmt.int(shocks.length)} 种：每年按概率独立抽取，例如新的大流行或地区冲突。`),
      shockList, msList),
    assumptionList ? card('基线假设', assumptionList) : null);

  // ---- §4 fiction
  const sFiction = section('fiction', 4, '哪些是虚构', '你的人生是虚构的，即使它发生在真实的年代与真实的国家。',
    h('ul.c-list.is-plain',
      h('li', h('strong', '你和你身边的人。'), `名字从各国常见的姓名中随机组合${Object.keys(names).length ? `（${fmt.int(Object.keys(names).length)} 个国家的姓名库）` : ''}；家人、伴侣、孩子、朋友与同龄人都是虚构人物，如有雷同纯属巧合。`),
      h('li', h('strong', '个人事件。'), '升学、恋爱、疾病、意外、机遇……按年龄、国家、时代与你的处境以概率生成。概率尽量贴近真实，但事件本身是虚构的。'),
      h('li', h('strong', 'AI 叙事。'), '出生故事、抉择情境、选择的结果、后续故事线、传记与墓志铭可能由 AI 写成。它们是文学化的虚构，可能与事实有出入。'),
      h('li', h('strong', '你与真实事件。'), '当真实的历史事件进入你的人生时，“你”只是千千万万普通亲历者之一；游戏不会编造真实人物的言论或行为。'),
      h('li', h('strong', '世界线上的具体事件。'), `${HISTORY_END} 年之后的里程碑与冲击是假设情景，不代表它们一定或可能发生。`)));

  // ---- §5 method
  const aiState = app.ai?.available
    ? `当前：AI 已启用（${AI_MODES[app.ai?.mode] || AI_MODES[app.settings?.aiMode] || '标准'}）。`
    : '当前：使用内置推演引擎（AI 未启用或不可用）。';
  const sMethod = section('method', 5, '方法', '每一年都按同一套规则推进：先由数据给出概率，再由你的处境和选择调整。',
    card('寿命与死亡',
      para('每一年离世的概率 = 联合国生命表中该国、该年、该性别、该年龄组的死亡率 m（年概率 q = 1 − e', h('sup', '−m'), '）× 个人系数 × 世界线系数。'),
      para('个人系数由健康值、家庭与收入位置、慢性病、吸烟等习惯组成，并经过归一化：全体人口的平均系数约为 1，因此模拟出的寿命分布与联合国的数据一致；系数被限制在 0.25–6 倍之间。'),
      para(`2024 年及以前的生命表已经包含真实发生的危机死亡（如新冠疫情与战争），历史事件不会再重复计入，只用于判断死因与叙事。${HISTORY_END + 1} 年起，再乘上世界线情景、随机冲击与未来事件的系数。`),
      para('死因按世界卫生组织的年龄段 × 收入组死因构成抽取，并按处境调整：战乱提高暴力死亡的比重，疫情提高传染病，吸烟提高心血管、癌症与呼吸系统疾病。')),
    card('收入与财富',
      para('收入 = 人均 GDP × 居民消费占比 ×（就业者约 1.5 倍）× 由基尼系数决定的对数正态分布在你所处收入百分位上的位置。失业风险来自失业率与青年失业率，退休年龄来自各国制度。'),
      para('所有金额以 2021 年国际元（购买力平价、扣除通胀）计算，显示时按 2021 年物价换算成当地货币。储蓄与投资在 2000–2025 年使用真实的年度资产回报，之后按世界线模拟。')),
    card('教育、家庭与迁徙',
      para('入学与升学概率来自中学与高等教育毛入学率，并受家庭条件、城乡、性别与时代影响；关键考试来自各国制度。结婚概率按各国初婚年龄中位数校准，生育按总和生育率与平均生育年龄。'),
      para('迁徙只通过抉择、故事线与事件发生，可行性取决于你的钱、学历、目的地与常见的迁移路线。')),
    card('同一秒出生的人',
      para('与你同一秒降生的若干人按当年各国出生人数抽样，用同样的模型走完他们的一生，作为你人生的对照。')),
    card('AI 的角色与离线引擎',
      para('AI 负责出生故事、每个抉择的情境与选项、你自由行动的结果、由选择引出的后续故事线，以及最后的传记与墓志铭。它会读到你的处境、最近的经历、过去的选择、所在国家的真实数字与当年的世界事件，因此新的抉择会从你自己的过去中长出来。'),
      para('所有 AI 输出都经过校验：数值被限制在合理范围，不存在的国家代码会被丢弃，不可用时立即改用内置推演引擎。内置引擎有自己的事件库与故事线模板，没有 AI 也能完整地玩完一生。'),
      h('p.c-callout', aiState)));

  // ---- §6 sources
  const domains = collectSources(data, content, meta);
  const sSources = section('sources', 6, '数据来源', '主要数据集与内容中引用到的全部来源网站。',
    h('ul.c-list.is-plain.c-primary-src',
      h('li', extLink(WPP_URL, 'United Nations, World Population Prospects 2024'), h('span.c-small', ' — 人口、出生、生命表（中方案）')),
      h('li', extLink(WDI_URL, 'World Bank, World Development Indicators'), h('span.c-small', ` — 国家经济与社会指标（访问于 ${DATA_DATE}）`)),
      h('li', extLink(WHO_GHE_URL, 'WHO, Global Health Estimates'), h('span.c-small', ' — 按年龄与收入组的死因构成'))),
    domains.length
      ? h('div.c-domains',
        h('h3.c-card-title', `内容引用的来源网站（${domains.length} 个，按引用次数排序）`),
        domainList(domains.slice(0, 48)),
        domains.length > 48 ? h('details.c-more', h('summary', `其余 ${domains.length - 48} 个来源网站`), domainList(domains.slice(48))) : null)
      : para('内容来源仍在整理中。'));

  // ---- §7 library
  const library = buildLibrary(history, { countries, countryName, params, timers, cleanups });
  const sLibrary = section('library', 7, '历史事件库', `${FIRST_YEAR}–${HISTORY_END} 年核实过的历史事件，可按年份、国家与类别筛选。每一条都附有来源。`, library);

  // ---- §8 disclaimer
  const sDisclaimer = section('disclaimer', 8, '免责声明', null,
    h('ul.c-list.is-plain',
      h('li', h('strong', '推演不是预测。'), `${HISTORY_END} 年之后的内容是基于当下趋势构造的情景，用来让故事有可信的背景，不代表对未来的判断，也不代表任何立场。`),
      h('li', h('strong', '不构成任何建议。'), '游戏中的健康、教育、职业、迁移与投资结果都是模拟，不构成医疗、法律、财务或移民建议。'),
      h('li', h('strong', '数据有误差与缺口。'), '官方统计本身存在误差；缺失的指标用地区中位数补齐，外推规则是简化的。具体到某一个人，现实的差异远比模型大。'),
      h('li', h('strong', '关于沉重的话题。'), '战争、灾害、疾病与死亡是许多真实人生的一部分。游戏以中性、克制的方式陈述它们，不渲染暴力。如果你正经历困难，请向身边的人或当地的专业机构求助。')));

  // ---- §9 origin
  const sOrigin = section('origin', 9, '与原作', null,
    para('人生长河受到 ', extLink(ORIGINAL_URL, '1in8b.life'), ' 这一创意的启发：在真实世界的数据里随机降生，然后度过一生。'),
    para('本作是独立实现，与原作没有共享任何代码、文字或美术。2000–2090 年的世界线推演、自定义出生、自由书写的人生选择、由选择驱动的 AI 故事线、同一秒出生的同龄人对照、登记卡片与人生地图，均为本作的设计。'));

  const page = h('article.c-about',
    head,
    h('div.c-about-body', sWhat, sReal, sProj, sFiction, sMethod, sSources, sLibrary, sDisclaimer, sOrigin),
    h('footer.c-about-foot', h('p', `人生长河 · ${FIRST_YEAR}–${LAST_YEAR} · 真实数据 + 推演 · 数据截至 ${DATA_DATE}`)));

  clear(root);
  root.append(page);

  function jump(id) {
    const el = page.querySelector(`#c-about-${id}`);
    if (!el) return;
    try { el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }); } catch { el.scrollIntoView(); }
    const hEl = el.querySelector('h2');
    if (hEl) { hEl.setAttribute('tabindex', '-1'); try { hEl.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }

  const target = params?.section || (params?.country || params?.year || params?.q ? 'library' : null);
  if (target && SECTIONS.some(([id]) => id === target)) {
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
    raf(() => jump(target));
  }

  return () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const fn of cleanups) { try { fn(); } catch { /* ignore */ } }
  };
}

function safe(fn, fallback) {
  try { const v = fn(); return v === undefined ? fallback : v; } catch { return fallback; }
}

// ---------------------------------------------------------------------------------------------------------------
// history library

function eventYears(e) {
  const y0 = Number(e.year) || Number(String(e.start || '').slice(0, 4)) || null;
  const y1 = Number(e.end_year) || Number(String(e.end || '').slice(0, 4)) || y0;
  return [y0, Math.max(y0 || 0, y1 || 0) || y0];
}

function buildLibrary(history, { countries, countryName, params, timers }) {
  const wrap = h('div.c-lib');
  if (!history.length) {
    wrap.append(h('p.c-empty', '历史事件库仍在整理中，稍后再来看看。'));
    return wrap;
  }
  const years = history.map((e) => eventYears(e)).flat().filter(isNum);
  let minY = years.length ? Math.max(FIRST_YEAR, Math.min(...years)) : FIRST_YEAR;
  let maxY = years.length ? Math.min(HISTORY_END, Math.max(...years)) : HISTORY_END;
  if (!(minY <= maxY)) { minY = FIRST_YEAR; maxY = HISTORY_END; }
  const cats = CATEGORY_ORDER.filter((c) => history.some((e) => e.category === c))
    .concat([...new Set(history.map((e) => e.category).filter((c) => c && !CATEGORY_ORDER.includes(c)))]);
  const isoOptions = Object.keys(countries)
    .map((iso) => [iso, countryName(iso)])
    .sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'zh-Hans-CN'));
  const regionOf = (iso) => countries[iso]?.region || null;

  const yearOpts = (sel) => {
    const out = [];
    for (let y = minY; y <= maxY; y++) out.push(h('option', { value: String(y), selected: y === sel }, String(y)));
    return out;
  };
  const presetYear = isNum(Number(params?.year)) && params?.year != null ? Math.max(minY, Math.min(maxY, Number(params.year))) : null;
  const presetCountry = params?.country && countries[params.country] ? params.country : '';

  const q = h('input.c-input', { type: 'search', placeholder: '搜索标题或摘要', 'aria-label': '搜索历史事件', value: params?.q ? String(params.q) : '' });
  const from = h('select.c-select', { 'aria-label': '起始年份' }, yearOpts(presetYear ?? minY));
  const to = h('select.c-select', { 'aria-label': '结束年份' }, yearOpts(presetYear ?? maxY));
  const country = h('select.c-select', { 'aria-label': '国家或地区' },
    h('option', { value: '' }, '全部国家和地区'),
    isoOptions.map(([iso, name]) => h('option', { value: iso, selected: iso === presetCountry }, `${name}`)));
  const cat = h('select.c-select', { 'aria-label': '类别' },
    h('option', { value: '' }, '全部类别'),
    cats.map((c) => h('option', { value: c }, CATEGORY_LABELS[c] || c)));
  const sort = h('select.c-select', { 'aria-label': '排序' },
    h('option', { value: 'time' }, '按时间'), h('option', { value: 'time-desc' }, '时间倒序'), h('option', { value: 'imp' }, '按重要程度'));
  const incGlobal = h('input', { type: 'checkbox', checked: true });
  const globalLabel = h('label.c-check', incGlobal, '含全球与区域事件');
  const count = h('p.c-lib-count', { 'aria-live': 'polite' });
  const list = h('ol.c-ev-list');
  const more = h('button.c-btn.c-lib-more', { type: 'button' }, '显示更多');
  const reset = h('button.c-btn.is-small', { type: 'button' }, '清除筛选');
  let shown = PAGE;
  let filtered = [];

  const controls = h('div.c-lib-controls',
    h('div.c-field.is-wide', h('span.c-field-l', '搜索'), q),
    h('div.c-field', h('span.c-field-l', '年份'), h('div.c-range', from, h('span.c-range-sep', '至'), to)),
    h('div.c-field', h('span.c-field-l', '国家'), country),
    h('div.c-field', h('span.c-field-l', '类别'), cat),
    h('div.c-field', h('span.c-field-l', '排序'), sort),
    h('div.c-field.is-row', globalLabel, reset));

  function apply() {
    const text = q.value.trim().toLowerCase();
    let y0 = Number(from.value), y1 = Number(to.value);
    if (y0 > y1) [y0, y1] = [y1, y0];
    const iso = country.value;
    const region = iso ? regionOf(iso) : null;
    const c = cat.value;
    const withWide = incGlobal.checked;
    globalLabel.classList.toggle('is-disabled', !iso);
    filtered = history.filter((e) => {
      const [a, b] = eventYears(e);
      if (!isNum(a) || b < y0 || a > y1) return false;
      if (c && e.category !== c) return false;
      if (iso) {
        const direct = arr(e.countries).includes(iso);
        const wide = withWide && (e.scope === 'global' || (e.scope === 'regions' && region && arr(e.regions).includes(region)));
        if (!direct && !wide) return false;
      }
      if (text) {
        const hay = `${e.title || ''} ${e.summary || ''} ${e.id || ''}`.toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
    if (sort.value === 'time-desc') filtered.sort((a, b) => eventYears(b)[0] - eventYears(a)[0] || (b.importance || 0) - (a.importance || 0));
    else if (sort.value === 'imp') filtered.sort((a, b) => (b.importance || 0) - (a.importance || 0) || eventYears(a)[0] - eventYears(b)[0]);
    else filtered.sort((a, b) => eventYears(a)[0] - eventYears(b)[0] || (b.importance || 0) - (a.importance || 0));
    shown = PAGE;
    render();
  }

  function render() {
    clear(list);
    const slice = filtered.slice(0, shown);
    for (const e of slice) list.append(eventItem(e, countryName, country.value));
    count.textContent = filtered.length
      ? `共 ${filtered.length} 条${filtered.length > slice.length ? `，显示前 ${slice.length} 条` : ''}`
      : '没有符合条件的事件，换个筛选试试。';
    more.hidden = filtered.length <= shown;
    more.textContent = `再显示 ${Math.min(PAGE, filtered.length - shown)} 条`;
  }

  let debounce = null;
  q.addEventListener('input', () => {
    if (debounce) { clearTimeout(debounce); timers.delete(debounce); }
    debounce = setTimeout(() => { timers.delete(debounce); debounce = null; apply(); }, 150);
    timers.add(debounce);
  });
  for (const el of [from, to, country, cat, sort, incGlobal]) el.addEventListener('change', apply);
  more.addEventListener('click', () => { shown += PAGE; render(); });
  reset.addEventListener('click', () => {
    q.value = '';
    from.value = String(minY);
    to.value = String(maxY);
    country.value = '';
    cat.value = '';
    sort.value = 'time';
    incGlobal.checked = true;
    apply();
  });

  wrap.append(controls, count, list, more);
  apply();
  return wrap;
}

function eventItem(e, countryName, focusIso) {
  const [a, b] = eventYears(e);
  const when = b && b !== a ? `${a}–${b}` : String(a ?? '');
  const imp = Math.max(0, Math.min(5, Math.round(Number(e.importance) || 0)));
  // when the library is filtered by a country, list that country first so the reason for the match is visible
  const cs = arr(e.countries).slice().sort((x, y) => (y === focusIso) - (x === focusIso));
  const regions = arr(e.regions).map((r) => REGIONS[r] || r);
  let where = '';
  if (e.scope === 'global') where = cs.length ? `全球；受影响较大：${cs.slice(0, 6).map(countryName).join('、')}${cs.length > 6 ? ` 等 ${cs.length} 个国家和地区` : ''}` : '全球';
  else if (e.scope === 'regions') where = [regions.join('、'), cs.length ? cs.slice(0, 6).map(countryName).join('、') + (cs.length > 6 ? ` 等 ${cs.length} 个` : '') : ''].filter(Boolean).join('；');
  else where = cs.slice(0, 8).map(countryName).join('、') + (cs.length > 8 ? ` 等 ${cs.length} 个国家和地区` : '');
  const hooks = arr(e.personal_hooks).map(String).filter(Boolean);
  const srcs = sourceNodes(e.sources);
  const conf = e.confidence === 'high' ? '高' : e.confidence === 'medium' ? '中' : null;
  return h('li.c-ev',
    h('div.c-ev-when.c-mono', when),
    h('div.c-ev-body',
      h('div.c-ev-meta',
        e.category ? h('span.c-chip.is-inline', CATEGORY_LABELS[e.category] || String(e.category)) : null,
        e.scope ? h('span.c-ev-scope', SCOPE_LABELS[e.scope] || String(e.scope)) : null,
        imp ? h('span.c-ev-imp', { role: 'img', 'aria-label': `重要程度 ${imp}/5` }, '●'.repeat(imp) + '○'.repeat(5 - imp)) : null),
      h('h4.c-ev-title', String(e.title)),
      e.summary ? h('p.c-ev-sum', String(e.summary)) : null,
      where ? h('p.c-ev-where', where) : null,
      hooks.length ? h('details.c-ev-hooks', h('summary', '普通人可能的经历'), h('ul', hooks.map((x) => h('li', x)))) : null,
      (srcs.length || conf) ? h('p.c-ev-src', srcs.length ? h('span.c-small', '来源：') : null, srcs, conf ? h('span.c-ev-conf', `可信度：${conf}`) : null) : null));
}
