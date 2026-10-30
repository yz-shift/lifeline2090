// Home: the thesis (one life among ~4 births per second), a live world-births counter from UN WPP births, the start
// panel (random birth with era choice, or custom birth, and a folded "开始之前" block with how automatic choices lean,
// reflection pauses, 略过可怕的情节, music and the player's real birthplace for the comparison at the end), a resume
// card for an unfinished life, the archive index, and a short note on what in this simulation is real, projected or
// fiction.

import { h, clear, fmt, storage, reducedMotion } from '../dom.js';
import { FIRST_YEAR, HISTORY_END, LAST_YEAR, DATA_DATE, AI_MODES, LIFE_LENGTH_OPTIONS } from '../../core/constants.js';
import * as saves from '../../social/saves.js';
import { readCollection } from '../../social/collection.js';
import { ACHIEVEMENTS } from '../../core/achievements.js';

const ERA_KEY = 'll2090.era';
const PREFS_OPEN_KEY = 'll2090.homePrefs';
const ERAS = [
  { id: '2000', label: '2000 年', sub: '默认 · 经历全部真实历史', range: [2000, 2000] },
  { id: 'history', label: '2000–2026', sub: '真实历史中的某一年', range: [2000, 2026] },
  { id: 'now', label: '现在 · 2026', sub: '和今天的婴儿同年出生', range: [2026, 2026] },
  { id: 'future', label: '未来 2027–2070', sub: '出生在推演的世界线里', range: [2027, 2070] },
  { id: 'any', label: '完全随机', sub: '2000–2070 年，按出生人数加权', range: [2000, 2070] },
];

/** world births per year (persons) for a calendar year, from WPP births (thousands) */
export function worldBirthsPerYear(data, year) {
  try {
    const w = data.birthsWeights?.(year);
    if (w && w.total > 0) return w.total * 1000;
  } catch { /* fall through */ }
  let t = 0;
  for (const iso of data.isoList || Object.keys(data.countries || {})) {
    let v = null;
    try { v = data.series?.(iso, 'births', year); } catch { v = null; }
    if (v > 0) t += v;
  }
  return t * 1000;
}

function lifeLine(st, data) {
  const p = st.person || {};
  const sex = (p.sex || st.birth?.sex) === 'female' ? '女' : '男';
  const iso = p.country || st.birth?.country;
  const cname = data.countries?.[iso]?.name || iso || '';
  return `${sex} · ${st.age ?? 0} 岁 · ${st.year ?? st.birth?.year ?? ''} 年 · ${cname}`;
}

