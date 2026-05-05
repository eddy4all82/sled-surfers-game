# Anas Surfers

A Subway Surfers–style 3D endless-runner web game built with [Three.js](https://threejs.org/) and [Vite](https://vitejs.dev/).

A little penguin slides down a procedurally generated course through snow, city, and tropical biomes — dodging cars, drones, rockets, low-flying airplanes, and a giant high-rise mid-course (with a jump-through arch, if you're brave). The course has a real start and finish line, with a shareable seed.

## Features

- **Procedural map generator** — seeded `mulberry32` RNG produces deterministic 2000-unit courses out of weighted chunk types: `OPEN_SNOW`, `CITY_BLOCK`, `FOREST`, `LAKE_CROSSING`, `MOUNTAIN_SPLIT`, `TRAIN_CROSSING`, `CANYON`, `BRIDGE`, `VILLAGE`, `FINALE_APPROACH`. Adjacent duplicates and exclusion zones (mountain/train spacing) enforced.
- **Three biomes** — snow / city / tropical, with smooth 50-unit color crossfades and biome-specific buildings, trees, and rocks.
- **Movement** — continuous horizontal slide (keyboard hold or touch drag), normal jump, double jump, **parachute glide** with energy bar.
- **Mountain split** — a tall arched high-rise blocks center; pick a left route, a right route, or thread the glowing arch with a ramp + glide.
- **Hazards** — parked vehicles, lane boulders, cross-street traffic, rockets (warned by a side `⚠`), low-pass airplanes (warned with a `LOW PASS` banner + ground shadow), drones, balloons.
- **Sky** — always-on cloud cover with ground shadows, ambient airplanes, occasional dramatic flyby.
- **Effects** — explosion + debris on death, confetti + win screen on finish, asymmetric camera close-up that smoothly leans around the high-rise and snaps back when crossing it.
- **HUD** — speed meter, parachute energy bar, course progress bar with milestone ticks, biome banner, air-time + bonus pop, "SPEED UP!" flashes.

## Run locally

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default `http://localhost:3000/`).

## Build

```bash
npm run build
npm run preview
```

## Controls

- **Slide left / right** — `←` / `→` (or `A` / `D`), or drag horizontally on touch.
- **Jump** — `↑` / `W` / `Space`, or swipe up.
- **Double jump + parachute** — press jump again mid-air; HOLD jump after the second press to deploy the chute (drains the cyan-purple energy bar; recharges only while airborne without the chute).
- **Duck** — `↓` / `S`, or swipe down.

## Project layout

```
src/
  core/
    game.js              # main game class (rendering, gameplay, HUD, effects)
    input-manager.js     # keyboard + touch
  systems/
    map-generator.js     # seeded procedural course generator (pure data)
  utils/
    constants.js         # GAME_CONFIG values (speeds, physics, biome thresholds, etc.)
  main.js                # entry point
index.html               # HUD markup + CSS
```

## Credits

Built collaboratively with Claude Code. Three.js handles all 3D rendering. No external assets — every mesh, color, and particle is generated procedurally in code.
