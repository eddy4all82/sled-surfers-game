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
