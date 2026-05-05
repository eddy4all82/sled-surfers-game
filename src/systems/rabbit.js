/**
 * Rabbit — Jana Bunny mode AI racer.
 *
 * Phase 2.2: full obstacle awareness + building tunnel threading.
 *
 * Threat taxonomy
 * ---------------
 *   • obstacles[]   — cars, rocks (jumpable; HIGH hop clears).
 *   • scenery[]     — trees, lamps, signs, cabins (with userData.collidable
 *                     set). Heights ≥ 4m typically — must SWERVE around.
 *                     Low scenery (signs ≤ 2.5m) can be HIGH-hopped.
 *   • buildings[]   — mid-rise blocks with userData.kind === 'building'.
 *                     Each has an arch tunnel through the centre lane:
 *                       archHalfW  — opening half-width (typ. 1.5m)
 *                       archYMin   — bottom of arch (typ. 3.0m)
 *                       archYMax   — top of arch    (typ. 8.0m)
 *                     Side lanes are SOLID PILLARS — must be in lane 0
 *                     when crossing AND have hopY in [archYMin+0.5, archYMax-0.5].
 *
 * Lane planning
 * -------------
 * Each frame the rabbit scores all 3 lanes within SWERVE_LOOKAHEAD_M:
 *   walls  (tall scenery / building pillars)  →  +5 each (must avoid)
 *   ground (cars / rocks / low signs)         →  +1 each (jumpable but slows decisions)
 *   coins                                     →  -0.3 each (small attractor)
 * If a building is upcoming, lane 0 gets a -10 bonus that overrides
 * everything — the rabbit MUST be in centre to thread the tunnel.
 * Picks lowest-cost lane, with a small adjacency preference so it
 * doesn't skip lanes wastefully.
 *
 * Hop planning
 * ------------
 * After each hop ends, the next hop's peak is chosen from the closest
 * threat in the chosen lane within HOP_HIGH_RANGE forward distance:
 *   • Building threading needed  →  MEGA peak (5.5m, ~13m forward range
 *                                   matches the arch span)
 *   • Tall ground hazard         →  HIGH peak (3.5m)
 *   • Nothing within range       →  LOW peak (0.55m, snappy running gait)
 *
 * Collisions
 * ----------
 * If the rabbit's hopY at the moment it crosses a threat's distance is
 * below the threat's clearance height (and lanes match), a 1-second
 * COLLISION_PENALTY_SEC speed cut is applied. Each threat resolves at
 * most once via a WeakSet so the penalty doesn't stack across frames
 * for the same object.
 */
import * as THREE from 'three';
import { JANA_BUNNY } from '../utils/constants.js';

// Forward distance covered by a hop with the given peak (h) and gravity (g)
// at speed (v).  D = v * 2*sqrt(2h/g).  Used for hop range planning.
function hopRange(peak, gravity, speed) {
  return speed * 2 * Math.sqrt(2 * peak / gravity);
}

export class Rabbit {
  constructor() {
    this.group = null;
    this.distance = 0;
    this.lane = 0;                 // start in centre — useful for first building
    this._targetLane = 0;
    this._scene = null;
    this._laneWidth = 3;

    this._hopY = 0;
    this._hopVel = 0;
    this._inHop = false;
    this._lastPeak = JANA_BUNNY.HOP_PEAK_LOW;

    this._penaltyT = 0;
    this._resolvedThreats = new WeakSet();

    this._earL = null;
    this._earR = null;
  }

