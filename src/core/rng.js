// Seeded, serialisable PRNG (sfc32) and sampling helpers. Every random draw in the simulation goes through an Rng
// so a life can be saved and resumed exactly. Never use Math.random() inside core/.

export function hashString(str) {
  // cyrb53-style 32-bit hash for deriving seeds from strings
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

export class Rng {
  /** @param {number|string|number[]} seed  number, string, or a saved state array from .state() */
  constructor(seed = 1) {
    if (Array.isArray(seed)) {
      [this.a, this.b, this.c, this.d] = seed.map((x) => x >>> 0);
      return;
    }
    const s = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
    this.a = 0x9e3779b9; this.b = 0x243f6a88; this.c = 0xb7e15162; this.d = s;
    for (let i = 0; i < 15; i++) this.next();
  }
  /** @returns {number} uniform float in [0,1) */
  next() {
    let { a, b, c, d } = this;
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return (r >>> 0) / 4294967296;
  }
  state() { return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0]; }
  /** derive an independent child generator (e.g. per subsystem or per peer) */
  fork(label = '') { return new Rng(hashString(label + ':' + this.state().join(','))); }
  float(min = 0, max = 1) { return min + (max - min) * this.next(); }
  int(min, max) { return Math.floor(this.float(min, max + 1)); } // inclusive
  chance(p) { return this.next() < p; }
  pick(arr) { return arr.length ? arr[Math.floor(this.next() * arr.length)] : undefined; }
  /** weighted pick: items array + weight function or weights array */
  weighted(items, weights) {
    const w = typeof weights === 'function' ? items.map(weights) : weights;
    let total = 0;
    for (const x of w) total += Math.max(0, x || 0);
    if (total <= 0) return undefined;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= Math.max(0, w[i] || 0);
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  }
  normal(mean = 0, sd = 1) {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  poisson(lambda) {
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= this.next(); } while (p > L);
    return k - 1;
  }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

/** Fresh non-deterministic seed for a new life (UI layer only). */
export function newSeed() {
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] >>> 0;
  } catch {
    return (Date.now() ^ (performance.now() * 1000)) >>> 0;
  }
}
