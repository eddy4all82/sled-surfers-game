/**
 * Shared collision descriptors for player physics and Jana Bunny AI.
 *
 * The visible meshes remain owned by game.js. This module gives both the
 * player and rabbit one common interpretation of those meshes: position,
 * footprint, height, jumpability, and special arch/aerial rules.
 */

export const COLLIDER_KIND = {
  GROUND: 'ground',
  WALL: 'wall',
  BUILDING: 'building',
  AERIAL: 'aerial',
};

export const DEFAULT_MAX_MEDIUM_CLEAR_HEIGHT = 3.0;

function laneFor(obj, laneWidth = 3) {
  if (obj?.userData && typeof obj.userData.lane === 'number') return obj.userData.lane - 1;
  return Math.round((obj?.position?.x ?? 0) / laneWidth);
}

function courseZ(playerDistance, screenZ) {
  return playerDistance + (screenZ || 0);
}

function commonCollider(obj, playerDistance, laneWidth, overrides = {}) {
  const ud = obj?.userData || {};
  const height = overrides.height ?? ud.height ?? 1;
  const width = overrides.width ?? ud.width ?? 1;
  const length = overrides.length ?? ud.length ?? 1;
  const x = overrides.x ?? obj?.position?.x ?? 0;
  const z = overrides.z ?? obj?.position?.z ?? 0;
  return {
    obj,
    source: overrides.source || ud.kind || ud.type || 'object',
    kind: overrides.kind || COLLIDER_KIND.GROUND,
    x,
    screenZ: z,
    courseZ: courseZ(playerDistance, z),
    lane: overrides.lane ?? laneFor({ position: { x }, userData: ud }, laneWidth),
    y: overrides.y ?? obj?.position?.y ?? 0,
    yHalf: overrides.yHalf,
    height,
    width,
    length,
    len: length,
    jumpable: overrides.jumpable ?? true,
    maxJumpClearHeight: overrides.maxJumpClearHeight ?? DEFAULT_MAX_MEDIUM_CLEAR_HEIGHT,
    requiresMega: overrides.requiresMega ?? false,
    archHalfW: overrides.archHalfW,
    archYMin: overrides.archYMin,
    archYMax: overrides.archYMax,
  };
}

