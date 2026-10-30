// "人生风景" — a generative illustration of the current year of a life, drawn on canvas (no image files).
// Terrain follows the birth region, the settlement follows urban/rural, era, wealth and the world line, the sky
// follows the season inside the year, the figures follow the person's age and family, and the year's tag sets the
// weather (war smoke, crisis rain, a calm sunny year). The layout is seeded per life so the place stays the same
// place while the person grows up in it.
//
// createScene(host, { data, world }) -> { update(state, monthFraction?), paint(), destroy(), el }

import { Rng, hashString } from '../core/rng.js';

const TERRAIN = {
  EAS: 'mountains', SEA: 'coast', SAS: 'hills', CAS: 'steppe', WAS: 'desert', NAF: 'desert', SSA: 'savanna',
  EEU: 'plains', WEU: 'forest', NAM: 'plains', LAC: 'jungle', OCE: 'coast',
};
const ISLANDS = new Set(['JPN', 'PHL', 'IDN', 'LKA', 'MDV', 'SGP', 'TWN', 'CUB', 'DOM', 'HTI', 'JAM', 'MDG', 'NZL', 'GBR', 'IRL', 'ISL', 'FJI', 'PNG', 'CPV', 'MUS']);

const PALETTES = {
  light: {
    sky: { spring: ['#cfe3ee', '#eef3ea'], summer: ['#a9d2ec', '#e9f2f4'], autumn: ['#e6d3bd', '#f1ebe1'], winter: ['#d5dde6', '#eef1f4'] },
    far: '#9fb1bf', mid: '#7b8f7c', near: '#56685a', sand: '#d8c19a', sea: '#7fb1c9', city: '#5d6b7a', window: '#f4d58a',
    ink: '#1e2833', haze: 'rgba(255,255,255,0.35)', proj: 'rgba(76,150,170,0.10)', smoke: 'rgba(70,70,74,0.45)', rain: 'rgba(70,90,110,0.35)',
  },
  dark: {
    sky: { spring: ['#1b2a3a', '#23364a'], summer: ['#14273b', '#1f3b55'], autumn: ['#2a2430', '#3a3036'], winter: ['#161d29', '#26303f'] },
    far: '#2d3d4d', mid: '#2a3b34', near: '#1b2722', sand: '#5b4c36', sea: '#21485c', city: '#33414f', window: '#e2bd63',
    ink: '#0b1016', haze: 'rgba(160,190,220,0.08)', proj: 'rgba(90,180,200,0.10)', smoke: 'rgba(20,20,22,0.55)', rain: 'rgba(160,190,220,0.25)',
  },
};

