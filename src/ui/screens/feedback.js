// Feedback: a short form that goes to social.sendFeedback(text, page). When sharing is unavailable the text is kept
// in this browser and shown back with a copy button, so nothing the player wrote is lost.

import { h, clear, storage } from '../dom.js';
import { DATA_DATE } from '../../core/constants.js';
import * as social from '../../social/store.js';

const DRAFT_KEY = 'll2090.feedbackDraft';
const OUTBOX_KEY = 'll2090.feedbackOutbox';
const MAX = 980; // the store keeps 1000 characters; the "[类别] " prefix takes the rest
const KINDS = [
  { value: 'experience', label: '游玩体验' },
  { value: 'facts', label: '史实或数据有误' },
  { value: 'ai', label: 'AI 推演' },
  { value: 'idea', label: '建议' },
  { value: 'other', label: '其他' },
];

export function mount(root, params, app) {
  let alive = true;
  const draft = storage.get(DRAFT_KEY, null) || {};
  let kind = KINDS.some((k) => k.value === draft.kind) ? draft.kind : 'experience';
  const page = typeof params.from === 'string' && params.from ? params.from : 'feedback';

  const kindG = app.ui.boxGroup({
    id: 'll-fb-kind', name: 'll-fb-kind', legend: '关于什么', value: kind, compact: true,
    options: KINDS,
    onChange: (v) => { kind = v; storage.set(DRAFT_KEY, { kind, text: text.value }); },
  });
  const text = h('textarea#ll-fb-text.ll-textarea', {
    rows: 7, maxlength: MAX,
    placeholder: '哪里让你感动、困惑或不对劲？如果是史实或数据错误，请写明年份、国家和你看到的内容。',
  });
  text.value = typeof draft.text === 'string' ? draft.text : '';
  const count = h('span.ll-count.ll-num', `${text.value.length} / ${MAX}`);
  const sendBtn = h('button.ll-btn.ll-btn--ink', { type: 'submit', disabled: !text.value.trim() }, '发送反馈');
  text.addEventListener('input', () => {
    count.textContent = `${text.value.length} / ${MAX}`;
    sendBtn.disabled = !text.value.trim();
    storage.set(DRAFT_KEY, { kind, text: text.value });
  });
  const result = h('div.ll-fb-result', { 'aria-live': 'polite' });

  /** kind: 'local' = kept by the store on this device (no sharing service); 'failed' = could not be stored there. */
  function showLocal(body, kind, reason) {
    const box = h('textarea#ll-fb-copy.ll-textarea.ll-fb-copy', { readonly: true, rows: 5, 'aria-label': '反馈全文' });
    box.value = body;
    const copyBtn = h('button.ll-btn.ll-btn--line.ll-btn--small', {
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(body);
          app.toast('已复制', 'good');
        } catch {
          box.focus();
          box.select();
          app.toast('已选中全文，请手动复制', 'info');
        }
      },
    }, '复制全文');
    clear(result).append(h('div.ll-fb-note.is-local', { role: 'status' },
      h('p.ll-fb-note-title', kind === 'local' ? '反馈已保存在本机' : '反馈暂时没能送出'),
      h('p', kind === 'local'
        ? '当前没有连接共享服务，反馈只保存在这个浏览器里，不会自动发送。可以复制下面的内容，通过其他方式告诉我们。'
        : `${reason ? reason + '。' : ''}你写的内容已经留在这个浏览器里，不会丢失。可以稍后再试，或者复制下面的内容，通过其他方式告诉我们。`),
      box,
      h('div.ll-actions', copyBtn)));
  }

  const formEl = h('form.ll-doc.ll-fb', {
    id: 'll-fb-form', novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      const body = text.value.trim();
      if (!body) return;
      const label = (KINDS.find((k) => k.value === kind) || KINDS[0]).label;
      const payload = `[${label}] ${body}`;
      sendBtn.disabled = true;
      sendBtn.textContent = '正在发送…';
      // outcome: 'sent' (shared service), 'local' (the store kept it on this device), 'failed'
      let outcome = 'failed';
      let reason = '';
      try {
        if (typeof social.sendFeedback !== 'function') throw new Error('no store');
        const r = await social.sendFeedback(payload, page);
        if (r && typeof r === 'object' && r.ok) outcome = r.mode === 'shared' ? 'sent' : 'local';
        else if (r === true) outcome = app.social.mode === 'shared' ? 'sent' : 'local';
        else reason = r && typeof r === 'object' && typeof r.message === 'string' ? r.message.replace(/[。.]$/, '') : '';
      } catch (err) {
        console.error(err);
        outcome = 'failed';
      }
      if (!alive) return;
      sendBtn.textContent = '发送反馈';
      if (outcome === 'sent') {
        storage.remove(DRAFT_KEY);
        text.value = '';
        count.textContent = `0 / ${MAX}`;
        sendBtn.disabled = true;
        clear(result).append(h('div.ll-fb-note.is-sent', { role: 'status' },
          h('p.ll-fb-note-title', '已收到，谢谢你'),
          h('p', '每一条反馈都会被读到。史实和数据方面的更正会在核实后更新。')));
        app.toast('反馈已发送', 'good');
      } else if (outcome === 'local') {
        storage.remove(DRAFT_KEY);
        text.value = '';
        count.textContent = `0 / ${MAX}`;
        sendBtn.disabled = true;
        showLocal(payload, 'local');
        app.toast('反馈已保存在本机', 'info');
      } else {
        // keep the draft in the box and a copy in a small outbox, so nothing the player wrote is lost
        const kept = storage.get(OUTBOX_KEY, []);
        const list = Array.isArray(kept) ? kept : [];
        list.push({ at: new Date().toISOString(), page, text: payload });
        storage.set(OUTBOX_KEY, list.slice(-20));
        sendBtn.disabled = !text.value.trim();
        showLocal(payload, 'failed', reason);
      }
    },
  },
  kindG,
  h('div.ll-field',
    h('div.ll-field-head', h('label.ll-label', { for: 'll-fb-text' }, '你的反馈'), count),
    text,
    h('p.ll-hint', '请不要写下真实姓名、电话等个人信息。')),
  h('div.ll-form-actions', sendBtn,
    h('button.ll-btn.ll-btn--ghost', { type: 'button', onclick: () => app.back() }, '返回')),
  result);

  root.append(
    h('div.ll-page-head',
      h('p.ll-eyebrow', '意见与更正'),
      h('h1.ll-h1', '反馈'),
      h('p.ll-lede', `人生长河的史实与数据截至 ${DATA_DATE}。发现错误、有想法，或者某段人生让你想说点什么，都可以写在这里。`),
      app.social.mode === 'shared' ? null : h('p.ll-hint', '当前没有连接共享服务：发送不出去时，反馈会保存在本机，并提供复制。')),
    formEl);

  return () => { alive = false; };
}
