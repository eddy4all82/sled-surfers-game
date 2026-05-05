/**
 * Rabbit — Jana Bunny mode AI racer.
 *
 * Phase 1 (this file): scaffolding only.
 *   - Builds a low-poly white-bunny mesh (body + head + ears + tail).
 *   - Spawns at the start line at the player's lane offset.
 *   - update(delta) is a stub: no movement, no AI yet — just keeps the
 *     mesh alive in the scene at distance=0.
 *
 * Phase 2 (later) will fill in:
 *   - Continuous parabolic hopping (no sliding).
 *   - World-Z tracking (rabbit.distance) advanced at JANA_BUNNY.RABBIT_SPEED.
 *   - Lane swerve + jump-arc shaping for cars / mid-rise bridge holes.
 *   - Coin pickup (set userData.collected on cross-lane match).
 *
 * The rabbit's mesh sits in the same world the player sees; its
 * world-Z is computed each frame as `-(rabbit.distance - player.distance)`
 * so the rabbit visibly stays ahead/behind based on real progress.
 *
 * Sprint Run never instantiates this class — kept entirely off the hot
 * path until gameMode === 'jana_bunny'.
 */
import * as THREE from 'three';

export class Rabbit {
  constructor() {
    this.group = null;       // root Object3D added to the scene
    this.distance = 0;       // world-units traveled along the course
    this.lane = 0;           // -1, 0, +1
    this._scene = null;
    this._hopT = 0;          // accumulator for the future hopping animation
  }

  /**
   * Build the mesh and add it at the start line, in the given lane.
   * laneWidth is the X distance between lane centers (matches GAME_CONFIG.LANE_WIDTH).
   */
  init(scene, { lane = -1, laneWidth = 2.0 } = {}) {
    this._scene = scene;
    this.lane = lane;
    this.distance = 0;

    const root = new THREE.Group();
    root.userData.kind = 'rabbit';

    // Body — squashed sphere, pearl white.
    const bodyGeo = new THREE.SphereGeometry(0.55, 14, 12);
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    const body = new THREE.Mesh(bodyGeo, whiteMat);
    body.scale.set(1.0, 0.85, 1.4);
    body.position.y = 0.7;
    body.castShadow = true;
    root.add(body);

    // Head — sphere, slightly forward & up.
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.36, 14, 12), whiteMat);
    head.position.set(0, 1.05, 0.55);
    head.castShadow = true;
    root.add(head);

    // Ears — two tall narrow ellipsoids.
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
    // Pink ear interiors
    const innerEarGeo = new THREE.CylinderGeometry(0.04, 0.025, 0.45, 8);
    const innerL = new THREE.Mesh(innerEarGeo, pinkMat);
    innerL.position.set(-0.15, 1.45, 0.5);
    innerL.rotation.z = 0.15;
    root.add(innerL);
    const innerR = new THREE.Mesh(innerEarGeo, pinkMat);
    innerR.position.set(0.15, 1.45, 0.5);
    innerR.rotation.z = -0.15;
    root.add(innerR);

    // Eyes (small black dots).
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.4 });
    const eyeGeo = new THREE.SphereGeometry(0.05, 8, 6);
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    eyeL.position.set(-0.13, 1.12, 0.85);
    root.add(eyeL);
    const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
    eyeR.position.set(0.13, 1.12, 0.85);
    root.add(eyeR);

    // Tail — small white cotton ball.
    const tail = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), whiteMat);
    tail.position.set(0, 0.7, -0.65);
    root.add(tail);

    // Place at lane × spacing × Z=0 (start line).
    root.position.set(lane * laneWidth, 0, 0);

    scene.add(root);
    this.group = root;
    this._laneWidth = laneWidth;
    return this;
  }

  /**
   * Per-frame update. Phase 1: no movement. The mesh sits at the start
   * line (relative to the world's recycle anchor) until Phase 2 wires
   * up distance advancement and the hop arc.
   *
   * playerDistance tells us how far the player has traveled so we can
   * render the rabbit's screen-Z as `-(rabbit.distance - playerDistance)`.
   */
  update(delta, playerDistance = 0) {
    if (!this.group) return;
    this._hopT += delta;
    // For now: pin the rabbit visually at the start line (offset back
    // by the player's progress so it stays anchored at world Z=0).
    this.group.position.z = -(this.distance - playerDistance);
    this.group.position.x = this.lane * (this._laneWidth || 2.0);
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
