/**
 * MapGenerator — produces a deterministic course layout as pure data.
 *
 * The generator emits a flat array of CHUNKS describing the level from
 * Z=0 up to Z=COURSE_LENGTH. Each chunk lists the obstacles, scenery,
 * collectibles and special features that belong to it. The renderer is
 * responsible for instantiating Three.js meshes from this data.
 *
 * Randomness is fully seeded (mulberry32) so the same seed reproduces
 * the same map. Use `generateMap({ seed, courseLength })`.
 */

// ─── Public constants ──────────────────────────────────────────

export const CHUNK_LENGTH = 50;            // every chunk spans 50 units of Z
export const DEFAULT_COURSE_LENGTH = 2000; // 0..COURSE_LENGTH world units

// Biome thresholds
export const BIOME_SNOW_END = 600;
export const BIOME_CITY_END = 1200;

// Mountain-split exclusion: minimum gap (in units) between two splits
const MIN_MOUNTAIN_SPLIT_GAP = 300;
// Train exclusion vs Mountain split (in units)
const MIN_TRAIN_NEAR_MOUNTAIN = 100;
// Length of the special finale stretch
const FINALE_LENGTH = 100;
// Length of the easy intro stretch
const INTRO_LENGTH = 100;

// Chunk-type weights as listed in the design spec
export const CHUNK_WEIGHTS = [
  ['OPEN_SNOW',      15],
  ['CITY_BLOCK',     12],
  ['FOREST',         10],
  ['LAKE_CROSSING',   6],
  ['MOUNTAIN_SPLIT',  8],
  ['TRAIN_CROSSING',  5],
  ['CANYON',          5],
  ['BRIDGE',          4],
  ['VILLAGE',         5],
  // FINALE_APPROACH not in the random pool — placed deterministically
];

// ─── Seeded RNG ────────────────────────────────────────────────

/** Returns a function () → [0, 1). Same seed → same stream. */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate a fresh seed (32-bit unsigned int). */
export function randomSeed() {
  return Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
}

function pick(rng, items) {
  return items[Math.floor(rng() * items.length)];
}
function range(rng, min, max) {
  return min + rng() * (max - min);
}
function rangeInt(rng, min, maxInclusive) {
  return Math.floor(min + rng() * (maxInclusive - min + 1));
}
function chance(rng, p) { return rng() < p; }

// Weighted pick with optional filter (items whose name is rejected get skipped)
function pickWeighted(rng, weights, reject) {
  let total = 0;
  for (const [name, w] of weights) {
    if (reject && reject(name)) continue;
    total += w;
  }
  if (total <= 0) return weights[0][0];
  let roll = rng() * total;
  for (const [name, w] of weights) {
    if (reject && reject(name)) continue;
    roll -= w;
    if (roll <= 0) return name;
  }
  return weights[weights.length - 1][0];
}

// ─── Biome helpers ─────────────────────────────────────────────

export function biomeForZ(z) {
  if (z < BIOME_SNOW_END) return 'snow';
  if (z < BIOME_CITY_END) return 'city';
  return 'tropical';
}

const BIOME_PALETTES = {
  snow: {
    buildings:  [0x4A90D9, 0x7ECFB3, 0xB5651D, 0xC0392B, 0xE6A23C, 0x9aa0a6],
    treeKind:   'pine',
    rockTint:   0x8B4513,
  },
  city: {
    buildings:  [0x4A90D9, 0x6FB1FF, 0x9BC4E2, 0xC97F5A, 0x7A8FA6, 0xD9C79A],
    treeKind:   'palm',
    rockTint:   0x8B4513,
  },
  tropical: {
    buildings:  [0xff9aa2, 0xffd6a5, 0xfdffb6, 0xcaffbf, 0x9bf6ff, 0xa0c4ff],
    treeKind:   'palm',
    rockTint:   0x4a3728,
  },
};

export function biomePalette(biome) {
  return BIOME_PALETTES[biome] || BIOME_PALETTES.snow;
}

// ─── Per-chunk content generators ──────────────────────────────
// All generators return { obstacles, scenery, collectibles, specialFeatures }
// where each item is plain data (no Three.js).

