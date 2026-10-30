// Small "moments" dialogs of the interactivity layer (CONTRACT §10). Each pauses the clock while it is open (the
// controller owns the pause) and looks like a slip filed into the same registry as the decision overlay.
//   openNaming(app, {state, naming, auto, speed, onName(name), onKeep()})       a child was born: give a name
//   openReflection(app, {state, reflect, auto, speed, onSave(text, {never}), onSkip({never})})   ages 5/15/30/50/70
//   openThought(app, {state, onSave(text), onCancel()})                         ✎ 写下想法 from the control bar
// Every function returns close() (idempotent; closing from outside calls no callback) with close.isOpen().
// Player text is only ever shown through textContent and is cleaned before it leaves the dialog.

import { h, $$, clear, reducedMotion } from '../dom.js';
import { HISTORY_END } from '../../core/constants.js';

export const NAME_MAX = 12;
export const NOTE_MAX = 200;

const noop = () => {};
let seq = 0;

/** Strip control / bidi characters, collapse whitespace and cut to `max` characters (not UTF-16 units). */
export function cleanText(text, max = NOTE_MAX) {
  const t = String(text == null ? '' : text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(t).slice(0, Math.max(0, max)).join('');
}

const charCount = (s) => Array.from(String(s || '')).length;

function pageHidden() {
  return typeof document !== 'undefined' && !!document.hidden;
}

/**
 * A soft countdown line ("8 秒后继续 · 等一等"). Never finishes while the tab is hidden. Returns stop().
 * label(secondsLeft) -> string; onDone() when it runs out.
 */
function countdown(line, ms, label, stopLabel, onDone) {
  let timer = 0;
  let tick = 0;
  let stopped = false;
  let offVis = noop;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(tick);
    offVis();
    offVis = noop;
    clear(line);
  };
  const run = () => {
    if (stopped) return;
    const until = Date.now() + ms;
    const paint = () => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      clear(line);
      line.append(label(left), ' ', h('button.g-link', { type: 'button', onclick: () => stop() }, stopLabel));
    };
    paint();
    tick = setInterval(paint, 250);
    timer = setTimeout(() => {
      clearInterval(tick);
      if (stopped) return;
      if (pageHidden()) {
        clear(line);
        const on = () => {
          if (pageHidden()) return;
          document.removeEventListener('visibilitychange', on);
          offVis = noop;
          run();
        };
        document.addEventListener('visibilitychange', on);
        offVis = () => document.removeEventListener('visibilitychange', on);
        return;
      }
      stopped = true;
      clear(line);
      onDone();
    }, ms);
  };
  run();
  return stop;
}

function autoMs(speed, base) {
  return Math.round(Math.max(2600, base / Math.sqrt(Math.max(0.5, Number(speed) || 1))));
}

/**
 * The shared dialog frame: overlay + registry slip with a stamp, the year/age line, a body and an action row.
 * onEscape runs on Escape; the focus is trapped inside; the page shell is inert while it is open.
 */