function isDark() {
  try {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch { return false; }
}

function season(month) {
  return month < 2 || month >= 11 ? 'winter' : month < 5 ? 'spring' : month < 8 ? 'summer' : 'autumn';
}

/** Collect what the picture needs from a LifeState (tolerant of missing fields). */
function readLife(state, data, world, frac) {
  const p = state.person || {};
  const iso = p.country || (state.birth && state.birth.country) || 'CHN';
  const c = data && typeof data.country === 'function' ? data.country(iso) : null;
  const region = (c && c.region) || 'EAS';
  const year = Number(state.year) || 2000;
  const gdp = data && typeof data.series === 'function' ? Number(data.series(iso, 'gdp_pc_ppp', Math.min(year, 2100))) || 8000 : 8000;
  const br = (world && world.branches) || {};
  const last = Array.isArray(state.history) && state.history.length ? state.history[state.history.length - 1] : null;
  const kids = (p.children || []).filter((k) => k && k.alive !== false && year - (Number(k.birthYear) || year) < 18)
    .map((k) => ({ age: year - (Number(k.birthYear) || year), sex: k.sex }));
  const rel = p.relationship || {};
  return {
    iso, region, year, gdp, frac: Math.max(0, Math.min(1, Number(frac) || 0)),
    terrain: ISLANDS.has(iso) ? 'coast' : TERRAIN[region] || 'plains',
    urban: !!p.urban, age: Number(state.age) || 0, sex: p.sex === 'female' ? 'female' : 'male',
    partner: ['married', 'partnered', 'dating'].includes(rel.status) && rel.partner ? 1 : 0,
    kids: kids.slice(0, 3),
    tag: last ? last.tag : 'birth', mood: last ? Number(last.mood) || 0 : 0,
    dead: !!state.dead, projection: year > 2026,
    energyFast: br.energy === 'energy_fast', aiHigh: br.ai === 'ai_transformative', hot: br.climate === 'climate_high',
    seed: hashString(String(state.id || state.seed || 'life') + ':' + iso + ':' + (p.urban ? 'u' : 'r')),
  };
}

function ridge(ctx, w, h, base, amp, rough, rng, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, h);
  let y = base;
  const step = Math.max(6, w / 60);
  for (let x = 0; x <= w + step; x += step) {
    y += (rng.next() - 0.5) * rough;
    y = Math.max(base - amp, Math.min(base + amp * 0.3, y));
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
}

function drawTerrain(ctx, w, h, L, P, rng) {
  const t = L.terrain;
  if (t === 'mountains' || t === 'hills' || t === 'steppe') {
    const amp = t === 'mountains' ? h * 0.32 : t === 'hills' ? h * 0.18 : h * 0.08;
    ridge(ctx, w, h, h * 0.52, amp, amp * 0.7, rng, P.far);
    ridge(ctx, w, h, h * 0.64, amp * 0.6, amp * 0.5, rng, P.mid);
  } else if (t === 'desert') {
    ctx.fillStyle = P.sand;
    for (let i = 0; i < 4; i++) {
      const cx = rng.float(0, w), r = rng.float(w * 0.18, w * 0.35);
      ctx.beginPath(); ctx.ellipse(cx, h * 0.72, r, h * 0.16, 0, Math.PI, 0); ctx.fill();
    }
    ctx.fillRect(0, h * 0.7, w, h * 0.3);
  } else if (t === 'coast') {
    ridge(ctx, w * 0.55, h, h * 0.56, h * 0.16, h * 0.12, rng, P.far);
    ctx.fillStyle = P.sea;
    ctx.fillRect(w * 0.45, h * 0.66, w * 0.55, h * 0.34);
    ctx.fillStyle = P.haze;
    for (let i = 0; i < 6; i++) ctx.fillRect(w * 0.5 + rng.float(0, w * 0.45), h * 0.7 + i * h * 0.04, rng.float(20, 60), 1.5);
  } else if (t === 'savanna') {
    ridge(ctx, w, h, h * 0.62, h * 0.05, h * 0.04, rng, P.far);
    ctx.fillStyle = P.mid;
    for (let i = 0; i < 4; i++) {
      const x = rng.float(0, w), y = h * 0.66;
      ctx.fillRect(x - 1.5, y - h * 0.12, 3, h * 0.12);
      ctx.beginPath(); ctx.ellipse(x, y - h * 0.13, h * 0.11, h * 0.035, 0, 0, Math.PI * 2); ctx.fill();
    }
  } else if (t === 'jungle' || t === 'forest') {
    ridge(ctx, w, h, h * 0.58, h * 0.12, h * 0.1, rng, P.far);
    ctx.fillStyle = P.mid;
    for (let x = 0; x < w; x += rng.float(10, 22)) {
      const r = rng.float(h * 0.05, h * 0.09);
      ctx.beginPath(); ctx.arc(x, h * 0.68, r, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    ridge(ctx, w, h, h * 0.64, h * 0.04, h * 0.03, rng, P.far);
  }
  // ground
  ctx.fillStyle = L.terrain === 'desert' ? P.sand : P.near;
  ctx.fillRect(0, h * 0.82, w, h * 0.18);
}

function drawSettlement(ctx, w, h, L, P, rng) {
  const ground = h * 0.82;
  const x0 = w * 0.08, x1 = L.terrain === 'coast' ? w * 0.46 : w * 0.62;
  if (L.urban) {
    // the skyline grows with the economy and the years
    const wealth = Math.max(0.15, Math.min(1, Math.log10(Math.max(1500, L.gdp)) / 5 - 0.5));
    const era = Math.min(1, Math.max(0, (L.year - 2000) / 60));
    let x = x0;
    while (x < x1) {
      const bw = rng.float(w * 0.018, w * 0.04);
      const bh = h * (0.1 + rng.next() * 0.38 * (0.45 + wealth * 0.55 + era * 0.35));
      ctx.fillStyle = P.city;
      ctx.fillRect(x, ground - bh, bw, bh);
      ctx.fillStyle = P.window;
      for (let wy = ground - bh + 4; wy < ground - 4; wy += 6) {
        for (let wx = x + 2; wx < x + bw - 2; wx += 5) if (rng.chance(0.28)) ctx.fillRect(wx, wy, 1.6, 2);
      }
      if (L.projection && L.energyFast && rng.chance(0.3)) { // rooftop solar
        ctx.fillStyle = '#3d6f8f';
        ctx.fillRect(x + 1, ground - bh - 2, bw - 2, 2);
      }
      x += bw + rng.float(1, 4);
    }
  } else {
    // village: small houses, a field and trees
    ctx.strokeStyle = P.mid;
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      const y = ground + 3 + i * 3;
      ctx.beginPath(); ctx.moveTo(w * 0.05, y); ctx.lineTo(w * 0.4, y); ctx.stroke();
    }
    const n = 3 + Math.floor(rng.next() * 3);
    for (let i = 0; i < n; i++) {
      const hx = rng.float(x0, x1), hw = rng.float(w * 0.025, w * 0.04), hh = hw * 0.7;
      ctx.fillStyle = P.city;
      ctx.fillRect(hx, ground - hh, hw, hh);
      ctx.beginPath(); ctx.moveTo(hx - 2, ground - hh); ctx.lineTo(hx + hw / 2, ground - hh - hw * 0.45); ctx.lineTo(hx + hw + 2, ground - hh); ctx.fill();
      ctx.fillStyle = P.window;
      if (L.year >= 2005 || rng.chance(0.5)) ctx.fillRect(hx + hw * 0.4, ground - hh * 0.6, 2.5, 2.5);
    }
  }
  // future world-line details
  if (L.projection && L.year >= 2032) {
    if (L.energyFast) {
      for (let i = 0; i < 3; i++) {
        const tx = w * (0.66 + i * 0.09), th = h * 0.32;
        ctx.strokeStyle = isDark() ? '#9fb3c4' : '#f6f8fa';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(tx, ground); ctx.lineTo(tx, ground - th); ctx.stroke();
        const a = (L.frac * 6 + i) * Math.PI;
        for (let k = 0; k < 3; k++) {
          const ang = a + (k * 2 * Math.PI) / 3;
          ctx.beginPath(); ctx.moveTo(tx, ground - th); ctx.lineTo(tx + Math.cos(ang) * h * 0.09, ground - th + Math.sin(ang) * h * 0.09); ctx.stroke();
        }
      }
    }
    if (L.aiHigh) { // small drones crossing the sky
      ctx.fillStyle = P.ink;
      for (let i = 0; i < 3; i++) {
        const dx = ((L.frac + i * 0.31) % 1) * w, dy = h * (0.18 + i * 0.07);
        ctx.fillRect(dx, dy, 5, 1.5); ctx.fillRect(dx + 1, dy - 1.5, 1, 1.5); ctx.fillRect(dx + 3, dy - 1.5, 1, 1.5);
      }
    }
  }
}

function person(ctx, x, ground, age, sex, scale, color) {
  // height grows to adulthood and stoops a little in old age
  const grown = Math.min(1, 0.35 + age / 18 * 0.65);
  const stoop = age > 70 ? Math.min(0.1, (age - 70) / 200) : 0;
  const hgt = scale * grown * (1 - stoop);
  const head = hgt * 0.13;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x + stoop * hgt * 0.6, ground - hgt + head, head, 0, Math.PI * 2); ctx.fill();
  const bw = hgt * (sex === 'female' ? 0.2 : 0.17);
  ctx.beginPath();
  ctx.moveTo(x - bw / 2, ground - hgt + head * 2.1);
  ctx.lineTo(x + bw / 2, ground - hgt + head * 2.1);
  ctx.lineTo(x + (sex === 'female' ? bw * 0.75 : bw * 0.45), ground - hgt * 0.42);
  ctx.lineTo(x - (sex === 'female' ? bw * 0.75 : bw * 0.45), ground - hgt * 0.42);
  ctx.fill();
  ctx.fillRect(x - bw * 0.35, ground - hgt * 0.42, bw * 0.25, hgt * 0.42);
  ctx.fillRect(x + bw * 0.1, ground - hgt * 0.42, bw * 0.25, hgt * 0.42);
  if (age > 72) { ctx.fillRect(x + bw * 0.9, ground - hgt * 0.5, 1.5, hgt * 0.5); } // walking stick
}

function drawPeople(ctx, w, h, L, P) {
  const ground = h * 0.9;
  const scale = h * 0.42;
  let x = w * 0.74;
  if (L.dead) {
    // an empty spot with a small lantern
    ctx.fillStyle = P.window;
    ctx.beginPath(); ctx.arc(x, ground - 6, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(244,213,138,0.18)';
    ctx.beginPath(); ctx.arc(x, ground - 6, 16, 0, Math.PI * 2); ctx.fill();
    return;
  }
  person(ctx, x, ground, L.age, L.sex, scale, P.ink);
  if (L.partner) { x += scale * 0.32; person(ctx, x, ground, Math.max(18, L.age), L.sex === 'female' ? 'male' : 'female', scale * 0.98, P.ink); }
  for (const k of L.kids) { x += scale * 0.24; person(ctx, x, ground, k.age, k.sex, scale, P.ink); }
}

function drawWeather(ctx, w, h, L, P, rng) {
  if (L.tag === 'war') {
    for (let i = 0; i < 3; i++) {
      const sx = rng.float(w * 0.1, w * 0.6);
      for (let k = 0; k < 7; k++) {
        ctx.fillStyle = P.smoke;
        ctx.beginPath(); ctx.arc(sx + k * 4 + Math.sin(L.frac * 6 + k) * 3, h * 0.78 - k * h * 0.07, 6 + k * 2.2, 0, Math.PI * 2); ctx.fill();
      }
    }
  } else if (L.tag === 'crisis' || L.tag === 'loss' || L.mood <= -2) {
    ctx.strokeStyle = P.rain;
    ctx.lineWidth = 1;
    const off = (L.frac * 40) % 12;
    for (let i = 0; i < 70; i++) {
      const rx = rng.float(0, w), ry = (rng.float(0, h) + off * 8) % h;
      ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx - 3, ry + 8); ctx.stroke();
    }
  }
  if (L.projection && L.hot && L.year >= 2040) {
    ctx.fillStyle = 'rgba(230,150,80,0.10)';
    ctx.fillRect(0, h * 0.4, w, h * 0.6);
  }
}

export function createScene(host, deps = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'g-scene-cv';
  canvas.setAttribute('role', 'img');
  const wrap = document.createElement('figure');
  wrap.className = 'g-scene';
  const cap = document.createElement('figcaption');
  cap.className = 'g-scene-cap';
  wrap.append(canvas, cap);
  if (host) host.append(wrap);
  let L = null;
  let lastPaint = 0;
  let destroyed = false;

  function paint() {
    if (destroyed || !L) return;
    const rect = wrap.getBoundingClientRect();
    const w = Math.max(240, Math.floor(rect.width || 600));
    const h = Math.round(Math.min(200, Math.max(120, w * 0.26)));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.height = h + 'px';
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const P = PALETTES[isDark() ? 'dark' : 'light'];
    const month = Math.floor(L.frac * 12);
    const [top, bottom] = L.dead ? (isDark() ? ['#120f1a', '#3b2a35'] : ['#c9a9a0', '#f0dccb']) : P.sky[season(month)];
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, top); g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // sun or moon travelling across the year
    ctx.fillStyle = isDark() ? 'rgba(230,226,200,0.85)' : 'rgba(255,236,170,0.9)';
    ctx.beginPath(); ctx.arc(w * (0.1 + 0.8 * L.frac), h * (0.32 - Math.sin(L.frac * Math.PI) * 0.18), h * 0.06, 0, Math.PI * 2); ctx.fill();
    const rng = new Rng(L.seed);
    drawTerrain(ctx, w, h, L, P, rng);
    drawSettlement(ctx, w, h, L, P, new Rng(L.seed + 7 + (L.urban ? Math.floor((L.year - 2000) / 10) : 0)));
    drawWeather(ctx, w, h, L, P, new Rng(L.seed + L.year));
    drawPeople(ctx, w, h, L, P);
    if (L.projection) { ctx.fillStyle = P.proj; ctx.fillRect(0, 0, w, h); }
    lastPaint = Date.now();
  }

  function describe() {
    if (!L) return '';
    const where = { mountains: '群山', hills: '丘陵', steppe: '草原', desert: '沙丘', coast: '海岸', savanna: '稀树草原', jungle: '雨林', forest: '森林', plains: '平原' }[L.terrain] || '原野';
    const place = L.urban ? '城市' : '村庄';
    const who = L.dead ? '那里只剩一盏灯' : `${L.age} 岁的你${L.partner ? '和伴侣' : ''}${L.kids.length ? `带着${L.kids.length}个孩子` : ''}`;
    return `${L.year} 年 · ${where}边的${place} · ${who}${L.projection ? ' · 推演中的世界' : ''}`;
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => paint()) : null;
  if (ro) ro.observe(wrap);
  let mq = null;
  const onScheme = () => paint();
  try { mq = window.matchMedia('(prefers-color-scheme: dark)'); mq.addEventListener('change', onScheme); } catch { mq = null; }

  return {
    el: wrap,
    update(state, frac) {
      if (destroyed || !state) return;
      const next = readLife(state, deps.data, deps.world, frac);
      const yearChanged = !L || L.year !== next.year || L.dead !== next.dead || L.tag !== next.tag;
      L = next;
      const text = describe();
      canvas.setAttribute('aria-label', '人生风景：' + text);
      cap.textContent = text;
      // within a year only the sky moves; repaint at most a few times a second
      if (yearChanged || Date.now() - lastPaint > 250) paint();
    },
    paint,
    destroy() {
      destroyed = true;
      if (ro) ro.disconnect();
      try { mq && mq.removeEventListener('change', onScheme); } catch { /* ignore */ }
      wrap.remove();
    },
  };
}