function genOpenSnow(rng, chunk) {
  const { startZ, endZ, biome } = chunk;
  const palette = biomePalette(biome);
  const obstacles = [];
  const scenery = [];
  const collectibles = [];

  // Side scatter: trees + rocks
  for (let z = startZ + 4; z < endZ; z += range(rng, 6, 9)) {
    for (const side of [-1, 1]) {
      if (chance(rng, 0.55)) {
        scenery.push({
          type: palette.treeKind === 'pine' ? 'pine_tree' : 'palm_tree',
          x: side * range(rng, 9, 13),
          z,
          scale: range(rng, 0.9, 1.3),
          biome,
        });
      } else if (chance(rng, 0.4)) {
        scenery.push({
          type: 'rock_cluster',
          x: side * range(rng, 7.5, 10),
          z,
          scale: range(rng, 0.8, 1.4),
          biome,
        });
      } else if (chance(rng, 0.3)) {
        scenery.push({
          type: 'street_lamp',
          x: side * 5.9,
          z,
          biome,
        });
      }
    }
  }

  // A few in-lane obstacles
  let oz = startZ + range(rng, 6, 14);
  while (oz < endZ - 4) {
    const lane = rangeInt(rng, -1, 1);
    if (chance(rng, 0.35)) {
      obstacles.push({
        type: 'lane_rock', x: lane * 3, z: oz, biome,
      });
    } else {
      const types = ['taxi', 'suv', 'truck', 'cityBus', 'schoolBus'];
      obstacles.push({
        type: 'static_vehicle',
        vehicle: pick(rng, types),
        x: lane * 3, z: oz,
        rotation: chance(rng, 0.3)
          ? (chance(rng, 0.5) ? 1 : -1) * range(rng, 10, 30) * Math.PI / 180
          : (chance(rng, 0.5) ? 0 : Math.PI),
      });
    }
    oz += range(rng, 18, 32);
  }

  // Coin rows
  for (let z = startZ + 4; z < endZ; z += 5) {
    if (chance(rng, 0.5)) {
      collectibles.push({
        type: 'coin', x: rangeInt(rng, -1, 1) * 3, z, y: 1.2,
      });
    }
  }

  return { obstacles, scenery, collectibles, specialFeatures: [] };
}

function genCityBlock(rng, chunk) {
  const { startZ, endZ, biome } = chunk;
  const palette = biomePalette(biome);
  const obstacles = [];
  const scenery = [];
  const collectibles = [];
  const specialFeatures = [];

  // Buildings on both sides
  for (let z = startZ + 3; z < endZ; z += range(rng, 8, 12)) {
    for (const side of [-1, 1]) {
      const r = rng();
      const baseX = side * range(rng, 12, 15);
      if (r < 0.55 && biome === 'city') {
        scenery.push({
          type: 'skyscraper',
          x: baseX,
          z,
          width: range(rng, 5, 8),
          depth: range(rng, 4, 7),
          height: range(rng, 18, 35),
          color: pick(rng, palette.buildings),
          helix: chance(rng, 0.18),
          biome,
        });
      } else if (r < 0.85) {
        scenery.push({
          type: 'mid_rise',
          x: baseX,
          z,
          width: range(rng, 4, 7),
          depth: range(rng, 3.5, 5.5),
          height: range(rng, 8, 16),
          color: pick(rng, palette.buildings),
          biome,
        });
      } else {
        scenery.push({
          type: 'street_lamp', x: side * 5.9, z, biome,
        });
      }
    }
  }

  // One cross-street roughly in the middle
  if (chance(rng, 0.85)) {
    const cz = startZ + range(rng, 18, 32);
    specialFeatures.push({ type: 'cross_street', z: cz, biome });
  }

  // In-lane parked vehicles
  let oz = startZ + range(rng, 6, 14);
  while (oz < endZ - 4) {
    const lane = rangeInt(rng, -1, 1);
    if (chance(rng, 0.7)) {
      obstacles.push({
        type: 'static_vehicle',
        vehicle: pick(rng, ['taxi', 'suv', 'truck', 'cityBus', 'schoolBus']),
        x: lane * 3, z: oz,
        rotation: chance(rng, 0.5) ? 0 : Math.PI,
      });
    } else {
      obstacles.push({ type: 'lane_rock', x: lane * 3, z: oz, biome });
    }
    oz += range(rng, 18, 30);
  }

  // Coins
  for (let z = startZ + 4; z < endZ; z += 5) {
    if (chance(rng, 0.55)) {
      collectibles.push({ type: 'coin', x: rangeInt(rng, -1, 1) * 3, z, y: 1.2 });
    }
  }

  return { obstacles, scenery, collectibles, specialFeatures };
}

