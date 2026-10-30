// Decision overlay (CONTRACT §8): openDecision(app, decision, {onChoose, onAuto, ...}) -> close()
// A focus-trapped modal dialog: header (year/age), situation, 2-4 option cards with risk chips, a free-text
// "写下你自己的选择", 自动选择, an AI status line (options are swapped in place when decision.upgrade resolves
// before the player chooses), then the resolution view (streamed narrative, effect deltas, changes, 伏笔) and 继续.
// The same dialog in custom mode (opts.custom) is the "主动选择" free-text action. With opts.onDismiss a decision
// can be set aside ("先看看再选"); the controller then shows a pill in the game screen to bring it back.

import { h, $$, clear, reducedMotion } from '../dom.js';
import { STAT_LABELS, EDU_LABELS, CAREER_LABELS, RELATIONSHIP_LABELS, HISTORY_END } from '../../core/constants.js';
import * as economy from '../../core/economy.js';
import { countryName } from '../controller.js';
import { interpretCustom, interpretLine } from '../../core/decisions.js';
import { aiStatus } from '../../ai/claude.js';

const RISK = {
  low: { label: '低风险', cls: 'g-risk--low' },
  mid: { label: '中风险', cls: 'g-risk--mid' },
  high: { label: '高风险', cls: 'g-risk--high' },
};
const KEYS = ['A', 'B', 'C', 'D'];
const MAX_CUSTOM = 200;
const EFFECT_STATS = ['health', 'happiness', 'knowledge', 'relationships', 'wealth'];

let seq = 0;
let openCount = 0;
const openStack = [];   // overlays currently open, topmost last (only the topmost one handles keys)
const noop = () => {};

function pageHidden() {
  return typeof document !== 'undefined' && !!document.hidden;
}

/** Run fn once the page is visible again; returns a canceller. */
function whenVisible(fn) {
  if (!pageHidden()) { fn(); return noop; }
  const on = () => {
    if (pageHidden()) return;
    document.removeEventListener('visibilitychange', on);
    fn();
  };
  document.addEventListener('visibilitychange', on);
  return () => document.removeEventListener('visibilitychange', on);
}

// ---------------------------------------------------------------------------------------------------------------
// Shared formatting helpers (also used by the game and death screens)

export function money(data, iso3, amount) {
  if (amount == null || !isFinite(amount)) return '—';
  try {
    if (typeof economy.formatMoney === 'function') {
      const s = economy.formatMoney(data, iso3, amount);
      if (s) return s;
    }
  } catch { /* fall through */ }
  const a = Math.abs(amount);
  const v = a >= 1e8 ? `${(amount / 1e8).toFixed(1)}亿` : a >= 1e4 ? `${(amount / 1e4).toFixed(a >= 1e5 ? 0 : 1)}万` : Math.round(amount).toLocaleString('zh-CN');
  return `${v} 国际元`;
}

export function signedMoney(data, iso3, delta) {
  if (!delta || !isFinite(delta)) return '';
  return (delta > 0 ? '+' : '−') + money(data, iso3, Math.abs(delta));
}

/**
 * Small chips for stat deltas. effects: {health, happiness, knowledge, relationships, wealth?, wealthDelta?}
 * @returns {HTMLElement[]}
 */
export function effectChips(effects, { data, iso3, min = 1 } = {}) {
  if (!effects || typeof effects !== 'object') return [];
  const out = [];
  for (const k of EFFECT_STATS) {
    const v = Math.round(Number(effects[k]) || 0);
    if (Math.abs(v) < min) continue;
    out.push(h('span.g-fx', { class: v > 0 ? 'g-fx--up' : 'g-fx--down', dataset: { stat: k } },
      h('i.g-fx-dot', { 'aria-hidden': 'true' }), `${STAT_LABELS[k]} ${v > 0 ? '+' : '−'}${Math.abs(v)}`));
  }
  const w = Number(effects.wealthDelta) || 0;
  if (Math.abs(w) >= 1) {
    out.push(h('span.g-fx', { class: w > 0 ? 'g-fx--up' : 'g-fx--down', dataset: { stat: 'wealth' } },
      h('i.g-fx-dot', { 'aria-hidden': 'true' }), `财富 ${signedMoney(data, iso3, w)}`));
  }
  return out;
}

function labelOf(map, v) {
  if (v == null || v === '') return '';
  return map[v] || String(v);
}

