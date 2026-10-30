// 生活片段: real stories and photos shared by the people who open the page.
// Shared mode (claude.ai): stories live in the db collection `stories`, photos in the asset store (the db row keeps
// the asset id and pages show it as "/_blob/" + id). Private stories live in the viewer's own data/users/<id>
// subtree. One reaction per viewer per story (`stories/<id>/reactions/<viewer>`), short replies in
// `stories/<id>/replies`. Local mode (no window.claude): everything stays in this browser's localStorage, photos as
// small JPEG data URLs.
// Everything read back is untrusted: sanitised here, rendered only as text / image sources by the screens.

import { storage, bus } from '../ui/dom.js';
import { socialContext, cleanLine, cleanText } from './store.js';
import { loadSeed, SEED_PHOTO_RE } from './seed.js';

export const STORY_LIMITS = Object.freeze({ title: 40, text: 2000, when: 20, place: 24, reply: 300, tags: 3, list: 300, replies: 100, localStories: 24 });
export const STORY_TAGS = Object.freeze(['家人', '朋友', '爱情', '孩子', '童年', '求学', '工作', '远方', '日常', '美食', '自然', '宠物', '重逢', '告别', '第一次', '小确幸']);
export const REACTIONS = Object.freeze({ warm: '温暖', same: '我也是', hug: '抱抱' });
const LOCAL_KEY = 'll2090.stories';
const LOCAL_REACT = 'll2090.storyReactions';
const LOCAL_REPLIES = 'll2090.storyReplies';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const cleanId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_\-.~:@+]{1,80}$/.test(v) ? v : null);
const ASSET_RE = /^[0-9a-f]{32}$/;
const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

function newId() {
  const a = new Uint32Array(2);
  try { crypto.getRandomValues(a); } catch { a[0] = Date.now() >>> 0; a[1] = (Math.random() * 2 ** 32) >>> 0; }
  return 's' + Date.now().toString(36) + a[0].toString(36) + a[1].toString(36).slice(0, 4);
}

function cleanDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return '';
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t > Date.now() + 2 * 86400000) return '';
  return new Date(t).toISOString();
}

/** Normalise an untrusted story row. Returns null when unusable. */
export function sanitizeStory(id, raw, viewerId) {
  if (!isObj(raw)) return null;
  const sid = cleanId(id) || cleanId(raw.id);
  if (!sid) return null;
  const title = cleanLine(raw.title, STORY_LIMITS.title);
  const text = cleanText(raw.text, STORY_LIMITS.text);
  const photo = typeof raw.photo === 'string' && (ASSET_RE.test(raw.photo) || DATA_URL_RE.test(raw.photo) || SEED_PHOTO_RE.test(raw.photo)) ? raw.photo : null;
  if (!title && !text && !photo) return null;
  const w = Number(raw.photoW), h = Number(raw.photoH);
  return {
    id: sid,
    title,
    text,
    photo,
    photoW: Number.isFinite(w) && w > 0 && w < 10000 ? Math.round(w) : null,
    photoH: Number.isFinite(h) && h > 0 && h < 10000 ? Math.round(h) : null,
    when: cleanLine(raw.when, STORY_LIMITS.when),
    place: cleanLine(raw.place, STORY_LIMITS.place),
    tags: (Array.isArray(raw.tags) ? raw.tags : []).filter((t) => STORY_TAGS.includes(t)).slice(0, STORY_LIMITS.tags),
    visibility: raw.visibility === 'private' ? 'private' : 'public',
    createdAt: cleanDate(raw.createdAt),
    // example stories seeded by the page owner from openly licensed sources: label and attribution
    seed: raw.seed === true,
    source: isObj(raw.source) ? {
      name: cleanLine(raw.source.name, 40),
      author: cleanLine(raw.source.author, 80),
      license: cleanLine(raw.source.license, 40),
      url: typeof raw.source.url === 'string' && /^https:\/\/[^\s"'<>]{4,300}$/.test(raw.source.url) ? raw.source.url : '',
    } : null,
    mine: !!viewerId && raw.authorId === viewerId,
  };
}

/** Display source for a story photo (asset id or local data URL). */
export function photoSrc(story) {
  if (!story || !story.photo) return null;
  return ASSET_RE.test(story.photo) ? '/_blob/' + story.photo : story.photo; // data: URL or bundled seed/*.jpg
}

function emit() { bus.emit('stories:changed'); }

// ---------------------------------------------------------------------------------------------------- capabilities

let assetsP = null;
async function assetsCap() {
  if (!assetsP) {
    assetsP = (async () => {
      try {
        const c = globalThis.window && globalThis.window.claude;
        if (!c || typeof c.use !== 'function') return null;
        return (await c.use('assets')) || null;
      } catch { return null; }
    })();
  }
  return assetsP;
}

/** What this viewer can do: {mode, canPost, canUploadPhoto, owner}. */
export async function storiesStatus() {
  const ctx = await socialContext();
  if (ctx.mode === 'local') return { mode: 'local', canPost: true, canUploadPhoto: true, owner: true };
  const assets = await assetsCap();
  return { mode: 'shared', canPost: ctx.canWrite, canUploadPhoto: !!assets, owner: ctx.owner };
}

// ---------------------------------------------------------------------------------------------------- photos

/** Downscale a picked image file to a JPEG blob (max side `max` px). Resolves {blob, width, height, dataUrl?}. */
export function preparePhoto(file, max = 1600, quality = 0.85, wantDataUrl = false) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(file.type || '')) { reject({ code: 'unsupported_type' }); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const g = cv.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, w, h);
      g.drawImage(img, 0, 0, w, h);
      const dataUrl = wantDataUrl ? cv.toDataURL('image/jpeg', quality) : null;
      cv.toBlob((blob) => (blob ? resolve({ blob, width: w, height: h, dataUrl }) : reject({ code: 'invalid_request' })), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject({ code: 'unsupported_type' }); };
    img.src = url;
  });
}