  init(scene, { lane = 0, laneWidth = 3 } = {}) {
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

    const furMat   = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.8 });
    const bellyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
    const pinkMat  = new THREE.MeshStandardMaterial({ color: 0xff9fb5, roughness: 0.7 });
    const noseMat  = new THREE.MeshStandardMaterial({ color: 0xff6b8a, roughness: 0.6 });
    const eyeMat   = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.3 });
    const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
    const toothMat = new THREE.MeshStandardMaterial({ color: 0xfff5e0, roughness: 0.5 });

    const body = new THREE.Mesh(new THREE.SphereGeometry(0.65, 18, 14), furMat);
    body.scale.set(1.0, 0.95, 1.4);
    body.position.set(0, 0.7, -0.05);
    body.castShadow = true;
    root.add(body);

    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), bellyMat);
    belly.scale.set(0.9, 0.7, 1.0);
    belly.position.set(0, 0.55, 0.25);
    root.add(belly);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 14), furMat);
    head.position.set(0, 1.05, 0.55);
    head.castShadow = true;
    root.add(head);

    const cheekGeo = new THREE.SphereGeometry(0.16, 10, 8);
    const cheekL = new THREE.Mesh(cheekGeo, furMat);
    cheekL.position.set(-0.22, 0.95, 0.78);
    root.add(cheekL);
    const cheekR = new THREE.Mesh(cheekGeo, furMat);
    cheekR.position.set(0.22, 0.95, 0.78);
    root.add(cheekR);

    const earGeo  = new THREE.CylinderGeometry(0.09, 0.06, 0.85, 10);
    const earInGeo = new THREE.CylinderGeometry(0.05, 0.025, 0.72, 10);
    const earL = new THREE.Group();
    earL.position.set(-0.18, 1.5, 0.55);
    earL.rotation.z = 0.18;
    const earLOuter = new THREE.Mesh(earGeo, furMat);
    earLOuter.position.y = 0.42;
    earL.add(earLOuter);
    const earLInner = new THREE.Mesh(earInGeo, pinkMat);
    earLInner.position.set(0, 0.42, 0.05);
    earL.add(earLInner);
    root.add(earL);
    const earR = new THREE.Group();
    earR.position.set(0.18, 1.5, 0.55);
    earR.rotation.z = -0.18;
    const earROuter = new THREE.Mesh(earGeo, furMat);
    earROuter.position.y = 0.42;
    earR.add(earROuter);
    const earRInner = new THREE.Mesh(earInGeo, pinkMat);
    earRInner.position.set(0, 0.42, 0.05);
    earR.add(earRInner);
    root.add(earR);
    this._earL = earL;
    this._earR = earR;

    const scleraGeo = new THREE.SphereGeometry(0.085, 12, 10);
    const pupilGeo  = new THREE.SphereGeometry(0.06, 10, 8);
    const eyeLW = new THREE.Mesh(scleraGeo, eyeWhiteMat);
    eyeLW.position.set(-0.16, 1.12, 0.92);
    root.add(eyeLW);
    const eyeRW = new THREE.Mesh(scleraGeo, eyeWhiteMat);
    eyeRW.position.set(0.16, 1.12, 0.92);
    root.add(eyeRW);
    const eyeL = new THREE.Mesh(pupilGeo, eyeMat);
    eyeL.position.set(-0.16, 1.10, 0.96);
    root.add(eyeL);
    const eyeR = new THREE.Mesh(pupilGeo, eyeMat);
    eyeR.position.set(0.16, 1.10, 0.96);
    root.add(eyeR);
    const shineGeo = new THREE.SphereGeometry(0.018, 8, 6);
    const shineL = new THREE.Mesh(shineGeo, eyeWhiteMat);
    shineL.position.set(-0.14, 1.14, 1.01);
    root.add(shineL);
    const shineR = new THREE.Mesh(shineGeo, eyeWhiteMat);
    shineR.position.set(0.18, 1.14, 1.01);
    root.add(shineR);

    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), noseMat);
    nose.scale.set(1.2, 0.85, 1.0);
    nose.position.set(0, 0.95, 1.0);
    root.add(nose);
    const toothGeo = new THREE.BoxGeometry(0.05, 0.09, 0.04);
    const toothL = new THREE.Mesh(toothGeo, toothMat);
    toothL.position.set(-0.04, 0.83, 0.96);
    root.add(toothL);
    const toothR = new THREE.Mesh(toothGeo, toothMat);
    toothR.position.set(0.04, 0.83, 0.96);
    root.add(toothR);

    const pawGeo = new THREE.SphereGeometry(0.14, 10, 8);
    const pawL = new THREE.Mesh(pawGeo, furMat);
    pawL.scale.set(0.9, 0.8, 1.5);
    pawL.position.set(-0.18, 0.25, 0.55);
    root.add(pawL);
    const pawR = new THREE.Mesh(pawGeo, furMat);
    pawR.scale.set(0.9, 0.8, 1.5);
    pawR.position.set(0.18, 0.25, 0.55);
    root.add(pawR);

    const haunchGeo = new THREE.SphereGeometry(0.32, 12, 10);
    const haunchL = new THREE.Mesh(haunchGeo, furMat);
    haunchL.scale.set(0.7, 1.0, 1.4);
    haunchL.position.set(-0.42, 0.45, -0.25);
    root.add(haunchL);
    const haunchR = new THREE.Mesh(haunchGeo, furMat);
    haunchR.scale.set(0.7, 1.0, 1.4);
    haunchR.position.set(0.42, 0.45, -0.25);
    root.add(haunchR);

    const footGeo = new THREE.SphereGeometry(0.18, 10, 8);
    const footL = new THREE.Mesh(footGeo, furMat);
    footL.scale.set(1.0, 0.7, 2.0);
    footL.position.set(-0.32, 0.18, 0.05);
    root.add(footL);
    const footR = new THREE.Mesh(footGeo, furMat);
    footR.scale.set(1.0, 0.7, 2.0);
    footR.position.set(0.32, 0.18, 0.05);
    root.add(footR);

    const tail = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), bellyMat);
    tail.position.set(0, 0.85, -0.85);
    root.add(tail);

    const whiskerMat = new THREE.LineBasicMaterial({ color: 0xcccccc });
    const mkWhisker = (x1, y1, z1, x2, y2, z2) => {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x1, y1, z1),
        new THREE.Vector3(x2, y2, z2),
      ]);
      return new THREE.Line(g, whiskerMat);
    };
    root.add(mkWhisker(-0.06, 0.92, 1.00, -0.40, 0.98, 1.02));
    root.add(mkWhisker(-0.06, 0.88, 1.00, -0.40, 0.85, 1.02));
    root.add(mkWhisker(-0.06, 0.84, 1.00, -0.36, 0.78, 1.02));
    root.add(mkWhisker( 0.06, 0.92, 1.00,  0.40, 0.98, 1.02));
    root.add(mkWhisker( 0.06, 0.88, 1.00,  0.40, 0.85, 1.02));
    root.add(mkWhisker( 0.06, 0.84, 1.00,  0.36, 0.78, 1.02));

    root.position.set(lane * laneWidth, 0, 0);
    scene.add(root);
    this.group = root;
    return this;
  }

  /**
   * env: { playerDistance, playerSpeed, playerX, playerY, obstacles,
   *        scenery, buildings, collectibles, courseLength, laneWidth }
   */
  update(delta, env = {}) {
    if (!this.group) return;
    const playerDistance = env.playerDistance || 0;
    const playerSpeed    = (typeof env.playerSpeed === 'number' && env.playerSpeed > 0)
      ? env.playerSpeed : JANA_BUNNY.RABBIT_SPEED;
    const obstacles      = env.obstacles    || [];
    const scenery        = env.scenery      || [];
    const buildings      = env.buildings    || [];
    const collectibles   = env.collectibles || [];
    const laneWidth      = env.laneWidth    || this._laneWidth;
    const playerX        = env.playerX      || 0;
    const playerY        = env.playerY      || 0;

    // Build a unified threat set for THIS frame. Each entry has:
    //   { obj, dist, lane, kind, height, len, width, x }
    // dist = world-distance from rabbit (positive = ahead).
    const threats = this._collectThreats(obstacles, scenery, buildings, playerDistance);

    // The player itself is also a threat the rabbit can't penetrate.
    threats.push({
      obj:    { __isPlayer: true },
      dist:   playerDistance - this.distance,
      x:      playerX,
      lane:   Math.round(playerX / laneWidth),
      kind:   'player',
      height: 1.6,         // tall enough that rabbit's HIGH hop just barely clears
      len:    2.0,
      width:  1.4,
      playerY,
    });

    // ── 1. Penalty timer
    if (this._penaltyT > 0) this._penaltyT = Math.max(0, this._penaltyT - delta);

    // ── 2. Forward speed (proposed)
    const baseSpeed = playerSpeed * JANA_BUNNY.RABBIT_SPEED_MULT;
    const speedMul  = this._penaltyT > 0 ? JANA_BUNNY.COLLISION_SPEED_MULT : 1.0;
    const speed     = baseSpeed * speedMul;

    // ── 3. Lane planning
    this._planLane(threats, collectibles, playerDistance);

    // ── 4. Lane X interpolation
    const targetX = this._targetLane * laneWidth;
    const currentX = this.group.position.x;
    const k = JANA_BUNNY.LANE_SWITCH_RATE;
    this.group.position.x = currentX + (targetX - currentX) * Math.min(1, k * delta);
    if (Math.abs(this.group.position.x - targetX) < 0.05) {
      this.lane = this._targetLane;
      this.group.position.x = targetX;
    }

    // ── 5. Hop arc — schedule new hop when grounded
    if (!this._inHop) this._startHop(threats, speed);
    this._hopVel -= JANA_BUNNY.HOP_GRAVITY * delta;
    this._hopY   += this._hopVel * delta;
    if (this._hopY <= 0) {
      this._hopY = 0;
      this._hopVel = 0;
      this._inHop = false;
    }

    // ── 6. HARD PHYSICS — clamp forward advance against any uncleared
    //       threat ahead. The rabbit physically cannot pass through.
    const myX = this.group.position.x;
    const proposed = speed * delta;
    let safeAdvance = proposed;
    for (const t of threats) {
      // We only care about threats whose body the rabbit could enter
      // this frame (leading edge currently <= proposed advance).
      const leadingEdge = t.dist - t.len / 2;
      if (leadingEdge > proposed + 0.3) continue;       // too far ahead
      if (t.dist + t.len / 2 < -0.3) continue;          // already fully past
      if (this._canClear(t, this._hopY, myX)) continue; // rabbit will fly over / threads arch
      // Blocked. Clamp to just before the leading edge (or 0 if past).
      const stopAt = Math.max(0, leadingEdge - 0.2);
      if (stopAt < safeAdvance) safeAdvance = stopAt;
      // Mark resolved so the speed-cut penalty doesn't double-fire.
      if (!this._resolvedThreats.has(t.obj)) {
        this._resolvedThreats.add(t.obj);
        if (this._penaltyT <= 0) this._penaltyT = JANA_BUNNY.COLLISION_PENALTY_SEC;
      }
      // The pillar/wall might be wider than its leading edge alone —
      // keep scanning others in case they clamp tighter.
    }
    this.distance += safeAdvance;

    // ── 7. Coin pickup
    this._scoopCoins(collectibles, playerDistance);

    // ── 8. Render position + tilt + ear flap
    this.group.position.y = this._hopY;
    this.group.position.z = -(this.distance - playerDistance);
    const tilt = Math.atan2(this._hopVel, speed + 1) * 0.5;
    this.group.rotation.x = -tilt;
    if (this._earL && this._earR) {
      const earSwing = -tilt * 0.6;
      this._earL.rotation.x = earSwing;
      this._earR.rotation.x = earSwing;
    }
  }

  /**
   * Returns true if the rabbit at (hopY, myX) will SAFELY pass over /
   * around / through this threat. Used as the gate on forward advance:
   * if false, the rabbit's distance is clamped to just before the
   * threat's leading edge.
   */
  _canClear(t, hopY, myX) {
    if (t.kind === 'building') {
      // Threading the centre arch: must be in centre lane laterally
      // AND between archYMin..archYMax vertically (with margins).
      const insideArchX = Math.abs(myX) <= (t.archHalfW - 0.15);
      const insideArchY = (hopY >= t.archYMin + 0.3) &&
                          (hopY <= t.archYMax - 0.3);
      return insideArchX && insideArchY;
    }
    // Lateral clearance — outside threat's X footprint = safe.
    const halfW = t.width / 2 + 0.4;
    if (Math.abs(t.x - myX) > halfW) return true;
    if (t.kind === 'wall') {
      // Can't be cleared by jumping (too tall); only laneswerve out.
      return false;
    }
    if (t.kind === 'player') {
      // Can be cleared by jumping over OR by being in a different lane.
      // Player's body is short (~1.6m); HIGH hop (3.5m) clears.
      return hopY >= t.height + 0.2;
    }
    // 'ground' — cleared if hop arc puts us above the top.
    return hopY >= t.height - 0.2;
  }

  // ─────────────────────────────────────────────────────────────
  // Threat collection
  // ─────────────────────────────────────────────────────────────

  _collectThreats(obstacles, scenery, buildings, playerDistance) {
    const out = [];
    for (const o of obstacles) {
      if (!o.userData) continue;
      const d = playerDistance + o.position.z - this.distance;
      out.push({
        obj: o,
        dist: d,
        x: o.position.x ?? 0,
        lane: this._laneFor(o),
        kind: 'ground',
        height: o.userData.height ?? 1.0,
        len: o.userData.length ?? 1.5,
        width: o.userData.width ?? 1.5,
      });
    }
    for (const s of scenery) {
      if (!s.userData || !s.userData.collidable) continue;
      const d = playerDistance + s.position.z - this.distance;
      const h = s.userData.height ?? 4.0;
      // Tall scenery (>3.5m we can't HIGH-hop) is a 'wall'; short signs
      // are still 'ground' and HIGH-hoppable.
      const kind = h > 3.5 ? 'wall' : 'ground';
      out.push({
        obj: s,
        dist: d,
        x: s.position.x ?? 0,
        lane: this._laneFor(s),
        kind,
        height: h,
        len: s.userData.length ?? 1.0,
        width: s.userData.width ?? 1.0,
      });
    }
    for (const b of buildings) {
      if (!b.userData || b.userData.kind !== 'building') continue;
      // Building's centre Z and full length define a band the rabbit
      // crosses through. Treat as a special 'building' threat.
      const d = playerDistance + b.position.z - this.distance;
      out.push({
        obj: b,
        dist: d,
        x: b.position.x ?? 0,
        lane: 0, // arch is centred
        kind: 'building',
        height: b.userData.height ?? 12.0,
        len: b.userData.length ?? 30.0,
        width: b.userData.width ?? 6.0,
        archHalfW: b.userData.archHalfW ?? 1.5,
        archYMin:  b.userData.archYMin  ?? 3.0,
        archYMax:  b.userData.archYMax  ?? 8.0,
      });
    }
    return out;
  }

  _laneFor(obj) {
    if (obj.userData && typeof obj.userData.lane === 'number') return obj.userData.lane - 1;
    return Math.round((obj.position.x ?? 0) / this._laneWidth);
  }

  // ─────────────────────────────────────────────────────────────
  // Lane planning
  // ─────────────────────────────────────────────────────────────

  _planLane(threats, collectibles, playerDistance) {
    const window = JANA_BUNNY.SWERVE_LOOKAHEAD_M;
    // Building override: if a building's leading edge is within ~30m,
    // FORCE centre lane regardless of other scoring.
    for (const t of threats) {
      if (t.kind !== 'building') continue;
      const leadingEdge = t.dist - t.len / 2;
      if (leadingEdge > 0 && leadingEdge < 30) {
        this._targetLane = 0;
        return;
      }
    }
    const score = [0, 0, 0]; // by laneIndex+1
    for (const t of threats) {
      if (t.dist <= 0 || t.dist > window) continue;
      if (t.kind === 'wall') {
        const idx = t.lane + 1;
        if (idx >= 0 && idx <= 2) score[idx] += 5;
      } else if (t.kind === 'ground') {
        const idx = t.lane + 1;
        if (idx >= 0 && idx <= 2) score[idx] += 1;
      } else if (t.kind === 'player') {
        // Rabbit prefers NOT to share a lane with the penguin —
        // costly if very close, mild penalty further out.
        const idx = t.lane + 1;
        const closeness = 1 - Math.min(1, t.dist / window);
        if (idx >= 0 && idx <= 2) score[idx] += 4 * closeness;
      }
    }
    // Coins pull the rabbit slightly toward their lane (small bonus).
    for (const c of collectibles) {
      if (!c || c.userData.collected) continue;
      const cd = (playerDistance + c.position.z) - this.distance;
      if (cd <= 0 || cd > window) continue;
      const cl = Math.round((c.position.x ?? 0) / this._laneWidth);
      const idx = cl + 1;
      if (idx >= 0 && idx <= 2) score[idx] -= 0.3;
    }
    // Pick the cheapest lane with a tiny preference for adjacency.
    let bestLane = this._targetLane;
    let bestScore = score[bestLane + 1] + 0; // current lane has no penalty
    for (const tryLane of [-1, 0, 1]) {
      const s = score[tryLane + 1]
              + (Math.abs(tryLane - this._targetLane) > 1 ? 0.4 : 0);
      if (s < bestScore - 0.01) {
        bestLane = tryLane;
        bestScore = s;
      }
    }
    this._targetLane = bestLane;
  }

  // ─────────────────────────────────────────────────────────────
  // Hop scheduling
  // ─────────────────────────────────────────────────────────────

  _startHop(threats, speed) {
    // Inspect threats in current target lane within HIGH/MEGA hop range
    // and pick the appropriate peak.
    const highRange = hopRange(JANA_BUNNY.HOP_PEAK_HIGH, JANA_BUNNY.HOP_GRAVITY, speed);
    const megaRange = hopRange(JANA_BUNNY.HOP_PEAK_MEGA, JANA_BUNNY.HOP_GRAVITY, speed);
    let peak = JANA_BUNNY.HOP_PEAK_LOW;
    let nearestGroundDist = Infinity;
    let buildingAhead = null;
    for (const t of threats) {
      if (t.dist <= 0) continue;
      if (t.kind === 'building') {
        // Trigger MEGA when the rabbit is ~half a mega-hop away, so the
        // arc peak lands at the building's centre.
        const leading = t.dist - t.len / 2;
        if (leading <= megaRange * 0.55) buildingAhead = t;
      } else if (t.kind === 'ground' && t.lane === this._targetLane) {
        if (t.dist < nearestGroundDist) nearestGroundDist = t.dist;
      }
      // 'wall' is handled by lane swerve; the rabbit never tries to
      // hop a tall tree/lamp.
    }
    if (buildingAhead) {
      peak = JANA_BUNNY.HOP_PEAK_MEGA;
    } else if (nearestGroundDist < highRange) {
      peak = JANA_BUNNY.HOP_PEAK_HIGH;
    }
    this._hopVel = Math.sqrt(2 * JANA_BUNNY.HOP_GRAVITY * peak);
    this._hopY = 0.001;
    this._inHop = true;
    this._lastPeak = peak;
  }

  // ─────────────────────────────────────────────────────────────
  // Coin pickup
  // ─────────────────────────────────────────────────────────────

  _scoopCoins(collectibles, playerDistance) {
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

  hasFinished(courseLength) {
    return courseLength > 0 && this.distance >= courseLength;
  }

  dispose() {
    if (!this.group || !this._scene) return;
    this._scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.isMesh || o.isLine) {
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
