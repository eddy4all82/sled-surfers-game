/**
 * Sled Surfers — Main Entry Point
 *
 * Initializes the game engine, sets up the scene, and starts the game loop.
 * This is the file Vite loads from index.html.
 */

import { Game } from './core/game.js';

// Boot the game when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  const game = new Game();
  game.init();
});
