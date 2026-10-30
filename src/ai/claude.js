// Thin wrapper around the artifact platform's `sample` capability (window.claude.use('sample')).
//
// Rules (CONTRACT §5 + the platform's sample.d.ts):
// - The capability may be absent (local run: no window.claude), null (non-viewer host; resolved ~10 s after load)
//   or never resolve. initAI() therefore waits for use('sample') at most ~10 s and accepts a late arrival.
// - Calls are never retried from code and never wrapped in timers; the platform ends over-long calls itself.
// - not_granted / sampling_disabled / not_declared / capability_* -> AI is switched off for the session and the
//   player is told once (bus 'ai:status'). rate_limited -> this call fails, AI stays on (background prefetches are
//   skipped until the next successful call). invalid_json / upstream_error / refused / empty_completion and every
//   other failure -> this call fails; the director falls back to the offline engine.
// - Prompts over 256 KiB (UTF-8) are refused locally with prompt_too_large; nothing is sent.
// - Every rejection is a plain object {code, message, text?, local?}.

import { bus } from '../ui/dom.js';
import { parseLooseJSON, splitNarrativeJSON } from './validate.js';

export const AI_TIERS = ['quick', 'default', 'complex'];
const MODES = ['off', ...AI_TIERS];

const PERMANENT = new Set(['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed']);
const KNOWN_CODES = new Set([
  'invalid_request', 'prompt_too_large', 'images_unavailable', 'tools_unavailable', 'image_rejected', 'cancelled',
  'not_granted', 'session_expired', 'sampling_disabled', 'not_declared', 'rate_limited', 'refused', 'empty_completion',
  'invalid_json', 'upstream_error', 'capability_disabled', 'capability_removed', 'transform_error', 'queue_overflow',
]);
const PAGE_BUGS = new Set(['invalid_request', 'prompt_too_large', 'transform_error', 'queue_overflow', 'images_unavailable', 'tools_unavailable']);

const MESSAGES = {
  absent: '当前是本地运行，未连接 Claude，人生故事由内置推演引擎生成。',
  null: '当前环境无法调用 Claude，人生故事由内置推演引擎生成。',
  timeout: '暂时连接不上 Claude，人生故事由内置推演引擎生成。',
  error: '连接 Claude 时出错，人生故事由内置推演引擎生成。',
  not_granted: '你没有允许本页面使用 Claude。本次游玩改用内置推演引擎，游戏可以照常进行。',
  sampling_disabled: '当前账号或组织未开放 Claude 调用。本次游玩改用内置推演引擎，游戏可以照常进行。',
  not_declared: '本页面当前无法调用 Claude。本次游玩改用内置推演引擎。',
  capability: '当前环境暂不支持调用 Claude。本次游玩改用内置推演引擎。',
  rate_limited: 'Claude 调用过于频繁或已达到用量上限，这一次改用内置推演；之后的抉择仍会尝试使用 AI。',
  session_expired: 'Claude 登录已过期，请重新登录后再使用 AI 叙事；这一次改用内置推演。',
  available: 'Claude 已连接，之后的抉择与结局将由 AI 书写。',
};

/** sample.d.ts: at most 256 KiB of prompt text; a bigger prompt is a page bug, refused here before anything is sent. */
export const MAX_PROMPT_BYTES = 256 * 1024;

let sampleFn = null;
let initPromise = null;
let tier = 'default';
let status = freshStatus();
let announcedDisable = false;
let rateLimited = false;
let announcedRateLimit = false;
let announcedSession = false;
let counter = freshCounter();

function freshStatus() {
  return { available: false, disabled: false, pending: false, reason: 'not_initialized', code: null, message: '' };
}
function freshCounter() {
  return { calls: 0, ok: 0, failed: 0, skipped: 0, byKind: {}, byCode: {} };
}

/** 'ai:status' carries the player-facing explanation; 'ai:changed' lets the shell refresh its status chip. */
function emit(payload) {
  const msg = { ...payload, available: isAvailable(), usable: isAvailable() && tier !== 'off', mode: tier };
  try {
    bus.emit('ai:status', msg);
    bus.emit('ai:changed', msg);
  } catch { /* the bus never throws, but stay safe */ }
}

function attach(fn) {
  sampleFn = fn;
  status.available = true;
  status.reason = null;
  status.code = null;
  status.message = '';
}

function setUnavailable(reason) {
  if (sampleFn && !status.disabled) return;
  status.available = false;
  status.reason = reason;
  status.message = MESSAGES[reason] || MESSAGES.null;
}

