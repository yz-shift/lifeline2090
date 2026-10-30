// Settings: life length, AI mode (with how AI usage works), decision frequency, default auto-choose and how automatic
// choices lean (纹理), the pace and tone of a life (reflection pauses, 略过可怕的情节, background music), the player's
// real birthplace for the comparison at the end (kept only in this browser), appearance, and clearing everything
// stored in this browser (behind an in-page confirm). Changes save immediately and apply to a life in progress.

import { h, clear, storage, bus } from '../dom.js';
import { STORAGE_KEYS, AI_MODES, LIFE_LENGTH_OPTIONS, DECISION_FREQUENCY, DECISION_AGES } from '../../core/constants.js';
import * as saves from '../../social/saves.js';

// same values as DEFAULT_SETTINGS in app.js (app.defaults is preferred; not imported: app.js imports this screen)
const RESET_SETTINGS = {
  lifeMinutes: 30, aiMode: 'default', decisionFreq: 'standard', autoChoose: false, theme: 'system', lastWorld: null,
  autoTexture: 'normal', gentle: false, music: true, reflections: true, compareIso: null, compareYear: null,
};

export const GENTLE_NOTE = '战争、暴力、意外、亲人离世这些沉重的事，仍然按真实的统计概率发生，不会因此变少；只是写得更含蓄，不描写细节。涉及轻生的内容会附上一句求助的提醒。';
export const MUSIC_NOTE = '人生进行时，放一段轻柔的背景音乐。随时可以在这里关掉。';
export const REFLECT_NOTE = '在 5、15、30、50、70 岁时停一停，可以写下几句此刻的想法，一生结束时会再看到它们。不想写，直接继续就好。';

const SCROLL_TO = { ai: 'll-set-sec-ai', compare: 'll-set-sec-cmp', play: 'll-set-sec-freq', tone: 'll-set-sec-tone' };

const AI_DETAIL = {
  off: '不调用 AI，完全在本机运行。人生的抉择和后续剧情由内置推演引擎按真实数据与模板生成，同样会记住你的选择。',
  quick: '响应最快，叙述简短。适合想快速过完一生的时候。',
  default: '在速度和叙述质量之间平衡。推荐。',
  complex: '叙述与后续剧情最细致，前后呼应更多；等待更久，也消耗更多用量。',
};

const FREQ = [
  { value: 'sparse', label: '稀疏', sub: `约 ${DECISION_FREQUENCY.sparse.length} 次：只在人生关键年龄` },
  { value: 'standard', label: '标准', sub: `约 ${DECISION_AGES.length} 次：大约每五年一次` },
  { value: 'frequent', label: '频繁', sub: '从 5 岁起每两三年一次' },
];

const TYPICAL_LIFE = 73; // world life expectancy at birth, rounded (UN WPP 2024, 2023 estimate)

/** Every localStorage key this game owns (all start with "ll2090."), plus the shared STORAGE_KEYS. */
function localKeys() {
  const keys = new Set(Object.values(STORAGE_KEYS));
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('ll2090.')) keys.add(k);
    }
  } catch { /* storage blocked: the known keys are still removed */ }
  return Array.from(keys);
}

