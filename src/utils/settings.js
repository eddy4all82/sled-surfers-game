/**
 * Persistent user settings — backed by localStorage.
 *
 *   const s = loadSettings();
 *   saveSettings({ ...s, musicVolume: 0.3 });
 *
 * Always returns a complete object; missing fields are filled from DEFAULTS.
 */

const STORAGE_KEY = 'sledSurfers.settings.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  // Audio
  musicVolume:    0.55,    // 0..1
  musicEnabled:   true,
  sfxEnabled:     true,    // applies to future sound-library SFX

  // Controls
  swapLR:         false,   // when true, left key moves right and vice versa
  keys: {                  // list of accepted KeyboardEvent.key values per action
    left:  ['ArrowLeft',  'a', 'A'],
    right: ['ArrowRight', 'd', 'D'],
    jump:  ['ArrowUp',    'w', 'W', ' '],
    duck:  ['ArrowDown',  's', 'S'],
  },

  // Camera
  firstPerson:    false,
  cameraDistance: 1.0,     // scale of 3rd-person chase distance (0.5 .. 2.0)

  // Mobile touch scheme — only visible/applicable on touch devices.
  //   'tap'   — quick tap = jump, tap-and-hold = double jump (default)
  //   'swipe' — vertical swipe-up = jump, swipe-up + hold = double jump
  //   'hold'  — finger hold (~150 ms) = jump, vertical swipe-up = double jump
  touchScheme:    'tap',
});

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaults();
    const parsed = JSON.parse(raw);
    return mergeWithDefaults(parsed);
  } catch (e) {
    return cloneDefaults();
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mergeWithDefaults(s)));
  } catch (e) { /* private window / quota — ignore */ }
}

export function resetSettings() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  return cloneDefaults();
}

function cloneDefaults() {
  return {
    ...DEFAULT_SETTINGS,
    keys: {
      left:  DEFAULT_SETTINGS.keys.left.slice(),
      right: DEFAULT_SETTINGS.keys.right.slice(),
      jump:  DEFAULT_SETTINGS.keys.jump.slice(),
      duck:  DEFAULT_SETTINGS.keys.duck.slice(),
    },
  };
}

function mergeWithDefaults(p) {
  const out = cloneDefaults();
  if (typeof p.musicVolume === 'number')    out.musicVolume    = clamp(p.musicVolume, 0, 1);
  if (typeof p.musicEnabled === 'boolean')  out.musicEnabled   = p.musicEnabled;
  if (typeof p.sfxEnabled === 'boolean')    out.sfxEnabled     = p.sfxEnabled;
  if (typeof p.swapLR === 'boolean')        out.swapLR         = p.swapLR;
  if (typeof p.firstPerson === 'boolean')   out.firstPerson    = p.firstPerson;
  if (typeof p.cameraDistance === 'number') out.cameraDistance = clamp(p.cameraDistance, 0.5, 2.0);
  if (p.touchScheme === 'tap' || p.touchScheme === 'swipe' || p.touchScheme === 'hold') {
    out.touchScheme = p.touchScheme;
  }
  if (p.keys && typeof p.keys === 'object') {
    for (const action of ['left', 'right', 'jump', 'duck']) {
      if (Array.isArray(p.keys[action]) && p.keys[action].length > 0) {
        out.keys[action] = p.keys[action].slice();
      }
    }
  }
  return out;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