export function mount(root, params, app) {
  const { data } = app;
  const disposers = [];
  let alive = true;

  // ------------------------------------------------ numbers from the data
  const now = new Date();
  const year = Math.min(2100, Math.max(FIRST_YEAR, now.getFullYear()));
  const perYear = worldBirthsPerYear(data, year) || 132.5e6;
  const yearStart = Date.UTC(year, 0, 1);
  const yearMs = Date.UTC(year + 1, 0, 1) - yearStart;
  const perSec = perYear / (yearMs / 1000);
  const openedAt = Date.now();
  const bornBy = (t) => perYear * Math.max(0, t - yearStart) / yearMs;
  const nCountries = (data.isoList || Object.keys(data.countries || {})).length;
  const counts = data.content?.meta?.counts || {};

  // ------------------------------------------------ hero
  const counterNum = h('span.ll-counter-num', fmt.int(bornBy(Date.now())));
  const sinceOpen = h('span.ll-counter-since', '0');
  const tick = () => {
    if (!alive) return;
    const t = Date.now();
    counterNum.textContent = fmt.int(bornBy(t));
    sinceOpen.textContent = fmt.int(Math.floor(bornBy(t) - bornBy(openedAt)));
  };
  const timer = setInterval(tick, reducedMotion() ? 1000 : 250);
  disposers.push(() => clearInterval(timer));

  const hero = h('section.ll-hero', { 'aria-labelledby': 'll-hero-title' },
    h('div.ll-hero-text',
      h('p.ll-eyebrow', `一个人的户籍档案 · ${FIRST_YEAR}–${LAST_YEAR}`),
      h('h1#ll-hero-title.ll-hero-title',
        h('span.ll-hero-line', '每秒约有 ', h('span.ll-hero-num', String(Math.round(perSec))), ' 个婴儿降生，'),
        h('span.ll-hero-line', '这一次，轮到你。')),
      h('p.ll-hero-lede',
        `你会按真实的出生概率降生在某个国家、某个家庭：${FIRST_YEAR}–${HISTORY_END} 年经历的是真实发生过的历史，`,
        `${HISTORY_END + 1} 年以后，走进依据今天的人口、经济与技术趋势推演出的世界线，一直到 ${LAST_YEAR} 年。`),
      h('p.ll-hero-lede.ll-hero-lede--2',
        '每个关键路口都可以自己写下选择。你做过的选择会被记住，后来的处境由它们而来，不套用固定剧本。'),
      h('div.ll-counter', { 'aria-live': 'off' },
        h('p.ll-counter-label', `${year} 年以来全球出生（估算）`),
        counterNum,
        h('p.ll-counter-sub',
          h('span', `按联合国《世界人口展望 2024》，${year} 年全球约出生 ${fmt.cn(perYear)} 人，即每秒 ${perSec.toFixed(1)} 人。`),
          h('span.ll-counter-open', '你打开这一页以来：', sinceOpen, ' 人')))),
    startPanel());

  // ------------------------------------------------ start panel
  function startPanel() {
    let era = storage.get(ERA_KEY, '2000');
    if (!ERAS.some((e) => e.id === era)) era = '2000';
    const ruler = app.ui.yearRuler({ range: ERAS.find((e) => e.id === era).range, size: 'hero', label: '出生年份范围' });
    const group = app.ui.boxGroup({
      id: 'll-era', name: 'll-era', legend: '出生年份', value: era,
      options: ERAS.map((e) => ({ value: e.id, label: e.label, sub: e.sub })),
      onChange: (v) => {
        era = v;
        storage.set(ERA_KEY, v);
        ruler.setRange(ERAS.find((e) => e.id === v).range);
      },
    });
    const goBtn = h('button.ll-btn.ll-btn--ink.ll-btn--big', { type: 'button', onclick: () => app.go('birth', { mode: 'random', yearMode: era }) }, '随机出生');
    return h('aside.ll-start.ll-doc', { 'aria-labelledby': 'll-start-title' },
      h('div.ll-doc-head',
        h('h2#ll-start-title.ll-doc-title', '出生登记申请'),
        h('p.ll-doc-no', '表 A-01')),
      h('p.ll-start-lede', '国家、性别、城乡与家境按当年真实的出生人数和分布抽取。'),
      group,
      h('div.ll-start-ruler', ruler,
        h('p.ll-legend',
          h('span.ll-legend-item', h('i.ll-legend-real', { 'aria-hidden': 'true' }), `真实历史 ${FIRST_YEAR}–${HISTORY_END}`),
          h('span.ll-legend-item', h('i.ll-legend-proj', { 'aria-hidden': 'true' }), `推演 ${HISTORY_END + 1}–${LAST_YEAR}`))),
      h('div.ll-start-actions',
        goBtn,
        h('button.ll-btn.ll-btn--line.ll-btn--big', { type: 'button', onclick: () => app.go('birth', { mode: 'custom' }) }, '自定义出生')),
      h('p.ll-start-note', '自定义出生可以指定年份、国家、家境，或用一段话写下特殊的出身。'),
      prefsBlock());
  }

  // ------------------------------------------------ "开始之前": how this life is played (saved in settings)
  function prefsBlock() {
    const ui = app.ui || {};
    if (typeof ui.switchField !== 'function') return null;
    const st = app.settings;
    const textures = Array.isArray(app.textures) ? app.textures : [];
    const sumEl = h('span.ll-prefs-now');
    const paintSum = () => {
      const t = textures.find((x) => x.id === st.autoTexture);
      const c = st.compareIso && app.data?.countries?.[st.compareIso];
      sumEl.textContent = [
        t ? `倾向：${t.label}` : '',
        st.reflections !== false ? '节点停顿' : '不停顿',
        st.gentle ? '温和叙述' : '',
        st.music !== false ? '音乐开' : '音乐关',
        c ? `对照：${c.name}` : '',
      ].filter(Boolean).join(' · ');
    };
    const save = (patch) => { app.saveSettings(patch); paintSum(); };
    const texture = typeof ui.texturePicker === 'function'
      ? ui.texturePicker({ id: 'll-home-texture', value: st.autoTexture, variant: 'select', legend: '自动选择时的倾向', onChange: (v) => save({ autoTexture: v }) })
      : null;
    const sw = (id, label, key, sub, invert = false) => ui.switchField({
      id, label, sub, checked: invert ? st[key] !== false : !!st[key],
      onChange: (on) => save({ [key]: on }),
    });
    const cmp = typeof ui.compareFields === 'function'
      ? ui.compareFields({ id: 'll-home-cmp', data: app.data, iso: st.compareIso, year: st.compareYear, onChange: (v) => save(v) })
      : null;
    paintSum();
    const det = h('details.ll-prefs', {
      open: !!storage.get(PREFS_OPEN_KEY, false),
      ontoggle: () => storage.set(PREFS_OPEN_KEY, !!det.open),
    },
    h('summary.ll-prefs-sum', h('span.ll-prefs-k', '开始之前'), sumEl),
    h('div.ll-prefs-body',
      texture,
      h('div.ll-prefs-sw',
        sw('ll-home-reflect', '在人生的几个节点停一停', 'reflections', '5、15、30、50、70 岁时，可以写下几句此刻的想法。', true),
        sw('ll-home-gentle', '略过可怕的情节', 'gentle', '沉重的事仍按真实的概率发生，只是写得含蓄一些。'),
        sw('ll-home-music', '背景音乐', 'music', '人生进行时放一段轻柔的音乐。', true)),
      cmp,
      h('p.ll-hint', '这些随时可以在',
        h('a.ll-link', { href: '#settings', onclick: (e) => { e.preventDefault(); app.go('settings', { focus: 'tone' }); } }, '设置'),
        '里修改。')));
    return det;
  }

  // ------------------------------------------------ resume card (filled asynchronously)
  const resumeSlot = h('div.ll-resume-slot');
  async function fillResume() {
    let st = null;
    let live = false;
    const cur = app.getLife();
    if (cur && !cur.dead && app.controller) { st = cur; live = true; }
    if (!st) {
      try { st = await Promise.resolve(saves.loadCurrent?.()); } catch { st = null; }
    }
    if (!alive || !st || typeof st !== 'object' || !st.birth || st.dead) return;
    const name = st.person?.name || st.birth?.name || '无名';
    const cont = h('button.ll-btn.ll-btn--ink', {
      type: 'button',
      onclick: () => { if (live && app.controller) app.go('game'); else app.resumeLife(st); },
    }, '继续这一生');
    const drop = h('button.ll-btn.ll-btn--ghost', {
      type: 'button',
      onclick: async () => {
        const ok = await app.confirm({
          title: '放弃这份档案？',
          body: `${name} 的人生停在 ${st.age ?? 0} 岁（${st.year ?? ''} 年）。放弃后自动存档会被删除，无法恢复。已结束的人生不受影响。`,
          ok: '放弃', cancel: '保留', danger: true,
        });
        if (!ok) return;
        app.abandonLife();
        clear(resumeSlot);
        app.toast('已放弃这份档案', 'info');
      },
    }, '放弃');
    clear(resumeSlot).append(h('section.ll-resume', { 'aria-labelledby': 'll-resume-title' },
      h('div.ll-resume-tab', live ? '进行中' : '未结档案'),
      h('div.ll-resume-body',
        h('p.ll-resume-no', app.archiveNo(st)),
        h('h2#ll-resume-title.ll-resume-name', name),
        h('p.ll-resume-line', lifeLine(st, data)),
        st.worldLabel ? h('p.ll-resume-world', '世界线：', st.worldLabel) : null),
      h('div.ll-resume-actions', cont, drop)));
  }
  fillResume();

  // ------------------------------------------------ archive index
  const pastCount = h('span.ll-index-live', '');
  const cardCount = h('span.ll-index-live', '');
  try {
    const n = Object.keys(readCollection().cards).length;
    cardCount.textContent = n ? `已收集 ${n} / ${ACHIEVEMENTS.length}` : '还没有卡片';
  } catch { /* ignore */ }
  (async () => {
    try {
      const list = await Promise.resolve(saves.pastLives?.());
      if (alive && Array.isArray(list)) pastCount.textContent = list.length ? `已归档 ${list.length} 份` : '还没有归档';
    } catch { /* ignore */ }
  })();
  const s = app.settings;
  const lenLabel = (LIFE_LENGTH_OPTIONS.find((o) => o.minutes === s.lifeMinutes) || {}).label || `${s.lifeMinutes} 分钟`;
  const entries = [
    { to: 'album', desc: '每走完一段人生，经历过的事会变成卡片收进图鉴。有的卡片几百段人生里才出现一次。', live: cardCount },
    { to: 'stories', desc: '真实的生活片段与照片墙：留下一张舍不得删的照片，讲讲它为什么值得记住。' },
    { to: 'memorial', desc: '被分享出来的一生。为他们点一支蜡烛，留一句话。' },
    { to: 'shared', desc: '其他人活过的人生，可以按国家和出生年代筛选。' },
    { to: 'past', desc: '你最近十次的人生，可导出备份。', live: pastCount },
    { to: 'about', desc: `${nCountries} 个国家和地区的真实数据、史实来源与推演方法。` },
    { to: 'settings', desc: `一生 ${lenLabel} · ${s.aiMode === 'off' ? '内置推演引擎' : 'AI 推演：' + AI_MODES[s.aiMode]}` },
    { to: 'feedback', desc: '发现史实或数据错误，或者有想法，告诉我们。' },
  ];
  const titles = { album: '成就图鉴', stories: '生活片段', memorial: '追思馆', shared: '大家的人生', past: '前世纪录', about: '关于数据', settings: '设置', feedback: '反馈' };
  const index = h('section.ll-index', { 'aria-labelledby': 'll-index-title' },
    h('h2#ll-index-title.ll-section-title', '卷宗目录'),
    h('ul.ll-index-list', entries.map((e) => h('li',
      h('a.ll-index-item', {
        href: '#' + e.to,
        onclick: (ev) => { ev.preventDefault(); app.go(e.to, e.to === 'feedback' ? { from: 'home' } : {}); },
      },
      h('span.ll-index-code', '#' + e.to),
      h('span.ll-index-title', titles[e.to]),
      h('span.ll-index-desc', e.desc),
      e.live || null)))));

  // ------------------------------------------------ what is real
  // counted from the loaded content (the build-time meta counts are only a fallback)
  const histN = (Array.isArray(data.content?.history) ? data.content.history.filter((e) => e && e.title).length : 0) || counts.history || 0;
  const dimsN = (Array.isArray(data.content?.future?.dimensions) ? data.content.future.dimensions.length : 0) || counts.dimensions || 0;
  const truth = h('section.ll-truth', { 'aria-labelledby': 'll-truth-title' },
    h('h2#ll-truth-title.ll-section-title', '这个模拟里什么是真实的'),
    h('dl.ll-truth-list',
      h('div.ll-truth-row.is-real',
        h('dt', h('span.ll-badge.ll-badge--real', '真实'), h('span.ll-truth-years', `${FIRST_YEAR}–${HISTORY_END}`)),
        h('dd', `出生、死亡率、预期寿命、收入、上网率等数字来自联合国《世界人口展望 2024》和世界银行，覆盖 ${nCountries} 个国家和地区。`,
          histN ? `这些年里发生的 ${histN} 件大事都经过核实并附有来源。` : '这些年里发生的大事都经过核实并附有来源。')),
      h('div.ll-truth-row.is-proj',
        h('dt', h('span.ll-badge.ll-badge--proj', '推演'), h('span.ll-truth-years', `${HISTORY_END + 1}–${LAST_YEAR}`)),
        h('dd', '以联合国人口预测中方案为基线，叠加人工智能、气候、地缘政治等方向的不同走向',
          dimsN ? `（共 ${dimsN} 个维度）` : '', '。每一局随机走上其中一条世界线，并在页面上始终标为推演。')),
      h('div.ll-truth-row.is-fiction',
        h('dt', h('span.ll-badge.ll-badge--fiction', '虚构'), h('span.ll-truth-years', '你的故事')),
        h('dd', '“你”这个人、你遇到的人和具体经历都是虚构的，只是按所在国家和年代的真实统计概率生成。真实人物不会被编造言论。'))),
    h('p.ll-truth-more',
      h('a.ll-link', { href: '#about', onclick: (e) => { e.preventDefault(); app.go('about', { section: 'sources' }); } }, '查看数据来源与方法'),
      h('span.ll-muted', ` · 数据截至 ${DATA_DATE}`)));

  root.append(hero, resumeSlot, h('div.ll-home-lower', index, truth));

  return () => {
    alive = false;
    disposers.forEach((f) => f());
  };
}
