/**
 * Byte-level checks on the assembler's uniform packing.
 *
 * The assertions that matter most are the OFF SWITCHES. `assembler.py:102-109`
 * pushes the on/off decision into the value, and on the web that is load
 * bearing twice over: it keeps the 1x1 dummy textures from ever being sampled
 * for real, and it is what keeps `fwidth` inside uniform control flow in
 * `frameAssembly.wgsl`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CameraView } from '../camera/cameraUniforms.ts';
import { DEFAULT_PREFERENCES, type DisplayPreferences } from '../prefs/preferences.ts';
import {
  BLOOM_DOWNSAMPLE_UNIFORM_SIZE,
  BLOOM_UPSAMPLE_UNIFORM_SIZE,
  FRAME_ASSEMBLY_UNIFORM_SIZE,
  NO_OVERLAYS,
  RETICLE_STYLES,
  RETICLE_STYLE_INDEX,
  packBloomDownsampleUniforms,
  packBloomUpsampleUniforms,
  packFrameAssemblyUniforms,
  type OverlayState,
} from './assemblerUniforms.ts';

const VIEW: CameraView = {
  canvasSize: [1024, 768],
  windowSize: [1920, 1080],
  pan: [0.25, -0.5],
  zoom: 2.5,
};

const prefs = (over: Partial<DisplayPreferences> = {}): DisplayPreferences => ({
  ...DEFAULT_PREFERENCES,
  ...over,
});

test('every assembler struct is 16-byte aligned', () => {
  for (const size of [
    BLOOM_DOWNSAMPLE_UNIFORM_SIZE,
    BLOOM_UPSAMPLE_UNIFORM_SIZE,
    FRAME_ASSEMBLY_UNIFORM_SIZE,
  ]) {
    assert.equal(size % 16, 0, `uniform size ${size} is not a multiple of 16`);
  }
});

test('bloom downsample carries texel, threshold and an INT apply flag', () => {
  const on = packBloomDownsampleUniforms([1 / 960, 1 / 540], 0.11, true);
  const f32 = new Float32Array(on);
  assert.equal(f32[0], Math.fround(1 / 960), 'texel x');
  assert.equal(f32[1], Math.fround(1 / 540), 'texel y');
  assert.equal(f32[2], Math.fround(0.11), 'threshold');
  assert.equal(new Int32Array(on)[3], 1, 'apply_threshold true');

  const off = packBloomDownsampleUniforms([1 / 480, 1 / 270], 0.11, false);
  assert.equal(new Int32Array(off)[3], 0, 'apply_threshold false');
});

test('bloom upsample carries texel and radius', () => {
  const f32 = new Float32Array(packBloomUpsampleUniforms([1 / 60, 1 / 33], 1.0));
  assert.equal(f32[0], Math.fround(1 / 60));
  assert.equal(f32[1], Math.fround(1 / 33));
  assert.equal(f32[2], 1.0, 'bloom_radius');
});

test('frame assembly repeats the camera View block verbatim', () => {
  // Same four values the camera pushed, so the overlays land exactly where the
  // image did (`assembler.py:114-121`). A drift here puts the reticle somewhere
  // the brush is not.
  const f32 = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs(), false, NO_OVERLAYS),
  );
  assert.deepEqual([...f32.slice(0, 7)], [1024, 768, 1920, 1080, 0.25, -0.5, 2.5]);
});

test('bloom OFF writes intensity 0 whatever the intensity preference says', () => {
  // `assembler.py:93,109`. The zero is the off switch, and it is what makes the
  // 1x1 dummy binding harmless -- the shader never fetches it.
  const disabled = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs({ bloomEnabled: false, bloomIntensity: 0.9 }), true, NO_OVERLAYS),
  );
  assert.equal(disabled[8], 0.0, 'bloomEnabled false must zero the intensity');

  // ...and enabled-but-zero-intensity is equally off, matching
  // `prefs.bloom_enabled and prefs.bloom_intensity > 0.0`.
  const zeroIntensity = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs({ bloomEnabled: true, bloomIntensity: 0.0 }), true, NO_OVERLAYS),
  );
  assert.equal(zeroIntensity[8], 0.0);
});

test('bloom that failed to build writes intensity 0 even when enabled', () => {
  // `bloom.process()` returns None when its shaders did not compile, and
  // `assembler.py:92-95,104` treats that as "no bloom this frame" rather than
  // as an error -- invariant 5, a compile failure is logged not fatal. On the
  // web the same path also prevents binding a mip texture that does not exist.
  const f32 = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs({ bloomEnabled: true, bloomIntensity: 0.5 }), false, NO_OVERLAYS),
  );
  assert.equal(f32[8], 0.0);
});

test('bloom ON writes the intensity through', () => {
  const f32 = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs({ bloomEnabled: true, bloomIntensity: 0.23 }), true, NO_OVERLAYS),
  );
  assert.equal(f32[8], Math.fround(0.23));
});

test('tonemapSoftness is clamped to >= 0 for asinh_f32', () => {
  // `asinh_f32` uses log(x + sqrt(x*x+1)), which is only asinh for x >= 0.
  // `preferences.py` enforces no lower bound, so the guard lives here. A
  // negative softness would otherwise reach log() of a value below 1 and, at
  // large magnitudes, of a NEGATIVE value -- NaN, and a black screen.
  const f32 = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs({ tonemapSoftness: -4.0 }), false, NO_OVERLAYS),
  );
  assert.equal(f32[10], 0.0);
});

test('field opacity is zero unless the overlay was actually asked for', () => {
  // `assembler.py:126-132`: `show_field` is resolved by the caller from the
  // active tool. Opacity alone is not enough.
  const hidden = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs({ fieldOpacity: 0.8 }), false, NO_OVERLAYS),
  );
  assert.equal(hidden[11], 0.0, 'showField false must zero the opacity');

  const shown: OverlayState = { ...NO_OVERLAYS, showField: true };
  const visible = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs({ fieldOpacity: 0.8 }), false, shown),
  );
  assert.equal(visible[11], Math.fround(0.8));
});

test('the reticle rides its own lanes, style as an INT', () => {
  const overlays: OverlayState = {
    ...NO_OVERLAYS,
    reticleCenter: [0.4, 0.6],
    reticleRadius: 0.031,
    reticleStyle: 'dashed',
    reticleAngle: 0.5,
  };
  const buffer = packFrameAssemblyUniforms(VIEW, prefs(), false, overlays);
  const f32 = new Float32Array(buffer);
  assert.equal(f32[12], Math.fround(0.4), 'reticle center x');
  assert.equal(f32[13], Math.fround(0.6), 'reticle center y');
  assert.equal(f32[14], Math.fround(0.031), 'reticle radius');
  assert.equal(f32[15], Math.fround(0.5), 'draw angle');
  assert.equal(new Int32Array(buffer)[16], RETICLE_STYLE_INDEX.dashed);
});

test('every reticle style packs its own index, and plain is zero', () => {
  // The shader's RETICLE_* constants are the other half of this table. `plain`
  // MUST be 0: this lane held a boolean `reticle_dashed` before, so a stale
  // reader sees 'plain' as false and every decorated style as true -- wrong in
  // an obvious way rather than a subtle one.
  assert.equal(RETICLE_STYLE_INDEX.plain, 0);
  assert.notEqual(RETICLE_STYLE_INDEX.dashed, 0);
  for (const style of RETICLE_STYLES) {
    const buffer = packFrameAssemblyUniforms(VIEW, prefs(), false, {
      ...NO_OVERLAYS,
      reticleStyle: style,
    });
    assert.equal(new Int32Array(buffer)[16], RETICLE_STYLE_INDEX[style], style);
  }
});

test('the two field overlays are gated independently', () => {
  // They share `fieldOpacity` -- one control for how strongly overlays draw --
  // but each has its own flag, because the painting tools force one layer on and
  // the other off. A single gate could not express that.
  const wallsOnly = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs({ fieldOpacity: 0.8 }), false, {
      ...NO_OVERLAYS,
      showField: true,
    }),
  );
  assert.equal(wallsOnly[11], Math.fround(0.8), 'walls opacity');
  assert.equal(wallsOnly[17], 0.0, 'trails must stay dark');

  const trailsOnly = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs({ fieldOpacity: 0.8 }), false, {
      ...NO_OVERLAYS,
      showTrails: true,
    }),
  );
  assert.equal(trailsOnly[11], 0.0, 'walls must stay dark');
  assert.equal(trailsOnly[17], Math.fround(0.8), 'trails opacity');
});

test('the line preview is gated by its own flag, not by being non-zero', () => {
  // A ZERO-LENGTH SEGMENT IS A LEGITIMATE PREVIEW -- it is what the frame the
  // line arms looks like, before the cursor has moved off the anchor. So the
  // enable cannot be inferred from the endpoints, and this asserts it is not.
  const off = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs(), false, NO_OVERLAYS),
  );
  assert.equal(off[18], 0.0, 'no preview means the enable is zero');

  const degenerate = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs(), false, {
      ...NO_OVERLAYS,
      linePreview: { from: [0.5, 0.5], to: [0.5, 0.5] },
    }),
  );
  assert.equal(degenerate[18], 1.0, 'a zero-length preview is still enabled');

  const real = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs(), false, {
      ...NO_OVERLAYS,
      linePreview: { from: [0.25, 0.75], to: [0.5, 0.125] },
    }),
  );
  assert.equal(real[28], Math.fround(0.25), 'anchor x');
  assert.equal(real[29], Math.fround(0.75), 'anchor y');
  assert.equal(real[30], Math.fround(0.5), 'cursor x');
  assert.equal(real[31], Math.fround(0.125), 'cursor y');
});

test('the capture remap defaults to the IDENTITY, never to zero', () => {
  // A scale of zero collapses every fragment onto one texel, so leaving this
  // lane as the buffer's zeros would render the screen as a single flat colour
  // -- on the DEFAULT path, taken every frame that is not a cropped capture.
  const f32 = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs(), false, NO_OVERLAYS),
  );
  assert.equal(f32[24], 1.0, 'capture scale x must default to 1');
  assert.equal(f32[25], 1.0, 'capture scale y must default to 1');
  assert.equal(f32[26], 0.0, 'capture offset x');
  assert.equal(f32[27], 0.0, 'capture offset y');
});

test('the crop box and the capture remap are never both set', () => {
  // They are inverses: the SCREEN pass draws the box and reads the whole
  // source; the CAPTURE pass reads the box's interior and draws nothing. A
  // frame carrying both would burn the annotation into the video it annotates,
  // which is the one thing the recording pass must never do.
  const screen: OverlayState = {
    ...NO_OVERLAYS,
    crop: { halfExtent: [0.25, 0.25] },
  };
  const screenF32 = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs(), false, screen),
  );
  assert.equal(screenF32[22], 1.0, 'crop enabled on the screen pass');
  assert.equal(screenF32[24], 1.0, 'screen pass reads the whole source');

  const capture: OverlayState = {
    ...NO_OVERLAYS,
    capture: { scale: [0.5, 0.5], offset: [0.25, 0.25] },
  };
  const captureF32 = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs(), false, capture),
  );
  assert.equal(captureF32[22], 0.0, 'crop box must NOT be drawn into the video');
  assert.equal(captureF32[24], Math.fround(0.5), 'capture scale x');
  assert.equal(captureF32[26], Math.fround(0.25), 'capture offset x');
});

test('NO_OVERLAYS leaves every overlay switch at exactly zero', () => {
  // Step 5 ships with this: no field texture until Step 9, no cursor until
  // Step 8. Both `if` blocks in the shader must be provably not taken, because
  // the textures behind them are 1x1 dummies.
  const buffer = packFrameAssemblyUniforms(VIEW, prefs({ fieldOpacity: 0.9 }), false, NO_OVERLAYS);
  const f32 = new Float32Array(buffer);
  assert.equal(f32[11], 0.0, 'field_opacity');
  assert.equal(f32[14], 0.0, 'reticle_radius');
  assert.equal(new Int32Array(buffer)[16], 0, 'reticle_dashed');
});

test('the reserved trailing lane is zero', () => {
  // Room for Step 9/10 state. Zero rather than uninitialised so a future reader
  // can tell "unused" from "written and happened to be zero".
  const f32 = new Float32Array(
    packFrameAssemblyUniforms(VIEW, prefs(), false, NO_OVERLAYS),
  );
  assert.deepEqual([...f32.slice(20, 24)], [0, 0, 0, 0]);
});