function genForest(rng, chunk) {
  const { startZ, endZ, biome } = chunk;
  const palette = biomePalette(biome);
  const obstacles = [];
  const scenery = [];
  const collectibles = [];

  // Dense rows of trees on both sides — narrower path feel
  for (let z = startZ; z < endZ; z += range(rng, 3, 5)) {
    for (const side of [-1, 1]) {
      const baseX = side * range(rng, 6.5, 11);
      scenery.push({
        type: palette.treeKind === 'pine' ? 'pine_tree' : 'palm_tree',
        x: baseX, z, scale: range(rng, 0.95, 1.4), biome,
      });
      if (chance(rng, 0.4)) {
        scenery.push({
          type: palette.treeKind === 'pine' ? 'pine_tree' : 'palm_tree',
          x: baseX + side * range(rng, 1.2, 2.0),
          z: z + range(rng, 1, 3),
          scale: range(rng, 0.8, 1.1), biome,
        });
      }
    }
    // Decorative deer/animal silhouettes on the far sides
    if (chance(rng, 0.06)) {
      scenery.push({
        type: 'deer',
        x: (chance(rng, 0.5) ? -1 : 1) * range(rng, 13, 17),
        z, biome,
      });
    }
  }

  // Fallen logs as in-lane obstacles
  let oz = startZ + range(rng, 8, 14);
  while (oz < endZ - 4) {
    obstacles.push({
      type: 'fallen_log',
      x: rangeInt(rng, -1, 1) * 3,
      z: oz,
      rotation: range(rng, -0.3, 0.3),
    });
    oz += range(rng, 16, 26);
  }

  // Sparse coins between the trees
  for (let z = startZ + 5; z < endZ; z += 6) {
    if (chance(rng, 0.45)) {
      collectibles.push({ type: 'coin', x: rangeInt(rng, -1, 1) * 3, z, y: 1.2 });
    }
  }

  return { obstacles, scenery, collectibles, specialFeatures: [] };
}

function genLakeCrossing(rng, chunk) {
  const { startZ, endZ, biome } = chunk;
  const obstacles = [];
  const scenery = [];
  const collectibles = [];
  const specialFeatures = [];

  // Mark the whole chunk as an icy floor with slippery physics
  specialFeatures.push({
    type: 'lake_floor',
    z0: startZ, z1: endZ,
    iceColor: 0xB8E8F0,
    crackColor: 0x2980B9,
    horizontalSpeedMult: 1.5,
  });

  // Frozen boats + ice chunks scattered both in lanes (obstacles) and on sides (scenery)
  for (let z = startZ + 6; z < endZ - 2; z += range(rng, 7, 12)) {
    if (chance(rng, 0.55)) {
      obstacles.push({
        type: 'frozen_boat',
        x: rangeInt(rng, -1, 1) * 3,
        z,
        rotation: range(rng, -0.4, 0.4),
      });
    } else {
      obstacles.push({
        type: 'ice_chunk',
        x: rangeInt(rng, -1, 1) * 3,
        z,
        scale: range(rng, 0.8, 1.4),
      });
    }
  }
  for (let z = startZ; z < endZ; z += range(rng, 4, 7)) {
    for (const side of [-1, 1]) {
      if (chance(rng, 0.45)) {
        scenery.push({
          type: 'ice_chunk_decor',
          x: side * range(rng, 7, 13),
          z, scale: range(rng, 0.6, 1.4),
        });
      }
    }
  }

  // Coins easier to collect since the player skims faster
  for (let z = startZ + 4; z < endZ; z += 4) {
    if (chance(rng, 0.55)) {
      collectibles.push({ type: 'coin', x: rangeInt(rng, -1, 1) * 3, z, y: 1.2 });
    }
  }

  return { obstacles, scenery, collectibles, specialFeatures };
}

