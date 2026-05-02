/**
 * InstancedScenery — Phase 1 perf pass.
 *
 * Replaces per-tree / per-palm / per-lamp Group construction with shared
 * THREE.InstancedMesh pools. Each "kind" pre-allocates a fixed pool of
 * sub-meshes (trunk, foliage layers, lamp post, etc.); placing a new tree
 * just writes new transform matrices into the next free slots.
 *
 * Usage:
 *   const scenery = new InstancedScenery(scene);
 *   const handle  = scenery.addPine(x, z, { biome: 'snow' });
 *   scenery.release(handle);    // when recycled away
 *
 * Each `add*` returns an opaque handle (an internal slot record). Releasing
 * the handle frees its slots back to the pool. Slots are reused FIFO.
 */

import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

// Hide a slot off-screen rather than shrinking it to zero (avoids artifacts
// when the renderer caches per-instance bounding info).
const HIDE_MATRIX = new THREE.Matrix4().makeTranslation(0, -10000, 0);

// Pool sizes — generous; Float32 matrices are cheap. Tune later if needed.
const POOL_PINE = 220;
const POOL_PALM = 220;
const POOL_LAMP = 140;

export class InstancedScenery {
  constructor(scene) {
    this.scene = scene;
    // All instanced meshes parent here so the whole batch can be scrolled
    // by one Object3D translate per frame — keeps perfect sync with the
    // marker .position.z values that the recycle path tracks.
    this.root = new THREE.Group();
    scene.add(this.root);

    // Shared materials — one per visual class, reused across all instances.
    this.mats = {
      bark:       new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.95 }),
      foliage:    new THREE.MeshStandardMaterial({ color: 0x2d5016, roughness: 0.85 }),
      snowCap:    new THREE.MeshStandardMaterial({ color: 0xfafdff, roughness: 0.7 }),
      palmTrunk:  new THREE.MeshStandardMaterial({ color: 0x8b6a3a, roughness: 0.9 }),
      frond:      new THREE.MeshStandardMaterial({
                    color: 0x3cb371, roughness: 0.75, side: THREE.DoubleSide,
                  }),
      coconut:    new THREE.MeshStandardMaterial({ color: 0x4a2a14, roughness: 0.6 }),
      lampMetal:  new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7 }),
      lampHead:   new THREE.MeshStandardMaterial({
                    color: 0xfff2a8, emissive: 0xffd97a,
                    emissiveIntensity: 0.9, roughness: 0.3,
                  }),
    };

    // ── Pine tree pool ────────────────────────────────────────
    // 1 trunk + 3 foliage cones + (snow biome) 3 snow caps per tree.
    this.pine = {
      free: [],
      used: 0,
      trunk:    new THREE.InstancedMesh(
                  new THREE.CylinderGeometry(0.15, 0.18, 1.5, 8),
                  this.mats.bark, POOL_PINE),
      foliage1: new THREE.InstancedMesh(
                  new THREE.ConeGeometry(1.2, 1.4, 8), this.mats.foliage, POOL_PINE),
      foliage2: new THREE.InstancedMesh(
                  new THREE.ConeGeometry(0.88, 1.18, 8), this.mats.foliage, POOL_PINE),
      foliage3: new THREE.InstancedMesh(
                  new THREE.ConeGeometry(0.56, 0.96, 8), this.mats.foliage, POOL_PINE),
      snow1:    new THREE.InstancedMesh(
                  new THREE.ConeGeometry(1.25, 0.77, 8), this.mats.snowCap, POOL_PINE),
      snow2:    new THREE.InstancedMesh(
                  new THREE.ConeGeometry(0.92, 0.65, 8), this.mats.snowCap, POOL_PINE),
      snow3:    new THREE.InstancedMesh(
                  new THREE.ConeGeometry(0.58, 0.53, 8), this.mats.snowCap, POOL_PINE),
    };
    for (const m of [this.pine.trunk, this.pine.foliage1, this.pine.foliage2,
                     this.pine.foliage3, this.pine.snow1, this.pine.snow2, this.pine.snow3]) {
      m.castShadow = false;     // shadow audit comes in Phase 5; keep off for now
      m.receiveShadow = false;
      m.frustumCulled = false;  // we control visibility via off-screen hide matrix
      // Initialize all slots as hidden
      for (let i = 0; i < POOL_PINE; i++) m.setMatrixAt(i, HIDE_MATRIX);
      m.instanceMatrix.needsUpdate = true;
      this.root.add(m);
    }

    // ── Palm tree pool ────────────────────────────────────────
    // 1 trunk + 5 frond planes + 3 coconut spheres per palm.
    this.palm = {
      free: [],
      used: 0,
      trunk:   new THREE.InstancedMesh(
                 new THREE.CylinderGeometry(0.18, 0.24, 5.5, 8),
                 this.mats.palmTrunk, POOL_PALM),
      fronds:  [],
      coconut: new THREE.InstancedMesh(
                 new THREE.SphereGeometry(0.14, 8, 8),
                 this.mats.coconut, POOL_PALM * 3),
    };
    // Five frond instances per palm, one InstancedMesh per frond slot.
    for (let i = 0; i < 5; i++) {
      const g = new THREE.PlaneGeometry(0.7, 2.6);
      g.translate(0, 1.2, 0);
      const m = new THREE.InstancedMesh(g, this.mats.frond, POOL_PALM);
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
      for (let j = 0; j < POOL_PALM; j++) m.setMatrixAt(j, HIDE_MATRIX);
      m.instanceMatrix.needsUpdate = true;
      this.root.add(m);
      this.palm.fronds.push(m);
    }
    for (const m of [this.palm.trunk, this.palm.coconut]) {
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
      for (let i = 0; i < m.count; i++) m.setMatrixAt(i, HIDE_MATRIX);
      m.instanceMatrix.needsUpdate = true;
      this.root.add(m);
    }

    // ── Street lamp pool ──────────────────────────────────────
    // 1 base + 1 pole + 1 arm + 1 head per lamp.
    this.lamp = {
      free: [],
      used: 0,
      base: new THREE.InstancedMesh(
              new THREE.CylinderGeometry(0.18, 0.22, 0.25, 8),
              this.mats.lampMetal, POOL_LAMP),
      pole: new THREE.InstancedMesh(
              new THREE.CylinderGeometry(0.07, 0.09, 4.0, 8),
              this.mats.lampMetal, POOL_LAMP),
      arm:  new THREE.InstancedMesh(
              new THREE.BoxGeometry(0.7, 0.07, 0.07),
              this.mats.lampMetal, POOL_LAMP),
      head: new THREE.InstancedMesh(
              new THREE.BoxGeometry(0.45, 0.25, 0.45),
              this.mats.lampHead, POOL_LAMP),
    };
    for (const m of [this.lamp.base, this.lamp.pole, this.lamp.arm, this.lamp.head]) {
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
      for (let i = 0; i < POOL_LAMP; i++) m.setMatrixAt(i, HIDE_MATRIX);
      m.instanceMatrix.needsUpdate = true;
      this.root.add(m);
    }
  }

  // ── Slot management ──────────────────────────────────────
  _claim(pool) {
    if (pool.free.length > 0) return pool.free.pop();
    const idx = pool.used;
    pool.used++;
    return idx;
  }
  _release(pool, idx, hideFn) {
    if (idx == null) return;
    if (hideFn) hideFn(idx);
    pool.free.push(idx);
  }

  // World→local Z conversion. Callers always pass WORLD z (the scroll offset
  // is handled here) so they don't need to know about the root translate.
  _localZ(worldZ) { return worldZ - this.root.position.z; }

  // ── Pine tree ────────────────────────────────────────────
  addPine(x, worldZ, opts = {}) {
    const biome = opts.biome || 'snow';
    const scale = opts.scale != null ? opts.scale : (0.9 + Math.random() * 0.35);
    const rotY  = opts.rotY  != null ? opts.rotY  : (Math.random() * Math.PI * 2);
    const idx   = this._claim(this.pine);
    this._writePine(idx, x, this._localZ(worldZ), biome, scale, rotY);
    return { kind: 'pine', idx };
  }

  // ── Palm tree ────────────────────────────────────────────
  addPalm(x, worldZ /* opts */) {
    const idx = this._claim(this.palm);
    this._writePalm(idx, x, this._localZ(worldZ));
    return { kind: 'palm', idx };
  }

  // ── Street lamp ──────────────────────────────────────────
  addLamp(x, worldZ) {
    const idx = this._claim(this.lamp);
    this._writeLamp(idx, x, this._localZ(worldZ));
    return { kind: 'lamp', idx };
  }

  // Reposition an existing handle in place — no slot churn, no allocation.
  // Just rewrites the matrices for the same instance index. Phase 2: pure
  // pool reuse, zero GC pressure on recycle.
  moveHandle(handle, x, worldZ, opts = {}) {
    if (!handle || handle.idx == null) return;
    const z = this._localZ(worldZ);
    if (handle.kind === 'pine') {
      this._writePine(handle.idx, x, z, opts.biome || 'snow',
        opts.scale != null ? opts.scale : (0.9 + Math.random() * 0.35),
        opts.rotY  != null ? opts.rotY  : (Math.random() * Math.PI * 2));
    } else if (handle.kind === 'palm') {
      this._writePalm(handle.idx, x, z);
    } else if (handle.kind === 'lamp') {
      this._writeLamp(handle.idx, x, z);
    }
  }

  // ── Internal matrix writers — single source of truth used by add* (new
  // slot) and moveHandle (existing slot). ───────────────────────────
  _writePine(idx, x, z, biome, scale, rotY) {
    _e.set(0, rotY, 0); _q.setFromEuler(_e); _s.set(scale, scale, scale);
    _v.set(x, 0.75 * scale, z); _m.compose(_v, _q, _s);
    this.pine.trunk.setMatrixAt(idx, _m);
    const layerYs = [2.2, 3.05, 3.7];
    const foliage = [this.pine.foliage1, this.pine.foliage2, this.pine.foliage3];
    const snows   = [this.pine.snow1,    this.pine.snow2,    this.pine.snow3];
    for (let i = 0; i < 3; i++) {
      _v.set(x, layerYs[i] * scale, z); _m.compose(_v, _q, _s);
      foliage[i].setMatrixAt(idx, _m);
      if (biome === 'snow') {
        _v.set(x, (layerYs[i] + 0.18) * scale, z); _m.compose(_v, _q, _s);
        snows[i].setMatrixAt(idx, _m);
      } else {
        snows[i].setMatrixAt(idx, HIDE_MATRIX);
      }
    }
    this.pine.trunk.instanceMatrix.needsUpdate = true;
    foliage.forEach((m) => { m.instanceMatrix.needsUpdate = true; });
    snows.forEach((m)   => { m.instanceMatrix.needsUpdate = true; });
  }
  _writePalm(idx, x, z) {
    const trunkH = 5 + Math.random() * 1.2;
    const leanRad = (12 + Math.random() * 8) * Math.PI / 180;
    const leanAxis = Math.random() < 0.5 ? -1 : 1;
    const rotY = Math.random() * Math.PI * 2;
    _e.set(0, rotY, leanAxis * leanRad); _q.setFromEuler(_e);
    _v.set(x, trunkH / 2, z); _s.set(1, trunkH / 5.5, 1); _m.compose(_v, _q, _s);
    this.palm.trunk.setMatrixAt(idx, _m);
    const topY = trunkH;
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
      const local = new THREE.Matrix4();
      const tilt  = new THREE.Matrix4().makeRotationZ(leanAxis * leanRad);
      const yaw   = new THREE.Matrix4().makeRotationY(angle);
      const pitch = new THREE.Matrix4().makeRotationX(-1.0);
      const trans = new THREE.Matrix4().makeTranslation(x, topY, z);
      local.copy(trans).multiply(tilt).multiply(yaw).multiply(pitch);
      this.palm.fronds[i].setMatrixAt(idx, local);
    }
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      _v.set(x + Math.cos(a) * 0.22, topY - 0.05, z + Math.sin(a) * 0.22);
      _e.set(0, 0, 0); _q.setFromEuler(_e); _s.set(1, 1, 1);
      _m.compose(_v, _q, _s);
      this.palm.coconut.setMatrixAt(idx * 3 + i, _m);
    }
    this.palm.trunk.instanceMatrix.needsUpdate = true;
    this.palm.coconut.instanceMatrix.needsUpdate = true;
    this.palm.fronds.forEach((m) => { m.instanceMatrix.needsUpdate = true; });
  }
  _writeLamp(idx, x, z) {
    const reachSign = x < 0 ? 1 : -1;
    _e.set(0, 0, 0); _q.setFromEuler(_e); _s.set(1, 1, 1);
    _v.set(x, 0.125, z); _m.compose(_v, _q, _s); this.lamp.base.setMatrixAt(idx, _m);
    _v.set(x, 2.0,   z); _m.compose(_v, _q, _s); this.lamp.pole.setMatrixAt(idx, _m);
    _v.set(x + reachSign * 0.4, 3.95, z); _m.compose(_v, _q, _s); this.lamp.arm.setMatrixAt(idx, _m);
    _v.set(x + reachSign * 0.7, 3.85, z); _m.compose(_v, _q, _s); this.lamp.head.setMatrixAt(idx, _m);
    this.lamp.base.instanceMatrix.needsUpdate = true;
    this.lamp.pole.instanceMatrix.needsUpdate = true;
    this.lamp.arm.instanceMatrix.needsUpdate  = true;
    this.lamp.head.instanceMatrix.needsUpdate = true;
  }

  // ── Release a handle (instance hidden, slot pooled) ──────
  release(handle) {
    if (!handle) return;
    if (handle.kind === 'pine') this._release(this.pine, handle.idx, (i) => this._hidePine(i));
    else if (handle.kind === 'palm') this._release(this.palm, handle.idx, (i) => this._hidePalm(i));
    else if (handle.kind === 'lamp') this._release(this.lamp, handle.idx, (i) => this._hideLamp(i));
    handle.idx = null;
  }

  _hidePine(idx) {
    for (const m of [this.pine.trunk, this.pine.foliage1, this.pine.foliage2,
                     this.pine.foliage3, this.pine.snow1, this.pine.snow2, this.pine.snow3]) {
      m.setMatrixAt(idx, HIDE_MATRIX);
      m.instanceMatrix.needsUpdate = true;
    }
  }
  _hidePalm(idx) {
    this.palm.trunk.setMatrixAt(idx, HIDE_MATRIX);
    this.palm.trunk.instanceMatrix.needsUpdate = true;
    for (const m of this.palm.fronds) {
      m.setMatrixAt(idx, HIDE_MATRIX);
      m.instanceMatrix.needsUpdate = true;
    }
    for (let i = 0; i < 3; i++) this.palm.coconut.setMatrixAt(idx * 3 + i, HIDE_MATRIX);
    this.palm.coconut.instanceMatrix.needsUpdate = true;
  }
  _hideLamp(idx) {
    for (const m of [this.lamp.base, this.lamp.pole, this.lamp.arm, this.lamp.head]) {
      m.setMatrixAt(idx, HIDE_MATRIX);
      m.instanceMatrix.needsUpdate = true;
    }
  }

  // Scroll the entire instance pool toward the player by dz on Z. One
  // Object3D translate per frame instead of N matrix rewrites — the per-
  // instance world positions stay correct because they're relative to root.
  scroll(dz) {
    this.root.position.z -= dz;
  }

  // Free EVERYTHING — used on full course rebuild (newSeed restart).
  clearAll() {
    for (const pool of [this.pine, this.palm, this.lamp]) {
      pool.free.length = 0;
      pool.used = 0;
    }
    for (let i = 0; i < POOL_PINE; i++) this._hidePine(i);
    for (let i = 0; i < POOL_PALM; i++) this._hidePalm(i);
    for (let i = 0; i < POOL_LAMP; i++) this._hideLamp(i);
  }
}
