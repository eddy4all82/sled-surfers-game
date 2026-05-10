/**
 * ModelLoader — central GLTFLoader cache for Kenney (and any other)
 * GLB assets. The whole game shares one instance.
 *
 *   const loader = new ModelLoader();
 *   await loader.preloadAll(progress => ...);   // wait until every cached path resolves
 *   const mesh = loader.cloneByKey('cars/taxi'); // returns a fresh Object3D each call
 *
 * Why a wrapper instead of bare GLTFLoader?
 *   • Caching: each .glb is fetched + parsed ONCE. Subsequent calls clone
 *     the stored prototype, so spawning 50 cars doesn't redownload 50
 *     payloads.
 *   • Clone-by-key API: callers pass a logical key like 'cars/taxi'
 *     instead of a file path, so swapping models later is one map edit.
 *   • Material independence: each clone gets its OWN material refs so
 *     per-instance tints (e.g. snow biome) don't bleed between siblings.
 *   • Synchronous failure: if a model didn't preload, cloneByKey returns
 *     null instead of throwing, so the spawner can fall back to its
 *     procedural mesh path.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const KENNEY_MANIFEST = {
  // Cars — Kenney `kenney_car-kit`. Forward axis is +Z by default.
  'cars/taxi':       '/models/cars/taxi.glb',
  'cars/sedan':      '/models/cars/sedan.glb',
  'cars/suv':        '/models/cars/suv.glb',
  'cars/truck':      '/models/cars/truck.glb',
  'cars/delivery':   '/models/cars/delivery.glb',
  'cars/van':        '/models/cars/van.glb',
  'cars/police':     '/models/cars/police.glb',
  'cars/ambulance':  '/models/cars/ambulance.glb',
  'cars/firetruck':  '/models/cars/firetruck.glb',

  // Buildings — Kenney `kenney_city-kit-commercial`.
  'buildings/a':            '/models/buildings/building-a.glb',
  'buildings/b':            '/models/buildings/building-b.glb',
  'buildings/c':            '/models/buildings/building-c.glb',
  'buildings/d':            '/models/buildings/building-d.glb',
  'buildings/e':            '/models/buildings/building-e.glb',
  'buildings/skyscraper-a': '/models/buildings/building-skyscraper-a.glb',
  'buildings/skyscraper-b': '/models/buildings/building-skyscraper-b.glb',
  'buildings/skyscraper-c': '/models/buildings/building-skyscraper-c.glb',
};

export class ModelLoader {
  constructor() {
    this._loader = new GLTFLoader();
    this._prototypes = new Map();   // key → root Object3D (the GLTF.scene we got)
    this._loadPromises = new Map(); // key → Promise<Object3D|null>
    this._failed = new Set();
  }

  /**
   * Trigger fetch + parse for every key in the manifest. Returns
   *   { total, ready, failed }
   * once every load has settled (success or fail). Calls onProgress
   * every time a model finishes.
   */
  preloadAll(onProgress) {
    const keys = Object.keys(KENNEY_MANIFEST);
    const total = keys.length;
    let done = 0;
    let failed = 0;
    const tick = () => {
      if (typeof onProgress === 'function') onProgress({ done, total, failed });
    };
    tick();
    return Promise.all(keys.map((key) =>
      this._loadOne(key).then((proto) => {
        if (!proto) failed++;
        done++;
        tick();
      }),
    )).then(() => ({ total, ready: total - failed, failed }));
  }

  _loadOne(key) {
    if (this._prototypes.has(key)) return Promise.resolve(this._prototypes.get(key));
    if (this._loadPromises.has(key)) return this._loadPromises.get(key);
    const url = KENNEY_MANIFEST[key];
    if (!url) {
      this._failed.add(key);
      return Promise.resolve(null);
    }
    const p = new Promise((resolve) => {
      this._loader.load(
        url,
        (gltf) => {
          // Apply some sane defaults: cast/receive shadows on every
          // mesh so Kenney models drop natural shadows on the snow.
          gltf.scene.traverse((o) => {
            if (o.isMesh) {
              o.castShadow = true;
              o.receiveShadow = true;
            }
          });
          this._prototypes.set(key, gltf.scene);
          resolve(gltf.scene);
        },
        undefined,
        (err) => {
          // eslint-disable-next-line no-console
          console.warn('[ModelLoader] failed to load', key, url, err);
          this._failed.add(key);
          resolve(null);
        },
      );
    });
    this._loadPromises.set(key, p);
    return p;
  }

  /**
   * Returns a fresh, independent clone of the prototype for `key`, or
   * null if the model failed to load. Materials are cloned per-mesh so
   * per-instance tints don't leak across siblings.
   */
  cloneByKey(key) {
    const proto = this._prototypes.get(key);
    if (!proto) return null;
    const clone = proto.clone(true);
    clone.traverse((o) => {
      if (o.isMesh && o.material) {
        if (Array.isArray(o.material)) {
          o.material = o.material.map((m) => m.clone());
        } else {
          o.material = o.material.clone();
        }
      }
    });
    return clone;
  }

  /**
   * Fits the prototype's bounding box to the requested target dims by
   * scaling the cloned root uniformly along the dominant axis. Returns
   * the same clone for chaining. Used so a Kenney building meant for a
   * 4×8×4m city block can be resized to fit our 5×12×5m mid-rise spec.
   *
   * @param targetLen  desired Z extent (or null to skip)
   * @param targetWidth desired X extent
   * @param targetHeight desired Y extent
   * @param mode 'fit' = uniform scale to fit ALL dims (no stretch); 'stretch' = independent X/Y/Z scale
   */
  fitToBox(obj, { length, width, height, mode = 'fit' } = {}) {
    if (!obj) return obj;
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);
    if (size.x <= 0 || size.y <= 0 || size.z <= 0) return obj;
    if (mode === 'stretch') {
      const sx = width  != null ? width  / size.x : 1;
      const sy = height != null ? height / size.y : 1;
      const sz = length != null ? length / size.z : 1;
      obj.scale.set(obj.scale.x * sx, obj.scale.y * sy, obj.scale.z * sz);
    } else {
      // Uniform scale that fits whichever dim was constrained first.
      const factors = [];
      if (width  != null) factors.push(width  / size.x);
      if (height != null) factors.push(height / size.y);
      if (length != null) factors.push(length / size.z);
      const s = factors.length ? Math.min(...factors) : 1;
      obj.scale.multiplyScalar(s);
    }
    return obj;
  }
}

// Lazy singleton — first import path wins.
let _instance = null;
export function getModelLoader() {
  if (!_instance) _instance = new ModelLoader();
  return _instance;
}