function shell({ stamp, when, projected, kind, build, onEscape, initialFocus }) {
  const id = `g-mom-${++seq}`;
  const prevFocus = typeof document !== 'undefined' ? document.activeElement : null;
  const meta = h('div.g-dlg-meta',
    h('span.g-dlg-stamp.g-mom-stamp', stamp),
    h('span.g-dlg-when', when),
    projected ? h('span.g-b.g-b--proj', '推演') : null);
  const body = h('div.g-dlg-body');
  const dlg = h('div.g-dlg.g-mom', {
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-t`, 'aria-describedby': `${id}-s`, tabindex: '-1',
    class: `g-mom--${kind}${projected ? ' g-dlg--proj' : ''}`,
  }, meta, body);
  const ov = h('div.g-ov.g-ov--mom', { role: 'presentation' }, dlg);
  let open = true;

  function focusables() {
    return $$('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])', dlg)
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
  }
  function onKey(ev) {
    if (!open) return;
    const all = document.querySelectorAll('.g-ov');
    if (all[all.length - 1] !== ov) return;
    const t = ev.target;
    if (t && t !== document.body && t !== document.documentElement && !ov.contains(t)) return;
    if (ev.key === 'Tab') {
      const f = focusables();
      if (!f.length) { ev.preventDefault(); dlg.focus(); return; }
      const i = f.indexOf(document.activeElement);
      if (ev.shiftKey && i <= 0) { ev.preventDefault(); f[f.length - 1].focus(); }
      else if (!ev.shiftKey && (i === f.length - 1 || i === -1)) { ev.preventDefault(); f[0].focus(); }
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      onEscape();
    }
  }

  const appRoot = document.querySelector('#app > .ll-shell') || document.getElementById('app');
  const canInert = appRoot && 'inert' in appRoot;
  if (canInert) appRoot.inert = true;
  document.documentElement.classList.add('g-lock');
  document.addEventListener('keydown', onKey);
  build(body, id);
  document.body.appendChild(ov);
  if (!reducedMotion()) requestAnimationFrame(() => ov.classList.add('g-ov--in'));
  else ov.classList.add('g-ov--in');
  const first = typeof initialFocus === 'function' ? initialFocus() : initialFocus;
  (first || dlg).focus();

  function close() {
    if (!open) return;
    open = false;
    document.removeEventListener('keydown', onKey);
    if (ov.parentNode) ov.parentNode.removeChild(ov);
    if (!document.querySelector('.g-ov')) {
      document.documentElement.classList.remove('g-lock');
      if (canInert) appRoot.inert = false;
    }
    if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
      try { prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }
  close.isOpen = () => open;
  return { close, dlg, body };
}

function whenLine(state, year, age) {
  const y = year ?? state?.year;
  const a = age ?? state?.age;
  return `${y} 年 · ${a} 岁`;
}

// ---------------------------------------------------------------------------------------------------------------
// 取名

/**
 * The player's child was born (state.namingPending = {childIndex, sex, suggestions}). Suggestions are chips; a text
 * field takes up to NAME_MAX characters. Closing the dialog keeps the first suggestion (onKeep).
 */
export function openNaming(app, opts = {}) {
  const state = opts.state || app?.getLife?.() || null;
  const naming = opts.naming || state?.namingPending || {};
  const child = (state?.person?.children || [])[naming.childIndex] || {};
  const sex = naming.sex || child.sex;
  const sexWord = sex === 'male' ? '儿子' : sex === 'female' ? '女儿' : '孩子';
  const suggestions = (Array.isArray(naming.suggestions) ? naming.suggestions : [])
    .map((s) => cleanText(s, NAME_MAX)).filter(Boolean).slice(0, 5);
  const fallback = suggestions[0] || cleanText(child.name, NAME_MAX) || '';
  const year = state?.year;
  const projected = year > HISTORY_END;
  let done = false;
  let stopAuto = noop;
  let input = null;
  let okBtn = null;
  let chipWrap = null;
  let counter = null;

  const finish = (fn, ...args) => {
    if (done) return;
    done = true;
    stopAuto();
    frame.close();
    try { fn(...args); } catch (e) { console.error('[moments] naming', e); }
  };
  const keep = () => finish(opts.onKeep || noop, fallback);
  const submit = () => {
    const name = cleanText(input.value, NAME_MAX);
    if (!name) { input.focus(); return; }
    finish(opts.onName || noop, name);
  };
  const sync = () => {
    const v = cleanText(input.value, NAME_MAX);
    counter.textContent = `${charCount(input.value)}/${NAME_MAX}`;
    okBtn.disabled = !v;
    for (const b of $$('.g-mchip', chipWrap)) b.setAttribute('aria-pressed', b.dataset.name === v ? 'true' : 'false');
  };

  const frame = shell({
    stamp: '取名',
    when: whenLine(state),
    projected,
    kind: 'naming',
    onEscape: keep,
    initialFocus: () => input,
    build(body, id) {
      chipWrap = h('div.g-mchips', { role: 'group', 'aria-label': '推荐的名字' }, suggestions.map((s) => h('button.g-mchip', {
        type: 'button', dataset: { name: s }, 'aria-pressed': 'false',
        onclick: () => { stopAuto(); input.value = s; sync(); input.focus(); },
      }, s)));
      counter = h('span.g-custom-n', { id: `${id}-n` }, `0/${NAME_MAX}`);
      input = h('input.g-mom-input', {
        id: `${id}-in`, type: 'text', maxlength: String(NAME_MAX * 2), autocomplete: 'off', spellcheck: 'false',
        value: fallback, 'aria-describedby': `${id}-hint ${id}-n`, placeholder: '写下一个名字',
      });
      input.addEventListener('input', () => {
        stopAuto();
        if (charCount(input.value) > NAME_MAX) input.value = Array.from(input.value).slice(0, NAME_MAX).join('');
        sync();
      });
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
      okBtn = h('button.g-btn.g-btn--primary', { type: 'button', onclick: submit }, '就叫这个名字');
      const autoLine = h('span.g-auto-line');
      body.append(
        h('h2.g-dlg-title', { id: `${id}-t` }, `给${sexWord}取个名字`),
        h('p.g-dlg-sit', { id: `${id}-s` }, `${sexWord}出生了。出生登记上，名字这一栏还空着——这个名字会陪着${sex === 'male' ? '他' : sex === 'female' ? '她' : 'TA'}走完一生。`),
        suggestions.length ? h('p.g-mom-k', '家里人想了几个') : null,
        suggestions.length ? chipWrap : null,
        h('div.g-mom-field',
          h('label.g-custom-lb', { for: `${id}-in` }, '名字'),
          input,
          h('div.g-custom-row',
            h('span.g-custom-hint', { id: `${id}-hint` }, `可以选一个，也可以自己写（最多 ${NAME_MAX} 个字）`),
            counter)),
        h('div.g-dlg-actions',
          autoLine,
          fallback ? h('button.g-btn.g-btn--ghost', { type: 'button', onclick: keep }, `就用「${fallback}」`) : null,
          okBtn));
      sync();
      if (opts.auto && fallback) {
        stopAuto = countdown(autoLine, autoMs(opts.speed, 6000), (s) => `自动抉择：${s} 秒后用「${fallback}」`, '我来取名', keep);
      }
    },
  });
  if (input && typeof input.select === 'function') { try { input.select(); } catch { /* ignore */ } }
  const close = () => { done = true; stopAuto(); frame.close(); };
  close.isOpen = frame.close.isOpen;
  return close;
}

// ---------------------------------------------------------------------------------------------------------------
// 停一停（5 / 15 / 30 / 50 / 70 岁）

/**
 * A reflection moment (state.reflectPending = {age, prompt}). The note is optional. "以后不再这样暂停" is reported
 * to the callbacks as {never: true}; the controller turns reflections off through app.saveSettings.
 */
export function openReflection(app, opts = {}) {
  const state = opts.state || app?.getLife?.() || null;
  const reflect = opts.reflect || state?.reflectPending || {};
  const age = Number.isFinite(reflect.age) ? reflect.age : state?.age;
  const prompt = cleanText(reflect.prompt, 160) || '走到这里，你最想记住的是什么？';
  const projected = state?.year > HISTORY_END;
  let done = false;
  let stopAuto = noop;
  let ta = null;
  let never = null;
  let okBtn = null;
  let counter = null;

  const flags = () => ({ never: !!(never && never.checked) });
  const finish = (fn, ...args) => {
    if (done) return;
    done = true;
    stopAuto();
    frame.close();
    try { fn(...args); } catch (e) { console.error('[moments] reflection', e); }
  };
  const skip = () => finish(opts.onSkip || noop, flags());
  const save = () => {
    const text = cleanText(ta.value, NOTE_MAX);
    if (!text) { skip(); return; }
    finish(opts.onSave || noop, text, flags());
  };

  const frame = shell({
    stamp: '回望',
    when: whenLine(state, null, age),
    projected,
    kind: 'reflect',
    onEscape: skip,
    initialFocus: () => ta,
    build(body, id) {
      counter = h('span.g-custom-n', { id: `${id}-n` }, `0/${NOTE_MAX}`);
      ta = h('textarea.g-custom-ta', {
        id: `${id}-ta`, rows: 3, maxlength: String(NOTE_MAX * 2), 'aria-describedby': `${id}-n`,
        placeholder: '写一句就好，也可以什么都不写',
      });
      okBtn = h('button.g-btn.g-btn--primary', { type: 'button', disabled: true, onclick: save }, '记下来');
      ta.addEventListener('input', () => {
        stopAuto();
        if (charCount(ta.value) > NOTE_MAX) ta.value = Array.from(ta.value).slice(0, NOTE_MAX).join('');
        counter.textContent = `${charCount(ta.value)}/${NOTE_MAX}`;
        okBtn.disabled = !cleanText(ta.value, NOTE_MAX);
      });
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save(); }
      });
      never = h('input', { type: 'checkbox', id: `${id}-never` });
      never.addEventListener('change', () => stopAuto());
      const autoLine = h('span.g-auto-line');
      body.append(
        h('h2.g-dlg-title', { id: `${id}-t` }, `${age} 岁，停一停`),
        h('p.g-dlg-sit.g-mom-prompt', { id: `${id}-s` }, prompt),
        h('div.g-mom-field',
          h('label.g-custom-lb', { for: `${id}-ta` }, '写给自己'),
          ta,
          h('div.g-custom-row',
            h('label.g-mom-never', { for: `${id}-never` }, never, '以后不再这样暂停'),
            counter)),
        h('div.g-dlg-actions',
          autoLine,
          h('button.g-btn.g-btn--ghost', { type: 'button', onclick: skip }, '不写了，继续'),
          okBtn),
        h('p.g-dlg-status', '写下的话会作为这一年的一行记录留下来。'));
      if (opts.auto) {
        stopAuto = countdown(autoLine, autoMs(opts.speed, 9000), (s) => `自动抉择：${s} 秒后继续`, '等一等', skip);
      }
    },
  });
  const close = () => { done = true; stopAuto(); frame.close(); };
  close.isOpen = frame.close.isOpen;
  return close;
}

// ---------------------------------------------------------------------------------------------------------------
// ✎ 写下想法

/** A free note for the current year (engine.addNote kind 'thought'). */
export function openThought(app, opts = {}) {
  const state = opts.state || app?.getLife?.() || null;
  const projected = state?.year > HISTORY_END;
  let done = false;
  let ta = null;
  let okBtn = null;
  let counter = null;

  const finish = (fn, ...args) => {
    if (done) return;
    done = true;
    frame.close();
    try { fn(...args); } catch (e) { console.error('[moments] thought', e); }
  };
  const cancel = () => finish(opts.onCancel || noop);
  const save = () => {
    const text = cleanText(ta.value, NOTE_MAX);
    if (!text) { ta.focus(); return; }
    finish(opts.onSave || noop, text);
  };

  const frame = shell({
    stamp: '随笔',
    when: whenLine(state),
    projected,
    kind: 'thought',
    onEscape: cancel,
    initialFocus: () => ta,
    build(body, id) {
      counter = h('span.g-custom-n', { id: `${id}-n` }, `0/${NOTE_MAX}`);
      ta = h('textarea.g-custom-ta', {
        id: `${id}-ta`, rows: 3, maxlength: String(NOTE_MAX * 2), 'aria-describedby': `${id}-s ${id}-n`,
        placeholder: '此刻的心情、一个念头、想对谁说的话……',
      });
      okBtn = h('button.g-btn.g-btn--primary', { type: 'button', disabled: true, onclick: save }, '记下来');
      ta.addEventListener('input', () => {
        if (charCount(ta.value) > NOTE_MAX) ta.value = Array.from(ta.value).slice(0, NOTE_MAX).join('');
        counter.textContent = `${charCount(ta.value)}/${NOTE_MAX}`;
        okBtn.disabled = !cleanText(ta.value, NOTE_MAX);
      });
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save(); }
      });
      body.append(
        h('h2.g-dlg-title', { id: `${id}-t` }, '写下此刻的想法'),
        h('p.g-dlg-sit', { id: `${id}-s` }, '它会作为这一年的一行记录留下来。时间先停在这里。'),
        h('div.g-mom-field',
          h('label.g-custom-lb', { for: `${id}-ta` }, '想法'),
          ta,
          h('div.g-custom-row', h('span.g-custom-hint', '只是记下，不会改变这一生的走向'), counter)),
        h('div.g-dlg-actions',
          h('button.g-btn.g-btn--ghost', { type: 'button', onclick: cancel }, '算了'),
          okBtn));
    },
  });
  const close = () => { done = true; frame.close(); };
  close.isOpen = frame.close.isOpen;
  return close;
}
