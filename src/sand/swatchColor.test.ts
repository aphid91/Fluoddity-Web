import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SATURATION,
  defaultSwatchColor,
  defaultSwatchColors,
  hsvToRgb,
  readSwatchColor,
  swatchColorFromCss,
  swatchColorToCss,
} from './swatchColor.ts';
import { SLOT_COUNT } from './palette.ts';

// ---------------------------------------------------------------------------
// Defaults -- what an uncoloured palette looks like
// ---------------------------------------------------------------------------

test('every default colour is in range', () => {
  for (const color of defaultSwatchColors(SLOT_COUNT)) {
    assert.ok(color.hue >= 0 && color.hue < 1, `hue ${color.hue}`);
    assert.ok(
      color.saturation >= 0 && color.saturation <= 1,
      `saturation ${color.saturation}`,
    );
  }
});

// The point of the golden-angle spacing: the first handful of swatches must be
// obviously different colours, which an even `i / SLOT_COUNT` ramp does not
// achieve (there, neighbours differ by 1/40th of a turn and read as identical).
test('consecutive default hues are far apart on the wheel', () => {
  const colors = defaultSwatchColors(SLOT_COUNT);
  for (let i = 1; i < 8; i++) {
    const a = colors[i - 1]?.hue ?? 0;
    const b = colors[i]?.hue ?? 0;
    // Distance around a circle, so the short way round.
    const raw = Math.abs(a - b);
    const apart = Math.min(raw, 1 - raw);
    assert.ok(apart > 0.15, `swatches ${i - 1} and ${i} are only ${apart} apart`);
  }
});

// Switching INTO Color By Swatch should change WHICH hues appear, not how
// saturated the whole world suddenly is -- the other two modes pin 0.8.
test('the default saturation matches what the other colour modes pin', () => {
  assert.equal(defaultSwatchColor(0).saturation, DEFAULT_SATURATION);
  assert.equal(DEFAULT_SATURATION, 0.8, 'camBrush.wgsl writes 0.8 for the two signal modes');
});

test('defaultSwatchColors survives a degenerate count', () => {
  assert.deepEqual(defaultSwatchColors(0), []);
  assert.deepEqual(defaultSwatchColors(-5), []);
});

// ---------------------------------------------------------------------------
// Reading stored colours
// ---------------------------------------------------------------------------

test('a well-formed colour reads back unchanged', () => {
  assert.deepEqual(readSwatchColor({ hue: 0.25, saturation: 0.5 }), {
    hue: 0.25,
    saturation: 0.5,
  });
});

// A NaN hue reaching the uniform renders the material black with no indication
// why, which looks like the feature being broken rather than a bad save.
test('a non-finite number is rejected rather than clamped', () => {
  assert.equal(readSwatchColor({ hue: Number.NaN, saturation: 0.5 }), null);
  assert.equal(readSwatchColor({ hue: 0.5, saturation: Number.POSITIVE_INFINITY }), null);
});

test('a missing or malformed entry is rejected', () => {
  assert.equal(readSwatchColor(undefined), null);
  assert.equal(readSwatchColor(null), null);
  assert.equal(readSwatchColor('#ff0000'), null);
  assert.equal(readSwatchColor([0.5, 0.5]), null, 'an array is not a colour');
  assert.equal(readSwatchColor({ hue: 0.5 }), null, 'saturation is required');
});

// Hue is periodic, so 1.25 means the same colour as 0.25 -- clamping it to 1.0
// would silently move a hand-edited palette's entry to red.
test('an out-of-range hue WRAPS rather than clamping', () => {
  assert.equal(readSwatchColor({ hue: 1.25, saturation: 1 })?.hue, 0.25);
  assert.equal(readSwatchColor({ hue: -0.25, saturation: 1 })?.hue, 0.75);
});

// Saturation is not periodic, so out of range pins -- which is the obvious
// intended meaning, and rejecting it would discard a palette over an off-by-one.
test('an out-of-range saturation clamps', () => {
  assert.equal(readSwatchColor({ hue: 0, saturation: 5 })?.saturation, 1);
  assert.equal(readSwatchColor({ hue: 0, saturation: -2 })?.saturation, 0);
});

