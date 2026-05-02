/**
 * InputManager — continuous horizontal control + jump/duck swipes
 *
 * Horizontal:
 *   • Keyboard: holding Left/Right (or A/D) sets `horizontalAxis` to ±1.
 *     Release to settle to 0. The game multiplies it by HORIZONTAL_SPEED
 *     for a continuous slide.
 *   • Touch: while a finger is down, `touchDeltaX` is the live horizontal
 *     drag distance in pixels relative to the touch-start point. The game
 *     converts that into a target X.
 *
 * Vertical (one-shot):
 *   • Up swipe / ArrowUp / W / Space → onSwipe('up')   — jump
 *   • Down swipe / ArrowDown / S    → onSwipe('down') — duck
 */

export class InputManager {
  constructor(element) {
    this.element = element;
    this.onSwipe = null; // callback for 'up' / 'down'

    // Continuous horizontal state
    this.horizontalAxis = 0;        // -1..1 keyboard axis
    this.touchActive = false;
    this.touchStartX = 0;
    this.touchCurrentX = 0;
    this.touchDeltaX = 0;           // signed pixels since touchstart
    this.viewportWidth = window.innerWidth;

    // Jump-held state (true while space/W/up is held, or while finger remains
    // down after a vertical-up swipe). Used by the parachute glide mechanic.
    this.jumpHeld = false;
    this._jumpEmitted = false;      // per-touch latch so a swipe only fires 'up' once

    // Internal keyboard state
    this._leftHeld = false;
    this._rightHeld = false;

    // Touch swipe detection (for up/down)
    this._touchStartY = 0;
    this._touchStartTime = 0;
    this._verticalLocked = false;
    this._horizontalLocked = false;

    this._setupTouch();
    this._setupKeyboard();
    this._setupResize();
  }

  // Public helpers ─────────────────────────────────────────────

  /** Returns true if the player is actively dragging horizontally on touch. */
  isTouchDragging() { return this.touchActive && this._horizontalLocked; }

  // Setup ──────────────────────────────────────────────────────

  _setupResize() {
    window.addEventListener('resize', () => {
      this.viewportWidth = window.innerWidth;
    });
  }

  _setupTouch() {
    this.element.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      this.touchActive = true;
      this.touchStartX = touch.clientX;
      this.touchCurrentX = touch.clientX;
      this.touchDeltaX = 0;
      this._touchStartY = touch.clientY;
      this._touchStartTime = Date.now();
      this._verticalLocked = false;
      this._horizontalLocked = false;
      this._jumpEmitted = false;
    }, { passive: true });

    this.element.addEventListener('touchmove', (e) => {
      if (!this.touchActive) return;
      const touch = e.touches[0];
      const dx = touch.clientX - this.touchStartX;
      const dy = touch.clientY - this._touchStartY;

      // Decide whether this gesture is mostly horizontal (drag) or vertical
      // (one-shot swipe). Once locked, stay in that mode.
      if (!this._horizontalLocked && !this._verticalLocked) {
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
          if (Math.abs(dx) >= Math.abs(dy)) this._horizontalLocked = true;
          else this._verticalLocked = true;
        }
      }

      this.touchCurrentX = touch.clientX;
      this.touchDeltaX = this._horizontalLocked ? dx : 0;

      // Vertical-up swipe fires 'up' immediately so the player can keep the
      // finger pressed for jumpHeld (parachute glide).
      if (this._verticalLocked && dy < -30 && !this._jumpEmitted) {
        this._jumpEmitted = true;
        this.jumpHeld = true;
        this._emit('up');
      }
    }, { passive: true });

    const endTouch = (e) => {
      if (!this.touchActive) return;
      const touch = (e.changedTouches && e.changedTouches[0]) || null;
      const dy = touch ? touch.clientY - this._touchStartY : 0;
      const dt = Date.now() - this._touchStartTime;

      // Quick vertical swipe that didn't already fire an 'up' on touchmove:
      // emit 'up' or 'down' here. (Up is normally emitted mid-swipe so the
      // player can keep their finger held for parachute glide.)
      if (this._verticalLocked && dt < 400 && Math.abs(dy) > 30 && !this._jumpEmitted) {
        this._emit(dy < 0 ? 'up' : 'down');
      }

      this.touchActive = false;
      this.touchDeltaX = 0;
      this._verticalLocked = false;
      this._horizontalLocked = false;
      this.jumpHeld = false;
      this._jumpEmitted = false;
    };
    this.element.addEventListener('touchend', endTouch, { passive: true });
    this.element.addEventListener('touchcancel', endTouch, { passive: true });
  }

  _setupKeyboard() {
    window.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowLeft':
        case 'a':
        case 'A':
          this._leftHeld = true;
          this._refreshAxis();
          break;
        case 'ArrowRight':
        case 'd':
        case 'D':
          this._rightHeld = true;
          this._refreshAxis();
          break;
        case 'ArrowUp':
        case 'w':
        case 'W':
        case ' ':
          this.jumpHeld = true;
          if (!e.repeat) this._emit('up');
          e.preventDefault();
          break;
        case 'ArrowDown':
        case 's':
        case 'S':
          if (!e.repeat) this._emit('down');
          break;
      }
    });

    window.addEventListener('keyup', (e) => {
      switch (e.key) {
        case 'ArrowLeft':
        case 'a':
        case 'A':
          this._leftHeld = false;
          this._refreshAxis();
          break;
        case 'ArrowRight':
        case 'd':
        case 'D':
          this._rightHeld = false;
          this._refreshAxis();
          break;
        case 'ArrowUp':
        case 'w':
        case 'W':
        case ' ':
          this.jumpHeld = false;
          break;
      }
    });

    // Drop the held state if the window loses focus, so the player doesn't
    // get stuck sliding in one direction.
    window.addEventListener('blur', () => {
      this._leftHeld = false;
      this._rightHeld = false;
      this.horizontalAxis = 0;
      this.jumpHeld = false;
    });
  }

  _refreshAxis() {
    this.horizontalAxis =
      (this._rightHeld ? 1 : 0) - (this._leftHeld ? 1 : 0);
  }

  _emit(direction) {
    if (this.onSwipe) this.onSwipe(direction);
  }
}