const PHOTO_ERRORS = {
  too_large: '照片太大了，请换一张小一些的。',
  unsupported_type: '这种图片格式无法上传，请换成 JPG 或 PNG。',
  quota_or_state: '这个页面的照片空间已经满了。',
  rate_limited: '上传太频繁了，请稍后再试。',
  upstream_auth: '登录状态失效了，请刷新页面后再试。',
  not_granted: '你在这个页面上没有上传照片的权限。',
  capability_disabled: '这里暂时不能上传照片。',
};
export const photoErrorText = (e) => PHOTO_ERRORS[e && e.code] || '照片没有传上去，请稍后再试。';

// ---------------------------------------------------------------------------------------------------- local mode

function localAll() {
  const arr = storage.get(LOCAL_KEY, []);
  return Array.isArray(arr) ? arr : [];
}
function localSave(arr) {
  // keep the newest stories that fit; localStorage is small
  let list = arr.slice(0, STORY_LIMITS.localStories);
  // always write (an empty list must be saved too); trim the oldest only when the browser runs out of space
  while (!storage.set(LOCAL_KEY, list) && list.length) list = list.slice(0, -1);
  return list.length === arr.length;
}

// ---------------------------------------------------------------------------------------------------- write

/**
 * Publish a story. input: {title, text, when, place, tags, visibility, photoFile?}.
 * Resolves {ok:true, story} or {ok:false, message}.
 */
export async function postStory(input) {
  const ctx = await socialContext();
  const draft = {
    title: cleanLine(input.title, STORY_LIMITS.title),
    text: cleanText(input.text, STORY_LIMITS.text),
    when: cleanLine(input.when, STORY_LIMITS.when),
    place: cleanLine(input.place, STORY_LIMITS.place),
    tags: (Array.isArray(input.tags) ? input.tags : []).filter((t) => STORY_TAGS.includes(t)).slice(0, STORY_LIMITS.tags),
    visibility: input.visibility === 'private' ? 'private' : 'public',
  };
  if (!draft.title && !draft.text && !input.photoFile) return { ok: false, message: '写一句话，或者选一张照片。' };
  const id = newId();
  const createdAt = new Date().toISOString();

  if (ctx.mode === 'local') {
    let photo = null, photoW = null, photoH = null;
    if (input.photoFile) {
      try {
        const p = await preparePhoto(input.photoFile, 720, 0.72, true);
        photo = p.dataUrl; photoW = p.width; photoH = p.height;
      } catch (e) { return { ok: false, message: photoErrorText(e) }; }
    }
    const row = { id, ...draft, photo, photoW, photoH, createdAt, authorId: ctx.viewerId };
    const all = [row, ...localAll()];
    const kept = localSave(all);
    emit();
    return { ok: true, story: sanitizeStory(id, row, ctx.viewerId), note: kept ? '' : '本机空间有限，最早的几则故事被移除了。' };
  }

  if (!ctx.db || !ctx.canWrite) return { ok: false, message: '你在这个页面上只能阅读，不能发布。' };
  let photo = null, photoW = null, photoH = null;
  if (input.photoFile) {
    const assets = await assetsCap();
    if (!assets) return { ok: false, message: '你在这个页面上不能上传照片，可以只写文字。' };
    try {
      const p = await preparePhoto(input.photoFile);
      const res = await assets.upload(p.blob, { type: 'image/jpeg' });
      photo = res.id; photoW = p.width; photoH = p.height;
    } catch (e) { return { ok: false, message: photoErrorText(e) }; }
  }
  const row = { v: 1, id, ...draft, photo, photoW, photoH, createdAt, authorId: ctx.viewerId };
  try {
    if (draft.visibility === 'private') {
      if (!ctx.platformId) return { ok: false, message: '需要登录后才能保存仅自己可见的故事。' };
      await ctx.db.collection('data/users/' + ctx.platformId).doc('story_' + id).set(row);
    } else {
      await ctx.db.collection('stories').doc(id).set(row);
    }
  } catch (e) {
    return { ok: false, message: e && e.code === 'quota_exceeded' ? '这里的故事已经太多了，暂时不能再发布。' : '没有发布成功，请稍后再试。' };
  }
  emit();
  return { ok: true, story: sanitizeStory(id, row, ctx.viewerId) };
}

