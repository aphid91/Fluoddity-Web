/**
 * Editor preferences -- the display subset Step 5 needs.
 *
 * TODO(Step 7): this is deliberately incomplete. `preferences/preferences.py`
 * (131 lines) also owns load/save, the `_coerce` type map, the live/disruptive
 * split and `requires_restart`. Step 7 ports all of that to `localStorage` and
 * grows this file; Step 5 needs only the values the camera and assembler read,
 * and needs them without dragging `localStorage` into modules that must stay
 * unit-testable under `node --test`.
 *
 * The three-way split the desktop draws (`preferences.py:1-14`) still holds:
 *
 *   ConfigData   the rule and its parameters. SAVED with a config.
 *   WorldData    global simulation properties. Also saved.
 *   Preferences  how YOUR editor is set up. NOT saved with a config, because
 *                loading a config you downloaded should not dim your screen.
 *
 * Every default below is transcribed from `preferences/preferences.py:35-92`.
 */

export interface DisplayPreferences {
  // --- live ---
  /**
   * Output brightness multiplier. Applied by the assembler, ONCE, for both
   * camera modes -- so TRAIL and PARTICLES respond to it identically.
   */
  readonly brightness: number;
  /** Physics sub-steps per rendered frame. Higher = faster simulation time. */
  readonly physicsSteps: number;

  // --- display: the frame assembly pipeline ---
  /**
   * Highlight compression for the asinh tone curve. Low is more linear
   * (brighter highlights); high is more logarithmic (reveals faint detail).
   *
   * NOTE: the desktop enforces no lower bound. `asinh_f32` in
   * `frameAssembly.wgsl` assumes a non-negative argument, so the packer clamps
   * this to >= 0 rather than the shader carrying a sign-preserving form.
   */
  readonly tonemapSoftness: number;

  /**
   * Temporal supersampling. TARGET samples per displayed frame -- the achieved
   * count is the nearest one that divides `physicsSteps`, so this is a target
   * rather than a promise. See `camera/blurSchedule.ts`.
   *
   * 1 IS THE OFF SWITCH -- one render per frame is what "no blur" means, so
   * there is no separate enable flag to disagree with it.
   */
  readonly motionBlurSamples: number;

  readonly bloomEnabled: boolean;
  /** Brightness cutoff for bloom extraction. Lower glows more widely. */
  readonly bloomThreshold: number;
  readonly bloomIntensity: number;
  /** Spread of the blur kernel, in source-texel units. */
  readonly bloomRadius: number;

  /**
   * Opacity of the strafe field overlay. EXACTLY zero is the off switch: the
   * assembler does not sample the field texture at all below it.
   *
   * Stays 0 until Step 9 builds the field; the uniform lane and the shader
   * branch land in Step 5 so the wiring is done when the texture arrives.
   */
  readonly fieldOpacity: number;
}

/** `preferences/preferences.py`'s dataclass defaults, verbatim. */
export const DEFAULT_PREFERENCES: DisplayPreferences = {
  brightness: 1.0,
  physicsSteps: 30,
  tonemapSoftness: 2.5,
  motionBlurSamples: 1,
  bloomEnabled: false,
  bloomThreshold: 0.11,
  bloomIntensity: 0.23,
  bloomRadius: 1.0,
  fieldOpacity: 0.0,
};
