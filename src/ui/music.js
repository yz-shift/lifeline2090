// Gentle generative ambient soundtrack for the game screen (WebAudio only, no audio files).
// Soft detuned pads drift through pentatonic chords; sparse bell-like notes fall now and then through a small
// echo. Everything stays very quiet. The AudioContext is created only inside start(), which the caller invokes
// from a user gesture (browsers refuse audio before one). The music fades in and out instead of cutting, follows
// the game's play/pause through setPlaying(), and its colour follows the year's tone through setMood().
//
// createMusic(opts?) -> { start(), stop(), setPlaying(bool), setMood(mood), isOn(), isAvailable(), destroy() }
//   mood: a number -2..2 (a year's history `mood`) or 'bright' | 'warm' | 'calm' | 'low' | 'sad'

const MOODS = {
  '-2': { root: 45, scale: [0, 3, 5, 7, 10], cutoff: 900, pace: 1.35, bell: 0.55 },   // A minor pentatonic, dim
  '-1': { root: 50, scale: [0, 3, 5, 7, 10], cutoff: 1250, pace: 1.18, bell: 0.65 },  // D minor pentatonic
  0: { root: 48, scale: [0, 2, 4, 7, 9], cutoff: 1650, pace: 1, bell: 0.72 },          // C major pentatonic
  1: { root: 50, scale: [0, 2, 4, 7, 9], cutoff: 2100, pace: 0.92, bell: 0.8 },        // D major pentatonic
  2: { root: 52, scale: [0, 2, 4, 7, 9], cutoff: 2500, pace: 0.85, bell: 0.86 },       // E major pentatonic, bright
};
const NAMED = { sad: -2, low: -1, calm: 0, warm: 1, bright: 2 };
// the colour of each life stage: childhood rings like a music box, youth is quicker, old age slower and lower
const STAGES = {
  child: { pace: 0.85, bellOct: 1, bell: 1.35, box: true, padOct: 0 },
  youth: { pace: 0.9, bellOct: 1, bell: 1.1, box: false, padOct: 0 },
  adult: { pace: 1, bellOct: 1, bell: 1, box: false, padOct: 0 },
  elder: { pace: 1.25, bellOct: 0, bell: 0.75, box: false, padOct: -1 },
};
export function stageForAge(age) {
  const a = Number(age) || 0;
  return a < 13 ? 'child' : a < 30 ? 'youth' : a < 65 ? 'adult' : 'elder';
}
// chord shapes as scale degrees (pentatonic, so every shape is consonant)
const SHAPES = [[0, 2, 4], [0, 1, 3], [1, 3, 5], [0, 2, 5], [-1, 1, 3], [0, 3, 5]];

const LOOKAHEAD = 1.6;     // seconds of audio scheduled ahead
const TICK_MS = 280;
const MASTER = 0.32;       // overall level (voices are quiet on their own)
const FADE_IN = 2.6;
const FADE_OUT = 1.3;

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function moodKey(m) {
  if (typeof m === 'string') m = NAMED[m] ?? Number(m);
  const v = Math.round(Number(m));
  if (!Number.isFinite(v)) return 0;
  return Math.max(-2, Math.min(2, v));
}

/** Pitch of scale degree `deg` (may be negative or beyond the scale) above `root`. */
function degreeNote(mood, deg, octave = 0) {
  const sc = mood.scale;
  const n = sc.length;
  const o = Math.floor(deg / n);
  const i = ((deg % n) + n) % n;
  return mood.root + sc[i] + 12 * (o + octave);
}

