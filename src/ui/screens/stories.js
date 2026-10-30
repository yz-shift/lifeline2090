// 生活片段 — real stories and photos from the people who open this page, plus a photo wall.
// Views (params.view): 'feed' (default) | 'wall' | 'mine' | 'compose' | 'detail' (params.id).
// All shared text is untrusted: rendered through h() (textContent) only; photos only as <img src>.

import { h, clear, fmt } from '../dom.js';
import * as S from '../../social/stories.js';

const PROMPTS = [
  '留下一张你舍不得删的照片，讲讲它为什么值得记住。',
  '最近一次让你觉得"活着真好"的瞬间是什么？',
  '有没有一个普通的日子，你到现在还记得？',
  '谁让你觉得被好好地爱着？那天发生了什么？',
];

function relTime(iso) {
  if (!iso) return '';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(d)) return '';
  if (d < 90) return '刚刚';
  if (d < 3600) return `${Math.round(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.round(d / 3600)} 小时前`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)} 天前`;
  return iso.slice(0, 10);
}

function photoEl(story, cls = 'st-photo', lazy = true) {
  const src = S.photoSrc(story);
  if (!src) return null;
  const img = h('img.' + cls, { src, alt: story.title ? `照片：${story.title}` : '分享的照片', loading: lazy ? 'lazy' : 'eager', decoding: 'async' });
  if (story.photoW && story.photoH) { img.width = story.photoW; img.height = story.photoH; }
  img.addEventListener('error', () => { img.replaceWith(h('div.st-photo-missing', '这张照片暂时无法显示')); }, { once: true });
  return img;
}

function meta(story) {
  const bits = [story.when, story.place, ...story.tags.map((t) => '#' + t), relTime(story.createdAt)].filter(Boolean);
  return h('p.st-meta', bits.join(' · '), story.seed ? h('span.st-badge', '示例') : null, story.visibility === 'private' ? h('span.st-badge', '仅自己可见') : null);
}

export function mount(root, params = {}, app) {
  let view = params.compose ? 'compose' : ['feed', 'wall', 'mine', 'compose', 'detail'].includes(params.view) ? params.view : 'feed';
  let currentId = params.id || null;
  let stories = [];
  let status = { mode: 'local', canPost: true, canUploadPhoto: true };
  let destroyed = false;
  const offs = [];

  const tabs = h('nav.st-tabs', { role: 'tablist', 'aria-label': '生活片段' });
  const banner = h('div.st-banner', { hidden: true });
  const body = h('div.st-body');
  const page = h('section.st-page',
    h('header.st-hd',
      h('p.st-eyebrow', '生活片段 · 真实的人生'),
      h('h1.st-title', '把值得记住的日子留下来'),
      h('p.st-lede', '模拟里的人生是推演出来的，这里的故事是真的。不必精彩，也不必圆满，一个普通的瞬间就够了。')),
    tabs, banner, body);
  root.append(page);

  function go(v, id) {
    view = v; currentId = id || null;
    render();
    try { page.scrollIntoView({ block: 'start' }); } catch { /* ignore */ }
  }

  function renderTabs() {
    clear(tabs);
    const items = [['feed', '故事'], ['wall', '照片墙'], ['mine', '我的'], ['compose', '写一段']];
    for (const [k, label] of items) {
      const active = view === k || (view === 'detail' && k === 'feed');
      tabs.append(h('button.st-tab', { type: 'button', role: 'tab', 'aria-selected': active ? 'true' : 'false', class: active ? 'is-on' : '', onclick: () => go(k) }, label));
    }
  }

  function renderBanner() {
    const msgs = [];
    if (status.mode === 'local') msgs.push('这是单机版：你写的故事只保存在这台设备的浏览器里，别人看不到。下面带「示例」标记的照片故事来自公开授权的资料。');
    else if (!status.canPost) msgs.push('你在这个页面上只能阅读和回应，不能发布新故事。');
    else if (!status.canUploadPhoto) msgs.push('你在这个页面上可以写故事，但暂时不能上传照片。');
    banner.hidden = !msgs.length;
    clear(banner).append(...msgs.map((m) => h('p', m)));
  }

  function empty(title, text, action) {
    return h('div.st-empty', h('p.st-empty-t', title), h('p', text), action || null);
  }

  // ------------------------------------------------------------------ feed / mine
  function card(s) {
    return h('article.st-card', {
      tabIndex: 0, role: 'link', 'aria-label': s.title || '一段故事',
      onclick: () => go('detail', s.id), onkeydown: (e) => { if (e.key === 'Enter') go('detail', s.id); },
    }, photoEl(s), h('div.st-card-b', s.title ? h('h2.st-card-t', s.title) : null, s.text ? h('p.st-card-x', s.text) : null, meta(s)));
  }

  function renderList(mine) {
    const list = mine ? stories.filter((s) => s.mine) : stories.filter((s) => s.visibility === 'public');
    if (!list.length) {
      return mine
        ? empty('你还没有写过故事', '写下的故事会出现在这里，包括只给自己看的那些。', h('button.st-btn.is-primary', { type: 'button', onclick: () => go('compose') }, '写第一段'))
        : empty('这里还没有故事', '第一段故事可以是你的：一张照片，几句话，讲讲它为什么值得记住。', h('button.st-btn.is-primary', { type: 'button', onclick: () => go('compose') }, '写一段'));
    }
    return h('div.st-grid', list.map(card));
  }

  // ------------------------------------------------------------------ wall
  function renderWall() {
    const withPhotos = stories.filter((s) => s.photo && s.visibility === 'public');
    if (!withPhotos.length) return empty('照片墙还是空的', '发布故事时附上一张照片，它就会出现在这面墙上。', h('button.st-btn.is-primary', { type: 'button', onclick: () => go('compose') }, '放上一张照片'));
    return h('div.st-wall', withPhotos.map((s) => h('button.st-tile', { type: 'button', onclick: () => go('detail', s.id), 'aria-label': s.title || '打开这段故事' },
      photoEl(s, 'st-tile-img'), s.title ? h('span.st-tile-cap', s.title) : null)));
  }

  // ------------------------------------------------------------------ compose
  function renderCompose() {
    let file = null;
    const tags = new Set();
    const prompt = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
    const preview = h('div.st-preview', h('p', '还没有选照片（可以不放）'));
    const fileIn = h('input#st-file.st-file', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif' });
    fileIn.addEventListener('change', () => {
      file = fileIn.files && fileIn.files[0] ? fileIn.files[0] : null;
      clear(preview);
      if (!file) { preview.append(h('p', '还没有选照片（可以不放）')); return; }
      const url = URL.createObjectURL(file);
      const img = h('img.st-preview-img', { src: url, alt: '准备分享的照片' });
      img.onload = () => URL.revokeObjectURL(url);
      preview.append(img, h('button.st-link', { type: 'button', onclick: () => { file = null; fileIn.value = ''; clear(preview).append(h('p', '还没有选照片（可以不放）')); } }, '不放照片了'));
    });
    const title = h('input#st-title.st-in', { type: 'text', maxLength: S.STORY_LIMITS.title, placeholder: '给它起个名字，比如「外婆家的夏天」' });
    const text = h('textarea#st-text.st-ta', { maxLength: S.STORY_LIMITS.text, rows: 7, placeholder: prompt });
    const count = h('span.st-count', `0 / ${S.STORY_LIMITS.text}`);
    text.addEventListener('input', () => { count.textContent = `${text.value.length} / ${S.STORY_LIMITS.text}`; });
    const when = h('input#st-when.st-in', { type: 'text', maxLength: S.STORY_LIMITS.when, placeholder: '什么时候（可不填）：2019 年夏天' });
    const place = h('input#st-place.st-in', { type: 'text', maxLength: S.STORY_LIMITS.place, placeholder: '在哪里（可不填）' });
    const tagRow = h('div.st-tags', S.STORY_TAGS.map((t) => {
      const b = h('button.st-tag', { type: 'button', 'aria-pressed': 'false' }, t);
      b.onclick = () => {
        if (tags.has(t)) tags.delete(t); else if (tags.size < S.STORY_LIMITS.tags) tags.add(t);
        for (const el of tagRow.children) el.setAttribute('aria-pressed', tags.has(el.textContent) ? 'true' : 'false');
      };
      return b;
    }));
    const visPublic = h('input#st-vis-pub', { type: 'radio', name: 'st-vis', value: 'public', checked: true });
    const visPrivate = h('input#st-vis-pri', { type: 'radio', name: 'st-vis', value: 'private' });
    const msg = h('p.st-msg', { role: 'status', 'aria-live': 'polite' });
    const submit = h('button.st-btn.is-primary', { type: 'submit' }, '发布');
    const form = h('form.st-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        msg.textContent = file ? '正在整理照片并发布…' : '正在发布…';
        const res = await S.postStory({ title: title.value, text: text.value, when: when.value, place: place.value, tags: [...tags], visibility: visPrivate.checked ? 'private' : 'public', photoFile: file });
        if (destroyed) return;
        submit.disabled = false;
        if (!res.ok) { msg.textContent = res.message; return; }
        app && app.toast && app.toast(res.note || '已发布。谢谢你愿意分享。');
        stories = await S.listStories();
        go('detail', res.story.id);
      },
    },
      h('p.st-prompt', prompt),
      h('div.st-field', h('label.st-l', { for: 'st-file' }, '照片'), fileIn, preview,
        status.mode === 'shared' && !status.canUploadPhoto ? h('p.st-hint', '你在这个页面上暂时不能上传照片，可以只写文字。') : null),
      h('div.st-field', h('label.st-l', { for: 'st-title' }, '标题'), title),
      h('div.st-field', h('label.st-l', { for: 'st-text' }, '故事'), text, count),
      h('div.st-row', h('div.st-field', h('label.st-l', { for: 'st-when' }, '时间'), when), h('div.st-field', h('label.st-l', { for: 'st-place' }, '地点'), place)),
      h('div.st-field', h('span.st-l', '标签（最多 3 个）'), tagRow),
      h('fieldset.st-vis', h('legend.st-l', '谁能看到'),
        h('label.st-radio', visPublic, ' 所有能打开这个页面的人'),
        h('label.st-radio', visPrivate, ' 只有我自己')),
      h('p.st-hint', '请不要写下真实的手机号、住址这类信息；照片里有别人的话，最好先征得对方同意。发布后随时可以删除。'),
      h('div.st-actions', submit, h('button.st-btn', { type: 'button', onclick: () => go('feed') }, '算了')),
      msg);
    if (!status.canPost) { submit.disabled = true; msg.textContent = '你在这个页面上不能发布。'; }
    return form;
  }

  // ------------------------------------------------------------------ detail
  function renderDetail() {
    const s = stories.find((x) => x.id === currentId);
    if (!s) return empty('找不到这段故事', '它可能已经被作者删除了。', h('button.st-btn', { type: 'button', onclick: () => go('feed') }, '回到故事'));
    const reactRow = h('div.st-react', { role: 'group', 'aria-label': '回应' });
    const repliesEl = h('ul.st-replies');
    const replyIn = h('textarea#st-reply.st-ta.is-small', { maxLength: S.STORY_LIMITS.reply, rows: 2, placeholder: '写一句真心的回应' });
    const replyMsg = h('p.st-msg', { role: 'status', 'aria-live': 'polite' });

    async function loadReactions() {
      const { counts, mine } = await S.reactionsFor(s.id);
      if (destroyed) return;
      clear(reactRow);
      for (const [k, label] of Object.entries(S.REACTIONS)) {
        const on = mine === k;
        reactRow.append(h('button.st-rbtn', {
          type: 'button', 'aria-pressed': on ? 'true' : 'false',
          onclick: async () => { await S.react(s.id, on ? null : k); loadReactions(); },
        }, label, counts[k] ? h('span.st-rcount', String(counts[k])) : null));
      }
    }
    async function loadReplies() {
      const list = await S.listReplies(s.id);
      if (destroyed) return;
      clear(repliesEl);
      if (!list.length) repliesEl.append(h('li.st-reply.is-empty', '还没有人回应。'));
      for (const r of list) {
        repliesEl.append(h('li.st-reply', h('p', r.text), h('p.st-meta', (r.mine ? '你 · ' : '一位访客 · ') + relTime(r.at),
          r.mine ? h('button.st-link', { type: 'button', onclick: async () => { await S.deleteReply(s.id, r.id); loadReplies(); } }, '删除') : null)));
      }
    }
    loadReactions();
    loadReplies();

    return h('article.st-detail',
      h('button.st-link.st-back', { type: 'button', onclick: () => go(s.mine && view === 'detail' && params.from === 'mine' ? 'mine' : 'feed') }, '← 返回'),
      photoEl(s, 'st-detail-img', false),
      s.title ? h('h2.st-detail-t', s.title) : null,
      meta(s),
      s.text ? h('div.st-detail-x', s.text) : null,
      s.source && (s.source.author || s.source.url) ? h('p.st-credit',
        s.seed ? '示例内容。' : '', '照片：', s.source.author || '佚名',
        s.source.license ? ` · ${s.source.license}` : '',
        s.source.url ? [' · ', h('a', { href: s.source.url, target: '_blank', rel: 'noopener noreferrer' }, s.source.name || '原始出处')] : null) : null,
      h('section.st-respond', h('h3.st-sub', '回应'), reactRow, repliesEl,
        h('form.st-reply-form', {
          onsubmit: async (e) => {
            e.preventDefault();
            const res = await S.addReply(s.id, replyIn.value);
            replyMsg.textContent = res.ok ? '' : res.message;
            if (res.ok) { replyIn.value = ''; loadReplies(); }
          },
        }, h('label.st-l', { for: 'st-reply' }, '你的回应'), replyIn, h('button.st-btn', { type: 'submit' }, '发送'), replyMsg)),
      s.mine ? h('div.st-actions', h('button.st-btn.is-danger', {
        type: 'button',
        onclick: async () => {
          const ok = app && typeof app.confirm === 'function'
            ? await app.confirm({ title: '删除这段故事？', body: '删除后无法恢复，照片也会一起删除。', ok: '删除', cancel: '再想想' })
            : true;
          if (!ok) return;
          await S.deleteStory(s);
          stories = await S.listStories();
          go('mine');
        },
      }, '删除这段故事')) : null);
  }

  function render() {
    if (destroyed) return;
    renderTabs();
    renderBanner();
    clear(body);
    if (view === 'wall') body.append(renderWall());
    else if (view === 'mine') body.append(renderList(true));
    else if (view === 'compose') body.append(renderCompose());
    else if (view === 'detail') body.append(renderDetail());
    else body.append(renderList(false));
  }

  render();
  (async () => {
    status = await S.storiesStatus();
    if (destroyed) return;
    offs.push(S.subscribeStories((list) => {
      if (destroyed) return;
      stories = list;
      // do not wipe a half-written story or a reply being typed
      if (view !== 'compose' && view !== 'detail') render();
      else if (view === 'detail' && !body.querySelector('.st-detail')) render();
    }));
    render();
  })();

  return () => { destroyed = true; for (const off of offs) { try { off(); } catch { /* ignore */ } } };
}

export const _test = { relTime, PROMPTS, fmt };
