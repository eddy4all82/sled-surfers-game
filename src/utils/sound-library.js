/**
 * SoundLibrary — pool of SFX clips per event, backed by the Web Audio API.
 *
 * ─────────────────────────────────────────────────────────────────
 * WHY WEB AUDIO (vs HTMLAudioElement)
 * ─────────────────────────────────────────────────────────────────
 * On mobile (iOS Safari, mobile Chrome) HTMLAudioElement.play() has
 * 200–500 ms first-call latency even after preload, because the
 * system media session has to warm up. Web Audio API plays decoded
 * AudioBuffers via AudioBufferSourceNode with sub-10 ms latency on
 * every platform. Multiple instances of the same buffer can play
 * simultaneously without any pool/clone management.
 *
 * ─────────────────────────────────────────────────────────────────
 * HOW TO ADD A NEW EVENT
 * ─────────────────────────────────────────────────────────────────
 * 1.  Drop your audio files (.mp3 / .ogg / .wav / .m4a) into the
 *     project's `public/audio/` folder.
 * 2.  Add an entry to SOUND_EVENTS below — pick any unique event name
 *     and list the file paths you want in the pool. Files MUST start
 *     with `/audio/` (the public-folder root).
 *
 *       SOUND_EVENTS.coin_pickup = [
 *         '/audio/coin1.mp3',
 *         '/audio/coin2.mp3',
 *       ];
 *
 * 3.  Trigger the event from game code wherever the action happens:
 *
 *       this.sounds.play('coin_pickup');
 *
 *     The library picks one path at random from the pool and plays it.
 *
 * ─────────────────────────────────────────────────────────────────
 * BACKGROUND-MUSIC DUCKING (per event, OFF by default)
 * ─────────────────────────────────────────────────────────────────
 * To make a specific event temporarily lower the music while it
 * plays, add an entry to EVENT_DUCK below:
 *
 *   EVENT_DUCK.drone_alert = { to: 0.15, durationMs: 1500 };
 *
 * If a second ducking event fires while one is active, the dip is
 * RE-EXTENDED for the new duration (not stacked).
 *
 * ─────────────────────────────────────────────────────────────────
 * EXISTING EVENTS
 *
 *   game_start    — fired the moment PLAY is pressed
 *   coin_pickup   — fired when the player collects a coin
 *   jump          — fired on a single-jump press
 *   double_jump   — fired on the second jump (double-jump)
 *   parachute     — fired when the parachute opens
 *   ramp_launch   — fired when the player launches off a jump ramp
 *   crash         — fired in _die() when the player explodes
 *   crash_lamp    — variant played when the killer was a lamp
 *   crash_tree    — variant played when the killer was a tree
 *   crash_rock    — variant played when the killer was a rock
 *   crash_car     — variant played when the killer was a car
 *   drone_alert   — fired when a drone batch spawns nearby
 *   drone_approch — fired 1.5 s after drone_alert (chained)
 *   speed_up      — fired on a speed-bump milestone
 *   win           — fired when the player crosses the finish line
 * ─────────────────────────────────────────────────────────────────
 */

// Each event is either a string[] (legacy: pool of file paths) or
// { files, gain, active }:
//
//   files  — string[] of paths in the random pool
//   gain   — per-event volume multiplier (1.0 = no change). Use to
//            compensate for clips mastered louder/quieter than the
//            rest of the library, without re-encoding source files.
//              0.7 = trim a loud clip
//              1.6 = boost a quiet voice clip
//   active — boolean (default true). When false, play() is a no-op
//            for this event — quick way to mute one trigger without
//            touching its callsites.
//
// Per-call opts.volume in play() multiplies on top of `gain`.
export const SOUND_EVENTS = {
  // Voice barks tend to be ~6 dB quieter than mastered SFX.
  game_start:  { active: true, gain: 1.6, files: [
    '/audio/new1.m4a',
    '/audio/estorha.m4a',
    '/audio/halhala.m4a',
    '/audio/weal.m4a',
  ]},
  coin_pickup:   { active: true, gain: 1.0, files: ['/audio/coin.mp3?v=2'] },
  jump:          { active: true, gain: 1.0, files: ['/audio/jump.mp3'] },
  double_jump:   { active: true, gain: 1.0, files: [] },
  parachute:     { active: true, gain: 0.9, files: ['/audio/parachute.mp3'] },
  ramp_launch:   { active: true, gain: 0.85, files: ['/audio/ramp.mp3'] },
  crash:         { active: true, gain: 1.0, files: ['/audio/crash.mp3'] },
  crash_lamp:    { active: true, gain: 1.0, files: [] },
  crash_tree:    { active: true, gain: 1.0, files: [] },
  crash_rock:    { active: true, gain: 1.0, files: [] },
  crash_car:     { active: true, gain: 1.0, files: [] },
  drone_alert:   { active: true, gain: 1.3, files: ['/audio/rocket1.m4a'] },
  drone_approch: { active: true, gain: 1.5, files: [
    '/audio/close-drone.mp3',
    '/audio/asrfha.m4a',
    '/audio/fake.m4a',
    '/audio/rocket2.m4a',
    '/audio/elhakona.m4a',
  ]},
  car_approach:  { active: true, gain: 1.2, files: ['/audio/close-car.mp3'] },
  landing:       { active: true, gain: 1.0, files: ['/audio/landing.mp3'] },
  sled:          { active: true, gain: 0.7, files: ['/audio/snow-slide.mp3'] },
  speed_up:      { active: true, gain: 0.85, files: ['/audio/yahoo.mp3'] },
  win:           { active: true, gain: 1.0, files: [] },
};

