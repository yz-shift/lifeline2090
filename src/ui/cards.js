// Shareable registry cards (1080x1350 PNG) drawn on canvas: the birth registration and the death registration with a
// mini life map. Colours come from a fixed light "paper and ink" palette (CARD_PALETTE), never from CSS variables, so
// a card looks the same whichever theme the viewer uses. Fonts follow the page's --font-* tokens with CJK fallbacks
// and are loaded for exactly the glyphs drawn before painting.
//
//   birthCard(state, data)                          -> Promise<Blob>
//   deathCard(state, data, {epitaph, bio, title})   -> Promise<Blob>
//   achievementCard(def, got, {have, total, index, category, url, data}) -> Promise<Blob>
//   lifePoster(state, data, {title, cards, url})    -> Promise<Blob>   (1080x1920 人生长卷 with a QR code)
//   saveBlob(blob, filename)                        -> Promise<{ok, status, code?, message}>   (never throws)
//   cardFileName(state, kind)                       -> safe file name for a card

import { hashString, Rng } from '../core/rng.js';
import { qrMatrix } from './qr.js';
import {
  YEAR_TAGS, YEAR_TAG_LABELS, STATS, STAT_LABELS, EDU_LABELS, CAREER_LABELS, RELATIONSHIP_LABELS, REGIONS, HISTORY_END,
} from '../core/constants.js';

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;
export const CARD_FOOTER = '人生长河 · 2000–2090 · 真实数据 + 推演';

export const CARD_PALETTE = Object.freeze({
  paper: '#F3EDE1',
  paper2: '#E8DFCC',
  ink: '#211C17',
  ink2: '#4B4237',
  ink3: '#86796A',
  line: '#CBBDA3',
  seal: '#B2302A',
  proj: '#3A6C8C',
  stats: Object.freeze({ health: '#5B8A5E', happiness: '#C98F2E', knowledge: '#4A78A8', relationships: '#B85F75', wealth: '#86683B' }),
  tags: Object.freeze({
    birth: '#C7A468', childhood: '#E6C46F', study: '#5A89B3', work: '#55707D', love: '#D27D8A', family: '#DE9B57',
    loss: '#837690', illness: '#9C6F99', crisis: '#C4673D', war: '#8A3A35', migration: '#3D8E88', success: '#CFA628',
    calm: '#A7B796', retire: '#8CA4B6', death: '#38332D',
  }),
});

const FONT_FALLBACK = {
  display: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "STSong", "SimSun", serif',
  body: '"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  mono: '"IBM Plex Mono", "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace',
};

const PARENT_EDU = { none: '未受正规教育', primary: '小学', secondary: '中学', tertiary: '大学及以上' };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (v == null || v === '' ? null : isNum(Number(v)) ? Number(v) : null);

// ---------------------------------------------------------------------------------------------------------------
// small formatting helpers (cards cannot depend on the page's theme or on screens)

function cnNum(n) {
  if (!isNum(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e8) return `${(n / 1e8).toFixed(a >= 1e9 ? 0 : 1)}亿`;
  if (a >= 1e4) return `${(n / 1e4).toFixed(a >= 1e5 ? 0 : 1)}万`;
  return Math.round(n).toLocaleString('zh-CN');
}

function dateParts(date, fallbackYear) {
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(String(date || ''));
  if (!m) return { y: fallbackYear ?? null, m: null, d: null };
  return { y: Number(m[1]), m: m[2] ? Number(m[2]) : null, d: m[3] ? Number(m[3]) : null };
}
function dateDots(date, fallbackYear) {
  const p = dateParts(date, fallbackYear);
  if (p.y == null) return '—';
  return [p.y, p.m && String(p.m).padStart(2, '0'), p.d && String(p.d).padStart(2, '0')].filter(Boolean).join('.');
}
function dateZh(date, fallbackYear) {
  const p = dateParts(date, fallbackYear);
  if (p.y == null) return '—';
  return `${p.y}年${p.m ? `${p.m}月` : ''}${p.d ? `${p.d}日` : ''}`;
}

function safeCall(fn, fallback = null) {
  try { const v = fn(); return v === undefined ? fallback : v; } catch { return fallback; }
}

function countryOf(data, iso) {
  return safeCall(() => data?.country?.(iso), null) || data?.countries?.[iso] || null;
}
function countryName(data, iso) {
  return countryOf(data, iso)?.name || iso || '未知';
}
function series(data, iso, key, year) {
  return num(safeCall(() => data?.series?.(iso, key, year), null));
}

/** Money is stored in 2021 international dollars; show local currency at 2021 prices when we can. */
function moneyText(data, iso, amount) {
  if (!isNum(amount)) return '—';
  const factor = series(data, iso, 'ppp_factor', 2021);
  const cur = safeCall(() => data?.currency?.(iso), null);
  const sym = cur?.symbol || '';
  const sign = amount < 0 ? '-' : '';
  if (isNum(factor) && factor > 0 && (sym || cur?.name)) {
    const v = Math.abs(amount * factor);
    return sym ? `${sign}${sym}${cnNum(v)}` : `${sign}${cnNum(v)} ${cur.name}`;
  }
  return `${sign}${cnNum(Math.abs(amount))} 国际元`;
}

function netWorth(person) {
  const m = person?.money || {};
  let total = (num(m.cash) || 0) - (num(m.debt) || 0);
  for (const v of Object.values(m.portfolio || {})) {
    const x = num(typeof v === 'object' && v ? v.value : v);
    if (isNum(x)) total += x;
  }
  return total;
}

function familyWord(p) {
  if (!isNum(p)) return '—';
  const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
  const word = p < 0.2 ? '清贫' : p < 0.4 ? '偏紧' : p < 0.6 ? '中等' : p < 0.8 ? '宽裕' : '富足';
  return `${word} · 本国第 ${Math.max(1, pct)} 百分位`;
}

export function archiveNumber(state) {
  const b = state?.birth || {};
  const key = String(state?.id ?? state?.seed ?? `${b.name}|${b.date}|${b.time}|${b.country}`);
  const hx = hashString(key).toString(16).toUpperCase().padStart(8, '0').slice(0, 6);
  return `LL-${b.year ?? dateParts(b.date).y ?? '0000'}-${b.country || 'XXX'}-${hx}`;
}

/** File name for a card: 人生长河-出生登记-<name>-<year>.png, with characters file systems reject removed. */
export function cardFileName(state, kind = 'birth') {
  const b = state?.birth || {};
  const name = String(b.name || state?.person?.name || '无名').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').slice(0, 24) || '无名';
  const label = kind === 'death' ? '一生档案' : '出生登记';
  const year = kind === 'death' ? (state?.dead?.year ?? state?.year ?? '') : (b.year ?? '');
  return `人生长河-${label}-${name}${year !== '' ? `-${year}` : ''}.png`;
}

// ---------------------------------------------------------------------------------------------------------------
// canvas plumbing

function cardFonts() {
  const out = { ...FONT_FALLBACK };
  try {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['display', 'body', 'mono']) {
      const v = cs.getPropertyValue(`--font-${k}`).trim();
      if (v && !v.includes('var(') && !/[;{}]/.test(v)) out[k] = `${v}, ${FONT_FALLBACK[k]}`;
    }
  } catch { /* fallbacks */ }
  return out;
}

async function ensureFonts(fonts, text) {
  const fs = typeof document !== 'undefined' ? document.fonts : null;
  if (!fs || typeof fs.load !== 'function') return;
  const chars = [...new Set(String(text))].join('') || '人生长河';
  const specs = [
    `700 80px ${fonts.display}`, `400 40px ${fonts.display}`,
    `400 26px ${fonts.body}`, `600 26px ${fonts.body}`,
    `400 24px ${fonts.mono}`, `600 24px ${fonts.mono}`,
  ];
  const work = (async () => {
    try { await fs.ready; } catch { /* ignore */ }
    await Promise.all(specs.map((f) => fs.load(f, chars).catch(() => null)));
  })();
  // never let a slow font network block the card: draw with fallbacks after a few seconds
  await Promise.race([work, new Promise((r) => setTimeout(r, 4000))]);
}

