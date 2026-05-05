/**
 * Rabbit — Jana Bunny mode AI racer.
 *
 * Phase 2.1 (revision): cute mesh, dynamic speed tracking, true running-
 * gait hop cadence.
 *
 * Locomotion model
 * ----------------
 * The rabbit is ALWAYS hopping. Three peak modes pick the arc:
 *   • LOW  (~0.55m) — rapid small bunny-hops, the natural running gait.
 *                     The peak is intentionally short so the cadence is
 *                     fast (~0.4 s per arc) — looks like a real running
 *                     rabbit, not a single big jump.
 *   • HIGH (~3.5m)  — when an obstacle is detected ahead in this lane,
 *                     the next hop arcs over the top of cars/rocks.
 *   • MEGA (~5.5m)  — reserved for tall openings (Phase 3).
 *
 * Forward speed = playerSpeed × RABBIT_SPEED_MULT. Tracking the player
 * keeps the race close — a clean run barely beats the rabbit, a sloppy
 * run loses. Falls back to JANA_BUNNY.RABBIT_SPEED if no live player
 * speed is provided.
 *
 * Coin pickup, lane swerve, and collision penalty are unchanged from
 * the previous revision (see method docstrings).
 */
import * as THREE from 'three';
import { JANA_BUNNY } from '../utils/constants.js';

export class Rabbit {
  constructor() {
    this.group = null;
    this.distance = 0;
    this.lane = -1;
    this._targetLane = -1;
    this._scene = null;
    this._laneWidth = 3;

    this._hopY = 0;
    this._hopVel = 0;
    this._inHop = false;
    this._hopCount = 0;            // how many hops since spawn — used for ear flap
    this._lastPeak = JANA_BUNNY.HOP_PEAK_LOW;

    this._penaltyT = 0;
    this._resolvedObs = new WeakSet();

    // Cached references to animated mesh parts (set in init).
    this._earL = null;
    this._earR = null;
  }

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
    this._hopCount = 0;

    const root = new THREE.Group();
    root.userData.kind = 'rabbit';

