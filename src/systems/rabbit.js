/**
 * Rabbit — Jana Bunny mode AI racer.
 *
 * Phase 2: full AI.
 *   • Continuous parabolic hop. The moment one hop ends, the next
 *     starts — the rabbit is never sliding/walking.
 *   • Look-ahead obstacle scan in the current lane: cars/rocks within
 *     LOOKAHEAD_M trigger a HIGH hop on the next bounce so the rabbit
 *     clears them; otherwise a LOW hop (default cadence + bridge-hole
 *     friendly).
 *   • Lane swerve when the current lane has more upcoming blockers
 *     than another lane within SWERVE_LOOKAHEAD_M.
 *   • Coins the rabbit passes (same lane, within COIN_PICKUP_DISTANCE)
 *     are collected — flag-shared with the player so they vanish for
 *     both racers.
 *   • If the AI's hop fails to clear an obstacle (rabbit's Y at the
 *     obstacle's distance < its top minus margin AND lanes match), a
 *     COLLISION_PENALTY_SEC speed cut is applied. Rabbit doesn't die.
 *
 * The rabbit's mesh sits in world space; its world-Z is computed each
 * frame as `-(rabbit.distance - playerDistance)` so it visibly stays
 * ahead/behind based on real progress.
 *
 * Sprint Run never instantiates this class — kept entirely off the hot
 * path until gameMode === 'jana_bunny'.
 */
import * as THREE from 'three';
import { JANA_BUNNY } from '../utils/constants.js';

export class Rabbit {
  constructor() {
    this.group = null;       // root Object3D added to the scene
    this.distance = 0;       // world-units traveled along the course
    this.lane = -1;          // current lane index in {-1, 0, +1}
    this._targetLane = -1;   // lane the AI is steering toward
    this._scene = null;
    this._laneWidth = 3;     // matches GAME_CONFIG.LANE_WIDTH

    // Hop physics state
    this._hopY = 0;
    this._hopVel = 0;
    this._inHop = false;
    this._nextPeak = JANA_BUNNY.HOP_PEAK_LOW;

    // Collision penalty timer (seconds remaining).
    this._penaltyT = 0;

    // Track which obstacles we've already resolved (collided or
    // passed under) so we don't double-count penalties on the same
    // obstacle across frames.
    this._resolvedObs = new WeakSet();
  }