export function createMusic(opts = {}) {
  const level = Number.isFinite(opts.volume) ? Math.max(0, Math.min(1, opts.volume)) : MASTER;
  const Ctx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
  let ctx = null;
  let nodes = null;
  let on = false;          // the player's music switch
  let playing = true;      // the game clock (paused / hidden / ended -> false)
  let audible = false;
  let timer = 0;
  let suspendTimer = 0;
  let moodK = 0;
  let nextChord = 0;
  let nextBell = 0;
  let lastShape = -1;
  let stageK = 'adult';

  function build() {
    if (nodes || !ctx) return nodes;
    const master = ctx.createGain();
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.ratio.value = 3;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = MOODS[moodK].cutoff;
    tone.Q.value = 0.4;
    // a soft echo: delay with filtered feedback, mixed in quietly
    const send = ctx.createGain();
    send.gain.value = 0.32;
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.46;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const fbTone = ctx.createBiquadFilter();
    fbTone.type = 'lowpass';
    fbTone.frequency.value = 1400;
    send.connect(delay);
    delay.connect(fbTone);
    fbTone.connect(fb);
    fb.connect(delay);
    fbTone.connect(tone);
    tone.connect(master);
    master.connect(comp);
    comp.connect(ctx.destination);
    nodes = { master, tone, send };
    return nodes;
  }

  function voice(freq, { type = 'sine', detune = 0, start, attack, hold, release, peak, sendAmt = 0.4 }) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(peak, start + attack);
    g.gain.setValueAtTime(peak, start + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, start + attack + hold + release);
    o.connect(g);
    g.connect(nodes.tone);
    if (sendAmt > 0) {
      const s = ctx.createGain();
      s.gain.value = sendAmt;
      g.connect(s);
      s.connect(nodes.send);
    }
    o.start(start);
    o.stop(start + attack + hold + release + 0.05);
    o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* already gone */ } };
  }

  function chordAt(t) {
    const mood = MOODS[moodK];
    let si;
    do { si = Math.floor(Math.random() * SHAPES.length); } while (si === lastShape && SHAPES.length > 1);
    lastShape = si;
    const st = STAGES[stageK];
    const len = rand(13, 17) * mood.pace * st.pace;
    const attack = rand(3.5, 5);
    const release = 5.5;
    for (const deg of SHAPES[si]) {
      const f = midiHz(degreeNote(mood, deg, st.padOct));
      voice(f, { type: 'sine', detune: -6, start: t, attack, hold: Math.max(1, len - attack), release, peak: 0.05, sendAmt: 0.25 });
      voice(f, { type: 'triangle', detune: 7, start: t + 0.08, attack, hold: Math.max(1, len - attack), release, peak: 0.026, sendAmt: 0.2 });
    }
    // a low root underneath every other chord
    if (Math.random() < 0.55) {
      voice(midiHz(degreeNote(mood, 0, -1)), { type: 'sine', start: t, attack: attack + 1, hold: Math.max(1, len - attack - 1), release, peak: 0.04, sendAmt: 0 });
    }
    return t + len;
  }

  function bellAt(t) {
    const mood = MOODS[moodK];
    const st = STAGES[stageK];
    if (Math.random() < Math.min(0.95, mood.bell * st.bell)) {
      const deg = Math.floor(rand(0, mood.scale.length * 2));
      const f = midiHz(degreeNote(mood, deg, st.bellOct));
      if (st.box) voice(f * 3, { type: 'sine', start: t, attack: 0.005, hold: 0.01, release: 0.9, peak: 0.01, sendAmt: 0.5 });
      const decay = rand(2.4, 4.2);
      voice(f, { type: 'sine', start: t, attack: 0.02, hold: 0.05, release: decay, peak: 0.07, sendAmt: 0.6 });
      voice(f * 2, { type: 'sine', start: t, attack: 0.01, hold: 0.02, release: decay * 0.45, peak: 0.012, sendAmt: 0.4 });
      if (Math.random() < 0.3) {
        const step = pick([1, 2, -1]);
        voice(midiHz(degreeNote(mood, deg + step, 1)), { type: 'sine', start: t + rand(0.28, 0.6), attack: 0.02, hold: 0.04, release: decay * 0.8, peak: 0.05, sendAmt: 0.6 });
      }
    }
    return t + rand(2.6, 6.2) * mood.pace * st.pace;
  }

  function schedule() {
    timer = 0;
    if (!audible || !ctx || !nodes) return;
    const horizon = ctx.currentTime + LOOKAHEAD;
    let guard = 0;
    while (nextChord < horizon && guard++ < 4) nextChord = chordAt(Math.max(nextChord, ctx.currentTime + 0.05));
    guard = 0;
    while (nextBell < horizon && guard++ < 6) nextBell = bellAt(Math.max(nextBell, ctx.currentTime + 0.05));
    timer = setTimeout(schedule, TICK_MS);
  }

  function update() {
    const want = on && playing && !!ctx;
    if (want === audible) return;
    audible = want;
    clearTimeout(suspendTimer);
    suspendTimer = 0;
    if (!ctx || !nodes) return;
    const g = nodes.master.gain;
    const t = ctx.currentTime;
    try { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); } catch { /* older engines */ }
    if (audible) {
      const resumed = ctx.state === 'suspended' ? ctx.resume() : null;
      if (resumed && typeof resumed.then === 'function') resumed.then(null, () => {});
      g.linearRampToValueAtTime(level, t + FADE_IN);
      nextChord = Math.max(nextChord, t + 0.1);
      nextBell = Math.max(nextBell, t + rand(1.5, 3));
      if (!timer) schedule();
    } else {
      g.linearRampToValueAtTime(0, t + FADE_OUT);
      clearTimeout(timer);
      timer = 0;
      // let the fade finish, then suspend the context so nothing keeps running in the background
      suspendTimer = setTimeout(() => {
        suspendTimer = 0;
        if (!audible && ctx && ctx.state === 'running') {
          const p = ctx.suspend();
          if (p && typeof p.then === 'function') p.then(null, () => {});
        }
        nextChord = 0;
        nextBell = 0;
      }, FADE_OUT * 1000 + 250);
    }
  }

  return {
    /** Turn the music on. Call from a user gesture (click / key) the first time. Returns false if unsupported. */
    start() {
      if (!Ctx) return false;
      if (!ctx) {
        try { ctx = new Ctx(); } catch { ctx = null; return false; }
        build();
      }
      on = true;
      if (ctx.state === 'suspended' && playing) {
        const p = ctx.resume();
        if (p && typeof p.then === 'function') p.then(null, () => {});
      }
      update();
      if (!audible && ctx.state === 'running') {
        // switched on while the game is paused: stay silent and idle until play resumes
        const p = ctx.suspend();
        if (p && typeof p.then === 'function') p.then(null, () => {});
      }
      return true;
    },
    /** Turn the music off (fades out). */
    stop() {
      on = false;
      update();
    },
    /** Follow the game clock: false fades out and suspends, true fades back in (if the music is on). */
    setPlaying(v) {
      playing = !!v;
      update();
    },
    /** Year tone -2..2 (or a mood name): key, brightness and pace follow from the next chord. */
    setMood(m) {
      const k = moodKey(m);
      if (k === moodK) return;
      moodK = k;
      if (ctx && nodes) {
        try { nodes.tone.frequency.setTargetAtTime(MOODS[k].cutoff, ctx.currentTime, 2.5); } catch { /* ignore */ }
      }
    },
    /** Life stage ('child' | 'youth' | 'adult' | 'elder', or an age): timbre, register and pace. */
    setStage(stage) {
      const k = typeof stage === 'number' ? stageForAge(stage) : STAGES[stage] ? stage : 'adult';
      stageK = k;
    },
    /** A short motif for a moment: 'birth' (rising), 'decision' (two soft notes), 'death' (falling, slow). */
    motif(kind) {
      if (!audible || !ctx || !nodes) return;
      const mood = MOODS[moodK];
      const t = ctx.currentTime + 0.05;
      const seq = kind === 'birth' ? [0, 2, 4, 7] : kind === 'decision' ? [4, 2] : kind === 'death' ? [7, 4, 2, 0, -3] : [];
      const gap = kind === 'death' ? 0.9 : kind === 'birth' ? 0.32 : 0.45;
      seq.forEach((deg, i) => {
        const f = midiHz(degreeNote(mood, deg, kind === 'death' ? 0 : 1));
        voice(f, { type: 'sine', start: t + i * gap, attack: 0.02, hold: 0.06, release: kind === 'death' ? 5 : 2.6, peak: 0.06, sendAmt: 0.55 });
      });
    },
    isOn() { return on; },
    isAvailable() { return !!Ctx; },
    destroy() {
      on = false;
      audible = false;
      clearTimeout(timer);
      clearTimeout(suspendTimer);
      timer = 0;
      if (ctx) {
        const c = ctx;
        ctx = null;
        nodes = null;
        try {
          const p = c.close();
          if (p && typeof p.then === 'function') p.then(null, () => {});
        } catch { /* ignore */ }
      }
    },
  };
}