    // Materials
    const furMat   = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.8 });
    const bellyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
    const pinkMat  = new THREE.MeshStandardMaterial({ color: 0xff9fb5, roughness: 0.7 });
    const noseMat  = new THREE.MeshStandardMaterial({ color: 0xff6b8a, roughness: 0.6 });
    const eyeMat   = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.3 });
    const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
    const toothMat = new THREE.MeshStandardMaterial({ color: 0xfff5e0, roughness: 0.5 });

    // ── Body — large rounded ovoid sitting back on the haunches.
    const bodyGeo = new THREE.SphereGeometry(0.65, 18, 14);
    const body = new THREE.Mesh(bodyGeo, furMat);
    body.scale.set(1.0, 0.95, 1.4);
    body.position.set(0, 0.7, -0.05);
    body.castShadow = true;
    root.add(body);

    // Belly — slightly lighter front patch.
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), bellyMat);
    belly.scale.set(0.9, 0.7, 1.0);
    belly.position.set(0, 0.55, 0.25);
    root.add(belly);

    // ── Head — chubby rounded sphere mounted forward + up.
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 14), furMat);
    head.position.set(0, 1.05, 0.55);
    head.castShadow = true;
    root.add(head);

    // Cheeks — slightly puffed out for a cute silhouette.
    const cheekGeo = new THREE.SphereGeometry(0.16, 10, 8);
    const cheekL = new THREE.Mesh(cheekGeo, furMat);
    cheekL.position.set(-0.22, 0.95, 0.78);
    root.add(cheekL);
    const cheekR = new THREE.Mesh(cheekGeo, furMat);
    cheekR.position.set(0.22, 0.95, 0.78);
    root.add(cheekR);

    // ── Ears — long upright ovals with pink interior. Tilted slightly
    //         outward so they read as ears, not antennae.
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

    // ── Eyes — white sclera + black pupil for that big-anime-eye look.
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
    // Tiny shine highlights
    const shineGeo = new THREE.SphereGeometry(0.018, 8, 6);
    const shineL = new THREE.Mesh(shineGeo, eyeWhiteMat);
    shineL.position.set(-0.14, 1.14, 1.01);
    root.add(shineL);
    const shineR = new THREE.Mesh(shineGeo, eyeWhiteMat);
    shineR.position.set(0.18, 1.14, 1.01);
    root.add(shineR);

    // ── Nose (pink heart-ish triangle) and mouth.
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), noseMat);
    nose.scale.set(1.2, 0.85, 1.0);
    nose.position.set(0, 0.95, 1.0);
    root.add(nose);
    // Two tiny buck teeth.
    const toothGeo = new THREE.BoxGeometry(0.05, 0.09, 0.04);
    const toothL = new THREE.Mesh(toothGeo, toothMat);
    toothL.position.set(-0.04, 0.83, 0.96);
    root.add(toothL);
    const toothR = new THREE.Mesh(toothGeo, toothMat);
    toothR.position.set(0.04, 0.83, 0.96);
    root.add(toothR);

    // ── Front paws — visible underneath the chest, small ovals.
    const pawGeo = new THREE.SphereGeometry(0.14, 10, 8);
    const pawL = new THREE.Mesh(pawGeo, furMat);
    pawL.scale.set(0.9, 0.8, 1.5);
    pawL.position.set(-0.18, 0.25, 0.55);
    root.add(pawL);
    const pawR = new THREE.Mesh(pawGeo, furMat);
    pawR.scale.set(0.9, 0.8, 1.5);
    pawR.position.set(0.18, 0.25, 0.55);
    root.add(pawR);

    // ── Back legs — bigger ovals tucked at the sides ("haunches").
    const haunchGeo = new THREE.SphereGeometry(0.32, 12, 10);
    const haunchL = new THREE.Mesh(haunchGeo, furMat);
    haunchL.scale.set(0.7, 1.0, 1.4);
    haunchL.position.set(-0.42, 0.45, -0.25);
    root.add(haunchL);
    const haunchR = new THREE.Mesh(haunchGeo, furMat);
    haunchR.scale.set(0.7, 1.0, 1.4);
    haunchR.position.set(0.42, 0.45, -0.25);
    root.add(haunchR);

    // Big back feet poking forward (bunny signature)
    const footGeo = new THREE.SphereGeometry(0.18, 10, 8);
    const footL = new THREE.Mesh(footGeo, furMat);
    footL.scale.set(1.0, 0.7, 2.0);
    footL.position.set(-0.32, 0.18, 0.05);
    root.add(footL);
    const footR = new THREE.Mesh(footGeo, furMat);
    footR.scale.set(1.0, 0.7, 2.0);
    footR.position.set(0.32, 0.18, 0.05);
    root.add(footR);

    // ── Cotton tail
    const tail = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), bellyMat);
    tail.position.set(0, 0.85, -0.85);
    root.add(tail);

    // Whiskers — six thin line segments using BufferGeometry. Cheap.
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
   * env: { playerDistance, playerSpeed, obstacles, collectibles, courseLength, laneWidth }
   */
  update(delta, env = {}) {
    if (!this.group) return;
    const playerDistance = env.playerDistance || 0;
    const playerSpeed    = (typeof env.playerSpeed === 'number' && env.playerSpeed > 0)
      ? env.playerSpeed : JANA_BUNNY.RABBIT_SPEED;
    const obstacles      = env.obstacles || [];
    const collectibles   = env.collectibles || [];
    const laneWidth      = env.laneWidth || this._laneWidth;

    // ── 1. Penalty timer
    if (this._penaltyT > 0) this._penaltyT = Math.max(0, this._penaltyT - delta);

    // ── 2. Forward speed: track player so race stays close. Apply
    //       penalty multiplier if currently in a collision recovery.
    const baseSpeed = playerSpeed * JANA_BUNNY.RABBIT_SPEED_MULT;
    const speedMul  = this._penaltyT > 0 ? JANA_BUNNY.COLLISION_SPEED_MULT : 1.0;
    const speed     = baseSpeed * speedMul;
    this.distance  += speed * delta;

    // ── 3. Lane planning
    this._planLane(obstacles, playerDistance);

    // ── 4. Lane X interpolation
    const targetX = this._targetLane * laneWidth;
    const currentX = this.group.position.x;
    const k = JANA_BUNNY.LANE_SWITCH_RATE;
    this.group.position.x = currentX + (targetX - currentX) * Math.min(1, k * delta);
    if (Math.abs(this.group.position.x - targetX) < 0.05) {
      this.lane = this._targetLane;
      this.group.position.x = targetX;
    }

    // ── 5. Hop arc
    if (!this._inHop) this._startHop(obstacles, playerDistance);
    this._hopVel -= JANA_BUNNY.HOP_GRAVITY * delta;
    this._hopY   += this._hopVel * delta;
    if (this._hopY <= 0) {
      this._hopY = 0;
      this._hopVel = 0;
      this._inHop = false;
    }

    // ── 6. Coin pickup (shared collected flag with player)
    this._scoopCoins(collectibles, playerDistance);

    // ── 7. Collision penalty check
    this._checkCollisions(obstacles, playerDistance);

    // ── 8. Render position
    this.group.position.y = this._hopY;
    this.group.position.z = -(this.distance - playerDistance);

    // Pitch tilt — nose up rising, nose down falling.
    const tilt = Math.atan2(this._hopVel, speed + 1) * 0.5;
    this.group.rotation.x = -tilt;

    // Ear flap — counter-tilt the ears so they trail slightly behind
    // the body's pitch, gives a sense of inertia. Cheap motion cue.
    if (this._earL && this._earR) {
      const earSwing = -tilt * 0.6;
      this._earL.rotation.x = earSwing;
      this._earR.rotation.x = earSwing;
    }
  }

  _startHop(obstacles, playerDistance) {
    let peak = JANA_BUNNY.HOP_PEAK_LOW;
    const next = this._nextObstacleInLane(obstacles, playerDistance, JANA_BUNNY.LOOKAHEAD_M, this._targetLane);
    if (next) peak = JANA_BUNNY.HOP_PEAK_HIGH;
    this._hopVel = Math.sqrt(2 * JANA_BUNNY.HOP_GRAVITY * peak);
    this._hopY = 0.001;
    this._inHop = true;
    this._lastPeak = peak;
    this._hopCount++;
  }

  _planLane(obstacles, playerDistance) {
    const counts = this._countBlockersByLane(obstacles, playerDistance, JANA_BUNNY.SWERVE_LOOKAHEAD_M);
    const here = counts[this._targetLane + 1] || 0;
    if (here === 0) return;
    let bestLane = this._targetLane;
    let bestCount = here;
    for (const tryLane of [-1, 0, 1]) {
      const c = counts[tryLane + 1] || 0;
      const distancePenalty = Math.abs(tryLane - this._targetLane) > 1 ? 0.5 : 0;
      if (c + distancePenalty < bestCount) {
        bestLane = tryLane;
        bestCount = c + distancePenalty;
      }
    }
    if (bestLane !== this._targetLane) this._targetLane = bestLane;
  }

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

  _checkCollisions(obstacles, playerDistance) {
    const myX = this.group.position.x;
    for (const o of obstacles) {
      if (!o.userData || this._resolvedObs.has(o)) continue;
      const obsDist = playerDistance + o.position.z;
      const ahead = obsDist - this.distance;
      const halfL = (o.userData.length || 1.5) / 2 + 0.4;
      if (ahead < -halfL || ahead > halfL) continue;
      const halfW = (o.userData.width || 1.5) / 2 + 0.5;
      if (Math.abs((o.position.x ?? 0) - myX) > halfW) continue;
      const top = (o.userData.height || 1.0);
      if (this._hopY >= top - 0.2) {
        this._resolvedObs.add(o);
        continue;
      }
      this._resolvedObs.add(o);
      if (this._penaltyT <= 0) this._penaltyT = JANA_BUNNY.COLLISION_PENALTY_SEC;
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