function makeCanvas(H = CARD_HEIGHT) {
  const c = document.createElement('canvas');
  c.width = CARD_WIDTH;
  c.height = H;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  return { canvas: c, ctx };
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png');
      return;
    }
    try {
      const url = canvas.toDataURL('image/png');
      const bin = atob(url.split(',')[1]);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      resolve(new Blob([arr], { type: 'image/png' }));
    } catch (e) { reject(e); }
  });
}

const NO_LINE_START = '，。、；：！？）》」』】〉”’,.;:!?)]}…—%·';
const NO_LINE_END = '（《「『【〈“‘([{';

function tokenize(str) {
  const out = [];
  const re = /[A-Za-z0-9À-ɏ'’\-./%#@&+_]+|\s+|[\s\S]/gu;
  let m;
  while ((m = re.exec(str))) out.push(m[0]);
  return out;
}

/** Painter: text helpers bound to one context, palette and font set. */
function painter(ctx, fonts) {
  const P = {
    ctx, fonts, pal: CARD_PALETTE,
    font(kind, size, weight = 400) { ctx.font = `${weight} ${size}px ${fonts[kind] || fonts.body}`; },
    spacing(px) { if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`; },
    measure(str) { return ctx.measureText(String(str)).width; },
    /** Ellipsise to maxW. */
    clip(str, maxW) {
      str = String(str ?? '');
      if (!maxW || P.measure(str) <= maxW) return str;
      const chars = [...str];
      while (chars.length && P.measure(chars.join('') + '…') > maxW) chars.pop();
      return chars.join('') + '…';
    },
    text(str, x, y, { kind = 'body', size = 26, weight = 400, color = CARD_PALETTE.ink, align = 'left', maxW = 0, spacing = 0 } = {}) {
      P.font(kind, size, weight);
      P.spacing(spacing);
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = 'alphabetic';
      const s = P.clip(str, maxW);
      ctx.fillText(s, x, y);
      const w = P.measure(s);
      P.spacing(0);
      return w;
    },
    /** Largest size <= size (>= min) at which str fits maxW. */
    fit(str, kind, weight, size, min, maxW) {
      let s = size;
      for (; s > min; s -= 2) { P.font(kind, s, weight); if (P.measure(str) <= maxW) return s; }
      return min;
    },
    /** CJK-aware wrap with simple kinsoku; ellipsises the last allowed line. */
    wrap(str, maxW, maxLines, kind = 'body', size = 24, weight = 400) {
      P.font(kind, size, weight);
      const lines = [];
      for (const para of String(str ?? '').split(/\n+/)) {
        const toks = tokenize(para.trim());
        let line = '';
        for (const tok of toks) {
          if (!line && /^\s+$/.test(tok)) continue;
          const test = line + tok;
          if (P.measure(test) <= maxW) { line = test; continue; }
          // hanging punctuation: one closing mark may overhang the measure
          if (tok.length === 1 && NO_LINE_START.includes(tok) && P.measure(test) <= maxW + size) { line = test; continue; }
          if (line && NO_LINE_START.includes(tok[0])) {
            // push-out: carry the last character(s) down so the new line does not start with a closing mark
            let ln = line, carry = '';
            do { const ch = [...ln].pop(); carry = ch + carry; ln = ln.slice(0, ln.length - ch.length); } while (ln && NO_LINE_START.includes(carry[0]) && carry.length < 4);
            if (ln.trim()) { lines.push(ln.trimEnd()); line = carry + tok; continue; }
          }
          if (!line) {
            // a single over-long token: hard break by character
            let part = '';
            for (const ch of tok) {
              if (P.measure(part + ch) > maxW && part) { lines.push(part); part = ''; }
              part += ch;
            }
            line = part;
            continue;
          }
          let carry = '';
          while (line && NO_LINE_END.includes(line[line.length - 1])) { carry = line[line.length - 1] + carry; line = line.slice(0, -1); }
          lines.push(line.trimEnd());
          line = (carry + tok).replace(/^\s+/, '');
        }
        if (line) lines.push(line.trimEnd());
      }
      if (lines.length > maxLines) {
        const kept = lines.slice(0, maxLines);
        let last = kept[maxLines - 1];
        while (last && P.measure(last + '…') > maxW) last = [...last].slice(0, -1).join('');
        kept[maxLines - 1] = last.replace(/[，。、；：,.;:\s]+$/, '') + '…';
        return kept;
      }
      return lines;
    },
    rule(x1, y, x2, { color = CARD_PALETTE.ink, width = 1, dash = null } = {}) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
      ctx.restore();
    },
  };
  return P;
}

function drawPaper(P, rng, H = CARD_HEIGHT) {
  const { ctx, pal } = P;
  ctx.fillStyle = pal.paper;
  ctx.fillRect(0, 0, CARD_WIDTH, H);
  // soft edge darkening like an archive sheet
  const g = ctx.createRadialGradient(CARD_WIDTH / 2, H / 2, H * 0.35, CARD_WIDTH / 2, H / 2, H * 0.78);
  g.addColorStop(0, 'rgba(120, 96, 60, 0)');
  g.addColorStop(1, 'rgba(120, 96, 60, 0.10)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CARD_WIDTH, H);
  // paper grain
  ctx.save();
  for (let i = 0; i < Math.round((2600 * H) / CARD_HEIGHT); i++) {
    ctx.globalAlpha = 0.025 + rng.next() * 0.035;
    ctx.fillStyle = rng.next() < 0.7 ? pal.ink2 : pal.paper2;
    const r = 0.6 + rng.next() * 1.2;
    ctx.fillRect(rng.next() * CARD_WIDTH, rng.next() * H, r, r);
  }
  ctx.restore();
  // frame: heavy outer rule, hairline inner rule, corner ticks
  ctx.save();
  ctx.strokeStyle = pal.ink2;
  ctx.lineWidth = 3;
  ctx.strokeRect(38, 38, CARD_WIDTH - 76, H - 76);
  ctx.strokeStyle = pal.ink3;
  ctx.lineWidth = 1;
  ctx.strokeRect(48, 48, CARD_WIDTH - 96, H - 96);
  ctx.strokeStyle = pal.ink2;
  ctx.lineWidth = 2;
  const t = 18;
  for (const [x, y, dx, dy] of [[56, 56, 1, 1], [CARD_WIDTH - 56, 56, -1, 1], [56, H - 56, 1, -1], [CARD_WIDTH - 56, H - 56, -1, -1]]) {
    ctx.beginPath();
    ctx.moveTo(x, y + dy * t);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dx * t, y);
    ctx.stroke();
  }
  ctx.restore();
}

function starPath(ctx, cx, cy, R, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? R : r;
    const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Round registry seal drawn off-screen, worn with deterministic specks, stamped with multiply. */
function drawSeal(P, cx, cy, r, { ring = '人生长河档案登记处', center = '', bottom = '', rotation = -0.22, seed = 1 } = {}) {
  const { ctx, pal, fonts } = P;
  const size = Math.ceil(r * 2 + 16);
  const off = document.createElement('canvas');
  off.width = size; off.height = size;
  const o = off.getContext('2d');
  if (!o) return;
  const c = size / 2;
  o.strokeStyle = pal.seal;
  o.fillStyle = pal.seal;
  o.lineWidth = r * 0.075;
  o.beginPath(); o.arc(c, c, r - o.lineWidth / 2, 0, Math.PI * 2); o.stroke();
  o.lineWidth = r * 0.02;
  o.beginPath(); o.arc(c, c, r * 0.8, 0, Math.PI * 2); o.stroke();
  // ring text along the upper arc
  const chars = [...ring];
  const fs = r * 0.19;
  o.font = `700 ${fs}px ${fonts.display}`;
  o.textAlign = 'center';
  o.textBaseline = 'middle';
  const span = Math.min(Math.PI * 1.35, chars.length * 0.36);
  const step = chars.length > 1 ? span / (chars.length - 1) : 0;
  chars.forEach((ch, i) => {
    const a = -span / 2 + i * step;
    o.save();
    o.translate(c, c);
    o.rotate(a);
    o.fillText(ch, 0, -r * 0.62);
    o.restore();
  });
  starPath(o, c, center ? c - r * 0.08 : c + r * 0.02, r * 0.2, r * 0.085);
  o.fill();
  if (center) {
    o.font = `700 ${r * 0.2}px ${fonts.display}`;
    o.fillText(center, c, c + r * 0.27);
  }
  if (bottom) {
    o.font = `600 ${r * 0.13}px ${fonts.mono}`;
    o.fillText(bottom, c, c + r * 0.52);
  }
  // wear: punch tiny gaps so it reads as an inked stamp, not a vector badge
  const rng = new Rng(seed);
  o.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 260; i++) {
    const a = rng.next() * Math.PI * 2, d = Math.sqrt(rng.next()) * r;
    o.globalAlpha = 0.25 + rng.next() * 0.6;
    const s = 0.8 + rng.next() * 2.4;
    o.fillRect(c + Math.cos(a) * d, c + Math.sin(a) * d, s, s);
  }
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  ctx.globalAlpha = 0.86;
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(off, -size / 2, -size / 2);
  ctx.restore();
}

function drawHeader(P, { title, no, right }) {
  const { pal } = P;
  P.text('人生长河档案馆 · LIFELINE 2090 ARCHIVE', 84, 112, { size: 20, color: pal.ink3, spacing: 3 });
  P.text('档案号', CARD_WIDTH - 84, 112, { size: 20, color: pal.ink3, align: 'right' });
  P.text(title, 84, 196, { kind: 'display', size: 64, weight: 700, color: pal.ink, spacing: 6 });
  P.text(no, CARD_WIDTH - 84, 150, { kind: 'mono', size: 26, weight: 600, color: pal.ink, align: 'right' });
  if (right) P.text(right, CARD_WIDTH - 84, 194, { size: 22, color: pal.ink2, align: 'right' });
  P.rule(84, 226, CARD_WIDTH - 84, { color: pal.ink, width: 2.5 });
  P.rule(84, 233, CARD_WIDTH - 84, { color: pal.ink3, width: 1 });
}

function drawFooter(P) {
  const { pal } = P;
  P.rule(84, 1248, CARD_WIDTH - 84, { color: pal.ink3, width: 1 });
  P.text(CARD_FOOTER, CARD_WIDTH / 2, 1284, { size: 22, color: pal.ink2, align: 'center', spacing: 2 });
}

/** Labelled field: small grey label, value below. */
function field(P, label, value, x, y, w, { size = 30, kind = 'body', weight = 500, labelSize = 20, gap = 12, min = 22 } = {}) {
  P.text(label, x, y, { size: labelSize, color: P.pal.ink3, spacing: 2, maxW: w });
  const v = value || '—';
  const fitted = P.fit(v, kind, weight, size, min, w);
  P.text(v, x, y + size + gap, { kind, size: fitted, weight, color: P.pal.ink, maxW: w });
}

function hatch(ctx, x, y, w, h, color, gap = 6) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let d = -h; d < w; d += gap) {
    ctx.moveTo(x + d, y + h);
    ctx.lineTo(x + d + h, y);
  }
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Mini life map: rows of ten ages; lived cells in their tag colour, projected years hatched. Returns used height. */
function drawLifeGrid(P, history, { x, y, w, maxH, birthYear, projectionFrom = HISTORY_END + 1 }) {
  const { ctx, pal } = P;
  const rows = (Array.isArray(history) ? history : []).filter((r) => r && isNum(Number(r.year)));
  const ages = rows.map((r) => (isNum(Number(r.age)) && r.age != null ? Number(r.age) : Number(r.year) - birthYear));
  const maxAge = ages.length ? Math.max(...ages) : 0;
  const nRows = Math.floor(maxAge / 10) + 1;
  const labelW = 40, gap = 4;
  const cellByW = Math.floor((w - labelW - gap * 9) / 10);
  const cellByH = Math.floor(maxH / nRows) - gap;
  const cell = Math.max(10, Math.min(cellByW, cellByH, 38));
  const gx = x + labelW;
  for (let r = 0; r < nRows; r++) {
    const ry = y + r * (cell + gap);
    P.text(String(r * 10), gx - 10, ry + cell / 2 + 7, { kind: 'mono', size: 18, color: pal.ink3, align: 'right' });
    for (let c = 0; c < 10 && r * 10 + c <= maxAge; c++) {
      const cx = gx + c * (cell + gap);
      ctx.save();
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(cx + 0.5, ry + 0.5, cell - 1, cell - 1);
      ctx.restore();
    }
  }
  rows.forEach((row, i) => {
    const age = ages[i];
    if (!(age >= 0)) return;
    const r = Math.floor(age / 10), c = age % 10;
    const cx = gx + c * (cell + gap), cy = y + r * (cell + gap);
    ctx.fillStyle = pal.paper;
    ctx.fillRect(cx, cy, cell, cell);
    const tag = YEAR_TAGS.includes(row.tag) ? row.tag : 'calm';
    ctx.fillStyle = pal.tags[tag];
    roundRect(ctx, cx, cy, cell, cell, Math.min(4, cell / 6));
    ctx.fill();
    if (Number(row.year) >= projectionFrom) hatch(ctx, cx, cy, cell, cell, 'rgba(243, 237, 225, 0.55)', 6);
  });
  return nRows * (cell + gap) - gap;
}

function drawLegend(P, items, x, y, w) {
  const { ctx, pal } = P;
  let cx = x, cy = y;
  const sw = 16;
  P.font('body', 18, 400);
  for (const it of items) {
    const tw = P.measure(it.label);
    const iw = sw + 8 + tw + 18;
    if (cx > x && cx + iw > x + w) { cx = x; cy += 28; }
    if (it.hatch) {
      ctx.fillStyle = pal.ink3;
      ctx.fillRect(cx, cy - 14, sw, sw);
      hatch(ctx, cx, cy - 14, sw, sw, 'rgba(243, 237, 225, 0.7)', 5);
    } else {
      ctx.fillStyle = it.color;
      roundRect(ctx, cx, cy - 14, sw, sw, 3);
      ctx.fill();
    }
    P.text(it.label, cx + sw + 8, cy, { size: 18, color: pal.ink2 });
    cx += iw;
  }
  return cy - y + 10;
}

function collectText(...parts) {
  return parts.flat(Infinity).filter((x) => x != null).map(String).join('');
}

const DIGITS = '0123456789.,-—–·%+:/ ()（）年月日岁万亿国际元第百分位¥$€£₹₩';

// ---------------------------------------------------------------------------------------------------------------
// birth card

/**
 * Birth registration card.
 * @param {object} state LifeState (birth, person, worldLabel, id/seed)
 * @param {object} data  DataStore
 * @returns {Promise<Blob>} 1080x1350 PNG
 */
export async function birthCard(state, data) {
  const b = state?.birth || {};
  const person = state?.person || {};
  const iso = b.country || person.country;
  const C = countryOf(data, iso);
  const year = num(b.year) ?? dateParts(b.date).y ?? HISTORY_END;
  const proj = year > HISTORY_END;
  const name = String(b.name || person.name || '无名');
  const latin = b.nameLatin ? String(b.nameLatin) : '';
  const sex = b.sex === 'female' ? '女' : b.sex === 'male' ? '男' : '—';
  const cName = countryName(data, iso);
  const region = C?.region ? REGIONS[C.region] || '' : '';
  const births = series(data, iso, 'births', year); // thousands
  const worldTotal = num(safeCall(() => data?.birthsWeights?.(year)?.total, null)); // thousands
  const le = series(data, iso, b.sex === 'female' ? 'le_f' : 'le_m', year) ?? series(data, iso, 'le', year);
  const gdp = series(data, iso, 'gdp_pc_ppp', year);
  const net = series(data, iso, 'internet', year);
  const no = archiveNumber(state);

  const facts = [
    ['出生地', `${cName}${region ? ` · ${region}` : ''}`],
    ['城乡', b.urban == null ? '—' : b.urban ? '城镇' : '乡村'],
    ['家庭经济', familyWord(num(b.familyPct))],
    ['父母受教育程度', PARENT_EDU[b.parentsEdu] || '—'],
    ['兄弟姐妹', isNum(num(b.siblings)) ? (num(b.siblings) === 0 ? '独生' : `${num(b.siblings)} 个`) : '—'],
    ['父母年龄', [isNum(num(b.motherAge)) ? `母亲 ${num(b.motherAge)} 岁` : '', isNum(num(b.fatherAge)) ? `父亲 ${num(b.fatherAge)} 岁` : ''].filter(Boolean).join(' · ') || '—'],
    ['登记方式', b.mode === 'custom' ? '自定义出生' : '随机降生'],
    ['世界线', state?.worldLabel ? String(state.worldLabel) : '—'],
  ];
  const metrics = [
    { v: isNum(births) ? cnNum(births * 1000) : '—', l: '当年本国新生儿' },
    { v: isNum(le) ? `${le.toFixed(1)} 岁` : '—', l: `出生时预期寿命${sex === '—' ? '' : `·${sex}`}` },
    { v: isNum(gdp) ? `${cnNum(gdp)}` : '—', l: '人均 GDP（国际元）' },
    { v: isNum(net) ? `${Math.round(net)}%` : '—', l: '互联网使用率' },
  ];
  let rarity = '';
  if (isNum(worldTotal) && isNum(births) && births > 0) {
    const every = Math.max(1, Math.round(worldTotal / births));
    rarity = every <= 1
      ? `这一年全球约有 ${cnNum(worldTotal * 1000)}名新生儿。`
      : `这一年全球约有 ${cnNum(worldTotal * 1000)}名新生儿，每 ${every} 人中就有 1 人生在${cName}。`;
  }
  const notes = [...(Array.isArray(b.notes) ? b.notes : []).map(String)];
  if (b.customText) notes.unshift(`自述出身：${String(b.customText)}`);
  const noteText = notes.join('；');
  const dateLine = `${dateZh(b.date, year)}${b.time ? ` ${String(b.time).slice(0, 5)}` : ''}`;

  const { canvas, ctx } = makeCanvas();
  const fonts = cardFonts();
  await ensureFonts(fonts, collectText(name, latin, cName, region, facts, metrics.map((m) => [m.v, m.l]), rarity, noteText, dateLine, no,
    '人生长河档案馆 LIFELINE 2090 ARCHIVE 档案号 出生登记 姓名 性别 出生日期 出生时的世界 真实数据 推演 登记日期 人生长河档案登记处', CARD_FOOTER, DIGITS));
  const P = painter(ctx, fonts);
  const pal = P.pal;
  const seed = hashString(no);
  drawPaper(P, new Rng(seed));
  drawHeader(P, { title: '出生登记', no, right: `登记日期 ${dateDots(b.date, year)}` });

  // name block
  P.text('姓名', 84, 284, { size: 20, color: pal.ink3, spacing: 3 });
  const nameSize = P.fit(name, 'display', 700, 108, 56, 640);
  P.text(name, 84, 284 + nameSize + 14, { kind: 'display', size: nameSize, weight: 700, color: pal.ink, maxW: 660 });
  let yy = 284 + nameSize + 14;
  if (latin) { yy += 46; P.text(latin, 88, yy, { kind: 'mono', size: 28, color: pal.ink3, maxW: 640 }); }
  yy += 56;
  P.text(`${sex === '—' ? '' : `${sex} · `}${dateLine} · ${cName}`, 84, yy, { size: 30, color: pal.ink2, maxW: 660 });
  drawSeal(P, 870, 380, 112, { ring: '人生长河档案登记处', center: '出生', bottom: String(year), rotation: -0.2, seed });

  // facts: two columns x four rows
  const top = Math.max(yy + 40, 540);
  P.rule(84, top - 20, CARD_WIDTH - 84, { color: pal.line, width: 1 });
  const colW = (CARD_WIDTH - 168 - 40) / 2;
  facts.forEach(([label, value], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    field(P, label, value, 84 + col * (colW + 40), top + 16 + row * 92, colW, { size: 30 });
  });

  // the world at birth
  const boxY = top + 16 + 4 * 92 + 8;
  const boxH = rarity ? 212 : 172;
  ctx.fillStyle = pal.paper2;
  roundRect(ctx, 84, boxY, CARD_WIDTH - 168, boxH, 6);
  ctx.fill();
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 1;
  ctx.stroke();
  P.text(`出生时的世界 · ${year}`, 112, boxY + 42, { size: 22, weight: 600, color: pal.ink2, spacing: 2 });
  const badge = proj ? '推演' : '真实数据';
  P.font('body', 18, 600);
  const bw = P.measure(badge) + 24;
  ctx.fillStyle = proj ? pal.proj : pal.ink2;
  roundRect(ctx, CARD_WIDTH - 112 - bw, boxY + 20, bw, 30, 15);
  ctx.fill();
  P.text(badge, CARD_WIDTH - 112 - bw / 2, boxY + 41, { size: 18, weight: 600, color: pal.paper, align: 'center' });
  const mw = (CARD_WIDTH - 224) / 4;
  metrics.forEach((m, i) => {
    const mx = 112 + i * mw;
    P.text(m.v, mx, boxY + 104, { kind: 'mono', size: 38, weight: 600, color: pal.ink, maxW: mw - 16 });
    P.text(m.l, mx, boxY + 136, { size: 18, color: pal.ink3, maxW: mw - 16 });
  });
  if (rarity) P.text(rarity, 112, boxY + 186, { size: 22, color: pal.ink2, maxW: CARD_WIDTH - 224 });

  // notes (family circumstances, custom birth text)
  if (noteText) {
    const lines = P.wrap(noteText, CARD_WIDTH - 168, 2, 'body', 22);
    lines.forEach((ln, i) => P.text(ln, 84, boxY + boxH + 44 + i * 34, { size: 22, color: pal.ink2 }));
  }
  drawFooter(P);
  return canvasToBlob(canvas);
}

// ---------------------------------------------------------------------------------------------------------------
// death card

/**
 * Death registration card with a mini life map, final stats, epitaph and a short biography.
 * @param {object} state LifeState (dead must be set; falls back to the current state)
 * @param {object} data  DataStore
 * @param {{epitaph?: string, bio?: string, title?: string}} extra AI or offline narrative (untrusted text, drawn only)
 * @returns {Promise<Blob>}
 */
export async function deathCard(state, data, extra = {}) {
  const b = state?.birth || {};
  const p = state?.person || {};
  const dead = state?.dead || {};
  const birthYear = num(b.year) ?? dateParts(b.date).y ?? 2000;
  const deathYear = num(dead.year) ?? num(state?.year) ?? birthYear;
  const age = num(dead.age) ?? num(state?.age) ?? Math.max(0, deathYear - birthYear);
  const name = String(b.name || p.name || '无名');
  const latin = b.nameLatin ? String(b.nameLatin) : '';
  const birthIso = b.country || p.country;
  const placeIso = dead.place || p.country || birthIso;
  const no = archiveNumber(state);
  const title = extra?.title ? String(extra.title).trim() : '';
  const epitaph = extra?.epitaph ? String(extra.epitaph).trim() : '';
  const bio = String(extra?.bio || dead.summary || '').trim();

  const cause = dead.cause?.name ? `${dead.cause.name}${dead.cause.detail ? `（${dead.cause.detail}）` : ''}` : '—';
  const place = `${countryName(data, placeIso)}${placeIso && birthIso && placeIso !== birthIso ? `（生于${countryName(data, birthIso)}）` : ''}`;
  const edu = p.education?.level ? `${EDU_LABELS[p.education.level] || p.education.level}${p.education.field ? ` · ${p.education.field}` : ''}` : '—';
  const career = p.career?.title ? String(p.career.title) : (CAREER_LABELS[p.career?.status] || '—');
  const kids = Array.isArray(p.children) ? p.children.length : 0;
  const rel = RELATIONSHIP_LABELS[p.relationship?.status] || '';
  const family = [rel, kids ? `${kids} 个孩子` : '没有孩子'].filter(Boolean).join(' · ');
  const wealth = `${moneyText(data, placeIso, netWorth(p))}`;
  let pct = num(dead.percentile);
  if (isNum(pct) && pct <= 1) pct *= 100;
  const leBirth = num(dead.lifeExpAtBirth) ?? series(data, birthIso, b.sex === 'female' ? 'le_f' : 'le_m', birthYear);
  const lifeLine = [
    isNum(pct) ? `寿命长于同年出生者的 ${Math.round(Math.max(0, Math.min(100, pct)))}%` : '',
    isNum(leBirth) ? `出生时预期 ${leBirth.toFixed(1)} 岁` : '',
  ].filter(Boolean).join('，');
  const facts = [
    ['死因', cause], ['离世地', place], ['受教育程度', edu], ['职业', career],
    ['家庭', family], ['身后财富（按2021年物价）', wealth],
  ];
  const stats = dead.stats || state?.stats || {};
  const history = Array.isArray(state?.history) ? state.history : [];
  const tagsPresent = YEAR_TAGS.filter((t) => history.some((r) => r && r.tag === t));
  const anyProj = history.some((r) => r && Number(r.year) > HISTORY_END);
  const legendItems = tagsPresent.map((t) => ({ label: YEAR_TAG_LABELS[t], color: CARD_PALETTE.tags[t] }));
  if (anyProj) legendItems.push({ label: '斜纹 = 推演年份', hatch: true });
  const span = `${dateDots(b.date, birthYear)} — ${dateDots(dead.date, deathYear)}`;

  const { canvas, ctx } = makeCanvas();
  const fonts = cardFonts();
  await ensureFonts(fonts, collectText(name, latin, title, epitaph, bio, facts, legendItems.map((l) => l.label), span, no,
    STATS.map((k) => STAT_LABELS[k]), '人生长河档案馆 LIFELINE 2090 ARCHIVE 档案号 死亡登记 享年 一生 每格一年 归档 「」“”人生长河档案登记处 终',
    CARD_FOOTER, DIGITS));
  const P = painter(ctx, fonts);
  const pal = P.pal;
  const seed = hashString(no + ':death');
  drawPaper(P, new Rng(seed));
  drawHeader(P, { title: '死亡登记', no, right: `归档 ${deathYear} 年` });

  // name, span, life title
  const nameSize = P.fit(name, 'display', 700, 92, 52, 640);
  let y = 262 + nameSize;
  P.text(name, 84, y, { kind: 'display', size: nameSize, weight: 700, color: pal.ink, maxW: 660 });
  if (latin) { y += 42; P.text(latin, 88, y, { kind: 'mono', size: 26, color: pal.ink3, maxW: 640 }); }
  y += 50;
  const sw = P.text(span, 84, y, { kind: 'mono', size: 30, weight: 600, color: pal.ink, maxW: 520 });
  P.text(`享年 ${age} 岁`, 84 + sw + 22, y, { size: 30, weight: 600, color: pal.ink2, maxW: 660 - sw - 22 });
  if (lifeLine) { y += 40; P.text(lifeLine, 84, y, { size: 22, color: pal.ink3, maxW: 660 }); }
  if (title) { y += 52; P.text(`「${title}」`, 70, y, { kind: 'display', size: 34, weight: 700, color: pal.ink2, maxW: 680 }); }
  drawSeal(P, 880, 368, 108, { ring: '人生长河档案登记处', center: '终', bottom: `${birthYear}–${deathYear}`, rotation: 0.18, seed });

  const midTop = Math.max(y + 30, 500);
  P.rule(84, midTop, CARD_WIDTH - 84, { color: pal.line, width: 1 });

  // stats row sits at a fixed place; the middle band (facts | life map) fills what is left above it
  const statsY = 980;
  const midBottom = statsY - 30;

  // left: facts
  const leftW = 440;
  const rowH = Math.min(66, Math.floor((midBottom - midTop - 24) / facts.length));
  const valueSize = rowH >= 64 ? 27 : 24;
  facts.forEach(([label, value], i) => {
    field(P, label, value, 84, midTop + 38 + i * rowH, leftW, { size: valueSize, labelSize: 18, gap: 8, min: 20 });
  });

  // right: life map
  const mapX = 560, mapW = CARD_WIDTH - 84 - mapX;
  P.text('一生 · 每格一年', mapX, midTop + 38, { size: 18, color: pal.ink3, spacing: 2 });
  P.font('body', 18, 400);
  const legendRows = legendItems.length ? Math.ceil(legendItems.reduce((a, it) => a + 16 + 8 + P.measure(it.label) + 18, 0) / mapW + 0.35) : 0;
  const legendH = legendRows * 28;
  const gridTop = midTop + 56;
  const gridH = drawLifeGrid(P, history, { x: mapX, y: gridTop, w: mapW, maxH: midBottom - gridTop - legendH - 14, birthYear });
  if (legendItems.length) drawLegend(P, legendItems, mapX, gridTop + gridH + 30, mapW);

  // final stats
  P.rule(84, statsY - 16, CARD_WIDTH - 84, { color: pal.line, width: 1 });
  const colW = (CARD_WIDTH - 168) / STATS.length;
  STATS.forEach((k, i) => {
    const x = 84 + i * colW;
    const v = Math.max(0, Math.min(100, Math.round(num(stats[k]) ?? 0)));
    P.text(STAT_LABELS[k], x, statsY + 24, { size: 20, color: pal.ink3 });
    P.text(String(v), x + colW - 24, statsY + 26, { kind: 'mono', size: 28, weight: 600, color: pal.ink, align: 'right' });
    ctx.fillStyle = pal.paper2;
    roundRect(ctx, x, statsY + 40, colW - 24, 10, 5);
    ctx.fill();
    ctx.fillStyle = pal.stats[k];
    if (v > 0) { roundRect(ctx, x, statsY + 40, Math.max(10, ((colW - 24) * v) / 100), 10, 5); ctx.fill(); }
  });

  // epitaph and biography excerpt
  let ty = statsY + 72;
  P.rule(84, ty, CARD_WIDTH - 84, { color: pal.ink3, width: 1 });
  ty += 10;
  const epiLines = epitaph ? P.wrap(`“${epitaph}”`, CARD_WIDTH - 220, 2, 'display', 32, 700) : [];
  epiLines.forEach((ln) => { ty += 46; P.text(ln, CARD_WIDTH / 2, ty, { kind: 'display', size: 32, weight: 700, color: pal.ink, align: 'center' }); });
  if (epiLines.length) ty += 12;
  const room = Math.min(4, Math.floor((1234 - ty) / 31));
  if (bio && room > 0) {
    const bioLines = P.wrap(bio, CARD_WIDTH - 168, room, 'body', 21);
    bioLines.forEach((ln) => { ty += 31; P.text(ln, 84, ty, { size: 21, color: pal.ink2 }); });
  }
  drawFooter(P);
  return canvasToBlob(canvas);
}

// ---------------------------------------------------------------------------------------------------------------
// achievement card

const TIER_STYLE = {
  N: { label: '普通', color: '#6E7F86' },
  R: { label: '稀有', color: '#3A6C8C' },
  SR: { label: '史诗', color: '#7A4FA0' },
  SSR: { label: '传说', color: '#B8892A' },
};

/**
 * One collected achievement card (成就卡片) as a shareable image.
 * @param {object} def   catalog entry from core/achievements.js ({id, icon, title, desc, tier, rate, cat})
 * @param {object|null} got  {at, n, life:{name, by, country, age}} from social/collection.js
 * @param {{have?: number, total?: number, index?: number, category?: string, url?: string, data?: object}} extra
 * @returns {Promise<Blob>}
 */
export async function achievementCard(def, got, extra = {}) {
  const tier = TIER_STYLE[def && def.tier] || TIER_STYLE.N;
  const title = String(def?.title || '成就');
  const desc = String(def?.desc || '');
  const life = got && got.life ? got.life : null;
  const no = `No.${String((extra.index ?? 0) + 1).padStart(3, '0')}${isNum(extra.total) ? ` / ${extra.total}` : ''}`;
  const who = life && life.name
    ? `由「${life.name}」获得${isNum(life.by) ? ` · ${life.by} 年生` : ''}${life.country ? ` · ${countryName(extra.data, life.country)}` : ''}${isNum(life.age) ? ` · 享年 ${life.age} 岁` : ''}`
    : '';
  const when = got && got.at ? `收集于 ${String(got.at).slice(0, 10).split('-').join('.')}` : '';
  const rate = isNum(def?.rate) ? (def.rate >= 0.01 ? `约 ${Math.round(def.rate * 100)}% 的人生能获得` : `不到 1% 的人生能获得`) : '';
  const have = isNum(extra.have) && isNum(extra.total) ? `已收集 ${extra.have} / ${extra.total}` : '';
  const url = extra.url ? String(extra.url).slice(0, 60) : '';

  const { canvas, ctx } = makeCanvas();
  const fonts = cardFonts();
  await ensureFonts(fonts, collectText(title, desc, who, when, rate, have, url, no, tier.label, extra.category || '',
    '人生长河档案馆 LIFELINE 2090 ARCHIVE 档案号 成就卡片 稀有度 来人生长河，活一次试试', CARD_FOOTER, DIGITS));
  const P = painter(ctx, fonts);
  const pal = P.pal;
  drawPaper(P, new Rng(hashString(String(def?.id || title))));
  drawHeader(P, { title: '成就卡片', no, right: extra.category ? `类别 · ${extra.category}` : '' });

  // the card face: a framed panel with the tier colour
  const x = 140, y = 290, w = CARD_WIDTH - 280, hgt = 700;
  ctx.save();
  roundRect(ctx, x, y, w, hgt, 28);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = tier.color;
  ctx.stroke();
  roundRect(ctx, x + 16, y + 16, w - 32, hgt - 32, 18);
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 6]);
  ctx.stroke();
  ctx.restore();

  // tier ribbon
  ctx.save();
  ctx.fillStyle = tier.color;
  roundRect(ctx, CARD_WIDTH / 2 - 120, y - 30, 240, 60, 30);
  ctx.fill();
  ctx.restore();
  P.text(`${tier.label} · ${def?.tier || 'N'}`, CARD_WIDTH / 2, y + 12, { size: 28, weight: 600, color: '#FFFFFF', align: 'center', spacing: 4 });

  // icon
  ctx.save();
  ctx.font = `160px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", ${fonts.body}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = pal.ink;
  ctx.fillText(String(def?.icon || '✦'), CARD_WIDTH / 2, y + 230);
  ctx.restore();

  const ts = P.fit(title, 'display', 700, 84, 48, w - 120);
  P.text(title, CARD_WIDTH / 2, y + 430, { kind: 'display', size: ts, weight: 700, color: pal.ink, align: 'center', spacing: 4 });
  P.rule(CARD_WIDTH / 2 - 80, y + 470, CARD_WIDTH / 2 + 80, { color: tier.color, width: 3 });
  const lines = P.wrap(desc, w - 140, 3, 'body', 32);
  lines.forEach((ln, i) => P.text(ln, CARD_WIDTH / 2, y + 530 + i * 46, { size: 32, color: pal.ink2, align: 'center' }));
  if (rate) P.text(rate, CARD_WIDTH / 2, y + hgt - 44, { size: 24, color: pal.ink3, align: 'center' });

  if (def && (def.tier === 'SR' || def.tier === 'SSR')) {
    drawSeal(P, x + w - 40, y + hgt - 40, 72, { center: def.tier === 'SSR' ? '传说' : '史诗', bottom: '收藏', seed: hashString(String(def.id)) });
  }

  // who earned it
  let ly = y + hgt + 80;
  if (who) { P.text(who, CARD_WIDTH / 2, ly, { size: 28, color: pal.ink, align: 'center', maxW: CARD_WIDTH - 168 }); ly += 48; }
  const sub = [when, have].filter(Boolean).join('　·　');
  if (sub) { P.text(sub, CARD_WIDTH / 2, ly, { size: 24, color: pal.ink2, align: 'center' }); ly += 44; }
  P.text(url ? `来人生长河，活一次试试 · ${url}` : '来人生长河，活一次试试', CARD_WIDTH / 2, Math.max(ly + 20, 1200), { size: 24, color: pal.ink3, align: 'center', maxW: CARD_WIDTH - 168 });
  drawFooter(P);
  return canvasToBlob(canvas);
}

// ---------------------------------------------------------------------------------------------------------------
// life poster (人生长卷): the whole life on one tall image for WeChat / 小红书, with a QR code back to the game

export const POSTER_HEIGHT = 1920; // the shortest poster; a long life with many choices grows taller
export const SHARE_URL = 'https://yz-shift.github.io/lifeline2090/';

const TIER_RANK = { SSR: 0, SR: 1, R: 2, N: 3 };

/** The address the poster's QR code opens: this page when it is served from a public site, else SHARE_URL. */
export function shareUrl(loc = typeof location !== 'undefined' ? location : null) {
  try {
    if (loc && /^https?:$/.test(loc.protocol) && !/^(localhost|127\.|192\.168\.|10\.)|claude\.ai$|claudeusercontent/.test(loc.hostname)) {
      return `${loc.protocol}//${loc.host}${loc.pathname.replace(/index\.html$/, '')}`;
    }
  } catch { /* fall through */ }
  return SHARE_URL;
}

/**
 * The key choices worth showing on the poster (at most `max`): the player's own written choices first, the rest
 * spread over the life, oldest first. [{age, year, title, choice, custom}]
 */
export function posterChoices(state, max = 6) {
  const all = (Array.isArray(state?.decisions) ? state.decisions : [])
    .filter((d) => d && typeof d.choice === 'string' && d.choice.trim() && isNum(Number(d.age)));
  if (all.length <= max) return all.slice();
  const own = all.filter((d) => d.custom).slice(0, Math.ceil(max / 2));
  const rest = all.filter((d) => !own.includes(d));
  const need = max - own.length;
  const picked = [];
  for (let i = 0; i < need; i++) picked.push(rest[Math.round((i * (rest.length - 1)) / Math.max(1, need - 1))]);
  return [...new Set([...own, ...picked])].sort((a, b) => a.age - b.age);
}

/** The happiest and the hardest year from the history rows: {high, low} rows (low only when it really was low). */
export function posterHighLow(state) {
  const rows = (Array.isArray(state?.history) ? state.history : []).filter((r) => r && r.stats && isNum(Number(r.age)) && r.tag !== 'death');
  let high = null, low = null;
  for (const r of rows) {
    const v = num(r.stats.happiness);
    if (v == null) continue;
    if (r.age >= 3 && (!high || v > num(high.stats.happiness))) high = r;
    if (r.age >= 6 && (!low || v < num(low.stats.happiness))) low = r;
  }
  // a low point only when it stands out from the best year (an even life has none)
  if (low && (low === high || num(low.stats.happiness) > num(high?.stats.happiness ?? 100) - 20)) low = null;
  return { high, low };
}

const plainHeadline = (s) => !s || /^平常的一年$|^出生$/.test(String(s));

/**
 * What happened to the person in that year, in one sentence: their own entry with the strongest tone of that sign
 * (world news and system lines are left out, so a happy year is not summed up by a headline about grain prices).
 */
export function posterMoment(state, row, sign) {
  if (!row) return '';
  const own = (Array.isArray(state?.log) ? state.log : []).filter((e) => e && e.year === row.year && typeof e.text === 'string'
    && !['news', 'system', 'decision'].includes(e.kind) && sign * (num(e.tone) ?? 0) > 0);
  own.sort((a, b) => sign * ((num(b.tone) ?? 0) - (num(a.tone) ?? 0)));
  const e = own[0];
  if (e) {
    const t = String(e.text).replace(/^【推演】/, '').replace(/\s+/g, ' ').trim();
    const first = (t.match(/^[^。！？]*[。！？]?/) || [t])[0];
    return first.length >= 6 ? first : t;
  }
  if (!plainHeadline(row.headline)) return String(row.headline);
  return sign > 0 ? '没有什么大事，日子却格外顺心。' : '说不出哪里不好，就是过得很难。';
}

/**
 * 人生长卷: one tall shareable image of the whole life (1080 x 1920).
 * @param {object} state   a finished life
 * @param {object} data    data store (country names)
 * @param {{title?: string, epitaph?: string, cards?: object[], url?: string, lifeExp?: number}} extra
 *        cards: catalog entries earned by this life (core/achievements.js)
 * @returns {Promise<Blob>}
 */
export async function lifePoster(state, data, extra = {}) {
  const b = state?.birth || {};
  const p = state?.person || {};
  const dead = state?.dead || {};
  const birthYear = num(b.year) ?? dateParts(b.date).y ?? 2000;
  const deathYear = num(dead.year) ?? num(state?.year) ?? birthYear;
  const age = num(dead.age) ?? num(state?.age) ?? Math.max(0, deathYear - birthYear);
  const name = String(b.name || p.name || '无名');
  const birthIso = b.country || p.country;
  const no = archiveNumber(state);
  const title = extra?.title ? String(extra.title).trim() : '';
  const url = String(extra?.url || SHARE_URL);
  const span = `${dateDots(b.date, birthYear)} — ${dateDots(dead.date, deathYear)}`;
  const family = num(b.familyPct);
  const famWord = family == null ? '' : family < 0.2 ? '家境十分拮据' : family < 0.4 ? '家境比较紧张' : family < 0.6 ? '家境中等' : family < 0.8 ? '家境比较宽裕' : '家境优渥';
  const born = `生于${countryName(data, birthIso)}的${b.urban ? '城市' : '乡村'}${famWord ? ` · ${famWord}` : ''}`;
  const places = [...new Set((Array.isArray(state?.history) ? state.history : []).map((r) => r && r.country).filter(Boolean))];
  const moved = places.length > 1 ? `一生在 ${places.length} 个国家生活过` : '';

  // the three numbers
  let pct = num(dead.percentile);
  if (isNum(pct) && pct <= 1) pct *= 100;
  const earned = (Array.isArray(extra?.cards) ? extra.cards : []).filter((d) => d && d.id)
    .sort((x, y) => (TIER_RANK[x.tier] ?? 4) - (TIER_RANK[y.tier] ?? 4) || (num(x.rate) ?? 1) - (num(y.rate) ?? 1));
  const rarest = earned.find((d) => isNum(d.rate)) || null;
  const exams = Array.isArray(p.education?.exams) ? p.education.exams : [];
  const gaokao = exams.filter((x) => x && isNum(x.score)).pop() || null;
  const decisions = Array.isArray(state?.decisions) ? state.decisions : [];
  const own = decisions.filter((d) => d && d.custom).length;
  const tiles = [];
  tiles.push(isNum(pct)
    ? { big: `${Math.round(Math.max(0, Math.min(100, pct)))}%`, label: '比这么多同年同国出生的人活得更久' }
    : { big: `${age}`, label: '岁，这一生的长度' });
  if (gaokao) tiles.push({ big: `${gaokao.score}`, label: `${gaokao.age} 岁那年的高考分数（满分 750）` });
  else tiles.push({ big: `${decisions.length}`, label: own ? `次人生抉择，其中 ${own} 次是自己写下的` : '次人生抉择' });
  if (rarest) {
    const r = rarest.rate >= 0.01 ? `${Math.round(rarest.rate * 100)}%` : '<1%';
    tiles.push({ big: r, label: `的人生才会遇到「${rarest.title}」` });
  } else {
    tiles.push({ big: `${earned.length}`, label: '张成就卡片' });
  }

  const choices = posterChoices(state, 6);
  const { high, low } = posterHighLow(state);
  const highText = posterMoment(state, high, 1);
  const lowText = posterMoment(state, low, -1);
  const history = Array.isArray(state?.history) ? state.history : [];
  const icons = earned.slice(0, 10);

  // the height follows the content: header and name, three numbers, the choices, high/low, map + cards, QR
  const rowH = 74;
  const mapRows = Math.floor(Math.max(0, ...history.map((r) => num(r && r.age) ?? 0)) / 10) + 1;
  const mapH = 40 + mapRows * 30;
  const iconsH = 40 + Math.ceil(icons.length / 4) * 120;
  const top = 560 + (title ? 54 : 0);
  const choicesH = 30 + Math.max(1, choices.length) * rowH + 10 + 56;
  const hlH = high || low ? 204 : 0;
  const H = Math.max(POSTER_HEIGHT, top + 176 + 56 + choicesH + hlH + Math.max(mapH, iconsH) + 10 + 310);

  const { canvas, ctx } = makeCanvas(H);
  const fonts = cardFonts();
  await ensureFonts(fonts, collectText(name, title, span, born, moved, no, tiles.map((t) => [t.big, t.label]),
    choices.map((c) => [c.title, c.choice]), highText, lowText, earned.map((d) => d.title), url,
    '人生长河档案馆 LIFELINE 2090 ARCHIVE 档案号 人生长卷 享年 关键选择 高光 低谷 一生 每格一年 这一生收集到 张卡片 扫码，活一次你自己的人生 随机出生在世界上任何一个地方 2000–2026 年真实数据，之后推演到 2090 年 「」 → 自己写的 终 人生长河档案登记处',
    CARD_FOOTER, DIGITS));
  const P = painter(ctx, fonts);
  const pal = P.pal;
  const seed = hashString(no + ':poster');
  drawPaper(P, new Rng(seed), H);
  drawHeader(P, { title: '人生长卷', no, right: `${birthYear}–${deathYear}` });

  // name block
  const nameSize = P.fit(name, 'display', 700, 96, 52, 640);
  let y = 262 + nameSize;
  P.text(name, 84, y, { kind: 'display', size: nameSize, weight: 700, color: pal.ink, maxW: 660 });
  y += 54;
  const sw = P.text(span, 84, y, { kind: 'mono', size: 30, weight: 600, color: pal.ink, maxW: 520 });
  P.text(`享年 ${age} 岁`, 84 + sw + 22, y, { size: 30, weight: 600, color: pal.ink2, maxW: 660 - sw - 22 });
  y += 44;
  P.text([born, moved].filter(Boolean).join(' · '), 84, y, { size: 24, color: pal.ink2, maxW: 680 });
  if (title) { y += 54; P.text(`「${title}」`, 70, y, { kind: 'display', size: 34, weight: 700, color: pal.ink2, maxW: 700 }); }
  drawSeal(P, 880, 372, 104, { ring: '人生长河档案登记处', center: '终', bottom: `${birthYear}–${deathYear}`, rotation: 0.18, seed });

  // three numbers
  y = Math.max(y + 50, top - 40);
  const tw = (CARD_WIDTH - 168 - 2 * 24) / 3, th = 176;
  tiles.forEach((t, i) => {
    const x = 84 + i * (tw + 24);
    ctx.save();
    roundRect(ctx, x, y, tw, th, 18);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fill();
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
    const bs = P.fit(t.big, 'mono', 700, 64, 36, tw - 40);
    P.text(t.big, x + 22, y + 22 + bs, { kind: 'mono', size: bs, weight: 700, color: i === 0 ? pal.seal : pal.ink });
    P.wrap(t.label, tw - 44, 2, 'body', 22).forEach((ln, k) => P.text(ln, x + 22, y + 122 + k * 30, { size: 22, color: pal.ink2 }));
  });
  y += th + 56;

  // key choices
  P.text('关键选择', 84, y, { kind: 'display', size: 34, weight: 700, color: pal.ink, spacing: 4 });
  P.rule(84, y + 18, CARD_WIDTH - 84, { color: pal.line, width: 1 });
  y += 30;
  const lineX = 84 + 96;
  if (choices.length) {
    ctx.save();
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(lineX, y + 30);
    ctx.lineTo(lineX, y + 30 + (choices.length - 1) * rowH);
    ctx.stroke();
    ctx.restore();
  } else {
    P.text('这一生没有来得及做出选择。', 84, y + 44, { size: 26, color: pal.ink3 });
  }
  choices.forEach((c, i) => {
    const cy = y + 30 + i * rowH;
    P.text(`${c.age} 岁`, lineX - 24, cy + 10, { kind: 'mono', size: 26, weight: 600, color: pal.ink2, align: 'right' });
    ctx.save();
    ctx.beginPath();
    ctx.arc(lineX, cy, 9, 0, Math.PI * 2);
    ctx.fillStyle = c.custom ? pal.seal : pal.ink2;
    ctx.fill();
    ctx.restore();
    const head = c.custom ? `${c.title || '主动选择'} · 自己写的` : String(c.title || '抉择');
    P.text(head, lineX + 28, cy - 8, { size: 20, color: c.custom ? pal.seal : pal.ink3, maxW: CARD_WIDTH - 84 - lineX - 28 });
    P.text(`→ ${c.choice}`, lineX + 28, cy + 26, { size: 28, weight: 600, color: pal.ink, maxW: CARD_WIDTH - 84 - lineX - 28 });
  });
  y += 30 + Math.max(1, choices.length) * rowH + 10 + 6;

  // high and low
  const boxW = (CARD_WIDTH - 168 - 24) / 2, boxH = 160;
  const hl = [
    high ? { k: '高光', at: `${high.age} 岁 · ${high.year}`, t: highText, c: pal.tags.success } : null,
    low ? { k: '低谷', at: `${low.age} 岁 · ${low.year}`, t: lowText, c: pal.tags.loss } : null,
  ].filter(Boolean);
  hl.forEach((it, i) => {
    const x = 84 + i * (boxW + 24);
    ctx.save();
    roundRect(ctx, x, y, boxW, boxH, 16);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fill();
    ctx.fillStyle = it.c;
    roundRect(ctx, x, y, 10, boxH, 5);
    ctx.fill();
    ctx.restore();
    P.text(it.k, x + 30, y + 44, { kind: 'display', size: 30, weight: 700, color: pal.ink });
    P.text(it.at, x + boxW - 22, y + 42, { kind: 'mono', size: 22, color: pal.ink3, align: 'right' });
    P.wrap(it.t, boxW - 54, 2, 'body', 26).forEach((ln, k) => P.text(ln, x + 30, y + 92 + k * 36, { size: 26, color: pal.ink2 }));
  });
  if (hl.length) y += boxH + 44;

  // life map (left) and the cards of this life (right)
  const qrTop = H - 300;
  const mapW = 470;
  P.text('一生 · 每格一年', 84, y, { size: 20, color: pal.ink3, spacing: 2 });
  drawLifeGrid(P, history, { x: 84, y: y + 22, w: mapW, maxH: Math.max(mapH, iconsH) - 30, birthYear });
  const cx0 = 84 + mapW + 50, cw = CARD_WIDTH - 84 - cx0;
  P.text(earned.length ? `这一生收集到 ${earned.length} 张卡片` : '这一生没有收集到卡片', cx0, y, { size: 20, color: pal.ink3, spacing: 2 });
  const ic = 82, gap = 12, perRow = Math.max(1, Math.floor((cw + gap) / (ic + gap)));
  icons.forEach((d, i) => {
    const x = cx0 + (i % perRow) * (ic + gap), yy = y + 22 + Math.floor(i / perRow) * (ic + gap + 26);
    if (yy + ic + 26 > qrTop - 30) return;
    const tier = TIER_STYLE[d.tier] || TIER_STYLE.N;
    ctx.save();
    roundRect(ctx, x, yy, ic, ic, 14);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = tier.color;
    ctx.stroke();
    ctx.font = `44px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", ${fonts.body}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = pal.ink;
    ctx.fillText(String(d.icon || '✦'), x + ic / 2, yy + ic / 2 + 2);
    ctx.restore();
    P.text(String(d.title), x + ic / 2, yy + ic + 22, { size: 17, color: pal.ink2, align: 'center', maxW: ic + gap - 2 });
  });

  // QR code and the invitation
  P.rule(84, qrTop - 10, CARD_WIDTH - 84, { color: pal.ink3, width: 1 });
  const q = qrMatrix(url);
  const qs = 200, qx = 84, qy = qrTop + 20;
  ctx.fillStyle = '#FFFFFF';
  roundRect(ctx, qx - 10, qy - 10, qs + 20, qs + 20, 10);
  ctx.fill();
  if (q) {
    const m = qs / q.size;
    ctx.fillStyle = '#000000';
    for (let yy = 0; yy < q.size; yy++) for (let xx = 0; xx < q.size; xx++) {
      if (q.dark(xx, yy)) ctx.fillRect(Math.floor(qx + xx * m), Math.floor(qy + yy * m), Math.ceil(m), Math.ceil(m));
    }
  }
  const tx = qx + qs + 44, tmax = CARD_WIDTH - 84 - tx;
  P.text('扫码，活一次你自己的人生', tx, qy + 52, { kind: 'display', size: P.fit('扫码，活一次你自己的人生', 'display', 700, 42, 28, tmax), weight: 700, color: pal.ink, maxW: tmax });
  P.text('随机出生在世界上任何一个地方', tx, qy + 104, { size: 24, color: pal.ink2, maxW: tmax });
  P.text('2000–2026 年真实数据，之后推演到 2090 年', tx, qy + 142, { size: 22, color: pal.ink3, maxW: tmax });
  P.text(url.replace(/^https?:\/\//, '').replace(/\/$/, ''), tx, qy + 190, { kind: 'mono', size: 22, color: pal.ink2, maxW: tmax });
  return canvasToBlob(canvas);
}

// ---------------------------------------------------------------------------------------------------------------
// saving

const SAVE_MESSAGES = {
  saved: '已保存',
  downloaded: '已开始下载',
  declined: '已取消保存',
  rate_limited: '已有一个保存请求在等待确认，请稍后再试',
  too_large: '文件太大，无法保存',
  rejected_extension: '当前环境不接受这种文件格式',
  extension_not_enabled: '当前环境不接受这种文件格式',
  bad_request: '保存请求无效',
  unavailable: '当前环境不支持下载文件',
};

/**
 * Offer a file to the viewer. Inside claude.ai the `downloads` capability shows a confirmation; where it is absent
 * (no window.claude, or use('downloads') resolving null on a top-level page such as the platform's own host) an
 * <a download> with an object URL is used. A framed page without the capability cannot download by itself, so it
 * reports 'unavailable' instead of pretending. Never throws.
 * @returns {Promise<{ok: boolean, status: string, code?: string, message: string}>}
 */
export async function saveBlob(blob, filename) {
  if (!blob || typeof filename !== 'string' || !filename) {
    return { ok: false, status: 'error', code: 'bad_request', message: SAVE_MESSAGES.bad_request };
  }
  const host = typeof window !== 'undefined' ? window.claude : undefined;
  let d = null;
  if (host) {
    try { d = typeof host.use === 'function' ? await host.use('downloads') : null; } catch { d = null; }
    if (!d || typeof d.save !== 'function') {
      // only a page that is certainly top-level may fall back (a cross-origin top throws; unknown counts as framed)
      let framed = true;
      try { framed = !(window.top && window.self && window.top === window.self); } catch { framed = true; }
      if (framed) return { ok: false, status: 'error', code: 'unavailable', message: SAVE_MESSAGES.unavailable };
      d = null;
    }
  }
  if (host && d) {
    try {
      const res = await d.save({ filename, data: blob });
      return { ok: true, status: res?.status || 'saved', message: SAVE_MESSAGES.saved };
    } catch (e) {
      const known = ['declined', 'rate_limited', 'too_large', 'rejected_extension', 'extension_not_enabled', 'bad_request', 'transform_error'];
      const code = known.includes(e?.code) ? (e.code === 'transform_error' ? 'bad_request' : e.code) : 'unavailable';
      return { ok: false, status: code === 'declined' ? 'declined' : 'error', code, message: SAVE_MESSAGES[code] || SAVE_MESSAGES.unavailable };
    }
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return { ok: true, status: 'downloaded', message: SAVE_MESSAGES.downloaded };
  } catch {
    return { ok: false, status: 'error', code: 'unavailable', message: SAVE_MESSAGES.unavailable };
  }
}