  /**
   * Build the mesh and add it at the start line, in the given lane.
   */
  init(scene, { lane = -1, laneWidth = 3 } = {}) {
    this._scene = scene;
    this.lane = lane;
    this._targetLane = lane;
    this._laneWidth = laneWidth;
    this.distance = 0;
    this._hopY = 0;
    this._hopVel = 0;
    this._inHop = false;
    this._penaltyT = 0;

    const root = new THREE.Group();
    root.userData.kind = 'rabbit';

    // Body — squashed sphere, pearl white.
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 12), whiteMat);
    body.scale.set(1.0, 0.85, 1.4);
    body.position.y = 0.7;
    body.castShadow = true;
    root.add(body);

    // Head — sphere, slightly forward & up.
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.36, 14, 12), whiteMat);
    head.position.set(0, 1.05, 0.55);
    head.castShadow = true;
    root.add(head);

    // Ears — two tall narrow cylinders.
    const pinkMat = new THREE.MeshStandardMaterial({ color: 0xffb3c1, roughness: 0.8 });
    const earGeo = new THREE.CylinderGeometry(0.07, 0.05, 0.55, 8);
    const earL = new THREE.Mesh(earGeo, whiteMat);
    earL.position.set(-0.15, 1.45, 0.45);
    earL.rotation.z = 0.15;
    root.add(earL);
    const earR = new THREE.Mesh(earGeo, whiteMat);
    earR.position.set(0.15, 1.45, 0.45);
    earR.rotation.z = -0.15;
    root.add(earR);
    const innerEarGeo = new THREE.CylinderGeometry(0.04, 0.025, 0.45, 8);
    const innerL = new THREE.Mesh(innerEarGeo, pinkMat);
    innerL.position.set(-0.15, 1.45, 0.5);
    innerL.rotation.z = 0.15;
    root.add(innerL);
    const innerR = new THREE.Mesh(innerEarGeo, pinkMat);
    innerR.position.set(0.15, 1.45, 0.5);
    innerR.rotation.z = -0.15;
    root.add(innerR);

    // Eyes
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.4 });
    const eyeGeo = new THREE.SphereGeometry(0.05, 8, 6);
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    eyeL.position.set(-0.13, 1.12, 0.85);
    root.add(eyeL);
    const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
    eyeR.position.set(0.13, 1.12, 0.85);
    root.add(eyeR);

    // Tail
    const tail = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), whiteMat);
    tail.position.set(0, 0.7, -0.65);
    root.add(tail);

    root.position.set(lane * laneWidth, 0, 0);

    scene.add(root);
    this.group = root;
    return this;
  }

  /**
   * Per-frame update.
   *
   * env: {
   *   playerDistance:   number,
   *   obstacles:        Object3D[]   // cars / rocks (jumpable)
   *   collectibles:     Object3D[]   // coins
   *   courseLength:     number,
   *   laneWidth:        number,      // optional; falls back to instance _laneWidth
   * }
   */
  update(delta, env = {}) {
    if (!this.group) return;
    const playerDistance = env.playerDistance || 0;
    const obstacles = env.obstacles || [];
    const collectibles = env.collectibles || [];
    const laneWidth = env.laneWidth || this._laneWidth;

    // ── 1. Penalty timer
    if (this._penaltyT > 0) this._penaltyT = Math.max(0, this._penaltyT - delta);

    // ── 2. Forward speed (cut while in penalty)
    const speedMul = this._penaltyT > 0 ? JANA_BUNNY.COLLISION_SPEED_MULT : 1.0;
    this.distance += JANA_BUNNY.RABBIT_SPEED * speedMul * delta;

    // ── 3. Lane planning — pick a target lane based on what's ahead
    this._planLane(obstacles, playerDistance);

    // ── 4. Lane X smoothly interpolates to target
    const targetX = this._targetLane * laneWidth;
    const currentX = this.group.position.x;
    const k = JANA_BUNNY.LANE_SWITCH_RATE;
    this.group.position.x = currentX + (targetX - currentX) * Math.min(1, k * delta);
    // Once close enough, snap discrete lane index.
    if (Math.abs(this.group.position.x - targetX) < 0.05) {
      this.lane = this._targetLane;
      this.group.position.x = targetX;
    }

    // ── 5. Hop physics (parabolic arc)
    if (!this._inHop) this._startHop(obstacles, playerDistance);
    this._hopVel -= JANA_BUNNY.HOP_GRAVITY * delta;
    this._hopY   += this._hopVel * delta;
    if (this._hopY <= 0) {
      this._hopY = 0;
      this._hopVel = 0;
      this._inHop = false;
      // The next frame schedules a fresh hop (no walking gap — race feel).
    }

    // ── 6. Coin pickup — same source-of-truth flag the player sets,
    //       so a coin the rabbit grabs disappears for both racers.
    this._scoopCoins(collectibles, playerDistance, laneWidth);

    // ── 7. Collision check — penalty if we cross an obstacle's distance
    //       in the same lane while the hop hasn't lifted us above it.
    this._checkCollisions(obstacles, playerDistance, laneWidth);

    // ── 8. Render position. Z is relative to the player's progress so
    //       the rabbit visibly stays ahead/behind based on real distance.
    this.group.position.y = this._hopY;
    this.group.position.z = -(this.distance - playerDistance);

    // Pitch tilt: nose up while ascending, nose down while descending.
    // Maps roughly +-15deg over the natural hop velocity range.
    const tilt = Math.atan2(this._hopVel, JANA_BUNNY.RABBIT_SPEED * speedMul + 1) * 0.4;
    this.group.rotation.x = -tilt;
  }

  /**
   * Schedule the next hop and decide its peak height. Looks at the
   * very next obstacle in the current lane within the lookahead and
   * picks HIGH to clear it, or LOW for the default arc.
   */
  _startHop(obstacles, playerDistance) {
    let peak = JANA_BUNNY.HOP_PEAK_LOW;
    const nextObs = this._nextObstacleInLane(obstacles, playerDistance, JANA_BUNNY.LOOKAHEAD_M, this._targetLane);
    if (nextObs) peak = JANA_BUNNY.HOP_PEAK_HIGH;
    // v = sqrt(2 g h) — initial vertical velocity to reach exactly `peak`
    this._hopVel = Math.sqrt(2 * JANA_BUNNY.HOP_GRAVITY * peak);
    this._hopY = 0.001;     // nudge above ground so the loop knows we're airborne
    this._inHop = true;
    this._nextPeak = peak;
  }

  /**
   * If the current lane is blocked within SWERVE_LOOKAHEAD_M and a
   * sibling lane is clear, switch target lane. Otherwise stay.
   */
  _planLane(obstacles, playerDistance) {
    const laneCounts = this._countBlockersByLane(obstacles, playerDistance, JANA_BUNNY.SWERVE_LOOKAHEAD_M);
    const here = laneCounts[this._targetLane + 1] || 0;
    if (here === 0) return; // happy with current lane
    let bestLane = this._targetLane;
    let bestCount = here;
    for (const tryLane of [-1, 0, 1]) {
      const c = laneCounts[tryLane + 1] || 0;
      // Prefer adjacent lanes (no skipping) — penalize 2-lane jumps.
      const distancePenalty = Math.abs(tryLane - this._targetLane) > 1 ? 0.5 : 0;
      if (c + distancePenalty < bestCount) {
        bestLane = tryLane;
        bestCount = c + distancePenalty;
      }
    }
    if (bestLane !== this._targetLane) this._targetLane = bestLane;
  }

  /**
   * Count obstacles ahead per lane within `windowM` world units.
   * Returns array indexed by (lane+1).
   */
  _countBlockersByLane(obstacles, playerDistance, windowM) {
    const counts = [0, 0, 0];
    for (const o of obstacles) {
      if (!o.userData) continue;
      const obsDist = playerDistance + o.position.z;
      const ahead = obsDist - this.distance;
      if (ahead <= 0 || ahead > windowM) continue;
      const lane = (typeof o.userData.lane === 'number') ? (o.userData.lane - 1) : Math.round(o.position.x / this._laneWidth);
      const idx = lane + 1;
      if (idx >= 0 && idx <= 2) counts[idx]++;
    }
    return counts;
  }

  /**
   * Find the closest obstacle in `lane` within `windowM` ahead of the rabbit.
   */
  _nextObstacleInLane(obstacles, playerDistance, windowM, lane) {
    let best = null;
    let bestAhead = Infinity;
    for (const o of obstacles) {
      if (!o.userData) continue;
      const oLane = (typeof o.userData.lane === 'number') ? (o.userData.lane - 1) : Math.round(o.position.x / this._laneWidth);
      if (oLane !== lane) continue;
      const obsDist = playerDistance + o.position.z;
      const ahead = obsDist - this.distance;
      if (ahead <= 0 || ahead > windowM) continue;
      if (ahead < bestAhead) { bestAhead = ahead; best = o; }
    }
    return best;
  }

  /**
   * Sweep collectibles; coins within COIN_PICKUP_DISTANCE along the
   * rabbit's path AND within COIN_PICKUP_LANE_DX laterally are picked
   * up. The collected flag is the same one the player sets in
   * game.js — so the coin disappears for everyone.
   */
  _scoopCoins(collectibles, playerDistance, laneWidth) {
    const dx = JANA_BUNNY.COIN_PICKUP_LANE_DX;
    const dz = JANA_BUNNY.COIN_PICKUP_DISTANCE;
    const myX = this.group.position.x;
    for (const coin of collectibles) {
      if (!coin || coin.userData.collected) continue;
      const coinDist = playerDistance + coin.position.z;
      if (Math.abs(coinDist - this.distance) > dz) continue;
      if (Math.abs((coin.position.x ?? 0) - myX) > dx) continue;
      coin.userData.collected = true;
      coin.visible = false;
    }
  }

  /**
   * Apply a collision penalty if the rabbit is currently passing
   * through an obstacle's distance band while in the same lane and
   * its hop Y is below the obstacle's top (with margin). Each
   * obstacle is resolved at most once via the WeakSet.
   */
  _checkCollisions(obstacles, playerDistance, laneWidth) {
    const myX = this.group.position.x;
    for (const o of obstacles) {
      if (!o.userData || this._resolvedObs.has(o)) continue;
      const obsDist = playerDistance + o.position.z;
      const lateralDist = obsDist - this.distance;
      // Only consider obstacles within a small band straddling the rabbit
      const halfL = (o.userData.length || 1.5) / 2 + 0.4;
      if (lateralDist < -halfL || lateralDist > halfL) continue;
      // Lateral X check
      const halfW = (o.userData.width || 1.5) / 2 + 0.5;
      if (Math.abs((o.position.x ?? 0) - myX) > halfW) continue;
      // Cleared on top? No collision.
      const top = (o.userData.height || 1.0);
      if (this._hopY >= top - 0.2) {
        // Hop arc was high enough — mark resolved so we don't keep checking.
        this._resolvedObs.add(o);
        continue;
      }
      // Otherwise: collision — apply penalty and mark resolved.
      this._resolvedObs.add(o);
      if (this._penaltyT <= 0) {
        this._penaltyT = JANA_BUNNY.COLLISION_PENALTY_SEC;
      }
    }
  }

  /** Has the rabbit reached or crossed the finish line? */
  hasFinished(courseLength) {
    return courseLength > 0 && this.distance >= courseLength;
  }

  /**
   * Tear down: remove from scene, dispose geometry/material so the
   * round restart doesn't leak GPU memory.
   */
  dispose() {
    if (!this.group || !this._scene) return;
    this._scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.isMesh) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      }
    });
    this.group = null;
    this._scene = null;
  }
}