export function buildCollisionWorld({
  playerDistance = 0,
  laneWidth = 3,
  obstacles = [],
  scenery = [],
  buildings = [],
  crossStreets = [],
  ramps = [],
  drones = [],
  observerDistance = playerDistance,
  observerSpeed = 0,
} = {}) {
  const colliders = [];

  for (const o of obstacles) {
    if (!o?.userData) continue;
    const height = o.userData.height ?? 1.0;
    colliders.push(commonCollider(o, playerDistance, laneWidth, {
      source: o.userData.vehicleType ? 'vehicle' : 'obstacle',
      kind: COLLIDER_KIND.GROUND,
      height,
      length: o.userData.length ?? 1.5,
      width: o.userData.width ?? 1.5,
      jumpable: height <= DEFAULT_MAX_MEDIUM_CLEAR_HEIGHT,
    }));
  }

  for (const s of scenery) {
    if (!s?.userData?.collidable) continue;
    const height = s.userData.height ?? 4.0;
    const jumpable = height <= DEFAULT_MAX_MEDIUM_CLEAR_HEIGHT;
    colliders.push(commonCollider(s, playerDistance, laneWidth, {
      source: s.userData.kind || 'scenery',
      kind: jumpable ? COLLIDER_KIND.GROUND : COLLIDER_KIND.WALL,
      height,
      length: s.userData.length ?? 1.0,
      width: s.userData.width ?? 1.0,
      jumpable,
    }));
  }

  for (const b of buildings) {
    if (!b?.userData || b.userData.kind !== 'building') continue;
    colliders.push(commonCollider(b, playerDistance, laneWidth, {
      source: 'building',
      kind: COLLIDER_KIND.BUILDING,
      lane: 0,
      height: b.userData.height ?? 12.0,
      length: b.userData.length ?? 30.0,
      width: b.userData.width ?? 6.0,
      jumpable: false,
      requiresMega: true,
      archHalfW: b.userData.archHalfW ?? 1.5,
      archYMin: b.userData.archYMin ?? 3.0,
      archYMax: b.userData.archYMax ?? 8.0,
    }));
  }

  for (const street of crossStreets) {
    if (!street?.userData?.cars) continue;
    const streetCourseZ = courseZ(playerDistance, street.position.z);
    const distToObserver = streetCourseZ - observerDistance;
    if (distToObserver <= -3 || distToObserver > 60) continue;
    const arrivalT = distToObserver > 0 && observerSpeed > 0 ? distToObserver / observerSpeed : 0;
    for (const car of street.userData.cars) {
      if (!car?.userData) continue;
      const futureX = car.position.x - (car.userData.dir || 0) * (car.userData.speed || 0) * arrivalT;
      colliders.push({
        obj: car,
        source: 'cross_traffic',
        kind: COLLIDER_KIND.GROUND,
        x: futureX,
        screenZ: street.position.z,
        courseZ: streetCourseZ,
        lane: Math.round(futureX / laneWidth),
        y: car.position.y ?? 0,
        height: 1.4,
        length: 1.6,
        len: 1.6,
        width: 3.6,
        jumpable: true,
        maxJumpClearHeight: DEFAULT_MAX_MEDIUM_CLEAR_HEIGHT,
      });
    }
  }

  for (const r of ramps) {
    if (!r?.userData) continue;
    colliders.push(commonCollider(r, playerDistance, laneWidth, {
      source: 'ramp',
      kind: COLLIDER_KIND.GROUND,
      height: 2.2,
      length: r.userData.length ?? 10,
      width: 3.0,
      jumpable: true,
    }));
  }

  for (const d of drones) {
    if (!d) continue;
    colliders.push(commonCollider(d, playerDistance, laneWidth, {
      source: 'drone',
      kind: COLLIDER_KIND.AERIAL,
      x: d.position.x,
      y: d.position.y,
      yHalf: 0.55,
      height: (d.position.y ?? 4) + 0.55,
      length: 1.4,
      width: 1.4,
      jumpable: false,
    }));
  }

  return colliders;
}

export function toRabbitThreat(collider, rabbitDistance) {
  return {
    obj: collider.obj,
    collider,
    dist: collider.courseZ - rabbitDistance,
    x: collider.x,
    lane: collider.lane,
    kind: collider.kind,
    height: collider.height,
    len: collider.length,
    width: collider.width,
    y: collider.y,
    yHalf: collider.yHalf,
    jumpable: collider.jumpable,
    maxJumpClearHeight: collider.maxJumpClearHeight,
    requiresMega: collider.requiresMega,
    archHalfW: collider.archHalfW,
    archYMin: collider.archYMin,
    archYMax: collider.archYMax,
    source: collider.source,
  };
}

export function buildRabbitThreats(options, rabbitDistance) {
  return buildCollisionWorld(options).map((c) => toRabbitThreat(c, rabbitDistance));
}

export function overlapsFootprint(collider, x, z = 0, marginX = 0, marginZ = 0) {
  const halfW = (collider.width || 1) / 2 + marginX;
  const halfL = (collider.length || collider.len || 1) / 2 + marginZ;
  return Math.abs((collider.x || 0) - x) < halfW &&
         Math.abs((collider.screenZ || 0) - z) < halfL;
}

export function canPassBuildingArch(collider, x, y, {
  bodyHalfW = 0,
  enterToleranceY = -0.2,
  continueToleranceY = 0.5,
  stateKey = '_playerInArch',
} = {}) {
  const archHalfW = collider.archHalfW ?? 1.5;
  const archYMin = collider.archYMin ?? 3.0;
  const archYMax = collider.archYMax ?? 8.0;
  const insideArchX = Math.abs(x - (collider.x || 0)) + bodyHalfW <= archHalfW + 0.4;
  const ud = collider.obj?.userData || {};

  if (!ud[stateKey]) {
    if (insideArchX && y >= archYMin + enterToleranceY && y <= archYMax + continueToleranceY) {
      ud[stateKey] = true;
      return { pass: true, snapY: Math.max(y, archYMin) };
    }
    return { pass: false };
  }

  if (insideArchX && y <= archYMax + continueToleranceY) {
    return { pass: true, snapY: Math.max(y, archYMin) };
  }

  return { pass: false };
}