function genMountainSplit(rng, chunk) {
  const { startZ, endZ, biome } = chunk;
  const splitLen = Math.min(endZ - startZ, range(rng, 80, 100));
  const splitEnd = startZ + splitLen;

  const obstacles = [];
  const scenery = [];
  const collectibles = [];

  // Mountain wall in the center (-3..+3, full height)
  scenery.push({
    type: 'mountain_block',
    x: 0,
    z: startZ + splitLen / 2,
    width: 6, depth: splitLen, height: 24,
    biome,
  });

  // Arrow signs at the entrance
  scenery.push({ type: 'arrow_sign', dir: 'left',  x: -2.5, z: startZ + 1 });
  scenery.push({ type: 'arrow_sign', dir: 'right', x:  2.5, z: startZ + 1 });

  const paths = { left: { obstacles: [], collectibles: [] },
                  right: { obstacles: [], collectibles: [] } };

  // LEFT route: full-width lane (X = -10 .. -3.5), denser obstacles, more coins.
  // Spread items across the full width so it feels like an actual alternate
  // route, not a thin shoulder beside the mountain.
  for (let z = startZ + 5; z < splitEnd - 3; z += range(rng, 8, 12)) {
    paths.left.obstacles.push({
      type: chance(rng, 0.55) ? 'lane_rock' : 'static_vehicle',
      vehicle: pick(rng, ['taxi', 'suv', 'truck']),
      x: range(rng, -10, -3.5), z,
      rotation: chance(rng, 0.5) ? 0 : Math.PI,
      biome,
    });
  }
  for (let z = startZ + 4; z < splitEnd; z += 3) {
    if (chance(rng, 0.75)) {
      paths.left.collectibles.push({
        type: 'coin', x: range(rng, -10, -3.5), z, y: 1.2,
      });
    }
  }

  // RIGHT route: also full width (X = +3.5 .. +10), fewer obstacles, optional ramp.
  for (let z = startZ + 8; z < splitEnd - 3; z += range(rng, 13, 18)) {
    if (chance(rng, 0.45)) {
      paths.right.obstacles.push({
        type: 'lane_rock',
        x: range(rng, 3.5, 10), z, biome,
      });
    }
  }
  if (chance(rng, 0.7)) {
    paths.right.specialRamp = {
      type: 'ramp',
      x: range(rng, 3.5, 9),
      z: startZ + splitLen * 0.4,
    };
  }
  for (let z = startZ + 4; z < splitEnd; z += 5) {
    if (chance(rng, 0.6)) {
      paths.right.collectibles.push({
        type: 'coin', x: range(rng, 3.5, 10), z, y: 1.2,
      });
    }
  }

  // Decorative scenery is pushed FAR out (X = ±16-22) so the city/forest
  // visibly parts to make room for the two full-width routes.
  for (let z = startZ; z < splitEnd; z += 7) {
    for (const side of [-1, 1]) {
      if (chance(rng, 0.55)) {
        scenery.push({
          type: biome === 'snow' ? 'pine_tree' : 'palm_tree',
          x: side * range(rng, 16, 20),
          z, scale: range(rng, 0.9, 1.4), biome,
        });
      }
      if (chance(rng, 0.18)) {
        scenery.push({
          type: 'rock_cluster',
          x: side * range(rng, 14, 18),
          z, scale: range(rng, 0.9, 1.5), biome,
        });
      }
    }
  }

  // Anything past splitEnd in this chunk is open ground (paths rejoined)
  return {
    obstacles, scenery, collectibles,
    specialFeatures: [{
      type: 'mountain_split',
      startZ, endZ: splitEnd,
      paths,
    }],
  };
}

