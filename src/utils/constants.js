/**
 * Game configuration constants
 *
 * Tweak these values to adjust gameplay feel.
 * All distances are in Three.js world units.
 */

export const GAME_CONFIG = {
  // Lanes (legacy spawn anchors only — player movement is continuous)
  LANE_WIDTH: 3,           // Distance between spawn anchor X positions
  LANE_COUNT: 3,           // Number of spawn anchors (left, center, right)

  // Continuous horizontal control
  HORIZONTAL_SPEED: 120,    // World units per second (keyboard hold)
  MAX_MOMENTUM: 96,         // Maximum horizontal momentum
  PLAYER_X_MIN: -6,
  PLAYER_X_MAX: 6,
  TOUCH_DRAG_SCALE: 0.025, // World units per pixel of finger drag

  // Speed (units per second)
  INITIAL_SPEED: 15,       // Starting speed
  MAX_SPEED: 60,           // Maximum speed cap
  SPEED_INCREASE: 0.5,     // Speed increase per second
  SPEED_UP_INTERVAL: 200,  // Distance (m) between staged speed bumps
  SPEED_UP_AMOUNT: 4,      // Flat speed added at each interval

  // Physics
  GRAVITY: 30,             // Gravity acceleration for jumps
  JUMP_FORCE: 12,          // Initial jump velocity
  DOUBLE_JUMP_FORCE: 7.2,  // Second-jump boost (~60% of JUMP_FORCE)

  // Parachute glide
  PARACHUTE_GRAVITY_MULT: 0.2,  // Net downward accel multiplier while gliding
  PARACHUTE_SPEED_MULT:   1.2,  // Forward speed boost while gliding
  PARACHUTE_DURATION:     4.0,  // Max seconds the chute can stay open
  PARACHUTE_OPEN_TIME:    0.20, // Seconds for the pop-open animation
  PARACHUTE_CLOSE_TIME:   0.15, // Seconds for the close animation
  PARACHUTE_MAX_ENERGY:   100,  // Energy bar maximum
  PARACHUTE_DRAIN_RATE:   25,   // Energy units consumed per second while open
  PARACHUTE_RECHARGE_RATE:15,   // Energy units gained per second while airborne (no chute)
  PARACHUTE_GROUND_RECHARGE_RATE: 5,  // Slower passive recharge while on the ground (no chute)
  MULTI_JUMP_COST:        20,   // Energy consumed per in-air jump press

  // Sky hazards
  ROCKET_INTERVAL_MIN: 15,
  ROCKET_INTERVAL_MAX: 25,
  ROCKET_WARNING_TIME: 1.5,
  LOW_PASS_INTERVAL_MIN: 30,
  LOW_PASS_INTERVAL_MAX: 45,
  LOW_PASS_WARNING_TIME: 2.0,
  DRONE_SPAWN_START_DISTANCE: 200,
  DRONE_SPAWN_GAP_MIN: 50,
  DRONE_SPAWN_GAP_MAX: 70,
  RAMP_JUMP_FORCE: 26,     // Initial vertical velocity off a ramp
  RAMP_BOOST_DURATION: 1.6, // Seconds of post-ramp speed boost
  RAMP_BOOST_MULT: 1.6,    // Speed multiplier during boost
  AIR_BONUS_PER_SEC: 25,   // Air-time bonus per second airborne
  AIR_HEIGHT_BONUS: 8,     // Extra bonus per unit of peak height

  // Spawning
  OBSTACLE_MIN_GAP: 12,    // Minimum distance between obstacles
  OBSTACLE_MAX_GAP: 25,    // Maximum distance between obstacles
  COIN_GAP: 5,             // Distance between coin rows
  RENDER_DISTANCE: 200,    // How far ahead to spawn objects
  DESPAWN_DISTANCE: 20,    // How far behind before recycling

  // Biomes (distance thresholds in meters)
  BIOME_SNOW_END: 500,     // Snow biome ends at 500m → city
  BIOME_CITY_END: 1000,    // City biome ends at 1000m → tropical

  // Scoring
  COIN_VALUE: 10,          // Points per coin
  DISTANCE_MULTIPLIER: 1,  // Points per meter
};

/**
 * Jana Bunny race-mode tuning. The AI rabbit's behavior; touched only
 * when gameMode === 'jana_bunny'. Sprint Run never reads from this.
 */