export function mount(root, params, app) {
  const offs = [];
  let alive = true;
  let savedTimer = 0;
  const status = h('p.ll-set-saved', { role: 'status', 'aria-live': 'polite' });
  function saved(text = '已保存') {
    status.textContent = text;
    status.classList.add('is-on');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { status.classList.remove('is-on'); }, 1600);
  }
  const save = (patch, text) => { app.saveSettings(patch); saved(text); paintAiState(); };
  const s = app.settings;
  const lifeActive = () => { const l = app.getLife(); return !!(l && !l.dead && app.controller); };

  // ------------------------------------------------ life length
  const lengthG = app.ui.boxGroup({
    id: 'll-set-length', name: 'll-set-length', value: s.lifeMinutes,
    options: LIFE_LENGTH_OPTIONS.map((o) => ({
      value: o.minutes, label: o.label,
      sub: `一年约 ${((o.minutes * 60) / TYPICAL_LIFE).toFixed(o.minutes * 60 / TYPICAL_LIFE < 10 ? 1 : 0)} 秒`,
    })),
    onChange: (v) => save({ lifeMinutes: Number(v) }),
  });

  // ------------------------------------------------ AI
  const aiState = h('p.ll-set-aistate');
  function paintAiState() {
    if (!alive) return;
    clear(aiState);
    const mode = app.settings.aiMode;
    let cls = 'off', text;
    if (mode === 'off') text = '当前：内置推演引擎。';
    else if (app.ai.pending) { cls = 'pending'; text = '正在检查 AI 是否可用…'; }
    else if (app.ai.available) { cls = 'on'; text = `当前：AI 推演（${AI_MODES[mode]}）。第一次调用时会请求一次授权。`; }
    else text = '当前环境里 AI 不可用（未授权、已关闭或额度用尽），游戏会自动使用内置推演引擎。';
    aiState.append(h('span.ll-status-dot.is-' + cls, { 'aria-hidden': 'true' }), text);
  }
  const aiG = app.ui.boxGroup({
    id: 'll-set-ai', name: 'll-set-ai', value: s.aiMode,
    options: Object.keys(AI_MODES).map((k) => ({ value: k, label: AI_MODES[k], sub: AI_DETAIL[k] })),
    onChange: (v) => save({ aiMode: v }),
  });
  paintAiState();
  offs.push(bus.on('ai:status', paintAiState), bus.on('ai:changed', paintAiState));

  // ------------------------------------------------ decisions
  const freqG = app.ui.boxGroup({
    id: 'll-set-freq', name: 'll-set-freq', value: s.decisionFreq,
    options: FREQ,
    onChange: (v) => save({ decisionFreq: v }),
  });
  const autoSw = app.ui.switchField({
    id: 'll-set-auto', label: '默认自动选择', checked: s.autoChoose,
    sub: '遇到抉择时，按人物的处境和性格自动替你选择，人生不停顿。游戏中随时可以关掉。',
    onChange: (on) => save({ autoChoose: on }),
  });
  const textureG = typeof app.ui.texturePicker === 'function'
    ? app.ui.texturePicker({
      id: 'll-set-texture', value: s.autoTexture, variant: 'boxes', legend: '自动选择时的倾向',
      hint: '没有亲自选择的时候（开着自动选择、没定每年的重心、来不及回答的小事），人生会朝这个方向偏一点；亲自做的选择不受影响。',
      onChange: (v) => save({ autoTexture: v }),
    })
    : null;

  // ------------------------------------------------ pace and tone
  const reflectSw = app.ui.switchField({
    id: 'll-set-reflect', label: '在人生的几个节点停一停', checked: s.reflections !== false, sub: REFLECT_NOTE,
    onChange: (on) => save({ reflections: on }),
  });
  const gentleSw = app.ui.switchField({
    id: 'll-set-gentle', label: '略过可怕的情节', checked: !!s.gentle, sub: GENTLE_NOTE,
    onChange: (on) => save({ gentle: on }),
  });
  const musicSw = app.ui.switchField({
    id: 'll-set-music', label: '背景音乐', checked: s.music !== false, sub: MUSIC_NOTE,
    onChange: (on) => save({ music: on }),
  });

  // ------------------------------------------------ the player's real birthplace (local only)
  const cmpF = typeof app.ui.compareFields === 'function'
    ? app.ui.compareFields({
      id: 'll-set-cmp', data: app.data, iso: s.compareIso, year: s.compareYear,
      onChange: (v) => save(v, v.compareIso ? '已保存在本机' : '已清除'),
    })
    : null;

  // ------------------------------------------------ appearance
  const themeG = app.ui.boxGroup({
    id: 'll-set-theme', name: 'll-set-theme', value: s.theme, compact: true,
    options: [{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色 · 档案纸' }, { value: 'dark', label: '深色 · 夜间档案室' }],
    onChange: (v) => save({ theme: v }),
  });

  // ------------------------------------------------ local data
  const pastInfo = h('span.ll-num', '—');
  const curInfo = h('span', '—');
  async function paintData() {
    let past = null, cur = null;
    try { past = await Promise.resolve(saves.pastLives?.()); } catch { past = null; }
    try { cur = await Promise.resolve(saves.loadCurrent?.()); } catch { cur = null; }
    if (!alive) return;
    pastInfo.textContent = Array.isArray(past) ? `${past.length} 份` : '—';
    curInfo.textContent = cur && cur.birth && !cur.dead ? `${cur.person?.name || cur.birth?.name || '一份'}（${cur.age ?? 0} 岁）` : '无';
  }
  paintData();
  const clearBtn = h('button.ll-btn.ll-btn--danger', {
    type: 'button',
    onclick: async () => {
      const ok = await app.confirm({
        title: '清除本机数据？',
        body: app.social.mode === 'shared'
          ? '这会删除保存在这个浏览器里的进行中的人生、前世纪录、草稿和全部设置，无法恢复。\n已经分享到追思馆的人生保存在共享服务里，不受影响。'
          : '这会删除保存在这个浏览器里的进行中的人生、前世纪录、草稿和全部设置，无法恢复。\n当前没有连接共享服务，只保存在本机的追思馆记录和留言也会一并删除。',
        ok: '全部清除', cancel: '取消', danger: true,
      });
      if (!ok || !alive) return;
      app.abandonLife();
      try { saves.clearCurrent?.(); } catch { /* ignore */ }
      for (const k of localKeys()) storage.remove(k);
      app.saveSettings({ ...(app.defaults || RESET_SETTINGS) });
      storage.remove(STORAGE_KEYS.settings);
      app.toast('本机数据已清除', 'good');
      app.go('settings', {}, { replace: true });
    },
  }, '清除本机数据');

  const section = (id, title, desc, ...body) => h('section.ll-set-sec', { id, 'aria-labelledby': id + '-t' },
    h('div.ll-set-sec-head', h('h2.ll-set-title', { id: id + '-t' }, title), desc ? h('p.ll-set-desc', desc) : null),
    h('div.ll-set-sec-body', body));

  root.append(
    h('div.ll-page-head',
      h('p.ll-eyebrow', '本机设置'),
      h('h1.ll-h1', '设置'),
      h('p.ll-lede', lifeActive()
        ? '修改会立即保存，并应用到正在进行的人生。'
        : '修改会立即保存在这个浏览器里，开始或继续一段人生时生效。'),
      status),
    h('div.ll-doc.ll-set',
      section('ll-set-sec-length', '一生的长度', '一生在现实中大约持续多久。实际时长随这个人的寿命变化；遇到抉择时会暂停。', lengthG),
      section('ll-set-sec-ai', 'AI 推演',
        'AI 推演使用的是你自己的 Claude 用量，不需要任何密钥。第一次调用时页面会请求一次授权；如果拒绝或额度用尽，游戏会自动改用内置推演引擎，人生可以照常继续。',
        aiG, aiState),
      section('ll-set-sec-freq', '抉择频率', '人生中停下来让你做选择的次数。战争、失业、重病等突发情况会另外触发抉择；每年的重心和一些小事随时可以自己定。', freqG, autoSw, textureG),
      section('ll-set-sec-tone', '节奏与氛围', '这些只改变人生怎样呈现给你，不改变它按真实数据推演的方式。', reflectSw, gentleSw, musicSw),
      cmpF ? section('ll-set-sec-cmp', '和你自己的出生地对照', '可以不填。填了以后，一生结束时会把你实际出生的地方和这一生的出生地放在一起看看。', cmpF) : null,
      section('ll-set-sec-theme', '外观', null, themeG),
      section('ll-set-sec-data', '本机数据', '存档只保存在这个浏览器里，换设备或清除浏览器数据后不会保留。可以在“前世纪录”里导出备份。',
        h('dl.ll-set-data',
          h('div', h('dt', '进行中的人生'), h('dd', curInfo)),
          h('div', h('dt', '前世纪录'), h('dd', pastInfo))),
        h('div.ll-actions', clearBtn,
          h('a.ll-link', { href: '#past', onclick: (e) => { e.preventDefault(); app.go('past'); } }, '前往前世纪录')))));

  if (params.focus && SCROLL_TO[params.focus]) {
    requestAnimationFrame(() => {
      const el = document.getElementById(SCROLL_TO[params.focus]);
      if (!el) return;
      el.scrollIntoView({ block: 'start' });
      const target = params.focus === 'compare' ? el.querySelector('select') : el.querySelector('input:checked');
      target?.focus({ preventScroll: true });
    });
  }

  return () => {
    alive = false;
    clearTimeout(savedTimer);
    offs.forEach((f) => f && f());
  };
}