/** Delete one of the viewer's own stories (and its photo when this viewer uploaded it). */
export async function deleteStory(story) {
  const ctx = await socialContext();
  if (!story || !story.id) return false;
  if (ctx.mode === 'local') {
    localSave(localAll().filter((s) => s.id !== story.id));
    emit();
    return true;
  }
  if (!ctx.db) return false;
  try {
    if (story.visibility === 'private' && ctx.platformId) await ctx.db.collection('data/users/' + ctx.platformId).doc('story_' + story.id).delete();
    else await ctx.db.collection('stories').doc(story.id).delete();
  } catch { return false; }
  if (story.photo && ASSET_RE.test(story.photo)) {
    const assets = await assetsCap();
    if (assets) { try { await assets.delete(story.photo); } catch { /* someone else's or already gone */ } }
  }
  emit();
  return true;
}

// ---------------------------------------------------------------------------------------------------- read

/** Public stories newest first, plus the viewer's own private ones when `includeMine`. */
export async function listStories({ includeMine = true } = {}) {
  const ctx = await socialContext();
  if (ctx.mode === 'local') {
    const own = localAll().map((r) => sanitizeStory(r.id, r, ctx.viewerId)).filter(Boolean);
    const seed = (await loadSeed()).stories.map((r) => sanitizeStory(r.id, r, null)).filter(Boolean);
    return own.concat(seed.filter((x) => !own.some((o) => o.id === x.id)));
  }
  if (!ctx.db) return [];
  const out = [];
  try {
    const snap = await ctx.db.collection('stories').orderBy('createdAt', 'desc').limit(STORY_LIMITS.list).get();
    for (const d of snap.docs) { const s = sanitizeStory(d.id, d.data(), ctx.viewerId); if (s && s.visibility === 'public') out.push(s); }
  } catch { /* degrade to what we have */ }
  if (includeMine && ctx.platformId) {
    try {
      const snap = await ctx.db.collection('data/users/' + ctx.platformId).limit(200).get();
      for (const d of snap.docs) {
        if (!d.id.startsWith('story_')) continue;
        const s = sanitizeStory(d.id.slice(6), d.data(), ctx.viewerId);
        if (s) { s.visibility = 'private'; s.mine = true; out.push(s); }
      }
    } catch { /* ignore */ }
  }
  out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return out;
}

/** Live public feed: cb(stories). Returns unsubscribe. Local mode re-reads on changes. */
export function subscribeStories(cb) {
  let stop = null;
  let off = bus.on('stories:changed', () => listStories().then(cb, () => {}));
  (async () => {
    const ctx = await socialContext();
    if (ctx.mode === 'local' || !ctx.db) { cb(await listStories()); return; }
    let mine = [];
    const refreshMine = async () => {
      if (!ctx.platformId) return;
      mine = (await listStories({ includeMine: true })).filter((s) => s.visibility === 'private');
    };
    await refreshMine();
    stop = ctx.db.collection('stories').orderBy('createdAt', 'desc').limit(STORY_LIMITS.list).onSnapshot((snap) => {
      const pub = snap.docs.map((d) => sanitizeStory(d.id, d.data(), ctx.viewerId)).filter((s) => s && s.visibility === 'public');
      const all = pub.concat(mine).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      cb(all);
    }, () => { listStories().then(cb, () => {}); });
    off(); // the live query replaces bus refreshes, but private stories still need a refresh on local edits
    off = bus.on('stories:changed', async () => { await refreshMine(); });
  })();
  return () => { try { stop && stop(); } catch { /* ignore */ } off(); };
}