export const EVENT_DUCK = {
  drone_alert:   { to: 0.15, durationMs: 1500 },
  drone_approch: { to: 0.15, durationMs: 2000 },
  // Game-feel ducks: short dips so important moments cut through music.
  // Re-triggers extend rather than stack, so rapid jumps don't pulse weirdly.
  crash:         { to: 0.25, durationMs: 1200 },
  win:           { to: 0.20, durationMs: 3000 },
  ramp_launch:   { to: 0.50, durationMs: 600 },
  parachute:     { to: 0.60, durationMs: 800 },
};

export class SoundLibrary {
  constructor(eventMap = SOUND_EVENTS, opts = {}) {
    this._ctx = null;                        // AudioContext (lazy)
    this._destinationGain = null;            // master gain node
    this._buffers = new Map();               // path → AudioBuffer
    this._loadPromises = new Map();          // path → Promise<AudioBuffer|null>
    this._unlocked = false;
    this._events = {};
    this._enabled = opts.enabled !== false;
    this._volume  = typeof opts.volume === 'number' ? clamp(opts.volume, 0, 1) : 1.0;
    this._duck = {};
    const duckMap = opts.duckMap || EVENT_DUCK;
    for (const [name, cfg] of Object.entries(duckMap)) {
      if (cfg) this._duck[name] = { to: cfg.to ?? 0.2, durationMs: cfg.durationMs ?? 1500 };
    }
    this._onDuck = typeof opts.onDuck === 'function' ? opts.onDuck : null;
    for (const [name, entry] of Object.entries(eventMap)) {
      this._events[name] = normalizeEntry(entry);
    }
  }

  // ── AudioContext lifecycle ────────────────────────────────