export const JANA_BUNNY = {
  // Forward speed tracks the player's CURRENT speed × this multiplier.
  // 0.98 keeps the race close — rabbit slightly faster on the early
  // ramp-up, slightly slower at top speed, so a clean run wins by a
  // small margin and a sloppy run loses. Used as a fallback constant
  // if the player's live speed isn't available.
  RABBIT_SPEED_MULT:     0.98,
  RABBIT_SPEED:           28,    // Fallback world-units/sec (only if env.playerSpeed is missing)
  // Hop modes — three peaks share the SAME time aloft (HOP_TIME), so
  // every hop covers the same forward distance regardless of height.
  // Per-hop gravity is derived: g = 8h / T², initial v.vel = 4h / T.
  //
  //   • LOW    — natural running gait, default
  //   • MEDIUM — obstacle clearance (cars/rocks/signs). Used only when
  //              jumping OVER a ground hazard. After firing, the next
  //              MEDIUM_DECAY_STEPS hops linearly decay back to LOW —
  //              the rabbit settles out of the medium arc instead of
  //              snapping straight back to running.
  //   • MEGA   — building arch threading. 5-second cooldown.
  HOP_TIME:              0.4,    // shared time aloft (s) — fixes forward distance
  HOP_PEAK_LOW:          0.4,    // LOW    peak (m)
  HOP_PEAK_MEDIUM:       2.0,    // MEDIUM peak (m) — replaces old OBSTACLE peak
  HOP_PEAK_MEGA:         5.5,    // MEGA   peak (m)
  // Legacy aliases — old code paths may still reference these names.
  HOP_PEAK_OBSTACLE:     2.0,    // alias of HOP_PEAK_MEDIUM
  HOP_PEAK_HIGH:         2.0,
  HOP_GRAVITY:           34,     // legacy fallback (per-hop gravity now derived)
  MEDIUM_DECAY_STEPS:    2,      // how many hops the post-MEDIUM peak decays over
  MEGA_COOLDOWN_SEC:     5.0,    // Seconds the MEGA jump is unavailable after firing
  // Rabbit body half-extents — used for "the rabbit has mass" checks.
  // The AI inflates obstacle hit-boxes by these to plan jump/swerve
  // placement so the body never touches anything. Scaled with the
  // visual mesh (currently 69% of the original — 60% × 1.15 bump).
  BODY_HALF_W:           0.38,   // half-width along X
  BODY_HALF_L:           0.48,   // half-length along Z
  // Look-ahead window: the rabbit scans this many world-units ahead
  // for upcoming obstacles each frame to plan its next hop / lane.
  LOOKAHEAD_M:           30,
  // Lane swerve threshold: rabbit changes lane when current lane has
  // a blocker within this distance and another lane is clear.
  SWERVE_LOOKAHEAD_M:    25,
  LANE_SWITCH_RATE:      12,     // Lerp rate for lane X transitions (higher = snappier)
  // Coin pickup: rabbit scoops up coins it passes while in its lane.
  COIN_PICKUP_DISTANCE:  1.6,    // World units along Z axis
  COIN_PICKUP_LANE_DX:   0.9,    // Half-width of pickup window across X (lane width is 3)
  // Collision penalty: when a hop fails to clear, the rabbit's speed
  // is throttled briefly so the AI's mistakes have weight.
  COLLISION_PENALTY_SEC: 1.0,    // Seconds the speed cut lasts
  COLLISION_SPEED_MULT:  0.4,    // Multiplier on RABBIT_SPEED during the penalty
};

/**
 * Asset paths — maps asset names to their GLB file locations.
 * These paths are relative to the public/ directory.
 * Update these once you generate assets with the AI workflow.
 */
export const ASSET_PATHS = {
  // Characters
  penguin: 'game_assets/characters/penguin_character.glb',
  sled: 'game_assets/characters/snow_tube_sled.glb',

  // Obstacles
  taxi: 'game_assets/obstacles/vehicles/taxi_cab.glb',
  suv: 'game_assets/obstacles/vehicles/red_suv.glb',
  truck: 'game_assets/obstacles/vehicles/blue_truck.glb',
  bus: 'game_assets/obstacles/vehicles/city_bus.glb',
  airplane: 'game_assets/obstacles/vehicles/airplane.glb',
  balloon: 'game_assets/obstacles/vehicles/hot_air_balloon.glb',
  ramp: 'game_assets/obstacles/ramps/jump_ramp.glb',
  rockLarge: 'game_assets/obstacles/static/rock_barrier_large.glb',
  rockSmall: 'game_assets/obstacles/static/rock_cluster_small.glb',
  barrier: 'game_assets/obstacles/static/traffic_barrier.glb',

  // Environment
  pineTree: 'game_assets/environment/snow/pine_tree_snowy.glb',
  bush: 'game_assets/environment/snow/snowy_bush.glb',
  mountain: 'game_assets/environment/snow/snow_mountain.glb',
  cabin: 'game_assets/environment/snow/wooden_cabin.glb',
  streetLamp: 'game_assets/environment/snow/street_lamp_snow.glb',
  skyscraper: 'game_assets/environment/city/skyscraper_glass.glb',
  officeBuilding: 'game_assets/environment/city/office_building_pink.glb',
  shop: 'game_assets/environment/city/colorful_shop.glb',
  trafficLight: 'game_assets/environment/city/traffic_light.glb',
  palmTree: 'game_assets/environment/tropical/palm_tree.glb',
  spiralTower: 'game_assets/environment/tropical/spiral_tower.glb',

  // Collectibles
  coin: 'game_assets/collectibles/gold_coin.glb',
  magnet: 'game_assets/collectibles/power_up_magnet.glb',
  shield: 'game_assets/collectibles/power_up_shield.glb',
  rocket: 'game_assets/collectibles/power_up_rocket.glb',

  // Terrain
  snowTile: 'game_assets/terrain/snow_ground_tile.glb',
  iceTile: 'game_assets/terrain/ice_ground_tile.glb',
  roadTile: 'game_assets/terrain/road_ground_tile.glb',
};
