// The same-second cohort (CONTRACT §2, §3 Peer): a handful of people born in the same second as the player,
// somewhere on Earth, each simulated over a whole life with the offline engine and automatic choices (no AI).
// A compact timeline of status changes lets the UI show what each peer is doing in any year.
// Pure module: no DOM, no Math.random, no Date.

import { Rng, hashString } from './rng.js';
import { newLife, stepYear, applyResolution, statusLine } from './engine.js';
import { randomBirth } from './person.js';
import { autoChoose, resolveOffline } from './decisions.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clampN = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
function safe(fn, fb = null) {
  try {
    const v = fn();
    return v === undefined || v === null ? fb : v;
  } catch {
    return fb;
  }
}
const SECONDS_PER_YEAR = 31557600;
const zhNum = (n) => ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'][n] || String(n);

/** Settings for headless lives: offline, automatic choices, sparse decisions, no nested cohort. */
export const HEADLESS_SETTINGS = Object.freeze({ lifeMinutes: 30, aiMode: 'off', decisionFreq: 'sparse', autoChoose: true, cohort: false, headless: true });

/**
 * Resolve the pending decision the way the auto-chooser would (same seeds as the game controller's auto mode).
 * Returns the LogEntries added.
 */
export function autoResolve(data, world, state) {
  const d = state && state.pending;
  if (!d) return [];
  let choice = null;
  try {
    choice = autoChoose(state, d, new Rng(hashString(`${state.id}:${d.id}:auto`)));
  } catch {
    choice = null;
  }
  if (!choice || (!choice.optionId && !choice.customText)) choice = Array.isArray(d.options) && d.options[0] ? { optionId: d.options[0].id } : { customText: '顺其自然' };
  let res = null;
  try {
    res = resolveOffline(data, world, state, d, choice, new Rng(hashString(`${state.id}:${d.id}:${JSON.stringify(choice)}`)));
  } catch {
    res = null;
  }
  if (!res) res = { narrative: '你做出了选择，日子照常往前走。', effects: { health: 0, happiness: 0, knowledge: 0, relationships: 0, wealthDelta: 0 }, set: {}, threads: [], feasible: true };
  const entries = applyResolution(data, world, state, d, choice, res);
  if (state.pending === d) state.pending = null;
  return entries;
}

/**
 * Simulate a whole life headless (offline engine + autoChoose) and return the final state.
 * opts.onYear(state, yearResult) is called after every year; opts.settings overrides HEADLESS_SETTINGS.
 */
export function simulateLife(data, world, birthSpec, seed, opts = {}) {
  const settings = { ...HEADLESS_SETTINGS, ...(isObj(opts.settings) ? opts.settings : {}), cohort: false };
  const state = newLife(data, world, birthSpec, settings, seed);
  const onYear = typeof opts.onYear === 'function' ? opts.onYear : null;
  let guard = 0;
  while (!state.dead && guard++ < 400) {
    if (state.pending) {
      autoResolve(data, world, state);
      continue;
    }
    const r = stepYear(data, world, state);
    if (onYear) onYear(state, r);
  }
  return state;
}

function uniq(arr) {
  return arr.filter((x, i) => x && arr.indexOf(x) === i);
}

function fateLine(data, state, titles, everUnion) {
  const p = state.person;
  const d = state.dead;
  const age = d ? d.age : state.age;
  const cause = d && d.cause ? d.cause.name : '';
  if (d && age < 5) return `${age < 1 ? '不满一岁' : `${age} 岁`}时因${cause}夭折。`;
  const parts = [];
  const lvl = p.education && p.education.level;
  const edu = { none: '没有上过学', preschool: '没有上过学', primary: '读到小学', secondary: '读完中学', vocational: '读过职业学校', tertiary: '读过大学', postgrad: '读到研究生' }[lvl];
  if (edu && age >= 18) parts.push(edu);
  const jobs = uniq(titles).slice(0, 2);
  if (jobs.length) parts.push(`做过${jobs.join('、')}`);
  else if (p.career && p.career.status === 'homemaker') parts.push('操持了一辈子家务');
  if (age >= 25) parts.push(everUnion ? '成过家' : '一生未婚');
  const kids = (p.children || []).filter((k) => k && k.alive !== false).length;
  if (kids) parts.push(`有${zhNum(Math.min(kids, 10))}个孩子`);
  const birthIso = state.birth && state.birth.country;
  if (p.country !== birthIso) parts.push(`后来在${safe(() => data.country(p.country).name) || p.country}生活`);
  const head = parts.join('，');
  if (!d) return head ? `${head}。` : '';
  return `${head ? `${head}；` : ''}${age} 岁时因${cause}离世。`;
}

