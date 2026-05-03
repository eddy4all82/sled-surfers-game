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

export const SOUND_EVENTS = {
  game_start:  [
    '/audio/new1.m4a',
    '/audio/estorha.m4a',
    '/audio/halhala.m4a',
    '/audio/weal.m4a',
  ],
  coin_pickup: [
    '/audio/coin.mp3?v=2',
  ],
  jump:        ['/audio/jump.mp3'],
  double_jump: [],
  parachute:   ['/audio/parachute.mp3'],
  ramp_launch: ['/audio/ramp.mp3'],
  crash:       ['/audio/crash.mp3'],
  crash_lamp:  [],
  crash_tree:  [],
  crash_rock:  [],
  crash_car:   [],
  drone_alert:   ['/audio/rocket1.m4a'],
  drone_approch: [
    '/audio/close-drone.mp3',
    '/audio/asrfha.m4a',
    '/audio/fake.m4a',
    '/audio/rocket2.m4a',
    '/audio/elhakona.m4a',
  ],
  car_approach: [
    '/audio/close-car.mp3',
  ],
  landing: [
    '/audio/landing.mp3',
  ],
  sled: [
    '/audio/snow-slide.mp3',
  ],
  speed_up:    ['/audio/yahoo.mp3'],
  win:         [],
};

export const EVENT_DUCK = {
  game_start:    { to: 0.15, durationMs: 4000 },
  drone_alert:   { to: 0.15, durationMs: 1500 },
  drone_approch: { to: 0.15, durationMs: 2000 },
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
    for (const [name, paths] of Object.entries(eventMap)) {
      this._events[name] = (paths || []).slice();
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
    const list = this._events[eventName];
    if (!list || list.length === 0) return null;
    const ctx = this._ctx;
    if (!ctx) return null;
    const path = list[Math.floor(Math.random() * list.length)];
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
      const v = typeof opts.volume === 'number' ? clamp(opts.volume, 0, 1) : 1.0;
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
    if (!this._events[eventName]) this._events[eventName] = [];
    this._events[eventName].push(path);
    if (this._ctx) this._loadBuffer(path);
  }

  removeSound(eventName, path) {
    const list = this._events[eventName];
    if (!list) return;
    const idx = list.indexOf(path);
    if (idx >= 0) list.splice(idx, 1);
  }

  setEvent(eventName, paths) {
    this._events[eventName] = (paths || []).slice();
    if (this._ctx) for (const p of this._events[eventName]) this._loadBuffer(p);
  }

  getSounds(eventName) { return (this._events[eventName] || []).slice(); }
  listEvents()         { return Object.keys(this._events); }

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
    for (const list of Object.values(this._events)) {
      for (const p of list) allPaths.add(p);
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