// ---------------------------------------------------------------------------
// The CSS round trip -- what the picker and the swatch chip speak
// ---------------------------------------------------------------------------

test('a colour survives a round trip through CSS', () => {
  // Every eighth of the wheel at a few saturations. The tolerance is one 8-bit
  // step, which is what a hex string can represent.
  for (let h = 0; h < 1; h += 0.125) {
    for (const s of [0.25, 0.5, 0.8, 1]) {
      const back = swatchColorFromCss(swatchColorToCss({ hue: h, saturation: s }));
      assert.ok(back !== null, `#${h} ${s} parsed`);
      const apart = Math.min(Math.abs(back.hue - h), 1 - Math.abs(back.hue - h));
      assert.ok(apart < 0.01, `hue ${h} came back as ${back.hue}`);
      assert.ok(Math.abs(back.saturation - s) < 0.01, `saturation ${s}`);
    }
  }
});

test('swatchColorToCss produces a six-digit hex colour', () => {
  assert.match(swatchColorToCss({ hue: 0, saturation: 1 }), /^#[0-9a-f]{6}$/);
  // Hue 0 at full saturation and value 1 is pure red.
  assert.equal(swatchColorToCss({ hue: 0, saturation: 1 }), '#ff0000');
  // Zero saturation at value 1 is white, whatever the hue.
  assert.equal(swatchColorToCss({ hue: 0.4, saturation: 0 }), '#ffffff');
});

test('swatchColorFromCss rejects anything that is not a hex colour', () => {
  assert.equal(swatchColorFromCss('red'), null);
  assert.equal(swatchColorFromCss('#fff'), null, 'three-digit form is not accepted');
  assert.equal(swatchColorFromCss('rgb(255,0,0)'), null);
  assert.equal(swatchColorFromCss(''), null);
});

// VALUE IS DISCARDED but the hue and saturation are kept, so a dark pick yields
// a bright version of that colour rather than nothing at all.
test('a dark pick keeps its hue and saturation at full value', () => {
  const dark = swatchColorFromCss('#003300');
  assert.ok(dark !== null);
  assert.ok(Math.abs(dark.hue - 1 / 3) < 0.01, 'green');
  assert.equal(dark.saturation, 1, 'a dark saturated colour is fully saturated');
});

// Every hue is equally correct at zero saturation, so this reports 0 and the
// caller keeps whatever hue was stored -- see the note in `swatchColorFromCss`.
test('grey reports zero saturation', () => {
  assert.deepEqual(swatchColorFromCss('#808080'), { hue: 0, saturation: 0 });
  assert.deepEqual(swatchColorFromCss('#000000'), { hue: 0, saturation: 0 });
});

// ---------------------------------------------------------------------------
// hsv2rgb -- the shader's function, transcribed
// ---------------------------------------------------------------------------

// The swatch chip and the particle must be the same colour. The shader cannot
// run under `node --test`, so this pins the transcription against the algebra
// `camBrush.wgsl` uses rather than against the GPU.
test('hsvToRgb matches the shader s one-liner at the primaries', () => {
  const near = (got: number[], want: number[], what: string): void => {
    for (let i = 0; i < 3; i++) {
      assert.ok(
        Math.abs((got[i] ?? 0) - (want[i] ?? 0)) < 1e-6,
        `${what}: ${got.join(',')} != ${want.join(',')}`,
      );
    }
  };
  near(hsvToRgb(0, 1, 1), [1, 0, 0], 'red');
  near(hsvToRgb(1 / 3, 1, 1), [0, 1, 0], 'green');
  near(hsvToRgb(2 / 3, 1, 1), [0, 0, 1], 'blue');
  near(hsvToRgb(0, 0, 1), [1, 1, 1], 'white');
  near(hsvToRgb(0.5, 1, 0), [0, 0, 0], 'value zero is black at any hue');
});

// Hue is periodic in the shader and must be here too, or the chip and the
// particle would disagree for any stored hue at or above 1.
test('hsvToRgb is periodic in hue', () => {
  const a = hsvToRgb(0.25, 1, 1);
  const b = hsvToRgb(1.25, 1, 1);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs((a[i] ?? 0) - (b[i] ?? 0)) < 1e-6, 'a full turn is a no-op');
  }
});
