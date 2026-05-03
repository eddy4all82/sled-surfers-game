/**
 * InputManager — continuous horizontal control + jump/duck swipes.
 *
 * Configurable via setKeyBindings({left, right, jump, duck}) and setSwapLR(b).
 * Defaults below match the historical hard-coded keys.
 *
 * Horizontal:
 *   • Keyboard: holding the assigned LEFT/RIGHT keys sets `horizontalAxis`
 *     to ±1. Release to settle to 0. The game multiplies it by
 *     HORIZONTAL_SPEED for a continuous slide.
 *   • Touch: while a finger is down, `touchDeltaX` is the live horizontal
 *     drag distance in pixels relative to the touch-start point.
 *
 * Vertical (one-shot):
 *   • Up swipe / JUMP key  → onSwipe('up')
 *   • Down swipe / DUCK key → onSwipe('down')
 */

const DEFAULT_BINDINGS = {
  left:  ['ArrowLeft',  'a', 'A'],
  right: ['ArrowRight', 'd', 'D'],
  jump:  ['ArrowUp',    'w', 'W', ' '],
  duck:  ['ArrowDown',  's', 'S'],
};

export class InputManager {
  constructor(element) {
    this.element = element;
    this.onSwipe = null;

    this.horizontalAxis = 0;
    this.touchActive = false;
    this.touchStartX = 0;
    this.touchCurrentX = 0;
    this.touchDeltaX = 0;
    this.viewportWidth = window.innerWidth;

    this.jumpHeld = false;
    this._jumpEmitted = false;

    this._leftHeld = false;
    this._rightHeld = false;

    this._touchStartY = 0;
    this._touchStartTime = 0;
    this._verticalLocked = false;
    this._horizontalLocked = false;

    this._swapLR = false;
    // Mobile touch scheme — see setTouchScheme().
    this._touchScheme = 'tap';
    this._bindings = {
      left:  DEFAULT_BINDINGS.left.slice(),
      right: DEFAULT_BINDINGS.right.slice(),
      jump:  DEFAULT_BINDINGS.jump.slice(),
      duck:  DEFAULT_BINDINGS.duck.slice(),
    };
    this._keyToAction = this._buildKeyMap(this._bindings);

    this._setupTouch();
    this._setupKeyboard();
    this._setupResize();
  }

  // ── Public configuration ─────────────────────────────────────

  setKeyBindings(bindings) {
    if (!bindings) return;
    for (const action of ['left', 'right', 'jump', 'duck']) {
      if (Array.isArray(bindings[action]) && bindings[action].length) {
        this._bindings[action] = bindings[action].slice();
      }
    }
    this._keyToAction = this._buildKeyMap(this._bindings);
    // Drop any held state — the keys may have changed under the player's fingers
    this._leftHeld = false;
    this._rightHeld = false;
    this.jumpHeld = false;
    this._refreshAxis();
  }

  setSwapLR(swap) {
    this._swapLR = !!swap;
    this._refreshAxis();
  }

  /**
   * Switch between three touch input schemes (mobile only):
   *   'tap'   — touch-down = jump, touch-and-hold = double jump
   *   'swipe' — vertical swipe-up = jump, swipe-up + hold = double jump
   *   'hold'  — touch + hold ~150 ms = jump, vertical swipe-up = double jump
   */
  setTouchScheme(scheme) {
    if (scheme === 'tap' || scheme === 'swipe' || scheme === 'hold') {
      this._touchScheme = scheme;
    }
  }

  // True when the player's drag should map onto X. Includes the post-jump
  // case so steering left/right during a held parachute glide actually
  // reaches the game (the gesture is vertical-locked at that point but
  // the finger is held and we want lateral input to count).
  isTouchDragging() {
    if (!this.touchActive) return false;
    return this._horizontalLocked || this.jumpHeld;
  }

  // ── Setup ────────────────────────────────────────────────────

