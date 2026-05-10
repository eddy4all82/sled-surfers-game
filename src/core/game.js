/**
 * Game — Core game manager
 *
 * Owns the Three.js renderer, scene, camera, and the main game loop.
 * Coordinates all systems (input, spawning, collision, scoring).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { InputManager } from './input-manager.js';
import { GAME_CONFIG, JANA_BUNNY } from '../utils/constants.js';
import { generateMap, randomSeed, DEFAULT_COURSE_LENGTH } from '../systems/map-generator.js';
import { InstancedScenery } from '../systems/instanced-scenery.js';
import { Rabbit } from '../systems/rabbit.js';
import { getModelLoader } from '../systems/model-loader.js';
import {
  COLLIDER_KIND,
  buildCollisionWorld,
  buildRabbitThreats,
  canPassBuildingArch,
  overlapsFootprint,
} from '../systems/collision-world.js';
import { loadSettings, saveSettings, resetSettings, DEFAULT_SETTINGS } from '../utils/settings.js';
import { SoundLibrary, SOUND_EVENTS, EVENT_DUCK } from '../utils/sound-library.js';

export class Game {
  constructor() {
    // Three.js core
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.clock = new THREE.Clock();

    // Game state
    // loading | ready | countdown | playing | exploding | gameover | won | lost_to_rabbit
    // 'countdown' and 'lost_to_rabbit' are Jana Bunny only.
    this.state = 'loading';
    // Game mode: 'sprint' (Sprint Run, default) or 'jana_bunny' (race vs AI rabbit).
    // Toggled on the start screen via the mode pill.
    this.gameMode = 'sprint';
    // Sprint Run "continue" — one-shot revival per session. Set true
    // once the player consumes their continue; cleared on PLAY AGAIN
    // or MAIN MENU return. Jana Bunny ignores this entirely.
    this._continueUsed = false;
    this._continueTimer = null;          // setInterval handle for the 10s countdown
    this._continueRemainingSec = 0;
    this._invincibleUntil = 0;           // performance.now() ms — _die ignored before this
    this.speed = GAME_CONFIG.INITIAL_SPEED;
    this.distance = 0;
    this.score = 0;
    this.coins = 0;

    // Procedural course (Phase 1 map). Default 2000 units long, fresh seed.
    this.courseSeed = randomSeed();
    this.courseLength = DEFAULT_COURSE_LENGTH;
    this.map = null;                      // populated in init()
    this.startTime = 0;                   // ms timestamp the run started
    this.finishLineGroup = null;          // 3D mesh placed at courseLength
    this.confetti = [];                   // active confetti particles (win)
    this._confettiSpawned = false;
    this.mountainBlocks = [];             // 3D groups for MOUNTAIN_SPLIT chunks (Phase 3)
    this.deathFlag = null;                // marker planted at the death spot

    // Player — continuous horizontal control (no fixed lanes)
    this.playerX = 0;            // float world X, clamped to [PLAYER_X_MIN..MAX]
    this.playerY = 0;
    this._playerXVelocity = 0;   // last-frame velocity, for tilt/visual feedback
    this._playerXMomentum = 0;   // horizontal momentum for smooth movement
    this._touchDragOriginX = 0;  // playerX at touch-start, for drag-mapping
    this.isJumping = false;
    this.isDucking = false;

    // Double jump + parachute glide
    this.canDoubleJump = false;       // armed when leaving the ground
    this._parachuteArmed = false;     // set on the frame of a double-jump press
    this.parachuteOpen = false;
    this.parachuteTimer = 0;          // seconds the chute has been open
    this.parachuteScale = 0;          // current visible scale (0..1)
    this.parachuteEnergy = GAME_CONFIG.PARACHUTE_MAX_ENERGY;

    // Ramp / air-time state
    this.airborneFromRamp = false;
    this.airTime = 0;
    this.airPeakHeight = 0;
    this.lastRampHitId = null;
    this.boostTimer = 0;
    this.shakeTimer = 0;
    this.shakeMagnitude = 0;
    this.cameraBaseOffset = new THREE.Vector3(0, 6.5, -9);
    // Two camera presets: NORMAL chase and CLOSE dramatic shot. Both pulled
    // in tighter than before so the player's true scale relative to cars,
    // buildings, and rocks reads correctly.
    this.cameraGroundOffset = new THREE.Vector3(0, 6.5, -9);
    this.cameraAirOffset    = new THREE.Vector3(0, 4.5, -6.5); // even closer
    this.cameraGroundLook   = new THREE.Vector3(0, 1.8, 16);
    this.cameraAirLook      = new THREE.Vector3(0, 2.2, 12);
    this._cameraAirLerp = 0;
    // Brief hold so the close-up doesn't pop the moment the trigger ends,
    // but short enough that the return-to-normal feels snappy.
    this._cameraHoldTimer = 0;
    // Lateral camera follow — slides left/right around the high-rise so the
    // player stays well framed when going around the building, then snaps
    // back to centered after crossing.
    this._cameraXShift = 0;
    // Smoothed copies of the player's X/Y used by the camera so its follow
    // motion lags slightly — a "floating" chase shot rather than a rigid lock.
    this._smoothPlayerX = 0;
    this._smoothPlayerY = 0;

    // Speed-up milestones
    this.nextSpeedUpAt = GAME_CONFIG.SPEED_UP_INTERVAL;

    // Biome state — current + previous + transition progress for smooth blends
    this.currentBiome = 'snow';
    this.previousBiome = 'snow';
    this.biomeProgress = 1.0;          // 0..1; 1 means fully in currentBiome
    this._biomeTransitionStart = 0;    // distance the transition began at
    this.BIOME_TRANSITION_LEN = 50;    // units over which to crossfade
    this._biomeFromColors = null;
    this._biomeToColors = null;

    // Snow trail (particle system + ground track marks)
    this.snowParticles = null;
    this.snowParticleData = []; // mirror state: {vx, vy, vz, life, maxLife}
    this.snowEmitAccum = 0;
    this.trackMarks = [];
    this.trackEmitAccum = 0;

    // Systems
    this.input = null;
    this.loader = new GLTFLoader();
    this.settings = loadSettings();
    // SFX library — pool of clips per event, see src/utils/sound-library.js
    // for how to add new events / sounds. play() picks a clip at random
    // from the matching event's pool. Respects the SFX-on/off setting.
    // Per-event ducking (declared in EVENT_DUCK) calls back into the game
    // here so we can dip the bg-music volume for the configured duration.
    this.sounds = new SoundLibrary(SOUND_EVENTS, {
      enabled: this.settings.sfxEnabled,
      volume:  1.0,
      duckMap: EVENT_DUCK,
      onDuck:  ({ to, durationMs }) => this._duckBgMusic(to, durationMs),
    });
    // Kenney 3D model cache. Spawners check this and use cloned GLBs
    // when available, falling back to procedural geometry on miss.
    this._models = getModelLoader();

    // Object pools
    this.obstacles = [];        // legacy in-lane vehicles, no longer spawned
    this.ramps = [];
    this.collectibles = [];
    this.scenery = [];
    this.groundTiles = [];
    this.crossStreets = [];     // perpendicular cross-streets with crossing traffic
    this.skyObjects = []; // high-cruising airplanes (decorative)
    this.clouds = [];     // pure decorative cloud clusters
    this.rockets = [];    // active rocket hazards
    this.lowPassPlanes = []; // low-altitude airplane hazards
    this.drones = [];     // hovering drone hazards
    this._skySpawnCooldown = 0;
    this._rocketTimer = 8 + Math.random() * 6;     // first rocket fires sooner
    this._lowPassTimer = 22 + Math.random() * 12;
    this._droneSpawnZ = GAME_CONFIG.DRONE_SPAWN_START_DISTANCE;
    this._pendingRocket = null;   // { side, fireAt }
    this._pendingLowPass = null;  // { plane, fireAt }

    // DOM
    this.canvas = document.getElementById('game-canvas');
    this.hud = document.getElementById('hud');
    this.scoreEl = document.getElementById('score');
    this.distanceEl = document.getElementById('distance');
    this.coinsEl = document.getElementById('coins-display');
    this.startScreen = document.getElementById('start-screen');
    this.gameOverScreen = document.getElementById('game-over');
    this.loadingEl = document.getElementById('loading');
    this.airTimeEl = document.getElementById('air-time');
    this.airTimerEl = this.airTimeEl ? this.airTimeEl.querySelector('.timer') : null;
    this.airBonusEl = this.airTimeEl ? this.airTimeEl.querySelector('.bonus') : null;
    this.bonusPopEl = document.getElementById('bonus-pop');
    this.speedLinesEl = document.getElementById('speed-lines');
    this.speedMeterEl = document.getElementById('speed-meter');
    this.speedNumEl = this.speedMeterEl ? this.speedMeterEl.querySelector('.num') : null;
    this.speedFillEl = this.speedMeterEl ? this.speedMeterEl.querySelector('.fill') : null;
    this.speedUpFlashEl = document.getElementById('speed-up-flash');
    this.biomeBannerEl = document.getElementById('biome-banner');
    this.chuteEnergyEl = document.getElementById('chute-energy');
    this.chuteFillEl = this.chuteEnergyEl ? this.chuteEnergyEl.querySelector('.bar-fill') : null;
    this.hazardWarnLeftEl = document.getElementById('hazard-warn-left');
    this.hazardWarnRightEl = document.getElementById('hazard-warn-right');
    this.hazardWarnCenterEl = document.getElementById('hazard-warn-center');
    // Progress bar
    this.progressEl = document.getElementById('course-progress');
    this.progressFillEl = this.progressEl ? this.progressEl.querySelector('.bar-fill') : null;
    this.progressMarkerEl = this.progressEl ? this.progressEl.querySelector('.player-marker') : null;
    this.progressRabbitMarkerEl = this.progressEl ? this.progressEl.querySelector('.rabbit-marker') : null;
    this.progressBarWrapEl = this.progressEl ? this.progressEl.querySelector('.bar-wrap') : null;
    this.progressRemainEl = this.progressEl ? this.progressEl.querySelector('.remaining') : null;
    // Win screen
    this.winScreenEl = document.getElementById('win-screen');
    this.winStatsEl = document.getElementById('win-stats');
    this.winSeedEl = document.getElementById('win-seed');

    // Background music — plays from the moment the player presses PLAY and
    // keeps playing through gameplay, the explosion, and the game-over /
    // game-won screens. Only stops when a brand-new round starts (so it
    // restarts from the top of the track).
    // Pool of looping background tracks. Each entry has its own `gain`
    // multiplier so tracks mastered at different loudness levels can
    // be balanced without re-encoding the source files. The chosen
    // track's gain compounds with the user's musicVolume setting and
    // any active duck — see _setMusicVolume() for the full chain.
    this.bgMusicPool = [
      { src: '/audio/game-music.mp3',  gain: 1.0 },
      { src: '/audio/game_music2.mp3', gain: 1.6 },
    ];
    this.bgMusic = new Audio();
    this.bgMusic.loop = true;
    this.bgMusic.preload = 'auto';
    this._currentMusicSrc = null;
    this._currentMusicGain = 1.0;
    this._currentDuckFactor = 1.0;
    this._musicShouldPlay = false;
    this.bgMusic.volume = 0.35;
    // Manual-loop fallback for browsers where the `loop` flag misbehaves
    this.bgMusic.addEventListener('ended', () => {
      if (this._musicShouldPlay) {
        try { this.bgMusic.currentTime = 0; } catch (e) {}
        const p = this.bgMusic.play();
        if (p && p.catch) p.catch(() => {});
      }
    });
    // If the audio gets paused for any external reason (tab autoplay policy,
    // browser focus loss, etc.) try to resume on the next user interaction.
    this.bgMusic.addEventListener('pause', () => {
      if (this._musicShouldPlay && !this.bgMusic.ended) {
        // Defer slightly so we don't fight an explicit pause from this code path
        setTimeout(() => {
          if (this._musicShouldPlay && this.bgMusic.paused) {
            const p = this.bgMusic.play();
            if (p && p.catch) p.catch(() => {});
          }
        }, 50);
      }
    });
    this._buildSpeedLines();
  }

  _buildSpeedLines() {
    if (!this.speedLinesEl || this.speedLinesEl.childElementCount > 0) return;
    const count = 14;
    for (let i = 0; i < count; i++) {
      const line = document.createElement('div');
      line.className = 'line';
      line.style.top = `${5 + Math.random() * 90}%`;
      line.style.animationDelay = `${(Math.random() * 0.5).toFixed(2)}s`;
      line.style.animationDuration = `${(0.35 + Math.random() * 0.45).toFixed(2)}s`;
      const w = 80 + Math.random() * 160;
      line.style.width = `${w}px`;
      this.speedLinesEl.appendChild(line);
    }
  }

  // ─────────────────────────────────────
  // Snow / ice trail (particles + ground tracks)
  // ─────────────────────────────────────

  _setupTrailRibbon() {
    // Tapered ribbon mesh that hugs the snow behind the player.
    // Width-varying plane: built from N segments along Z, each a quad with
    // its own per-vertex alpha so the tail fades out.
    const SEG = 60;
    this.trailSegmentCount = SEG;
    this.trailLength = 35; // world units behind the player
    this.trailHeadHistory = []; // recent {x, y} samples in world frame
    this.trailHistorySpacing = this.trailLength / SEG;

    // Buffer geometry: 2 verts per segment × (SEG+1) segments
    const verts = (SEG + 1) * 2;
    const positions = new Float32Array(verts * 3);
    const alphas = new Float32Array(verts);
    const indices = [];
    for (let s = 0; s < SEG; s++) {
      const a = s * 2;
      const b = s * 2 + 1;
      const c = (s + 1) * 2;
      const d = (s + 1) * 2 + 1;
      indices.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
    geo.setIndex(indices);

    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0x7ec8e3) } },
      vertexShader: `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          if (vAlpha < 0.01) discard;
          gl_FragColor = vec4(uColor, vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const ribbon = new THREE.Mesh(geo, mat);
    ribbon.frustumCulled = false;
    ribbon.renderOrder = 1;
    this.scene.add(ribbon);
    this.trailRibbon = ribbon;
  }

  _resetTrailRibbon() {
    if (!this.trailRibbon) return;
    this.trailHeadHistory.length = 0;
    const positions = this.trailRibbon.geometry.attributes.position.array;
    const alphas = this.trailRibbon.geometry.attributes.alpha.array;
    for (let i = 0; i < alphas.length; i++) {
      alphas[i] = 0;
      positions[i * 3]     = 0;
      positions[i * 3 + 1] = -10;
      positions[i * 3 + 2] = -1000;
    }
    this.trailRibbon.geometry.attributes.position.needsUpdate = true;
    this.trailRibbon.geometry.attributes.alpha.needsUpdate = true;
  }

  _updateTrailRibbon(delta, moveZ, intensity) {
    if (!this.trailRibbon) return;

    // Slide the existing history backward in world Z, then add a new head sample.
    for (const h of this.trailHeadHistory) h.z -= moveZ;

    const headX = this.player.position.x;
    const headZ = 0; // player sits at z=0
    const last = this.trailHeadHistory[0];
    if (!last || Math.abs(headZ - last.z) >= this.trailHistorySpacing * 0.5) {
      this.trailHeadHistory.unshift({ x: headX, z: headZ });
    } else {
      // Update the head sample's X so lane changes are captured smoothly
      last.x = headX;
      last.z = headZ;
    }
    // Trim history we no longer need
    const maxSamples = this.trailSegmentCount + 4;
    if (this.trailHeadHistory.length > maxSamples) {
      this.trailHeadHistory.length = maxSamples;
    }

    const positions = this.trailRibbon.geometry.attributes.position.array;
    const alphas = this.trailRibbon.geometry.attributes.alpha.array;

    const SEG = this.trailSegmentCount;
    const onGround = !this.airborneFromRamp && this.playerY <= 0.05 && this.state === 'playing';

    // Build geometry: walk back through history sampled at evenly spaced Z.
    let prevX = headX;
    for (let i = 0; i <= SEG; i++) {
      const targetZ = -i * this.trailHistorySpacing;

      // Find samples bracketing targetZ in history (history is ordered newest→oldest)
      let sx = prevX;
      for (let h = 0; h < this.trailHeadHistory.length - 1; h++) {
        const a = this.trailHeadHistory[h];
        const b = this.trailHeadHistory[h + 1];
        if (a.z >= targetZ && b.z <= targetZ) {
          const t = (a.z - targetZ) / Math.max(0.0001, a.z - b.z);
          sx = a.x + (b.x - a.x) * t;
          break;
        }
        if (h === 0 && targetZ > a.z) sx = a.x;
        if (h === this.trailHeadHistory.length - 2 && targetZ < b.z) sx = b.x;
      }
      prevX = sx;

      // Width tapers from full at the head to zero at the tail
      const t = i / SEG; // 0 at head, 1 at tail
      const halfW = (0.45 + 0.25 * intensity) * (1 - t * 0.85);
      // Slight S-curve fade so the tip is bold and the tail is soft
      const fadeAlpha = onGround ? Math.pow(1 - t, 1.4) * 0.8 : 0;

      const aIdx = i * 2;
      const bIdx = i * 2 + 1;
      // Left vertex
      positions[aIdx * 3]     = sx - halfW;
      positions[aIdx * 3 + 1] = 0.018;
      positions[aIdx * 3 + 2] = targetZ;
      alphas[aIdx] = fadeAlpha;
      // Right vertex
      positions[bIdx * 3]     = sx + halfW;
      positions[bIdx * 3 + 1] = 0.018;
      positions[bIdx * 3 + 2] = targetZ;
      alphas[bIdx] = fadeAlpha;
    }

    this.trailRibbon.geometry.attributes.position.needsUpdate = true;
    this.trailRibbon.geometry.attributes.alpha.needsUpdate = true;
  }

  _setupSnowTrail() {
    // Tapered ribbon trail (light-blue ice streak)
    this._setupTrailRibbon();
    // Soft round sprite as a canvas texture for particles
    const cnv = document.createElement('canvas');
    cnv.width = cnv.height = 64;
    const ctx = cnv.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(245,250,255,0.85)');
    grad.addColorStop(1, 'rgba(220,235,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const sprite = new THREE.CanvasTexture(cnv);
    sprite.colorSpace = THREE.SRGBColorSpace;

    const MAX = 220;
    const positions = new Float32Array(MAX * 3);
    const sizes = new Float32Array(MAX);
    const alphas = new Float32Array(MAX);
    for (let i = 0; i < MAX; i++) {
      positions[i * 3] = 0;
      positions[i * 3 + 1] = -10; // off-screen until used
      positions[i * 3 + 2] = 0;
      sizes[i] = 0;
      alphas[i] = 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: sprite },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
      },
      vertexShader: `
        attribute float size;
        attribute float alpha;
        varying float vAlpha;
        uniform float uPixelRatio;
        void main() {
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uPixelRatio * (300.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        varying float vAlpha;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(t.rgb, t.a * vAlpha);
          if (gl_FragColor.a < 0.01) discard;
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.scene.add(points);
    this.snowParticles = points;
    this.snowParticleMax = MAX;
    this.snowParticleHead = 0;
    this.snowParticleData = new Array(MAX).fill(null).map(() => ({
      vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0, alive: false,
    }));

    // Ground track-mark pool removed — the tapered ribbon now serves as the
    // visible trail behind the player. Keep an empty array so the rest of
    // the code that iterates over trackMarks safely no-ops.
    this.trackMarkMax = 0;
    this.trackMarkHead = 0;
  }

  _emitSnowParticle(px, py, pz, side, intensity) {
    if (!this.snowParticles) return;
    const idx = this.snowParticleHead;
    this.snowParticleHead = (this.snowParticleHead + 1) % this.snowParticleMax;
    const pos = this.snowParticles.geometry.attributes.position.array;
    const sizes = this.snowParticles.geometry.attributes.size.array;
    const alphas = this.snowParticles.geometry.attributes.alpha.array;
    const data = this.snowParticleData[idx];

    // Spawn well behind the tube and right at ground level so the puffs
    // don't bloom over the character.
    pos[idx * 3]     = px + side * (0.55 + Math.random() * 0.15);
    pos[idx * 3 + 1] = 0.05 + Math.random() * 0.05;
    pos[idx * 3 + 2] = pz - 0.9 - Math.random() * 0.3;

    // Small, soft puffs (no growing in flight)
    sizes[idx] = 2.5 + Math.random() * 1.5 + intensity * 1.5;
    alphas[idx] = 0.4;

    // Spray outward at ~45° — quick low arc, fades fast
    const lateral = side * (1.6 + Math.random() * 0.9 + intensity * 0.8);
    const back    = -0.8 - Math.random() * 0.5;
    const up      = 0.6 + Math.random() * 0.4;

    data.vx = lateral;
    data.vy = up;
    data.vz = back;
    data.maxLife = 0.18 + Math.random() * 0.10;
    data.life = data.maxLife;
    data.alive = true;
  }

  _emitTrackMark(px, pz) {
    if (this.trackMarks.length === 0) return;
    const m = this.trackMarks[this.trackMarkHead];
    this.trackMarkHead = (this.trackMarkHead + 1) % this.trackMarkMax;
    m.position.set(px, 0.012, pz - 0.5);
    m.scale.set(1 + (Math.random() - 0.5) * 0.2, 1, 1.2 + Math.random() * 0.4);
    m.material.opacity = 0.35;
    m.userData.maxLife = 1.6;
    m.userData.life = m.userData.maxLife;
    m.userData.alive = true;
  }

  _updateSnowTrail(delta, moveZ, effectiveSpeed) {
    if (!this.snowParticles) return;

    const onGround = !this.airborneFromRamp && this.playerY <= 0.05;
    const intensity = Math.min(1, effectiveSpeed / GAME_CONFIG.MAX_SPEED);

    // Update the tapered ice ribbon behind the player
    this._updateTrailRibbon(delta, moveZ, intensity);

    // Side-spray particles: keep ~6–10 alive — subtle puffs, not a snowstorm
    if (onGround && this.state === 'playing') {
      const rate = 12 + intensity * 18; // 12–30/s
      this.snowEmitAccum += rate * delta;
      const px = this.player.position.x;
      const py = 0.05;
      const pz = this.player.position.z;
      while (this.snowEmitAccum >= 1) {
        this.snowEmitAccum -= 1;
        // Alternate sides for a clean 45° spray
        const side = Math.random() < 0.5 ? -1 : 1;
        this._emitSnowParticle(px, py, pz, side, intensity);
      }
    }

    // Update particles
    const pos = this.snowParticles.geometry.attributes.position.array;
    const sizes = this.snowParticles.geometry.attributes.size.array;
    const alphas = this.snowParticles.geometry.attributes.alpha.array;
    for (let i = 0; i < this.snowParticleMax; i++) {
      const d = this.snowParticleData[i];
      if (!d.alive) continue;
      d.life -= delta;
      if (d.life <= 0) {
        d.alive = false;
        alphas[i] = 0;
        sizes[i] = 0;
        pos[i * 3 + 1] = -10;
        continue;
      }

      // Integrate velocity + gravity-ish drag
      pos[i * 3]     += d.vx * delta;
      pos[i * 3 + 1] += d.vy * delta;
      pos[i * 3 + 2] += d.vz * delta;
      // World motion (so particles stick to world frame)
      pos[i * 3 + 2] -= moveZ;
      d.vy -= 4.5 * delta;     // gravity
      d.vx *= (1 - 1.4 * delta); // air drag
      d.vz *= (1 - 0.8 * delta);

      // Don't sink below the ground
      if (pos[i * 3 + 1] < 0.02) {
        pos[i * 3 + 1] = 0.02;
        d.vy = 0;
        // Fade faster on contact
        d.life -= delta * 0.6;
      }

      const t = Math.max(0, d.life / d.maxLife);
      // Soft fade, never opaque, shrink slightly toward end
      alphas[i] = t * 0.35;
      sizes[i] = (2.5 + Math.random() * 0.3) * (0.6 + t * 0.5) * (0.9 + intensity * 0.3);
    }
    this.snowParticles.geometry.attributes.position.needsUpdate = true;
    this.snowParticles.geometry.attributes.size.needsUpdate = true;
    this.snowParticles.geometry.attributes.alpha.needsUpdate = true;

    // Update track marks — fade + scroll
    for (const m of this.trackMarks) {
      if (!m.userData.alive) continue;
      m.position.z -= moveZ;
      m.userData.life -= delta;
      if (m.userData.life <= 0 || m.position.z < -25) {
        m.userData.alive = false;
        m.material.opacity = 0;
        m.position.y = -10;
        continue;
      }
      const t = m.userData.life / m.userData.maxLife;
      // Slightly more visible at higher speed
      m.material.opacity = t * (0.25 + intensity * 0.25);
    }
  }

  // ─────────────────────────────────────
  // Falling snow (snow biome ambient effect)
  // ─────────────────────────────────────

  _setupSnowfall() {
    const COUNT = 100;
    this._snowfallCount = COUNT;
    const positions = new Float32Array(COUNT * 3);
    const sizes = new Float32Array(COUNT);
    this._snowfallVel = [];
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 90;
      positions[i * 3 + 1] = Math.random() * 35;
      positions[i * 3 + 2] = -10 + Math.random() * 90;
      sizes[i] = 1.5 + Math.random() * 1.6;
      this._snowfallVel.push({
        vx: (Math.random() - 0.5) * 0.4,
        vy: -(1.5 + Math.random() * 1.5),
        vz: (Math.random() - 0.5) * 0.3,
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    // Reuse the snow-trail sprite for the soft round flake look
    const cnv = document.createElement('canvas');
    cnv.width = cnv.height = 32;
    const ctx = cnv.getContext('2d');
    const grad = ctx.createRadialGradient(16, 16, 1, 16, 16, 14);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(245,250,255,0.7)');
    grad.addColorStop(1, 'rgba(220,235,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
    const sprite = new THREE.CanvasTexture(cnv);
    sprite.colorSpace = THREE.SRGBColorSpace;

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: sprite },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
        uOpacity: { value: 0.7 },
      },
      vertexShader: `
        attribute float size;
        uniform float uPixelRatio;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uPixelRatio * (300.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform float uOpacity;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(t.rgb, t.a * uOpacity);
          if (gl_FragColor.a < 0.01) discard;
        }
      `,
      transparent: true,
      depthWrite: false,
    });

    this.snowfall = new THREE.Points(geo, mat);
    this.snowfall.frustumCulled = false;
    this.scene.add(this.snowfall);
  }

  _updateSnowfall(delta) {
    if (!this.snowfall) return;

    // Visibility fades with biome — use a uniform so the cross-fade is smooth.
    const targetOpacity = this.currentBiome === 'snow'
      ? 0.7
      : (this.previousBiome === 'snow' ? (1 - this.biomeProgress) * 0.7 : 0.0);
    const u = this.snowfall.material.uniforms.uOpacity;
    u.value += (targetOpacity - u.value) * Math.min(1, 6 * delta);
    this.snowfall.visible = u.value > 0.02;

    if (!this.snowfall.visible) return;

    const pos = this.snowfall.geometry.attributes.position.array;
    const vel = this._snowfallVel;
    const N = this._snowfallCount;
    for (let i = 0; i < N; i++) {
      pos[i * 3]     += vel[i].vx * delta;
      pos[i * 3 + 1] += vel[i].vy * delta;
      pos[i * 3 + 2] += vel[i].vz * delta;
      // Recycle when it hits the ground
      if (pos[i * 3 + 1] < 0.1) {
        pos[i * 3]     = (Math.random() - 0.5) * 90;
        pos[i * 3 + 1] = 30 + Math.random() * 8;
        pos[i * 3 + 2] = -10 + Math.random() * 90;
      }
    }
    this.snowfall.geometry.attributes.position.needsUpdate = true;
  }

  // ─────────────────────────────────────
  // Ground detail (bumps + flat color patches)
  // ─────────────────────────────────────

  _setupGroundDetail() {
    this.groundBumps = [];
    this.groundPatches = [];

    // Soft white "snow drift" bumps — flattened spheres at the edges of the
    // playable area so they don't interfere with sliding.
    const bumpMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0, transparent: true, opacity: 0.85,
    });
    this.groundBumpMat = bumpMat;
    for (let i = 0; i < 26; i++) {
      const r = 0.9 + Math.random() * 1.2;
      const bump = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), bumpMat);
      bump.scale.set(
        1 + (Math.random() - 0.5) * 0.4,
        0.18 + Math.random() * 0.1,
        1 + (Math.random() - 0.5) * 0.4,
      );
      bump.position.set(this._randomGroundDetailX(8), 0.02, Math.random() * 380);
      bump.receiveShadow = true;
      this.scene.add(bump);
      this.groundBumps.push(bump);
    }

    // Flat tinted patches — slightly lighter or icier circles on the snow.
    const patchMat = new THREE.MeshStandardMaterial({
      color: 0xdfeaf5, roughness: 0.95, transparent: true, opacity: 0.55,
      depthWrite: false,
    });
    this.groundPatchMat = patchMat;
    for (let i = 0; i < 32; i++) {
      const r = 1.4 + Math.random() * 1.6;
      const patch = new THREE.Mesh(new THREE.CircleGeometry(r, 16), patchMat);
      patch.rotation.x = -Math.PI / 2;
      // Patches can be near the lanes — they're flat and won't obscure
      patch.position.set(
        (Math.random() - 0.5) * 60,
        0.014 + Math.random() * 0.002,
        Math.random() * 380,
      );
      this.scene.add(patch);
      this.groundPatches.push(patch);
    }
  }

  // Helper: random X far enough from the playable lanes (3-lane corridor)
  _randomGroundDetailX(minOffset) {
    const sign = Math.random() < 0.5 ? -1 : 1;
    const span = 60 - minOffset; // half-width budget
    return sign * (minOffset + Math.random() * span);
  }

  _updateGroundDetail(moveZ) {
    // Bumps: scroll, recycle past camera, keep them out of the player's path
    for (const b of this.groundBumps) {
      b.position.z -= moveZ;
      if (b.position.z < -25) {
        b.position.z += 380 + Math.random() * 30;
        b.position.x = this._randomGroundDetailX(8);
      }
    }
    for (const p of this.groundPatches) {
      p.position.z -= moveZ;
      if (p.position.z < -25) {
        p.position.z += 380 + Math.random() * 30;
        p.position.x = (Math.random() - 0.5) * 60;
      }
    }
  }

  _setBiomeGroundDetail(biome) {
    // Tint bumps/patches per biome so they read as snow drifts, debris, or sand piles.
    if (!this.groundBumpMat || !this.groundPatchMat) return;
    if (biome === 'snow') {
      this.groundBumpMat.color.setHex(0xffffff);
      this.groundBumpMat.opacity = 0.85;
      this.groundPatchMat.color.setHex(0xdfeaf5);
      this.groundPatchMat.opacity = 0.55;
    } else if (biome === 'city') {
      this.groundBumpMat.color.setHex(0xb8c2cc);
      this.groundBumpMat.opacity = 0.55;
      this.groundPatchMat.color.setHex(0xa5b1bd);
      this.groundPatchMat.opacity = 0.45;
    } else { // tropical
      this.groundBumpMat.color.setHex(0xe8c98a);
      this.groundBumpMat.opacity = 0.7;
      this.groundPatchMat.color.setHex(0xd5b46d);
      this.groundPatchMat.opacity = 0.5;
    }
  }

  _resetSnowTrail() {
    if (this.snowParticleData) {
      const pos = this.snowParticles.geometry.attributes.position.array;
      const sizes = this.snowParticles.geometry.attributes.size.array;
      const alphas = this.snowParticles.geometry.attributes.alpha.array;
      for (let i = 0; i < this.snowParticleMax; i++) {
        this.snowParticleData[i].alive = false;
        alphas[i] = 0;
        sizes[i] = 0;
        pos[i * 3 + 1] = -10;
      }
      this.snowParticles.geometry.attributes.position.needsUpdate = true;
      this.snowParticles.geometry.attributes.size.needsUpdate = true;
      this.snowParticles.geometry.attributes.alpha.needsUpdate = true;
    }
    if (this.trackMarks) {
      for (const m of this.trackMarks) {
        m.userData.alive = false;
        m.material.opacity = 0;
        m.position.y = -10;
      }
    }
    this.snowEmitAccum = 0;
    this.trackEmitAccum = 0;
    this._resetTrailRibbon();
  }

  async init() {
    this._setupRenderer();
    this._setupScene();
    this._setupCamera();
    this._setupLighting();
    // Phase 1 perf: pooled InstancedMesh scenery for the high-volume kinds
    // (pine, palm, lamp). Must be ready BEFORE _createPlaceholderWorld so the
    // first wave of trees and lamps lands in the instance pools.
    this.instancedScenery = new InstancedScenery(this.scene);
    this._createPlaceholderWorld();

    // Generate the procedural course map (Phase 1) and place the finish line
    this._buildCourse();

    // Input
    this.input = new InputManager(this.canvas);
    this.input.onSwipe = (dir) => this._handleSwipe(dir);
    this._applySettings();
    this._wireSettingsUI();
    this._wireMobileJumpButton();
    this._wireModeToggle();

    // UI — every gameplay-start click is also the moment to unlock the
    // SFX library so iOS / mobile Safari permits later automatic plays.
    const startGesture = (fn) => () => {
      if (this.sounds && this.sounds.unlock) this.sounds.unlock();
      fn();
    };
    document.getElementById('start-btn').addEventListener(
      'click', startGesture(() => this.start()));
    document.getElementById('restart-btn').addEventListener(
      'click', startGesture(() => this.restart({ newSeed: true })));
    // Sprint Run CONTINUE button — resume from the death spot.
    const continueBtn = document.getElementById('continue-btn');
    if (continueBtn) continueBtn.addEventListener(
      'click', startGesture(() => this._continuePlay()));
    const winNew = document.getElementById('win-new-btn');
    const winReplay = document.getElementById('win-replay-btn');
    if (winNew) winNew.addEventListener(
      'click', startGesture(() => this.restart({ newSeed: true })));
    if (winReplay) winReplay.addEventListener(
      'click', startGesture(() => this.restart({ newSeed: false })));
    // MAIN MENU — return to the start screen (mode selector). Available
    // from both the game-over and win panels in either game mode.
    const mainMenuBtn = document.getElementById('main-menu-btn');
    const winMainMenuBtn = document.getElementById('win-main-menu-btn');
    if (mainMenuBtn) mainMenuBtn.addEventListener(
      'click', () => this._returnToMainMenu());
    if (winMainMenuBtn) winMainMenuBtn.addEventListener(
      'click', () => this._returnToMainMenu());

    // Initial milestone tick on the progress bar
    this._populateProgressMilestones();

    // Pre-fetch + decode every SFX clip while still on the loading screen,
    // so the first PLAY tap on mobile doesn't stutter waiting on audio
    // network / decode. The PLAY button stays disabled until done.
    const startBtn = document.getElementById('start-btn');
    if (startBtn) startBtn.disabled = true;
    this.state = 'ready';
    this.loadingEl.textContent = 'Loading audio 0%...';
    // Track audio + 3D-model preload progress independently and show
    // the slower of the two as the loading-screen text. Two streams
    // run in parallel; a single Ready! line replaces both at the end.
    let audioPct = 0, modelPct = 0;
    const renderLoading = () => {
      this.loadingEl.textContent =
        `Loading… audio ${audioPct}% · models ${modelPct}%`;
    };
    renderLoading();
    Promise.all([
      this.sounds.preloadAll({
        onProgress: ({ done, total, failed }) => {
          audioPct = total ? Math.floor((done / total) * 100) : 100;
          renderLoading();
        },
      }),
      this._preloadBgMusic(),
      this._models.preloadAll(({ done, total, failed }) => {
        modelPct = total ? Math.floor((done / total) * 100) : 100;
        renderLoading();
      }),
    ]).then(([sfxResult, _bg, modelResult]) => {
      const { ready, total, failed } = sfxResult;
      const msg = (failed > 0)
        ? `Ready! (${ready}/${total} sounds, ${failed} skipped${modelResult.failed ? `, ${modelResult.failed} models skipped` : ''})`
        : `Ready! (${modelResult.ready}/${modelResult.total} models loaded)`;
      this.loadingEl.textContent = msg;
      if (startBtn) startBtn.disabled = false;
      // First scenery walk happens HERE (not in _createPlaceholderWorld)
      // so the Kenney models are guaranteed loaded by the time the
      // spawners try to clone them. The state-gate is intentionally
      // loose: even if the user has already clicked PLAY (state moved
      // to 'countdown'/'playing'), we still want the scenery populated.
      // Clear any leftover items from prior tabs / hot-reloads first.
      this._clearScenery();
      this._spawnSideDecor();
    });

    // Start render loop
    this._loop();
  }

  // ── Settings ────────────────────────────────────────────────

  _applySettings() {
    const s = this.settings;
    if (this.input) {
      this.input.setKeyBindings(s.keys);
      this.input.setSwapLR(s.swapLR);
      if (this.input.setTouchScheme) this.input.setTouchScheme(s.touchScheme);
    }
    if (this.sounds) this.sounds.setEnabled(s.sfxEnabled);
    if (this.bgMusic) {
      this._setMusicVolume();
      if (s.musicEnabled) {
        this._musicShouldPlay = true;
        if (this.state === 'playing') this._playBgMusic();
      } else {
        this._musicShouldPlay = false;
        this._stopBgMusic && this._stopBgMusic();
        try { this.bgMusic.pause(); } catch (e) {}
      }
    }
  }

  // Touch-only jump button. CSS controls visibility (mobile-only via
  // hover:none + pointer:coarse media query).
  //
  // Behavior:
  //   • On ground (label = "JUMP")     — press fires _handleSwipe('up')
  //                                       (single ground jump).
  //   • Airborne  (label = "PARACHUTE") — press fires _handleSwipe('up')
  //                                       (multi-jump + arms parachute);
  //                                       holding sets input.jumpHeld so
  //                                       the armed parachute opens AND
  //                                       stays open while energy lasts.
  //                                       Release closes the parachute via
  //                                       the existing jumpHeld watcher in
  //                                       _update (line ~5529).
  // The label flips automatically each frame in _updateMobileJumpButton().
  _wireMobileJumpButton() {
    const btn = document.getElementById('mobile-jump-btn');
    if (!btn) return;
    this._mobileJumpBtn = btn;
    this._mobileJumpHeld = false;

    const press = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.sounds && this.sounds.unlock) this.sounds.unlock();
      this._mobileJumpHeld = true;
      // Use the external-jumpHeld channel so a separate canvas-finger
      // can swipe to steer without its touchstart resetting jumpHeld.
      if (this.input) this.input.setExternalJumpHeld(true);
      this._handleSwipe('up');
    };
    const release = (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      this._mobileJumpHeld = false;
      if (this.input) this.input.setExternalJumpHeld(false);
    };

    btn.addEventListener('touchstart', press, { passive: false });
    btn.addEventListener('touchend', release, { passive: false });
    btn.addEventListener('touchcancel', release, { passive: false });
    // Mouse fallback for DevTools device emulation / desktop testing.
    btn.addEventListener('mousedown', press);
    btn.addEventListener('mouseup', release);
    btn.addEventListener('mouseleave', release);
  }

  // Toggle button visibility + label/style based on game state. Called
  // every frame from _loop. Cheap — only writes the DOM when the visible
  // mode actually changes.
  //
  //   • Hidden when state !== 'playing' (loading, ready, exploding,
  //     gameover, won). CSS .game-active class gates visibility.
  //   • While playing, label flips between JUMP (on ground) and PARA
  //     (airborne) to match the active behavior.
  // Jana Bunny — fired by Rabbit.update when its body collides with
  // any obstacle/scenery/building (the AI's planning failed). The
  // rabbit "loses" → the player WINS.
  _onRabbitCollision(kind) {
    if (this.state !== 'playing') return;
    // Trigger the standard win path. The win screen + finish-line UI
    // takes over; the rabbit's death-cam variant comes in Phase 3.
    this._win();
  }

  // Jana Bunny — player vs rabbit physical collision. Fires only when
  // the player catches up to the rabbit at ground level: if their
  // bodies overlap in lane + Z, the player crashes (this._die fires
  // with kind 'rabbit'). The rabbit can't penetrate the player on
  // its side either — that's enforced inside Rabbit.update via the
  // player-as-threat hard clamp.
  _checkRabbitKill() {
    if (this.state !== 'playing' || !this.rabbit || !this.rabbit.group) return;
    if (!this.player) return;
    const r = this.rabbit.group;
    // Z relative to player camera: same as rabbit's screen Z.
    const dz = r.position.z;          // rabbit's screen-Z (player is at 0)
    if (Math.abs(dz) > 1.4) return;   // out of bumper range
    const dx = r.position.x - this.player.position.x;
    if (Math.abs(dx) > 1.2) return;   // not in our lane / lateral gap
    // Player must be at ground level (or close) — if both are airborne
    // and well above the rabbit, no collision. Player Y > rabbit top + small margin = safe.
    const rabbitTop = (r.position.y || 0) + 1.6;  // rabbit body height ~1.6m
    if (this.playerY > rabbitTop + 0.2) return;
    // Crash.
    this._die(this.player.position, 'rabbit', 'CAUGHT BY THE BUNNY!');
  }

  _updateMobileJumpButton() {
    const btn = this._mobileJumpBtn;
    if (!btn) return;
    const playing = this.state === 'playing';
    if (playing !== this._mobileJumpBtnActive) {
      this._mobileJumpBtnActive = playing;
      btn.classList.toggle('game-active', playing);
      // Defensive: clear any lingering held state when hiding so an
      // unreleased finger from a mid-press game-over doesn't keep
      // jumpHeld true into the next round.
      if (!playing && this.input) this.input.setExternalJumpHeld(false);
    }
    if (!playing) return;

    const airborne = this.isJumping || this.airborneFromRamp || this.playerY > 0.05;
    if (airborne === this._mobileJumpBtnWasAirborne) return;
    this._mobileJumpBtnWasAirborne = airborne;
    if (airborne) {
      btn.classList.add('parachute-mode');
      btn.setAttribute('aria-label', 'Parachute');
      btn.querySelector('.label').textContent = 'PARA';
    } else {
      btn.classList.remove('parachute-mode');
      btn.setAttribute('aria-label', 'Jump');
      btn.querySelector('.label').textContent = 'JUMP';
    }
  }

  // Start-screen mode pill — flips between Sprint Run / Jana Bunny.
  // Sets this.gameMode and toggles a class on #start-screen so the
  // themed SVG background swaps. Sprint Run path is the default and
  // unchanged from before this UI existed.
  _wireModeToggle() {
    const startScreen = document.getElementById('start-screen');
    const opts = document.querySelectorAll('#mode-toggle .mode-opt');
    if (!startScreen || !opts.length) return;
    const apply = (mode) => {
      this.gameMode = mode === 'jana_bunny' ? 'jana_bunny' : 'sprint';
      startScreen.classList.toggle('mode-sprint', this.gameMode === 'sprint');
      startScreen.classList.toggle('mode-jana',   this.gameMode === 'jana_bunny');
      opts.forEach((b) => {
        b.classList.toggle('active', b.dataset.mode === this.gameMode);
      });
    };
    opts.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        apply(btn.dataset.mode);
      });
    });
    // Apply default state on init.
    apply(this.gameMode);
  }

  _wireSettingsUI() {
    const overlay = document.getElementById('settings-overlay');
    const openers = document.querySelectorAll('.open-settings');
    const closeBtn = document.getElementById('settings-close');
    const resetBtn = document.getElementById('settings-reset');
    if (!overlay) return;

    const open = () => { overlay.style.display = 'flex'; this._refreshSettingsUI(); };
    const close = () => { overlay.style.display = 'none'; saveSettings(this.settings); };
    openers.forEach((el) => el.addEventListener('click', open));
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (resetBtn) resetBtn.addEventListener('click', () => {
      this.settings = resetSettings();
      this._applySettings();
      this._refreshSettingsUI();
    });

    // Music volume
    const volSlider = document.getElementById('setting-music-vol');
    const volLabel  = document.getElementById('music-vol-val');
    if (volSlider) volSlider.addEventListener('input', () => {
      this.settings.musicVolume = parseInt(volSlider.value, 10) / 100;
      if (volLabel) volLabel.textContent = `${volSlider.value}%`;
      this._setMusicVolume();
      saveSettings(this.settings);
    });

    // Music on/off
    const musicChk = document.getElementById('setting-music-on');
    if (musicChk) musicChk.addEventListener('change', () => {
      this.settings.musicEnabled = musicChk.checked;
      this._applySettings();
      saveSettings(this.settings);
    });

    // SFX on/off (placeholder for future SoundLibrary)
    const sfxChk = document.getElementById('setting-sfx-on');
    if (sfxChk) sfxChk.addEventListener('change', () => {
      this.settings.sfxEnabled = sfxChk.checked;
      saveSettings(this.settings);
    });

    // Swap LR
    const swapChk = document.getElementById('setting-swap-lr');
    if (swapChk) swapChk.addEventListener('change', () => {
      this.settings.swapLR = swapChk.checked;
      if (this.input) this.input.setSwapLR(this.settings.swapLR);
      saveSettings(this.settings);
    });

    // Touch scheme picker — only visible on touch devices (mobile/tablet).
    // Detection: presence of a touch API. Avoids showing the radios on
    // pure-keyboard desktops where they're irrelevant.
    const touchRow = document.getElementById('touch-scheme-row');
    const isTouchDevice = ('ontouchstart' in window)
      || (navigator.maxTouchPoints > 0)
      || (navigator.msMaxTouchPoints > 0);
    if (touchRow) {
      touchRow.style.display = isTouchDevice ? 'block' : 'none';
      touchRow.querySelectorAll('input[name="touch-scheme"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          if (!radio.checked) return;
          this.settings.touchScheme = radio.value;
          if (this.input && this.input.setTouchScheme) {
            this.input.setTouchScheme(radio.value);
          }
          saveSettings(this.settings);
        });
      });
    }

    // First-person view
    const fpChk = document.getElementById('setting-fp');
    if (fpChk) fpChk.addEventListener('change', () => {
      this.settings.firstPerson = fpChk.checked;
      saveSettings(this.settings);
    });

    // Camera distance
    const distSlider = document.getElementById('setting-cam-dist');
    const distLabel  = document.getElementById('cam-dist-val');
    if (distSlider) distSlider.addEventListener('input', () => {
      this.settings.cameraDistance = parseFloat(distSlider.value);
      if (distLabel) distLabel.textContent = `${this.settings.cameraDistance.toFixed(2)}x`;
      saveSettings(this.settings);
    });

    // Key rebinds — clicking a key button arms a single capture; the next
    // keydown becomes the new binding for that action.
    document.querySelectorAll('.key-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        btn.textContent = 'Press a key…';
        const onCapture = (e) => {
          e.preventDefault();
          window.removeEventListener('keydown', onCapture, true);
          this.settings.keys[action] = [e.key];
          if (this.input) this.input.setKeyBindings(this.settings.keys);
          saveSettings(this.settings);
          this._refreshSettingsUI();
        };
        window.addEventListener('keydown', onCapture, true);
      });
    });
  }

  _refreshSettingsUI() {
    const s = this.settings;
    const set = (id, prop, v) => {
      const el = document.getElementById(id);
      if (el) el[prop] = v;
    };
    set('setting-music-vol', 'value', Math.round(s.musicVolume * 100));
    const volLabel = document.getElementById('music-vol-val');
    if (volLabel) volLabel.textContent = `${Math.round(s.musicVolume * 100)}%`;
    set('setting-music-on', 'checked', s.musicEnabled);
    set('setting-sfx-on',   'checked', s.sfxEnabled);
    set('setting-swap-lr',  'checked', s.swapLR);
    set('setting-fp',       'checked', s.firstPerson);
    set('setting-cam-dist', 'value', s.cameraDistance);
    const distLabel = document.getElementById('cam-dist-val');
    if (distLabel) distLabel.textContent = `${s.cameraDistance.toFixed(2)}x`;
    document.querySelectorAll('.key-btn').forEach((btn) => {
      const action = btn.dataset.action;
      btn.textContent = (s.keys[action] || ['—']).map(prettifyKey).join(' / ');
    });
    // Touch-scheme picker — check the radio that matches the saved value.
    document.querySelectorAll('input[name="touch-scheme"]').forEach((r) => {
      r.checked = (r.value === s.touchScheme);
    });
    function prettifyKey(k) {
      if (k === ' ') return 'Space';
      if (k === 'ArrowUp')    return '↑';
      if (k === 'ArrowDown')  return '↓';
      if (k === 'ArrowLeft')  return '←';
      if (k === 'ArrowRight') return '→';
      return k;
    }
  }

  _buildCourse() {
    this.map = generateMap({ seed: this.courseSeed, courseLength: this.courseLength });
    this._buildFinishLine(this.map.courseLength);
    this._buildMountainBlocks();
  }

  _clearMountainBlocks() {
    if (this.mountainBlocks) {
      for (const m of this.mountainBlocks) this.scene.remove(m);
    }
    this.mountainBlocks = [];
  }

  _buildMountainBlocks() {
    this._clearMountainBlocks();
    if (!this.map) return;

    for (const chunk of this.map.chunks) {
      if (chunk.type !== 'MOUNTAIN_SPLIT') continue;
      const splitFeat = chunk.specialFeatures.find(f => f.type === 'mountain_split');
      if (!splitFeat) continue;

      const startZRaw = splitFeat.startZ;
      const endZRaw   = splitFeat.endZ;
      const corridorLen = endZRaw - startZRaw;
      const width = 6;            // building footprint (X = -3 .. +3)
      const height = 28;          // tall — can't clear with a double-jump
      const buildingLen = Math.min(corridorLen, 25);
      const halfL = buildingLen / 2;

      // Building MUST sit on land between cross-streets, never on top of one.
      // The building's Z extent is buildingLen ± a 5-unit padding for the
      // surrounding caution / stop signs. Walk the chunk's corridor in
      // small steps until we find a centerZ where neither the building
      // nor its sign halo overlaps any cross-street's Z band.
      const SAFETY_PAD = 5;
      const safeOf = (z) => !this._zHasCrossStreet(z, halfL + SAFETY_PAD);
      let centerZ = (startZRaw + endZRaw) / 2;
      if (!safeOf(centerZ)) {
        const corridorMin = startZRaw + halfL;
        const corridorMax = endZRaw   - halfL;
        let found = false;
        for (let probe = centerZ; probe <= corridorMax + 60; probe += 4) {
          if (safeOf(probe)) { centerZ = probe; found = true; break; }
        }
        if (!found) {
          for (let probe = centerZ; probe >= corridorMin - 60; probe -= 4) {
            if (safeOf(probe)) { centerZ = probe; found = true; break; }
          }
        }
        // If still not safe (impossibly dense map), skip this building rather
        // than place it on a cross-street.
        if (!safeOf(centerZ)) continue;
      }
      // Recompute the visual corridor anchors to follow the relocated building
      const startZ = centerZ - halfL;
      const endZ   = centerZ + halfL;

      const block = this._buildHighRiseBuilding(buildingLen, chunk.biome);
      block.position.set(0, 0, centerZ);
      block.userData.kind = 'building';
      block.userData.startZ = startZ;
      block.userData.endZ = endZ;
      block.userData.length = buildingLen;
      block.userData.corridorLength = corridorLen;
      block.userData.width = width;
      block.userData.height = height;
      block.userData.archHalfW = 1.5;
      block.userData.archYMin = 3.0;
      block.userData.archYMax = 8.0;
      this.scene.add(block);
      this.mountainBlocks.push(block);

      // Arrow signs at the entry of the split (decorative — not collidable)
      const leftArrow = this._buildArrowSign('left');
      leftArrow.position.set(-2.6, 1.7, startZ - 1.0);
      leftArrow.userData.kind = 'arrow';
      this.scene.add(leftArrow);
      this.mountainBlocks.push(leftArrow);

      const rightArrow = this._buildArrowSign('right');
      rightArrow.position.set(2.6, 1.7, startZ - 1.0);
      rightArrow.userData.kind = 'arrow';
      this.scene.add(rightArrow);
      this.mountainBlocks.push(rightArrow);

      // Surround the building with collidable hazard signage.
      this._spawnForkSignage(centerZ, startZ, endZ);

      // Spawn the per-path obstacles + coins (data lives on chunk.paths)
      if (chunk.paths) this._spawnSplitPathContent(chunk.paths);
    }
  }

  // Caution + stop signs around a mountain-split high-rise. Every sign is
  // marked collidable with a small hit box so the player explodes if they
  // crash into them, just like trees / lamps / rocks.
  _spawnForkSignage(centerZ, startZ, endZ) {
    const W = 6;                 // building width in X (matches block.userData.width)
    const halfW = W / 2;
    // Two stop signs on the corridor entry — one each side of the arch
    for (const sx of [-2.2, 2.2]) {
      const stop = this._buildStopSign();
      stop.position.set(sx, 0, startZ - 3.0);
      stop.userData.kind = 'stop_sign';
      stop.userData.collidable = true;
      stop.userData.length = 0.7;
      stop.userData.width  = 0.7;
      stop.userData.height = 2.5;
      this.scene.add(stop);
      this.mountainBlocks.push(stop);
    }
    // Caution triangles flanking the building on its four corners
    const cornerOffsets = [
      [-(halfW + 1.2), startZ - 0.5],
      [ (halfW + 1.2), startZ - 0.5],
      [-(halfW + 1.2), endZ + 0.5],
      [ (halfW + 1.2), endZ + 0.5],
    ];
    for (const [cx, cz] of cornerOffsets) {
      const sign = this._buildCautionSign();
      sign.position.set(cx, 0, cz);
      sign.userData.kind = 'caution_sign';
      sign.userData.collidable = true;
      sign.userData.length = 0.8;
      sign.userData.width  = 0.8;
      sign.userData.height = 2.5;
      this.scene.add(sign);
      this.mountainBlocks.push(sign);
    }
  }

  // Yellow diamond CAUTION sign on a thin pole, ~2.5m tall.
  _buildCautionSign() {
    const group = new THREE.Group();
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.7 });
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.07, 2.0, 8), poleMat,
    );
    pole.position.y = 1.0;
    group.add(pole);
    // Diamond plate (square rotated 45°)
    const cnv = document.createElement('canvas');
    cnv.width = 128; cnv.height = 128;
    const ctx = cnv.getContext('2d');
    ctx.fillStyle = '#FFD23F';
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, 120, 120);
    ctx.fillStyle = '#111';
    ctx.font = 'bold 92px Arial Black';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', 64, 70);
    const tex = new THREE.CanvasTexture(cnv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.95, 0.95),
      new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.5 }),
    );
    plate.position.y = 2.1;
    plate.rotation.z = Math.PI / 4;     // diamond orientation
    group.add(plate);
    // Backside duplicate so it reads from both directions
    const plateBack = plate.clone();
    plateBack.rotation.y = Math.PI;
    group.add(plateBack);
    return group;
  }

  // Octagonal red STOP sign on a thin pole, ~2.5m tall.
  _buildStopSign() {
    const group = new THREE.Group();
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.7 });
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.07, 2.0, 8), poleMat,
    );
    pole.position.y = 1.0;
    group.add(pole);
    // Octagonal red plate built from a CircleGeometry with 8 segments
    const plate = new THREE.Mesh(
      new THREE.CircleGeometry(0.45, 8),
      new THREE.MeshStandardMaterial({
        color: 0xCC1F1A, side: THREE.DoubleSide, roughness: 0.5,
      }),
    );
    plate.position.y = 2.1;
    plate.rotation.z = Math.PI / 8;     // align flat side at top
    group.add(plate);
    // White "STOP" text via canvas texture overlaid slightly forward
    const cnv = document.createElement('canvas');
    cnv.width = 128; cnv.height = 128;
    const ctx = cnv.getContext('2d');
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 36px Arial Black';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('STOP', 64, 64);
    const tex = new THREE.CanvasTexture(cnv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const text = new THREE.Mesh(
      new THREE.PlaneGeometry(0.65, 0.65),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }),
    );
    text.position.set(0, 2.1, 0.005);
    group.add(text);
    return group;
  }

  _buildHighRiseBuilding(length, biome) {
    const group = new THREE.Group();

    const W = 6;                  // total building width (X)
    const H = 28;                 // total height
    const archHalfW = 1.5;        // arch opening half-width
    const archY0 = 3.0;           // arch bottom (above ground)
    const archY1 = 8.0;           // arch top
    const pillarHalfW = (W / 2) - archHalfW; // = 1.5

    // Glass material varies a touch per biome
    const wallColor = biome === 'tropical' ? 0xddc28a
                    : biome === 'snow'     ? 0x6fa8d3
                    :                        0x4a90d9;
    const glassMat = new THREE.MeshStandardMaterial({
      color: wallColor, metalness: 0.65, roughness: 0.25,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x333741, roughness: 0.55,
    });

    // ── Solid LEFT pillar  (X ∈ -3..-1.5, full H) ─────────────
    const leftPillar = new THREE.Mesh(
      new THREE.BoxGeometry(pillarHalfW, H, length),
      glassMat,
    );
    leftPillar.position.set(-(archHalfW + pillarHalfW / 2), H / 2, 0);
    leftPillar.castShadow = true;
    leftPillar.receiveShadow = true;
    group.add(leftPillar);

    // ── Solid RIGHT pillar (X ∈ 1.5..3, full H) ───────────────
    const rightPillar = new THREE.Mesh(
      new THREE.BoxGeometry(pillarHalfW, H, length),
      glassMat,
    );
    rightPillar.position.set(archHalfW + pillarHalfW / 2, H / 2, 0);
    rightPillar.castShadow = true;
    group.add(rightPillar);

    // ── Solid CENTER lintel (above the arch): X ∈ -1.5..1.5, Y > archY1
    const lintelH = H - archY1;
    const lintel = new THREE.Mesh(
      new THREE.BoxGeometry(archHalfW * 2, lintelH, length),
      glassMat,
    );
    lintel.position.set(0, archY1 + lintelH / 2, 0);
    lintel.castShadow = true;
    group.add(lintel);

    // ── Solid CENTER base (below the arch): X ∈ -1.5..1.5, Y < archY0
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(archHalfW * 2, archY0, length),
      glassMat,
    );
    base.position.set(0, archY0 / 2, 0);
    base.castShadow = true;
    group.add(base);

    // ── Roof crown ────────────────────────────────────────────
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(W + 0.4, 0.7, length + 0.4),
      trimMat,
    );
    roof.position.set(0, H + 0.35, 0);
    group.add(roof);

    // ── Window grid on the front and back faces of each pillar ─
    const winMat = new THREE.MeshStandardMaterial({
      color: 0xfff2a8, emissive: 0xffd97a, emissiveIntensity: 0.45,
    });
    const cols = Math.max(1, Math.floor(pillarHalfW / 0.8));
    const rows = Math.max(6, Math.floor(H / 1.4));
    const colStep = pillarHalfW / (cols + 1);
    const rowStep = H / (rows + 1);
    for (const facing of [-1, 1]) {
      for (const sx of [-(archHalfW + pillarHalfW / 2), archHalfW + pillarHalfW / 2]) {
        for (let c = 1; c <= cols; c++) {
          for (let r = 1; r <= rows; r++) {
            const wn = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.32), winMat);
            wn.position.set(sx - pillarHalfW / 2 + c * colStep,
                            r * rowStep,
                            facing * (length / 2 + 0.01));
            if (facing < 0) wn.rotation.y = Math.PI;
            group.add(wn);
          }
        }
      }
    }
    // Window grid on the lintel front/back too
    for (const facing of [-1, 1]) {
      const lintelCols = Math.max(2, Math.floor((archHalfW * 2) / 0.8));
      const lintelRows = Math.max(3, Math.floor(lintelH / 1.4));
      const lcStep = (archHalfW * 2) / (lintelCols + 1);
      const lrStep = lintelH / (lintelRows + 1);
      for (let c = 1; c <= lintelCols; c++) {
        for (let r = 1; r <= lintelRows; r++) {
          const wn = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.32), winMat);
          wn.position.set(-archHalfW + c * lcStep,
                          archY1 + r * lrStep,
                          facing * (length / 2 + 0.01));
          if (facing < 0) wn.rotation.y = Math.PI;
          group.add(wn);
        }
      }
    }

    // ── Glowing arch frame on both faces so the hole reads at distance ──
    const archFrameMat = new THREE.MeshStandardMaterial({
      color: 0xffe14a, emissive: 0xffae42, emissiveIntensity: 1.1,
    });
    for (const facing of [-1, 1]) {
      // Top bar of the arch
      const topBar = new THREE.Mesh(
        new THREE.BoxGeometry(archHalfW * 2 + 0.4, 0.18, 0.18),
        archFrameMat,
      );
      topBar.position.set(0, archY1, facing * (length / 2 + 0.05));
      group.add(topBar);
      // Bottom bar
      const botBar = new THREE.Mesh(
        new THREE.BoxGeometry(archHalfW * 2 + 0.4, 0.18, 0.18),
        archFrameMat,
      );
      botBar.position.set(0, archY0, facing * (length / 2 + 0.05));
      group.add(botBar);
      // Vertical sides
      for (const sx of [-archHalfW, archHalfW]) {
        const sideRail = new THREE.Mesh(
          new THREE.BoxGeometry(0.18, archY1 - archY0, 0.18),
          archFrameMat,
        );
        sideRail.position.set(sx, (archY0 + archY1) / 2, facing * (length / 2 + 0.05));
        group.add(sideRail);
      }
    }

    // Subtle point light near the arch for visibility
    const archGlow = new THREE.PointLight(0xffd97a, 1.2, 14, 1.2);
    archGlow.position.set(0, (archY0 + archY1) / 2, 0);
    group.add(archGlow);

    return group;
  }

  _buildArrowSign(direction) {
    const group = new THREE.Group();
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.7 });
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.08, 1.7, 8),
      poleMat,
    );
    pole.position.y = -0.9;
    group.add(pole);

    // Sign plate with canvas-rendered arrow
    const cnv = document.createElement('canvas');
    cnv.width = 128; cnv.height = 64;
    const ctx = cnv.getContext('2d');
    ctx.fillStyle = '#FFD23F';
    ctx.fillRect(0, 0, 128, 64);
    ctx.strokeStyle = '#aa3700';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 124, 60);
    ctx.fillStyle = '#aa3700';
    ctx.font = 'bold 56px Arial Black';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(direction === 'left' ? '←' : '→', 64, 36);
    const tex = new THREE.CanvasTexture(cnv);
    tex.colorSpace = THREE.SRGBColorSpace;

    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.75),
      new THREE.MeshStandardMaterial({
        map: tex, side: THREE.DoubleSide, roughness: 0.5,
      }),
    );
    plate.position.y = 0.45;
    group.add(plate);
    return group;
  }

  // Returns 0..1: how "inside" the player is of any active mountain split.
  // 0 = no split nearby, 1 = fully inside one. Used to widen the corridor
  // and to push existing scenery outward so it visually parts the city.
  _mountainSplitFactor() {
    if (!this.mountainBlocks) return 0;
    let best = 0;
    for (const block of this.mountainBlocks) {
      if (block.userData.kind !== 'building') continue;
      // Use the FULL split corridor length so the city parts well before and
      // after the building, not only around its own footprint.
      const halfL = (block.userData.corridorLength
                     || block.userData.length || 80) / 2;
      const dz = block.position.z;
      const front = dz - halfL;
      const back  = dz + halfL;
      let f;
      if (0 < front) {
        f = THREE.MathUtils.clamp(1 - front / 6, 0, 1);
      } else if (0 > back) {
        f = THREE.MathUtils.clamp(1 + back / 6, 0, 1);
      } else {
        f = 1;
      }
      if (f > best) best = f;
    }
    return best;
  }

  // Each frame: scenery items whose world Z falls inside an active mountain
  // split get pushed outward (X ≥ ±18) so the city visibly opens up.
  // When they leave the split, restore their original X.
  _pushScenerydForSplits() {
    if (!this.mountainBlocks || this.mountainBlocks.length === 0) return;
    if (!this.scenery) return;

    // Cache active split CORRIDOR Z windows so the whole city parts, not
    // just the small zone around the building footprint.
    const ranges = [];
    for (const m of this.mountainBlocks) {
      if (m.userData.kind !== 'building') continue;
      const halfL = (m.userData.corridorLength
                     || m.userData.length || 80) / 2;
      ranges.push([m.position.z - halfL - 4, m.position.z + halfL + 4]);
    }
    if (ranges.length === 0) return;

    for (const s of this.scenery) {
      let inside = false;
      for (const [z0, z1] of ranges) {
        if (s.position.z >= z0 && s.position.z <= z1) { inside = true; break; }
      }
      if (inside && !s.userData._pushedForSplit) {
        s.userData._origX = s.position.x;
        s.userData._pushedForSplit = true;
        const side = Math.sign(s.position.x) || 1;
        s.position.x = side * Math.max(Math.abs(s.position.x), 18);
      } else if (!inside && s.userData._pushedForSplit) {
        s.position.x = s.userData._origX;
        s.userData._pushedForSplit = false;
      }
    }
  }

  _spawnSplitPathContent(paths) {
    // Path obstacles + coins are data items from the map generator; spawn
    // them now and tag as `unique` so the recycler leaves them alone.
    const spawnObs = (data) => {
      let mesh;
      if (data.type === 'lane_rock') {
        mesh = this._buildLaneRock(data.biome || this.currentBiome || 'snow');
        mesh.userData.length = 1.6;
        mesh.userData.width = 1.6;
      } else if (data.type === 'static_vehicle') {
        mesh = this._buildStaticVehicle(data.vehicle);
        mesh.rotation.y = data.rotation || 0;
        mesh.userData.vehicleType = data.vehicle;
      } else {
        return;
      }
      mesh.position.set(data.x, 0, data.z);
      mesh.userData.type = 'obstacle';
      mesh.userData.unique = true;
      this.scene.add(mesh);
      this.obstacles.push(mesh);
    };

    (paths.left.obstacles || []).forEach(spawnObs);
    (paths.right.obstacles || []).forEach(spawnObs);

    // Coins
    const coinMat = new THREE.MeshStandardMaterial({
      color: 0xffd700, emissive: 0xffa500, emissiveIntensity: 0.3,
      metalness: 0.8, roughness: 0.2,
    });
    const allCoins = (paths.left.collectibles || [])
      .concat(paths.right.collectibles || []);
    for (const c of allCoins) {
      const coin = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.3, 0.08, 16),
        coinMat,
      );
      coin.position.set(c.x, c.y, c.z);
      coin.rotation.x = Math.PI / 2;
      coin.userData.type = 'coin';
      coin.userData.lane = 1;
      coin.userData.collected = false;
      coin.userData.unique = true;
      this.scene.add(coin);
      this.collectibles.push(coin);
    }

    // Optional right-path ramp
    if (paths.right.specialRamp) {
      const ramp = this._buildRamp();
      ramp.position.set(
        paths.right.specialRamp.x, 0, paths.right.specialRamp.z,
      );
      ramp.userData.type = 'ramp';
      ramp.userData.id = `ramp_split_${Math.random().toString(36).slice(2, 8)}`;
      ramp.userData.length = ramp.userData.length || 10;
      ramp.userData.unique = true;
      this.scene.add(ramp);
      this.ramps.push(ramp);
    }
  }

  _buildFinishLine(z) {
    if (this.finishLineGroup) {
      this.scene.remove(this.finishLineGroup);
      this.finishLineGroup = null;
    }
    const group = new THREE.Group();

    // Two tall poles flanking the course
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x222226, roughness: 0.6 });
    for (const sx of [-7, 7]) {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.22, 8, 12),
        poleMat,
      );
      pole.position.set(sx, 4, 0);
      pole.castShadow = true;
      group.add(pole);
    }

    // Checkered banner (canvas-rendered texture stretched between the poles)
    const cnv = document.createElement('canvas');
    cnv.width = 256; cnv.height = 64;
    const ctx = cnv.getContext('2d');
    const cells = 16, rows = 4;
    const cw = cnv.width / cells, ch = cnv.height / rows;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cells; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#000000' : '#ffffff';
        ctx.fillRect(x * cw, y * ch, cw, ch);
      }
    }
    const tex = new THREE.CanvasTexture(cnv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 1.4),
      new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.6 }),
    );
    banner.position.set(0, 7.0, 0);
    group.add(banner);

    // FINISH text plane (canvas)
    const tcnv = document.createElement('canvas');
    tcnv.width = 512; tcnv.height = 128;
    const tctx = tcnv.getContext('2d');
    tctx.fillStyle = 'rgba(0,0,0,0)'; tctx.fillRect(0, 0, tcnv.width, tcnv.height);
    tctx.font = 'bold 96px Arial Black, sans-serif';
    tctx.textAlign = 'center';
    tctx.textBaseline = 'middle';
    tctx.lineWidth = 8;
    tctx.strokeStyle = '#aa3700';
    tctx.fillStyle = '#FFD700';
    tctx.strokeText('FINISH', tcnv.width / 2, tcnv.height / 2);
    tctx.fillText('FINISH', tcnv.width / 2, tcnv.height / 2);
    const ttex = new THREE.CanvasTexture(tcnv);
    ttex.colorSpace = THREE.SRGBColorSpace;
    const text = new THREE.Mesh(
      new THREE.PlaneGeometry(7, 1.7),
      new THREE.MeshBasicMaterial({ map: ttex, transparent: true }),
    );
    text.position.set(0, 8.4, 0.05);
    group.add(text);

    // Crossbar between the poles (visual structure)
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(14.2, 0.18, 0.18),
      poleMat,
    );
    bar.position.set(0, 7.85, 0);
    group.add(bar);

    // Golden glow point light
    const glow = new THREE.PointLight(0xFFD23F, 2.0, 24, 1.5);
    glow.position.set(0, 5, 0);
    group.add(glow);

    // Wide ground line at finish (so the player can see the threshold)
    const lineGeo = new THREE.PlaneGeometry(16, 1.2);
    const lineMat = new THREE.MeshBasicMaterial({
      color: 0xFFD700, transparent: true, opacity: 0.9,
    });
    const line = new THREE.Mesh(lineGeo, lineMat);
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.05, 0);
    group.add(line);

    group.position.set(0, 0, z);
    this.scene.add(group);
    this.finishLineGroup = group;
  }

  _populateProgressMilestones() {
    if (!this.progressBarWrapEl || !this.map) return;
    // Clear any existing milestone ticks
    this.progressBarWrapEl.querySelectorAll('.milestone').forEach(n => n.remove());
    for (const m of this.map.milestones) {
      // Skip the start/finish marker — covered by the start label and flag icon.
      // Skip HALFWAY too — visually noisy on the bar; the player can read
      // their position from the marker + remaining-meters readout.
      if (m.label === 'START' || m.label === 'FINISH' || m.label === 'HALFWAY') continue;
      const tick = document.createElement('div');
      tick.className = 'milestone';
      const t = m.z / this.map.courseLength;
      tick.style.bottom = `${(t * 100).toFixed(1)}%`;
      const lbl = document.createElement('span');
      lbl.className = 'ml';
      lbl.textContent = m.label;
      tick.appendChild(lbl);
      this.progressBarWrapEl.appendChild(tick);
    }
  }

  _setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    });
  }

  _setupScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb); // Sky blue
    this.scene.fog = new THREE.Fog(0xd0e8ff, 80, 200);
  }

  _setupCamera() {
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      500
    );
    // Behind and above the player, looking forward
    this.camera.position.set(0, 8, -12);
    this.camera.lookAt(0, 2, 20);
  }

  _setupLighting() {
    // Ambient
    const ambient = new THREE.AmbientLight(0xb0d4f1, 0.6);
    this.scene.add(ambient);

    // Directional (sun)
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(20, 40, -10);
    sun.castShadow = true;
    // Phase 5 perf: 2048→1024 shadow map. Halves the shadow-pass cost
    // and the visual difference is invisible at this camera distance.
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 80;     // tighter far plane, sharper close shadows
    sun.shadow.camera.left = -25;
    sun.shadow.camera.right = 25;
    sun.shadow.camera.top = 25;
    sun.shadow.camera.bottom = -25;
    sun.shadow.bias = -0.0008;
    this.scene.add(sun);

    // Hemisphere for sky/ground ambient
    const hemi = new THREE.HemisphereLight(0x87ceeb, 0xffffff, 0.4);
    this.scene.add(hemi);
  }

  /**
   * Creates a placeholder world with simple shapes.
   * This runs immediately so you see SOMETHING before GLB models load.
   * Replace these with real GLB models later.
   */
  _createPlaceholderWorld() {
    // Wide snowy/icy ground — no road, no lane lines.
    const groundGeo = new THREE.PlaneGeometry(140, 500);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xf0f5ff,    // snow white (snow biome default)
      roughness: 0.95,
    });
    this.ground = new THREE.Mesh(groundGeo, groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.z = 200;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.groundMat = groundMat;
    this.roadMat = null;
    this.sidewalkMat = null;

    // Subtle surface variation — gentle bumps + flat color patches scattered
    // across the ground so the playable area doesn't read as a flat sheet.
    this._setupGroundDetail();

    // Player: penguin sitting in a bright blue inflatable snow-tube
    this.player = this._buildPlayer();
    this.player.position.set(0, 0.0, 0);
    this.scene.add(this.player);

    // Snow/ice trail system (particles + ground tracks)
    this._setupSnowTrail();

    // Falling snow (visible only in snow biome)
    this._setupSnowfall();

    // Decorative cloud cover with ground shadows
    this._setupClouds();

    // Side-decor walk is intentionally DEFERRED until the GLB preload
    // resolves (see init() / Promise.all().then()). Walking it here
    // would race the model loader and lock-in procedural fallbacks,
    // since cloneByKey returns null until the model is parsed. The
    // start screen is up during preload, so the world is allowed to
    // be empty for those few hundred milliseconds.

    // Cross-streets (perpendicular roads with crossing traffic)
    let cz = 35;
    while (cz < 320) {
      this._spawnCrossStreet(cz);
      cz += 40 + Math.random() * 20;
    }

    // Spawn ramps (every 80-120 units in the center lane)
    for (let z = 60; z < 320; z += 80 + Math.random() * 40) {
      if (this._zHasCrossStreet(z, 8)) continue;
      this._spawnRamp(z);
    }

    // Lane obstacles (parked cars + boulders) randomly placed across the
    // three lanes on the snowy slope. Skips cross-streets and ramp rows.
    let oz = 28;
    while (oz < 240) {
      this._spawnLaneObstacle(oz);
      oz += 18 + Math.random() * 14; // 18-32 unit gap so the player can dodge
    }

    // Spawn coins (skip rows that fall on a cross-street)
    for (let z = 20; z < 200; z += 5) {
      if (this._zHasCrossStreet(z, 4)) continue;
      if (Math.random() > 0.5) {
        this._spawnPlaceholderCoin(z);
      }
    }
  }

  _zHasCrossStreet(z, pad) {
    if (!this.crossStreets) return false;
    for (const s of this.crossStreets) {
      if (Math.abs(s.position.z - z) < (s.userData.streetDepth / 2 + pad)) return true;
    }
    return false;
  }

  // Returns true if z is inside (or within `pad` of) any high-rise
  // building's Z footprint. Buildings have an arch tunnel down the
  // centre lane that the player (and the rabbit in Jana Bunny mode)
  // must thread; we don't want cars / ramps / coins / signs spawning
  // inside that span and blocking the path.
  _zInsideBuilding(z, pad) {
    if (!this.mountainBlocks) return false;
    for (const b of this.mountainBlocks) {
      if (!b.userData || b.userData.kind !== 'building') continue;
      // Use startZ/endZ if present (set in _buildMountainBlocks), else
      // fall back to position.z ± length/2.
      let zStart, zEnd;
      if (typeof b.userData.startZ === 'number' && typeof b.userData.endZ === 'number') {
        zStart = b.userData.startZ;
        zEnd   = b.userData.endZ;
      } else {
        const half = (b.userData.length || 30) / 2;
        zStart = b.position.z - half;
        zEnd   = b.position.z + half;
      }
      if (z > zStart - pad && z < zEnd + pad) return true;
    }
    return false;
  }

  // Project-wide rule: NO object (building, side decor, ramp, tree, lamp,
  // car, rock, coin, sign) is allowed to land inside a cross-street's
  // Z footprint OR inside a high-rise building's tunnel span. Every
  // spawner uses this helper to displace its candidate Z to the
  // nearest clean spot. Returns null if no safe Z within ±limit.
  _clampToSafeZ(z, pad = 4, limit = 80) {
    const zClear = (zz) => !this._zHasCrossStreet(zz, pad)
                        && !this._zInsideBuilding(zz, pad);
    if (zClear(z)) return z;
    // Try forward first (the player is moving forward — closer to original
    // intended spacing reads better), then backward as fallback.
    for (let step = 4; step <= limit; step += 4) {
      const fwd = z + step;
      if (zClear(fwd)) return fwd;
      const bwd = z - step;
      if (zClear(bwd)) return bwd;
    }
    return null;
  }

  _addSideDecor(side, z, biome) {
    // Project-wide rule: NEVER drop side decor (buildings, trees, lamps,
    // rocks, planters, towers, etc.) inside a cross-street's Z footprint.
    const safeZ = this._clampToSafeZ(z, 5);
    if (safeZ == null) return;        // no clean Z in 80m — skip silently
    z = safeZ;
    const sign = side;
    if (!biome) {
      // We walk the full course at init, so the world Z of this spawn
      // *is* the value of `z` (player.distance == 0 at init time). Pick
      // the biome from the world-Z so each chunk of the course gets the
      // right scenery (snow before 500m, city 500-1000m, tropical after).
      biome = this._biomeForDistance(z);
    }
    const roll = Math.random();

    // Buildings sit ~12-15 units back from center on both sides
    const buildingX = () => sign * (12 + Math.random() * 3);
    const treeX = () => sign * (10 + Math.random() * 2.5);
    const cliffX = () => sign * (22 + Math.random() * 4);
    const lampX = () => sign * (GAME_CONFIG.LANE_WIDTH * 1.5 + 1.4);
    // Rocks sit BETWEEN the curb and the buildings
    const rockX = () => sign * (7.5 + Math.random() * 2.5);

    if (biome === 'snow') {
      // Snow biome = outdoor festival event. Heavier weight on tents,
      // trees, and a cheering crowd watching the penguin race.
      if (roll < 0.18) {
        this._addSnowShop(buildingX(), z + (Math.random() - 0.5) * 4);   // tent
      } else if (roll < 0.26) {
        this._addSnowTallBuilding(buildingX(), z + (Math.random() - 0.5) * 4); // big decorated tree
      } else if (roll < 0.55) {
        // Heavy snow-tree zone (29% of slots) — cluster 1-3 trees
        const baseX = treeX();
        this._addPineTree(baseX, z, biome);
        if (Math.random() < 0.6) {
          this._addPineTree(baseX + sign * (1 + Math.random()), z + 2 + Math.random() * 2, biome);
        }
        if (Math.random() < 0.3) {
          this._addPineTree(baseX + sign * (2 + Math.random()), z - 2 - Math.random() * 2, biome);
        }
      } else if (roll < 0.66) {
        // Cheering crowd watching the penguin run
        this._addCheeringCrowd(sign, z + (Math.random() - 0.5) * 3);
      } else if (roll < 0.74) {
        this._addCabin(buildingX(), z + (Math.random() - 0.5) * 4);
      } else if (roll < 0.84) {
        this._addRockCluster(rockX(), z + (Math.random() - 0.5) * 2, biome);
      } else if (roll < 0.92) {
        this._addStreetLamp(lampX(), z + (Math.random() - 0.5) * 4);
      } else {
        this._addFestivalProp(sign, z + (Math.random() - 0.5) * 3);
      }
    } else if (biome === 'city') {
      if (roll < 0.34) {
        if (Math.random() < 0.18) {
          this._addCityWalkwayPair(sign, z + (Math.random() - 0.5) * 3);
        } else {
          this._addSkyscraper(buildingX(), z + (Math.random() - 0.5) * 4);
        }
      } else if (roll < 0.55) {
        this._addCityMidRise(buildingX(), z + (Math.random() - 0.5) * 4);
      } else if (roll < 0.70) {
        this._addPalmTree(treeX(), z);
        if (Math.random() < 0.5) this._addPlanter(treeX() * 0.85, z + 1.2);
      } else if (roll < 0.80) {
        this._addRockCluster(rockX(), z + (Math.random() - 0.5) * 2, biome);
      } else if (roll < 0.90) {
        this._addStreetLamp(lampX(), z + (Math.random() - 0.5) * 4);
      } else {
        this._addCityRoadFurniture(sign, z + (Math.random() - 0.5) * 3);
      }
    } else { // tropical
      if (roll < 0.36) {
        const baseX = treeX();
        this._addPalmTree(baseX, z);
        if (Math.random() < 0.4) {
          this._addPalmTree(baseX + sign * (1.2 + Math.random()), z + 3 + Math.random() * 2);
        }
      } else if (roll < 0.56) {
        this._addTropicalMidRise(buildingX(), z + (Math.random() - 0.5) * 4);
      } else if (roll < 0.70) {
        this._addCliffWall(cliffX(), z + (Math.random() - 0.5) * 6);
      } else if (roll < 0.80) {
        this._addTikiHut(buildingX(), z + (Math.random() - 0.5) * 4);
      } else if (roll < 0.92) {
        // Volcanic rocks more common in tropical biome
        this._addRockCluster(rockX(), z + (Math.random() - 0.5) * 2, biome);
      } else {
        this._addStreetLamp(lampX(), z + (Math.random() - 0.5) * 4);
      }
    }
  }

  // Drops a small cluster of Kenney spectator characters facing the
  // race lane — the "fans watching the penguin" moment for the snow
  // biome event. Falls through silently if models aren't ready.
  _addCheeringCrowd(side, z) {
    if (!this._models) return;
    const PEOPLE = [
      'people/male-a', 'people/male-b', 'people/male-c', 'people/male-d',
      'people/male-e', 'people/male-f',
      'people/female-a', 'people/female-b', 'people/female-c', 'people/female-d',
    ];
    const count = 2 + Math.floor(Math.random() * 3);   // 2-4 spectators
    const baseX = side * (8 + Math.random() * 2.5);
    const group = new THREE.Group();
    for (let i = 0; i < count; i++) {
      const pkey = PEOPLE[Math.floor(Math.random() * PEOPLE.length)];
      const ch = this._models.cloneByKey(pkey);
      if (!ch) continue;
      // Mini Characters 1 are ~1.7m tall by default — keep that scale.
      this._models.fitToBox(ch, { height: 1.6, mode: 'fit' });
      const dx = (Math.random() - 0.5) * 1.2;
      const dz = (i - count / 2) * 0.7 + (Math.random() - 0.5) * 0.3;
      ch.position.set(dx, 0.01, dz);
      // Face the race lane (toward x=0): rotate so character's forward
      // axis points toward the lane center. Kenney chars face -Z by
      // default, so when on the right side (sign=+1) we yaw +π/2 to
      // face left toward the lane; on the left side we yaw -π/2.
      ch.rotation.y = -side * Math.PI / 2 + (Math.random() - 0.5) * 0.5;
      group.add(ch);
    }
    if (group.children.length === 0) return;
    group.position.set(baseX, 0, z);
    group.userData.type = 'scenery';
    group.userData.kenneyModel = true;
    group.userData.biome = 'snow';
    group.userData.kind = 'crowd';
    // Soft hit-box: characters are passable visually-only props. Mark
    // collidable false so the player can clip them at speed if our
    // safe-Z drift puts the cluster too close.
    group.userData.collidable = false;
    this.scene.add(group);
    this.scenery.push(group);
  }

  // Drops a single decorative festival prop in the snow biome — a
  // snowman, a sled, a stack of presents, or a lantern. Adds variety
  // to the side decor without inflating the building/tree count.
  _addFestivalProp(side, z) {
    if (!this._models) return;
    const PROPS = [
      { key: 'holiday/snowman',         h: 1.4 },
      { key: 'holiday/sled',            h: 0.7 },
      { key: 'holiday/present-cube',    h: 0.6 },
      { key: 'holiday/present-rect',    h: 0.5 },
      { key: 'holiday/lantern',         h: 1.1 },
      { key: 'holiday/snow-pile',       h: 0.6 },
    ];
    const choice = PROPS[Math.floor(Math.random() * PROPS.length)];
    const km = this._models.cloneByKey(choice.key);
    if (!km) return;
    this._models.fitToBox(km, { height: choice.h, mode: 'fit' });
    km.rotation.y = Math.random() * Math.PI * 2;
    const group = new THREE.Group();
    group.add(km);
    group.position.set(side * (8.5 + Math.random() * 2), 0.01, z);
    group.userData.type = 'scenery';
    group.userData.kenneyModel = true;
    group.userData.biome = 'snow';
    group.userData.kind = 'festival_prop';
    group.userData.collidable = false;
    this.scene.add(group);
    this.scenery.push(group);
  }

  // Drops a Kenney highway sign or modern streetlight along the city
  // sidewalk. Used to make the city biome feel signposted/lived-in.
  _addCityRoadFurniture(side, z) {
    if (!this._models) return;
    const FURN = [
      { key: 'road/sign-highway',          h: 4.5, x: 11 },
      { key: 'road/sign-highway-wide',     h: 4.5, x: 11 },
      { key: 'road/sign-highway-detailed', h: 5.0, x: 11 },
      { key: 'road/light-curved',          h: 5.5, x: 7  },
      { key: 'road/light-curved-double',   h: 5.5, x: 7  },
      { key: 'road/light-square',          h: 5.0, x: 7  },
    ];
    const choice = FURN[Math.floor(Math.random() * FURN.length)];
    const km = this._models.cloneByKey(choice.key);
    if (!km) return;
    this._models.fitToBox(km, { height: choice.h, mode: 'fit' });
    // Sign should face the road (yaw 90° on side=+1, -90° on side=-1).
    km.rotation.y = -side * Math.PI / 2;
    const group = new THREE.Group();
    group.add(km);
    group.position.set(side * (choice.x + Math.random() * 1.5), 0.01, z);
    group.userData.type = 'scenery';
    group.userData.kenneyModel = true;
    group.userData.biome = 'city';
    group.userData.kind = 'city_furniture';
    group.userData.collidable = false;
    this.scene.add(group);
    this.scenery.push(group);
  }

  _addParkedVehicle(side, x, z) {
    const types = ['taxi', 'suv', 'truck', 'cityBus', 'schoolBus'];
    const type = types[Math.floor(Math.random() * types.length)];
    const v = this._buildStaticVehicle(type);
    // Rotate 90° so length runs along X — parked sideways at the curb.
    // Sign chooses whether the vehicle's front faces the road or away from it.
    const facing = Math.random() < 0.5 ? 1 : -1;
    v.rotation.y = (Math.PI / 2) * facing * Math.sign(side || 1);
    // Slight crooked angle for a "left-on-the-curb" look
    v.rotation.y += (Math.random() - 0.5) * 0.25;
    v.position.set(x, 0, z);
    v.userData.type = 'scenery';
    v.userData.biome = this.currentBiome || 'snow';
    this.scene.add(v);
    this.scenery.push(v);
  }

  _addRockCluster(x, z, biome) {
    const group = new THREE.Group();
    biome = biome || this.currentBiome || 'snow';

    // Reddish-brown rocks (#8B4513) per spec; tropical biome uses darker
    // volcanic (#4a3728).
    const baseHex = biome === 'tropical' ? 0x4a3728 : 0x8B4513;

    const count = 2 + Math.floor(Math.random() * 3); // 2-4
    for (let i = 0; i < count; i++) {
      const r = 0.9 + Math.random() * 0.9; // bigger boulders (≈ 0.9-1.8)
      const geo = new THREE.IcosahedronGeometry(r, 0);
      // Jitter vertices for a rough surface
      const pos = geo.attributes.position;
      for (let j = 0; j < pos.count; j++) {
        pos.setXYZ(
          j,
          pos.getX(j) + (Math.random() - 0.5) * 0.32,
          pos.getY(j) + (Math.random() - 0.5) * 0.32,
          pos.getZ(j) + (Math.random() - 0.5) * 0.32,
        );
      }
      geo.computeVertexNormals();
      const tint = new THREE.Color(baseHex).offsetHSL(0, 0, (Math.random() - 0.5) * 0.06);
      const rock = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: tint, roughness: 1.0, flatShading: true }),
      );
      rock.position.set(
        (Math.random() - 0.5) * 2.6,
        r * 0.55,
        (Math.random() - 0.5) * 2.6,
      );
      rock.rotation.y = Math.random() * Math.PI * 2;
      // Phase 5 perf: rocks/cliff-chunks are tiny or sit far back; cast
      // shadows contribute nothing visually at run speed.
      rock.castShadow = false;
      rock.receiveShadow = false;
      group.add(rock);
    }

    // Snow biome: dust the cluster with a few small white specks
    if (biome === 'snow') {
      const snowMat = new THREE.MeshStandardMaterial({ color: 0xfafdff, roughness: 0.7 });
      for (let i = 0; i < 3; i++) {
        const cap = new THREE.Mesh(new THREE.SphereGeometry(0.25, 6, 6), snowMat);
        cap.scale.set(1, 0.4, 1);
        cap.position.set(
          (Math.random() - 0.5) * 2.2,
          0.85 + Math.random() * 0.3,
          (Math.random() - 0.5) * 2.2,
        );
        group.add(cap);
      }
    }

    group.position.set(x, 0, z);
    group.userData.type = 'scenery';
    group.userData.biome = biome;
    // Side-hit collision: rock cluster is a low solid mass. Player can
    // fully clear by jumping (cluster is short, height ~1.6m), but a
    // ground-level side hit explodes them.
    group.userData.collidable = true;
    group.userData.length = 2.4;
    group.userData.width  = 2.4;
    group.userData.height = 1.6;
    group.userData.kind = 'rock';
    this.scene.add(group);
    this.scenery.push(group);
  }

  _addPineTree(x, z, biome) {
    biome = biome || this.currentBiome || 'snow';
    // Snow biome: ~35% chance to upgrade an instanced pine into a real
    // Kenney holiday snow-tree. Non-instanced (so no perf savings) but
    // visually richer — gives the snow stretch a varied "festival forest"
    // look. Falls through to the instanced path if the model isn't ready
    // or the dice rolls cold, so perf stays bounded.
    if (biome === 'snow' && this._models && Math.random() < 0.35) {
      const TREE_KEYS = ['holiday/tree-snow-a', 'holiday/tree-snow-b', 'holiday/tree-snow-c'];
      const key = TREE_KEYS[Math.floor(Math.random() * TREE_KEYS.length)];
      const km = this._models.cloneByKey(key);
      if (km) {
        const targetH = 3.2 + Math.random() * 1.6;  // 3.2-4.8m
        this._models.fitToBox(km, { height: targetH, mode: 'fit' });
        km.rotation.y = Math.random() * Math.PI * 2;
        const group = new THREE.Group();
        group.position.set(x, 0, z);
        group.add(km);
        group.userData.type = 'scenery';
        group.userData.biome = biome;
        group.userData.kenneyModel = true;
        group.userData.collidable = true;
        group.userData.length = 1.0;
        group.userData.width  = 1.0;
        group.userData.height = 4.0;
        group.userData.kind = 'tree';
        this.scene.add(group);
        this.scenery.push(group);
        return;
      }
    }
    // Phase 1 perf: instanced. Returns a marker Group (no real meshes added
    // to the scene) carrying the instance handle. Recycle path releases
    // the instance via _disposeObject's userData.releaseInstance hook.
    const handle = this.instancedScenery.addPine(x, z, { biome });
    const marker = new THREE.Group();
    marker.position.set(x, 0, z);
    marker.userData.type = 'scenery';
    marker.userData.biome = biome;
    marker.userData.instanceHandle = handle;
    marker.userData.releaseInstance = () => this.instancedScenery.release(handle);
    // Side-hit collision: pine trunk is ~0.4m wide, foliage flares to ~2m,
    // top reaches ~4m. Trunk is the lethal solid; if the player jumps over
    // (py > height - margin) they pass safely through the soft foliage.
    marker.userData.collidable = true;
    marker.userData.length = 0.9;     // hit-box Z half-extent ×2
    marker.userData.width  = 0.9;     // hit-box X half-extent ×2
    marker.userData.height = 4.0;     // safe-clear altitude
    marker.userData.kind = 'tree';
    this.scenery.push(marker);
  }

  _addCabin(x, z) {
    const group = new THREE.Group();

    const w = 3 + Math.random() * 1.5;
    const h = 2.2 + Math.random() * 0.6;
    const d = 3 + Math.random() * 1.2;

    // Kenney fast-path — reuses the city-kit mid-rise GLBs scaled
    // down to cabin proportions. Falls through to the procedural log
    // cabin geometry if the model cache isn't ready.
    if (this._models) {
      const KEYS = ['buildings/a', 'buildings/b', 'buildings/c', 'buildings/d', 'buildings/e'];
      const km = this._models.cloneByKey(KEYS[Math.floor(Math.random() * KEYS.length)]);
      if (km) {
        this._models.fitToBox(km, { width: w, height: h, length: d, mode: 'stretch' });
        km.position.y = 0.01;
        group.add(km);
        group.userData.kenneyModel = true;
        group.position.set(x, 0, z);
        group.rotation.y = (x < 0 ? -1 : 1) * (Math.PI / 8) * (Math.random() - 0.5);
        group.userData.type = 'scenery';
        group.userData.biome = 'snow';
        group.userData.kind = 'cabin';
        group.userData.collidable = true;
        group.userData.length = d;
        group.userData.width  = w;
        group.userData.height = h;
        this.scene.add(group);
        this.scenery.push(group);
        return;
      }
    }

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.9 });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    wall.position.y = h / 2;
    wall.castShadow = true;
    group.add(wall);

    // Snowy roof — triangular prism
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xf5f5fa, roughness: 0.6 });
    const roofShape = new THREE.Shape();
    roofShape.moveTo(-w / 2 - 0.2, 0);
    roofShape.lineTo(w / 2 + 0.2, 0);
    roofShape.lineTo(0, 1.4);
    roofShape.lineTo(-w / 2 - 0.2, 0);
    const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: d + 0.4, bevelEnabled: false });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.rotation.y = Math.PI / 2;
    roof.position.set(0, h, -d / 2 - 0.2);
    roof.rotation.set(0, 0, 0);
    roof.position.set(-(d + 0.4) / 2, h, 0);
    roof.rotation.y = Math.PI / 2;
    group.add(roof);

    // Door
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x3a2410 });
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.2, 0.05), doorMat);
    door.position.set(0, 0.6, d / 2 + 0.03);
    group.add(door);

    // Glowing window
    const winMat = new THREE.MeshStandardMaterial({
      color: 0xfff2a8, emissive: 0xffd97a, emissiveIntensity: 0.6,
    });
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.5), winMat);
    win.position.set(w / 2 - 0.7, h * 0.65, d / 2 + 0.03);
    group.add(win);

    group.position.set(x, 0, z);
    group.rotation.y = (x < 0 ? -1 : 1) * (Math.PI / 8) * (Math.random() - 0.5);
    group.userData.type = 'scenery';
    group.userData.biome = 'snow';
    group.userData.kind = 'cabin';
    group.userData.collidable = true;
    group.userData.length = d;
    group.userData.width  = w;
    group.userData.height = h;
    this.scene.add(group);
    this.scenery.push(group);
  }

  _addStreetLamp(x, z) {
    const handle = this.instancedScenery.addLamp(x, z);
    const marker = new THREE.Group();
    marker.position.set(x, 0, z);
    marker.userData.type = 'scenery';
    marker.userData.biome = 'city';
    marker.userData.instanceHandle = handle;
    marker.userData.releaseInstance = () => this.instancedScenery.release(handle);
    // Side-hit collision: pole is thin but lethal. The lamp's reach arm
    // sticks out toward the road, so the hit zone is wider on the road side.
    marker.userData.collidable = true;
    marker.userData.length = 0.5;
    marker.userData.width  = 1.2;     // wider so the arm + head are covered
    marker.userData.height = 4.0;
    marker.userData.kind = 'lamp';
    this.scenery.push(marker);
  }

  _addPalmTree(x, z) {
    const handle = this.instancedScenery.addPalm(x, z);
    const marker = new THREE.Group();
    marker.position.set(x, 0, z);
    marker.userData.type = 'scenery';
    marker.userData.biome = 'tropical';
    marker.userData.instanceHandle = handle;
    marker.userData.releaseInstance = () => this.instancedScenery.release(handle);
    // Side-hit collision: thin trunk, fronds high up. Player can clear by
    // jumping past trunk height; below that, hitting the trunk = death.
    marker.userData.collidable = true;
    marker.userData.length = 0.6;
    marker.userData.width  = 0.6;
    marker.userData.height = 4.5;
    marker.userData.kind = 'tree';
    this.scenery.push(marker);
  }

  _addTikiHut(x, z) {
    const group = new THREE.Group();

    const w = 2.4 + Math.random() * 1;
    const h = 1.8 + Math.random() * 0.4;
    const d = 2.4 + Math.random() * 1;

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xd4a96a, roughness: 0.95 });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    wall.position.y = h / 2;
    wall.castShadow = true;
    group.add(wall);

    // Thatched (cone) roof
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x7a5a2a, roughness: 0.95 });
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.85, 1.6, 4), roofMat);
    roof.position.y = h + 0.7;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    group.add(roof);

    // Door
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x3a2410 });
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.1, 0.05), doorMat);
    door.position.set(0, 0.55, d / 2 + 0.03);
    group.add(door);

    group.position.set(x, 0, z);
    group.rotation.y = Math.random() * Math.PI * 2;
    group.userData.type = 'scenery';
    group.userData.biome = 'tropical';
    group.userData.kind = 'tiki_hut';
    group.userData.collidable = true;
    group.userData.length = d;
    group.userData.width  = w;
    group.userData.height = h + 1.6;   // include cone roof
    this.scene.add(group);
    this.scenery.push(group);
  }

  _addBuilding(x, z) {
    const group = new THREE.Group();

    const width = 3 + Math.random() * 3;
    const depth = 3 + Math.random() * 2.5;
    const height = 6 + Math.random() * 18;

    const palette = [0xc97f5a, 0x7a8fa6, 0xd9c79a, 0x9ab4a0, 0xb56a6a, 0x6f7c8c, 0xe0b97a];
    const color = palette[Math.floor(Math.random() * palette.length)];

    const bodyGeo = new THREE.BoxGeometry(width, height, depth);
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = height / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // Roof cap (slightly darker, slightly wider)
    const roofGeo = new THREE.BoxGeometry(width + 0.2, 0.3, depth + 0.2);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x333741 });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.y = height + 0.15;
    group.add(roof);

    // Windows — emissive grid on the side facing the road
    const facingSign = x < 0 ? 1 : -1;
    const winMat = new THREE.MeshStandardMaterial({
      color: 0xfff2a8,
      emissive: 0xffd97a,
      emissiveIntensity: 0.35,
      roughness: 0.4,
    });
    const winSize = 0.4;
    const cols = Math.max(2, Math.floor(width / 1.0));
    const rows = Math.max(2, Math.floor(height / 1.4));
    const colStep = width / (cols + 1);
    const rowStep = height / (rows + 1);
    for (let c = 1; c <= cols; c++) {
      for (let r = 1; r <= rows; r++) {
        const winGeo = new THREE.PlaneGeometry(winSize, winSize);
        const win = new THREE.Mesh(winGeo, winMat);
        win.position.set(
          -width / 2 + c * colStep,
          r * rowStep,
          facingSign * (depth / 2 + 0.01)
        );
        if (facingSign === -1) win.rotation.y = Math.PI;
        group.add(win);
      }
    }

    group.position.set(x, 0, z);
    group.userData.type = 'scenery';
    group.userData.biome = 'city';
    group.userData.kind = 'building_basic';
    group.userData.collidable = true;
    group.userData.length = depth;
    group.userData.width  = width;
    group.userData.height = height;
    this.scene.add(group);
    this.scenery.push(group);
  }

  // ── Snow biome buildings ────────────────────────────────────

  _addSnowShop(x, z) {
    const group = new THREE.Group();
    const w = 3 + Math.random() * 2;       // 3-5
    const h = 4 + Math.random() * 2;       // 4-6
    const d = 3 + Math.random() * 1.6;
    // Snow biome reads as an outdoor festival, NOT a small town. Replace
    // procedural shops with Kenney survival tents + a watching crowd /
    // campfire combo. The "shop" name is kept so the side-decor picker
    // doesn't need to change.
    if (this._models) {
      const tentKeys = ['survival/tent', 'survival/tent-canvas', 'survival/tent-canvas-half'];
      const km = this._models.cloneByKey(tentKeys[Math.floor(Math.random() * tentKeys.length)]);
      if (km) {
        // Kenney tents are ~2m wide × 2m tall × 2m long natively. Scale up
        // to match the previous snow-shop footprint so the safe-Z and
        // collision math (which both read .length) stays compatible.
        this._models.fitToBox(km, { width: w * 0.85, height: h * 0.55, length: d * 0.85, mode: 'fit' });
        km.position.y = 0.01;
        km.rotation.y = Math.random() * Math.PI * 2;
        group.add(km);

        // 30% chance: park a campfire next to the tent for a camp vibe.
        if (Math.random() < 0.3) {
          const fire = this._models.cloneByKey('survival/campfire-pit');
          if (fire) {
            fire.position.set((Math.random() - 0.5) * 1.6, 0.02, (Math.random() - 0.5) * 1.6);
            this._models.fitToBox(fire, { height: 0.5, mode: 'fit' });
            group.add(fire);
          }
        }
        group.userData.kenneyModel = true;
        group.position.set(x, 0, z);
        group.userData.type = 'scenery';
        group.userData.biome = 'snow';
        group.userData.kind = 'snow_tent';
        group.userData.collidable = true;
        group.userData.length = d;
        group.userData.width  = w;
        group.userData.height = h * 0.6;
        this.scene.add(group);
        this.scenery.push(group);
        return;
      }
    }
    const palette = [0x4a90d9, 0x7ecfb3, 0xb5651d, 0xc0392b, 0xe6a23c];
    const color = palette[Math.floor(Math.random() * palette.length)];

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.85 })
    );
    body.position.y = h / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // Snow-covered roof — flat white slab slightly oversized
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.4, 0.35, d + 0.4),
      new THREE.MeshStandardMaterial({ color: 0xfafdff, roughness: 0.7 })
    );
    roof.position.y = h + 0.18;
    roof.castShadow = true;
    group.add(roof);

    // Awning over the front (facing the road)
    const facing = x < 0 ? 1 : -1;
    const awningColors = [0xc0392b, 0x2980b9, 0xf1c40f, 0x16a085, 0xf39c12];
    const awning = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.85, 0.18, 1.0),
      new THREE.MeshStandardMaterial({
        color: awningColors[Math.floor(Math.random() * awningColors.length)],
        roughness: 0.7,
      })
    );
    awning.position.set(0, h * 0.55, facing * (d / 2 + 0.5));
    group.add(awning);

    // Sign — flat colored rectangle on the facade
    const signColors = [0xffffff, 0xffeb3b, 0xff7043, 0x80deea];
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 0.55, 0.7),
      new THREE.MeshStandardMaterial({
        color: signColors[Math.floor(Math.random() * signColors.length)],
        roughness: 0.4, emissive: 0x222222, emissiveIntensity: 0.15,
      })
    );
    sign.position.set(0, h * 0.78, facing * (d / 2 + 0.02));
    if (facing < 0) sign.rotation.y = Math.PI;
    group.add(sign);

    // Door
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 1.2, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x3a2410 })
    );
    door.position.set(-w * 0.18, 0.6, facing * (d / 2 + 0.03));
    group.add(door);

    // A few warm windows on the facade
    const winMat = new THREE.MeshStandardMaterial({
      color: 0xfff2a8, emissive: 0xffd97a, emissiveIntensity: 0.35,
    });
    for (let i = 0; i < 3; i++) {
      const wn = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 0.35), winMat);
      wn.position.set(w * 0.22 - i * 0.5, h * 0.35, facing * (d / 2 + 0.02));
      if (facing < 0) wn.rotation.y = Math.PI;
      group.add(wn);
    }

    group.position.set(x, 0, z);
    group.userData.type = 'scenery';
    group.userData.biome = 'snow';
    group.userData.kind = 'snow_shop';
    group.userData.collidable = true;
    group.userData.length = d;
    group.userData.width  = w;
    group.userData.height = h;
    this.scene.add(group);
    this.scenery.push(group);
  }

  _addSnowTallBuilding(x, z) {
    const group = new THREE.Group();
    const w = 4 + Math.random() * 2;
    const d = 3.5 + Math.random() * 1.5;
    const h = 8 + Math.random() * 4;       // 8-12 occasional taller
    // Snow biome reads as an outdoor festival, not a built-up town.
    // Replace the procedural "tall building" with a giant decorated
    // Kenney tree (festival vibe) — much taller than a regular pine.
    if (this._models) {
      const km = this._models.cloneByKey('holiday/tree-decorated');
      if (km) {
        const targetH = h;          // 8-12m as before
        const targetW = w * 0.6;
        this._models.fitToBox(km, { width: targetW, height: targetH, length: targetW, mode: 'fit' });
        km.position.y = 0.01;
        km.rotation.y = Math.random() * Math.PI * 2;
        group.add(km);
        group.userData.kenneyModel = true;
        group.position.set(x, 0, z);
        group.userData.type = 'scenery';
        group.userData.biome = 'snow';
        group.userData.kind = 'snow_decorated_tree';
        group.userData.collidable = true;
        group.userData.length = d;
        group.userData.width  = w;
        group.userData.height = h;
        this.scene.add(group);
        this.scenery.push(group);
        return;
      }
    }
    const greys = [0x9aa0a6, 0x7d8590, 0xb0b6bd];
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({
        color: greys[Math.floor(Math.random() * greys.length)],
        roughness: 0.7,
      })
    );
    body.position.y = h / 2;
    body.castShadow = true;
    group.add(body);

    // Snow cap on top
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.3, 0.35, d + 0.3),
      new THREE.MeshStandardMaterial({ color: 0xfafdff, roughness: 0.7 })
    );
    cap.position.y = h + 0.18;
    group.add(cap);

    // Window grid
    const facing = x < 0 ? 1 : -1;
    const winMat = new THREE.MeshStandardMaterial({
      color: 0xfff2a8, emissive: 0xffd97a, emissiveIntensity: 0.3,
    });
    const cols = Math.max(2, Math.floor(w / 1.0));
    const rows = Math.max(3, Math.floor(h / 1.4));
    const colStep = w / (cols + 1);
    const rowStep = h / (rows + 1);
    for (let c = 1; c <= cols; c++) {
      for (let r = 1; r <= rows; r++) {
        const wn = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 0.35), winMat);
        wn.position.set(-w / 2 + c * colStep, r * rowStep, facing * (d / 2 + 0.01));
        if (facing < 0) wn.rotation.y = Math.PI;
        group.add(wn);
      }
    }

    group.position.set(x, 0, z);
    group.userData.type = 'scenery';
    group.userData.biome = 'snow';
    group.userData.kind = 'snow_tall_building';
    group.userData.collidable = true;
    group.userData.length = d;
    group.userData.width  = w;
    group.userData.height = h;
    this.scene.add(group);
    this.scenery.push(group);
  }

  // ── City biome buildings ────────────────────────────────────

  _addSkyscraper(x, z, opts = {}) {
    const group = new THREE.Group();
    const w = 5 + Math.random() * 3;       // 5-8
    const d = 4 + Math.random() * 3;
    const h = 20 + Math.random() * 20;     // 20-40
    // Kenney fast-path: pick one of the three skyscraper GLBs.
    const KENNEY_SKYSCRAPER_KEYS = ['buildings/skyscraper-a', 'buildings/skyscraper-b', 'buildings/skyscraper-c'];
    if (this._models) {
      const key = KENNEY_SKYSCRAPER_KEYS[Math.floor(Math.random() * KENNEY_SKYSCRAPER_KEYS.length)];
      const km = this._models.cloneByKey(key);
      if (km) {
        this._models.fitToBox(km, { width: w, height: h, length: d, mode: 'stretch' });
        km.position.y = 0.01;
        group.add(km);
        group.userData.kenneyModel = true;
        group.position.set(x, 0, z);
        group.userData.type = 'scenery';
        group.userData.biome = 'city';
        group.userData.kind = 'skyscraper';
        group.userData.collidable = true;
        group.userData.length = d;
        group.userData.width  = w;
        group.userData.height = h;
        this.scene.add(group);
        this.scenery.push(group);
        return group;
      }
    }
    const tint = [0x4a90d9, 0x6fb1ff, 0x9bc4e2, 0x6cd2c2];
    const color = tint[Math.floor(Math.random() * tint.length)];

    const glassMat = new THREE.MeshStandardMaterial({
      color, metalness: 0.7, roughness: 0.2, envMapIntensity: 1,
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), glassMat);
    body.position.y = h / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // Roof crown
    const crown = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.6, 1.2, d * 0.6),
      new THREE.MeshStandardMaterial({ color: 0x3a3f48, roughness: 0.6 })
    );
    crown.position.y = h + 0.6;
    group.add(crown);

    // Subtle horizontal floor lines (slightly darker thin slabs)
    const lineMat = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.5 });
    const floors = Math.max(4, Math.floor(h / 3));
    for (let i = 1; i < floors; i++) {
      const ln = new THREE.Mesh(
        new THREE.BoxGeometry(w + 0.04, 0.06, d + 0.04),
        lineMat
      );
      ln.position.y = (i / floors) * h;
      group.add(ln);
    }

    // Optional decorative helix wrapping around the building
    if (opts.helix || Math.random() < 0.18) {
      const helixGroup = new THREE.Group();
      const helixMat = new THREE.MeshStandardMaterial({
        color: 0xeff5ff, emissive: 0xb6d6ff, emissiveIntensity: 0.5,
      });
      const r = Math.max(w, d) / 2 + 0.25;
      const turns = 3.2;
      const segments = 80;
      for (let i = 0; i < segments; i++) {
        const t = i / segments;
        const angle = t * turns * Math.PI * 2;
        const seg = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 6), helixMat);
        seg.position.set(
          Math.cos(angle) * r,
          0.5 + t * (h - 1),
          Math.sin(angle) * r,
        );
        helixGroup.add(seg);
      }
      group.add(helixGroup);
    }

    // Planter / bushes at the base, road-facing
    const facing = x < 0 ? 1 : -1;
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x2e8b3f, roughness: 0.8 });
    for (let i = -1; i <= 1; i++) {
      const bush = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 8), bushMat);
      bush.position.set(i * (w / 3), 0.45, facing * (d / 2 + 0.7));
      group.add(bush);
    }
    const planter = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.9, 0.3, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x6b6b70, roughness: 0.7 })
    );
    planter.position.set(0, 0.15, facing * (d / 2 + 0.7));
    group.add(planter);

    group.position.set(x, 0, z);
    group.userData.type = 'scenery';
    group.userData.biome = 'city';
    group.userData.kind = 'skyscraper';
    group.userData.collidable = true;
    group.userData.length = d;
    group.userData.width  = w;
    group.userData.height = h;
    this.scene.add(group);
    this.scenery.push(group);
    return group;
  }

  _addCityMidRise(x, z) {
    const group = new THREE.Group();
    const w = 5 + Math.random() * 2;
    const d = 4 + Math.random() * 1.5;
    const h = 10 + Math.random() * 6;
    // Kenney fast-path: clone one of the city-kit building GLBs and
    // scale it to fit the procedural footprint. Falls through to the
    // procedural box body on cache miss.
    const KENNEY_BUILDING_KEYS = ['buildings/a', 'buildings/b', 'buildings/c', 'buildings/d', 'buildings/e'];
    if (this._models) {
      const key = KENNEY_BUILDING_KEYS[Math.floor(Math.random() * KENNEY_BUILDING_KEYS.length)];
      const km = this._models.cloneByKey(key);
      if (km) {
        this._models.fitToBox(km, { width: w, height: h, length: d, mode: 'stretch' });
        km.position.y = 0.01;
        group.add(km);
        // Skip the procedural body + window-grid block below since the
        // Kenney model already includes those details. Hit-box userData
        // is still set at the bottom for AI/collision.
        group.userData.kenneyModel = true;
        group.position.set(x, 0, z);
        group.userData.type = 'scenery';
        group.userData.biome = 'city';
        group.userData.kind = 'city_midrise';
        group.userData.collidable = true;
        group.userData.length = d;
        group.userData.width  = w;
        group.userData.height = h;
        this.scene.add(group);
        this.scenery.push(group);
        return;
      }
    }
    const palette = [0xc97f5a, 0x7a8fa6, 0xd9c79a, 0x9ab4a0, 0xb56a6a];
    const color = palette[Math.floor(Math.random() * palette.length)];
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.85 })
    );
    body.position.y = h / 2;
    body.castShadow = true;
    group.add(body);

    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.2, 0.3, d + 0.2),
      new THREE.MeshStandardMaterial({ color: 0x333741 })
    );
    roof.position.y = h + 0.15;
    group.add(roof);

    // Window grid
    const facing = x < 0 ? 1 : -1;
    const winMat = new THREE.MeshStandardMaterial({
      color: 0xfff2a8, emissive: 0xffd97a, emissiveIntensity: 0.35,
    });
    const cols = Math.max(3, Math.floor(w / 0.9));
    const rows = Math.max(3, Math.floor(h / 1.4));
    const colStep = w / (cols + 1);
    const rowStep = h / (rows + 1);
    for (let c = 1; c <= cols; c++) {
      for (let r = 1; r <= rows; r++) {
        const wn = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.32), winMat);
        wn.position.set(-w / 2 + c * colStep, r * rowStep, facing * (d / 2 + 0.01));
        if (facing < 0) wn.rotation.y = Math.PI;
        group.add(wn);
      }
    }

    group.position.set(x, 0, z);
    group.userData.type = 'scenery';
    group.userData.biome = 'city';
    group.userData.kind = 'city_midrise';
    group.userData.collidable = true;
    group.userData.length = d;
    group.userData.width  = w;
    group.userData.height = h;
    this.scene.add(group);
    this.scenery.push(group);
  }

  _addCityWalkwayPair(side, z) {
    // Two skyscrapers in line connected by an elevated bridge.
    const sign = side;
    const x1 = sign * (12 + Math.random() * 1.5);
    const x2 = sign * (16.5 + Math.random() * 1.5);
    const a = this._addSkyscraper(x1, z, { helix: false });
    const b = this._addSkyscraper(x2, z + (Math.random() - 0.5) * 2, { helix: false });

    // Bridge: thin horizontal box at ~y=10 connecting the inner faces
    const bridgeY = 9 + Math.random() * 2;
    const bridge = new THREE.Mesh(
      new THREE.BoxGeometry(Math.abs(x2 - x1), 0.8, 1.2),
      new THREE.MeshStandardMaterial({
        color: 0xb6d6ff, metalness: 0.5, roughness: 0.3,
        emissive: 0x88aacc, emissiveIntensity: 0.3,
      })
    );
    bridge.position.set((x1 + x2) / 2, bridgeY, z);
    bridge.castShadow = true;
    bridge.userData.type = 'scenery';
    bridge.userData.biome = 'city';
    this.scene.add(bridge);
    this.scenery.push(bridge);
    void a; void b;
  }

  _addPlanter(x, z) {
    const group = new THREE.Group();
    const planter = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.35, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x6b6b70, roughness: 0.7 })
    );
    planter.position.y = 0.175;
    group.add(planter);
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x2e8b3f, roughness: 0.85 });
    for (let i = -1; i <= 1; i++) {
      const bush = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 8), bushMat);
      bush.position.set(i * 0.45, 0.55, 0);
      group.add(bush);
    }
    group.position.set(x, 0, z);
    group.userData.type = 'scenery';
    group.userData.biome = 'city';
    group.userData.kind = 'planter';
    group.userData.collidable = true;
    group.userData.length = 0.6;
    group.userData.width  = 1.4;
    group.userData.height = 0.9;     // low; potentially hoppable
    this.scene.add(group);
    this.scenery.push(group);
  }

  // ── Tropical biome buildings ───────────────────────────────

  _addTropicalMidRise(x, z) {
    const group = new THREE.Group();
    const w = 4.5 + Math.random() * 2;
    const d = 4 + Math.random() * 1.5;
    const h = 9 + Math.random() * 5;
    if (this._models) {
      const KEYS = ['buildings/a', 'buildings/b', 'buildings/c', 'buildings/d', 'buildings/e'];
      const km = this._models.cloneByKey(KEYS[Math.floor(Math.random() * KEYS.length)]);
      if (km) {
        this._models.fitToBox(km, { width: w, height: h, length: d, mode: 'stretch' });
        km.position.y = 0.01;
        group.add(km);
        group.userData.kenneyModel = true;
        group.position.set(x, 0, z);
        group.userData.type = 'scenery';
        group.userData.biome = 'tropical';
        group.userData.kind = 'tropical_midrise';
        group.userData.collidable = true;
        group.userData.length = d;
        group.userData.width  = w;
        group.userData.height = h;
        this.scene.add(group);
        this.scenery.push(group);
        return;
      }
    }
    const palette = [0xff9aa2, 0xffd6a5, 0xfdffb6, 0xcaffbf, 0x9bf6ff, 0xa0c4ff, 0xbdb2ff];
    const color = palette[Math.floor(Math.random() * palette.length)];
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.85 })
    );
    body.position.y = h / 2;
    body.castShadow = true;
    group.add(body);

    // Roof slab
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.3, 0.25, d + 0.3),
      new THREE.MeshStandardMaterial({ color: 0x7a5a2a })
    );
    roof.position.y = h + 0.12;
    group.add(roof);

    // Balconies — small box cutouts every floor on the road-facing side
    const facing = x < 0 ? 1 : -1;
    const balMat = new THREE.MeshStandardMaterial({ color: 0x3a2410, roughness: 0.7 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0xe6e6e6 });
    const floors = Math.max(2, Math.floor(h / 3));
    for (let i = 1; i <= floors; i++) {
      const fy = (i / (floors + 0.5)) * h;
      const balcony = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.15, 0.7), balMat);
      balcony.position.set(0, fy, facing * (d / 2 + 0.35));
      group.add(balcony);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.5, 0.06), railMat);
      rail.position.set(0, fy + 0.3, facing * (d / 2 + 0.7));
      group.add(rail);
      // Door cutout (just a darker rectangle on the wall)
      const doorMat = new THREE.MeshStandardMaterial({ color: 0x2c1f10 });
      const door = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 1.0), doorMat);
      door.position.set(0, fy + 0.55, facing * (d / 2 + 0.01));
      if (facing < 0) door.rotation.y = Math.PI;
      group.add(door);
    }

    group.position.set(x, 0, z);
    group.userData.type = 'scenery';
    group.userData.biome = 'tropical';
    group.userData.kind = 'tropical_midrise';
    group.userData.collidable = true;
    group.userData.length = d;
    group.userData.width  = w;
    group.userData.height = h;
    this.scene.add(group);
    this.scenery.push(group);
  }

  _addCliffWall(x, z) {
    const group = new THREE.Group();
    const tropical = this.currentBiome === 'tropical';
    const baseColor = tropical ? 0x8b4513 : 0x6b4423;

    const segments = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < segments; i++) {
      const w = 3 + Math.random() * 2;
      const d = 2.5 + Math.random() * 1.5;
      const h = 8 + Math.random() * 8;
      const chunk = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(baseColor).offsetHSL(0, 0, (Math.random() - 0.5) * 0.08),
          roughness: 1.0,
          flatShading: true,
        })
      );
      // Skew to create irregular cliff face
      chunk.position.set(
        (Math.random() - 0.5) * 1.2,
        h / 2,
        (i - segments / 2) * (d * 0.9) + (Math.random() - 0.5) * 0.5,
      );
      chunk.rotation.y = (Math.random() - 0.5) * 0.4;
      chunk.castShadow = false;
      chunk.receiveShadow = false;
      group.add(chunk);
    }

    group.position.set(x, 0, z);
    group.userData.type = 'scenery';
    group.userData.biome = 'tropical';
    group.userData.kind = 'cliff_wall';
    group.userData.collidable = true;
    group.userData.length = 12;
    group.userData.width  = 5;
    group.userData.height = 12;
    this.scene.add(group);
    this.scenery.push(group);
  }

  // Unified lane-obstacle spawner used along the snowy slope. Drops a single
  // hazard (vehicle OR rock) in ONE random lane, leaves the other two clear so
  // the player can always pick a path through. Skips Z slots that overlap a
  // cross-street or a ramp.
  _spawnLaneObstacle(z) {
    if (this._zHasCrossStreet(z, 5)) return false;
    // Project-wide rule: don't drop a lane obstacle inside a high-rise
    // building's footprint — the lane is dedicated to threading the
    // arch tunnel. Pad by 4m so cars don't sit right at the entrance.
    if (this._zInsideBuilding(z, 4)) return false;
    for (const ramp of this.ramps) {
      if (Math.abs(ramp.position.z - z) < 5) return false;
    }
    // Make sure we don't stack on top of an existing obstacle
    for (const o of this.obstacles) {
      if (Math.abs(o.position.z - z) < 6) return false;
    }

    const lane = Math.floor(Math.random() * 3) - 1; // -1, 0, 1
    const x = lane * GAME_CONFIG.LANE_WIDTH;

    let obstacle;
    if (Math.random() < 0.65) {
      const types = ['taxi', 'taxi', 'suv', 'truck', 'cityBus', 'schoolBus'];
      const type = types[Math.floor(Math.random() * types.length)];
      obstacle = this._buildStaticVehicle(type);
      // Random forward/backward facing — half don't "face" the player
      if (Math.random() < 0.5) obstacle.rotation.y = Math.PI;
      // Small "slid on ice" tilt for variety
      if (Math.random() < 0.3) {
        const sign = Math.random() < 0.5 ? -1 : 1;
        obstacle.rotation.y += sign * (10 + Math.random() * 20) * Math.PI / 180;
      }
      obstacle.userData.vehicleType = type;
    } else {
      obstacle = this._buildLaneRock(this.currentBiome || 'snow');
      // Hit-box dims for the rock
      obstacle.userData.length = 1.6;
      obstacle.userData.width = 1.6;
    }
    obstacle.position.set(x, 0, z);
    obstacle.userData.type = 'obstacle';
    obstacle.userData.lane = lane + 1;

    this.scene.add(obstacle);
    this.obstacles.push(obstacle);
    return true;
  }

  // Older entry point kept so existing callers / tests don't break.
  _spawnPlaceholderObstacle(z) {
    return this._spawnLaneObstacle(z);
  }

  _buildLaneRock(biome) {
    const group = new THREE.Group();
    biome = biome || 'snow';
    // Reddish-brown #8B4513, darker volcanic in tropical
    const baseHex = biome === 'tropical' ? 0x4a3728 : 0x8B4513;

    // Kenney fast-path: clone a fantasy-town rock GLB. We pick a key,
    // fit it to roughly the same footprint as the procedural boulder
    // cluster (≈2m wide, 1.5m tall) so the existing hit-box (height
    // 1.5) still works without changes.
    if (this._models) {
      const KEYS = ['rocks/large', 'rocks/wide', 'rocks/small'];
      const key = KEYS[Math.floor(Math.random() * KEYS.length)];
      const km = this._models.cloneByKey(key);
      if (km) {
        const targetH = key === 'rocks/small' ? 1.0 : 1.5;
        const targetW = key === 'rocks/wide' ? 2.4 : 2.0;
        const targetL = key === 'rocks/wide' ? 2.4 : 2.0;
        this._models.fitToBox(km, { width: targetW, height: targetH, length: targetL, mode: 'fit' });
        if (biome === 'snow') {
          // Lightly desaturate the warm fantasy texture so it reads as
          // a snowy rock rather than a desert one.
          km.traverse((o) => {
            if (o.isMesh && o.material && o.material.color) {
              const c = o.material.color;
              c.r = c.r * 0.7 + 0.25;
              c.g = c.g * 0.7 + 0.25;
              c.b = c.b * 0.7 + 0.3;
            }
          });
        } else if (biome === 'tropical') {
          km.traverse((o) => {
            if (o.isMesh && o.material && o.material.color) {
              o.material.color.multiplyScalar(0.55);
            }
          });
        }
        km.rotation.y = Math.random() * Math.PI * 2;
        group.add(km);
        if (biome === 'snow') {
          const cap = new THREE.Mesh(
            new THREE.SphereGeometry(0.32, 6, 6),
            new THREE.MeshStandardMaterial({ color: 0xfafdff, roughness: 0.7 }),
          );
          cap.scale.set(1, 0.4, 1);
          cap.position.set(0, targetH * 0.92, 0);
          group.add(cap);
        }
        group.userData.kenneyModel = true;
        group.userData.height = 1.5;
        return group;
      }
    }

    // 1 large boulder + (50% of the time) a small companion. Tight footprint
    // so the cluster sits comfortably inside a 3-unit lane.
    const count = Math.random() < 0.5 ? 1 : 2;
    for (let i = 0; i < count; i++) {
      const r = i === 0
        ? 0.75 + Math.random() * 0.4   // 0.75-1.15
        : 0.35 + Math.random() * 0.2;
      const geo = new THREE.IcosahedronGeometry(r, 0);
      const pos = geo.attributes.position;
      for (let j = 0; j < pos.count; j++) {
        pos.setXYZ(
          j,
          pos.getX(j) + (Math.random() - 0.5) * 0.22,
          pos.getY(j) + (Math.random() - 0.5) * 0.22,
          pos.getZ(j) + (Math.random() - 0.5) * 0.22,
        );
      }
      geo.computeVertexNormals();
      const tint = new THREE.Color(baseHex).offsetHSL(0, 0, (Math.random() - 0.5) * 0.06);
      const rock = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: tint, roughness: 1.0, flatShading: true }),
      );
      rock.position.set(
        i === 0 ? 0 : (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.3),
        r * 0.55,
        i === 0 ? 0 : (Math.random() - 0.5) * 0.5,
      );
      rock.rotation.y = Math.random() * Math.PI * 2;
      // Phase 5 perf: rocks/cliff-chunks are tiny or sit far back; cast
      // shadows contribute nothing visually at run speed.
      rock.castShadow = false;
      rock.receiveShadow = false;
      group.add(rock);
    }

    if (biome === 'snow') {
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 6, 6),
        new THREE.MeshStandardMaterial({ color: 0xfafdff, roughness: 0.7 }),
      );
      cap.scale.set(1, 0.4, 1);
      cap.position.set(0, 0.95, 0);
      group.add(cap);
    }
    group.userData.height = 1.5; // boulder top — passable when py >= height-margin
    return group;
  }

  _buildStaticVehicle(type) {
    // All vehicles oriented so length runs along Z (the player's travel axis).
    const group = new THREE.Group();

    // Kenney fast-path: if a matching GLB is preloaded, clone it and
    // skip the procedural box-geometry build. Hit-box userData (length,
    // width, height) is set at the BOTTOM of this function — the AI +
    // collision systems read those, not the visible mesh. So swapping
    // the visual geometry to the Kenney model is purely cosmetic.
    const KENNEY_KEY = {
      taxi:      'cars/taxi',
      suv:       'cars/suv',
      truck:     'cars/truck',
      sedan:     'cars/sedan',
      cityBus:   'cars/delivery',     // no actual bus in kit; box-truck stand-in
      schoolBus: 'cars/delivery',
      van:       'cars/van',
      police:    'cars/police',
      ambulance: 'cars/ambulance',
      firetruck: 'cars/firetruck',
    };
    if (this._models && KENNEY_KEY[type]) {
      const km = this._models.cloneByKey(KENNEY_KEY[type]);
      if (km) {
        // Kenney cars face -Z by default — rotate 180° so they point
        // along +Z (the world's "forward"). The spawner that places
        // them in the world may rotate them again per-instance.
        km.rotation.y = Math.PI;
        // Centre the model on (0, 0, 0). Kenney cars sit on the
        // origin in their own space; tiny lift so the mesh kisses
        // the ground without z-fighting.
        km.position.y = 0.01;
        group.add(km);
        // Hit-box dims still set at the bottom of this fn so the
        // collision/AI math is identical to the procedural path.
        // Cache the kenney flag for downstream features (wheel spin,
        // headlight emissive cycle, etc — Phase 2).
        group.userData.kenneyModel = true;
        // Apply the fall-through hit-box block by re-using its dims.
        const heights = {
          taxi:      1.10, sedan:     1.10,
          suv:       1.30, truck:     2.40,
          cityBus:   1.90, schoolBus: 1.15,
          van:       1.45, police:    1.10, ambulance: 1.85, firetruck: 2.40,
        };
        const lengths = {
          taxi: 3.2, sedan: 3.2, suv: 3.0, truck: 4.6,
          cityBus: 5.5, schoolBus: 4.5, van: 4.0,
          police: 3.2, ambulance: 4.6, firetruck: 4.6,
        };
        const widths = {
          taxi: 1.55, sedan: 1.55, suv: 1.70, truck: 1.70,
          cityBus: 1.85, schoolBus: 1.70, van: 1.70,
          police: 1.55, ambulance: 1.85, firetruck: 1.85,
        };
        group.userData.length = lengths[type] || 3.2;
        group.userData.width  = widths[type]  || 1.6;
        group.userData.height = heights[type] || 1.20;
        return group;
      }
    }

    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.95 });
    const winMat = new THREE.MeshStandardMaterial({
      color: 0x1a2a3a, roughness: 0.2, metalness: 0.6, emissive: 0x0a1520, emissiveIntensity: 0.3,
    });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xfff5cc, emissive: 0xffe28a, emissiveIntensity: 0.7 });

    // Spec dims given as (length × height × width) — sized to roughly match
    // the cars on the cross-streets so parked cars feel proportional.
    const specs = {
      taxi:      { L: 3.2, H: 0.55, W: 1.55, color: 0xF1C40F, cabin: { L: 1.5, H: 0.55, W: 1.40, c: 0xF1C40F } },
      suv:       { L: 3.0, H: 0.70, W: 1.70, color: 0xE74C3C, cabin: { L: 2.0, H: 0.60, W: 1.60, c: 0xC0392B } },
      truck:     { L: 4.6, H: 0.75, W: 1.70, color: 0x3498DB,
                   cabin: { L: 1.4, H: 1.00, W: 1.65, c: 0x2980B9 },
                   cargo: { L: 2.6, H: 1.60, W: 1.65, c: 0xECF0F1 } },
      cityBus:   { L: 5.5, H: 0.50, W: 1.85, color: 0xE74C3C },
      schoolBus: { L: 4.5, H: 0.55, W: 1.70, color: 0xF39C12 },
    };

    const s = specs[type] || specs.taxi;
    const bodyMat = new THREE.MeshStandardMaterial({
      color: s.color, roughness: 0.45, metalness: 0.4,
    });

    // Body — Phase 5 perf: lane vehicles are short and parked; their cast
    // shadows fold into the ground darkening from the directional sun
    // and don't add visual signal at run speed.
    const body = new THREE.Mesh(new THREE.BoxGeometry(s.W, s.H, s.L), bodyMat);
    body.position.y = s.H / 2;
    body.castShadow = false;
    group.add(body);

    if (type === 'taxi') {
      // Cabin: smaller box on top
      const cab = new THREE.Mesh(
        new THREE.BoxGeometry(s.cabin.W, s.cabin.H, s.cabin.L),
        new THREE.MeshStandardMaterial({ color: s.cabin.c, roughness: 0.4, metalness: 0.4 }),
      );
      cab.position.set(0, s.H + s.cabin.H / 2, -0.05);
      cab.castShadow = false;
      group.add(cab);
      // Windshield strip
      const win = new THREE.Mesh(
        new THREE.BoxGeometry(s.cabin.W + 0.01, s.cabin.H * 0.7, s.cabin.L * 0.9),
        winMat,
      );
      win.position.set(0, s.H + s.cabin.H / 2 + 0.05, -0.05);
      group.add(win);
      // Yellow taxi sign on the roof
      const sign = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 0.18, 0.18),
        new THREE.MeshStandardMaterial({ color: 0xFFD23F, emissive: 0xFFC107, emissiveIntensity: 0.6 }),
      );
      sign.position.set(0, s.H + s.cabin.H + 0.1, -0.05);
      group.add(sign);
      // Black side stripe
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(s.W + 0.01, 0.12, s.L * 0.9),
        new THREE.MeshStandardMaterial({ color: 0x111111 }),
      );
      stripe.position.y = s.H * 0.45;
      group.add(stripe);
    } else if (type === 'suv') {
      // Raised roof (slightly larger flat box on top)
      const cab = new THREE.Mesh(
        new THREE.BoxGeometry(s.cabin.W, s.cabin.H, s.cabin.L),
        new THREE.MeshStandardMaterial({ color: s.cabin.c, roughness: 0.4 }),
      );
      cab.position.set(0, s.H + s.cabin.H / 2, -0.1);
      cab.castShadow = false;
      group.add(cab);
      // Window band
      const win = new THREE.Mesh(
        new THREE.BoxGeometry(s.cabin.W + 0.01, s.cabin.H * 0.65, s.cabin.L * 0.9),
        winMat,
      );
      win.position.set(0, s.H + s.cabin.H / 2 + 0.05, -0.1);
      group.add(win);
      // Roof rack accent
      const rack = new THREE.Mesh(
        new THREE.BoxGeometry(s.cabin.W * 0.8, 0.06, s.cabin.L * 0.9),
        new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7 }),
      );
      rack.position.y = s.H + s.cabin.H + 0.03;
      group.add(rack);
    } else if (type === 'truck') {
      // Cab in front
      const cab = new THREE.Mesh(
        new THREE.BoxGeometry(s.cabin.W, s.cabin.H, s.cabin.L),
        new THREE.MeshStandardMaterial({ color: s.cabin.c, roughness: 0.4, metalness: 0.4 }),
      );
      cab.position.set(0, s.H + s.cabin.H / 2, -s.L / 2 + s.cabin.L / 2 + 0.02);
      cab.castShadow = false;
      group.add(cab);
      // Cargo box in back
      const cargo = new THREE.Mesh(
        new THREE.BoxGeometry(s.cargo.W, s.cargo.H, s.cargo.L),
        new THREE.MeshStandardMaterial({ color: s.cargo.c, roughness: 0.7 }),
      );
      cargo.position.set(0, s.H + s.cargo.H / 2, s.L / 2 - s.cargo.L / 2 - 0.02);
      cargo.castShadow = false;
      group.add(cargo);
      // Cab windshield
      const win = new THREE.Mesh(
        new THREE.BoxGeometry(s.cabin.W + 0.01, s.cabin.H * 0.6, s.cabin.L * 0.85),
        winMat,
      );
      win.position.set(0, s.H + s.cabin.H * 0.7, -s.L / 2 + s.cabin.L / 2 + 0.02);
      group.add(win);
    } else if (type === 'cityBus') {
      // Tall body extends up — replace the simple body with a taller block.
      group.remove(body);
      const tallBody = new THREE.Mesh(
        new THREE.BoxGeometry(s.W, s.H + 0.9, s.L),
        bodyMat,
      );
      tallBody.position.y = (s.H + 0.9) / 2;
      tallBody.castShadow = false;
      group.add(tallBody);
      // White stripe with window indentations
      const stripeMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.6 });
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(s.W + 0.01, 0.55, s.L * 0.95),
        stripeMat,
      );
      stripe.position.y = s.H + 0.55;
      group.add(stripe);
      // Window indentations along both sides
      const winSlotMat = new THREE.MeshStandardMaterial({
        color: 0xb8d4e8, roughness: 0.3, metalness: 0.3,
        emissive: 0x6a9bbf, emissiveIntensity: 0.3,
      });
      const slots = 6;
      for (let i = 0; i < slots; i++) {
        const t = (i + 0.5) / slots;
        const z = -s.L / 2 + t * s.L;
        for (const sx of [-s.W / 2 - 0.005, s.W / 2 + 0.005]) {
          const slot = new THREE.Mesh(
            new THREE.BoxGeometry(0.02, 0.4, s.L / slots * 0.7),
            winSlotMat,
          );
          slot.position.set(sx, s.H + 0.55, z);
          group.add(slot);
        }
      }
    } else if (type === 'schoolBus') {
      // Slightly taller body
      group.remove(body);
      const tallBody = new THREE.Mesh(
        new THREE.BoxGeometry(s.W, s.H + 0.6, s.L),
        bodyMat,
      );
      tallBody.position.y = (s.H + 0.6) / 2;
      tallBody.castShadow = false;
      group.add(tallBody);
      // Black stripe along the side
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(s.W + 0.01, 0.18, s.L * 0.95),
        new THREE.MeshStandardMaterial({ color: 0x111111 }),
      );
      stripe.position.y = s.H + 0.15;
      group.add(stripe);
      // Window strip
      const winStrip = new THREE.Mesh(
        new THREE.BoxGeometry(s.W + 0.005, 0.35, s.L * 0.92),
        winMat,
      );
      winStrip.position.y = s.H + 0.55;
      group.add(winStrip);
    }

    // Wheels — four black cylinders set under the body
    const wheelR = 0.36;
    const wheelW = 0.26;
    const wheelGeo = new THREE.CylinderGeometry(wheelR, wheelR, wheelW, 12);
    const wheelOffsets = [
      [-s.W / 2,  s.L / 2 - 0.4],
      [ s.W / 2,  s.L / 2 - 0.4],
      [-s.W / 2, -s.L / 2 + 0.4],
      [ s.W / 2, -s.L / 2 + 0.4],
    ];
    if (type === 'cityBus' || type === 'schoolBus') {
      // Buses get an extra pair of wheels
      wheelOffsets.push([-s.W / 2, s.L / 2 - 1.2], [s.W / 2, s.L / 2 - 1.2]);
    }
    wheelOffsets.forEach(([wx, wz]) => {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(wx, wheelR, wz);
      group.add(wheel);
    });

    // Headlights at the front (-Z is "forward")
    const headGeo = new THREE.BoxGeometry(0.18, 0.16, 0.04);
    const hL = new THREE.Mesh(headGeo, headMat);
    hL.position.set(-s.W / 2 + 0.22, s.H * 0.6, -s.L / 2 - 0.02);
    group.add(hL);
    const hR = hL.clone();
    hR.position.x = s.W / 2 - 0.22;
    group.add(hR);

    // Hit-box dims for collision (length × width × top-Y).
    // Height is the world-Y of the vehicle's roof — the player needs to be
    // above this minus a small margin to safely slide over the top.
    const heights = {
      taxi:      1.10,
      suv:       1.30,
      truck:     2.40,
      cityBus:   1.90,
      schoolBus: 1.15,
    };
    group.userData.length = s.L;
    group.userData.width  = s.W;
    group.userData.height = heights[type] || 1.20;
    return group;
  }

  _buildPlayer() {
    const root = new THREE.Group();

    // Inner pivot: holds penguin + tube. We'll spin THIS for ramp flips so
    // lane-tilt (applied to root) stays independent of the flip rotation.
    const inner = new THREE.Group();
    root.add(inner);

    // Inflatable snow-tube (flat torus)
    const tubeMat = new THREE.MeshStandardMaterial({
      color: 0x2196f3, roughness: 0.45, metalness: 0.05,
    });
    const tube = new THREE.Mesh(
      new THREE.TorusGeometry(0.6, 0.2, 14, 28),
      tubeMat
    );
    tube.rotation.x = Math.PI / 2; // lay flat
    tube.position.y = 0.2;
    tube.castShadow = true;
    inner.add(tube);

    // Penguin body — small dark sphere sitting inside the tube hole
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.6 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 14), darkMat);
    body.position.y = 0.42;
    body.castShadow = true;
    inner.add(body);

    // White belly patch (slightly flattened white sphere on the front)
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.7 });
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), whiteMat);
    belly.scale.set(0.85, 1.0, 0.55);
    belly.position.set(0, 0.4, 0.13);
    inner.add(belly);

    // Head (smaller dark sphere on top)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 14, 14), darkMat);
    head.position.y = 0.78;
    head.castShadow = true;
    inner.add(head);

    // Tiny eyes
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
    const eyeGeo = new THREE.SphereGeometry(0.045, 8, 8);
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    eyeL.position.set(-0.07, 0.82, 0.15);
    inner.add(eyeL);
    const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
    eyeR.position.set(0.07, 0.82, 0.15);
    inner.add(eyeR);

    // Pupils for a bit of life
    const pupilMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const pupilGeo = new THREE.SphereGeometry(0.022, 6, 6);
    const pL = new THREE.Mesh(pupilGeo, pupilMat);
    pL.position.set(-0.07, 0.82, 0.19);
    inner.add(pL);
    const pR = new THREE.Mesh(pupilGeo, pupilMat);
    pR.position.set(0.07, 0.82, 0.19);
    inner.add(pR);

    // Tiny orange beak
    const beakMat = new THREE.MeshStandardMaterial({ color: 0xffa726, roughness: 0.5 });
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.1, 8), beakMat);
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, 0.78, 0.18);
    inner.add(beak);

    // Parachute (hidden by default; lives on the OUTER root so it doesn't
    // inherit the inner pivot's flip rotation during ramp launches).
    const parachute = this._buildParachute();
    parachute.visible = false;
    parachute.scale.setScalar(0);
    root.add(parachute);
    root.userData.parachute = parachute;

    root.userData.inner = inner;
    root.userData.tube = tube;
    return root;
  }

  _buildParachute() {
    const group = new THREE.Group();

    // Hemisphere canopy (top half of a sphere — looks like a parachute dome)
    const canopyGeo = new THREE.SphereGeometry(
      0.85, 18, 10,           // radius / segments
      0, Math.PI * 2,         // full phi
      0, Math.PI / 2,         // top hemisphere only (theta 0..π/2)
    );
    const canopyMat = new THREE.MeshStandardMaterial({
      color: 0xE74C3C,
      side: THREE.DoubleSide,
      roughness: 0.7,
      metalness: 0.0,
    });
    const canopy = new THREE.Mesh(canopyGeo, canopyMat);
    canopy.castShadow = true;
    group.add(canopy);

    // Subtle alternating darker stripe segment for visual interest
    const stripeGeo = new THREE.SphereGeometry(
      0.86, 18, 10,
      0, Math.PI / 4,
      0, Math.PI / 2,
    );
    const stripeMat = new THREE.MeshStandardMaterial({
      color: 0xC0392B,
      side: THREE.DoubleSide,
      roughness: 0.7,
    });
    const stripe = new THREE.Mesh(stripeGeo, stripeMat);
    group.add(stripe);

    // 4 strings from the canopy edge down to the penguin body
    const lineMat = new THREE.LineBasicMaterial({ color: 0x111111 });
    const angles = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
    const linePositions = new Float32Array(angles.length * 2 * 3);
    for (let i = 0; i < angles.length; i++) {
      const r = 0.78;
      linePositions[i * 6 + 0] = Math.cos(angles[i]) * r;
      linePositions[i * 6 + 1] = 0;
      linePositions[i * 6 + 2] = Math.sin(angles[i]) * r;
      linePositions[i * 6 + 3] = 0;
      linePositions[i * 6 + 4] = -1.6;  // converge near the penguin body
      linePositions[i * 6 + 5] = 0;
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    group.add(lines);

    // Sit ~1.5 above the penguin's head
    group.position.y = 2.0;
    return group;
  }

  _buildVehicle(type) {
    const group = new THREE.Group();
    const carColors = [0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, 0x8e44ad, 0xecf0f1, 0x16a085];
    const color = carColors[Math.floor(Math.random() * carColors.length)];

    let bodyW, bodyH, bodyD, cabinW, cabinH, cabinD, cabinY, cabinZ, cabinColor;

    if (type === 'car') {
      bodyW = 1.6; bodyH = 0.55; bodyD = 3.2;
      cabinW = 1.45; cabinH = 0.55; cabinD = 1.5; cabinY = bodyH + cabinH / 2; cabinZ = -0.1;
      cabinColor = color;
    } else if (type === 'truck') {
      bodyW = 1.7; bodyH = 0.7; bodyD = 4.5;
      // For trucks, the "cabin" is the tall cargo box at the back
      cabinW = 1.7; cabinH = 1.6; cabinD = 2.8; cabinY = bodyH + cabinH / 2; cabinZ = 0.6;
      cabinColor = 0xe6e6e6;
    } else { // bus
      bodyW = 1.85; bodyH = 0.45; bodyD = 5.5;
      cabinW = 1.85; cabinH = 1.7; cabinD = 5.3; cabinY = bodyH + cabinH / 2; cabinZ = 0;
      cabinColor = color;
    }

    const bodyGeo = new THREE.BoxGeometry(bodyW, bodyH, bodyD);
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.5 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = bodyH / 2;
    body.castShadow = true;
    group.add(body);

    // Cabin / cargo
    const cabinGeo = new THREE.BoxGeometry(cabinW, cabinH, cabinD);
    const cabinMat = new THREE.MeshStandardMaterial({ color: cabinColor, roughness: 0.45, metalness: 0.3 });
    const cabin = new THREE.Mesh(cabinGeo, cabinMat);
    cabin.position.set(0, cabinY, cabinZ);
    cabin.castShadow = true;
    group.add(cabin);

    // Truck cab (the front driver compartment, lower than the cargo)
    if (type === 'truck') {
      const cabGeo = new THREE.BoxGeometry(bodyW, 1.0, 1.4);
      const cabMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.5 });
      const cab = new THREE.Mesh(cabGeo, cabMat);
      cab.position.set(0, bodyH + 0.5, -1.5);
      cab.castShadow = false;
      group.add(cab);
    }

    // Windows — dark glass strip
    const winMat = new THREE.MeshStandardMaterial({
      color: 0x1a2a3a, roughness: 0.2, metalness: 0.6, emissive: 0x0a1520, emissiveIntensity: 0.3,
    });
    if (type === 'car') {
      const winGeo = new THREE.BoxGeometry(cabinW + 0.01, cabinH * 0.7, cabinD * 0.9);
      const win = new THREE.Mesh(winGeo, winMat);
      win.position.set(0, cabinY + 0.05, cabinZ);
      group.add(win);
    } else if (type === 'bus') {
      // Window strip running along the bus length
      const winGeo = new THREE.BoxGeometry(cabinW + 0.01, cabinH * 0.45, cabinD * 0.92);
      const win = new THREE.Mesh(winGeo, winMat);
      win.position.set(0, cabinY + 0.15, cabinZ);
      group.add(win);
    } else if (type === 'truck') {
      // Front cab windshield
      const winGeo = new THREE.BoxGeometry(bodyW + 0.01, 0.5, 1.0);
      const win = new THREE.Mesh(winGeo, winMat);
      win.position.set(0, bodyH + 0.75, -1.55);
      group.add(win);
    }

    // Wheels
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
    const wheelR = type === 'car' ? 0.32 : 0.42;
    const wheelW = type === 'car' ? 0.22 : 0.3;
    const wheelGeo = new THREE.CylinderGeometry(wheelR, wheelR, wheelW, 12);
    const wheelOffsets = type === 'car'
      ? [[-bodyW / 2, -bodyD / 2 + 0.6], [bodyW / 2, -bodyD / 2 + 0.6], [-bodyW / 2, bodyD / 2 - 0.6], [bodyW / 2, bodyD / 2 - 0.6]]
      : type === 'bus'
        ? [[-bodyW / 2, -bodyD / 2 + 0.8], [bodyW / 2, -bodyD / 2 + 0.8], [-bodyW / 2, bodyD / 2 - 0.8], [bodyW / 2, bodyD / 2 - 0.8]]
        : [[-bodyW / 2, -bodyD / 2 + 0.7], [bodyW / 2, -bodyD / 2 + 0.7], [-bodyW / 2, bodyD / 2 - 1.0], [bodyW / 2, bodyD / 2 - 1.0], [-bodyW / 2, bodyD / 2 - 0.2], [bodyW / 2, bodyD / 2 - 0.2]];
    wheelOffsets.forEach(([wx, wz]) => {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(wx, wheelR, wz);
      group.add(wheel);
    });

    // Headlights at the front (negative Z is "forward" relative to placement)
    const headMat = new THREE.MeshStandardMaterial({ color: 0xfff5cc, emissive: 0xffe28a, emissiveIntensity: 0.7 });
    const headGeo = new THREE.BoxGeometry(0.25, 0.2, 0.05);
    const hL = new THREE.Mesh(headGeo, headMat);
    hL.position.set(-bodyW / 2 + 0.3, bodyH * 0.7, -bodyD / 2 - 0.01);
    group.add(hL);
    const hR = hL.clone();
    hR.position.x = bodyW / 2 - 0.3;
    group.add(hR);

    // Face the player (oncoming traffic) — flip 180° so the front faces -Z
    group.rotation.y = Math.PI;

    return group;
  }

  // ─────────────────────────────────────
  // Cross-streets — perpendicular roads with crossing traffic
  // ─────────────────────────────────────

  _spawnCrossStreet(z) {
    const group = new THREE.Group();
    const streetWidth = 60;  // span in X (perpendicular to player travel)
    const streetDepth = 4;   // 4-unit asphalt strip per spec

    // Asphalt — dark grey #3a3a3a
    const roadGeo = new THREE.PlaneGeometry(streetWidth, streetDepth);
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.95 });
    const road = new THREE.Mesh(roadGeo, roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.y = 0.012;
    road.receiveShadow = true;
    group.add(road);
    group.userData.roadMat = roadMat;

    // White dashed lane line down the middle
    const dashMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const dashLen = 1.2;
    const dashGap = 1.2;
    for (let x = -streetWidth / 2 + 1; x < streetWidth / 2; x += dashLen + dashGap) {
      const d = new THREE.Mesh(new THREE.PlaneGeometry(dashLen, 0.16), dashMat);
      d.rotation.x = -Math.PI / 2;
      d.position.set(x + dashLen / 2, 0.022, 0);
      group.add(d);
    }

    // Solid stop lines at the entry / exit edges
    for (const sz of [-streetDepth / 2 + 0.25, streetDepth / 2 - 0.25]) {
      const stop = new THREE.Mesh(
        new THREE.PlaneGeometry(streetWidth - 2, 0.3),
        dashMat,
      );
      stop.rotation.x = -Math.PI / 2;
      stop.position.set(0, 0.022, sz);
      group.add(stop);
    }

    // Traffic lights — one pole on each side. Per spec only red or green is lit.
    const lampColor = Math.random() < 0.5 ? 0 : 2; // 0 = red, 2 = green
    for (const side of [-1, 1]) {
      const tl = this._buildTrafficLight(lampColor);
      tl.position.set(side * (streetWidth / 2 - 1.6), 0, side < 0 ? -1.0 : 1.0);
      // Face inward over the road
      tl.rotation.y = side < 0 ? -Math.PI / 2 : Math.PI / 2;
      group.add(tl);
    }

    // Crossing vehicles — 2-4 cars using the Section-6 static vehicle shapes.
    group.userData.cars = [];
    const carCount = 2 + Math.floor(Math.random() * 3); // 2, 3 or 4
    const placedX = [];
    for (let i = 0; i < carCount; i++) {
      const types = ['taxi', 'suv', 'truck', 'cityBus', 'schoolBus'];
      const t = types[Math.floor(Math.random() * types.length)];
      const v = this._buildStaticVehicle(t);

      // Built with length along Z and front facing -Z. Rotate ±90° so length
      // runs along X with the front pointing in the travel direction.
      const dir = Math.random() < 0.5 ? -1 : 1; // 1 = traveling +X, -1 = traveling -X
      v.rotation.set(0, dir > 0 ? Math.PI / 2 : -Math.PI / 2, 0);

      // Two opposing lanes inside the 4-unit street depth
      const laneZ = dir > 0 ? -0.95 : 0.95;
      let cx;
      let tries = 0;
      do {
        cx = (Math.random() - 0.5) * (streetWidth - 8);
        tries++;
      } while (placedX.some(p => Math.abs(p - cx) < 6) && tries < 12);
      placedX.push(cx);
      v.position.set(cx, 0, laneZ);

      v.userData.dir = dir;
      v.userData.speed = 8 + Math.random() * 7; // moderate crossing speed
      group.add(v);
      group.userData.cars.push(v);
    }

    group.position.set(0, 0, z);
    group.userData.type = 'crossStreet';
    group.userData.streetWidth = streetWidth;
    group.userData.streetDepth = streetDepth;

    this.scene.add(group);
    this.crossStreets.push(group);
    return group;
  }

  _buildTrafficLight(state) {
    const group = new THREE.Group();

    const baseMat = new THREE.MeshStandardMaterial({ color: 0x222226, roughness: 0.7 });

    // Tall thin cylinder pole
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.07, 4.0, 8),
      baseMat,
    );
    pole.position.y = 2.0;
    pole.castShadow = true;
    group.add(pole);

    // Small box housing on top
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.05, 0.32), baseMat);
    housing.position.y = 4.4;
    housing.castShadow = true;
    group.add(housing);

    // Three circular lights — only red OR green is ever lit (no yellow)
    const colors = [0xff3030, 0xffd23f, 0x35d24a];
    const lit = state == null ? (Math.random() < 0.5 ? 0 : 2) : state;
    for (let i = 0; i < 3; i++) {
      const isLit = i === lit;
      const bulbMat = new THREE.MeshStandardMaterial({
        color: colors[i],
        emissive: isLit ? colors[i] : 0x000000,
        emissiveIntensity: isLit ? 1.4 : 0,
        roughness: 0.35,
      });
      // Flat circular lens for a "circle" look
      const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.12, 16), bulbMat);
      bulb.position.set(0, 4.75 - i * 0.32, 0.17);
      group.add(bulb);
    }

    return group;
  }

  _updateCrossStreets(delta, moveZ) {
    if (this.crossStreets.length === 0) return;

    for (const street of this.crossStreets) {
      street.position.z -= moveZ;

      const sw = street.userData.streetWidth;
      for (const car of street.userData.cars) {
        // The mesh rotation made each vehicle face the OPPOSITE of its stored
        // dir, so they were sliding backwards. Move along -dir so each car
        // travels in the direction its front is pointing.
        car.position.x -= car.userData.dir * car.userData.speed * delta;
        if (car.userData.dir > 0 && car.position.x < -sw / 2 - 4) {
          car.position.x = sw / 2 + 4;
        } else if (car.userData.dir < 0 && car.position.x > sw / 2 + 4) {
          car.position.x = -sw / 2 - 4;
        }
      }
    }

    // Recycle streets that have passed behind us — push them past the farthest
    // current street so the spacing stays roughly 40-60 units.
    for (const street of this.crossStreets) {
      if (street.position.z < -25) {
        let maxZ = 0;
        for (const s of this.crossStreets) maxZ = Math.max(maxZ, s.position.z);
        street.position.z = Math.max(maxZ + 40 + Math.random() * 20, street.position.z + 220);

        // Refresh traffic-light states + biome tint for the new instance
        const newRoadColor = this._biomeRoadColor();
        if (street.userData.roadMat) street.userData.roadMat.color.setHex(newRoadColor);
      }
    }
  }

  _biomeRoadColor() {
    // Dark grey #3a3a3a per spec — same across all biomes
    return 0x3a3a3a;
  }

  _checkCrossStreetCollision() {
    if (this.airborneFromRamp) return false;
    const px = this.player.position.x;
    const pz = this.player.position.z;
    const py = this.player.position.y;
    if (py > 1.5) return false;

    for (const street of this.crossStreets) {
      const dz = Math.abs(street.position.z - pz);
      if (dz > street.userData.streetDepth / 2 + 1.5) continue;

      for (const car of street.userData.cars) {
        // Vehicle world coords: street is centered at x=0. Use the per-vehicle
        // length / width baked in by _buildStaticVehicle for an accurate box.
        const carWorldX = car.position.x;
        const carWorldZ = street.position.z + car.position.z;
        const dxCar = Math.abs(carWorldX - px);
        const dzCar = Math.abs(carWorldZ - pz);
        const halfL = (car.userData.length || 3.0) / 2 + 0.3;
        const halfW = (car.userData.width  || 1.7) / 2 + 0.3;
        // Close call sound
        const closeThreshold = 10;
        if (dxCar < halfL + closeThreshold && dzCar < halfW + closeThreshold && this.closeCallCooldown <= 0) {
          this.sounds.play('car_approach');
          this.closeCallCooldown = 2;
        }
        if (dxCar < halfL && dzCar < halfW) {
          // Touching the top? Slide across instead of dying.
          const top = car.userData.height || 1.5;
          if (py >= top - 0.6 || py >= top * 0.65) continue;
          return true;
        }
      }
    }
    return false;
  }

  _clearCrossStreets() {
    for (const s of this.crossStreets) this.scene.remove(s);
    this.crossStreets = [];
  }

  // Walk the procedural side-decor placement loop. Single source of
  // truth used by init() and restart() so we don't have inline copies
  // drifting apart. We walk the FULL course length (not just the first
  // 400m) so that snow / city / tropical biome scenery actually lands
  // at the world-Z that matches each biome's threshold (BIOME_SNOW_END,
  // BIOME_CITY_END). _addSideDecor reads the biome from world-Z when
  // none is passed, so the spawner picks tents in snow, Kenney
  // commercial buildings in city, palm-trees + tropical mid-rises after.
  // Items spawned this way are NOT recycled forward (see _recycleObjects),
  // so they sit at fixed world-Z for the whole run and just slide
  // backward relative to the player as they advance.
  _spawnSideDecor() {
    const courseLen = this.courseLength || 2000;
    for (let z = 0; z < courseLen; z += 12) {
      this._addSideDecor(-1, z);
      this._addSideDecor(1, z + 6);
    }
  }

  // Tear down every side-decor scenery item so a fresh _buildCourse
  // call can re-walk and re-spawn through the Kenney GLB fast-path.
  // Releases InstancedScenery slots for instanced markers (pine,
  // palm, lamp) so the pool stays balanced; the recycle hook lives
  // on userData.releaseInstance.
  _clearScenery() {
    if (!this.scenery || !this.scenery.length) return;
    for (const s of this.scenery) {
      if (s.userData && typeof s.userData.releaseInstance === 'function') {
        try { s.userData.releaseInstance(); } catch (e) { /* ignore */ }
      }
      this.scene.remove(s);
      // Dispose non-instanced geometry/material so we don't leak.
      s.traverse?.((o) => {
        if (o.isMesh) {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
            else o.material.dispose();
          }
        }
      });
    }
    this.scenery = [];
  }

  _spawnRamp(z) {
    // Project-wide rule: never deploy a ramp on a cross-street.
    const safeZ = this._clampToSafeZ(z, 8);
    if (safeZ == null) return;
    z = safeZ;
    // Spec: ramps are placed in the center lane.
    const lane = 0;
    const x = lane * GAME_CONFIG.LANE_WIDTH;

    // Make sure the ramp doesn't sit on top of an existing obstacle nearby
    for (const obs of this.obstacles) {
      if (Math.abs(obs.position.z - z) < 8 && obs.userData.lane === lane + 1) {
        return;
      }
    }

    const ramp = this._buildRamp();
    ramp.position.set(x, 0, z);
    ramp.userData.type = 'ramp';
    ramp.userData.lane = lane + 1;
    ramp.userData.id = `ramp_${Math.random().toString(36).slice(2, 9)}`;
    ramp.userData.length = ramp.userData.length || 10; // collision Z extent

    this.scene.add(ramp);
    this.ramps.push(ramp);
  }

  _buildRamp() {
    const group = new THREE.Group();

    // Spec dims: 2.5 wide × 10 long × 3 high (back at ground, front high).
    const length = 10;
    const width  = 2.5;
    const height = 3;
    const slopeAngle = Math.atan2(height, length); // ~16.7°
    const slopeLen   = Math.sqrt(length * length + height * height);

    // ── 1. Main ramp body (triangular prism wedge) ──────────────
    const wedgeGeo = new THREE.BufferGeometry();
    const verts = new Float32Array([
      // Bottom (y=0)
      -width / 2, 0, -length / 2,
       width / 2, 0, -length / 2,
       width / 2, 0,  length / 2,
      -width / 2, 0, -length / 2,
       width / 2, 0,  length / 2,
      -width / 2, 0,  length / 2,
      // Slope (top surface, rising toward +Z)
      -width / 2, 0, -length / 2,
       width / 2, 0, -length / 2,
       width / 2, height, length / 2,
      -width / 2, 0, -length / 2,
       width / 2, height, length / 2,
      -width / 2, height, length / 2,
      // Back wall (high end)
      -width / 2, 0,  length / 2,
       width / 2, 0,  length / 2,
       width / 2, height, length / 2,
      -width / 2, 0,  length / 2,
       width / 2, height, length / 2,
      -width / 2, height, length / 2,
      // Left side triangle
      -width / 2, 0, -length / 2,
      -width / 2, 0,  length / 2,
      -width / 2, height, length / 2,
      // Right side triangle
       width / 2, 0, -length / 2,
       width / 2, height, length / 2,
       width / 2, 0,  length / 2,
    ]);
    wedgeGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    wedgeGeo.computeVertexNormals();

    const wedgeMat = new THREE.MeshStandardMaterial({
      color: 0xFFD700, roughness: 0.55, metalness: 0.15,
    });
    const wedge = new THREE.Mesh(wedgeGeo, wedgeMat);
    wedge.castShadow = true;
    wedge.receiveShadow = true;
    group.add(wedge);

    // Kenney rail-slope visual overlay: clone the skate-park slope rail
    // and stretch it to the exact ramp footprint. Sits on top of the
    // procedural wedge so the chevrons/lights/bollards stay readable
    // while the wedge picks up textured detail and a more grounded
    // material. Falls back to the bare wedge if the model isn't loaded.
    if (this._models) {
      const km = this._models.cloneByKey('rails/slope');
      if (km) {
        // The Kenney slope is centred at origin with its base at y=0.
        // Stretch to our exact dimensions so the surface aligns with the
        // wedge's slope plane.
        this._models.fitToBox(km, { width, height, length, mode: 'stretch' });
        km.position.y = 0.001; // sit just above the procedural wedge to win z-fight
        group.add(km);
      }
    }

    // ── 1b. Side guardrails (channel walls) ─────────────────────
    // Thin vertical slabs running along the slope on each side, 0.3 tall.
    const railHeight = 0.3;
    const railThickness = 0.08;
    const guardMat = new THREE.MeshStandardMaterial({
      color: 0xF5A623, roughness: 0.55,
    });
    for (const sx of [-(width / 2) - railThickness / 2,
                       (width / 2) + railThickness / 2]) {
      const guard = new THREE.Mesh(
        new THREE.BoxGeometry(railThickness, railHeight, slopeLen),
        guardMat,
      );
      // Place along the slope, half-height above the slope surface
      guard.position.set(
        sx,
        height / 2 + (railHeight / 2) * Math.cos(slopeAngle),
        -(railHeight / 2) * Math.sin(slopeAngle),
      );
      guard.rotation.x = -slopeAngle;
      guard.castShadow = true;
      group.add(guard);
    }

    // ── 4. Glowing edge strip on top of each guardrail ──────────
    const glowMat = new THREE.MeshStandardMaterial({
      color: 0xFFD700, emissive: 0xFFD700, emissiveIntensity: 0.6,
      roughness: 0.3,
    });
    for (const sx of [-(width / 2) - railThickness / 2,
                       (width / 2) + railThickness / 2]) {
      const glow = new THREE.Mesh(
        new THREE.BoxGeometry(railThickness * 1.1, 0.06, slopeLen),
        glowMat,
      );
      glow.position.set(
        sx,
        height / 2 + (railHeight + 0.04) * Math.cos(slopeAngle),
        -(railHeight + 0.04) * Math.sin(slopeAngle),
      );
      glow.rotation.x = -slopeAngle;
      group.add(glow);
    }

    // ── 2. Brown chevron arrows (V-shape pointing up the ramp) ──
    const chevMat = new THREE.MeshStandardMaterial({
      color: 0x5C3A1A, roughness: 0.7,
    });
    const chevCount = 9;                     // spec: 8-10
    const chevHalfArm = width * 0.45;        // length of one half-stripe
    const chevYaw = Math.PI / 5;             // splay each half ±36° → V shape
    for (let i = 0; i < chevCount; i++) {
      const t = (i + 0.5) / chevCount;
      const baseZ = -length / 2 + t * length;
      const baseY = t * height + 0.03;       // sit just above the slope surface

      for (const dir of [-1, 1]) {
        const half = new THREE.Mesh(
          new THREE.BoxGeometry(chevHalfArm, 0.04, 0.22),
          chevMat,
        );
        // Pivot to lie flat on the sloped surface, then yaw to form a >
        half.position.set(dir * (width * 0.22), baseY, baseZ);
        half.rotation.x = -slopeAngle;        // align with slope
        half.rotation.y = -dir * chevYaw;     // V-shape splay
        half.castShadow = false;
        group.add(half);
      }
    }

    // ── 3. Diagonal support beams under the ramp ────────────────
    const beamMat = new THREE.MeshStandardMaterial({
      color: 0x444444, roughness: 0.7,
    });
    const beamCount = 3;
    for (let i = 0; i < beamCount; i++) {
      const t = (i + 1) / (beamCount + 1);   // 0.25, 0.5, 0.75 along length
      const surfaceY = t * height;
      const beamZ = -length / 2 + t * length;
      // Vertical box from ground (y=0) up to the underside of the slope
      const beam = new THREE.Mesh(
        new THREE.BoxGeometry(width * 0.7, surfaceY, 0.14),
        beamMat,
      );
      beam.position.set(0, surfaceY / 2, beamZ);
      beam.castShadow = true;
      group.add(beam);

      // Diagonal cross-brace for a scaffolded look
      const braceLen = Math.sqrt((length / beamCount) ** 2 + surfaceY * surfaceY);
      if (i < beamCount - 1) {
        const brace = new THREE.Mesh(
          new THREE.BoxGeometry(width * 0.5, 0.08, braceLen),
          beamMat,
        );
        const nextSurfaceY = ((i + 2) / (beamCount + 1)) * height;
        brace.position.set(
          0,
          (surfaceY + nextSurfaceY) / 2 * 0.6,
          beamZ + (length / (beamCount + 1)) / 2,
        );
        brace.rotation.x = -Math.atan2(nextSurfaceY - surfaceY, length / (beamCount + 1));
        group.add(brace);
      }
    }

    // ── 5. Entry markers (orange bollards at the base) ──────────
    const bollardMat = new THREE.MeshStandardMaterial({
      color: 0xF5A623, roughness: 0.55,
    });
    for (const sx of [-(width / 2) - 0.42, (width / 2) + 0.42]) {
      const bollard = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.14, 0.8, 10),
        bollardMat,
      );
      bollard.position.set(sx, 0.4, -length / 2 + 0.25);
      bollard.castShadow = true;
      group.add(bollard);

      // Glowing cap on each bollard so the entry reads at distance
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.13, 0.13, 0.06, 10),
        glowMat,
      );
      cap.position.set(sx, 0.83, -length / 2 + 0.25);
      group.add(cap);
    }

    // ── Floor approach lights (chase pattern toward the ramp) ───
    const approachLights = [];
    const lightCount = 6;
    const lightSpacing = 0.85;
    for (let i = 0; i < lightCount; i++) {
      const lz = -length / 2 - 0.6 - i * lightSpacing;
      for (const sx of [-(width / 2) - 0.7, (width / 2) + 0.7]) {
        const lampMat = new THREE.MeshStandardMaterial({
          color: 0xffe14a,
          emissive: 0x161413,
          emissiveIntensity: 0.0,
          roughness: 0.35,
        });
        const lamp = new THREE.Mesh(
          new THREE.BoxGeometry(0.32, 0.10, 0.55),
          lampMat,
        );
        lamp.position.set(sx, 0.05, lz);
        lamp.userData.approachLight = true;
        lamp.userData.indexI = i;
        group.add(lamp);
        approachLights.push(lamp);
      }
    }
    group.userData.approachLights = approachLights;
    group.userData.lightCount = lightCount;

    group.userData.length = length;
    group.userData.height = height;
    group.userData.width = width;
    return group;
  }

  _updateRampLights() {
    if (!this.ramps || this.ramps.length === 0) return;
    // Chase position cycles 0..N-1 over time, moving from far end (high i) to
    // near end (low i, the ramp). At each step ONE pair of lights is fully
    // lit, the rest are dim.
    const speed = 7; // lights per second
    for (const ramp of this.ramps) {
      const lights = ramp.userData.approachLights;
      if (!lights) continue;
      const N = ramp.userData.lightCount || 6;
      const pulse = Math.floor(performance.now() / 1000 * speed) % N;
      for (const lamp of lights) {
        const i = lamp.userData.indexI;
        // Lights flow from far (i = N-1) to near (i = 0): "active step" for
        // light i is (N - 1 - i).
        const myStep = (N - 1) - i;
        const isOn = myStep === pulse;
        lamp.material.emissive.setHex(isOn ? 0xffae42 : 0x161413);
        lamp.material.emissiveIntensity = isOn ? 2.2 : 0.05;
      }
    }
  }

  // ─────────────────────────────────────
  // Sky objects (only visible during ramp air time)
  // ─────────────────────────────────────

  _spawnSkyBurst() {
    // Initial dramatic burst: a few objects spread across the sky.
    this._spawnSkyObject('airplane', { far: false });
    this._spawnSkyObject('airplane', { far: true });
    this._spawnSkyObject('balloon', { far: true });
    this._spawnSkyObject('balloon', { far: false });
    this._spawnSkyObject('rocket', { far: false });
  }

  _spawnSkyObject(type, opts = {}) {
    // Phase 4 perf: hard cap so the sky never hosts more than 6 props.
    if (this.skyObjects.length >= 6) return;
    const far = opts.far !== undefined ? opts.far : Math.random() < 0.5;
    const low = !!opts.low;
    const flyby = !!opts.flyby;
    let mesh;
    if (type === 'airplane') mesh = this._buildAirplane();
    else if (type === 'balloon') mesh = this._buildBalloon();
    else mesh = this._buildRocket();

    // Distance from camera affects parallax. "far" objects get pushed deeper +Z
    // and scaled up slightly so they stay readable.
    const depth = far ? 90 + Math.random() * 50 : 40 + Math.random() * 25;
    let altitude;
    if (type === 'rocket') {
      altitude = 8 + Math.random() * 6;
    } else if (type === 'balloon') {
      altitude = 25 + Math.random() * 15;
    } else if (low) {
      altitude = 15 + Math.random() * 5;     // dramatic low pass
    } else {
      altitude = 30 + Math.random() * 20;    // high cruise
    }
    const lateralRange = far ? 70 : 40;
    const startX = (Math.random() < 0.5 ? -1 : 1) * (lateralRange * 0.5 + Math.random() * 10);

    mesh.position.set(startX, altitude, depth);
    mesh.userData.type = 'sky';
    mesh.userData.skyKind = type;
    mesh.userData.far = far;
    mesh.userData.parallax = far ? 0.18 : 0.45;
    mesh.userData.bornAt = performance.now();
    mesh.userData.life = 11 + Math.random() * 5; // longer life so the population persists
    mesh.userData.age = 0;

    if (type === 'airplane') {
      if (flyby) {
        // Dramatic head-on approach: starts far ahead, flies toward the player,
        // grows larger as it nears.
        mesh.position.set((Math.random() - 0.5) * 6, 35 + Math.random() * 15, 200);
        mesh.userData.vx = (Math.random() - 0.5) * 2;
        mesh.userData.vy = -1.0 - Math.random() * 0.8;
        mesh.userData.vz = -28 - Math.random() * 12;   // toward the player
        mesh.userData.parallax = 0;                     // motion is its own velocity
        mesh.rotation.y = Math.PI;                      // face -Z (toward player)
        mesh.scale.setScalar(1.8);
        mesh.userData.life = 8 + Math.random() * 2;
        mesh.userData.flyby = true;
      } else {
        mesh.userData.vx = (startX < 0 ? 1 : -1) * (10 + Math.random() * 8);
        mesh.userData.vy = (Math.random() - 0.5) * 0.3;
        mesh.rotation.y = startX < 0 ? -Math.PI / 2 : Math.PI / 2;
        mesh.scale.setScalar(low ? 1.0 : (far ? 1.6 : 1.2));
      }
    } else if (type === 'balloon') {
      mesh.userData.vx = (Math.random() - 0.5) * 1.0;
      mesh.userData.vy = 0.15 + Math.random() * 0.25;   // float slowly upward
      mesh.userData.bobPhase = Math.random() * Math.PI * 2;
      mesh.userData.life = 14 + Math.random() * 5;
      const scale = far ? 1.4 : 1.0;
      mesh.scale.setScalar(scale);
    } else if (type === 'rocket') {
      mesh.userData.vx = (Math.random() - 0.5) * 0.6;
      mesh.userData.vy = 18 + Math.random() * 10; // shoots upward
      mesh.userData.life = 3.5 + Math.random() * 1.5;
      const scale = far ? 1.3 : 1.0;
      mesh.scale.setScalar(scale);
      // Trail line
      const trailMat = new THREE.LineBasicMaterial({
        color: 0xffd07a, transparent: true, opacity: 0.85,
      });
      const trailGeo = new THREE.BufferGeometry();
      const TRAIL_POINTS = 24;
      const positions = new Float32Array(TRAIL_POINTS * 3);
      for (let i = 0; i < TRAIL_POINTS; i++) {
        positions[i * 3] = mesh.position.x;
        positions[i * 3 + 1] = mesh.position.y;
        positions[i * 3 + 2] = mesh.position.z;
      }
      trailGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const trail = new THREE.Line(trailGeo, trailMat);
      this.scene.add(trail);
      mesh.userData.trail = trail;
      mesh.userData.trailPoints = TRAIL_POINTS;
    }

    this.scene.add(mesh);
    this.skyObjects.push(mesh);
  }

  _buildAirplane() {
    const group = new THREE.Group();
    // Kenney space-craft fast-path: fly cosmetic "speeders" instead of
    // a generic airliner. The Kenney craft are oriented forward = -Z by
    // default, so we yaw them +π/2 here so the OUTER group's "forward"
    // axis is +X — matching the procedural airplane below. The sky-spawn
    // code applies an additional rotation.y based on startX, so this
    // local rotation just normalises the local frame.
    if (this._models) {
      const KEYS = ['space/speeder-a', 'space/speeder-b', 'space/racer'];
      const km = this._models.cloneByKey(KEYS[Math.floor(Math.random() * KEYS.length)]);
      if (km) {
        // Scale FIRST (in native orientation, where length runs along Z)
        // so fitToBox measures the un-rotated bounds, THEN apply the yaw
        // that aligns the craft's forward axis with the group's +X.
        this._models.fitToBox(km, { length: 5, mode: 'fit' });
        km.rotation.y = Math.PI / 2;
        group.add(km);
        return group;
      }
    }
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf5f7fa, roughness: 0.4, metalness: 0.6 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xd14b4b, roughness: 0.4 });

    // Fuselage
    const fuselageGeo = new THREE.CylinderGeometry(0.5, 0.4, 5, 12);
    const fuselage = new THREE.Mesh(fuselageGeo, bodyMat);
    fuselage.rotation.z = Math.PI / 2;
    group.add(fuselage);

    // Nose cone
    const noseGeo = new THREE.ConeGeometry(0.5, 1, 12);
    const nose = new THREE.Mesh(noseGeo, bodyMat);
    nose.rotation.z = -Math.PI / 2;
    nose.position.x = 3;
    group.add(nose);

    // Tail accent
    const tailStripeGeo = new THREE.CylinderGeometry(0.51, 0.41, 0.6, 12);
    const tailStripe = new THREE.Mesh(tailStripeGeo, accentMat);
    tailStripe.rotation.z = Math.PI / 2;
    tailStripe.position.x = -2.0;
    group.add(tailStripe);

    // Wings
    const wingGeo = new THREE.BoxGeometry(2.2, 0.12, 5.5);
    const wings = new THREE.Mesh(wingGeo, bodyMat);
    wings.position.set(0.3, -0.05, 0);
    group.add(wings);

    // Tail vertical fin
    const finGeo = new THREE.BoxGeometry(1.0, 1.1, 0.12);
    const fin = new THREE.Mesh(finGeo, bodyMat);
    fin.position.set(-2.2, 0.6, 0);
    group.add(fin);

    // Tail horizontal stabilizer
    const stabGeo = new THREE.BoxGeometry(1.0, 0.1, 2.0);
    const stab = new THREE.Mesh(stabGeo, bodyMat);
    stab.position.set(-2.2, 0.2, 0);
    group.add(stab);

    return group;
  }

  _buildBalloon() {
    const group = new THREE.Group();

    // Envelope (the balloon itself) — slightly stretched sphere
    const colors = [0xff6b6b, 0xffd166, 0x4ecdc4, 0xa06cd5, 0xf78c6b];
    const c1 = colors[Math.floor(Math.random() * colors.length)];
    const c2 = colors[Math.floor(Math.random() * colors.length)];

    const envelopeGeo = new THREE.SphereGeometry(2, 18, 18);
    const envelopeMat = new THREE.MeshStandardMaterial({ color: c1, roughness: 0.6 });
    const envelope = new THREE.Mesh(envelopeGeo, envelopeMat);
    envelope.scale.set(1, 1.25, 1);
    envelope.position.y = 0.6;
    group.add(envelope);

    // Vertical stripes for visual flair
    for (let i = 0; i < 6; i++) {
      const stripeGeo = new THREE.TorusGeometry(2, 0.06, 6, 24, Math.PI);
      const stripeMat = new THREE.MeshStandardMaterial({ color: c2, roughness: 0.5 });
      const stripe = new THREE.Mesh(stripeGeo, stripeMat);
      stripe.rotation.y = (i / 6) * Math.PI * 2;
      stripe.rotation.x = Math.PI / 2;
      stripe.scale.y = 1.25;
      stripe.position.y = 0.6;
      group.add(stripe);
    }

    // Ropes
    const ropeMat = new THREE.LineBasicMaterial({ color: 0x222222 });
    for (const off of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) {
      const ropeGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(off[0] * 0.7, -1.2, off[1] * 0.7),
        new THREE.Vector3(off[0], -2.4, off[1]),
      ]);
      const rope = new THREE.Line(ropeGeo, ropeMat);
      group.add(rope);
    }

    // Basket
    const basketGeo = new THREE.BoxGeometry(1.4, 0.9, 1.4);
    const basketMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.9 });
    const basket = new THREE.Mesh(basketGeo, basketMat);
    basket.position.y = -2.9;
    group.add(basket);

    return group;
  }

  _buildRocket() {
    const group = new THREE.Group();

    // Body
    const bodyGeo = new THREE.CylinderGeometry(0.4, 0.4, 2.4, 16);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.3, metalness: 0.5 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    group.add(body);

    // Nose cone
    const noseGeo = new THREE.ConeGeometry(0.4, 0.9, 16);
    const noseMat = new THREE.MeshStandardMaterial({ color: 0xd14b4b, roughness: 0.3 });
    const nose = new THREE.Mesh(noseGeo, noseMat);
    nose.position.y = 1.65;
    group.add(nose);

    // Window
    const winGeo = new THREE.SphereGeometry(0.18, 12, 12);
    const winMat = new THREE.MeshStandardMaterial({
      color: 0x9be3ff, emissive: 0x4cc6ff, emissiveIntensity: 0.6,
    });
    const win = new THREE.Mesh(winGeo, winMat);
    win.position.set(0, 0.4, 0.32);
    group.add(win);

    // Fins
    const finMat = new THREE.MeshStandardMaterial({ color: 0xd14b4b, roughness: 0.3 });
    for (let i = 0; i < 3; i++) {
      const finShape = new THREE.Shape();
      finShape.moveTo(0, 0);
      finShape.lineTo(0.7, -0.4);
      finShape.lineTo(0, 0.6);
      finShape.lineTo(0, 0);
      const finGeo = new THREE.ShapeGeometry(finShape);
      const fin = new THREE.Mesh(finGeo, finMat);
      fin.position.set(0.4, -1.2, 0);
      fin.rotation.y = (i / 3) * Math.PI * 2;
      group.add(fin);
    }

    // Flame
    const flameGeo = new THREE.ConeGeometry(0.3, 1.2, 12);
    const flameMat = new THREE.MeshStandardMaterial({
      color: 0xffae42, emissive: 0xffa028, emissiveIntensity: 1.2, transparent: true, opacity: 0.95,
    });
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.position.y = -1.7;
    flame.rotation.x = Math.PI;
    group.add(flame);
    group.userData.flame = flame;

    return group;
  }

  _updateSkyObjects(delta, moveZ) {
    if (this.skyObjects.length === 0) return;

    for (let i = this.skyObjects.length - 1; i >= 0; i--) {
      const obj = this.skyObjects[i];
      const ud = obj.userData;
      ud.age += delta;

      // Parallax: subtract a fraction of the world's z-motion. Distant objects
      // move much less, near objects move closer to "real" speed.
      obj.position.z -= moveZ * ud.parallax;

      // Type-specific motion
      if (ud.skyKind === 'airplane') {
        obj.position.x += ud.vx * delta;
        obj.position.y += ud.vy * delta;
        if (ud.vz) obj.position.z += ud.vz * delta;
        // Flyby planes grow slightly as they approach the player (purely
        // visual — perspective handles most of it)
        if (ud.flyby) {
          const t = Math.max(0, 1 - obj.position.z / 200);
          obj.scale.setScalar(1.8 + t * 0.6);
        }
      } else if (ud.skyKind === 'balloon') {
        obj.position.x += ud.vx * delta;
        obj.position.y += ud.vy * delta;
        // Gentle bob
        ud.bobPhase += delta * 1.4;
        obj.position.x += Math.sin(ud.bobPhase) * 0.3 * delta;
      } else if (ud.skyKind === 'rocket') {
        obj.position.x += ud.vx * delta;
        obj.position.y += ud.vy * delta;
        ud.vy += 12 * delta; // accelerate upward
        // Pulse the flame
        if (obj.userData.flame) {
          const f = 0.85 + Math.sin(performance.now() * 0.04) * 0.2;
          obj.userData.flame.scale.set(f, 1 + f * 0.4, f);
        }
        // Update trail
        if (ud.trail) {
          const pos = ud.trail.geometry.attributes.position;
          for (let p = ud.trailPoints - 1; p > 0; p--) {
            pos.array[p * 3]     = pos.array[(p - 1) * 3];
            pos.array[p * 3 + 1] = pos.array[(p - 1) * 3 + 1];
            pos.array[p * 3 + 2] = pos.array[(p - 1) * 3 + 2];
          }
          pos.array[0] = obj.position.x;
          pos.array[1] = obj.position.y - 1.2;
          pos.array[2] = obj.position.z;
          pos.needsUpdate = true;
        }
      }

      // Despawn when life expires OR drifts off frame. Sky objects now
      // persist regardless of airtime.
      const offscreen = ud.age > ud.life
        || obj.position.z < -30
        || obj.position.z > 260
        || Math.abs(obj.position.x) > 220
        || obj.position.y < 5
        || obj.position.y > 80;

      if (offscreen) {
        if (ud.trail) this.scene.remove(ud.trail);
        this.scene.remove(obj);
        this.skyObjects.splice(i, 1);
      }
    }
  }

  // Maintain the always-on sky population: 2-3 airplanes, 1-2 balloons,
  // periodic rockets, and the occasional dramatic flyby plane.
  _maintainSky(delta) {
    if (this.state !== 'playing') return;

    let airplaneCount = 0, balloonCount = 0;
    for (const obj of this.skyObjects) {
      if (obj.userData.skyKind === 'airplane') airplaneCount++;
      else if (obj.userData.skyKind === 'balloon') balloonCount++;
    }

    this._planeSpawnCD = (this._planeSpawnCD || 0) - delta;
    this._balloonSpawnCD = (this._balloonSpawnCD || 0) - delta;
    this._rocketCD = this._rocketCD == null ? 6 + Math.random() * 6 : this._rocketCD - delta;
    this._flybyCD = this._flybyCD == null ? 18 + Math.random() * 12 : this._flybyCD - delta;

    if (airplaneCount < 2 && this._planeSpawnCD <= 0) {
      const low = Math.random() < 0.3; // ~30% are dramatic low passes
      this._spawnSkyObject('airplane', { low, far: !low && Math.random() < 0.5 });
      this._planeSpawnCD = 1.5 + Math.random() * 2.5;
    } else if (airplaneCount < 3 && this._planeSpawnCD <= 0 && Math.random() < 0.4) {
      this._spawnSkyObject('airplane', { far: Math.random() < 0.55 });
      this._planeSpawnCD = 3 + Math.random() * 3;
    }

    if (balloonCount < 1 && this._balloonSpawnCD <= 0) {
      this._spawnSkyObject('balloon', { far: Math.random() < 0.5 });
      this._balloonSpawnCD = 3 + Math.random() * 3;
    } else if (balloonCount < 2 && this._balloonSpawnCD <= 0 && Math.random() < 0.3) {
      this._spawnSkyObject('balloon', { far: Math.random() < 0.6 });
      this._balloonSpawnCD = 5 + Math.random() * 5;
    }

    if (this._rocketCD <= 0) {
      this._spawnSkyObject('rocket', { far: Math.random() < 0.5 });
      this._rocketCD = 20 + Math.random() * 10;
    }

    if (this._flybyCD <= 0) {
      this._spawnSkyObject('airplane', { flyby: true });
      this._flybyCD = 25 + Math.random() * 15;
    }
  }

  _clearSkyObjects() {
    for (const obj of this.skyObjects) {
      if (obj.userData.trail) this.scene.remove(obj.userData.trail);
      this.scene.remove(obj);
    }
    this.skyObjects = [];
    this._planeSpawnCD = 0;
    this._balloonSpawnCD = 0;
    this._rocketCD = 4 + Math.random() * 4;
    this._flybyCD = 12 + Math.random() * 10;
    this._clearHazards();
  }

  _clearHazards() {
    for (const r of this.rockets || []) {
      if (r.userData.trail) this.scene.remove(r.userData.trail);
      this.scene.remove(r);
    }
    for (const p of this.lowPassPlanes || []) this.scene.remove(p);
    for (const d of this.drones || []) this.scene.remove(d);
    this.rockets = [];
    this.lowPassPlanes = [];
    this.drones = [];
    this._pendingRocket = null;
    this._pendingLowPass = null;
    this._rocketTimer = GAME_CONFIG.ROCKET_INTERVAL_MIN
      + Math.random() * (GAME_CONFIG.ROCKET_INTERVAL_MAX - GAME_CONFIG.ROCKET_INTERVAL_MIN);
    this._lowPassTimer = GAME_CONFIG.LOW_PASS_INTERVAL_MIN
      + Math.random() * (GAME_CONFIG.LOW_PASS_INTERVAL_MAX - GAME_CONFIG.LOW_PASS_INTERVAL_MIN);
    this._droneSpawnZ = GAME_CONFIG.DRONE_SPAWN_START_DISTANCE;
    this._droneAlertCooldownUntil = 0;
    this._setHazardWarning('left', false);
    this._setHazardWarning('right', false);
    this._setHazardWarning('center', false);
  }

  // ── Clouds (decorative) ──────────────────────────────────────

  _setupClouds() {
    for (let i = 0; i < 11; i++) {
      const cloud = this._buildCloud();
      cloud.position.set(
        (Math.random() - 0.5) * 130,
        40 + Math.random() * 30,
        Math.random() * 350,
      );
      cloud.userData.driftSpeed = 0.5 + Math.random() * 0.5;
      this.scene.add(cloud);
      this.clouds.push(cloud);
    }
  }

  _buildCloud() {
    const group = new THREE.Group();
    const sphereCount = 3 + Math.floor(Math.random() * 3);
    const cloudMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0, transparent: true, opacity: 0.85,
    });
    let maxR = 0;
    for (let i = 0; i < sphereCount; i++) {
      const r = 1.5 + Math.random() * 2.5;
      maxR = Math.max(maxR, r);
      const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), cloudMat);
      puff.position.set(
        (Math.random() - 0.5) * 4.5,
        (Math.random() - 0.5) * 1.2,
        (Math.random() - 0.5) * 4.5,
      );
      group.add(puff);
    }
    // Ground shadow disabled — the dark disc on the ground was visible
    // at the starting line (and elsewhere along the course) and looked
    // like an unintended dirt patch. Clouds float as visuals only now.
    return group;
  }

  _updateClouds(delta, moveZ) {
    for (const cloud of this.clouds) {
      cloud.position.z -= moveZ + cloud.userData.driftSpeed * delta;
      const sh = cloud.userData.shadow;
      if (sh) {
        sh.position.x = cloud.position.x;
        sh.position.z = cloud.position.z;
        sh.position.y = 0.04;
      }
      if (cloud.position.z < -40) {
        cloud.position.z += 380 + Math.random() * 30;
        cloud.position.x = (Math.random() - 0.5) * 130;
        cloud.position.y = 40 + Math.random() * 30;
      }
    }
  }

  // ── Rockets (active hazards) ─────────────────────────────────

  _buildRocketHazard() {
    const group = new THREE.Group();

    // Body
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.3, 2.5, 14),
      new THREE.MeshStandardMaterial({ color: 0xE74C3C, roughness: 0.3, metalness: 0.4 }),
    );
    group.add(body);

    // Nose
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.3, 0.8, 14),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }),
    );
    nose.position.y = 1.65;
    group.add(nose);

    // Fins
    const finMat = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.7 });
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.6, 0.5), finMat);
      const a = (i / 4) * Math.PI * 2;
      fin.position.set(Math.cos(a) * 0.32, -1.0, Math.sin(a) * 0.32);
      fin.rotation.y = a;
      group.add(fin);
    }

    // Flame trail — 6 graduated spheres
    const flameColors = [0xFFD700, 0xFFC107, 0xFF9800, 0xFF6600, 0xFF3300, 0xFF0000];
    const flames = [];
    for (let i = 0; i < flameColors.length; i++) {
      const r = 0.32 - i * 0.04;
      const f = new THREE.Mesh(
        new THREE.SphereGeometry(r, 8, 6),
        new THREE.MeshStandardMaterial({
          color: flameColors[i],
          emissive: flameColors[i],
          emissiveIntensity: 0.85,
          transparent: true,
          opacity: 0.95 - i * 0.1,
        }),
      );
      f.position.y = -1.4 - i * 0.35;
      flames.push(f);
      group.add(f);
    }
    group.userData.flames = flames;

    // Smoke trail — line of grey spheres with decreasing opacity
    const trailGroup = new THREE.Group();
    const smokes = [];
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Mesh(
        new THREE.SphereGeometry(0.35 + i * 0.06, 8, 6),
        new THREE.MeshStandardMaterial({
          color: 0xbbbbbb, transparent: true, opacity: 0.6 * (1 - i / 14),
        }),
      );
      s.userData.indexI = i;
      smokes.push(s);
      trailGroup.add(s);
    }
    this.scene.add(trailGroup);
    group.userData.trail = trailGroup;
    group.userData.smokes = smokes;

    return group;
  }

  _spawnRocket(side) {
    const rocket = this._buildRocketHazard();
    const sx = side < 0 ? -10 : 10;
    rocket.position.set(sx, 0, -6);

    // Steep launch (~70° from horizontal): mostly upward, some forward
    const speed = 40 + Math.random() * 20;
    const a = 70 * Math.PI / 180;
    rocket.userData.vx = 0;
    rocket.userData.vy = speed * Math.sin(a);   // ~47 at 50
    rocket.userData.vz = speed * Math.cos(a);   // ~17 at 50
    rocket.userData.life = 3.0;
    rocket.userData.age = 0;

    // Pitch the rocket forward to match its velocity vector
    rocket.rotation.x = -(Math.PI / 2 - a);

    this.scene.add(rocket);
    this.rockets.push(rocket);
  }

  _updateRockets(delta) {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      const ud = r.userData;
      ud.age += delta;
      r.position.x += ud.vx * delta;
      r.position.y += ud.vy * delta;
      r.position.z += ud.vz * delta;

      // Flame wobble
      if (ud.flames) {
        for (let f = 0; f < ud.flames.length; f++) {
          const flame = ud.flames[f];
          const wob = 1 + Math.sin(performance.now() * 0.025 + f) * 0.15;
          flame.scale.set(wob, wob, wob);
        }
      }

      // Smoke trail — push current position into the buffer head
      if (ud.smokes && ud.smokes.length) {
        for (let s = ud.smokes.length - 1; s > 0; s--) {
          ud.smokes[s].position.copy(ud.smokes[s - 1].position);
        }
        ud.smokes[0].position.set(r.position.x, r.position.y - 1.3, r.position.z);
      }

      // Despawn after life or off-screen
      if (ud.age > ud.life
          || r.position.y > 60
          || r.position.z > 220
          || Math.abs(r.position.x) > 150) {
        if (ud.trail) this.scene.remove(ud.trail);
        this.scene.remove(r);
        this.rockets.splice(i, 1);
      }
    }
  }

  // ── Low-pass airplanes (deadly) ──────────────────────────────

  _spawnLowPassPlane() {
    const plane = this._buildAirplane();
    const dir = Math.random() < 0.5 ? 1 : -1;     // +1 = right, -1 = left
    const startX = dir > 0 ? -50 : 50;
    plane.position.set(startX, 5 + Math.random() * 3, -2 + Math.random() * 4);
    plane.userData.vx = dir * (28 + Math.random() * 6);
    plane.userData.vy = 0;
    plane.userData.vz = 0;
    plane.userData.life = 8;
    plane.userData.age = 0;
    plane.rotation.y = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
    plane.scale.setScalar(1.4);
    this.scene.add(plane);

    // Subtle dark-grey oval shadow that grows as the plane approaches
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1.4, 18),
      new THREE.MeshBasicMaterial({
        color: 0x222222, transparent: true, opacity: 0.15, depthWrite: false,
      }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.05;
    shadow.scale.set(1.0, 1.0, 1.6);  // elongated along the player's Z axis (oval)
    this.scene.add(shadow);
    plane.userData.shadow = shadow;
    this.lowPassPlanes.push(plane);
  }

  _updateLowPassPlanes(delta) {
    for (let i = this.lowPassPlanes.length - 1; i >= 0; i--) {
      const p = this.lowPassPlanes[i];
      const ud = p.userData;
      ud.age += delta;
      p.position.x += ud.vx * delta;
      if (ud.shadow) {
        ud.shadow.position.x = p.position.x;
        ud.shadow.position.z = p.position.z;
        // Grow as the plane closes on the player horizontally
        const distX = Math.abs(p.position.x - this.player.position.x);
        const grow = THREE.MathUtils.clamp(1 - distX / 30, 0.4, 1.6);
        ud.shadow.scale.set(grow, grow * 1.6, 1);
        ud.shadow.material.opacity = 0.10 + grow * 0.10;
      }
      if (ud.age > ud.life || Math.abs(p.position.x) > 80) {
        if (ud.shadow) this.scene.remove(ud.shadow);
        this.scene.remove(p);
        this.lowPassPlanes.splice(i, 1);
      }
    }
  }

  // ── Drones (hover hazards) ───────────────────────────────────

  _buildDrone() {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.6, metalness: 0.4 });
    const armMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.5), bodyMat);
    // Phase 5 perf: drone is high above ground and outside the directional
    // shadow camera frustum — its cast shadow contributes nothing.
    body.castShadow = false;
    group.add(body);

    // Four diagonal arms + rotors
    const rotors = [];
    const armLen = 0.55;
    const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const [sx, sz] of corners) {
      const arm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.04, armLen, 6),
        armMat,
      );
      arm.position.set(sx * armLen / 2, 0, sz * armLen / 2);
      arm.rotation.z = Math.PI / 2;
      arm.rotation.y = Math.atan2(sz, sx) - Math.PI / 2;
      group.add(arm);

      const rotor = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.3, 0.03, 16),
        new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.5, transparent: true, opacity: 0.85 }),
      );
      rotor.position.set(sx * (armLen + 0.05), 0.12, sz * (armLen + 0.05));
      group.add(rotor);
      rotors.push(rotor);
    }
    group.userData.rotors = rotors;

    // Lens
    const lens = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0x4cc6ff, emissive: 0x2a8acc, emissiveIntensity: 0.7 }),
    );
    lens.position.set(0, -0.13, 0);
    group.add(lens);

    // LED lights front (red) + back (green)
    const ledFront = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 6, 6),
      new THREE.MeshStandardMaterial({ color: 0xff3030, emissive: 0xff3030, emissiveIntensity: 1.4 }),
    );
    ledFront.position.set(0, 0.05, 0.3);
    group.add(ledFront);
    const ledBack = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 6, 6),
      new THREE.MeshStandardMaterial({ color: 0x35d24a, emissive: 0x35d24a, emissiveIntensity: 1.4 }),
    );
    ledBack.position.set(0, 0.05, -0.3);
    group.add(ledBack);

    // Marker diamond floating above the drone
    const markerGeo = new THREE.OctahedronGeometry(0.22, 0);
    const markerMat = new THREE.MeshStandardMaterial({
      color: 0xff3030, emissive: 0xff3030, emissiveIntensity: 1.0,
      transparent: true, opacity: 0.85,
    });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.y = 1.1;
    group.add(marker);
    group.userData.marker = marker;

    // (Ground danger disc removed — drones must be spotted in the air visually.)
    return group;
  }

  _spawnDrone(z) {
    // Phase 4 perf: hard cap so a long run never piles drones up.
    if (this.drones.length >= 4) return;
    const drone = this._buildDrone();
    drone.position.set(
      (Math.random() - 0.5) * 8,
      3 + Math.random() * 5,
      z,
    );
    drone.userData.baseX = drone.position.x;
    drone.userData.bobAmp = 1.5 + Math.random() * 1.5;
    drone.userData.bobFreq = 0.6 + Math.random() * 0.6;
    drone.userData.bobPhase = Math.random() * Math.PI * 2;
    drone.userData.driftZ = Math.random() < 0.5 ? 0 : (5 + Math.random() * 4);
    this.scene.add(drone);
    this.drones.push(drone);
  }

  _updateDrones(delta, moveZ) {
    const t = performance.now() * 0.001;
    for (let i = this.drones.length - 1; i >= 0; i--) {
      const d = this.drones[i];
      const ud = d.userData;
      // Sine-wave horizontal motion
      d.position.x = ud.baseX + Math.sin(t * ud.bobFreq * Math.PI + ud.bobPhase) * ud.bobAmp;
      // Drift toward player; world also pulls them in
      d.position.z -= moveZ + ud.driftZ * delta;
      // Spin rotors
      if (ud.rotors) {
        for (const r of ud.rotors) r.rotation.y += 20 * delta;
      }
      // Wobble marker for visibility
      if (ud.marker) ud.marker.rotation.y += 2 * delta;

      if (d.position.z < -25) {
        this.scene.remove(d);
        this.drones.splice(i, 1);
      }
    }

    // Spawn new drones every 30-50 units of distance, after 200m
    if (this.distance >= GAME_CONFIG.DRONE_SPAWN_START_DISTANCE
        && this.distance >= this._droneSpawnZ - GAME_CONFIG.DRONE_SPAWN_START_DISTANCE) {
      // Use distance-tracked spawning: spawn when distance crosses threshold
      while (this.distance > this._droneSpawnZ - GAME_CONFIG.DRONE_SPAWN_START_DISTANCE) {
        // Drop 1-2 drones ahead of the player
        const count = Math.random() < 0.4 ? 2 : 1;
        for (let k = 0; k < count; k++) {
          this._spawnDrone(180 + Math.random() * 40);
        }
        this._droneSpawnZ += GAME_CONFIG.DRONE_SPAWN_GAP_MIN
          + Math.random() * (GAME_CONFIG.DRONE_SPAWN_GAP_MAX - GAME_CONFIG.DRONE_SPAWN_GAP_MIN);
        // 5-second cooldown on drone_alert — even if multiple drone batches
        // spawn rapidly, the alert (and its chained approach) only fires
        // once per cooldown window so the audio doesn't spam.
        const now = performance.now();
        if (!this._droneAlertCooldownUntil || now >= this._droneAlertCooldownUntil) {
          this._droneAlertCooldownUntil = now + 5000;
          this.sounds.play('drone_alert');
          // Chain the approach sound 1.5 s later — only if still playing.
          setTimeout(() => {
            if (this.state === 'playing') this.sounds.play('drone_approch');
          }, 1500);
        }
      }
    }
  }

  // ── Hazard scheduler & warnings ──────────────────────────────

  _updateHazardScheduler(delta) {
    if (this.state !== 'playing') return;

    // Rocket: countdown → flash warning → launch
    this._rocketTimer -= delta;
    if (this._rocketTimer <= 0 && !this._pendingRocket) {
      const side = Math.random() < 0.5 ? -1 : 1;
      this._pendingRocket = { side, fireAt: GAME_CONFIG.ROCKET_WARNING_TIME };
      this._setHazardWarning(side < 0 ? 'left' : 'right', true);
    }
    if (this._pendingRocket) {
      this._pendingRocket.fireAt -= delta;
      if (this._pendingRocket.fireAt <= 0) {
        const side = this._pendingRocket.side;
        this._spawnRocket(side);
        this._setHazardWarning(side < 0 ? 'left' : 'right', false);
        this._pendingRocket = null;
        this._rocketTimer = GAME_CONFIG.ROCKET_INTERVAL_MIN
          + Math.random() * (GAME_CONFIG.ROCKET_INTERVAL_MAX - GAME_CONFIG.ROCKET_INTERVAL_MIN);
      }
    }

    // Low-pass airplane: warning then spawn
    this._lowPassTimer -= delta;
    if (this._lowPassTimer <= 0 && !this._pendingLowPass) {
      this._pendingLowPass = { fireAt: GAME_CONFIG.LOW_PASS_WARNING_TIME };
      this._setHazardWarning('center', true);
    }
    if (this._pendingLowPass) {
      this._pendingLowPass.fireAt -= delta;
      if (this._pendingLowPass.fireAt <= 0) {
        this._spawnLowPassPlane();
        this._setHazardWarning('center', false);
        this._pendingLowPass = null;
        this._lowPassTimer = GAME_CONFIG.LOW_PASS_INTERVAL_MIN
          + Math.random() * (GAME_CONFIG.LOW_PASS_INTERVAL_MAX - GAME_CONFIG.LOW_PASS_INTERVAL_MIN);
      }
    }
  }

  _setHazardWarning(which, on) {
    const el = which === 'left' ? this.hazardWarnLeftEl
             : which === 'right' ? this.hazardWarnRightEl
             : this.hazardWarnCenterEl;
    if (!el) return;
    el.classList.toggle('show', !!on);
  }

  // ── Flying hazard collision ──────────────────────────────────

  // Returns the hit-type string ('rocket' | 'airplane' | 'drone' | 'balloon')
  // or null if no aerial hazard was hit. Only triggers when the player is
  // genuinely above the ground (py > 0.5).
  _checkFlyingHazards() {
    const px = this.player.position.x;
    const py = this.player.position.y;
    const pz = this.player.position.z;
    if (py <= 0.5) return null;
    // Phase 3 perf: cheap squared-distance early-outs on Z (cheapest axis
    // since most hazards spawn far ahead). Each loop bails on the FIRST
    // axis-distance check before doing any 3D distance math.

    for (const r of this.rockets) {
      const dz = r.position.z - pz;
      if (dz > 1.7 || dz < -1.7) continue;
      const dx = r.position.x - px;
      if (dx > 1.7 || dx < -1.7) continue;
      const dy = r.position.y - py;
      if (dx * dx + dy * dy + dz * dz < 1.7 * 1.7) return 'rocket';
    }
    for (const p of this.lowPassPlanes) {
      if (Math.abs(p.position.z - pz) > 5) continue;
      const dx = Math.abs(p.position.x - px);
      const dy = Math.abs(p.position.y - py);
      if (dx < 5 && dy < 1.5) return 'airplane';
    }
    for (const d of this.drones) {
      const dz = d.position.z - pz;
      if (dz > 1.3 || dz < -1.3) continue;
      const dx = d.position.x - px;
      if (dx > 1.3 || dx < -1.3) continue;
      const dy = d.position.y - py;
      // Close call for drones
      const closeThreshold = 10;
      if (dx * dx + dy * dy + dz * dz < closeThreshold * closeThreshold && this.closeCallCooldown <= 0) {
        this.sounds.play('drone_approach');
        this.closeCallCooldown = 2;
      }
      if (dx * dx + dy * dy + dz * dz < 1.3 * 1.3) return 'drone';
    }
    // Balloons (still tracked in skyObjects)
    for (const obj of this.skyObjects) {
      if (obj.userData.skyKind !== 'balloon') continue;
      const dz = obj.position.z - pz;
      if (dz > 2 || dz < -2) continue;
      const dx = obj.position.x - px;
      if (dx > 2 || dx < -2) continue;
      const dy = obj.position.y - py;
      if (dx * dx + dy * dy + dz * dz < 2.0 * 2.0) return 'balloon';
    }
    return null;
  }

  // ── Explosion / death sequence ───────────────────────────────

  _die(position, hitType, title) {
    if (this.state !== 'playing') return;
    // Debug mode: rabbit-cam analysis. Player invincible — ignore all
    // collision deaths so the round runs indefinitely.
    if (this._debugRabbitCam) return;
    // Brief post-continue invincibility window so the player isn't
    // instantly killed again by the same obstacle they just respawned
    // next to.
    if (this._invincibleUntil && performance.now() < this._invincibleUntil) return;
    this._pendingGameOverTitle = title || 'CRASHED!';
    // bgMusic keeps playing during the crash impact sound. The death-cam
    // audio sequence (stop SFX, stop bgMusic, play death_cam stinger)
    // fires once the crash clip finishes — see beginDeathCamAudio below.
    // Snapshot the crash spot + identify the object that killed us so the
    // post-death camera can frame BOTH in view.
    this._crashPos = position.clone();
    this._killer   = this._findKillerObject(position, hitType);
    this._deathCamElapsed = 0;
    // Plant a flag at the death spot showing the distance reached
    this._placeDeathFlag(position, this.distance);
    this._explode(position.clone(), hitType || 'car');
    // SFX: prefer a kind-specific crash variant if defined; fall back to
    // the generic 'crash' event. e.g. lamp hit → 'crash_lamp' if its pool
    // has any clips, otherwise 'crash'.
    const kind = (this._killer && this._killer.kind) || hitType || 'crash';
    const variant = `crash_${kind}`;
    const crashSrc = (this.sounds.getSounds(variant).length > 0)
      ? this.sounds.play(variant)
      : this.sounds.play('crash');
    const beginDeathCamAudio = () => {
      // Restart can interrupt the crash mid-flight via stopAllSources();
      // in that case we don't want to start the death-cam sequence
      // because we're no longer in 'exploding' state.
      if (this.state !== 'exploding') return;
      if (this.sounds) this.sounds.stopAllSources();
      this._stopBgMusic();
      if (this.sounds) this.sounds.play('death_cam');
    };
    if (crashSrc) {
      // Chain after the SoundLibrary's own onended (which removes the
      // source from _liveSources) so cleanup runs first, then ours.
      const prev = crashSrc.onended;
      crashSrc.onended = (e) => {
        if (prev) { try { prev(e); } catch (err) { /* ignore */ } }
        beginDeathCamAudio();
      };
    } else {
      // No crash source returned (silent event, buffer not yet loaded,
      // disabled SFX) — fire the death-cam sequence immediately rather
      // than wait for an event that will never come.
      beginDeathCamAudio();
    }
  }

  // Walk the world for the closest object that could have caused the hit.
  // Returns { kind, pos } where pos is a Vector3 cloned at death time so
  // the world can keep scrolling without losing the killer reference.
  _findKillerObject(playerPos, hitType) {
    let best = null, bestD2 = Infinity;
    const consider = (kind, x, y, z) => {
      const dx = x - playerPos.x, dy = y - playerPos.y, dz = z - playerPos.z;
      const d2 = dx*dx + dy*dy + dz*dz;
      if (d2 < bestD2) { bestD2 = d2; best = { kind, pos: new THREE.Vector3(x, y, z) }; }
    };
    // Scenery (collidable: trees, lamps, rocks)
    for (const s of this.scenery || []) {
      if (!s.userData || !s.userData.collidable) continue;
      if (Math.abs(s.position.z) > 8) continue;
      consider(s.userData.kind || 'scenery', s.position.x, 0, s.position.z);
    }
    // Lane obstacles (parked cars / boulders)
    for (const o of this.obstacles || []) {
      if (Math.abs(o.position.z) > 8) continue;
      consider(o.userData.vehicleType ? 'car' : 'boulder',
               o.position.x, o.position.y || 0, o.position.z);
    }
    // Cross-street vehicles
    for (const street of this.crossStreets || []) {
      if (Math.abs(street.position.z) > 6) continue;
      for (const car of street.userData.cars || []) {
        const cz = street.position.z + (car.position.z || 0);
        if (Math.abs(cz - playerPos.z) > 5) continue;
        consider('car', car.position.x, 0, cz);
      }
    }
    // Mountain-split high-rise
    for (const m of this.mountainBlocks || []) {
      if (m.userData.kind !== 'building') continue;
      if (Math.abs(m.position.z) > 14) continue;
      consider('building', m.position.x, 0, m.position.z);
    }
    // Aerial — drones, rockets, low-pass planes, balloons
    for (const d of this.drones || []) {
      if (Math.abs(d.position.z) > 6) continue;
      consider('drone', d.position.x, d.position.y, d.position.z);
    }
    for (const r of this.rockets || []) {
      if (Math.abs(r.position.z) > 6) continue;
      consider('rocket', r.position.x, r.position.y, r.position.z);
    }
    for (const obj of this.skyObjects || []) {
      if (obj.userData.skyKind !== 'balloon') continue;
      if (Math.abs(obj.position.z) > 6) continue;
      consider('balloon', obj.position.x, obj.position.y, obj.position.z);
    }
    // Fallback if nothing was nearby — point the cam at the hint
    if (!best) {
      best = { kind: hitType || 'crash', pos: playerPos.clone() };
    }
    return best;
  }

  _placeDeathFlag(position, distance) {
    if (this.deathFlag) {
      this.scene.remove(this.deathFlag);
      this.deathFlag = null;
    }
    const group = new THREE.Group();

    // Pole
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.10, 4.2, 10),
      new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.65 }),
    );
    pole.position.y = 2.1;
    pole.castShadow = true;
    group.add(pole);

    // Flag fabric — canvas with the distance written on it
    const cnv = document.createElement('canvas');
    cnv.width = 256; cnv.height = 128;
    const ctx = cnv.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 256, 128);
    grad.addColorStop(0, '#ff5a3c');
    grad.addColorStop(1, '#ffae42');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = '#aa3700';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 250, 122);
    ctx.font = 'bold 28px Arial Black';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffe14a';
    ctx.fillText('REACHED', 128, 32);
    ctx.font = 'bold 60px Arial Black';
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#aa3700';
    ctx.fillStyle = '#ffffff';
    const txt = `${Math.floor(distance)}m`;
    ctx.strokeText(txt, 128, 80);
    ctx.fillText(txt, 128, 80);
    const tex = new THREE.CanvasTexture(cnv);
    tex.colorSpace = THREE.SRGBColorSpace;

    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 1.3),
      new THREE.MeshStandardMaterial({
        map: tex, side: THREE.DoubleSide, roughness: 0.55,
      }),
    );
    flag.position.set(1.35, 3.4, 0);
    group.add(flag);

    // Top cap
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 12, 12),
      new THREE.MeshStandardMaterial({
        color: 0xFFD700, emissive: 0xffae42, emissiveIntensity: 0.7,
      }),
    );
    cap.position.y = 4.25;
    group.add(cap);

    group.position.set(position.x, 0, position.z);
    this.scene.add(group);
    this.deathFlag = group;
  }

  _explosionTypeColors(hitType) {
    switch (hitType) {
      case 'car':      return [0xF1C40F, 0xE74C3C, 0x3498DB];
      case 'drone':    return [0x888888, 0xffeb3b];
      case 'rocket':   return [0xff0000, 0xffffff, 0xff6600];
      case 'airplane': return [0xAAAAAA, 0xffffff];
      case 'balloon':  return [0xff6b6b, 0xffd166, 0x4ecdc4, 0xa06cd5];
      case 'boulder':  return [0x8B4513, 0x6b4423];
      default:         return [];
    }
  }

  _explode(position, hitType) {
    this.state = 'exploding';
    // Visuals start immediately (orbit camera, particles); the audio
    // sequence (stop SFX, stop bgMusic, play death_cam) is deferred
    // until the crash clip finishes — wired in _die() via the crash
    // source's onended.
    this._explosionParticles = [];
    this._secondaryExplosions = [];
    this._explosionDecel = 0;
    this._explosionElapsed = 0;
    this._explosionHitType = hitType;

    // Hide the player immediately
    if (this.player) this.player.visible = false;

    // Hard camera shake
    this.shakeTimer = 0.8;
    this.shakeMagnitude = 0.5;

    // Bigger blast radius for airplane crashes
    const radius = hitType === 'airplane' ? 1.4 : 1.0;

    // Main flash sphere
    const flashMat = new THREE.MeshStandardMaterial({
      color: 0xfff5cc, emissive: 0xfff5cc, emissiveIntensity: 1.6,
      transparent: true, opacity: 1.0,
    });
    const flash = new THREE.Mesh(new THREE.SphereGeometry(2 * radius, 16, 12), flashMat);
    flash.position.copy(position);
    flash.scale.setScalar(0.001);
    this.scene.add(flash);
    this._explosionParticles.push({ mesh: flash, kind: 'flash', life: 0.5, maxLife: 0.5 });

    // Shockwave ring
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff8a3c, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 1.0, 32), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(position.x, position.y + 0.05, position.z);
    this.scene.add(ring);
    this._explosionParticles.push({ mesh: ring, kind: 'shockwave', life: 0.5, maxLife: 0.5 });

    // Debris (mix of boxes and spheres, multi-color)
    const baseColors = [0xFF6600, 0xFFD700, 0xFF2200, 0x333333, 0xFFFFFF];
    const colors = baseColors.concat(this._explosionTypeColors(hitType));
    const debrisCount = hitType === 'airplane' ? 60 : 50;
    for (let i = 0; i < debrisCount; i++) {
      const isBox = Math.random() < 0.5;
      const geo = isBox
        ? new THREE.BoxGeometry(0.15, 0.15, 0.15)
        : new THREE.SphereGeometry(0.10, 6, 6);
      const color = colors[Math.floor(Math.random() * colors.length)];
      const mat = new THREE.MeshStandardMaterial({
        color, transparent: true, opacity: 1, roughness: 0.7,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(position);

      const dir = new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() * 0.7 + 0.3,
        Math.random() - 0.5,
      ).normalize();
      const speed = (8 + Math.random() * 12) * radius;
      const velocity = dir.multiplyScalar(speed);
      const angVel = new THREE.Vector3(
        (Math.random() - 0.5) * 12,
        (Math.random() - 0.5) * 12,
        (Math.random() - 0.5) * 12,
      );
      this.scene.add(mesh);
      this._explosionParticles.push({
        mesh, velocity, angularVelocity: angVel,
        kind: 'debris', life: 1.5, maxLife: 1.5, gravity: 30,
      });
    }

    // Type-specific extras
    if (hitType === 'balloon') {
      // Fabric planes that flutter down slowly
      const fabricColors = [0xff6b6b, 0xffd166, 0x4ecdc4, 0xa06cd5, 0xf78c6b];
      for (let i = 0; i < 7; i++) {
        const c = fabricColors[i % fabricColors.length];
        const fabric = new THREE.Mesh(
          new THREE.PlaneGeometry(0.7, 0.7),
          new THREE.MeshStandardMaterial({
            color: c, side: THREE.DoubleSide, transparent: true, opacity: 1,
          }),
        );
        fabric.position.copy(position);
        const dir = new THREE.Vector3(
          Math.random() - 0.5, Math.random() * 0.5 + 0.3, Math.random() - 0.5,
        ).normalize().multiplyScalar(4 + Math.random() * 3);
        this.scene.add(fabric);
        this._explosionParticles.push({
          mesh: fabric, velocity: dir,
          angularVelocity: new THREE.Vector3(2, 2, 2),
          kind: 'fabric', life: 2.5, maxLife: 2.5, gravity: 6,
        });
      }
    } else if (hitType === 'drone') {
      // Bright yellow sparks
      for (let i = 0; i < 10; i++) {
        const spark = new THREE.Mesh(
          new THREE.SphereGeometry(0.07, 6, 6),
          new THREE.MeshStandardMaterial({
            color: 0xffeb3b, emissive: 0xffeb3b, emissiveIntensity: 1.5,
            transparent: true, opacity: 1,
          }),
        );
        spark.position.copy(position);
        const dir = new THREE.Vector3(
          Math.random() - 0.5, Math.random() * 0.6 + 0.3, Math.random() - 0.5,
        ).normalize().multiplyScalar(15 + Math.random() * 10);
        this.scene.add(spark);
        this._explosionParticles.push({
          mesh: spark, velocity: dir,
          angularVelocity: new THREE.Vector3(0, 0, 0),
          kind: 'spark', life: 0.7, maxLife: 0.7, gravity: 30,
        });
      }
    } else if (hitType === 'rocket') {
      // Larger fire spheres
      for (let i = 0; i < 8; i++) {
        const fire = new THREE.Mesh(
          new THREE.SphereGeometry(0.25, 8, 6),
          new THREE.MeshStandardMaterial({
            color: 0xff5a3c, emissive: 0xff8a3c, emissiveIntensity: 1.2,
            transparent: true, opacity: 1,
          }),
        );
        fire.position.copy(position);
        const dir = new THREE.Vector3(
          Math.random() - 0.5, Math.random() * 0.7 + 0.3, Math.random() - 0.5,
        ).normalize().multiplyScalar(10 + Math.random() * 8);
        this.scene.add(fire);
        this._explosionParticles.push({
          mesh: fire, velocity: dir,
          angularVelocity: new THREE.Vector3(3, 3, 3),
          kind: 'debris', life: 1.0, maxLife: 1.0, gravity: 18,
        });
      }
    }

    // 3-4 secondary explosions, slightly delayed
    const secondaryCount = 3 + Math.floor(Math.random() * 2);
    for (let i = 0; i < secondaryCount; i++) {
      this._secondaryExplosions.push({
        position: new THREE.Vector3(
          position.x + (Math.random() - 0.5) * 2,
          position.y + (Math.random() - 0.5) * 1.2,
          position.z + (Math.random() - 0.5) * 2,
        ),
        delay: 0.10 + Math.random() * 0.20,
      });
    }

    // Schedule the actual game-over screen 4.5s later — gives the orbit
    // camera time to complete a full 360° revolution around the killer
    // before the UI takes over.
    setTimeout(() => {
      if (this.state === 'exploding') {
        this._cleanupExplosion();
        this._showGameOverScreen(this._pendingGameOverTitle || 'Game Over!');
      }
    }, 4500);
  }

  _addSecondaryExplosion(pos) {
    const flashMat = new THREE.MeshStandardMaterial({
      color: 0xffd23f, emissive: 0xffd23f, emissiveIntensity: 1.4,
      transparent: true, opacity: 1,
    });
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8), flashMat);
    flash.position.copy(pos);
    this.scene.add(flash);
    this._explosionParticles.push({ mesh: flash, kind: 'flash', life: 0.4, maxLife: 0.4 });

    for (let i = 0; i < 12; i++) {
      const isBox = Math.random() < 0.5;
      const geo = isBox
        ? new THREE.BoxGeometry(0.10, 0.10, 0.10)
        : new THREE.SphereGeometry(0.08, 6, 6);
      const color = [0xFF6600, 0xFFD700, 0xFF2200][Math.floor(Math.random() * 3)];
      const mat = new THREE.MeshStandardMaterial({
        color, transparent: true, opacity: 1, emissive: color, emissiveIntensity: 0.5,
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.copy(pos);
      const dir = new THREE.Vector3(
        Math.random() - 0.5, Math.random() * 0.6 + 0.2, Math.random() - 0.5,
      ).normalize().multiplyScalar(6 + Math.random() * 8);
      this.scene.add(m);
      this._explosionParticles.push({
        mesh: m, velocity: dir,
        angularVelocity: new THREE.Vector3(5, 5, 5),
        kind: 'debris', life: 0.9, maxLife: 0.9, gravity: 26,
      });
    }
  }

  _updateExplosionState(delta) {
    this._explosionElapsed += delta;

    // Pop secondary explosions when their delay elapses
    if (this._secondaryExplosions) {
      for (let i = this._secondaryExplosions.length - 1; i >= 0; i--) {
        this._secondaryExplosions[i].delay -= delta;
        if (this._secondaryExplosions[i].delay <= 0) {
          this._addSecondaryExplosion(this._secondaryExplosions[i].position);
          this._secondaryExplosions.splice(i, 1);
        }
      }
    }

    // Particle update + cleanup
    if (this._explosionParticles) {
      for (let i = this._explosionParticles.length - 1; i >= 0; i--) {
        const p = this._explosionParticles[i];
        p.life -= delta;
        if (p.life <= 0) {
          this.scene.remove(p.mesh);
          if (p.mesh.geometry) p.mesh.geometry.dispose();
          if (p.mesh.material) p.mesh.material.dispose();
          this._explosionParticles.splice(i, 1);
          continue;
        }

        if (p.kind === 'debris' || p.kind === 'fabric' || p.kind === 'spark') {
          p.velocity.y -= (p.gravity || 30) * delta;
          p.mesh.position.x += p.velocity.x * delta;
          p.mesh.position.y += p.velocity.y * delta;
          p.mesh.position.z += p.velocity.z * delta;
          if (p.mesh.position.y < 0.05) {
            p.mesh.position.y = 0.05;
            p.velocity.y *= -0.3;
            p.velocity.x *= 0.65;
            p.velocity.z *= 0.65;
          }
          if (p.angularVelocity) {
            p.mesh.rotation.x += p.angularVelocity.x * delta;
            p.mesh.rotation.y += p.angularVelocity.y * delta;
            p.mesh.rotation.z += p.angularVelocity.z * delta;
          }
          const t = Math.max(0, p.life / p.maxLife);
          if (p.mesh.material) p.mesh.material.opacity = t;
        } else if (p.kind === 'flash') {
          const tn = 1 - (p.life / p.maxLife);
          // Scale 0 → 3 in the first 20%, then shrink and fade
          const scale = tn < 0.2 ? (tn / 0.2) * 3 : 3 * (1 - (tn - 0.2) / 0.8);
          p.mesh.scale.setScalar(Math.max(0.01, scale));
          if (p.mesh.material) p.mesh.material.opacity = Math.max(0, 1 - tn);
        } else if (p.kind === 'shockwave') {
          const tn = 1 - (p.life / p.maxLife);
          p.mesh.scale.setScalar(1 + tn * 7);
          if (p.mesh.material) p.mesh.material.opacity = Math.max(0, 0.85 * (1 - tn));
        }
      }
    }

    // World decelerates very fast (0.15s) so the killer object stays in
    // frame instead of scrolling past the dead player.
    this._explosionDecel += delta;
    const slowFactor = Math.max(0, 1 - this._explosionDecel / 0.15);
    const moveZ = this.speed * delta * slowFactor;
    if (moveZ > 0) this._moveWorld(moveZ);

    // Death cam — hovers around the killer object at a constant radius and
    // height, slowly orbiting 360°. The camera is continuously chased
    // toward a moving "orbit point" so the entry from the chase position
    // is smooth (no two-phase logic needed) and the steady state is a
    // clean circular hover.
    this._deathCamElapsed = (this._deathCamElapsed || 0) + delta;
    if (this._crashPos && this._killer) {
      const ORBIT_RADIUS = 8;            // m, constant hover distance
      const ORBIT_HEIGHT = 4;            // m above the killer's base
      const ORBIT_SPEED  = 1.5;          // rad/s → full revolution in ~4.2 s
      const angle = this._deathCamElapsed * ORBIT_SPEED;
      const orbitTarget = new THREE.Vector3(
        this._killer.pos.x + Math.cos(angle) * ORBIT_RADIUS,
        this._killer.pos.y + ORBIT_HEIGHT,
        this._killer.pos.z + Math.sin(angle) * ORBIT_RADIUS,
      );
      // Smooth lerp from current camera pose into the orbit. 5/s converges
      // to the orbit point in ~0.4 s, after which the camera tracks the
      // moving orbit point exactly.
      this.camera.position.lerp(orbitTarget, Math.min(1, 5 * delta));
      // Always look at the killer with a small upward bias so the camera
      // gently tilts down on tall props (lamps) and up on flat ones (rocks).
      this.camera.lookAt(
        this._killer.pos.x,
        this._killer.pos.y + 1.2,
        this._killer.pos.z,
      );

      // Keep a subtle shake layered on top for the first 0.5 s
      if (this.shakeTimer > 0) {
        this.shakeTimer -= delta;
        const k = Math.max(0, this.shakeTimer / 0.8);
        const m = this.shakeMagnitude * k * 0.6;
        this.camera.position.x += (Math.random() - 0.5) * m * 2;
        this.camera.position.y += (Math.random() - 0.5) * m * 2;
        this.camera.position.z += (Math.random() - 0.5) * m;
      }
    }
  }

  _cleanupExplosion() {
    if (this._explosionParticles) {
      for (const p of this._explosionParticles) {
        this.scene.remove(p.mesh);
        if (p.mesh.geometry) p.mesh.geometry.dispose();
        if (p.mesh.material) p.mesh.material.dispose();
      }
    }
    this._explosionParticles = [];
    this._secondaryExplosions = [];
  }

  _showGameOverScreen(title) {
    this.state = 'gameover';
    // Death cam over — UI takes over. Stop the bg track that's been
    // ducked at 0.5 throughout the orbit; next round picks fresh.
    this._stopBgMusic();
    if (this.rabbit) { this.rabbit.dispose(); this.rabbit = null; }
    if (this.startingLine) { this.scene.remove(this.startingLine); this.startingLine = null; }
    this._clearSkyObjects();
    if (this.airTimeEl) this.airTimeEl.classList.remove('active');
    if (this.speedLinesEl) this.speedLinesEl.classList.remove('active');
    this.hud.style.display = 'none';
    if (this.progressEl) this.progressEl.style.display = 'none';
    const titleEl = document.getElementById('game-over-title');
    if (titleEl) titleEl.textContent = title || 'Game Over!';
    document.getElementById('final-score').textContent =
      `Distance: ${Math.floor(this.distance)}m  |  Coins: ${this.coins}`;
    this.gameOverScreen.style.display = 'flex';
    // Sprint Run only: offer a CONTINUE if the player hasn't used theirs.
    if (this.gameMode !== 'jana_bunny' && !this._continueUsed) {
      this._showContinueOption();
    } else {
      this._hideContinueOption();
    }
  }

  // Sprint Run continue — shows the CONTINUE button + counts down 10s
  // on its label. After 10s (or after PLAY AGAIN / MAIN MENU click)
  // the option goes away. Only one continue is granted per session.
  _showContinueOption() {
    const btn = document.getElementById('continue-btn');
    if (!btn) return;
    btn.style.display = 'inline-block';
    btn.disabled = false;
    this._continueRemainingSec = 10;
    btn.textContent = `CONTINUE (${this._continueRemainingSec})`;
    if (this._continueTimer) clearInterval(this._continueTimer);
    this._continueTimer = setInterval(() => {
      this._continueRemainingSec--;
      if (this._continueRemainingSec <= 0) {
        this._hideContinueOption();
        return;
      }
      btn.textContent = `CONTINUE (${this._continueRemainingSec})`;
    }, 1000);
  }

  _hideContinueOption() {
    const btn = document.getElementById('continue-btn');
    if (btn) btn.style.display = 'none';
    if (this._continueTimer) {
      clearInterval(this._continueTimer);
      this._continueTimer = null;
    }
  }

  // Resume play from the death spot. Snaps the player back to the
  // centre lane on the ground, pushes distance ahead by ~10m to clear
  // the obstacle that just killed them, grants 1.5s invincibility.
  // Marks the continue consumed so subsequent deaths go straight to
  // permanent game over.
  _continuePlay() {
    if (this._continueUsed) return;
    if (this.gameMode === 'jana_bunny') return;   // Sprint Run only
    this._continueUsed = true;
    this._hideContinueOption();
    this.gameOverScreen.style.display = 'none';
    // Restore the player mesh + state.
    if (this.player) {
      this.player.visible = true;
      this.player.position.set(0, 0, 0);
      this.player.rotation.set(0, 0, 0);
    }
    this.playerX = 0;
    this.playerY = 0;
    this._playerXMomentum = 0;
    this._smoothPlayerX = 0;
    this._smoothPlayerY = 0;
    this.isJumping = false;
    this.isDucking = false;
    this.airborneFromRamp = false;
    this._cleanupExplosion();
    if (this.deathFlag) {
      this.scene.remove(this.deathFlag);
      this.deathFlag = null;
    }
    // Push past the killer obstacle so the spawn isn't a re-death.
    this.distance += 10;
    // 1.5s invincibility window (see _die check) just in case.
    this._invincibleUntil = performance.now() + 1500;
    // Restore HUD + progress bar.
    this.hud.style.display = 'block';
    if (this.progressEl) this.progressEl.style.display = 'block';
    // Resume gameplay.
    this.state = 'playing';
    this.clock.start();
    this._playBgMusic();
  }

  _spawnPlaceholderCoin(z) {
    // Project-wide rule: never deploy a coin on a cross-street.
    const safeZ = this._clampToSafeZ(z, 4);
    if (safeZ == null) return;
    z = safeZ;
    const lane = Math.floor(Math.random() * 3) - 1;
    const x = lane * GAME_CONFIG.LANE_WIDTH;

    const geo = new THREE.CylinderGeometry(0.3, 0.3, 0.08, 16);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffd700,
      emissive: 0xffa500,
      emissiveIntensity: 0.3,
      metalness: 0.8,
      roughness: 0.2,
    });
    const coin = new THREE.Mesh(geo, mat);
    coin.position.set(x, 1.2, z);
    coin.rotation.x = Math.PI / 2;
    coin.userData.type = 'coin';
    coin.userData.lane = lane + 1;
    coin.userData.collected = false;

    this.scene.add(coin);
    this.collectibles.push(coin);
  }

  // ─────────────────────────────────────
  // Game State Management
  // ─────────────────────────────────────

  start() {
    // Fresh session — continue is available again.
    this._continueUsed = false;
    this._invincibleUntil = 0;
    this._hideContinueOption();
    this.startScreen.style.opacity = '0';
    setTimeout(() => { this.startScreen.style.display = 'none'; }, 500);
    this.hud.style.display = 'block';
    if (this.progressEl) this.progressEl.style.display = 'block';
    // Cut anything still ringing from a previous round (death_cam tail,
    // pending drone alert, etc.) so game_start plays clean.
    if (this.sounds) this.sounds.stopAllSources();
    if (this.gameMode === 'jana_bunny') {
      // Race mode: hold the world frozen and run a 3-2-1-GO countdown.
      // Player + rabbit are visible at the start line during the count.
      this._beginRaceCountdown();
    } else {
      // Sprint Run: straight into play, unchanged behaviour.
      this.state = 'playing';
      this.startTime = performance.now();
      this.clock.start();
      this._playBgMusic();
      this.sounds.play('game_start');
    }
  }

  // ── Jana Bunny: 3-2-1-GO race countdown ─────────────────────────────
  // World stays frozen (state='countdown' → main loop skips _update).
  // Each second fires countdown_tick; the GO! frame fires countdown_go,
  // unlocks the world (state='playing'), starts music, and emits the
  // standard game_start bark.
  _beginRaceCountdown() {
    this.state = 'countdown';
    this.startTime = performance.now();
    this._countdownStartMs = performance.now();
    this._postCountdownTransitionT = 0;     // no blend during countdown itself
    // Always tear down any leftover rabbit from the previous round
    // (e.g. a win-ended round didn't dispose, or restart fired in an
    // edge case) and spawn a fresh one at the start line. Fresh rabbit
    // = distance:0, lane:-1, _dead:false, mesh at Z=0 right beside the
    // player so both racers visibly start at the same line.
    if (this.rabbit) { this.rabbit.dispose(); this.rabbit = null; }
    if (this.startingLine) { this.scene.remove(this.startingLine); this.startingLine = null; }
    this.rabbit = new Rabbit().init(this.scene, {
      lane: -1,
      laneWidth: GAME_CONFIG.LANE_WIDTH,
    });
    // Visible starting-line mesh on the floor at Z=0. Scrolls back
    // with the world after GO; auto-disposed when far behind camera.
    this._addStartingLine();
    // Don't .start() the clock yet — _loop reads delta from this.clock.
    // We DO start it on GO so the first playing-frame's delta is sane.
    const overlay = document.getElementById('countdown-overlay');
    if (!overlay) {
      // No overlay element — fall back to immediate play.
      this._raceGo();
      return;
    }
    overlay.classList.add('show');
    const showStep = (text, isGo) => {
      overlay.innerHTML = '';
      const div = document.createElement('div');
      div.className = 'num' + (isGo ? ' go' : '');
      div.textContent = text;
      overlay.appendChild(div);
    };
    // Sequence: t=0 → 3, t=1s → 2, t=2s → 1, t=3s → GO + start.
    showStep('3', false);
    if (this.sounds) this.sounds.play('countdown_tick');
    this._countdownTimers = [
      setTimeout(() => { showStep('2', false); if (this.sounds) this.sounds.play('countdown_tick'); }, 1000),
      setTimeout(() => { showStep('1', false); if (this.sounds) this.sounds.play('countdown_tick'); }, 2000),
      setTimeout(() => { showStep('GO!', true); this._raceGo(); }, 3000),
      setTimeout(() => { overlay.classList.remove('show'); overlay.innerHTML = ''; }, 3700),
    ];
  }

  // Big white-painted strip across all 3 lanes at world Z=0 — visible
  // marker that the player + rabbit are at the start line. Scrolls
  // backward with the world once the race begins; disposed when it
  // drifts too far behind the camera.
  _addStartingLine() {
    if (this.startingLine) {
      this.scene.remove(this.startingLine);
      this.startingLine = null;
    }
    const group = new THREE.Group();
    const mainGeo = new THREE.PlaneGeometry(18, 1.0);
    const mainMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const main = new THREE.Mesh(mainGeo, mainMat);
    main.rotation.x = -Math.PI / 2;
    main.position.y = 0.04;
    group.add(main);
    // Black-and-white checker tiles flanking the strip — racing flag motif.
    const tileGeo = new THREE.PlaneGeometry(0.55, 0.55);
    const blackMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
    const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (let i = -8; i <= 8; i++) {
      const isBlack = (i % 2) === 0;
      const tileF = new THREE.Mesh(tileGeo, isBlack ? blackMat : whiteMat);
      tileF.rotation.x = -Math.PI / 2;
      tileF.position.set(i * 0.55, 0.045, 0.85);
      group.add(tileF);
      const tileB = new THREE.Mesh(tileGeo, isBlack ? whiteMat : blackMat);
      tileB.rotation.x = -Math.PI / 2;
      tileB.position.set(i * 0.55, 0.045, -0.85);
      group.add(tileB);
    }
    group.position.set(0, 0, 0);
    this.scene.add(group);
    this.startingLine = group;
  }

  // Per-frame scroll for the starting-line mesh. Decays with the world
  // and self-disposes when it leaves the camera frustum.
  _updateStartingLine(moveZ) {
    if (!this.startingLine) return;
    this.startingLine.position.z -= moveZ;
    if (this.startingLine.position.z < -25) {
      this.scene.remove(this.startingLine);
      this.startingLine = null;
    }
  }

  _raceGo() {
    if (this.sounds) this.sounds.play('countdown_go');
    this.state = 'playing';
    // Trigger the orbit→follow camera blend when the race actually begins.
    this._postCountdownTransitionT = 0.7;
    this.clock.start();
    this._playBgMusic();
    this.sounds.play('game_start');
  }

  _cancelCountdown() {
    if (this._countdownTimers) {
      this._countdownTimers.forEach((t) => clearTimeout(t));
      this._countdownTimers = null;
    }
    const overlay = document.getElementById('countdown-overlay');
    if (overlay) { overlay.classList.remove('show'); overlay.innerHTML = ''; }
  }

  _playBgMusic() {
    if (!this.bgMusic) return;
    // Settings may have music disabled — honor it.
    if (this.settings && this.settings.musicEnabled === false) {
      this._musicShouldPlay = false;
      return;
    }
    // Pick one track from the pool at random for THIS round. The chosen
    // track keeps looping until the next round picks again.
    const pool = this.bgMusicPool && this.bgMusicPool.length
      ? this.bgMusicPool : [{ src: '/audio/game-music.mp3', gain: 1.0 }];
    const picked = pool[Math.floor(Math.random() * pool.length)];
    const src  = typeof picked === 'string' ? picked : picked.src;
    const gain = typeof picked === 'string' ? 1.0    : (picked.gain ?? 1.0);
    if (src !== this._currentMusicSrc) {
      this._currentMusicSrc = src;
      this.bgMusic.src = src;
    }
    this._currentMusicGain = gain;
    this._currentDuckFactor = 1.0;        // fresh round = fresh duck state
    this._setMusicVolume();
    // Rewind so each new round starts at the top of the track
    try { this.bgMusic.currentTime = 0; } catch (e) { /* not yet loaded */ }
    this._musicShouldPlay = true;
    const p = this.bgMusic.play();
    // Browsers return a Promise from play(); swallow the unhandled-rejection
    // that fires if the user hasn't gestured yet (we'll catch the next click).
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  _stopBgMusic() {
    if (!this.bgMusic) return;
    this._musicShouldPlay = false;
    this.bgMusic.pause();
    try { this.bgMusic.currentTime = 0; } catch (e) { /* ignore */ }
  }

  // Force the bg-music HTMLAudioElement to fully buffer + decode while
  // still on the loading screen, so the first play() (called from the
  // PLAY-button gesture) starts instantly on mobile instead of stalling
  // for the network/decode pipeline.
  _preloadBgMusic() {
    if (!this.bgMusic) return Promise.resolve();
    if (this.bgMusic.readyState >= 4) return Promise.resolve();   // HAVE_ENOUGH_DATA
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; cleanup(); resolve(); } };
      const cleanup = () => {
        this.bgMusic.removeEventListener('canplaythrough', finish);
        this.bgMusic.removeEventListener('canplay',        finish);
        this.bgMusic.removeEventListener('loadeddata',     finish);
        this.bgMusic.removeEventListener('error',          finish);
        clearTimeout(timer);
      };
      this.bgMusic.addEventListener('canplaythrough', finish, { once: true });
      this.bgMusic.addEventListener('canplay',        finish, { once: true });
      this.bgMusic.addEventListener('loadeddata',     finish, { once: true });
      this.bgMusic.addEventListener('error',          finish, { once: true });
      const timer = setTimeout(finish, 12000);
      try { this.bgMusic.load(); } catch (e) { finish(); }
    });
  }

  // Single source of truth for bgMusic.volume. Compounds:
  //   user-slider × per-track gain × current duck factor
  // and clamps to [0, 1]. All bgMusic volume writes funnel through here.
  _setMusicVolume() {
    if (!this.bgMusic) return;
    const userVol = (this.settings && typeof this.settings.musicVolume === 'number')
      ? this.settings.musicVolume : 0.35;
    const trackGain = this._currentMusicGain || 1.0;
    const duck = this._currentDuckFactor || 1.0;
    const v = userVol * trackGain * duck;
    this.bgMusic.volume = Math.max(0, Math.min(1, v));
  }

  // Temporarily lower the bg-music volume — called via the SoundLibrary
  // onDuck hook for events configured in EVENT_DUCK. Re-triggers extend
  // (don't stack) the dip duration.
  //   toFraction = 0..1 of the user's music volume (0 = silence)
  //   ms         = how long to hold the dip; restores after that
  _duckBgMusic(toFraction, ms) {
    if (!this.bgMusic || !this.settings.musicEnabled) return;
    this._currentDuckFactor = Math.max(0, Math.min(1, toFraction));
    this._setMusicVolume();
    if (this._duckRestoreTimer) clearTimeout(this._duckRestoreTimer);
    this._duckRestoreTimer = setTimeout(() => {
      if (this.bgMusic && this.settings.musicEnabled) {
        this._currentDuckFactor = 1.0;
        this._setMusicVolume();
      }
      this._duckRestoreTimer = null;
    }, Math.max(0, ms));
    // this.sounds.stop('yahoo');
    // this.sounds.stop('parachute');
  }

  // Return to the start screen (mode selector). Used by the MAIN MENU
  // button on both the game-over and win panels. Runs a full silent
  // reset (fresh seed, zeroed score/distance, world rebuilt, player
  // recentred, parachute energy refilled, etc.) so a subsequent PLAY
  // — possibly in a DIFFERENT mode — starts from a true clean slate.
  _returnToMainMenu() {
    // Wipe continue state — the next PLAY (any mode) starts a fresh
    // session.
    this._continueUsed = false;
    this._invincibleUntil = 0;
    this._hideContinueOption();
    this._cancelCountdown();
    if (this.sounds) this.sounds.stopAllSources();
    this._stopBgMusic();
    if (this.rabbit) { this.rabbit.dispose(); this.rabbit = null; }
    if (this.startingLine) { this.scene.remove(this.startingLine); this.startingLine = null; }
    // Full reset of round state (counters, player position, world spawns,
    // explosion debris, parachute, biome, etc.) — silent: true skips
    // the round-start coda so we don't kick off music/countdown.
    if (this.map) {
      this.restart({ newSeed: true, silent: true });
    }
    // Hide the round UI.
    if (this.gameOverScreen) this.gameOverScreen.style.display = 'none';
    const winScreen = document.getElementById('win-screen');
    if (winScreen) winScreen.style.display = 'none';
    if (this.hud) this.hud.style.display = 'none';
    if (this.progressEl) this.progressEl.style.display = 'none';
    if (this.airTimeEl) this.airTimeEl.classList.remove('active');
    if (this.speedLinesEl) this.speedLinesEl.classList.remove('active');
    // Show the start screen again.
    if (this.startScreen) {
      this.startScreen.style.display = 'flex';
      // Force reflow before re-fading in so the transition runs.
      void this.startScreen.offsetWidth;
      this.startScreen.style.opacity = '1';
    }
    this.state = 'ready';
  }

  restart(opts = {}) {
    // Fresh round resets the one-shot continue: PLAY AGAIN means a
    // new attempt and continues are per-attempt.
    this._continueUsed = false;
    this._invincibleUntil = 0;
    this._hideContinueOption();
    // Optionally roll a fresh seed (PLAY AGAIN). Replay button passes newSeed=false.
    if (opts.newSeed) {
      // Clear scenery first so the side-decor walk re-spawns through
      // the Kenney fast-path (procedural ones from earlier rounds,
      // built before the model preload finished, are gone).
      this._clearScenery();
      this.courseSeed = randomSeed();
      this._buildCourse();
      this._spawnSideDecor();          // re-spawn buildings/trees/etc.
      this._populateProgressMilestones();
    } else if (!this.map) {
      // Defensive: ensure a map exists if this is the first call
      this._clearScenery();
      this._buildCourse();
      this._spawnSideDecor();
      this._populateProgressMilestones();
    } else {
      // Same-seed replay: reset finish line + mountain blocks back to their
      // original Zs so they're ahead of the player again. Side decor
      // also has to be re-walked because we no longer recycle scenery —
      // items from the previous round are sitting at negative relative
      // Z (already passed). Clearing and re-walking puts the same seed's
      // scenery back at its original world-Z range.
      this._buildFinishLine(this.map.courseLength);
      this._buildMountainBlocks();
      this._clearScenery();
      this._spawnSideDecor();
    }
    this._clearConfetti();
    if (this.deathFlag) {
      this.scene.remove(this.deathFlag);
      this.deathFlag = null;
    }
    this._explosionDecel = 0;
    this._crashPos = null;
    this._killer = null;
    this._deathCamElapsed = 0;
    if (this.winScreenEl) this.winScreenEl.style.display = 'none';
    this.startTime = performance.now();
    // Reset state
    this.speed = GAME_CONFIG.INITIAL_SPEED;
    this.distance = 0;
    this.score = 0;
    this.coins = 0;
    this.playerX = 0;
    this._playerXVelocity = 0;
    this._playerXMomentum = 0;
    this._wasDragging = false;
    this.isJumping = false;
    this.isDucking = false;
    this.canDoubleJump = false;
    this._cameraAirLerp = 0;
    this._cameraHoldTimer = 0;
    this._cameraXShift = 0;
    this._smoothPlayerX = 0;
    this._smoothPlayerY = 0;
    this._parachuteArmed = false;
    this.parachuteOpen = false;
    this.parachuteTimer = 0;
    this.parachuteScale = 0;
    this.parachuteEnergy = GAME_CONFIG.PARACHUTE_MAX_ENERGY;
    if (this.chuteEnergyEl) {
      this.chuteEnergyEl.classList.remove('draining', 'recharging', 'warning', 'empty', 'empty-flash');
    }
    if (this.player && this.player.userData.parachute) {
      this.player.userData.parachute.visible = false;
      this.player.userData.parachute.scale.setScalar(0);
    }
    this.airborneFromRamp = false;
    this.airTime = 0;
    this.airPeakHeight = 0;
    this.lastRampHitId = null;
    this.boostTimer = 0;
    this.shakeTimer = 0;
    this.nextSpeedUpAt = GAME_CONFIG.SPEED_UP_INTERVAL;
    if (this.airTimeEl) this.airTimeEl.classList.remove('active');
    if (this.speedLinesEl) this.speedLinesEl.classList.remove('active');
    if (this.speedUpFlashEl) this.speedUpFlashEl.classList.remove('show');
    // Snap back to snow biome
    // Snap colors instantly (no fade on restart)
    this.previousBiome = 'snow';
    this.biomeProgress = 1;
    this._setBiome('snow', { immediate: true });
    if (this.biomeBannerEl) this.biomeBannerEl.classList.remove('show');

    // Reset player position — snap to the front line (X=0, Y=0, Z=0)
    // with no transition / momentum so the round always begins with
    // the penguin parked dead-centre on the start line.
    this.player.position.set(0, 0.0, 0);
    this.player.rotation.set(0, 0, 0);
    this.player.visible = true;
    this.playerY = 0;
    this._cleanupExplosion();
    // Snap-reset the progress-bar markers (CSS has a 0.15s transition
    // that would otherwise animate them down from their old position).
    // Setting transition:none, writing 0%, forcing a reflow, then
    // restoring the transition gives an instant reset.
    const snapMarker = (el) => {
      if (!el) return;
      const t = el.style.transition;
      el.style.transition = 'none';
      el.style.bottom = '0%';
      void el.offsetHeight;     // force layout flush
      el.style.transition = t;  // restore CSS-defined transition
    };
    snapMarker(this.progressMarkerEl);
    snapMarker(this.progressRabbitMarkerEl);
    if (this.progressFillEl) {
      const t = this.progressFillEl.style.transition;
      this.progressFillEl.style.transition = 'none';
      this.progressFillEl.style.transform = 'scaleY(0)';
      void this.progressFillEl.offsetHeight;
      this.progressFillEl.style.transition = t;
    }

    // Clear and respawn coins, ramps, and cross-streets
    this.obstacles.forEach(o => this.scene.remove(o));
    this.collectibles.forEach(c => this.scene.remove(c));
    this.ramps.forEach(r => this.scene.remove(r));
    this.obstacles = [];
    this.collectibles = [];
    this.ramps = [];
    this._clearCrossStreets();
    this._clearSkyObjects();
    this._resetSnowTrail();

    let cz = 35;
    while (cz < 320) {
      this._spawnCrossStreet(cz);
      cz += 40 + Math.random() * 20;
    }
    for (let z = 60; z < 320; z += 80 + Math.random() * 40) {
      if (this._zHasCrossStreet(z, 8)) continue;
      this._spawnRamp(z);
    }
    let _oz = 28;
    while (_oz < 240) {
      this._spawnLaneObstacle(_oz);
      _oz += 18 + Math.random() * 14;
    }
    for (let z = 20; z < 200; z += 5) {
      if (this._zHasCrossStreet(z, 4)) continue;
      if (Math.random() > 0.5) this._spawnPlaceholderCoin(z);
    }

    // UI
    this.gameOverScreen.style.display = 'none';
    // Caller (MAIN MENU) can pass silent:true to do a full state reset
    // without starting the new round (no HUD reveal, no music, no
    // countdown, no game_start bark). Used to bring the player cleanly
    // back to the start screen.
    if (opts.silent) return;
    this.hud.style.display = 'block';
    if (this.progressEl) this.progressEl.style.display = 'block';
    // Cut anything still ringing from the previous round (death_cam tail,
    // pending drone alert, etc.) so game_start plays clean.
    if (this.sounds) this.sounds.stopAllSources();
    if (this.gameMode === 'jana_bunny') {
      // Race-mode restart: re-run the 3-2-1-GO countdown.
      this._beginRaceCountdown();
    } else {
      this.state = 'playing';
      this.clock.start();
      this._playBgMusic();
      // Fire game_start every restart too — picks one clip at random from
      // the pool just like the initial PLAY does.
      this.sounds.play('game_start');
    }
  }

  gameOver(title) {
    this.state = 'gameover';
    this._cancelCountdown();
    if (this.rabbit) { this.rabbit.dispose(); this.rabbit = null; }
    if (this.startingLine) { this.scene.remove(this.startingLine); this.startingLine = null; }
    this._clearSkyObjects();
    if (this.airTimeEl) this.airTimeEl.classList.remove('active');
    if (this.speedLinesEl) this.speedLinesEl.classList.remove('active');
    this.hud.style.display = 'none';
    if (this.progressEl) this.progressEl.style.display = 'none';
    const titleEl = document.getElementById('game-over-title');
    if (titleEl) titleEl.textContent = title || 'Game Over!';
    document.getElementById('final-score').textContent =
      `Distance: ${Math.floor(this.distance)}m  |  Coins: ${this.coins}`;
    this.gameOverScreen.style.display = 'flex';
  }

  // ─────────────────────────────────────
  // Input Handling
  // ─────────────────────────────────────

  _handleSwipe(direction) {
    if (this.state !== 'playing') return;
    // Debug rabbit-cam: ignore all jumps/ducks so the player just
    // coasts forward and we can study the rabbit's AI cleanly.
    if (this._debugRabbitCam) return;

    // Horizontal motion is now continuous; only up/down still come through here.
    switch (direction) {
      case 'up':
        if (!this.isJumping && !this.airborneFromRamp) {
          // Ground jump — free.
          this.isJumping = true;
          this.jumpVelocity = GAME_CONFIG.JUMP_FORCE;
          this.canDoubleJump = true;
          this.sounds.play('jump');
        } else if (this.parachuteEnergy >= GAME_CONFIG.MULTI_JUMP_COST) {
          // Multi-jump in air — UNLIMITED as long as energy lasts. Each
          // press costs MULTI_JUMP_COST. Holding the press also arms the
          // parachute, which opens on the next frame if jumpHeld stays
          // true and shares the same energy pool while gliding.
          this.parachuteEnergy -= GAME_CONFIG.MULTI_JUMP_COST;
          this.jumpVelocity = Math.max(this.jumpVelocity, GAME_CONFIG.DOUBLE_JUMP_FORCE);
          this._parachuteArmed = true;
          this.sounds.play('double_jump');
        } else {
          // Out of energy — flash the bar so the player sees why
          this._flashChuteEmpty();
        }
        break;
      case 'down':
        if (!this.isDucking) {
          this.isDucking = true;
          setTimeout(() => { this.isDucking = false; }, 500);
        }
        break;
    }
  }

  _openParachute() {
    if (this.parachuteOpen) return;
    if (this.parachuteEnergy <= 0) {
      // No energy → chute can't open. Flash the bar to show why.
      this._flashChuteEmpty();
      return;
    }
    this.parachuteOpen = true;
    this.parachuteTimer = 0;
    this.sounds.play('parachute');
  }

  _closeParachute() {
    if (!this.parachuteOpen) return;
    this.parachuteOpen = false;
    this.parachuteTimer = 0;
    // this.sounds.stop('parachute');
  }

  _flashChuteEmpty() {
    if (!this.chuteEnergyEl) return;
    this.chuteEnergyEl.classList.remove('empty-flash');
    void this.chuteEnergyEl.offsetWidth;   // restart the animation
    this.chuteEnergyEl.classList.add('empty-flash');
    setTimeout(() => {
      if (this.chuteEnergyEl) this.chuteEnergyEl.classList.remove('empty-flash');
    }, 900);
  }

  // ─────────────────────────────────────
  // Main Game Loop
  // ─────────────────────────────────────

  _loop() {
    requestAnimationFrame(() => this._loop());

    const delta = this.clock.getDelta();

    if (this.state === 'playing') {
      this._update(delta);
    } else if (this.state === 'exploding') {
      this._updateExplosionState(delta);
    } else if (this.state === 'won') {
      this._updateWonState(delta);
    }

    // Spin coins always (even in menu)
    this.collectibles.forEach(c => {
      if (!c.userData.collected) {
        c.rotation.z += delta * 3;
      }
    });

    // Jana Bunny rabbit: tick every frame with the live game env
    // so the AI can plan hops, swerve, scoop coins, and apply
    // collision penalties. Frozen during 'countdown' state.
    if (this.gameMode === 'jana_bunny' && this.rabbit && this.state === 'playing') {
	      // In debug rabbit-cam mode: the player is frozen (speed=0) but
	      // the rabbit keeps racing at its own fixed pace through the
	      // static world.
	      const rabbitPlayerSpeed = JANA_BUNNY.RABBIT_SPEED;
	      const rabbitThreats = buildRabbitThreats({
	        playerDistance: this.distance,
	        laneWidth: GAME_CONFIG.LANE_WIDTH,
	        obstacles: this.obstacles,
	        scenery: this.scenery,
	        buildings: this.mountainBlocks,
	        crossStreets: this.crossStreets,
	        ramps: this.ramps,
	        drones: this.drones,
	        observerDistance: this.rabbit.distance,
	        observerSpeed: JANA_BUNNY.RABBIT_SPEED,
	      }, this.rabbit.distance);
	      this.rabbit.update(delta, {
	        playerDistance: this.distance,
	        playerSpeed:    rabbitPlayerSpeed,
        playerX:        this.player ? this.player.position.x : 0,
        playerY:        this.playerY || 0,
        obstacles:      this.obstacles,
        scenery:        this.scenery,           // trees, lamps, signs, cabins (collidable subset)
        buildings:      this.mountainBlocks,    // mid-rises with tunnel arches
        crossStreets:   this.crossStreets,      // perpendicular streets w/ moving cars
        ramps:          this.ramps,             // jump ramps (centre-lane wedges)
	        drones:         this.drones,            // hovering aerial hazards
	        collectibles:   this.collectibles,
	        threats:        rabbitThreats,
	        courseLength:   this.map ? this.map.courseLength : 0,
        laneWidth:      GAME_CONFIG.LANE_WIDTH,
        ignorePlayerThreat: !!this._debugRabbitCam,
        // FATAL collision callback: when the rabbit's body would
        // overlap an obstacle (its AI failed), the rabbit "loses"
        // and the PLAYER WINS. Mirrors the player's own collision
        // → death contract.
        onRabbitCollide: (kind) => this._onRabbitCollision(kind),
      });
      // Player-vs-rabbit kill check: if the player runs into the rabbit
      // (same Z band, lateral overlap, both at ground/low Y), the
      // player loses. The rabbit's own hard physics keeps it from
      // entering the player, so collisions fire only when the PLAYER
      // catches up and rams the rabbit.
      if (!this._debugRabbitCam) this._checkRabbitKill();
    }

    this._updateMobileJumpButton();

    // Starting-line scroll: scrolls back with the world during play.
    // Frozen during countdown (no scroll yet) and skipped if no line.
    if (this.startingLine && this.state === 'playing') {
      const moveZ = this.speed * delta;
      this._updateStartingLine(moveZ);
    }

    // Jana Bunny COUNTDOWN orbit cam: while state === 'countdown'
    // (3-2-1-GO window), the camera circles slowly around the start
    // line so the viewer sees both racers waiting at the same line.
    if (this.gameMode === 'jana_bunny' && this.state === 'countdown') {
      const tSec = (performance.now() - (this._countdownStartMs || 0)) / 1000;
      const angle = -Math.PI * 0.6 - tSec * 0.55; // slow orbit, starts behind, rotates the OPPOSITE way
      const radius = 11;
      const height = 4.5;
      // Centre between player (lane 0, X=0) and rabbit (lane -1, X=-3)
      const centreX = -1.5;
      const centreZ = 0;
      const ox = centreX + Math.sin(angle) * radius;
      const oz = centreZ + Math.cos(angle) * radius;
      this.camera.position.set(ox, height, oz);
      this.camera.lookAt(centreX, 1.2, centreZ);
      // Cache the last orbit pose for the post-GO blend.
      if (!this._lastOrbitPos)  this._lastOrbitPos  = new THREE.Vector3();
      if (!this._lastOrbitLook) this._lastOrbitLook = new THREE.Vector3();
      this._lastOrbitPos.copy(this.camera.position);
      this._lastOrbitLook.set(centreX, 1.2, centreZ);
    }

    // Post-countdown camera blend: at GO (state→'playing'), smoothly
    // lerp from the last orbit pose to the standard player chase-cam
    // pose over _postCountdownTransitionT seconds.
    if (this._postCountdownTransitionT > 0
        && this.state === 'playing'
        && this._lastOrbitPos && this._stdCamPos) {
      const total = 0.7;
      this._postCountdownTransitionT = Math.max(0, this._postCountdownTransitionT - delta);
      const tRaw = 1 - (this._postCountdownTransitionT / total);
      const t = Math.max(0, Math.min(1, tRaw));
      const ts = t * t * (3 - 2 * t);
      const blendPos  = new THREE.Vector3().lerpVectors(this._lastOrbitPos,  this._stdCamPos,  ts);
      const blendLook = new THREE.Vector3().lerpVectors(this._lastOrbitLook, this._stdCamLook, ts);
      this.camera.position.copy(blendPos);
      this.camera.lookAt(blendLook);
    }

    // Debug rabbit-cam: lock the camera onto the rabbit + hide the
    // penguin mesh, regardless of game state. Runs after every other
    // camera write so the override always wins. When the flag flips
    // off, restore default visibility next frame.
    if (this._debugRabbitCam && this.rabbit && this.rabbit.group) {
      const r = this.rabbit.group.position;
      this.camera.position.set(r.x, r.y + 8, r.z - 12);
      this.camera.lookAt(r.x, r.y + 2, r.z + 20);
      if (this.player) this.player.visible = false;
    } else if (this.player && !this.player.visible && this.state === 'playing') {
      // Only restore visibility during normal gameplay. During
      // 'exploding' / 'gameover' / 'won' the player is INTENTIONALLY
      // hidden by _explode() / win logic — leave it alone. Without
      // this state guard, the death cam would re-show the penguin
      // mid-explosion (Sprint Run accidentally worked because the
      // override didn't run during 'exploding' until the rabbit-cam
      // code was hoisted into _loop).
      this.player.visible = true;
    }

    this.renderer.render(this.scene, this.camera);
  }

  _update(delta) {
    // Increase speed over time
    this.speed = Math.min(
      GAME_CONFIG.MAX_SPEED,
      this.speed + GAME_CONFIG.SPEED_INCREASE * delta
    );
    // Debug rabbit-cam: ghost the player and let the world stream at
    // bunny pace, so chunks/finish line keep generating around the AI.
    if (this._debugRabbitCam) this.speed = JANA_BUNNY.RABBIT_SPEED;

    // Apply post-ramp speed boost (multiplier on top of base speed)
    let effectiveSpeed = this.speed;
    if (this.boostTimer > 0) {
      this.boostTimer -= delta;
      // Ease the multiplier down over the boost window
      const t = Math.max(0, this.boostTimer / GAME_CONFIG.RAMP_BOOST_DURATION);
      const mult = 1 + (GAME_CONFIG.RAMP_BOOST_MULT - 1) * t;
      effectiveSpeed = this.speed * mult;
      if (this.boostTimer <= 0 && this.speedLinesEl) {
        this.speedLinesEl.classList.remove('active');
      }
    }
    // Wind-in-the-chute forward boost while gliding
    if (this.parachuteOpen) {
      effectiveSpeed *= GAME_CONFIG.PARACHUTE_SPEED_MULT;
    }

    // Distance
    if (this._debugRabbitCam) effectiveSpeed = JANA_BUNNY.RABBIT_SPEED;
    const moveZ = effectiveSpeed * delta;
    this.distance += moveZ;

    // Staged speed-ups every SPEED_UP_INTERVAL meters
    if (this.distance >= this.nextSpeedUpAt) {
      this.speed = Math.min(GAME_CONFIG.MAX_SPEED, this.speed + GAME_CONFIG.SPEED_UP_AMOUNT);
      this.nextSpeedUpAt += GAME_CONFIG.SPEED_UP_INTERVAL;
      this._showSpeedUpFlash();
    }

    // Biome transitions
    this._updateBiome();

    // Continuous horizontal player movement.
    //   • Keyboard: holding L/R sets input.horizontalAxis to ±1 → constant slide.
    //   • Touch:   while a finger is dragging, map the live drag delta onto
    //     the player's X.
    const prevX = this.playerX;
    const dragging = this.input && this.input.isTouchDragging && this.input.isTouchDragging();
    if (dragging) {
      // Capture the player's X at the start of each touch-drag so subsequent
      // motion is relative to where the player was, not absolute.
      if (!this._wasDragging) this._touchDragOriginX = this.playerX;
      const target = this._touchDragOriginX
        + this.input.touchDeltaX * GAME_CONFIG.TOUCH_DRAG_SCALE;
      this.playerX += (target - this.playerX) * Math.min(1, 18 * delta);
      // Reset momentum during touch drag for direct control
      this._playerXMomentum = 0;
    } else {
      // Apply input as force to momentum (increased gain for responsiveness)
      // Debug rabbit-cam: ignore the horizontal axis so the player
      // doesn't drift laterally while we're watching the rabbit.
      if (this.input && this.input.horizontalAxis && !this._debugRabbitCam) {
        const inputForce = this.input.horizontalAxis * GAME_CONFIG.HORIZONTAL_SPEED * delta;
        this._playerXMomentum += inputForce;
      }

      // Apply friction/damping to momentum (reduced for better momentum retention)
      const friction = 0.94; // Less friction so momentum lasts longer
      this._playerXMomentum *= Math.pow(friction, delta * 60); // Frame-rate independent

      // Clamp momentum to reasonable limits (increased for stronger input)
      this._playerXMomentum = THREE.MathUtils.clamp(this._playerXMomentum, -GAME_CONFIG.MAX_MOMENTUM, GAME_CONFIG.MAX_MOMENTUM);

      // Apply momentum to position
      this.playerX += this._playerXMomentum * delta;
    }
    this._wasDragging = dragging;

    // Mountain splits widen the playable corridor to give two FULL routes —
    // one to the left of the mountain, one to the right. Lerp the X clamp
    // out to ±10 while inside the split footprint, snap back to ±6 outside.
    const splitNear = this._mountainSplitFactor();
    const xMin = THREE.MathUtils.lerp(GAME_CONFIG.PLAYER_X_MIN, -10, splitNear);
    const xMax = THREE.MathUtils.lerp(GAME_CONFIG.PLAYER_X_MAX,  10, splitNear);

    // Smoothly decelerate momentum when approaching the left/right bounds.
    const boundaryRange = 1.5;
    if (this._playerXMomentum > 0) {
      const distanceToRight = xMax - this.playerX;
      if (distanceToRight < boundaryRange) {
        const edgeFactor = THREE.MathUtils.smoothstep(distanceToRight, 0, boundaryRange);
        this._playerXMomentum *= edgeFactor;
      }
    } else if (this._playerXMomentum < 0) {
      const distanceToLeft = this.playerX - xMin;
      if (distanceToLeft < boundaryRange) {
        const edgeFactor = THREE.MathUtils.smoothstep(distanceToLeft, 0, boundaryRange);
        this._playerXMomentum *= edgeFactor;
      }
    }

    const clampedX = THREE.MathUtils.clamp(this.playerX, xMin, xMax);
    if (clampedX !== this.playerX) {
      if ((this._playerXMomentum > 0 && clampedX >= xMax) ||
          (this._playerXMomentum < 0 && clampedX <= xMin)) {
        this._playerXMomentum = 0;
      }
    }
    this.playerX = clampedX;
    this.player.position.x = this.playerX;
    this._playerXVelocity = (this.playerX - prevX) / Math.max(0.001, delta);

    // Tilt slightly in the direction of motion; lerp back to upright when idle.
    const targetTiltZ = THREE.MathUtils.clamp(
      this._playerXVelocity * 0.06, -0.32, 0.32,
    );
    this.player.rotation.z += (targetTiltZ - this.player.rotation.z) * 8 * delta;

    // Parachute open/close logic — must run BEFORE jump physics so the
    // current frame uses the correct gravity.
    if (this._parachuteArmed) {
      if (this.input && this.input.jumpHeld) this._openParachute();
      this._parachuteArmed = false;
    }
    const airborne = this.isJumping || this.airborneFromRamp || this.playerY > 0.05;

    if (this.parachuteOpen) {
      this.parachuteTimer += delta;
      // Drain energy
      this.parachuteEnergy -= GAME_CONFIG.PARACHUTE_DRAIN_RATE * delta;
      if (this.parachuteEnergy <= 0) {
        this.parachuteEnergy = 0;
        this._flashChuteEmpty();
        this._closeParachute();
      } else if (this.parachuteTimer >= GAME_CONFIG.PARACHUTE_DURATION
          || !(this.input && this.input.jumpHeld)
          || this.playerY <= 0.01) {
        this._closeParachute();
      }
    } else if (this.parachuteEnergy < GAME_CONFIG.PARACHUTE_MAX_ENERGY) {
      // Passive recharge — faster while airborne (with the chute closed),
      // slower but still ticking while on the ground so the player isn't
      // stuck waiting after a heavy multi-jump string.
      const rate = airborne
        ? GAME_CONFIG.PARACHUTE_RECHARGE_RATE
        : GAME_CONFIG.PARACHUTE_GROUND_RECHARGE_RATE;
      this.parachuteEnergy = Math.min(
        GAME_CONFIG.PARACHUTE_MAX_ENERGY,
        this.parachuteEnergy + rate * delta,
      );
    }

    // Jump physics — gravity is reduced while the parachute is open
    if (this.isJumping) {
      const g = this.parachuteOpen
        ? GAME_CONFIG.GRAVITY * GAME_CONFIG.PARACHUTE_GRAVITY_MULT
        : GAME_CONFIG.GRAVITY;
      this.jumpVelocity -= g * delta;
      this.playerY += this.jumpVelocity * delta;
      if (this.playerY <= 0) {
        this.playerY = 0;
        this.isJumping = false;
        this.canDoubleJump = false;
        this._closeParachute();
         this.sounds.play('landing');
         // this.sounds.stop('ramp');
         // this.sounds.stop('jump');
        if (this.airborneFromRamp) this._finishAirTime();
      }
    }
    this.player.position.y = this.playerY;

    // Parachute visual: pop-in / pop-out scale + gentle wobble
    {
      const target = this.parachuteOpen ? 1 : 0;
      const dt = this.parachuteOpen
        ? delta / GAME_CONFIG.PARACHUTE_OPEN_TIME
        : delta / GAME_CONFIG.PARACHUTE_CLOSE_TIME;
      this.parachuteScale += (target - this.parachuteScale) > 0
        ? Math.min(target - this.parachuteScale, dt)
        : Math.max(target - this.parachuteScale, -dt);
      const para = this.player.userData.parachute;
      if (para) {
        para.scale.setScalar(this.parachuteScale);
        para.visible = this.parachuteScale > 0.01;
        if (para.visible) {
          // Side-to-side wobble while gliding
          para.rotation.z = Math.sin(performance.now() * 0.004) * 0.14;
        }
      }
    }

    // Track air time + peak height while airborne from a ramp
    if (this.airborneFromRamp) {
      this.airTime += delta;
      if (this.playerY > this.airPeakHeight) this.airPeakHeight = this.playerY;

      // Drip in additional sky objects while still high in the air
      this._skySpawnCooldown -= delta;
      if (this._skySpawnCooldown <= 0 && this.playerY > 2.0) {
        const types = ['airplane', 'balloon', 'balloon', 'rocket'];
        const t = types[Math.floor(Math.random() * types.length)];
        this._spawnSkyObject(t);
        this._skySpawnCooldown = 0.4 + Math.random() * 0.5;
      }
      if (this.airTimerEl) this.airTimerEl.textContent = `${this.airTime.toFixed(2)}s`;
      if (this.airBonusEl) {
        const heightBonus = Math.floor(this.airPeakHeight * GAME_CONFIG.AIR_HEIGHT_BONUS);
        const timeBonus = Math.floor(this.airTime * GAME_CONFIG.AIR_BONUS_PER_SEC);
        const previewCoins = Math.max(1, Math.floor((heightBonus + timeBonus) / 10));
        this.airBonusEl.textContent = `+${previewCoins} 🪙  (${heightBonus + timeBonus} pts)`;
      }
      // Full 360° forward flip on the inner pivot.
      // Easing: rate(t) = 1 + 0.6*cos(2π t) — fast at start, slow at peak,
      // fast at landing. Integrates to t + 0.6*sin(2π t)/(2π).
      const inner = this.player.userData.inner;
      if (inner) {
        const t = Math.min(1, this.airTime / Math.max(0.001, this.flipDuration));
        const eased = t + 0.6 * Math.sin(2 * Math.PI * t) / (2 * Math.PI);
        inner.rotation.x = -2 * Math.PI * eased; // negative = forward flip
      }
    } else {
      // Lerp the inner pivot back to upright
      const inner = this.player.userData.inner;
      if (inner) inner.rotation.x += (0 - inner.rotation.x) * 10 * delta;
    }

    // Camera: zoom IN to a close-up during dramatic events — ramp launches,
    // any airborne jump, or anywhere inside the mountain-split corridor
    // (going left/right around the building or threading the arch). Smooth
    // zoom IN, snappy zoom OUT.
    const splitFactor = this._mountainSplitFactor();
    const closeTrigger =
         this.airborneFromRamp
      || this.isJumping
      || this.parachuteOpen
      || splitFactor > 0;
    if (closeTrigger) {
      this._cameraHoldTimer = 0.25;     // brief hold, then quick release
    } else if (this._cameraHoldTimer > 0) {
      this._cameraHoldTimer = Math.max(0, this._cameraHoldTimer - delta);
    }
    const wantAir = (closeTrigger || this._cameraHoldTimer > 0) ? 1 : 0;
    // Asymmetric lerp speeds — smooth fade IN (3/s) and quick fade OUT (10/s)
    const zoomLerpSpeed = wantAir > this._cameraAirLerp ? 3 : 10;
    this._cameraAirLerp += (wantAir - this._cameraAirLerp)
                         * Math.min(1, zoomLerpSpeed * delta);
    const tpOffset = new THREE.Vector3().lerpVectors(
      this.cameraGroundOffset, this.cameraAirOffset, this._cameraAirLerp,
    );
    const tpLook = new THREE.Vector3().lerpVectors(
      this.cameraGroundLook, this.cameraAirLook, this._cameraAirLerp,
    );
    // Settings: scale the 3rd-person offset by the user's distance slider
    // (0.5x..2x). 1st-person preset overrides when toggled on — eye sits
    // just in front of the player at head height, looking forward.
    const distMul = (this.settings && this.settings.cameraDistance) || 1.0;
    tpOffset.x *= distMul; tpOffset.y *= distMul; tpOffset.z *= distMul;
    const fpOffset = new THREE.Vector3(0, 1.25, 1.4);
    const fpLook   = new THREE.Vector3(0, 1.15, 18);
    const fpBlend  = (this.settings && this.settings.firstPerson) ? 1 : 0;
    const camOffset = new THREE.Vector3().lerpVectors(tpOffset, fpOffset, fpBlend);
    const camLook   = new THREE.Vector3().lerpVectors(tpLook,   fpLook,   fpBlend);
    // Hide the player mesh in first-person so it doesn't fill the screen.
    if (this.player) this.player.visible = fpBlend < 0.7;

    // Floating chase camera — smoothed lateral follow. The camera-tracked X
    // lerps toward the real playerX at 5/s, giving a gentle ~200 ms lag that
    // reads as a hand-held / drone-cam float. Both camera AND look-at use
    // the smoothed value so the player still ends up in frame.
    const followLerp = Math.min(1, 5 * delta);
    this._smoothPlayerX += (this.playerX - this._smoothPlayerX) * followLerp;
    camOffset.x += this._smoothPlayerX;
    camLook.x   += this._smoothPlayerX;
    // Around the high-rise the camera also leans an EXTRA bit in the same
    // direction (on top of the precise follow), to clearly read which side
    // the player took. This extra lean fades out once the corridor ends.
    const wantXShift = splitFactor > 0 ? this.playerX * 0.35 * splitFactor : 0;
    const xLerpSpeed = Math.abs(wantXShift) > Math.abs(this._cameraXShift) ? 4 : 9;
    this._cameraXShift += (wantXShift - this._cameraXShift)
                        * Math.min(1, xLerpSpeed * delta);
    if (Math.abs(this._cameraXShift) < 0.01) this._cameraXShift = 0;
    camOffset.x += this._cameraXShift;
    camLook.x   += this._cameraXShift * 0.65;

    // Vertical follow — same floaty smoothing as the lateral follow. Camera
    // rises with the player's jump arc and glides back down with a small
    // lag instead of snapping. Look-at trails at 85 % so the camera tilts
    // slightly downward as the player climbs, selling the aerial view.
    this._smoothPlayerY += (Math.max(0, this.playerY) - this._smoothPlayerY) * followLerp;
    const followY = this._smoothPlayerY;
    camOffset.y += followY;
    camLook.y   += followY * 0.85;
    camOffset.z -= followY * 0.25;

    // Subtle floaty bob — gentle sine waves so the camera reads as
    // hand-held / drone-cam rather than a perfectly rigid mount. Tiny
    // amplitude so it's felt, not noticed. Skipped in 1st-person where
    // it would induce motion sickness.
    if (fpBlend < 0.5) {
      const bobT = performance.now() * 0.001;
      camOffset.y += Math.sin(bobT * 1.4) * 0.08;
      camOffset.x += Math.cos(bobT * 1.1) * 0.05;
      camOffset.z += Math.sin(bobT * 0.7) * 0.04;
    }

    // Approaching a mountain split? Briefly raise the camera so the fork in
    // the path reads clearly.
    if (this.mountainBlocks) {
      let near = 0;
      for (const block of this.mountainBlocks) {
        if (block.userData.kind !== 'building') continue;
        const halfL = (block.userData.corridorLength || 80) / 2;
        const front = block.position.z - halfL; // world Z of corridor entry
        if (front > -2 && front < 35) {
          near = Math.max(near, THREE.MathUtils.clamp(1 - Math.abs(front - 12) / 22, 0, 1));
        }
      }
      if (near > 0) {
        camOffset.y += 3 * near;
        camLook.y  += 2 * near;
      }
    }

    let cx = camOffset.x, cy = camOffset.y, cz = camOffset.z;
    if (this.shakeTimer > 0) {
      this.shakeTimer -= delta;
      const k = Math.max(0, this.shakeTimer / 0.5);
      const m = this.shakeMagnitude * k;
      cx += (Math.random() - 0.5) * m * 2;
      cy += (Math.random() - 0.5) * m * 2;
      cz += (Math.random() - 0.5) * m;
    }
    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(camLook);
    // Snapshot the standard camera pose so _loop's countdown→follow
    // blend has a target to lerp toward (camera.lookAt's quaternion
    // result is hard to read back, so we store the lookAt VECTOR).
    if (!this._stdCamPos)  this._stdCamPos  = new THREE.Vector3();
    if (!this._stdCamLook) this._stdCamLook = new THREE.Vector3();
    this._stdCamPos.set(cx, cy, cz);
    this._stdCamLook.copy(camLook);

    // (Debug rabbit-cam override moved to _loop so it fires every
    // frame regardless of state.)

    // Duck
    if (this.isDucking) {
      this.player.scale.y = 0.5;
    } else {
      this.player.scale.y += (1 - this.player.scale.y) * 10 * delta;
    }

    // Move world toward player (player stays at z=0)
    this._moveWorld(moveZ);

    // Update active sky objects (parallax + per-type motion)
    this._updateSkyObjects(delta, moveZ);
    this._maintainSky(delta);

    // New flying-object systems
    this._updateClouds(delta, moveZ);
    this._updateRockets(delta);
    this._updateLowPassPlanes(delta);
    this._updateDrones(delta, moveZ);
    this._updateHazardScheduler(delta);

    // Cross-streets — scroll forward, move crossing traffic, recycle
    this._updateCrossStreets(delta, moveZ);

    // Snow / ice trail (emit + advect particles, scroll track marks)
    this._updateSnowTrail(delta, moveZ, effectiveSpeed);

    // Animate the chase pattern of ramp approach lights
    this._updateRampLights();

    // Course progress + finish-line crossing
    this._updateCourseProgress(delta);

    // Part the city/forest around any active mountain split
    this._pushScenerydForSplits();

    // Falling snow (snow biome ambient)
    this._updateSnowfall(delta);

    // Smooth biome transition (color crossfade over BIOME_TRANSITION_LEN units)
    this._tickBiomeTransition();

    // Collision detection. Rabbit debug-cam ghosts the hidden player so
    // the world can keep streaming around the bunny without ending the run.
    if (!this._debugRabbitCam) this._checkCollisions();

    // Respawn objects that went behind camera
    this._recycleObjects();

    // Update HUD
    this.scoreEl.textContent = Math.floor(this.distance);
    this.distanceEl.textContent = `${Math.floor(this.distance)}m`;
    this.coinsEl.textContent = `${this.coins}`;

    if (this.speedNumEl) this.speedNumEl.textContent = effectiveSpeed.toFixed(0);
    if (this.speedFillEl) {
      const pct = Math.min(100, (effectiveSpeed / GAME_CONFIG.MAX_SPEED) * 100);
      this.speedFillEl.style.width = `${pct}%`;
    }
    if (this.speedMeterEl) {
      this.speedMeterEl.classList.toggle('boost', this.boostTimer > 0);
    }

    // Parachute energy bar
    this._updateChuteHud();
  }

  _updateChuteHud() {
    const e = this.chuteEnergyEl;
    if (!e) return;
    const max = GAME_CONFIG.PARACHUTE_MAX_ENERGY;
    const pct = Math.max(0, Math.min(1, this.parachuteEnergy / max));
    if (this.chuteFillEl) {
      this.chuteFillEl.style.transform = `scaleX(${pct})`;
    }
    const airborne = this.isJumping || this.airborneFromRamp || this.playerY > 0.05;
    e.classList.toggle('draining', this.parachuteOpen);
    e.classList.toggle(
      'recharging',
      airborne && !this.parachuteOpen && this.parachuteEnergy < max,
    );
    e.classList.toggle('warning', this.parachuteEnergy < 25);
    e.classList.toggle('empty', this.parachuteEnergy <= 0);
  }

  _moveWorld(moveZ) {
    // Move world objects toward player
    this.obstacles.forEach(o => { o.position.z -= moveZ; });
    this.ramps.forEach(r => { r.position.z -= moveZ; });
    this.collectibles.forEach(c => { c.position.z -= moveZ; });
    this.scenery.forEach(s => { s.position.z -= moveZ; });
    // Phase 1 perf: scroll the instanced-scenery batch root in lockstep
    // with the marker .position.z values above so trees/lamps move with
    // the world without per-instance matrix updates.
    if (this.instancedScenery) this.instancedScenery.scroll(moveZ);
    if (this.finishLineGroup) this.finishLineGroup.position.z -= moveZ;
    if (this.mountainBlocks) {
      for (const m of this.mountainBlocks) m.position.z -= moveZ;
    }
    if (this.deathFlag) this.deathFlag.position.z -= moveZ;
    this._updateGroundDetail(moveZ);
  }

  // Course progress: HUD bar, finish-line crossing, win trigger
  _updateCourseProgress(delta) {
    if (!this.map) return;
    const len = this.map.courseLength;
    const pct = Math.max(0, Math.min(1, this.distance / len));

    // HUD update
    if (this.progressFillEl) this.progressFillEl.style.transform = `scaleY(${pct})`;
    if (this.progressMarkerEl) this.progressMarkerEl.style.bottom = `${(pct * 100).toFixed(1)}%`;
    if (this.progressRemainEl) {
      const remaining = Math.max(0, Math.floor(len - this.distance));
      this.progressRemainEl.textContent = `${remaining}m left`;
    }
    // Jana Bunny — second marker tracking the AI rabbit's progress
    // along the same course. Hidden in Sprint Run.
    if (this.progressRabbitMarkerEl) {
      if (this.gameMode === 'jana_bunny' && this.rabbit) {
        const rPct = Math.max(0, Math.min(1, this.rabbit.distance / len));
        this.progressRabbitMarkerEl.style.bottom = `${(rPct * 100).toFixed(1)}%`;
        this.progressRabbitMarkerEl.style.display = 'block';
      } else {
        this.progressRabbitMarkerEl.style.display = 'none';
      }
    }

    // Finish-line crossing — finishLineGroup.position.z drops as player advances.
    // It reaches z=0 when this.distance === courseLength.
    if (this.state === 'playing' && this.finishLineGroup
        && this.finishLineGroup.position.z <= 0) {
      this._win();
    }
  }

  // Phase 4 perf: confetti pool — one InstancedMesh, 80 slots (was 220
  // individual Mesh+Geometry+Material). Each particle just rewrites its
  // slot matrix per frame; one draw call total instead of ~220.
  _ensureConfettiPool() {
    if (this._confettiPool) return;
    const MAX = 80;
    const geo = new THREE.PlaneGeometry(0.22, 0.14);
    const mat = new THREE.MeshStandardMaterial({
      side: THREE.DoubleSide, vertexColors: false, roughness: 0.7,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, MAX);
    mesh.frustumCulled = false;
    // Color each slot once at construction; varying via setColorAt.
    const colors = [0xff3030, 0x4cc6ff, 0xffd23f, 0x35d24a, 0xffffff, 0xff8a3c, 0xa06cd5];
    const c = new THREE.Color();
    for (let i = 0; i < MAX; i++) {
      c.setHex(colors[i % colors.length]);
      mesh.setColorAt(i, c);
      mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(0, -10000, 0));
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
    this._confettiPool = { mesh, MAX };
  }

  _spawnConfetti(originZ) {
    this._ensureConfettiPool();
    const MAX = this._confettiPool.MAX;
    const startZ = originZ != null ? originZ : 0;
    for (let i = 0; i < MAX; i++) {
      // Reuse any free slot; otherwise overwrite the oldest.
      if (this.confetti[i] && this.confetti[i].life > 0) continue;
      this.confetti[i] = {
        slot: i,
        x: (Math.random() - 0.5) * 6,
        y: 2 + Math.random() * 2,
        z: startZ + (Math.random() - 0.5) * 4,
        rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6,
        vx: (Math.random() - 0.5) * 6,
        vy: 8 + Math.random() * 8,
        vz: (Math.random() - 0.5) * 6,
        avx: (Math.random() - 0.5) * 8,
        avy: (Math.random() - 0.5) * 8,
        avz: (Math.random() - 0.5) * 8,
        life: 4.0 + Math.random() * 2,
        maxLife: 4.0 + Math.random() * 2,
        gravity: 9.8,
        drift: (Math.random() - 0.5) * 1.5,
      };
    }
  }

  _updateConfetti(delta) {
    if (!this.confetti || this.confetti.length === 0 || !this._confettiPool) return;
    const pool = this._confettiPool;
    const tmpM = new THREE.Matrix4();
    const tmpQ = new THREE.Quaternion();
    const tmpE = new THREE.Euler();
    const tmpV = new THREE.Vector3();
    const tmpS = new THREE.Vector3();
    let dirty = false;
    for (let i = 0; i < this.confetti.length; i++) {
      const p = this.confetti[i];
      if (!p) continue;
      if (p.life <= 0) continue;
      p.life -= delta;
      if (p.life <= 0) {
        // Hide the slot instead of allocating
        tmpM.makeTranslation(0, -10000, 0);
        pool.mesh.setMatrixAt(p.slot, tmpM);
        dirty = true;
        continue;
      }
      p.vy -= p.gravity * delta;
      p.vx += p.drift * delta;
      p.x += p.vx * delta; p.y += p.vy * delta; p.z += p.vz * delta;
      p.rx += p.avx * delta; p.ry += p.avy * delta; p.rz += p.avz * delta;
      if (p.y < 0.05) {
        p.y = 0.05;
        p.vy *= -0.25; p.vx *= 0.8; p.vz *= 0.8;
      }
      // Fade by SCALING DOWN over the last 25 % of life (no per-particle
      // material — opacity is fixed on the shared material).
      const t = p.life / p.maxLife;
      const scale = t > 0.25 ? 1 : (t / 0.25);
      tmpE.set(p.rx, p.ry, p.rz); tmpQ.setFromEuler(tmpE);
      tmpV.set(p.x, p.y, p.z);
      tmpS.set(scale, scale, scale);
      tmpM.compose(tmpV, tmpQ, tmpS);
      pool.mesh.setMatrixAt(p.slot, tmpM);
      dirty = true;
    }
    if (dirty) pool.mesh.instanceMatrix.needsUpdate = true;
  }

  _clearConfetti() {
    if (!this.confetti) return;
    if (this._confettiPool) {
      const tmpM = new THREE.Matrix4().makeTranslation(0, -10000, 0);
      for (let i = 0; i < this._confettiPool.MAX; i++) {
        this._confettiPool.mesh.setMatrixAt(i, tmpM);
      }
      this._confettiPool.mesh.instanceMatrix.needsUpdate = true;
    }
    this.confetti = [];
    this._confettiSpawned = false;
  }

  _updateWonState(delta) {
    // Animate confetti and let the world coast to a stop with a periodic burst
    this._explosionDecel = (this._explosionDecel || 0) + delta;
    const slow = Math.max(0, 1 - this._explosionDecel / 1.0);
    const moveZ = this.speed * delta * slow * 0.6;
    if (moveZ > 0) this._moveWorld(moveZ);
    this._updateConfetti(delta);
    // Top up confetti every ~1.2s while the win screen is visible
    this._confettiTopupT = (this._confettiTopupT || 0) + delta;
    if (this._confettiTopupT > 1.2) {
      this._spawnConfetti(0);
      this._confettiTopupT = 0;
    }
  }

  _win() {
    if (this.state !== 'playing') return;
    this.state = 'won';
    this._stopBgMusic();
    // Tear down the rabbit (if any) so the next round starts clean.
    if (this.rabbit) { this.rabbit.dispose(); this.rabbit = null; }
    if (this.startingLine) { this.scene.remove(this.startingLine); this.startingLine = null; }
    this.sounds.play('win');
    if (!this._confettiSpawned) {
      this._spawnConfetti(0);  // confetti at the player's frame (z ≈ 0)
      this._confettiSpawned = true;
    }
    // Coast to a stop
    this._explosionDecel = 0;
    // Hide gameplay HUD (keeps win UI clean)
    if (this.airTimeEl) this.airTimeEl.classList.remove('active');
    if (this.speedLinesEl) this.speedLinesEl.classList.remove('active');
    this.hud.style.display = 'none';
    if (this.progressEl) this.progressEl.style.display = 'none';

    // Populate win-screen stats
    if (this.winStatsEl) {
      const seconds = Math.max(0, (performance.now() - this.startTime) / 1000);
      const mm = Math.floor(seconds / 60);
      const ss = (seconds - mm * 60).toFixed(2);
      const timeStr = mm > 0 ? `${mm}m ${ss}s` : `${ss}s`;
      this.winStatsEl.innerHTML =
        `<div>Time: <strong>${timeStr}</strong></div>` +
        `<div>Distance: <strong>${this.map ? this.map.courseLength : 0}m</strong></div>` +
        `<div>Coins: <strong>${this.coins}</strong></div>`;
    }
    if (this.winSeedEl) {
      this.winSeedEl.textContent = `Seed: ${this.courseSeed}`;
    }
    if (this.winScreenEl) this.winScreenEl.style.display = 'flex';
  }

  _checkCollisions() {
    const px = this.player.position.x;
    const py = this.player.position.y;
    // Phase 3 perf: world scrolls so the player is fixed at z=0. Anything
    // beyond ±NEAR_Z can't possibly overlap. Skip the iteration body for
    // far objects with a single Math.abs compare at the top of each loop.
    const NEAR_Z = 8;
    // If the player is high enough above all ground props (cars, rocks,
    // tall lamps, ramps, ~6 m max prop height) we can skip ground checks
    // entirely. Air-time + ramp arc fly safely above everything except
	    // mountain-split high-rises and aerial hazards.
	    const aboveGround = py > 8 && !this.isJumping;
	    const collisionWorld = buildCollisionWorld({
	      playerDistance: this.distance,
	      laneWidth: GAME_CONFIG.LANE_WIDTH,
	      obstacles: this.obstacles,
	      scenery: this.scenery,
	      buildings: this.mountainBlocks,
	      // Player keeps dedicated systems for these special interactions.
	      crossStreets: [],
	      ramps: [],
	      drones: [],
	    });

    // Ramp hit — launch the player. Player is at z=0; the ramp is at
    // ramp.position.z and extends ±length/2 in Z. Trigger as soon as the
    // player overlaps the ramp footprint within ±1.5 in X.
    if (!aboveGround) for (const ramp of this.ramps) {
      if (Math.abs(ramp.position.z) > NEAR_Z + 6) continue;  // far → skip
      const halfL = (ramp.userData.length || 10) / 2;
      const insideZ = Math.abs(ramp.position.z) <= halfL + 0.5;
      const dx = Math.abs(ramp.position.x - px);
      if (insideZ && dx < 1.5 && py < 1.5
          && ramp.userData.id !== this.lastRampHitId) {
        this._launchFromRamp(ramp);
        break;
      }
    }

    // Side-hit collision against the COLLIDABLE mountain-split signs
    // (caution + stop). Same height-aware rule as scenery — the player
    // can ramp-jump cleanly over them but a side hit at low altitude
    // explodes them.
    if (!this.airborneFromRamp && !aboveGround && this.mountainBlocks) {
      for (const sign of this.mountainBlocks) {
        if (!sign.userData.collidable) continue;
        if (Math.abs(sign.position.z) > NEAR_Z) continue;
        const halfL = (sign.userData.length || 0.8) / 2 + 0.3;
        const halfW = (sign.userData.width  || 0.8) / 2 + 0.3;
        const top   = (sign.userData.height || 2.5);
        const dz = Math.abs(sign.position.z);
        const dx = Math.abs(sign.position.x - px);
        if (dz < halfL && dx < halfW) {
          if (py >= top - 0.4) continue;
          this._die(this.player.position, sign.userData.kind || 'boulder', 'CRASHED!');
          return;
        }
      }
    }

    // Mountain-split high-rise collision. The arch is a SAFE corridor — but
    // ONLY if the player ENTERS through the arch (i.e. is centered in the
    // arch X window AND already at the entrance floor altitude or above at
    // first contact). Otherwise they crashed into the front wall / pillar.
	    {
	      const buildingColliders = collisionWorld.filter((c) => c.kind === COLLIDER_KIND.BUILDING);
	      for (const collider of buildingColliders) {
	        const block = collider.obj;
	        // Phase 3 perf: skip if the building's CENTER is far away. Use the
	        // building length (≈25) as the near-window so we don't skip while
	        // the player is approaching its front wall.
	        if (Math.abs(collider.screenZ) > NEAR_Z + 14) continue;
	        const halfL = (collider.length || 25) / 2;
	        const halfW = (collider.width  || 6) / 2;
	        const dz = collider.screenZ;
	        const insideZ = dz - halfL <= 0 && dz + halfL >= 0;

        // Outside the building's Z footprint — clear the per-pass qualifier
        if (!insideZ) {
          block.userData._playerInArch = false;
          continue;
        }
        // Above the roof? Pass freely.
	        if (py >= (collider.height || 28)) continue;

	        const dxAbs = Math.abs(px - collider.x);
	        if (dxAbs >= halfW) continue;            // not in X footprint

	        const arch = canPassBuildingArch(collider, px, py, { stateKey: '_playerInArch' });
	        if (arch.pass) {
	          // Snap up to the arch floor if below — landing inside the
	          // entrance places the player on the floor, not on the road.
	          if (this.playerY < arch.snapY) {
	            this.playerY = arch.snapY;
	            this.player.position.y = arch.snapY;
	            this.isJumping = true;
	            if (this.jumpVelocity < 0) this.jumpVelocity = 0;
	          }
	          continue;                          // safe — sliding through
	        }
	        this._die(this.player.position, 'boulder', 'CRASHED!');
	        return;
	      }
    }

    // Cross-street traffic collision — ignored while airborne from a ramp.
    if (this._checkCrossStreetCollision()) {
      this._die(this.player.position, 'car', 'CRASHED!');
      return;
    }

    // Aerial hazards (rockets, low-pass planes, drones, balloons)
    const aerialHit = this._checkFlyingHazards();
    if (aerialHit) {
      this._die(this.player.position, aerialHit, 'CRASHED!');
      return;
    }

    // Stationary on-course vehicle / boulder obstacles. The player can RIDE
    // along the top of an object: any time their Y is at or above
    // `top - 0.6`, treat it as a safe surface contact. To make the slide
    // read visually, snap playerY up to the obstacle's roof while overlapping
    // — the player rides the surface and falls back off the back.
    // A side hit (coming in below the roof minus the margin) still kills.
	    if (!this.airborneFromRamp && !aboveGround) {
	      let onTopOfSomething = false;
	      const obstacleColliders = collisionWorld.filter((c) => c.source === 'vehicle' || c.source === 'obstacle');
	      for (const collider of obstacleColliders) {
	        const obs = collider.obj;
	        // Phase 3 perf: cheap Z-distance early-out before any other math.
	        if (Math.abs(collider.screenZ) > NEAR_Z) continue;
	        const top = collider.height || 1.5;
	        if (overlapsFootprint(collider, px, 0, 0.5, 0.6)) {
	          // Generous "touching the top" tolerance — also catches the player
	          // when the obstacle's height fraction is met (≥ 65 %).
	          if (py >= top - 0.6 || py >= top * 0.65) {
            // Snap up to the surface so we visibly ride the obstacle
            if (this.playerY < top) {
              this.playerY = top;
              this.player.position.y = top;
              this.isJumping = true;
              if (this.jumpVelocity < 0) this.jumpVelocity = 0;
            }
            onTopOfSomething = true;
            continue;
          }
          const kind = obs.userData.vehicleType ? 'car' : 'boulder';
          this._die(this.player.position, kind, 'Game Over!');
          return;
        }
      }
      // Tag for downstream systems (currently unused, available for tuning)
      this._ridingObstacle = onTopOfSomething;
    }

    // Side-hit collision against COLLIDABLE scenery (trees, lamps, rocks).
    // Same Z early-out as the other ground loops. The player can clear
    // these props by jumping above their `height` minus a margin.
	    if (!this.airborneFromRamp && !aboveGround) {
	      const sceneryColliders = collisionWorld.filter((c) =>
	        c.source !== 'vehicle' &&
	        c.source !== 'obstacle' &&
	        c.source !== 'building' &&
	        (c.kind === COLLIDER_KIND.GROUND || c.kind === COLLIDER_KIND.WALL)
	      );
	      for (const collider of sceneryColliders) {
	        const s = collider.obj;
	        if (Math.abs(collider.screenZ) > NEAR_Z) continue;
	        const top = collider.height || 2.0;
	        if (overlapsFootprint(collider, px, 0, 0.3, 0.3)) {
	          // Cleared the prop's top? Pass safely — sled can fly over.
	          if (py >= top - 0.4) continue;
	          const kind = s.userData.kind || 'boulder';
          this._die(this.player.position, kind, 'CRASHED!');
          return;
        }
      }
    }

    // Coin collection — Phase 3 perf: check Z FIRST (cheapest); coin
    // collection radius is 1.5, so anything past ±2 can't be picked up.
    for (const coin of this.collectibles) {
      if (coin.userData.collected) continue;
      const dz = Math.abs(coin.position.z);
      if (dz > 2) continue;
      const dx = Math.abs(coin.position.x - px);
      if (dz < 1.5 && dx < 1.5) {
        coin.userData.collected = true;
        coin.visible = false;
        this.coins++;
        // Cooldown so chained pickups (5 coins in a row) read as a series of
        // distinct ticks, not one wash of overlapping clips.
        const now = performance.now();
        if (now - (this._lastCoinSfxAt || 0) > 50) {
          this.sounds.play('coin_pickup');
          this._lastCoinSfxAt = now;
        }
        this.score += 10;
      }
    }
  }

  _launchFromRamp(ramp) {
    this.lastRampHitId = ramp.userData.id;
    this.isJumping = true;
    this.airborneFromRamp = true;
    this.jumpVelocity = GAME_CONFIG.RAMP_JUMP_FORCE;
    this.airTime = 0;
    this.airPeakHeight = this.playerY;
    this.sounds.play('ramp_launch');
    // Air time of a ballistic jump = 2 * v / g. The full 360° flip eases to
    // exactly 1 revolution over this duration so the penguin lands upright.
    this.flipDuration = 2 * GAME_CONFIG.RAMP_JUMP_FORCE / GAME_CONFIG.GRAVITY;
    // Ramp launches arm a single double-jump too
    this.canDoubleJump = true;
    this._parachuteArmed = false;
    this._skySpawnCooldown = 0;
    if (this.airTimeEl) this.airTimeEl.classList.add('active');

    // Dramatic sky burst the moment the player launches
    this._spawnSkyBurst();
  }

  _finishAirTime() {
    if (!this.airborneFromRamp) return;
    const seconds = this.airTime;
    const heightBonus = Math.floor(this.airPeakHeight * GAME_CONFIG.AIR_HEIGHT_BONUS);
    const timeBonus = Math.floor(seconds * GAME_CONFIG.AIR_BONUS_PER_SEC);
    const bonusCoins = Math.max(1, Math.floor((heightBonus + timeBonus) / 10));
    this.coins += bonusCoins;
    this.score += heightBonus + timeBonus;

    this._showBonusPop(`+${bonusCoins} 🪙  ·  ${seconds.toFixed(2)}s AIR`);

    // Trigger boost + screen shake + speed lines
    this.boostTimer = GAME_CONFIG.RAMP_BOOST_DURATION;
    this.shakeTimer = 0.5;
    this.shakeMagnitude = 0.35;
    if (this.speedLinesEl) this.speedLinesEl.classList.add('active');

    // Reset air state and snap the flip back to upright
    this.airborneFromRamp = false;
    if (this.player.userData.inner) this.player.userData.inner.rotation.x = 0;
    if (this.airTimeEl) this.airTimeEl.classList.remove('active');
    setTimeout(() => { this.lastRampHitId = null; }, 600);
  }

  _showBonusPop(text) {
    if (!this.bonusPopEl) return;
    this.bonusPopEl.textContent = text;
    this.bonusPopEl.classList.add('show');
    clearTimeout(this._bonusPopTimer);
    this._bonusPopTimer = setTimeout(() => {
      this.bonusPopEl.classList.remove('show');
    }, 1100);
  }

  _showSpeedUpFlash() {
    if (!this.speedUpFlashEl) return;
    // Re-trigger CSS animation by toggling the class
    this.speedUpFlashEl.classList.remove('show');
    // Force reflow so the next add re-runs the animation
    void this.speedUpFlashEl.offsetWidth;
    this.speedUpFlashEl.classList.add('show');
    // A tiny camera shake on milestone
    this.shakeTimer = Math.max(this.shakeTimer, 0.35);
    this.shakeMagnitude = Math.max(this.shakeMagnitude, 0.25);
    this.sounds.play('speed_up');
  }

  // ─────────────────────────────────────
  // Biome transitions
  // ─────────────────────────────────────

  _biomeForDistance(d) {
    if (d < GAME_CONFIG.BIOME_SNOW_END) return 'snow';
    if (d < GAME_CONFIG.BIOME_CITY_END) return 'city';
    return 'tropical';
  }

  _updateBiome() {
    const target = this._biomeForDistance(this.distance);
    if (target !== this.currentBiome) {
      this._setBiome(target);
    }
  }

  _biomePalette(biome) {
    if (biome === 'snow')     return { ground: 0xf0f5ff, fog: 0xd0e8ff, sky: 0x87ceeb };
    if (biome === 'city')     return { ground: 0xdde7f0, fog: 0xc4d0dc, sky: 0x8da3b8 };
    /* tropical */            return { ground: 0xf3e6c8, fog: 0xfdeec0, sky: 0x6cc6f0 };
  }

  _setBiome(biome, opts = {}) {
    const immediate = !!opts.immediate;
    if (biome === this.currentBiome && !immediate) return;

    this.previousBiome = this.currentBiome;
    this.currentBiome = biome;

    const fromPal = this._biomePalette(this.previousBiome);
    const toPal   = this._biomePalette(biome);
    this._biomeFromColors = fromPal;
    this._biomeToColors = toPal;
    this._biomeTransitionStart = this.distance;
    this.biomeProgress = immediate ? 1 : 0;

    if (immediate) {
      // Snap colors instantly (used on restart)
      if (this.groundMat) this.groundMat.color.setHex(toPal.ground);
      if (this.scene && this.scene.background) this.scene.background.setHex(toPal.sky);
      if (this.scene && this.scene.fog) this.scene.fog.color.setHex(toPal.fog);
      this._setBiomeGroundDetail(biome);
    }

    // Cross-streets share one asphalt color — retint immediately, no fade
    const roadColor = 0x3a3a3a;
    if (this.crossStreets) {
      for (const street of this.crossStreets) {
        if (street.userData.roadMat) street.userData.roadMat.color.setHex(roadColor);
      }
    }
    if (this.roadMat) this.roadMat.color.setHex(roadColor);

    const bannerLabel = biome === 'snow' ? 'SNOW' : biome === 'city' ? 'CITY' : 'TROPICAL';

    // Banner pop
    if (this.biomeBannerEl) {
      this.biomeBannerEl.textContent = bannerLabel;
      this.biomeBannerEl.classList.add('show');
      clearTimeout(this._biomeBannerTimer);
      this._biomeBannerTimer = setTimeout(() => {
        this.biomeBannerEl.classList.remove('show');
      }, 2200);
    }
  }

  _tickBiomeTransition() {
    if (this.biomeProgress >= 1 || !this._biomeFromColors || !this._biomeToColors) return;

    const t = Math.max(0, Math.min(1,
      (this.distance - this._biomeTransitionStart) / this.BIOME_TRANSITION_LEN,
    ));
    this.biomeProgress = t;

    const tmp = new THREE.Color();
    const a = this._biomeFromColors;
    const b = this._biomeToColors;

    if (this.groundMat) {
      this.groundMat.color.lerpColors(
        new THREE.Color(a.ground), new THREE.Color(b.ground), t,
      );
    }
    if (this.scene && this.scene.background) {
      tmp.copy(new THREE.Color(a.sky)).lerp(new THREE.Color(b.sky), t);
      this.scene.background.copy(tmp);
    }
    if (this.scene && this.scene.fog) {
      tmp.copy(new THREE.Color(a.fog)).lerp(new THREE.Color(b.fog), t);
      this.scene.fog.color.copy(tmp);
    }

    // When the crossfade completes, lock in the biome's ground-detail tint
    if (t >= 1) {
      this._setBiomeGroundDetail(this.currentBiome);
    }
  }

  _recycleObjects() {
    // Move obstacles that passed behind camera back to the front. Skip any
    // obstacle marked `unique` (e.g. mountain-path content) — those belong
    // to a specific course Z and must NOT be recycled forward.
    this.obstacles.forEach(obs => {
      if (obs.userData.unique) return;
      if (obs.position.z < -20) {
        const targetZ = obs.position.z + 200 + Math.random() * 50;
        const newZ = this._clampToSafeZ(targetZ, 5);
        if (newZ == null) return;     // No clean Z — leave it behind, don't park on road
        obs.position.z = newZ;
        const newLane = Math.floor(Math.random() * 3) - 1;
        obs.position.x = newLane * GAME_CONFIG.LANE_WIDTH;
      }
    });

    // Recycle ramps further out so they're rarer
    this.ramps.forEach(ramp => {
      if (ramp.userData.unique) return;
      if (ramp.position.z < -20) {
        const targetZ = ramp.position.z + 240 + Math.random() * 80;
        const newZ = this._clampToSafeZ(targetZ, 8);
        if (newZ == null) return;
        ramp.position.z = newZ;
        ramp.position.x = 0;
        ramp.userData.lane = 1;
        ramp.userData.id = `ramp_${Math.random().toString(36).slice(2, 9)}`;
      }
    });

    // Recycle coins
    this.collectibles.forEach(coin => {
      if (coin.userData.unique) return;
      if (coin.position.z < -20) {
        const targetZ = coin.position.z + 200 + Math.random() * 50;
        const safeZ = this._clampToSafeZ(targetZ, 4);
        if (safeZ == null) return;
        coin.position.z = safeZ;
        const newLane = Math.floor(Math.random() * 3) - 1;
        coin.position.x = newLane * GAME_CONFIG.LANE_WIDTH;
        coin.userData.collected = false;
        coin.visible = true;
      }
    });

    // Scenery is now pre-spawned across the entire course at init (see
    // _spawnSideDecor), with each item placed at its true world-Z so
    // that biome-correct items land in the right region (snow tents
    // 0-500m, city buildings 500-1000m, tropical mid-rises 1000m+).
    // Items therefore must NOT be teleported forward when they pass
    // behind the player — that would put a tent/building at the wrong
    // world-Z and visibly contradict the biome stripe. Three.js frustum
    // culling skips off-screen items, so leaving them in place is free.
  }
}