/** Simulate one peer and compress the life into a Peer (CONTRACT §3). */
export function simulatePeer(data, world, birthSpec, seed) {
  const timeline = [];
  const titles = [];
  let last = '';
  let everUnion = false;
  const state = simulateLife(data, world, birthSpec, seed, {
    onYear(st) {
      const p = st.person;
      if (p.career && p.career.title && ['employed', 'self_employed'].includes(p.career.status)) titles.push(p.career.title);
      if (p.relationship && ['married', 'partnered', 'widowed', 'divorced'].includes(p.relationship.status)) everUnion = true;
      if (st.dead) return;
      const s = safe(() => statusLine(data, st), '');
      if (s && s !== last) {
        timeline.push({ year: st.year, status: s });
        last = s;
      }
    },
  });
  const b = state.birth;
  const d = state.dead;
  if (!timeline.length || timeline[0].year > b.year) timeline.unshift({ year: b.year, status: '出生' });
  if (d) timeline.push({ year: d.year, status: `离世（${d.cause.name}）` });
  return {
    name: b.name,
    sex: b.sex,
    country: b.country,
    urban: b.urban,
    familyPct: b.familyPct,
    birthYear: b.year,
    deathYear: d ? d.year : null,
    deathAge: d ? d.age : null,
    deathCause: d ? { id: d.cause.id, name: d.cause.name } : null,
    place: d ? d.place : state.person.country,
    timeline: timeline.slice(-40),
    fate: fateLine(data, state, titles, everUnion),
  };
}

/**
 * Peers born in the same second as birthSpec (CONTRACT §2): n defaults to a Poisson draw around the world's births
 * per second in that year, clamped to 3–6; countries by births weights, same date and time as the player.
 */
export function makeCohort(data, world, birthSpec, rng, n) {
  const spec = isObj(birthSpec) ? birthSpec : {};
  const R = rng && typeof rng.next === 'function' ? rng : new Rng(hashString(`cohort|${spec.date}|${spec.time}|${spec.country}`));
  const year = clampN(Math.round(isNum(spec.year) ? spec.year : 2000), 2000, 2070);
  const total = Number(safe(() => data.birthsWeights(year).total, 130000)) || 130000;
  const bps = (total * 1000) / SECONDS_PER_YEAR;
  const count = isNum(n) ? clampN(Math.round(n), 0, 12) : clampN(R.poisson(bps), 3, 6);
  const peers = [];
  for (let i = 0; i < count; i++) {
    const pr = R.fork(`peer:${i}`);
    try {
      const b = randomBirth(data, world, pr, { year });
      if (typeof spec.date === 'string' && spec.date.startsWith(String(year))) b.date = spec.date;
      if (typeof spec.time === 'string') b.time = spec.time;
      b.notes = [];
      peers.push(simulatePeer(data, world, b, hashString(`${spec.date}|${spec.time}|${i}|${pr.next()}`)));
    } catch {
      /* skip a peer that could not be simulated */
    }
  }
  return peers;
}

/**
 * What a peer is doing in a given year: {year, alive, age, status}. Before birth: alive false, status '尚未出生'.
 */
export function peerStatusAt(peer, year) {
  const y = Math.floor(Number(year));
  if (!isObj(peer) || !Number.isFinite(y)) return { year: y, alive: false, age: null, status: '' };
  const by = Number(peer.birthYear);
  if (Number.isFinite(by) && y < by) return { year: y, alive: false, age: null, status: '尚未出生' };
  const dy = peer.deathYear;
  const cause = peer.deathCause && typeof peer.deathCause === 'object' ? peer.deathCause.name : peer.deathCause;
  if (dy != null && Number.isFinite(Number(dy)) && y >= Number(dy)) {
    return { year: y, alive: false, age: isNum(peer.deathAge) ? peer.deathAge : y - by, status: y === Number(dy) ? `这一年离世${cause ? `（${cause}）` : ''}` : `已于 ${dy} 年离世` };
  }
  const tl = Array.isArray(peer.timeline) ? peer.timeline : [];
  let status = '';
  for (const t of tl) {
    if (!t || !(Number(t.year) <= y)) continue;
    if (/^离世/.test(String(t.status || ''))) continue;
    status = String(t.status || '');
  }
  return { year: y, alive: true, age: Number.isFinite(by) ? y - by : null, status: status || '还在生活着' };
}