/** Human-readable list of state changes in a Resolution.set */
export function describeSet(set, data) {
  const out = [];
  if (!set || typeof set !== 'object') return out;
  const e = set.education;
  if (e) {
    const lvl = typeof e === 'string' ? e : e.level;
    if (lvl) out.push(`教育 → ${labelOf(EDU_LABELS, lvl)}${e.inSchool ? '（在读）' : ''}${e.field ? ` · ${e.field}` : ''}`);
    else if (e.inSchool === false) out.push('离开校园');
    else if (e.inSchool === true) out.push('回到校园');
  }
  const c = set.career;
  if (c) {
    const st = typeof c === 'string' ? c : c.status;
    const title = typeof c === 'object' ? c.title : null;
    if (st || title) out.push(`职业 → ${[labelOf(CAREER_LABELS, st), title].filter(Boolean).join(' · ')}`);
  }
  const r = set.relationship;
  if (r) {
    const st = typeof r === 'string' ? r : r.status;
    const partner = typeof r === 'object' && r.partner ? (r.partner.name || '') : '';
    if (st) out.push(`感情 → ${labelOf(RELATIONSHIP_LABELS, st)}${partner ? ` · ${partner}` : ''}`);
  }
  if (set.country) out.push(`迁居 → ${countryName(data, set.country)}`);
  if (set.urban === true) out.push('搬到城市');
  if (set.urban === false) out.push('搬到乡村');
  if (set.addCondition) {
    const n = typeof set.addCondition === 'string' ? set.addCondition : set.addCondition.name;
    if (n) out.push(`健康 → 患上${n}`);
  }
  if (set.removeCondition) {
    const n = typeof set.removeCondition === 'string' ? set.removeCondition : set.removeCondition.name || set.removeCondition.id;
    out.push(n && !/^[a-z_]+$/i.test(n) ? `健康 → ${n}好转` : '健康 → 一种病情好转');
  }
  return out;
}

/** When a pending storyline (Thread) is expected to surface, as a short hint. */
export function threadWhen(t, state) {
  const tr = (t && t.trigger) || {};
  if (tr.afterYears) return `约 ${tr.afterYears} 年后`;
  if (tr.age != null && state) return tr.age > state.age ? `${tr.age} 岁前后` : '不久之后';
  if (tr.year) {
    const diff = state && Number.isFinite(state.year) ? tr.year - state.year : null;
    if (diff != null && diff <= 0) return '不久之后';
    if (diff != null && diff <= 30) return `约 ${diff} 年后`;
    return `${tr.year} 年前后`;
  }
  return '将来某一天';
}

function suggestionsFor(age) {
  if (age < 12) return ['认真读书，争取考第一', '缠着家人学一门乐器', '和邻居家的孩子交朋友', '帮家里干点活'];
  if (age < 18) return ['偷偷自学编程', '参加学校的运动队', '课余打工攒钱', '和父母认真谈谈将来', '离开学校去打工'];
  if (age < 30) return ['换一份工作', '去大城市闯一闯', '开始存钱、学投资', '向喜欢的人表白', '报名进修课程', '出国读书或工作'];
  if (age < 60) return ['辞职创业', '休息一年，陪陪家人', '买一套房子', '和疏远的亲人和解', '每天坚持锻炼', '做一次全面体检'];
  return ['去远方旅行一次', '搬去和子女同住', '学着用新的科技产品', '写一本回忆录', '去社区做志愿者'];
}