function isAvailable() {
  return !!sampleFn && !status.disabled;
}

/**
 * Acquire the sample capability. Resolves {available} within ~10 s at most; a capability that arrives later
 * still switches AI on (and announces it on the bus). Safe to call repeatedly.
 */
export function initAI({ waitMs = 10000 } = {}) {
  if (initPromise) return initPromise;
  const w = typeof window !== 'undefined' ? window : undefined;
  const claude = w && w.claude;
  if (!claude || typeof claude.use !== 'function') {
    setUnavailable('absent');
    initPromise = Promise.resolve({ available: false });
    return initPromise;
  }
  status.pending = true;
  initPromise = new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      status.pending = false;
      resolve({ available: isAvailable() });
    };
    let req;
    try {
      req = claude.use('sample');
    } catch {
      req = null;
    }
    const guard = setTimeout(() => {
      if (!sampleFn) setUnavailable('timeout');
      finish();
    }, Math.max(0, waitMs) + 500);
    if (guard && typeof guard.unref === 'function') guard.unref();
    Promise.resolve(req).then(
      (fn) => {
        const late = done;
        if (typeof fn === 'function' && !status.disabled) {
          attach(fn);
          if (late) emit({ code: 'available', message: MESSAGES.available, permanent: false });
        } else if (!sampleFn) {
          setUnavailable('null');
        }
        clearTimeout(guard);
        finish();
      },
      () => {
        if (!sampleFn) setUnavailable('error');
        clearTimeout(guard);
        finish();
      },
    );
  });
  return initPromise;
}

/** Current AI state for the UI. `usable` = a call would be attempted right now. */
export function aiStatus() {
  return {
    available: isAvailable(),
    usable: isAvailable() && tier !== 'off',
    mode: tier,
    pending: status.pending,
    disabled: status.disabled,
    reason: status.reason,
    code: status.code,
    message: status.message,
    rateLimited,
    calls: { ...counter, byKind: { ...counter.byKind }, byCode: { ...counter.byCode } },
  };
}

export function isUsable() {
  return isAvailable() && tier !== 'off';
}

/** settings.aiMode: 'off' | 'quick' | 'default' | 'complex'. Unknown values are ignored. Returns the active mode. */
export function setTier(mode) {
  if (MODES.includes(mode)) tier = mode;
  return tier;
}

export function getTier() {
  return tier;
}

/**
 * Test hook: install a fake sample function (with optional .json) or null for "no AI"; resets all module state.
 * Called with no argument it returns to the uninitialised state so initAI() runs again.
 */
export function setSampleForTests(fn) {
  sampleFn = null;
  status = freshStatus();
  counter = freshCounter();
  announcedDisable = false;
  announcedSession = false;
  announcedRateLimit = false;
  rateLimited = false;
  tier = 'default';
  if (fn === undefined) {
    initPromise = null;
    return;
  }
  if (typeof fn === 'function') attach(fn);
  else setUnavailable('absent');
  initPromise = Promise.resolve({ available: isAvailable() });
}

/* ------------------------------------------------------------------ errors */

function localError(code, message) {
  return { code, message, local: true };
}

function normalizeError(e) {
  let code = e && typeof e === 'object' && typeof e.code === 'string' ? e.code : 'upstream_error';
  if (!KNOWN_CODES.has(code) && !code.startsWith('capability_')) code = 'upstream_error';
  const out = { code, message: e && typeof e.message === 'string' ? e.message : String(e && e.code ? e.code : e) };
  if (e && typeof e.text === 'string') out.text = e.text;
  return out;
}

function handleFailure(err) {
  const { code } = err;
  counter.failed++;
  counter.byCode[code] = (counter.byCode[code] || 0) + 1;
  if (PERMANENT.has(code) || code.startsWith('capability_')) {
    status.disabled = true;
    status.available = false;
    status.code = code;
    status.reason = code;
    status.message = MESSAGES[code] || MESSAGES.capability;
    err.permanent = true;
    if (!announcedDisable) {
      announcedDisable = true;
      emit({ code, message: status.message, permanent: true });
    }
    return;
  }
  if (code === 'rate_limited') {
    rateLimited = true;
    if (!announcedRateLimit) {
      announcedRateLimit = true;
      emit({ code, message: MESSAGES.rate_limited, permanent: false });
    }
    return;
  }
  if (code === 'session_expired') {
    if (!announcedSession) {
      announcedSession = true;
      emit({ code, message: MESSAGES.session_expired, permanent: false });
    }
    return;
  }
  if (PAGE_BUGS.has(code)) {
    try { console.warn('[ai] request rejected:', code, err.message); } catch { /* no console */ }
  }
}

