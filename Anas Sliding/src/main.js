import * as THREE from 'three';

const COLORS = {
  snow: 0xf7fbff,
  packed: 0xd7eef9,
  wall: 0x9fb7c9,
  road: 0x3f4a54,
  water: 0x1c6f9a,
  rail: 0x5c6670,
  tree: 0x244b24,
  trunk: 0x6b4423,
  blue: 0x1f8de4,
  dark: 0x172331,
  yellow: 0xf5c542,
};

const COURSE = {
  width: 26,
  platform: 96,
  gap: 18,
  drop: 4.6,
  count: 17,
};

class Game {
  constructor() {
    this.root = document.getElementById('app');
    this.startPanel = document.getElementById('start');
    this.startBtn = document.getElementById('start-btn');
    this.pad = document.getElementById('pad');
    this.distanceEl = document.getElementById('distance');
    this.speedEl = document.getElementById('speed');
    this.dropsEl = document.getElementById('drops');

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xc5dfef);
    this.scene.fog = new THREE.Fog(0xc5dfef, 110, 520);

    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 900);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.root.appendChild(this.renderer.domElement);

    this.clock = new THREE.Clock();
    this.keys = new Set();
    this.platforms = [];
    this.drops = [];
    this.playerX = 0;
    this.playerZ = 8;
    this.playerY = 0;
    this.velY = 0;
    this.speed = 17;
    this.dropCount = 0;
    this.lastPlatform = 0;
    this.running = false;
    this.touching = false;
    this.touchStartX = 0;
    this.touchOriginX = 0;
    this.cam = new THREE.Vector3(0, 9, -15);

    this.mat = this._materials();
    this._lights();
    this._world();
    this._player();
    this._input();
    this._resize();
    this._loop();
  }

  _materials() {
    return {
      snow: new THREE.MeshStandardMaterial({ color: COLORS.snow, roughness: 0.95 }),
      packed: new THREE.MeshStandardMaterial({ color: COLORS.packed, roughness: 0.9 }),
      wall: new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.82 }),
      road: new THREE.MeshStandardMaterial({ color: COLORS.road, roughness: 0.9 }),
      water: new THREE.MeshStandardMaterial({ color: COLORS.water, roughness: 0.25, metalness: 0.3 }),
      rail: new THREE.MeshStandardMaterial({ color: COLORS.rail, roughness: 0.45, metalness: 0.45 }),
      tree: new THREE.MeshStandardMaterial({ color: COLORS.tree, roughness: 0.9 }),
      trunk: new THREE.MeshStandardMaterial({ color: COLORS.trunk, roughness: 0.95 }),
      roof: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
      blue: new THREE.MeshStandardMaterial({ color: COLORS.blue, roughness: 0.45 }),
      dark: new THREE.MeshStandardMaterial({ color: COLORS.dark, roughness: 0.7 }),
      yellow: new THREE.MeshStandardMaterial({ color: COLORS.yellow, emissive: 0x6d4b00, emissiveIntensity: 0.16 }),
      red: new THREE.MeshStandardMaterial({ color: 0xd74338, roughness: 0.55 }),
      buildingA: new THREE.MeshStandardMaterial({ color: 0x96b4d2, roughness: 0.78 }),
      buildingB: new THREE.MeshStandardMaterial({ color: 0xd7a77a, roughness: 0.78 }),
      buildingC: new THREE.MeshStandardMaterial({ color: 0x8797a8, roughness: 0.78 }),
    };
  }

  _lights() {
    this.scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x6d7a84, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.8);
    sun.position.set(-30, 70, -35);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(sun);
  }

  _world() {
    let z = 0;
    for (let i = 0; i < COURSE.count; i++) {
      const y = -i * COURSE.drop;
      const kind = this._kind(i);
      this._platform(i, z, y, kind);
      this.platforms.push({ start: z, end: z + COURSE.platform, y, index: i });
      this._gap(z + COURSE.platform, y, y - COURSE.drop, kind);
      z += COURSE.platform + COURSE.gap;
    }
    this.finish = z - COURSE.gap;
    this._mountains();
  }

  _kind(i) {
    if (i === 2 || i === 10) return 'road';
    if (i === 4) return 'fuel';
    if (i === 6) return 'rail';
    if (i === 8) return 'fjord';
    if (i === 12) return 'plaza';
    if (i === 14) return 'aircraft';
    return i % 3 === 0 ? 'trees' : 'city';
  }

  _platform(index, z, y, kind) {
    const group = new THREE.Group();
    group.position.set(0, y, z + COURSE.platform / 2);
    const base = new THREE.Mesh(new THREE.BoxGeometry(COURSE.width, 0.55, COURSE.platform), this.mat.snow);
    base.position.y = -0.28;
    base.receiveShadow = true;
    group.add(base);
    const riding = new THREE.Mesh(new THREE.PlaneGeometry(COURSE.width - 2.4, COURSE.platform - 3), this.mat.packed);
    riding.rotation.x = -Math.PI / 2;
    riding.position.y = 0.015;
    group.add(riding);
    for (const sx of [-13.6, 13.6]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1 + index * 0.08, COURSE.platform), this.mat.wall);
      wall.position.set(sx, -0.6, 0);
      group.add(wall);
    }
    this._sideCity(group, index, kind);
    if (kind === 'fuel') this._fuel(group);
    if (kind === 'plaza') this._plaza(group);
    if (kind === 'aircraft') this._aircraft(group);
    if (index % 2 === 1) this._ramp(group, index % 4 === 1 ? -5 : 5, 10);
    this.scene.add(group);
  }

  _gap(startZ, topY, lowerY, kind) {
    const z = startZ + COURSE.gap / 2;
    const face = new THREE.Mesh(new THREE.BoxGeometry(COURSE.width, COURSE.drop, 0.8), this.mat.wall);
    face.position.set(0, lowerY + COURSE.drop / 2 - 0.25, startZ + 0.25);
    this.scene.add(face);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(COURSE.width, 0.12, 0.8), this.mat.roof);
    lip.position.set(0, topY + 0.05, startZ - 0.15);
    this.scene.add(lip);
    if (kind === 'road') this._crossRoad(z, lowerY);
    else if (kind === 'rail') this._rail(z, lowerY);
    else if (kind === 'fjord') this._fjord(z, lowerY);
    else {
      const ice = new THREE.Mesh(new THREE.PlaneGeometry(COURSE.width * 0.72, COURSE.gap), this.mat.packed);
      ice.rotation.x = -Math.PI / 2;
      ice.position.set(0, lowerY + 0.02, z);
      this.scene.add(ice);
    }
    this.drops.push({ z: startZ, lowerY });
  }

  _sideCity(group, index, kind) {
    for (const side of [-1, 1]) {
      const road = new THREE.Mesh(new THREE.PlaneGeometry(9, COURSE.platform * 0.86), this.mat.road);
      road.rotation.x = -Math.PI / 2;
      road.position.set(side * 28, -2.2 - index * 0.18, 0);
      group.add(road);
      for (let i = 0; i < 6; i++) {
        const z = -38 + i * 14 + Math.random() * 4;
        if (kind === 'trees' || Math.random() < 0.42) {
          const tree = this._tree(0.9 + Math.random() * 0.45);
          tree.position.set(side * (15 + Math.random() * 6), -0.1 - index * 0.08, z);
          group.add(tree);
        } else {
          const b = this._building();
          b.position.set(side * (35 + Math.random() * 10), -2.2 - index * 0.18, z);
          group.add(b);
        }
      }
    }
  }

  _crossRoad(z, y) {
    const road = new THREE.Mesh(new THREE.PlaneGeometry(82, COURSE.gap + 7), this.mat.road);
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, y + 0.02, z);
    this.scene.add(road);
    for (let i = 0; i < 4; i++) {
      const car = this._vehicle(i % 2 ? 0xd85043 : COLORS.yellow);
      car.position.set(-32 + i * 21, y + 0.45, z + (i % 2 ? 2 : -2));
      car.rotation.y = Math.PI / 2;
      this.scene.add(car);
    }
  }

  _rail(z, y) {
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(86, COURSE.gap + 5), this.mat.road);
    bed.rotation.x = -Math.PI / 2;
    bed.position.set(0, y + 0.02, z);
    this.scene.add(bed);
    for (const rz of [-0.9, 0.9]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(82, 0.08, 0.12), this.mat.rail);
      rail.position.set(0, y + 0.12, z + rz);
      this.scene.add(rail);
    }
    for (let i = 0; i < 6; i++) {
      const car = new THREE.Mesh(new THREE.BoxGeometry(8, 2.2, 2.4), this.mat.buildingC);
      car.position.set(-28 + i * 10, y + 1.2, z);
      this.scene.add(car);
    }
  }

  _fjord(z, y) {
    const water = new THREE.Mesh(new THREE.PlaneGeometry(96, COURSE.gap + 12), this.mat.water);
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, y - 0.55, z);
    this.scene.add(water);
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(COURSE.width * 0.55, 0.18, COURSE.gap + 2), this.mat.packed);
    bridge.position.set(0, y + 0.12, z);
    this.scene.add(bridge);
    const ship = this._vehicle(0xd7a77a);
    ship.scale.set(2.2, 1.1, 1.5);
    ship.position.set(25, y - 0.25, z - 2.5);
    this.scene.add(ship);
  }

  _fuel(group) {
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(12, 0.45, 9), this.mat.red);
    canopy.position.set(0, 3.35, 5);
    group.add(canopy);
    for (const sx of [-5, 5]) for (const sz of [1.5, 8.5]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 3.2, 10), this.mat.roof);
      pillar.position.set(sx, 1.6, sz);
      group.add(pillar);
    }
    for (const sx of [-2.2, 2.2]) {
      const pump = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.25, 0.7), this.mat.dark);
      pump.position.set(sx, 0.65, 5);
      group.add(pump);
    }
  }

  _plaza(group) {
    const plaza = new THREE.Mesh(new THREE.CircleGeometry(5.4, 32), this.mat.snow);
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.y = 0.04;
    group.add(plaza);
    const fountain = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.6, 0.4, 24), this.mat.wall);
    fountain.position.y = 0.22;
    group.add(fountain);
  }

  _aircraft(group) {
    const plane = new THREE.Group();
    plane.add(new THREE.Mesh(new THREE.BoxGeometry(3, 3, 15), this.mat.dark));
    const wing = new THREE.Mesh(new THREE.BoxGeometry(27, 0.35, 3), this.mat.dark);
    wing.position.z = -1;
    plane.add(wing);
    plane.position.set(0, 16, 12);
    group.add(plane);
  }

  _ramp(group, x, z) {
    const ramp = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.45, 8.5), this.mat.snow);
    body.position.y = 0.22;
    body.rotation.x = -0.22;
    ramp.add(body);
    ramp.position.set(x, 0, z);
    ramp.userData.ramp = true;
    group.add(ramp);
  }

  _tree(scale) {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 1.2, 7), this.mat.trunk);
    trunk.position.y = 0.6 * scale;
    g.add(trunk);
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry((0.95 - i * 0.18) * scale, 1.15 * scale, 8), this.mat.tree);
      cone.position.y = (1.2 + i * 0.62) * scale;
      g.add(cone);
      const cap = new THREE.Mesh(new THREE.ConeGeometry((0.97 - i * 0.18) * scale, 0.34 * scale, 8, 1, true), this.mat.roof);
      cap.position.y = cone.position.y + 0.2 * scale;
      g.add(cap);
    }
    return g;
  }

  _building() {
    const mats = [this.mat.buildingA, this.mat.buildingB, this.mat.buildingC];
    const h = 5 + Math.random() * 12;
    const w = 4 + Math.random() * 3;
    const d = 4 + Math.random() * 3;
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats[Math.floor(Math.random() * mats.length)]);
    body.position.y = h / 2;
    g.add(body);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.5, 0.28, d + 0.5), this.mat.roof);
    roof.position.y = h + 0.14;
    g.add(roof);
    return g;
  }

  _vehicle(color) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.8, 1.8), mat);
    body.position.y = 0.45;
    g.add(body);
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 1.5), mat);
    top.position.y = 1.15;
    g.add(top);
    return g;
  }

  _mountains() {
    for (let i = 0; i < 18; i++) {
      const m = new THREE.Mesh(
        new THREE.ConeGeometry(16 + Math.random() * 18, 35 + Math.random() * 25, 5),
        new THREE.MeshStandardMaterial({ color: 0xc8dceb, roughness: 1, flatShading: true }),
      );
      m.position.set(-150 + i * 18, -22, 500 + Math.random() * 180);
      m.rotation.y = Math.random() * Math.PI;
      this.scene.add(m);
    }
  }

  _player() {
    const root = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.22, 14, 32), this.mat.blue);
    tube.rotation.x = Math.PI / 2;
    tube.position.y = 0.25;
    root.add(tube);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 16), this.mat.dark);
    body.position.y = 0.62;
    root.add(body);
    this.player = root;
    this.scene.add(root);
  }

  _input() {
    this.startBtn.addEventListener('click', () => {
      this.running = true;
      this.startPanel.style.display = 'none';
    });
    addEventListener('keydown', e => {
      this.keys.add(e.key.toLowerCase());
      if (e.code === 'Space') this._jump();
    });
    addEventListener('keyup', e => this.keys.delete(e.key.toLowerCase()));
    this.pad.addEventListener('pointerdown', e => {
      this.touching = true;
      this.touchStartX = e.clientX;
      this.touchOriginX = this.playerX;
      this.pad.setPointerCapture(e.pointerId);
    });
    this.pad.addEventListener('pointermove', e => {
      if (this.touching) this.playerX = THREE.MathUtils.clamp(this.touchOriginX + (e.clientX - this.touchStartX) * 0.035, -10, 10);
    });
    this.pad.addEventListener('pointerup', () => {
      if (this.touching) this._jump();
      this.touching = false;
    });
    addEventListener('resize', () => this._resize());
  }

  _jump() {
    if (!this.running || !this.grounded) return;
    this.velY = 13;
    this.grounded = false;
  }

  _groundAt(z) {
    const p = this.platforms.find(item => z >= item.start && z <= item.end);
    if (p) return p;
    let lower = this.platforms[0];
    for (const p2 of this.platforms) if (p2.start <= z) lower = p2;
    return lower;
  }

  _update(dt) {
    if (!this.running) return;
    const steer = (this.keys.has('a') || this.keys.has('arrowleft') ? -1 : 0) + (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0);
    if (!this.touching) this.playerX += steer * 15 * dt;
    this.playerX = THREE.MathUtils.clamp(this.playerX, -10.5, 10.5);
    this.speed = Math.min(31, this.speed + 0.75 * dt);
    this.playerZ += this.speed * dt;
    const ground = this._groundAt(this.playerZ);
    if (!this.grounded) {
      this.velY -= 31 * dt;
      this.playerY += this.velY * dt;
      if (this.playerY <= ground.y) {
        this.playerY = ground.y;
        this.velY = 0;
        this.grounded = true;
      }
    } else if (ground.y < this.playerY - 0.3) {
      this.grounded = false;
      this.velY = -2;
    } else {
      this.playerY += (ground.y - this.playerY) * Math.min(1, 18 * dt);
    }
    if (ground.index > this.lastPlatform) {
      this.dropCount += ground.index - this.lastPlatform;
      this.lastPlatform = ground.index;
    }
    this.player.position.set(this.playerX, this.playerY + 0.18, this.playerZ);
    this.player.rotation.z += ((-this.playerX * 0.02) - this.player.rotation.z) * Math.min(1, 8 * dt);
    this.player.rotation.x = -0.2 + Math.sin(performance.now() * 0.006) * 0.025;
    this.cam.lerp(new THREE.Vector3(this.playerX * 0.35, this.playerY + 8.5, this.playerZ - 15), Math.min(1, 4.5 * dt));
    this.camera.position.copy(this.cam);
    this.camera.lookAt(this.playerX * 0.18, this.playerY - 1.4, this.playerZ + 34);
    this.distanceEl.textContent = `${Math.floor(this.playerZ)} m`;
    this.speedEl.textContent = `${Math.floor(this.speed * 3.6)} km/h`;
    this.dropsEl.textContent = `${this.dropCount} drops`;
  }

  _resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  _loop() {
    requestAnimationFrame(() => this._loop());
    this._update(Math.min(0.033, this.clock.getDelta()));
    this.renderer.render(this.scene, this.camera);
  }
}

new Game();