  _buildKeyMap(b) {
    const m = new Map();
    for (const action of ['left', 'right', 'jump', 'duck']) {
      for (const k of b[action]) m.set(k, action);
    }
    return m;
  }

  _setupResize() {
    window.addEventListener('resize', () => {
      this.viewportWidth = window.innerWidth;
    });
  }

  _setupTouch() {
    // Touch model:
    //   • TAP (touch + release within 200 ms, < 8 px drift) → single jump.
    //   • TAP & HOLD (touch held > 200 ms with no drag) → fires the first
    //     jump at 200 ms, then a SECOND jump at +250 ms (double jump);
    //     the held finger keeps `jumpHeld = true` so the parachute opens
    //     and stays open until release.
    //   • Horizontal DRAG (> 8 px) → steering only, no jump fires.
    //   • Vertical DRAG DOWN (> 30 px) → duck.
    // After a tap-or-hold has emitted its jump(s), the finger can ALSO
    // drag left/right to steer the airborne character.
    // Block iOS Safari context-menu (long-press preview) on the canvas.
    this.element.addEventListener('contextmenu', (e) => e.preventDefault());
    // Block iOS pinch-zoom gesture events.
    for (const evt of ['gesturestart', 'gesturechange', 'gestureend']) {
      this.element.addEventListener(evt, (e) => e.preventDefault());
    }
    // Suppress iOS double-tap zoom on the canvas (the Safari engine still
    // listens for it even with touch-action:none on some versions).
    let lastTouchEnd = 0;
    this.element.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouchEnd < 350) e.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });

    this.element.addEventListener('touchstart', (e) => {
      if (e.cancelable) e.preventDefault();
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
      this._duckEmitted = false;
      this.jumpHeld = false;

      if (this._touchScheme === 'tap') {
        // INSTANT first jump on touch-down + double jump after 180 ms hold
        this._jumpEmitted = true;
        this.jumpHeld = true;
        this._emit('up');
        this._holdDoubleJumpTimer = setTimeout(() => {
          if (this.touchActive && !this._horizontalLocked && !this._duckEmitted) {
            this._emit('up');
          }
        }, 180);
      } else if (this._touchScheme === 'hold') {
        // First jump fires after 150 ms of holding without drag.
        this.jumpHeld = true;     // flag the press for parachute later
        this._holdJumpTimer = setTimeout(() => {
          if (this.touchActive && !this._horizontalLocked && !this._duckEmitted) {
            this._jumpEmitted = true;
            this._emit('up');
          }
        }, 150);
      }
      // 'swipe' scheme: nothing on touchstart — wait for vertical drag.
    }, { passive: false });

    this.element.addEventListener('touchmove', (e) => {
      if (!this.touchActive) return;
      // Stop iOS rubber-band scroll, edge-swipe back/forward, etc.
      if (e.cancelable) e.preventDefault();
      const touch = e.touches[0];
      const dx = touch.clientX - this.touchStartX;
      const dy = touch.clientY - this._touchStartY;

      if (!this._horizontalLocked && !this._verticalLocked) {
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
          if (Math.abs(dx) >= Math.abs(dy)) {
            this._horizontalLocked = true;
            // It's a drag, not a tap → cancel pending tap-hold jumps
            this._cancelTapHoldTimers();
          } else {
            this._verticalLocked = true;
          }
        }
      }

      this.touchCurrentX = touch.clientX;
      // Horizontal drag is reported when EITHER:
      //   • the gesture is horizontal-locked (regular ground slide), OR
      //   • a jump has already fired and the finger is still down — the
      //     player is mid-air / holding the parachute and now wants to
      //     steer left/right.
      if (this._horizontalLocked || this.jumpHeld) {
        this.touchDeltaX = dx;
      } else {
        this.touchDeltaX = 0;
      }

      // Down-swipe → duck. Cancel any pending jump from the tap-hold timer.
      if (this._verticalLocked && dy > 30 && !this._duckEmitted) {
        this._duckEmitted = true;
        this._cancelTapHoldTimers();
        this._emit('down');
      }

      // Vertical-up swipe handling per scheme:
      //   'swipe' — first up swipe = jump; finger then held arms
      //             parachute / chains a double jump.
      //   'hold'  — vertical up swipe = double jump (if hold-jump
      //             already fired) or first jump.
      //   'tap'   — ignored (taps already handled on touchstart).
      if (this._verticalLocked && dy < -30 && this._touchScheme !== 'tap') {
        if (this._touchScheme === 'swipe' && !this._jumpEmitted) {
          this._jumpEmitted = true;
          this.jumpHeld = true;
          this._emit('up');
          // After the first swipe-up fires, chain a double jump after a
          // brief hold so swipe-up-and-hold reads as double jump.
          this._holdDoubleJumpTimer = setTimeout(() => {
            if (this.touchActive && !this._duckEmitted) this._emit('up');
          }, 180);
          // Reset horizontal origin so subsequent left/right drag steers cleanly
          this.touchStartX = touch.clientX;
          this.touchDeltaX = 0;
        } else if (this._touchScheme === 'hold') {
          // Cancel pending hold-jump (the swipe replaces it as the trigger)
          this._cancelTapHoldTimers();
          this._jumpEmitted = true;
          this.jumpHeld = true;
          this._emit('up');
          this.touchStartX = touch.clientX;
          this.touchDeltaX = 0;
        }
      }
    }, { passive: false });

    const endTouch = () => {
      if (!this.touchActive) return;
      // First jump already fired on touch-down. On release we just stop
      // holding (closes parachute) and clear pending double-jump timer.
      this._cancelTapHoldTimers();
      this.touchActive = false;
      this.touchDeltaX = 0;
      this._verticalLocked = false;
      this._horizontalLocked = false;
      this.jumpHeld = false;
      this._jumpEmitted = false;
      this._duckEmitted = false;
    };
    this.element.addEventListener('touchend', endTouch, { passive: false });
    this.element.addEventListener('touchcancel', endTouch, { passive: false });
  }

  _cancelTapHoldTimers() {
    if (this._holdDoubleJumpTimer) {
      clearTimeout(this._holdDoubleJumpTimer);
      this._holdDoubleJumpTimer = null;
    }
    if (this._holdJumpTimer) {
      clearTimeout(this._holdJumpTimer);
      this._holdJumpTimer = null;
    }
  }

  _setupKeyboard() {
    window.addEventListener('keydown', (e) => {
      const action = this._keyToAction.get(e.key);
      if (!action) return;
      switch (action) {
        case 'left':
          this._leftHeld = true;
          this._refreshAxis();
          break;
        case 'right':
          this._rightHeld = true;
          this._refreshAxis();
          break;
        case 'jump':
          this.jumpHeld = true;
          if (!e.repeat) this._emit('up');
          e.preventDefault();
          break;
        case 'duck':
          if (!e.repeat) this._emit('down');
          break;
      }
    });

    window.addEventListener('keyup', (e) => {
      const action = this._keyToAction.get(e.key);
      if (!action) return;
      switch (action) {
        case 'left':
          this._leftHeld = false;
          this._refreshAxis();
          break;
        case 'right':
          this._rightHeld = false;
          this._refreshAxis();
          break;
        case 'jump':
          this.jumpHeld = false;
          break;
      }
    });

    window.addEventListener('blur', () => {
      this._leftHeld = false;
      this._rightHeld = false;
      this.horizontalAxis = 0;
      this.jumpHeld = false;
    });
  }

  _refreshAxis() {
    const raw = (this._rightHeld ? 1 : 0) - (this._leftHeld ? 1 : 0);
    this.horizontalAxis = this._swapLR ? -raw : raw;
  }

  _emit(direction) {
    if (this.onSwipe) this.onSwipe(direction);
  }
}