function paragraphs(text) {
  return String(text || '').split(/\n+/).map((t) => t.trim()).filter(Boolean).map((t) => h('p', t));
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {object} app
 * @param {object} decision  Decision (may carry .upgrade: Promise<Decision|null>)
 * @param {object} opts {onChoose(choice, decision, {onText}) -> Promise<{resolution, entries}>, onAuto(decision) -> choice,
 *                       onContinue(), onCancel(), onUpgrade(decision), onDismiss() (adds 先看看再选; Esc sets the
 *                       decision aside when no auto countdown runs), state, data, custom, auto, speed, autoDelay}
 * @returns {Function} close(); also close.setAuto(bool), close.setSpeed(x)
 */
export function openDecision(app, decision, opts = {}) {
  const state = opts.state || (typeof app?.getLife === 'function' ? app.getLife() : null);
  const data = opts.data || app?.data;
  const iso3 = state?.person?.country || state?.birth?.country;
  const custom = !!opts.custom || decision?.kind === 'custom' || !(decision?.options || []).length;
  const id = `g-dlg-${++seq}`;
  const prevFocus = typeof document !== 'undefined' ? document.activeElement : null;

  let current = decision || {};
  let phase = 'choose';          // 'choose' | 'resolving' | 'result' | 'closed'
  let autoOn = !!opts.auto && !custom;
  let autoCancelled = false;
  let speed = Number(opts.speed) || 1;
  let autoTimer = 0;
  let autoTick = 0;
  let contTimer = 0;
  let contTick = 0;
  let stopWaitVis = noop;
  let pickedByAuto = false;

  const year = current.year ?? state?.year;
  const age = current.age ?? state?.age;
  const projected = year > HISTORY_END;

  // ---- skeleton ------------------------------------------------------------------------------------------------
  const statusEl = h('p.g-dlg-status', { role: 'status', 'aria-live': 'polite' });
  const body = h('div.g-dlg-body');
  const meta = h('div.g-dlg-meta',
    h('span.g-dlg-stamp', custom ? '主动' : '抉择'),
    h('span.g-dlg-when', `${year} 年 · ${age} 岁`),
    projected ? h('span.g-b.g-b--proj', '推演') : h('span.g-b.g-b--real', year === HISTORY_END ? '截至 2026-10' : '真实历史'),
    !custom ? h('span.g-dlg-src') : null,
  );
  const dlg = h('div.g-dlg', {
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-t`, 'aria-describedby': `${id}-s`, tabindex: '-1',
    class: projected ? 'g-dlg--proj' : '',
  }, meta, body, statusEl);
  const ov = h('div.g-ov', { role: 'presentation' }, dlg);

  function setStatus(text, kind = '') {
    statusEl.textContent = text || '';
    statusEl.className = 'g-dlg-status' + (kind ? ` g-dlg-status--${kind}` : '');
  }

  function setSource(d) {
    const el = meta.querySelector('.g-dlg-src');
    if (!el) return;
    const ai = d && d.source === 'ai';
    el.textContent = ai ? 'AI 根据你的经历生成' : '内置推演引擎';
    el.className = 'g-dlg-src' + (ai ? ' g-dlg-src--ai' : '');
  }

  // ---- choose view ---------------------------------------------------------------------------------------------
  let optsWrap = null;
  let textarea = null;
  let customBtn = null;
  let autoLine = null;

  function optionButton(o, i) {
    const risk = RISK[o.risk] || RISK.mid;
    return h('button.g-opt', {
      type: 'button',
      dataset: { id: o.id },
      'aria-describedby': `${id}-o${i}`,
      onclick: () => { cancelAuto(true); choose({ optionId: o.id }); },
    },
    h('span.g-opt-k', { 'aria-hidden': 'true' }, KEYS[i] || String(i + 1)),
    h('span.g-opt-main',
      h('span.g-opt-l', o.label),
      o.detail ? h('span.g-opt-d', { id: `${id}-o${i}` }, o.detail) : null),
    h('span.g-risk', { class: risk.cls }, risk.label));
  }

  function renderChoose(animate) {
    clear(body);
    const d = current;
    setSource(d);
    const title = h('h2.g-dlg-title', { id: `${id}-t` }, custom ? '主动选择' : d.title || '人生的岔路口');
    let sitText = d.situation || '';
    if (custom && (!sitText || sitText === '此刻，你想主动做点什么？')) {
      const where = iso3 ? countryName(data, iso3) : '';
      sitText = `${year} 年，你 ${age} 岁${where ? `，生活在${where}` : ''}。此刻你想主动做点什么？写下来——世界会回应，但未必如你所愿。`;
    }
    const sit = h('p.g-dlg-sit', { id: `${id}-s` }, sitText);
    body.append(title, sit);

    if (!custom) {
      optsWrap = h('div.g-opts', { role: 'group', 'aria-label': '可选的道路' }, (d.options || []).slice(0, 4).map(optionButton));
      if (animate && !reducedMotion()) optsWrap.classList.add('g-swap');
      body.append(optsWrap);
    } else {
      optsWrap = null;
    }

    const counter = h('span.g-custom-n', { id: `${id}-n`, title: `最多 ${MAX_CUSTOM} 字` }, `0/${MAX_CUSTOM}`);
    textarea = h('textarea.g-custom-ta', {
      id: `${id}-ta`, rows: custom ? 3 : 2, maxlength: String(MAX_CUSTOM), 'aria-describedby': `${id}-hint ${id}-n`,
      placeholder: custom ? '例如：辞掉工作，去海边开一家小店' : '都不想选？写下你自己的打算',
    });
    customBtn = h('button.g-btn.g-btn--primary', { type: 'button', disabled: true }, custom ? '就这么做' : '按我的想法');
    // without AI the built-in engine reads the text; tell the player how, while they type, so they can rephrase
    const readLine = h('p.g-custom-read', { id: `${id}-read`, 'aria-live': 'polite' });
    let readTimer = 0;
    const engineReads = () => { try { return !aiStatus().usable; } catch { return true; } };
    const paintRead = () => {
      const t = textarea.value.trim();
      const it = t && engineReads() ? interpretCustom(t, custom ? null : current, data, iso3) : null;
      const line = interpretLine(it);
      readLine.textContent = line || '';
      readLine.className = 'g-custom-read' + (it && (it.kind === 'unclear' || it.kind === 'noise') ? ' g-custom-read--unclear' : '');
    };
    const sync = () => {
      const n = textarea.value.length;
      counter.textContent = `${n}/${MAX_CUSTOM}`;
      customBtn.disabled = !textarea.value.trim();
      clearTimeout(readTimer);
      readTimer = setTimeout(paintRead, 250);
    };
    textarea.addEventListener('input', () => { cancelAuto(true); sync(); });
    textarea.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && textarea.value.trim()) { ev.preventDefault(); submitCustom(); }
    });
    customBtn.addEventListener('click', submitCustom);
    const chips = custom
      ? h('div.g-sugg', { 'aria-label': '一些想法' }, suggestionsFor(Number(age) || 0).map((t) => h('button.g-sugg-b', {
        type: 'button',
        onclick: () => { textarea.value = t; sync(); textarea.focus(); },
      }, t)))
      : null;
    const box = h('div.g-custom', { class: custom ? 'g-custom--main' : '' },
      h('label.g-custom-lb', { for: `${id}-ta` }, custom ? '写下你想做的事' : '写下你自己的选择'),
      textarea,
      readLine,
      chips,
      h('div.g-custom-row',
        h('span.g-custom-hint', { id: `${id}-hint` }, '会结合你的处境判断能否实现'),
        counter,
        customBtn));
    body.append(box);

    const actions = h('div.g-dlg-actions');
    if (custom) {
      actions.append(h('button.g-btn', { type: 'button', onclick: cancel }, '算了'));
    } else {
      autoLine = h('span.g-auto-line');
      actions.append(autoLine,
        typeof opts.onDismiss === 'function'
          ? h('button.g-btn.g-btn--ghost.g-dlg-later', { type: 'button', onclick: dismiss, title: '先回到人生记录看看，时间会停在这里等你（Esc）' }, '先看看再选')
          : null,
        h('button.g-btn', { type: 'button', onclick: () => { cancelAuto(true); runAuto(false); } }, '自动选择'));
    }
    body.append(actions);
    if (autoOn && !autoCancelled) startAuto();
  }

  function submitCustom() {
    const t = textarea && textarea.value.replace(/\s+/g, ' ').trim();
    if (!t) return;
    cancelAuto(true);
    choose({ customText: t.slice(0, MAX_CUSTOM) });
  }

  // ---- auto choose ---------------------------------------------------------------------------------------------
  function autoDelay() {
    if (opts.autoDelay != null) return opts.autoDelay;
    return Math.round(Math.max(1200, 3200 / Math.sqrt(Math.max(0.5, speed))));
  }

  function startAuto() {
    cancelAuto(false);
    if (!autoOn || autoCancelled || phase !== 'choose' || custom || !autoLine) return;
    const total = autoDelay();
    const until = Date.now() + total;
    const paint = () => {
      if (!autoLine) return;
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      clear(autoLine);
      autoLine.append(`自动抉择：${left} 秒后替你选择 `,
        h('button.g-link', { type: 'button', onclick: () => cancelAuto(true) }, '我自己来'));
    };
    paint();
    autoTick = setInterval(paint, 250);
    autoTimer = setTimeout(() => {
      cancelAuto(false);
      // never choose for the player while the tab is in the background: restart the countdown on return
      if (pageHidden()) { stopWaitVis = whenVisible(() => startAuto()); return; }
      runAuto(true);
    }, total);
  }

  function cancelAuto(byPlayer) {
    clearTimeout(autoTimer);
    clearInterval(autoTick);
    stopWaitVis();
    stopWaitVis = noop;
    autoTimer = 0;
    autoTick = 0;
    if (byPlayer && autoOn && !autoCancelled) autoCancelled = true;
    if (autoLine) clear(autoLine);
  }

  async function runAuto(viaTimer) {
    if (phase !== 'choose') return;
    let c = null;
    try { c = await (typeof opts.onAuto === 'function' ? opts.onAuto(current) : null); } catch { c = null; }
    if (!c && (current.options || []).length) c = { optionId: current.options[0].id };
    if (!c || phase !== 'choose') return;
    if (c.optionId && optsWrap) {
      for (const b of $$('.g-opt', optsWrap)) {
        const on = b.dataset.id === c.optionId;
        b.classList.toggle('g-opt--picked', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    const beat = reducedMotion() ? 0 : (viaTimer ? 700 : 450);
    if (beat) await new Promise((r) => setTimeout(r, beat));
    choose(c, true);
  }

  // ---- upgrade (AI options arriving later) ------------------------------------------------------------------
  if (!custom && current.upgrade && typeof current.upgrade.then === 'function') {
    setStatus('正在根据你的人生生成更贴合的选项…', 'busy');
    current.upgrade.then((d) => {
      if (phase !== 'choose') return;
      if (d && Array.isArray(d.options) && d.options.length >= 2) {
        const focusedIdx = optsWrap ? $$('.g-opt', optsWrap).indexOf(document.activeElement) : -1;
        const draft = textarea ? textarea.value : '';
        current = { ...d, upgrade: undefined };
        if (typeof opts.onUpgrade === 'function') { try { opts.onUpgrade(current); } catch { /* ignore */ } }
        renderChoose(true);
        if (textarea && draft) { textarea.value = draft; textarea.dispatchEvent(new Event('input')); }
        const btns = optsWrap ? $$('.g-opt', optsWrap) : [];
        if (focusedIdx >= 0 && btns.length) btns[Math.min(focusedIdx, btns.length - 1)].focus();
        setStatus('选项已根据你的经历更新', 'ai');
      } else {
        setStatus('');
      }
    }, () => { if (phase === 'choose') setStatus(''); });
  }

  // ---- choose -> resolve -----------------------------------------------------------------------------------
  function choiceLabel(c) {
    if (!c) return '';
    if (c.customText) return c.customText;
    const o = (current.options || []).find((x) => x.id === c.optionId);
    return o ? o.label : '';
  }

  async function choose(choice, byAuto = false) {
    if (phase !== 'choose') return;
    phase = 'resolving';
    // only a pick the auto-chooser actually made is labelled 自动选择 (and continues on its own); a player who
    // clicks during the short highlight beat before the auto pick lands keeps their own choice
    pickedByAuto = !!byAuto;
    cancelAuto(false);
    const label = choiceLabel(choice);
    clear(body);
    const narr = h('div.g-res-narr.g-res-narr--live', { 'aria-busy': 'true' });
    body.append(
      h('h2.g-dlg-title', { id: `${id}-t` }, custom ? '主动选择' : current.title || '抉择'),
      h('div.g-res-choice', h('span.g-res-choice-k', choice.customText ? '你的决定' : '你选择了'), h('span.g-res-choice-v', label)),
      narr);
    narr.append(h('p.g-res-wait', h('span.g-dots', { 'aria-hidden': 'true' }), '世界正在回应…'));
    setStatus('');
    dlg.focus();
    // The controller hands over the full narrative streamed so far (already extracted from JSON).
    const onText = (t) => {
      if (phase !== 'resolving') return;
      const txt = typeof t === 'string' ? t : '';
      if (!txt) return;
      clear(narr);
      narr.append(...paragraphs(txt));
      narr.lastChild && narr.lastChild.append(h('span.g-caret', { 'aria-hidden': 'true' }));
    };
    let res = null;
    try {
      res = await (typeof opts.onChoose === 'function' ? opts.onChoose(choice, current, { onText }) : null);
    } catch (e) {
      console.warn('[decision] onChoose', e);
      res = null;
    }
    if (phase === 'closed') return;
    const resolution = res && (res.resolution || (typeof res.narrative === 'string' ? res : null));
    if (!resolution) {
      phase = 'choose';
      renderChoose(false);
      setStatus('推演时出了点问题，请再选一次。', 'error');
      focusFirst();
      return;
    }
    renderResult(choice, label, resolution, (res && res.source) || resolution.source || 'local');
  }

  function renderResult(choice, label, r, source) {
    phase = 'result';
    clear(body);
    const narr = h('div.g-res-narr', { id: `${id}-r` }, paragraphs(r.narrative || '日子继续向前。'));
    const parts = [
      h('h2.g-dlg-title', { id: `${id}-t` }, custom ? '主动选择' : current.title || '抉择'),
      h('div.g-res-choice', h('span.g-res-choice-k', choice.customText ? '你的决定' : (pickedByAuto ? '自动选择' : '你选择了')), h('span.g-res-choice-v', label)),
      narr,
    ];
    if (r.feasible === false) {
      parts.push(h('p.g-res-note.g-res-note--warn', h('b', '没能如愿：'), r.note || '在当时的条件下，这件事没能实现。'));
    } else if (r.note) {
      parts.push(h('p.g-res-note', r.note));
    }
    const chips = effectChips(r.effects, { data, iso3 });
    if (chips.length) parts.push(h('div.g-res-sec', h('h3.g-res-h', '影响'), h('div.g-fxs', chips)));
    const changes = describeSet(r.set, data);
    if (r.hazard && r.hazard.mult && Math.abs(r.hazard.mult - 1) > 0.04) {
      const up = r.hazard.mult > 1;
      changes.push(`${up ? '健康风险上升' : '健康风险下降'}${r.hazard.reason ? `（${r.hazard.reason}）` : ''}${r.hazard.years ? `，约 ${r.hazard.years} 年` : ''}`);
    }
    if (changes.length) parts.push(h('div.g-res-sec', h('h3.g-res-h', '人生的变化'), h('ul.g-res-list', changes.map((t) => h('li', t)))));
    const threads = (r.threads || []).filter((t) => t && (t.title || t.text));
    if (threads.length) {
      parts.push(h('div.g-res-sec.g-res-sec--thread',
        h('h3.g-res-h', '伏笔'),
        h('ul.g-res-threads', threads.slice(0, 4).map((t) => h('li',
          h('span.g-res-thread-t', t.title || '一件尚未发生的事'),
          h('span.g-res-thread-w', threadWhen(t, state)))))));
    }
    body.append(...parts);
    // focus lands on 继续; screen readers read the outcome with it (the situation text it described is gone)
    dlg.setAttribute('aria-describedby', `${id}-r`);
    const cont = h('button.g-btn.g-btn--primary.g-res-cont', { type: 'button', onclick: finish, 'aria-describedby': `${id}-r` }, '继续');
    const contLine = h('span.g-auto-line');
    body.append(h('div.g-dlg-actions', contLine, cont));
    setStatus(source === 'ai' ? '后果由 AI 结合你的处境与过去的选择推演（虚构）' : '后果由内置推演引擎生成');
    cont.focus();
    if (autoOn && !autoCancelled && pickedByAuto) {
      const countdown = () => {
        const total = reducedMotion() ? 2500 : Math.max(2200, Math.round(5200 / Math.sqrt(Math.max(0.5, speed))));
        const until = Date.now() + total;
        const paint = () => {
          const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
          clear(contLine);
          contLine.append(`${left} 秒后继续 `, h('button.g-link', {
            type: 'button',
            onclick: () => { stopContinue(); cont.focus(); },
          }, '停下来看看'));
        };
        paint();
        contTick = setInterval(paint, 250);
        contTimer = setTimeout(() => {
          clearInterval(contTick);
          if (pageHidden()) { clear(contLine); stopWaitVis = whenVisible(countdown); return; }
          finish();
        }, total);
      };
      countdown();
    }
  }

  function stopContinue() {
    clearTimeout(contTimer);
    clearInterval(contTick);
    stopWaitVis();
    stopWaitVis = noop;
    contTimer = 0;
    contTick = 0;
    const line = body.querySelector('.g-dlg-actions .g-auto-line');
    if (line) clear(line);
  }

  function finish() {
    if (phase !== 'result') return;
    close();
    if (typeof opts.onContinue === 'function') opts.onContinue();
  }

  function cancel() {
    if (phase !== 'choose' || !custom) return;
    close();
    if (typeof opts.onCancel === 'function') opts.onCancel();
  }

  /** Set the decision aside: the dialog closes, the clock stays stopped and the game shows a pill to come back. */
  function dismiss() {
    if (phase !== 'choose' || custom || typeof opts.onDismiss !== 'function') return;
    close();
    opts.onDismiss();
  }

  // ---- focus trap & keys -------------------------------------------------------------------------------------
  function focusables() {
    return $$('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])', dlg)
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
  }

  function focusFirst() {
    const first = custom ? textarea : (optsWrap && optsWrap.querySelector('.g-opt'));
    (first || focusables()[0] || dlg).focus();
  }

  function onKey(ev) {
    if (phase === 'closed' || openStack[openStack.length - 1] !== ov) return;
    // keys reach the dialog even when focus fell back to <body> (e.g. after a click on the backdrop)
    const t = ev.target;
    if (t && t !== document.body && t !== document.documentElement && !ov.contains(t)) return;
    if (ev.key === 'Tab') {
      const f = focusables();
      if (!f.length) { ev.preventDefault(); dlg.focus(); return; }
      const i = f.indexOf(document.activeElement);
      if (ev.shiftKey && (i <= 0)) { ev.preventDefault(); f[f.length - 1].focus(); }
      else if (!ev.shiftKey && (i === f.length - 1 || i === -1)) { ev.preventDefault(); f[0].focus(); }
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (phase === 'result') finish();
      else if (phase === 'choose' && custom) cancel();
      else if (phase === 'choose' && (autoTimer || autoTick)) cancelAuto(true);
      else if (phase === 'choose' && typeof opts.onDismiss === 'function') dismiss();
      else if (phase === 'choose') cancelAuto(true);
      return;
    }
    const inText = ev.target && (ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'INPUT');
    if (phase === 'choose' && !custom && !inText && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const k = ev.key.toUpperCase();
      let idx = KEYS.indexOf(k);
      if (idx < 0 && /^[1-4]$/.test(ev.key)) idx = Number(ev.key) - 1;
      const o = (current.options || [])[idx];
      if (o) { ev.preventDefault(); cancelAuto(true); choose({ optionId: o.id }); }
    }
  }

  // stop the clock-driven auto pick as soon as the player interacts with the options
  dlg.addEventListener('pointerdown', (ev) => {
    if (phase === 'choose' && ev.target && ev.target.closest && ev.target.closest('.g-opt, .g-custom')) cancelAuto(true);
  });
  document.addEventListener('keydown', onKey);

  // ---- open / close ------------------------------------------------------------------------------------------
  // Only the page shell goes inert: the app's toasts (siblings of the shell inside #app) stay readable and
  // dismissable while a decision is open.
  const appRoot = document.querySelector('#app > .ll-shell') || document.getElementById('app');
  const canInert = appRoot && 'inert' in appRoot;
  if (canInert) appRoot.inert = true;
  openCount++;
  openStack.push(ov);
  document.documentElement.classList.add('g-lock');
  document.body.appendChild(ov);
  renderChoose(false);
  requestAnimationFrame(() => { ov.classList.add('g-ov--in'); });
  focusFirst();

  function close() {
    if (phase === 'closed') return;
    phase = 'closed';
    cancelAuto(false);
    stopContinue();
    document.removeEventListener('keydown', onKey);
    const at = openStack.indexOf(ov);
    if (at >= 0) openStack.splice(at, 1);
    if (ov.parentNode) ov.parentNode.removeChild(ov);
    openCount = Math.max(0, openCount - 1);
    if (!openCount) {
      document.documentElement.classList.remove('g-lock');
      if (canInert) appRoot.inert = false;
    }
    if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
      try { prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }

  close.setAuto = (v) => {
    autoOn = !!v && !custom;
    if (autoOn) { autoCancelled = false; if (phase === 'choose') startAuto(); }
    else cancelAuto(false);
  };
  close.setSpeed = (x) => { speed = Number(x) || 1; };
  close.isOpen = () => phase !== 'closed';
  return close;
}