function onSuccess() {
  counter.ok++;
  rateLimited = false;
  announcedRateLimit = false;
}

/* ------------------------------------------------------------------ calls */

function utf8Bytes(s) {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length * 3;
  }
}

async function ready(prompt, opts) {
  if (status.pending && initPromise) await initPromise;
  if (typeof prompt !== 'string' || !prompt.trim()) throw localError('invalid_request', 'empty prompt');
  if (prompt.length * 3 > MAX_PROMPT_BYTES && utf8Bytes(prompt) > MAX_PROMPT_BYTES) {
    throw localError('prompt_too_large', `prompt of ${utf8Bytes(prompt)} bytes`);
  }
  const t = opts.tier || tier;
  if (tier === 'off' || t === 'off') throw localError('off', 'AI 已关闭');
  if (!AI_TIERS.includes(t)) throw localError('invalid_request', 'unknown tier ' + t);
  if (!isAvailable()) throw localError('unavailable', status.message || MESSAGES.null);
  if (opts.background && rateLimited) {
    counter.skipped++;
    throw localError('rate_limited', 'skipped background call after rate limit');
  }
  if (opts.signal && opts.signal.aborted) throw localError('cancelled', 'aborted before the call');
  return { fn: sampleFn, tier: t };
}

function buildOptions(opts, t) {
  const o = { modelTier: t };
  if (opts.signal) o.signal = opts.signal;
  if (opts.cache === false) o.cache = false;
  else if (opts.cache && typeof opts.cache === 'object') o.cache = { ...opts.cache };
  if (opts.background) o.fast = false;
  if (typeof opts.onText === 'function') {
    const cb = opts.onText;
    o.onText = (u) => {
      try { cb(u); } catch (e) { try { console.error('[ai] onText', e); } catch { /* ignore */ } }
    };
  }
  return o;
}

async function run(kind, prompt, opts, exec) {
  const { fn, tier: t } = await ready(prompt, opts);
  counter.calls++;
  counter.byKind[kind] = (counter.byKind[kind] || 0) + 1;
  try {
    const v = await exec(fn, buildOptions(opts, t));
    onSuccess();
    return v;
  } catch (e) {
    const err = normalizeError(e);
    handleFailure(err);
    throw err;
  }
}

/**
 * Ask for JSON. opts: {tier, signal, cache, kind, background}. Resolves with the parsed value; rejects with
 * {code, message, text?}.
 */
export function aiJSON(prompt, opts = {}) {
  return run(opts.kind || 'json', prompt, opts, async (fn, o) => {
    if (typeof fn.json === 'function') return fn.json(prompt, o);
    const r = await fn(prompt, o);
    const text = typeof r === 'string' ? r : r && r.text;
    const v = parseLooseJSON(text);
    if (v == null) throw { code: 'invalid_json', message: 'reply held no JSON object', text: typeof text === 'string' ? text : '' };
    return v;
  });
}

/**
 * Stream text. opts: {tier, signal, onText({text, delta}), cache, kind, background}.
 * Resolves {text, truncated, modelTierApplied}; rejects with {code, message, text?}.
 */
export function aiStream(prompt, opts = {}) {
  return run(opts.kind || 'stream', prompt, opts, async (fn, o) => {
    const r = await fn(prompt, o);
    const text = typeof r === 'string' ? r : r && typeof r.text === 'string' ? r.text : '';
    if (!text.trim()) throw { code: 'empty_completion', message: 'empty answer' };
    return { text, truncated: !!(r && r.truncated), modelTierApplied: (r && r.modelTierApplied) || o.modelTier };
  });
}

/**
 * CONTRACT §2 signature: aiCall(kind, prompt, {tier, signal, onText, json, cache, background}) -> {text, json}.
 * With json:true it uses sample.json; otherwise it streams and extracts a trailing JSON object when present.
 */
export async function aiCall(kind, prompt, opts = {}) {
  if (opts.json) {
    const v = await aiJSON(prompt, { ...opts, kind });
    return { text: JSON.stringify(v), json: v };
  }
  const r = await aiStream(prompt, { ...opts, kind });
  const split = splitNarrativeJSON(r.text);
  return { text: r.text, json: split.json || null, narrative: split.narrative, truncated: r.truncated };
}