  /**
   * Construct the AudioContext (must be called inside a user gesture
   * on iOS to be allowed to start). Idempotent.
   */
  _ensureContext() {
    if (this._ctx) return this._ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      this._ctx = new AC();
      this._destinationGain = this._ctx.createGain();
      this._destinationGain.gain.value = this._volume;
      // Master limiter: tames overlapping SFX bursts so the summed signal
      // stops clipping when several events fire at once. Threshold/ratio
      // are intentionally gentle — keeps single-shot punch, only kicks in
      // on dense moments (coin chains, crash + sled + drone alert, etc).
      this._limiter = this._ctx.createDynamicsCompressor();
      this._limiter.threshold.value = -12;
      this._limiter.knee.value = 6;
      this._limiter.ratio.value = 6;
      this._limiter.attack.value = 0.003;
      this._limiter.release.value = 0.1;
      this._destinationGain.connect(this._limiter).connect(this._ctx.destination);
    } catch (e) {
      this._ctx = null;
    }
    return this._ctx;
  }

  /**
   * Unlock audio playback inside a user gesture (PLAY button click).
   * Resumes a suspended context and plays a silent buffer to convince
   * iOS the user really wants audio. Must run before play() works.
   */
  unlock() {
    if (this._unlocked) return;
    this._unlocked = true;
    const ctx = this._ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      try { ctx.resume(); } catch (e) { /* ignore */ }
    }
    // Play 1 silent sample to fully unlock iOS audio output
    try {
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch (e) { /* ignore */ }
  }

  // ── Public API ─────────────────────────────────────────────

  play(eventName, opts = {}) {
    if (!this._enabled) return null;
    const entry = this._events[eventName];
    if (!entry || !entry.files || entry.files.length === 0) return null;
    // Per-event active flag — false silences this trigger entirely.
    if (entry.active === false) return null;
    const ctx = this._ctx;
    if (!ctx) return null;
    const path = entry.files[Math.floor(Math.random() * entry.files.length)];
    const buffer = this._buffers.get(path);
    if (!buffer) {
      // Buffer wasn't preloaded — fire a load but skip THIS playback
      // rather than pop in late once it arrives.
      this._loadBuffer(path);
      return null;
    }
    let source;
    try {
      source = ctx.createBufferSource();
      source.buffer = buffer;
      // Per-event gain × per-call opts.volume. Skip the gain node entirely
      // when both are 1.0 to keep the graph minimal.
      const callV = typeof opts.volume === 'number' ? clamp(opts.volume, 0, 4) : 1.0;
      const eventGain = typeof entry.gain === 'number' ? entry.gain : 1.0;
      const v = callV * eventGain;
      if (v !== 1.0) {
        const g = ctx.createGain();
        g.gain.value = v;
        source.connect(g).connect(this._destinationGain);
      } else {
        source.connect(this._destinationGain);
      }
      source.start(0);
    } catch (e) {
      return null;
    }
    // Fire duck hook
    const duckCfg = this._duck[eventName];
    if (duckCfg && this._onDuck) this._onDuck(duckCfg);
    return source;
  }

  /** Add a sound to an event pool. Creates the event if it doesn't exist. */
  addSound(eventName, path) {
    if (!this._events[eventName]) this._events[eventName] = { files: [], gain: 1.0 };
    this._events[eventName].files.push(path);
    if (this._ctx) this._loadBuffer(path);
  }

  removeSound(eventName, path) {
    const entry = this._events[eventName];
    if (!entry) return;
    const idx = entry.files.indexOf(path);
    if (idx >= 0) entry.files.splice(idx, 1);
  }

  setEvent(eventName, entry) {
    const norm = normalizeEntry(entry);
    this._events[eventName] = norm;
    if (this._ctx) for (const p of norm.files) this._loadBuffer(p);
  }

  /** Set just the per-event gain (volume multiplier) without touching the file pool. */
  setEventGain(eventName, gain) {
    const entry = this._events[eventName];
    if (!entry) return;
    entry.gain = typeof gain === 'number' ? gain : 1.0;
  }

  /** Toggle a single event on/off. Inactive events silently skip play(). */
  setEventActive(eventName, on) {
    const entry = this._events[eventName];
    if (!entry) return;
    entry.active = !!on;
  }
  isEventActive(eventName) {
    const entry = this._events[eventName];
    return !!(entry && entry.active !== false);
  }

  getSounds(eventName) {
    const entry = this._events[eventName];
    return entry ? entry.files.slice() : [];
  }
  listEvents() { return Object.keys(this._events); }

  setVolume(v) {
    this._volume = clamp(v, 0, 1);
    if (this._destinationGain) this._destinationGain.gain.value = this._volume;
  }

  setEnabled(on) { this._enabled = !!on; }

  /** Stop in-flight playback by suspending the context briefly. */
  stopAll() {
    if (this._ctx) {
      try { this._ctx.suspend().then(() => this._ctx.resume()); } catch (e) {}
    }
  }

  setDuck(eventName, cfg) {
    if (!cfg) { delete this._duck[eventName]; return; }
    this._duck[eventName] = { to: cfg.to ?? 0.2, durationMs: cfg.durationMs ?? 1500 };
  }
  getDuck(eventName) { return this._duck[eventName] || null; }

  /**
   * Decode every audio file used by any event into AudioBuffers. Calling
   * this from the loading screen guarantees that the FIRST play() after
   * PLAY is sub-10ms on every platform — no fetch, no decode, just
   * hand a ready buffer to a fresh source node.
   *
   * Returns { total, ready, failed }.
   */
  preloadAll(opts = {}) {
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    // Make sure context exists — needed for decodeAudioData. If we're
    // pre-PLAY (no user gesture yet) the context will be 'suspended' on
    // iOS, but decodeAudioData still works. unlock() resumes it later.
    this._ensureContext();
    const allPaths = new Set();
    for (const entry of Object.values(this._events)) {
      for (const p of entry.files) allPaths.add(p);
    }
    const paths = [...allPaths];
    const total = paths.length;
    let done = 0, failed = 0;
    const tick = () => onProgress && onProgress({ done, total, failed });
    tick();
    return Promise.all(paths.map((p) =>
      this._loadBuffer(p).then((buf) => {
        if (!buf) failed++;
        done++; tick();
      }),
    )).then(() => ({ total, ready: total - failed, failed }));
  }

  // ── Internals ──────────────────────────────────────────────

  _loadBuffer(path) {
    if (this._buffers.has(path)) return Promise.resolve(this._buffers.get(path));
    if (this._loadPromises.has(path)) return this._loadPromises.get(path);
    const ctx = this._ensureContext();
    if (!ctx) return Promise.resolve(null);
    const promise = fetch(path, { cache: 'force-cache' })
      .then((r) => {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.arrayBuffer();
      })
      // Use the callback form for Safari/iOS compatibility — older WebKit
      // doesn't support the promise form of decodeAudioData.
      .then((arrayBuffer) => new Promise((resolve, reject) => {
        try {
          const ret = ctx.decodeAudioData(arrayBuffer, resolve, reject);
          if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
        } catch (e) { reject(e); }
      }))
      .then((buf) => { this._buffers.set(path, buf); return buf; })
      .catch(() => null);
    this._loadPromises.set(path, promise);
    return promise;
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Accept legacy array shape OR { files, gain, active }; always store
// the expanded form so play()/preloadAll() have one path to read from.
function normalizeEntry(entry) {
  if (!entry) return { files: [], gain: 1.0, active: true };
  if (Array.isArray(entry)) return { files: entry.slice(), gain: 1.0, active: true };
  return {
    files:  Array.isArray(entry.files) ? entry.files.slice() : [],
    gain:   typeof entry.gain === 'number' ? entry.gain : 1.0,
    active: entry.active !== false,
  };
}
