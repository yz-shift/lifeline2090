// The player's card collection (成就卡片), kept only in this browser under STORAGE_KEYS.stats.
// Shape: { v:1, lives, sexes:[], countries:[ISO3], regions:[], seen:[lifeId] (last SEEN_MAX),
//          cards: { [cardId]: { at: ISO date, n: times earned, life: { name, by, country, age } } } }
// recordLife() is idempotent per life: a life counts once, but is looked at again later (a final sentence written
// after death can still earn its card). Imported data is untrusted and validated like saves.js does.

import { storage } from '../ui/dom.js';
import { STORAGE_KEYS } from '../core/constants.js';
import { ACHIEVEMENTS, achievementDef, evaluateLife, evaluateMeta } from '../core/achievements.js';

const KEY = STORAGE_KEYS.stats;
const SEEN_MAX = 400;
const ISO_RE = /^[A-Z]{3}$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
const uniq = (list, ok, max) => [...new Set((Array.isArray(list) ? list : []).filter(ok))].slice(0, max);

function cleanLife(l) {
  if (!isObj(l)) return null;
  return { name: str(l.name, 40), by: int(l.by, 1800, 2200, null), country: ISO_RE.test(l.country) ? l.country : '', age: int(l.age, 0, 130, null) };
}

/** Validated copy of a stored or imported collection. */
export function sanitizeCollection(raw) {
  const r = isObj(raw) ? raw : {};
  const cards = {};
  if (isObj(r.cards)) {
    for (const [id, c] of Object.entries(r.cards)) {
      if (!achievementDef(id) || !isObj(c)) continue;
      const at = typeof c.at === 'string' && !Number.isNaN(Date.parse(c.at)) ? c.at.slice(0, 30) : '';
      cards[id] = { at, n: int(c.n, 1, 1e6, 1), life: cleanLife(c.life) };
    }
  }
  return {
    v: 1,
    lives: int(r.lives, 0, 1e6, 0),
    sexes: uniq(r.sexes, (x) => x === 'male' || x === 'female', 2),
    countries: uniq(r.countries, (x) => typeof x === 'string' && ISO_RE.test(x), 300),
    regions: uniq(r.regions, (x) => typeof x === 'string' && /^[A-Z]{3}$/.test(x), 20),
    seen: uniq(r.seen, (x) => typeof x === 'string' && x.length <= 80, SEEN_MAX),
    cards,
  };
}

export function readCollection() {
  return sanitizeCollection(storage.get(KEY, null));
}

function write(col) {
  return storage.set(KEY, col);
}

function metaOf(col) {
  return { lives: col.lives, sexes: col.sexes, countries: col.countries, regions: col.regions, cardCount: Object.keys(col.cards).length };
}

function grant(col, id, life, now, fresh) {
  const c = col.cards[id];
  if (c) { c.n += 1; return; }
  col.cards[id] = { at: now, n: 1, life };
  fresh.push(id);
}

/**
 * Count a finished life and collect its cards.
 * @param state  finished LifeState (state.dead set)
 * @param opts   { regionOf?(iso3) -> region code, now?: ISO string }
 * @returns {{ fresh: string[], earned: string[], col }}  fresh = cards earned for the first time (catalog order)
 */
export function recordLife(state, opts = {}) {
  const col = readCollection();
  if (!isObj(state) || !state.dead) return { fresh: [], earned: [], col };
  const now = typeof opts.now === 'string' ? opts.now : new Date().toISOString();
  const b = isObj(state.birth) ? state.birth : {};
  const p = isObj(state.person) ? state.person : {};
  const life = cleanLife({ name: p.name || b.name, by: b.year, country: b.country, age: state.dead.age ?? state.age });
  const id = typeof state.id === 'string' ? state.id.slice(0, 80) : '';
  const first = !id || !col.seen.includes(id);
  const fresh = [];
  const earned = evaluateLife(state);
  if (first) {
    col.lives += 1;
    if (id) col.seen = [...col.seen, id].slice(-SEEN_MAX);
    const sex = p.sex || b.sex;
    if ((sex === 'male' || sex === 'female') && !col.sexes.includes(sex)) col.sexes.push(sex);
    if (b.country && ISO_RE.test(b.country) && !col.countries.includes(b.country)) col.countries.push(b.country);
    const reg = typeof opts.regionOf === 'function' ? opts.regionOf(b.country) : null;
    if (reg && /^[A-Z]{3}$/.test(reg) && !col.regions.includes(reg)) col.regions.push(reg);
    for (const cid of earned) grant(col, cid, life, now, fresh);
  } else {
    // seen before: only cards this life had not yet earned (e.g. the final sentence written afterwards)
    for (const cid of earned) if (!col.cards[cid]) grant(col, cid, life, now, fresh);
  }
  // collection cards; "collector" counts may unlock each other, so evaluate until nothing changes
  for (let i = 0; i < 3; i++) {
    const before = fresh.length;
    for (const cid of evaluateMeta(metaOf(col))) if (!col.cards[cid]) grant(col, cid, life, now, fresh);
    if (fresh.length === before) break;
  }
  write(col);
  const order = new Map(ACHIEVEMENTS.map((a, i) => [a.id, i]));
  fresh.sort((x, y) => order.get(x) - order.get(y));
  return { fresh, earned, col };
}

/** Catalog joined with what this player has: [{...def, got: {at, n, life}|null}]. */
export function collectionView(col = readCollection()) {
  return ACHIEVEMENTS.map((a) => ({ ...a, got: col.cards[a.id] || null }));
}

/** Merge an imported collection (from a backup file) into this browser's one. Returns the number of new cards. */
export function mergeCollection(raw) {
  if (!isObj(raw)) return 0;
  const inc = sanitizeCollection(raw);
  const col = readCollection();
  let added = 0;
  for (const [id, c] of Object.entries(inc.cards)) {
    const own = col.cards[id];
    if (!own) { col.cards[id] = c; added += 1; continue; }
    own.n = Math.max(own.n, c.n);
    if (c.at && (!own.at || c.at < own.at)) { own.at = c.at; own.life = c.life; }
  }
  col.lives = Math.max(col.lives, inc.lives);
  for (const k of ['sexes', 'countries', 'regions']) col[k] = [...new Set([...col[k], ...inc[k]])];
  col.seen = [...new Set([...col.seen, ...inc.seen])].slice(-SEEN_MAX);
  write(sanitizeCollection(col));
  return added;
}