function genTrainCrossing(rng, chunk) {
  const { startZ, endZ, biome } = chunk;
  const obstacles = [];
  const scenery = [];
  const collectibles = [];
  const specialFeatures = [];

  const trackZ = startZ + range(rng, 18, 30);

  specialFeatures.push({
    type: 'train_crossing',
    z: trackZ,
    width: 80,                      // along X (perpendicular to player travel)
    depth: 5,                       // along Z (visible track depth)
    direction: chance(rng, 0.5) ? 1 : -1,
    speed: range(rng, 20, 30),
    carCount: rangeInt(rng, 6, 10),
    barriers: true,
    biome,
  });

  // Light side scenery + coins around the tracks
  for (let z = startZ; z < endZ; z += range(rng, 6, 9)) {
    if (Math.abs(z - trackZ) < 4) continue; // keep tracks clear
    for (const side of [-1, 1]) {
      if (chance(rng, 0.4)) {
        scenery.push({
          type: biome === 'snow' ? 'pine_tree' : 'palm_tree',
          x: side * range(rng, 10, 13),
          z, scale: range(rng, 0.9, 1.3), biome,
        });
      }
    }
  }
  for (let z = startZ + 5; z < endZ; z += 6) {
    if (Math.abs(z - trackZ) < 4) continue;
    if (chance(rng, 0.45)) {
      collectibles.push({ type: 'coin', x: rangeInt(rng, -1, 1) * 3, z, y: 1.2 });
    }
  }

  return { obstacles, scenery, collectibles, specialFeatures };
}

function genCanyon(rng, chunk) {
  const { startZ, endZ, biome } = chunk;
  const palette = biomePalette(biome);
  const obstacles = [];
  const scenery = [];
  const collectibles = [];

  // Tall rocky walls flanking the path
  for (let z = startZ; z < endZ; z += range(rng, 4, 6)) {
    for (const side of [-1, 1]) {
      // Pushed beyond the playable corridor (player can reach ±10 inside a
      // mountain split) so the canyon walls never sit in the road.
      scenery.push({
        type: 'cliff_wall',
        x: side * range(rng, 12, 15),
        z, biome,
        height: range(rng, 10, 18),
        rockTint: palette.rockTint,
      });
    }
  }
  // Rolling boulders + a couple of jump ramps
  let oz = startZ + range(rng, 6, 12);
  while (oz < endZ - 4) {
    obstacles.push({
      type: 'rolling_boulder',
      x: rangeInt(rng, -1, 1) * 3, z: oz,
      rollSpeed: range(rng, 6, 12),
    });
    oz += range(rng, 14, 22);
  }
  if (chance(rng, 0.7)) {
    obstacles.push({
      type: 'ramp',
      x: 0,
      z: startZ + range(rng, 10, endZ - startZ - 10),
    });
  }
  for (let z = startZ + 5; z < endZ; z += 5) {
    if (chance(rng, 0.45)) {
      collectibles.push({ type: 'coin', x: rangeInt(rng, -1, 1) * 3, z, y: 1.5 });
    }
  }
  return { obstacles, scenery, collectibles, specialFeatures: [] };
}

function genBridge(rng, chunk) {
  const { startZ, endZ, biome } = chunk;
  const obstacles = [];
  const scenery = [];
  const collectibles = [];
  const specialFeatures = [];

  specialFeatures.push({
    type: 'bridge_deck',
    z0: startZ, z1: endZ,
    elevation: 2.0,
    railColor: 0xb56a0a,
    windPushAmplitude: 0.8,         // small random horizontal push
  });

  for (let z = startZ; z < endZ; z += range(rng, 4, 6)) {
    for (const side of [-1, 1]) {
      scenery.push({
        type: 'bridge_railing_post',
        x: side * 5.5, z, biome,
      });
    }
  }
  let oz = startZ + range(rng, 8, 14);
  while (oz < endZ - 4) {
    if (chance(rng, 0.55)) {
      obstacles.push({
        type: 'static_vehicle',
        vehicle: pick(rng, ['taxi', 'suv', 'truck']),
        x: rangeInt(rng, -1, 1) * 3, z: oz,
        rotation: chance(rng, 0.5) ? 0 : Math.PI,
      });
    } else {
      obstacles.push({ type: 'lane_rock', x: rangeInt(rng, -1, 1) * 3, z: oz, biome });
    }
    oz += range(rng, 18, 30);
  }
  for (let z = startZ + 4; z < endZ; z += 5) {
    if (chance(rng, 0.5)) {
      collectibles.push({ type: 'coin', x: rangeInt(rng, -1, 1) * 3, z, y: 1.2 });
    }
  }
  return { obstacles, scenery, collectibles, specialFeatures };
}

