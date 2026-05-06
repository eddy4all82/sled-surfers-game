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

const RABBIT_X_MIN = -6;
const RABBIT_X_MAX = 6;
const RABBIT_MAX_SIDE_STEP = 2.75;
const MEDIUM_CLEARANCE_MARGIN = 0.45;
const MEDIUM_MAX_CLEAR_HEIGHT = 3.0;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export class Rabbit {
  constructor() {
    this.group = null;
    this.distance = 0;
    this.lane = 0;                 // start in centre — useful for first building
    this._targetLane = 0;
    this._targetX = 0;
    this._scene = null;
    this._laneWidth = 3;

    this._hopY = 0;
    this._hopVel = 0;
    this._hopGravity = JANA_BUNNY.HOP_GRAVITY;  // per-hop gravity, set in _startHop
    this._hopElapsed = 0;               // seconds elapsed in current hop
    this._hopDuration = JANA_BUNNY.HOP_TIME;
    this._hopStartX = 0;                // rabbit X at start of current hop
    this._hopTargetX = 0;               // rabbit X at landing (lane committed for this hop)
    this._hopLaneTarget = 0;            // lane index the hop will land in
    this._inHop = false;
    this._lastPeak = JANA_BUNNY.HOP_PEAK_LOW;
    this._lastHopKind = 'low';
    this._lastLandingDustPeak = 0;
    this._settleT = 0;                  // brief settle window after a MEGA landing
    this._megaCooldownT = 0;            // seconds until MEGA is available again
    this._mediumDecayLeft = 0;          // hops remaining in post-MEDIUM decay
    this._mediumDecayPeak = JANA_BUNNY.HOP_PEAK_MEDIUM;
    this._dead = false;                 // set once a fatal collision fires
    // Diagnostics: enable from DevTools via `window.__game.rabbit._debug = true`
    // Logs the threat being collided with each time the bbox check fires,
    // plus a per-frame nearby-threat summary so missing-threat bugs are
    // visible in the console.
    this._debug = false;
    this._debugFrame = 0;

    this._penaltyT = 0;
    this._resolvedThreats = new WeakSet();

    this._body = null;
    this._head = null;
    this._pawL = null;
    this._pawR = null;
    this._haunchL = null;
    this._haunchR = null;
    this._footL = null;
    this._footR = null;
    this._tail = null;
    this._earL = null;
    this._earR = null;
    this._partRest = new Map();
    this._groundShadow = null;
    this._dustPuffs = [];
  }

  init(scene, { lane = 0, laneWidth = 3 } = {}) {
    this._scene = scene;
    this.lane = lane;
    this._targetLane = lane;
    this._targetX = clamp(lane * laneWidth, RABBIT_X_MIN, RABBIT_X_MAX);
    this._laneWidth = laneWidth;
    this.distance = 0;
    this._hopY = 0;
    this._hopVel = 0;
    this._hopGravity = JANA_BUNNY.HOP_GRAVITY;
    this._hopDuration = JANA_BUNNY.HOP_TIME;
    this._inHop = false;
    this._penaltyT = 0;
    this._settleT = 0;
    this._megaCooldownT = 0;
    this._mediumDecayLeft = 0;
    this._mediumDecayPeak = JANA_BUNNY.HOP_PEAK_MEDIUM;
    this._lastHopKind = 'low';
    this._lastLandingDustPeak = 0;
    this._dead = false;
    this._partRest.clear();
    this._dustPuffs = [];

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
    this._body = body;

    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), bellyMat);
    belly.scale.set(0.9, 0.7, 1.0);
    belly.position.set(0, 0.55, 0.25);
    root.add(belly);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 14), furMat);
    head.position.set(0, 1.05, 0.55);
    head.castShadow = true;
    root.add(head);
    this._head = head;

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
      this._pawL = pawL;
      const pawR = new THREE.Mesh(pawGeo, furMat);
      pawR.scale.set(0.9, 0.8, 1.5);
      pawR.position.set(0.18, 0.25, 0.55);
      root.add(pawR);
      this._pawR = pawR;

    const haunchGeo = new THREE.SphereGeometry(0.32, 12, 10);
      const haunchL = new THREE.Mesh(haunchGeo, furMat);
      haunchL.scale.set(0.7, 1.0, 1.4);
      haunchL.position.set(-0.42, 0.45, -0.25);
      root.add(haunchL);
      this._haunchL = haunchL;
      const haunchR = new THREE.Mesh(haunchGeo, furMat);
      haunchR.scale.set(0.7, 1.0, 1.4);
      haunchR.position.set(0.42, 0.45, -0.25);
      root.add(haunchR);
      this._haunchR = haunchR;

    const footGeo = new THREE.SphereGeometry(0.18, 10, 8);
      const footL = new THREE.Mesh(footGeo, furMat);
      footL.scale.set(1.0, 0.7, 2.0);
      footL.position.set(-0.32, 0.18, 0.05);
      root.add(footL);
      this._footL = footL;
      const footR = new THREE.Mesh(footGeo, furMat);
      footR.scale.set(1.0, 0.7, 2.0);
      footR.position.set(0.32, 0.18, 0.05);
      root.add(footR);
      this._footR = footR;

      const tail = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), bellyMat);
      tail.position.set(0, 0.85, -0.85);
      root.add(tail);
      this._tail = tail;

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

    // Scale the whole bunny to 69% of its design size (60% × 1.15
    // bump). Single uniform scale keeps proportions intact and shrinks
    // the entire mesh tree at once. Pair this with BODY_HALF_W/L in
    // JANA_BUNNY so collisions match what's drawn.
    root.scale.setScalar(0.69);

      root.position.set(lane * laneWidth, 0, 0);
      scene.add(root);
      this.group = root;
      this._captureRestPose();
      this._createAirShadow();
      return this;
    }

  /**
   * env: { playerDistance, playerSpeed, playerX, playerY, obstacles,
   *        scenery, buildings, collectibles, courseLength, laneWidth }
   */
  update(delta, env = {}) {
    if (!this.group || this._dead) return;
    const playerDistance = env.playerDistance || 0;
    const playerSpeed    = (typeof env.playerSpeed === 'number' && env.playerSpeed > 0)
      ? env.playerSpeed : JANA_BUNNY.RABBIT_SPEED;
    const obstacles      = env.obstacles    || [];
    const scenery        = env.scenery      || [];
    const buildings      = env.buildings    || [];
    const crossStreets   = env.crossStreets || [];
    const ramps          = env.ramps        || [];
    const drones         = env.drones       || [];
    const collectibles   = env.collectibles || [];
    const laneWidth      = env.laneWidth    || this._laneWidth;
    const playerX        = env.playerX      || 0;
    const playerY        = env.playerY      || 0;
    const onCollide      = typeof env.onRabbitCollide === 'function' ? env.onRabbitCollide : null;

    // Build a unified threat set for THIS frame. Each entry has:
    //   { obj, dist, lane, kind, height, len, width, x }
    // dist = world-distance from rabbit (positive = ahead).
    // Need a speed estimate for cross-traffic prediction. Use the same
    // formula the forward-advance step uses (playerSpeed × multiplier).
    const _baseSpeedForThreats = playerSpeed * JANA_BUNNY.RABBIT_SPEED_MULT;
    const threats = this._collectThreats(
      obstacles, scenery, buildings, crossStreets, ramps, drones,
      playerDistance, _baseSpeedForThreats
    );

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

    // ── 1. Cooldown / settle timers
    if (this._megaCooldownT > 0) this._megaCooldownT = Math.max(0, this._megaCooldownT - delta);
    if (this._penaltyT > 0)      this._penaltyT      = Math.max(0, this._penaltyT - delta);

    // ── 2. Forward speed (proposed)
    const baseSpeed = playerSpeed * JANA_BUNNY.RABBIT_SPEED_MULT;
    const speed     = baseSpeed; // no more penalty multiplier — collisions are now fatal, not slowdowns

      // ── 3. Free-space planning. The rabbit can aim anywhere across
      //       the playable width, while still using only LOW/MEDIUM/MEGA
      //       hop families for vertical decisions.
      this._planPath(threats, collectibles, playerDistance);

      // ── 4. Hop scheduling + arc + free lateral aim. X motion is still
      //       committed per hop so the rabbit reads as jumping, not
      //       sliding sideways through hazards.
      if (this._settleT > 0) this._settleT = Math.max(0, this._settleT - delta);
      if (!this._inHop && this._settleT <= 0) this._startHop(threats, speed, laneWidth);
      if (this._inHop) {
      this._hopElapsed += delta;
      this._hopVel -= this._hopGravity * delta;
      this._hopY   += this._hopVel * delta;
      // X follows a smooth-step from start lane to landing lane over
      // the hop's full duration.
        const tProgress = Math.min(1, this._hopElapsed / this._hopDuration);
      const tSmooth   = tProgress * tProgress * (3 - 2 * tProgress);
      this.group.position.x = this._hopStartX
        + (this._hopTargetX - this._hopStartX) * tSmooth;
        if (this._hopY <= 0) {
          this._hopY = 0;
          this._hopVel = 0;
          this._inHop = false;
          // Commit the horizontal landing target.
          this.lane = Math.round(this._hopTargetX / laneWidth);
          this.group.position.x = this._hopTargetX;
          this._spawnLandingDust(this._lastLandingDustPeak, this.group.position.x, this.group.position.z);
          // If the hop we just finished was a MEGA, give the rabbit a
          // brief grounded settle (~0.18s) before launching into rapid
        // running hops. Avoids the abrupt "land + ricochet" feel.
        if (this._lastPeak >= JANA_BUNNY.HOP_PEAK_MEGA - 0.01) {
          this._settleT = 0.18;
        }
        }
      } else {
        // Grounded — hold the last landing spot until the next hop.
        this.group.position.x = this._hopTargetX || this.group.position.x;
      }

    // ── 6. HARD PHYSICS — bounding-box collision check using the
    //       rabbit's body half-extents. Fires a FATAL collision
    //       callback (game ends, player wins) if the rabbit's body
    //       overlaps an uncleared threat. The X-clamp + smart hop
    //       scheduling are designed to keep this from firing — but
    //       if the AI ever fails (e.g. all 3 lanes blocked, or MEGA
    //       on cooldown when a building hits) it surfaces here.
    const myX = this.group.position.x;
    const proposedAdvance = speed * delta;
    const proposedDistance = this.distance + proposedAdvance;
    // Debug: every ~30 frames, print a snapshot of nearby threats
    // (≤20m ahead, ≤2m laterally) so we can see what the rabbit
    // perceives. Toggle with `game.rabbit._debug = true` in DevTools.
    if (this._debug && (this._debugFrame++ % 30 === 0)) {
      const nearby = threats
        .filter((t) => t.dist > -2 && t.dist < 20 && Math.abs(t.x - myX) < 4)
        .map((t) => `${t.kind}@(dist=${t.dist.toFixed(1)},x=${t.x.toFixed(1)},h=${t.height.toFixed(1)})`);
      // eslint-disable-next-line no-console
      console.log(`[rabbit] d=${this.distance.toFixed(1)} x=${myX.toFixed(2)} hopY=${this._hopY.toFixed(2)} lane=${this._targetLane} | nearby:`, nearby);
    }
    for (const t of threats) {
      // Test whether the rabbit's body box would overlap this threat
      // after the advance. Inflate threat's halves by rabbit body
      // half-extents.
      const bodyHalfL = JANA_BUNNY.BODY_HALF_L;
      const bodyHalfW = JANA_BUNNY.BODY_HALF_W;
        const halfL = t.len / 2 + bodyHalfL;
        // Threat's distance after rabbit advances:
        const dAfter = t.dist - proposedAdvance;
        if (dAfter > halfL || dAfter < -halfL) {
          if (t.kind === 'building' && t.obj?.userData) t.obj.userData._rabbitInArch = false;
          continue;            // out of Z band
        }
      // Inflate lateral by body width.
      if (t.kind === 'building') {
        // Building special: pillars are everywhere except the central
        // arch. If we're inside the building's Z band:
          const insideArchX = (myX - bodyHalfW >= -t.archHalfW + 0.1) &&
                              (myX + bodyHalfW <=  t.archHalfW - 0.1);
          const entryArchY = (this._hopY >= t.archYMin - 0.2) &&
                             (this._hopY <= t.archYMax + 0.5);
          const continuingArchY = this._hopY <= t.archYMax + 0.6;
          if (!t.obj.userData._rabbitInArch && insideArchX && entryArchY) {
            t.obj.userData._rabbitInArch = true;
            continue;
          }
          if (t.obj.userData._rabbitInArch && insideArchX && continuingArchY) {
            if (this._hopY < t.archYMin) this._hopY = t.archYMin;
            continue;                  // threading / running through the arch — safe
          }
        if (onCollide && !this._resolvedThreats.has(t.obj)) {
          this._resolvedThreats.add(t.obj);
          this._fatalHit(onCollide, t);
          return;
        }
        continue;
      }
      const halfW = t.width / 2 + bodyHalfW;
      if (Math.abs(t.x - myX) > halfW) continue;                   // lateral miss
      // Vertical clearance — depends on threat kind.
      let cleared = false;
      if (t.kind === 'ground') {
        cleared = (this._hopY >= t.height - 0.1);
      } else if (t.kind === 'player') {
        cleared = (this._hopY >= t.height + 0.2);
      } else if (t.kind === 'aerial') {
        // Drone-style: clear if rabbit body is fully below or fully
        // above the threat's Y band.
        const top    = this._hopY + 0.9;
        const bottom = this._hopY;
        const tBot = (t.y ?? 4) - (t.yHalf ?? 0.5);
        const tTop = (t.y ?? 4) + (t.yHalf ?? 0.5);
        cleared = (top < tBot - 0.1) || (bottom > tTop + 0.1);
      } else {
        cleared = false;                                            // 'wall'
      }
      if (cleared) continue;
      if (onCollide && !this._resolvedThreats.has(t.obj)) {
        this._resolvedThreats.add(t.obj);
        this._fatalHit(onCollide, t);
        return;
      }
    }
    // No fatal hit — advance.
    this.distance = proposedDistance;

    // ── 7. Coin pickup
    this._scoopCoins(collectibles, playerDistance);

    // ── 8. Render position + tilt + ear flap
    this.group.position.y = this._hopY;
    // Screen-Z convention: world is rendered with the player at z=0
    // and obstacles ahead at +z (camera looks +z toward lookAt z=+20).
    // So the rabbit's screen-Z must be POSITIVE when it's ahead in
    // the race (further along the course) and NEGATIVE (off-camera
    // behind) when it's lagging. distance - playerDistance gives
    // exactly that.
    this.group.position.z = (this.distance - playerDistance);
    const tilt = Math.atan2(this._hopVel, speed + 1) * 0.5;
    this.group.rotation.x = -tilt;
      if (this._earL && this._earR) {
        const earSwing = -tilt * 0.6;
        this._earL.rotation.x = earSwing;
        this._earR.rotation.x = earSwing;
      }
      this._updateAnimation(delta, speed);
      this._updateAirShadow();
      this._updateDust(delta, playerSpeed);
    }

  /**
   * Lateral X clamp — refuses to slide the rabbit through a threat's
   * footprint when the rabbit is currently within (or about to be
   * within) the threat's Z band AND can't clear it vertically.
   *
   * This is what stops the rabbit from "phasing through" a tree/lamp
   * during a lane swerve while the forward distance is already
   * clamped at the leading edge.
   */
  _clampLateralX(currentX, proposedX, threats) {
    if (proposedX === currentX) return proposedX;
    let resultX = proposedX;
    for (const t of threats) {
      // Only consider threats currently overlapping the rabbit's Z
      // band — those are the ones we could slide laterally into.
      const inBand = (t.dist > -(t.len / 2) - 0.5) && (t.dist < (t.len / 2) + 0.5);
      if (!inBand) continue;
      // If the rabbit can clear the threat vertically (or it's not
      // actually blocking us laterally at this Y), no clamp needed.
      if (this._canClear(t, this._hopY, resultX)) continue;
      // Unsafe at proposed X. If the current X is safe, hold X here.
      if (this._canClear(t, this._hopY, currentX)) {
        resultX = currentX;
        // Don't break — there might be other threats that demand
        // a different (smaller) X. We want the most-restrictive
        // safe X for this frame.
        continue;
      }
      // Else: already unsafe at currentX. Don't make it worse — pick
      // whichever direction moves us further from the threat centre.
      const movingToward = (proposedX > currentX) === (t.x > currentX);
      if (movingToward) resultX = currentX;
    }
    return resultX;
  }

  /**
   * Returns true if the rabbit at (hopY, myX) will SAFELY pass over /
   * around / through this threat. Used as the gate on forward advance:
   * if false, the rabbit's distance is clamped to just before the
   * threat's leading edge.
   */
    _canClear(t, hopY, myX) {
    const bodyHalfW = JANA_BUNNY.BODY_HALF_W;
    if (t.kind === 'building') {
      // Threading the centre arch: the rabbit's BODY (not just centre
      // point) must fit through the opening laterally + vertically.
      const insideArchX = (myX - bodyHalfW >= -t.archHalfW + 0.1) &&
                          (myX + bodyHalfW <=  t.archHalfW - 0.1);
      const insideArchY = (hopY >= t.archYMin + 0.3) &&
                          (hopY <= t.archYMax - 0.3);
      return insideArchX && insideArchY;
    }
    // Lateral clearance — outside threat's footprint (inflated by
    // rabbit body half-width) = safe.
    const halfW = t.width / 2 + bodyHalfW;
    if (Math.abs(t.x - myX) > halfW) return true;
    if (t.kind === 'wall') return false;            // tall scenery — must swerve
    if (t.kind === 'player') return hopY >= t.height + 0.2;
    if (t.kind === 'aerial') {
      // Drones / sky hazards: pass safely if the rabbit's BODY (with
      // its height ~0.9m above hopY) is entirely below the threat's
      // Y band, OR entirely above it. Otherwise lateral overlap means
      // collision.
      const rabbitBodyTop    = hopY + 0.9;
      const rabbitBodyBottom = hopY;
      const threatBottom = (t.y ?? 4) - (t.yHalf ?? 0.5);
      const threatTop    = (t.y ?? 4) + (t.yHalf ?? 0.5);
      if (rabbitBodyTop < threatBottom - 0.1) return true;  // rabbit safely below
      if (rabbitBodyBottom > threatTop + 0.1) return true;  // safely above
      return false;                                          // overlapping Y bands = unsafe
    }
      // 'ground' — cleared if hop arc puts us above the top.
      return hopY >= t.height - 0.1;
    }

    _threatOverlapsX(t, x) {
      const halfW = (t.width || 1) / 2 + JANA_BUNNY.BODY_HALF_W;
      return Math.abs((t.x || 0) - x) <= halfW;
    }

    _canMediumClear(t) {
      return t.kind === 'ground' && (t.height || 0) <= MEDIUM_MAX_CLEAR_HEIGHT;
    }

    _mediumPeakForHeight(height) {
      const needed = (height || 0) + MEDIUM_CLEARANCE_MARGIN;
      return clamp(
        needed,
        JANA_BUNNY.HOP_PEAK_LOW + 0.35,
        MEDIUM_MAX_CLEAR_HEIGHT + MEDIUM_CLEARANCE_MARGIN
      );
    }

  // ─────────────────────────────────────────────────────────────
  // Threat collection
  // ─────────────────────────────────────────────────────────────

  _collectThreats(obstacles, scenery, buildings, crossStreets, ramps, drones, playerDistance, rabbitSpeed) {
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
    // Cross-streets: cars crossing perpendicular to the rabbit's
    // direction of travel. Each car has userData.dir (±1) and .speed
    // (units/sec along X). Predict where each car will be at the
    // moment the rabbit reaches the street's Z so the AI can plan
    // around the actual collision point, not the snapshot position.
    for (const street of crossStreets) {
      if (!street || !street.userData || !street.userData.cars) continue;
      const streetDist = playerDistance + street.position.z - this.distance;
      // Skip far / passed streets. Only project while within reasonable
      // planning range — long-distance prediction is unreliable since
      // the cars cycle position when they leave the street.
      if (streetDist <= -3 || streetDist > 60) continue;
      const arrivalT = (streetDist > 0 && rabbitSpeed > 0)
        ? streetDist / rabbitSpeed : 0;
      for (const car of street.userData.cars) {
        if (!car || !car.userData) continue;
        // Mirror the engine's update: position.x -= dir * speed * dt
        const futureX = car.position.x
          - (car.userData.dir || 0) * (car.userData.speed || 0) * arrivalT;
        out.push({
          obj: car,
          // Distance to the STREET's Z, not the car's local Z (which
          // is just ±0.95 inside the 4-unit street depth).
          dist: streetDist,
          x: futureX,
          lane: Math.round(futureX / this._laneWidth),
          kind: 'ground',           // jumpable like static cars
          // The car's body runs ALONG X (it was rotated 90°), so its
          // length-in-X is its `len`-extent and its width-in-Z is
          // small. From the rabbit's POV: Z extent is the street's
          // depth (~1.5m car body), X extent is the car's length
          // (~3.5m typical).
          height: 1.4,
          len:    1.6,                // narrow Z window
          width:  3.6,                // wide X footprint
        });
      }
    }
    // Ramps — centre-lane wedges (lane 0 in this game). Treated as a
    // 'ground' threat so the lane planner avoids the centre lane near
    // them and the rabbit either swerves OR uses MEDIUM. Ramp height
    // is set just above MEDIUM peak so the rabbit slightly prefers
    // swerving but can MEDIUM-clear if it has to.
    for (const r of ramps) {
      if (!r || !r.userData) continue;
      const d = playerDistance + r.position.z - this.distance;
      out.push({
        obj: r,
        dist: d,
        x: r.position.x ?? 0,
        lane: this._laneFor(r),
        kind: 'ground',
        height: 2.2,
        len: r.userData.length ?? 10,
        width: 3.0,
      });
    }
    // Drones — hovering aerial threats at Y=3-8m. Use an 'aerial' kind
    // so _canClear knows the rabbit's body must miss the drone's Y
    // band entirely (not just clear its top — the drone is ABOVE the
    // ground, so the rabbit can also pass UNDER it). Lateral motion
    // is sine-wave so we just use the current X (cheap; drones don't
    // travel far).
    for (const d of drones) {
      if (!d) continue;
      const dist = playerDistance + d.position.z - this.distance;
      out.push({
        obj: d,
        dist,
        x: d.position.x,
        lane: Math.round((d.position.x ?? 0) / this._laneWidth),
        kind: 'aerial',
        y: d.position.y,           // drone centre Y
        yHalf: 0.55,               // half the drone body height
        height: d.position.y + 0.55,  // top, used by lane-planner score only
        len: 1.4,
        width: 1.4,
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

    _planPath(threats, collectibles, playerDistance) {
      const window = JANA_BUNNY.SWERVE_LOOKAHEAD_M;
      const myX = this.group ? this.group.position.x : this._targetX;
      const samples = [-6, -4.5, -3, -1.5, 0, 1.5, 3, 4.5, 6];

      // Middle-opening buildings are special race moments: the smart move
      // is to aim for the arch centre early, then let MEGA handle height.
      for (const t of threats) {
        if (t.kind !== 'building') continue;
        const leadingEdge = t.dist - t.len / 2;
        if (leadingEdge > 0 && leadingEdge < 36) {
          this._targetX = 0;
          this._targetLane = 0;
          return;
        }
      }

      let bestX = clamp(this._targetX, RABBIT_X_MIN, RABBIT_X_MAX);
      let bestScore = Infinity;
      for (const x of samples) {
        let score = Math.abs(x - myX) * 0.08;
        score += Math.abs(x) * 0.015; // tiny centre bias keeps motion tidy when all paths tie

        for (const t of threats) {
          if (t.dist <= -2 || t.dist > window) continue;
          const proximity = 1 - Math.min(1, Math.max(0, t.dist) / window);
          const halfW = (t.width || 1) / 2 + JANA_BUNNY.BODY_HALF_W;
          const lateralOverlap = Math.max(0, halfW - Math.abs((t.x || 0) - x));
          if (lateralOverlap <= 0) continue;

          if (t.kind === 'ground') {
            if (this._canMediumClear(t)) {
              score += 0.45 + proximity * 0.85 + lateralOverlap * 0.35;
            } else {
              score += 30 + proximity * 25 + lateralOverlap * 6;
            }
          } else if (t.kind === 'wall') {
            score += 40 + proximity * 35 + lateralOverlap * 8;
          } else if (t.kind === 'player') {
            score += 6 + proximity * 8 + lateralOverlap * 3;
          } else if (t.kind === 'aerial') {
            score += 1.5 + proximity * 2;
          }
        }

        for (const c of collectibles) {
          if (!c || c.userData.collected) continue;
          const cd = (playerDistance + c.position.z) - this.distance;
          if (cd <= 0 || cd > window) continue;
          const coinDx = Math.abs((c.position.x ?? 0) - x);
          if (coinDx < 1.0) score -= 0.35 * (1 - cd / window);
        }

        if (score < bestScore) {
          bestScore = score;
          bestX = x;
        }
      }

      this._targetX = clamp(bestX, RABBIT_X_MIN, RABBIT_X_MAX);
      this._targetLane = Math.round(this._targetX / this._laneWidth);
    }

  // ─────────────────────────────────────────────────────────────
  // Hop scheduling
  // ─────────────────────────────────────────────────────────────

  /**
   * Schedule the next hop. THREE modes — every mode shares HOP_TIME
   * so all three cover the same horizontal distance. Per-hop gravity
   * is derived to make peak height match while keeping time aloft
   * constant.
   *
   *   • LOW    — natural running gait. Default when no threat.
   *   • MEDIUM — clears a ground hazard (car/rock/sign) in the
   *              current lane within a hop's forward range. After
   *              firing, sets _mediumDecayLeft = MEDIUM_DECAY_STEPS,
   *              so the next 2 hops decay back toward LOW instead of
   *              snapping straight to the running gait.
   *   • MEGA   — building tunnel threading. Uses the same HOP_TIME
   *              so its forward range matches the others, with peak
   *              just much higher. Subject to MEGA_COOLDOWN_SEC.
   */
    _startHop(threats, speed, laneWidth) {
      let T = JANA_BUNNY.HOP_TIME;
      const hopForward = speed * T;
      const megaDuration = 0.85;
      const megaForward = speed * megaDuration;
      const currentX = this.group ? this.group.position.x : this._hopTargetX;
      const targetX = clamp(this._targetX, RABBIT_X_MIN, RABBIT_X_MAX);
      const dx = clamp(targetX - currentX, -RABBIT_MAX_SIDE_STEP, RABBIT_MAX_SIDE_STEP);
      const landingX = clamp(currentX + dx, RABBIT_X_MIN, RABBIT_X_MAX);
      this._hopStartX     = currentX;
      this._hopTargetX    = landingX;
      this._hopLaneTarget = Math.round(landingX / (laneWidth || this._laneWidth));
      this._hopElapsed    = 0;
      let peak = JANA_BUNNY.HOP_PEAK_LOW;
      let hopKind = 'low';
      let nearestObstacleDist = Infinity;
      let nearestObstacleHeight = 0;
      let buildingAhead = null;
      for (const t of threats) {
        if (t.dist <= 0) continue;
        if (t.kind === 'building') {
          const leading = t.dist - t.len / 2;
        // Trigger MEGA when the rabbit is within a few hops of the
        // building (so the arc apex lands inside the arch).
          if (leading <= megaForward * 0.72) buildingAhead = t;
        } else if (t.kind === 'ground' && this._threatOverlapsX(t, landingX)) {
          if (!this._canMediumClear(t)) continue;
          if (t.dist < nearestObstacleDist) nearestObstacleDist = t.dist;
          nearestObstacleHeight = Math.max(nearestObstacleHeight, t.height || 0);
        }
      }
      if (buildingAhead && this._megaCooldownT <= 0) {
        T = megaDuration;
        peak = JANA_BUNNY.HOP_PEAK_MEGA;
        hopKind = 'mega';
        this._megaCooldownT = JANA_BUNNY.MEGA_COOLDOWN_SEC;
        this._mediumDecayLeft = 0;        // MEGA cancels any pending decay
        this._targetX = 0;
      } else if (nearestObstacleDist < hopForward * 1.1) {
        // Obstacle within reach → MEDIUM, but sized to the obstacle
        // instead of a fixed jump. It can clear up to 3m and then
        // settles down over the next two hops.
        peak = this._mediumPeakForHeight(nearestObstacleHeight);
        hopKind = 'medium';
        this._mediumDecayLeft = JANA_BUNNY.MEDIUM_DECAY_STEPS;
        this._mediumDecayPeak = peak;
      } else if (this._mediumDecayLeft > 0) {
        // Post-MEDIUM decay: linearly blend between MEDIUM and LOW so
        // the rabbit settles down over a couple of hops.
        const total = JANA_BUNNY.MEDIUM_DECAY_STEPS;
        // remaining=2 → step 1 of decay (high), remaining=1 → step 2 (lower)
        const blend = this._mediumDecayLeft / (total + 1);
        peak = JANA_BUNNY.HOP_PEAK_LOW
             + blend * (this._mediumDecayPeak - JANA_BUNNY.HOP_PEAK_LOW);
        hopKind = 'medium_decay';
        this._mediumDecayLeft--;
      } else {
        peak = JANA_BUNNY.HOP_PEAK_LOW;
        hopKind = 'low';
      }
    // Solve for v and g so the arc reaches `peak` in time T:
    //   v = 4 h / T,  g = 2 v / T  =  8 h / T²
    // Forward distance D = speed × T is independent of peak — every
    // hop covers the same horizontal span.
      this._hopDuration = T;
      this._hopVel     = 4 * peak / T;
    this._hopGravity = 2 * this._hopVel / T;
      this._hopY = 0.001;
      this._inHop = true;
      this._lastPeak = peak;
      this._lastHopKind = hopKind;
      this._lastLandingDustPeak = peak;
    }

  /**
   * Mark the rabbit as dead and notify the host. The host (game.js)
   * is expected to transition to a "player wins" state.
   */
  _fatalHit(callback, threat) {
    if (this._dead) return;
    this._dead = true;
    if (this._debug) {
      // eslint-disable-next-line no-console
      console.log('[rabbit] FATAL HIT:', threat ? {
        kind:   threat.kind,
        dist:   threat.dist?.toFixed(2),
        x:      threat.x?.toFixed(2),
        height: threat.height,
        len:    threat.len,
        width:  threat.width,
      } : 'unknown');
    }
    callback(threat ? threat.kind : 'unknown');
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

    _captureRestPose() {
      this._partRest.clear();
      const parts = [
        this._body, this._head, this._pawL, this._pawR, this._haunchL,
        this._haunchR, this._footL, this._footR, this._tail,
        this._earL, this._earR,
      ];
      for (const part of parts) {
        if (!part) continue;
        this._partRest.set(part, {
          position: part.position.clone(),
          rotation: part.rotation.clone(),
        });
      }
    }

    _resetPart(part) {
      const rest = this._partRest.get(part);
      if (!part || !rest) return;
      part.position.copy(rest.position);
      part.rotation.copy(rest.rotation);
    }

    _updateAnimation(delta, speed) {
      const parts = [
        this._body, this._head, this._pawL, this._pawR, this._haunchL,
        this._haunchR, this._footL, this._footR, this._tail,
        this._earL, this._earR,
      ];
      for (const part of parts) this._resetPart(part);

      const peakRatio = clamp(
        (this._lastPeak - JANA_BUNNY.HOP_PEAK_LOW) /
        (JANA_BUNNY.HOP_PEAK_MEGA - JANA_BUNNY.HOP_PEAK_LOW),
        0, 1
      );
      const hopT = this._inHop ? clamp(this._hopElapsed / this._hopDuration, 0, 1) : 0;
      const cycle = this._inHop
        ? Math.sin(hopT * Math.PI)
        : Math.sin((performance.now() * 0.001) * (8 + speed * 0.05)) * 0.25;
      const tuck = this._inHop ? Math.sin(hopT * Math.PI) : 0;
      const push = this._inHop ? Math.sin(hopT * Math.PI * 2) : 0;
      const landing = (!this._inHop && this._lastLandingDustPeak > JANA_BUNNY.HOP_PEAK_LOW)
        ? clamp(this._settleT / 0.18, 0, 1) : 0;

      if (this._body) {
        this._body.rotation.x += -0.18 * push - 0.22 * peakRatio * tuck;
        this._body.position.y += 0.06 * tuck - 0.08 * landing;
      }
      if (this._head) {
        this._head.rotation.x += 0.22 * push - 0.18 * peakRatio * tuck;
        this._head.position.y += 0.05 * tuck - 0.04 * landing;
      }
      if (this._pawL && this._pawR) {
        const pawTuck = 0.55 * tuck + 0.25 * peakRatio;
        this._pawL.rotation.x += -pawTuck + cycle * 0.25;
        this._pawR.rotation.x += -pawTuck - cycle * 0.25;
        this._pawL.position.z += 0.10 * tuck;
        this._pawR.position.z += 0.10 * tuck;
      }
      if (this._haunchL && this._haunchR) {
        this._haunchL.rotation.x += 0.35 * tuck - cycle * 0.18;
        this._haunchR.rotation.x += 0.35 * tuck + cycle * 0.18;
      }
      if (this._footL && this._footR) {
        const kick = 0.65 * tuck + 0.35 * peakRatio;
        this._footL.rotation.x += kick + cycle * 0.35;
        this._footR.rotation.x += kick - cycle * 0.35;
        this._footL.position.z -= 0.18 * tuck;
        this._footR.position.z -= 0.18 * tuck;
      }
      if (this._tail) {
        this._tail.rotation.x += 0.25 * push;
        this._tail.position.y += 0.03 * tuck;
      }
      if (this._earL && this._earR) {
        const earLayback = 0.45 * tuck + 0.35 * peakRatio;
        this._earL.rotation.x += -earLayback;
        this._earR.rotation.x += -earLayback;
        this._earL.rotation.z += cycle * 0.08;
        this._earR.rotation.z -= cycle * 0.08;
      }
    }

    _createAirShadow() {
      if (!this._scene || this._groundShadow) return;
      const mat = new THREE.MeshBasicMaterial({
        color: 0x1d2430,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.75, 24), mat);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.035;
      shadow.renderOrder = 3;
      this._scene.add(shadow);
      this._groundShadow = shadow;
    }

    _updateAirShadow() {
      if (!this._groundShadow || !this.group) return;
      const height = Math.max(0, this._hopY);
      this._groundShadow.visible = height > 0.08;
      this._groundShadow.position.x = this.group.position.x;
      this._groundShadow.position.z = this.group.position.z;
      const spread = 1 + Math.min(2.2, height * 0.18);
      this._groundShadow.scale.set(spread, spread * 0.62, 1);
      this._groundShadow.material.opacity = clamp(0.22 - height * 0.018, 0.07, 0.22);
    }

    _spawnLandingDust(peak, x, z) {
      if (!this._scene || peak <= JANA_BUNNY.HOP_PEAK_LOW + 0.02) return;
      const strength = clamp(
        (peak - JANA_BUNNY.HOP_PEAK_LOW) /
        (JANA_BUNNY.HOP_PEAK_MEGA - JANA_BUNNY.HOP_PEAK_LOW),
        0.12, 1
      );
      const count = Math.round(3 + strength * 9);
      for (let i = 0; i < count; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: 0xf3f7ff,
          transparent: true,
          opacity: 0.42 * strength,
          depthWrite: false,
        });
        const puff = new THREE.Mesh(new THREE.SphereGeometry(0.08 + strength * 0.08, 8, 6), mat);
        const side = (i / Math.max(1, count - 1) - 0.5) * 1.4;
        puff.position.set(x + side * (0.35 + strength), 0.08, z - 0.2 + Math.random() * 0.5);
        puff.userData.life = 0.35 + strength * 0.25;
        puff.userData.maxLife = puff.userData.life;
        puff.userData.vx = side * (0.6 + strength * 0.7);
        puff.userData.vy = 0.25 + Math.random() * 0.45 * strength;
        puff.userData.vz = -0.8 - Math.random() * 1.0;
        this._scene.add(puff);
        this._dustPuffs.push(puff);
      }
    }

    _updateDust(delta, playerSpeed) {
      if (!this._dustPuffs.length) return;
      for (let i = this._dustPuffs.length - 1; i >= 0; i--) {
        const puff = this._dustPuffs[i];
        const ud = puff.userData;
        ud.life -= delta;
        puff.position.x += ud.vx * delta;
        puff.position.y += ud.vy * delta;
        puff.position.z += (ud.vz - playerSpeed) * delta;
        const t = clamp(ud.life / ud.maxLife, 0, 1);
        puff.scale.setScalar(0.7 + (1 - t) * 1.4);
        puff.material.opacity = 0.42 * t;
        if (ud.life <= 0) {
          this._scene.remove(puff);
          if (puff.geometry) puff.geometry.dispose();
          if (puff.material) puff.material.dispose();
          this._dustPuffs.splice(i, 1);
        }
      }
    }

    hasFinished(courseLength) {
      return courseLength > 0 && this.distance >= courseLength;
    }

    dispose() {
      if (!this.group || !this._scene) return;
      if (this._groundShadow) {
        this._scene.remove(this._groundShadow);
        if (this._groundShadow.geometry) this._groundShadow.geometry.dispose();
        if (this._groundShadow.material) this._groundShadow.material.dispose();
        this._groundShadow = null;
      }
      for (const puff of this._dustPuffs) {
        this._scene.remove(puff);
        if (puff.geometry) puff.geometry.dispose();
        if (puff.material) puff.material.dispose();
      }
      this._dustPuffs = [];
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