// ---------------------------------------------------------------------------------------------------- reactions & replies

/** Counts per reaction and this viewer's own reaction. */
export async function reactionsFor(storyId) {
  const ctx = await socialContext();
  const counts = { warm: 0, same: 0, hug: 0 };
  let mine = null;
  if (ctx.mode === 'local' || !ctx.db) {
    const all = storage.get(LOCAL_REACT, {}) || {};
    const k = all[storyId];
    if (k && REACTIONS[k]) { counts[k] = 1; mine = k; }
    return { counts, mine };
  }
  try {
    const snap = await ctx.db.collection(`stories/${storyId}/reactions`).limit(1000).get();
    for (const d of snap.docs) {
      const k = d.data() && d.data().kind;
      if (REACTIONS[k]) counts[k]++;
      if (d.id === ctx.viewerId) mine = REACTIONS[k] ? k : null;
    }
  } catch { /* ignore */ }
  return { counts, mine };
}

const inflight = new Map();
/** Set (or clear with null) this viewer's single reaction. */
export async function react(storyId, kind) {
  if (inflight.has(storyId)) return inflight.get(storyId);
  const p = (async () => {
    const ctx = await socialContext();
    if (!cleanId(storyId)) return false;
    if (ctx.mode === 'local' || !ctx.db) {
      const all = storage.get(LOCAL_REACT, {}) || {};
      if (kind && REACTIONS[kind]) all[storyId] = kind; else delete all[storyId];
      storage.set(LOCAL_REACT, all);
      return true;
    }
    try {
      const ref = ctx.db.collection(`stories/${storyId}/reactions`).doc(ctx.viewerId);
      if (kind && REACTIONS[kind]) await ref.set({ kind, at: new Date().toISOString() });
      else await ref.delete();
      return true;
    } catch { return false; }
  })().finally(() => inflight.delete(storyId));
  inflight.set(storyId, p);
  return p;
}

export async function listReplies(storyId) {
  const ctx = await socialContext();
  if (ctx.mode === 'local' || !ctx.db) {
    const all = storage.get(LOCAL_REPLIES, {}) || {};
    return (Array.isArray(all[storyId]) ? all[storyId] : []).map((r) => ({ id: r.id, text: cleanText(r.text, STORY_LIMITS.reply), at: cleanDate(r.at), mine: true })).filter((r) => r.text);
  }
  try {
    const snap = await ctx.db.collection(`stories/${storyId}/replies`).orderBy('at', 'asc').limit(STORY_LIMITS.replies).get();
    return snap.docs.map((d) => {
      const r = d.data() || {};
      return { id: d.id, text: cleanText(r.text, STORY_LIMITS.reply), at: cleanDate(r.at), mine: r.authorId === ctx.viewerId };
    }).filter((r) => r.text);
  } catch { return []; }
}

let lastReply = 0;
export async function addReply(storyId, text) {
  const t = cleanText(text, STORY_LIMITS.reply);
  if (!t) return { ok: false, message: '写点什么再发送吧。' };
  if (Date.now() - lastReply < 8000) return { ok: false, message: '慢一点，过几秒再发。' };
  lastReply = Date.now();
  const ctx = await socialContext();
  const row = { id: newId(), text: t, at: new Date().toISOString(), authorId: ctx.viewerId };
  if (ctx.mode === 'local' || !ctx.db) {
    const all = storage.get(LOCAL_REPLIES, {}) || {};
    all[storyId] = [...(Array.isArray(all[storyId]) ? all[storyId] : []), row].slice(-STORY_LIMITS.replies);
    storage.set(LOCAL_REPLIES, all);
    return { ok: true };
  }
  try {
    await ctx.db.collection(`stories/${storyId}/replies`).doc(row.id).set(row);
    return { ok: true };
  } catch { lastReply = 0; return { ok: false, message: '没有发送成功，请稍后再试。' }; }
}

export async function deleteReply(storyId, replyId) {
  const ctx = await socialContext();
  if (ctx.mode === 'local' || !ctx.db) {
    const all = storage.get(LOCAL_REPLIES, {}) || {};
    all[storyId] = (all[storyId] || []).filter((r) => r.id !== replyId);
    storage.set(LOCAL_REPLIES, all);
    return true;
  }
  try { await ctx.db.collection(`stories/${storyId}/replies`).doc(replyId).delete(); return true; } catch { return false; }
}