function genVillage(rng, chunk) {
  const { startZ, endZ, biome } = chunk;
  const palette = biomePalette(biome);
  const obstacles = [];
  const scenery = [];
  const collectibles = [];

  for (let z = startZ + 3; z < endZ; z += range(rng, 6, 9)) {
    for (const side of [-1, 1]) {
      const r = rng();
      if (r < 0.55) {
        scenery.push({
          type: 'cottage',
          x: side * range(rng, 11, 14),
          z,
          width: range(rng, 3, 5),
          depth: range(rng, 3, 5),
          height: range(rng, 3, 5),
          color: pick(rng, palette.buildings),
          biome,
        });
      } else if (r < 0.8) {
        scenery.push({
          type: 'market_stall',
          x: side * range(rng, 7.5, 9.5),
          z,
          color: pick(rng, [0xc0392b, 0x2980b9, 0xf1c40f, 0x16a085, 0xf39c12]),
        });
      } else {
        scenery.push({
          type: 'fence_section',
          x: side * 6.5, z, length: range(rng, 1.5, 3),
        });
      }
    }
  }
  let oz = startZ + range(rng, 8, 14);
  while (oz < endZ - 4) {
    obstacles.push({
      type: chance(rng, 0.5) ? 'market_stall_obstacle' : 'fence_obstacle',
      x: rangeInt(rng, -1, 1) * 3, z: oz,
      destructible: true,
    });
    oz += range(rng, 14, 22);
  }
  for (let z = startZ + 4; z < endZ; z += 5) {
    if (chance(rng, 0.55)) {
      collectibles.push({ type: 'coin', x: rangeInt(rng, -1, 1) * 3, z, y: 1.2 });
    }
  }
  return { obstacles, scenery, collectibles, specialFeatures: [] };
}

function genFinaleApproach(rng, chunk, finishZ) {
  const { startZ, endZ, biome } = chunk;
  const palette = biomePalette(biome);
  const obstacles = [];
  const scenery = [];
  const collectibles = [];
  const specialFeatures = [];

  // Heavy decoration — buildings, trees, lamps, bunting
  for (let z = startZ + 2; z < endZ; z += range(rng, 5, 7)) {
    for (const side of [-1, 1]) {
      const r = rng();
      if (r < 0.4) {
        scenery.push({
          type: biome === 'city' ? 'mid_rise' : 'cottage',
          x: side * range(rng, 12, 14),
          z,
          width: range(rng, 4, 6),
          depth: range(rng, 4, 5),
          height: range(rng, 6, 14),
          color: pick(rng, palette.buildings),
          biome,
        });
      } else if (r < 0.75) {
        scenery.push({
          type: biome === 'snow' ? 'pine_tree' : 'palm_tree',
          x: side * range(rng, 9, 12),
          z, scale: range(rng, 1.0, 1.3), biome,
        });
      } else {
        scenery.push({ type: 'street_lamp', x: side * 5.9, z, biome });
      }
    }
  }
  // Plenty of coins
  for (let z = startZ + 3; z < endZ - 2; z += 3) {
    collectibles.push({ type: 'coin', x: rangeInt(rng, -1, 1) * 3, z, y: 1.2 });
  }
  // Light scattered obstacles — must stay traversable
  let oz = startZ + range(rng, 10, 16);
  while (oz < endZ - 12) {
    obstacles.push({ type: 'lane_rock', x: rangeInt(rng, -1, 1) * 3, z: oz, biome });
    oz += range(rng, 22, 32);
  }
  // The finish-line marker is its own special feature for the renderer
  specialFeatures.push({
    type: 'finish_line',
    z: finishZ,
    bannerHeight: 8,
  });
  // Continuous fireworks particle hint for the renderer
  specialFeatures.push({
    type: 'fireworks_field',
    z0: startZ, z1: endZ,
    biome,
  });

  return { obstacles, scenery, collectibles, specialFeatures };
}

// ─── Main entry point ──────────────────────────────────────────

const GENERATORS = {
  OPEN_SNOW:      genOpenSnow,
  CITY_BLOCK:     genCityBlock,
  FOREST:         genForest,
  LAKE_CROSSING:  genLakeCrossing,
  MOUNTAIN_SPLIT: genMountainSplit,
  TRAIN_CROSSING: genTrainCrossing,
  CANYON:         genCanyon,
  BRIDGE:         genBridge,
  VILLAGE:        genVillage,
  FINALE_APPROACH: (rng, chunk) => {
    // Set in pickType; the actual content needs the finish Z, supplied later.
    return { obstacles: [], scenery: [], collectibles: [], specialFeatures: [] };
  },
};

/**
 * Generate a complete map.
 *
 * @param {Object} opts
 * @param {number} [opts.seed]            — 32-bit unsigned int. Random if omitted.
 * @param {number} [opts.courseLength]    — total Z length. Default DEFAULT_COURSE_LENGTH.
 * @returns {{ seed:number, courseLength:number, chunks:Array, milestones:Array }}
 */
export function generateMap(opts = {}) {
  const seed = (opts.seed != null ? opts.seed : randomSeed()) >>> 0;
  const courseLength = opts.courseLength || DEFAULT_COURSE_LENGTH;
  const rng = mulberry32(seed);

  const chunks = [];
  let prevType = null;
  let lastMountainSplitZ = -Infinity;
  // Track all mountain-split positions and train positions so we can enforce
  // the 100-unit exclusion symmetrically.
  const mountainSplitZs = [];
  const trainCrossingZs = [];

  // Walk Z in CHUNK_LENGTH steps
  for (let z = 0; z < courseLength; z += CHUNK_LENGTH) {
    const startZ = z;
    const endZ = Math.min(z + CHUNK_LENGTH, courseLength);
    const biome = biomeForZ(startZ);

    let type;
    if (startZ < INTRO_LENGTH) {
      type = 'OPEN_SNOW';
    } else if (startZ >= courseLength - FINALE_LENGTH) {
      type = 'FINALE_APPROACH';
    } else {
      // Apply rules: never repeat, MOUNTAIN_SPLIT spacing, TRAIN/MOUNTAIN spacing,
      // LAKE/BRIDGE preceded by OPEN_SNOW.
      const lookbackPrev = chunks.length ? chunks[chunks.length - 1].type : null;
      const tooCloseToAnyMountain = mountainSplitZs.some(
        sz => Math.abs(startZ - sz) < MIN_TRAIN_NEAR_MOUNTAIN,
      );
      const tooCloseToAnyTrain = trainCrossingZs.some(
        tz => Math.abs(startZ - tz) < MIN_TRAIN_NEAR_MOUNTAIN,
      );
      const rejected = (name) => {
        if (name === lookbackPrev) return true;
        if (name === 'MOUNTAIN_SPLIT') {
          if ((startZ - lastMountainSplitZ) < MIN_MOUNTAIN_SPLIT_GAP) return true;
          if (tooCloseToAnyTrain) return true;
        }
        if (name === 'TRAIN_CROSSING'
            && (lookbackPrev === 'MOUNTAIN_SPLIT' || tooCloseToAnyMountain)) return true;
        if (name === 'LAKE_CROSSING' && lookbackPrev !== 'OPEN_SNOW') return true;
        if (name === 'BRIDGE'        && lookbackPrev !== 'OPEN_SNOW') return true;
        return false;
      };
      type = pickWeighted(rng, CHUNK_WEIGHTS, rejected);

      // Belt-and-braces: if TRAIN/MOUNTAIN slipped through near each other,
      // downgrade to OPEN_SNOW.
      if (type === 'TRAIN_CROSSING' && tooCloseToAnyMountain) type = 'OPEN_SNOW';
      if (type === 'MOUNTAIN_SPLIT' && tooCloseToAnyTrain)    type = 'OPEN_SNOW';
    }

    if (type === 'MOUNTAIN_SPLIT') {
      lastMountainSplitZ = startZ;
      mountainSplitZs.push(startZ);
    }
    if (type === 'TRAIN_CROSSING') {
      trainCrossingZs.push(startZ);
    }

    const chunk = {
      index: chunks.length,
      type,
      startZ, endZ,
      biome,
      obstacles: [],
      scenery: [],
      collectibles: [],
      specialFeatures: [],
      paths: null,                  // populated by MOUNTAIN_SPLIT generator
    };

    let payload;
    if (type === 'FINALE_APPROACH') {
      payload = genFinaleApproach(rng, chunk, courseLength);
    } else {
      payload = (GENERATORS[type] || genOpenSnow)(rng, chunk);
    }
    chunk.obstacles = payload.obstacles;
    chunk.scenery = payload.scenery;
    chunk.collectibles = payload.collectibles;
    chunk.specialFeatures = payload.specialFeatures;
    // Mountain split exposes its paths at the chunk level for convenience
    const splitFeat = payload.specialFeatures.find(f => f.type === 'mountain_split');
    if (splitFeat) chunk.paths = splitFeat.paths;

    chunks.push(chunk);
    prevType = type;
  }

  // Guarantee at least one MOUNTAIN_SPLIT shows up in the early/mid course.
  // The weighted picker can occasionally produce a map with no splits at all
  // (or push the first one past 800 m), and players expect to encounter the
  // fork high-rise. If none is present in the 200-650 m range, convert a
  // suitable OPEN_SNOW chunk in that window into a MOUNTAIN_SPLIT.
  const earlySplits = chunks.filter(
    c => c.type === 'MOUNTAIN_SPLIT' && c.startZ >= 200 && c.startZ < 650,
  );
  if (earlySplits.length === 0) {
    for (const ch of chunks) {
      if (ch.startZ < 250 || ch.startZ > 600) continue;
      if (ch.type !== 'OPEN_SNOW') continue;
      ch.type = 'MOUNTAIN_SPLIT';
      const payload = genMountainSplit(rng, ch);
      ch.obstacles = payload.obstacles;
      ch.scenery = payload.scenery;
      ch.collectibles = payload.collectibles;
      ch.specialFeatures = payload.specialFeatures;
      const splitFeat = payload.specialFeatures.find(f => f.type === 'mountain_split');
      if (splitFeat) ch.paths = splitFeat.paths;
      break;
    }
  }

  // Milestones: biome thresholds + halfway
  const milestones = [
    { z: 0, label: 'START' },
    { z: BIOME_SNOW_END, label: 'CITY' },
    { z: BIOME_CITY_END, label: 'TROPICAL' },
    { z: courseLength / 2, label: 'HALFWAY' },
    { z: courseLength, label: 'FINISH' },
  ].filter(m => m.z >= 0 && m.z <= courseLength)
   .sort((a, b) => a.z - b.z);

  return {
    seed,
    courseLength,
    chunkLength: CHUNK_LENGTH,
    chunks,
    milestones,
  };
}

/** Convenience: find the chunk index for a given Z. */
export function chunkIndexForZ(map, z) {
  if (z < 0) return 0;
  const i = Math.floor(z / map.chunkLength);
  return Math.min(i, map.chunks.length - 1);
}

/** Returns the array of chunks within [z - back, z + ahead]. */
export function chunksInRange(map, z, ahead = 150, back = 30) {
  const i0 = chunkIndexForZ(map, z - back);
  const i1 = chunkIndexForZ(map, z + ahead);
  return map.chunks.slice(i0, i1 + 1);
}
