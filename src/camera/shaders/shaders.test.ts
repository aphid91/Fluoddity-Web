/**
 * Structural checks on the Step 5 camera shaders.
 *
 * Nothing here compiles WGSL -- that needs a real device, and headless Chrome
 * hands back a null adapter (see "Verification" in web/README.md). What these
 * cover is the class of mistake a compiler would NOT catch, and Step 5's list
 * is different from Step 4's:
 *
 *   - A Y FLIP IN THE WRONG PLACE. `brush.wgsl` negates NDC y; `camBrush.wgsl`,
 *     which otherwise mirrors it, must NOT. Getting that wrong mirrors PARTICLES
 *     relative to TRAIL, which on a roughly symmetric field is easy to miss.
 *   - A WRONG QUAD PERMUTATION. The sprite's kernel is radially symmetric about
 *     the quad centre, so a permuted uv array renders a PIXEL-IDENTICAL sprite.
 *   - A LOST `@interpolate(flat)`. The hue then interpolates across each quad
 *     rather than being constant, which reads as a rendering style choice.
 *   - `textureSample` WHERE `textureSampleLevel` IS REQUIRED. This one WOULD
 *     fail to compile -- but only in a browser, and the test suite runs in Node,
 *     so catching it here is the difference between a red test and a black
 *     screen someone has to bisect.
 *
 * The assertions run against the EXPANDED source, so an include that stopped
 * resolving fails here too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveIncludes } from '../../../tools/wgslInclude.ts';
import {
  COLOR_BY_BEHAVIOR,
  COLOR_BY_COHORT,
  COLOR_BY_SWATCH,
  colorModeIndex,
} from '../../sand/colorMode.ts';
import { SLOT_COUNT } from '../../sand/palette.ts';
import { CAM_BRUSH_SWATCH_COUNT } from '../cameraUniforms.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.join(here, '..', '..', 'shaders');

function expand(name: string): string {
  return resolveIncludes(path.join(here, name), { sharedDir: SHARED_DIR });
}

/** Strip `//` comments so a rule is not "satisfied" by prose about it. */
function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

const SHADERS = ['camera.wgsl', 'camBrush.wgsl'] as const;

/** Shaders that include the shared fullscreen quad. camBrush has its own verts. */
const QUAD_SHADERS = ['camera.wgsl'] as const;

/** Parse a `var name = array<vec2f, 4>(...)` literal into ordered pairs. */
function parseVec2Array(source: string, name: string): string[] {
  const m = new RegExp(`${name}\\s*=\\s*array<vec2f,\\s*4>\\(([^;]*)\\)\\s*;`).exec(source);
  assert.ok(m !== null, `could not find the ${name} array`);
  return [...m[1]!.matchAll(/vec2f\(([^)]*)\)/g)].map((v) =>
    v[1]!.split(',').map((s) => s.trim()).join(','),
  );
}

test('every camera shader expands with common.wgsl included', () => {
  for (const name of SHADERS) {
    const source = expand(name);
    assert.match(source, /struct\s+ConfigData\s*\{/, `${name} is missing ConfigData`);
    assert.match(source, /==== begin include: common\.wgsl ====/, `${name} did not include`);
  }
});

test('the shared fullscreen quad resolves from the sibling-then-shared lookup', () => {
  // `fullscreenQuad.wgsl` lives in src/shaders, not beside these files, so this
  // also proves the resolver's fallback works for a per-module shader directory
  // -- the thing `vite.config.ts` predicted would need no config change.
  for (const name of QUAD_SHADERS) {
    const source = expand(name);
    assert.match(
      source,
      /==== begin include: fullscreenQuad\.wgsl ====/,
      `${name} did not include the shared quad`,
    );
    assert.match(source, /fn\s+fullscreen_vs\s*\(/, `${name} is missing the quad entry point`);
  }
});

test('no GLSL preprocessor directives survive translation', () => {
  for (const name of SHADERS) {
    const source = stripComments(expand(name));
    for (const d of ['#version', '#define', '#ifdef', '#ifndef', '#endif', '#else', '#include']) {
      assert.ok(!source.includes(d), `${name} still contains a GLSL ${d} directive`);
    }
  }
});

test('the fullscreen quad does NOT flip v', () => {
  // `canvas.wgsl:80` flips because it rasterizes INTO the canvas and each
  // fragment must read the texel it is about to write. Every consumer of the
  // shared quad instead SAMPLES the canvas to the screen, where the stored
  // top-left-origin image is already the right way up. A flip here mirrors the
  // whole picture -- and on a roughly symmetric trail field that is easy to
  // miss and would silently poison every A/B comparison.
  const quad = stripComments(expand('camera.wgsl'));
  assert.ok(
    !/0\.5\s*-\s*p\.y\s*\*\s*0\.5/.test(quad),
    'the shared fullscreen quad must NOT flip v (that is canvas.wgsl\'s job alone)',
  );
  assert.match(
    quad,
    /out\.uv\s*=\s*p\s*\*\s*0\.5\s*\+\s*0\.5/,
    'the shared quad must map NDC to uv without a flip',
  );
});

test('camera.wgsl samples through textureSampleLevel, never textureSample', () => {
  // The letterbox early-out puts the sample in NON-UNIFORM control flow, where
  // WGSL forbids implicit-derivative sampling outright. No mips exist, so
  // level 0 is numerically identical -- the same substitution entityUpdate.wgsl
  // makes for the compute stage, arrived at for a different reason.
  const source = stripComments(expand('camera.wgsl'));
  assert.ok(
    !/[^A-Za-z]textureSample\s*\(/.test(source),
    'camera.wgsl must not call textureSample -- the early-out makes flow non-uniform',
  );
  assert.match(source, /textureSampleLevel\s*\(/, 'camera.wgsl should sample the canvas');
});

test('camera.wgsl divides the canvas by CANVAS_VALUE_SCALE', () => {
  // Every canvas reader does. Forgetting it is a 512x too-bright image, which
  // looks like a brightness bug rather than a missing divide -- and would send
  // someone tuning the Brightness preference to compensate.
  assert.match(
    stripComments(expand('camera.wgsl')),
    /\/\s*CANVAS_VALUE_SCALE/,
    'camera.wgsl must divide out the fp16 storage scale',
  );
});

test('camera.wgsl keeps camera.frag\'s 3.1415 literal rather than PI', () => {
  // A ~2e-5 hue rotation, invisible either way -- but the port is verified by
  // eye against the desktop, so gratuitous divergences are worth not having.
  // If this ever intentionally changes, change camera.frag too.
  const source = stripComments(expand('camera.wgsl'));
  assert.match(source, /atan2\([^)]*\)\s*\/\s*3\.1415\s*\//, 'expected the 3.1415 literal');
});

test('camBrush.wgsl builds its quad in STRIP order, offsets and uvs together', () => {
  // The fragment kernel is `gaussian(uv - 0.5)` gated by
  // `length(uv - 0.5) > 0.5` -- RADIALLY SYMMETRIC about the quad centre. A
  // wrong uv permutation therefore renders a PIXEL-IDENTICAL sprite and cannot
  // be caught by looking at it. Both arrays are asserted as ORDERED lists,
  // because the pairing is the thing that must hold.
  const source = stripComments(expand('camBrush.wgsl'));

  assert.deepEqual(
    parseVec2Array(source, 'offsets'),
    ['-size,-size', 'size,-size', '-size,size', 'size,size'],
    'offsets must be in strip order, not cam_brush.vert:46-51\'s fan order',
  );
  assert.deepEqual(
    parseVec2Array(source, 'uv_coords'),
    ['0.0,0.0', '1.0,0.0', '0.0,1.0', '1.0,1.0'],
    'uv_coords must be permuted to match offsets corner for corner',
  );
});

test('camBrush.wgsl does NOT flip Y -- unlike its sibling brush.wgsl', () => {
  // THE most dangerous line in Step 5. `brush.wgsl` negates ndc.y because it
  // rasterizes into the CANVAS, read back through y-up world_to_uv.
  // `camBrush.wgsl` rasterizes into the HDR SCREEN target, whose only
  // correctness partner is camera.wgsl walking the same transform backwards
  // from an unflipped quad -- so the two modes agree only when neither flips.
  //
  // This test exists to catch someone "fixing" camBrush to match brush.
  const source = stripComments(expand('camBrush.wgsl'));
  assert.ok(
    !/-\s*ndc\.y/.test(source),
    'camBrush.wgsl must NOT negate ndc.y -- that is brush.wgsl\'s correction, ' +
      'and it applies because brush writes to the canvas, not to the screen',
  );
  assert.match(
    source,
    /world_to_screen_ndc\s*\(/,
    'camBrush.wgsl must transform through world_to_screen_ndc',
  );
});

test('camBrush.wgsl keeps @interpolate(flat) on col_params', () => {
  // Every vertex of a sprite reads the same entity, so the value is constant
  // across the quad. Dropping the attribute does not error -- the hue simply
  // interpolates across each sprite, which reads as a rendering style choice
  // rather than as a bug, and costs three extra interpolations per fragment.
  assert.match(
    stripComments(expand('camBrush.wgsl')),
    /@interpolate\(flat\)\s+col_params/,
    'col_params must be flat-interpolated (cam_brush.vert:24-28)',
  );
});

test('camBrush.wgsl guards the velocity frame with an if, not select()', () => {
  // `select()` evaluates BOTH arms, and the discarded arm here is
  // `normalize(vec2f(0.0))` -- a divide by zero. The same decision the engine's
  // singularity guards made (web/README.md).
  const source = stripComments(expand('camBrush.wgsl'));
  const fn = /fn\s+to_velocity_frame[\s\S]*?\n\}/.exec(source);
  assert.ok(fn !== null, 'to_velocity_frame should exist');
  assert.ok(
    !/select\s*\(/.test(fn[0]),
    'to_velocity_frame must branch with `if` -- select() would evaluate ' +
      'normalize(vec2f(0.0)) on the zero-velocity path',
  );
  assert.match(fn[0], /if\s*\(\s*dot\(vel,\s*vel\)\s*==\s*0\.0\s*\)/);
});

test('camBrush.wgsl binds entities read-only in the vertex stage', () => {
  // A vertex stage cannot write storage at all, so `read` is not a style
  // choice. The binding numbers must match what camera.ts builds.
  const source = stripComments(expand('camBrush.wgsl'));
  assert.match(source, /@group\(0\)\s*@binding\(0\)\s*var<uniform>/, 'uniform at 0,0');
  assert.match(
    source,
    /@group\(0\)\s*@binding\(1\)\s*var<storage,\s*read>\s+entities/,
    'entities must be group 0 binding 1, read-only',
  );
});

test('camera.wgsl reads the canvas from the SWAPPING bind group', () => {
  // Group 0 is the uniform (bound once); group 1 is the canvas texture, which
  // changes identity every sub-step. Collapsing them into one group would mean
  // rebuilding the uniform binding 30 times a frame for no reason -- and would
  // break the two-slot cache in camera.ts, which keys on the texture view.
  const source = stripComments(expand('camera.wgsl'));
  assert.match(source, /@group\(0\)\s*@binding\(0\)\s*var<uniform>/, 'uniform must be group 0');
  assert.match(
    source,
    /@group\(1\)\s*@binding\(0\)\s*var\s+canvas_texture\s*:\s*texture_2d<f32>/,
    'canvas texture must be group 1 binding 0',
  );
  assert.match(
    source,
    /@group\(1\)\s*@binding\(1\)\s*var\s+canvas_sampler\s*:\s*sampler/,
    'canvas sampler must be group 1 binding 1',
  );
});

test('camBrush.wgsl dims by cohort against a FLOORED value', () => {
  // THE COMPARISON THAT MAKES THE HIGHLIGHT WORK. `col_params.y` is
  // floor(cohort) (entityUpdate.wgsl) and the highlighted cohort arrives
  // already floored by entityPick.wgsl's derive pass, so `==` between them is
  // exact. If either side ever stopped being floored, `get_cohort`'s continuous
  // ramp would make the comparison match nothing and the shader would dim
  // EVERY particle -- a uniformly darker screen, which reads as a brightness
  // bug rather than as a broken highlight.
  const source = stripComments(expand('camBrush.wgsl'));

  assert.match(
    source,
    /const\s+COHORT_DIM\s*:\s*f32\s*=/,
    'the dim factor must stay a single named constant, tweakable in one place',
  );
  assert.match(
    source,
    /const\s+COHORT_WASH\s*:\s*f32\s*=/,
    'the saturation wash must stay a named constant beside the dim',
  );
  assert.match(
    source,
    /highlighted_cohort\(\)\s*>=\s*0\.0/,
    'a negative highlighted cohort is the "no highlight" sentinel',
  );
  assert.match(
    source,
    /col_params\.y\s*!=\s*highlighted_cohort\(\)/,
    'the dim must apply to particles OUTSIDE the highlighted cohort',
  );
});

test('camBrush.wgsl reads the highlighted cohort from a float lane', () => {
  // Not `bitcast<i32>` like the colour mode: cohorts are non-negative floats and
  // the sentinel is a negative one, so the lane carries both facts without a
  // second lane that could disagree with it. cameraUniforms.ts writes f32[13].
  const source = stripComments(expand('camBrush.wgsl'));
  assert.match(
    source,
    /fn\s+highlighted_cohort\(\)\s*->\s*f32\s*\{\s*return\s+u\.flags\.y;/,
    'highlighted_cohort must read flags.y as a plain f32',
  );
});

// ---------------------------------------------------------------------------
// The three colour modes -- the protocol between colorMode.ts and the shader
// ---------------------------------------------------------------------------

test('camBrush.wgsl agrees with colorMode.ts about the mode integers', () => {
  // A DRIFT HERE IS SILENT AND TOTAL: the host would ask for Swatch and the
  // shader would render Cohort, which looks like a colour bug rather than like
  // a protocol mismatch. The values are declared in two languages and this is
  // the only thing holding them together.
  const source = stripComments(expand('camBrush.wgsl'));

  const declared = (name: string): number => {
    const match = new RegExp(`const\\s+${name}\\s*:\\s*i32\\s*=\\s*(-?\\d+)`).exec(source);
    assert.ok(match !== null, `${name} must be declared as an i32 constant`);
    return Number(match[1]);
  };

  assert.equal(declared('MODE_BEHAVIOR'), colorModeIndex(COLOR_BY_BEHAVIOR));
  assert.equal(declared('MODE_COHORT'), colorModeIndex(COLOR_BY_COHORT));
  assert.equal(declared('MODE_SWATCH'), colorModeIndex(COLOR_BY_SWATCH));
});

// Zero is the mode an unwritten uniform buffer reads as, so it must be the one
// that is harmless -- the original look rather than an unrecognised state.
test('the zero mode is Behavior, so an unwritten uniform is harmless', () => {
  assert.equal(colorModeIndex(COLOR_BY_BEHAVIOR), 0);
});

test('camBrush.wgsl sizes its swatch table to the palette', () => {
  // The table is indexed by `config_index`, whose range is SLOT_COUNT. A
  // shorter one reads past the array for every material above the cut.
  const source = stripComments(expand('camBrush.wgsl'));
  const match = /const\s+SWATCH_COLOR_COUNT\s*:\s*i32\s*=\s*(\d+)/.exec(source);
  assert.ok(match !== null, 'SWATCH_COLOR_COUNT must be a named i32 constant');
  assert.equal(Number(match[1]), SLOT_COUNT, 'the shader and the palette disagree');
  assert.equal(
    Number(match[1]),
    CAM_BRUSH_SWATCH_COUNT,
    'the shader and the uniform packer disagree',
  );

  // The declared array must be that long too -- the constant alone is only used
  // for the clamp, so a shorter array would clamp into bounds it does not have.
  assert.match(
    source,
    new RegExp(`swatches\\s*:\\s*array<vec4f,\\s*${SLOT_COUNT}>`),
    `the swatch array must be declared array<vec4f, ${SLOT_COUNT}>`,
  );
});

test('camBrush.wgsl clamps the swatch lookup rather than trusting the index', () => {
  // An unclamped index would be an out-of-bounds uniform read. The dead-particle
  // cull means it is never reached with a negative index, but the clamp is what
  // makes the read safe on its own terms rather than by the caller's good manners.
  const source = stripComments(expand('camBrush.wgsl'));
  assert.match(
    source,
    /u\.swatches\[clamp\(index,\s*0,\s*SWATCH_COLOR_COUNT\s*-\s*1\)\]/,
    'swatch_entry must clamp its index into the table',
  );

  // THROUGH ONE ACCESSOR, so the colour and the coefficients cannot end up
  // describing different slots -- which would be a clamp written twice and
  // drifting, not a missing clamp, and far harder to see.
  assert.equal(
    (source.match(/u\.swatches\[/g) ?? []).length,
    1,
    'the table must be indexed in exactly one place',
  );
});

// ---------------------------------------------------------------------------
// Per-config hue: A * signal + B
// ---------------------------------------------------------------------------

// THE SHAPE OF THE EXPRESSION. Sensitivity is a coefficient and offset a bias,
// which is what makes the slider pair work the way the panel says it does: A
// scales the signal's swing, B decides where on the wheel that swing sits.
// Multiplying the bias in instead would make the two knobs fight -- at A = 0
// every material would collapse to hue 0 no matter where B was set.
test('camBrush.wgsl computes hue as sensitivity * signal + offset', () => {
  const source = stripComments(expand('camBrush.wgsl'));
  assert.match(
    source,
    /hue\s*=\s*ab\.x\s*\*\s*signal\s*\+\s*ab\.y\s*;/,
    'the signal modes must read as A * signal + B',
  );
});

// BOTH COEFFICIENTS MUST COME FROM THE PARTICLE'S OWN SLOT. This is the whole
// point of the change: a single frame-wide sensitivity meant the master square
// coloured every material on screen, and every other square's copy was saved
// and silently ignored.
test('camBrush.wgsl reads both hue coefficients per config_index', () => {
  const source = stripComments(expand('camBrush.wgsl'));
  assert.match(
    source,
    /fn\s+hue_coefficients\(index:\s*i32\)\s*->\s*vec2f\s*\{[^}]*swatch_entry\(index\)\.zw/,
    'hue_coefficients must read the zw lanes of the indexed table entry',
  );
  assert.match(
    source,
    /hue_coefficients\(in\.config_index\)/,
    'the coefficients must be looked up by the particle’s own config index',
  );
});

// THE LANE THAT USED TO HOLD THE FRAME-WIDE SENSITIVITY. Nothing may read it
// again: the packer leaves it at zero, so a reader would silently get a
// sensitivity of 0 and render every material at a flat hue.
test('camBrush.wgsl no longer reads a frame-wide colour sensitivity', () => {
  const source = stripComments(expand('camBrush.wgsl'));
  assert.doesNotMatch(
    source,
    /u\.sprite\.z/,
    'sprite.z held the old per-frame sensitivity and must stay unread',
  );
});

// Swatch mode's colour was CHOSEN by the author. Applying a gain would rotate
// every material off that colour, and a bias would do it a second time.
test('camBrush.wgsl leaves the swatch colour exactly as it was picked', () => {
  const source = stripComments(expand('camBrush.wgsl'));
  assert.match(
    source,
    /hue\s*=\s*picked\.x\s*;/,
    'Swatch mode must use the chosen hue unmodified',
  );
});

// The cohort's spacing is a fixed constant scaled by the config's own A, so the
// populations spread apart as sensitivity rises rather than jumbling.
test('camBrush.wgsl derives the cohort signal from a fixed spacing', () => {
  const source = stripComments(expand('camBrush.wgsl'));
  assert.match(
    source,
    /in\.col_params\.y\s*\*\s*COHORT_COLOR_CONSTANT/,
    'the cohort signal must be the cohort index times the fixed spacing',
  );
});

test('camBrush.wgsl carries config_index flat, not interpolated', () => {
  // A config index is an identity, not a quantity. Interpolated across the quad
  // it would produce indices belonging to no material at all, so the sprite
  // would be painted in a smear of the wrong swatches' colours.
  const source = stripComments(expand('camBrush.wgsl'));
  assert.match(
    source,
    /@interpolate\(flat\)\s*config_index\s*:\s*i32/,
    'config_index must be a flat i32 varying',
  );
});

// Swatch mode is the only one that carries a saturation; the other two pin it.
// If the fragment stage went back to a literal, a swatch colour's saturation
// would be silently discarded and the picker's second axis would do nothing.
test('camBrush.wgsl feeds a variable saturation to hsv2rgb', () => {
  const source = stripComments(expand('camBrush.wgsl'));
  assert.match(
    source,
    /hsv2rgb\(vec3f\(hue,\s*saturation\s*\*\s*wash,\s*1\.0\)\)/,
    'the fragment must use the mode-supplied saturation, not a literal',
  );
});

test('camBrush.wgsl washes saturation on the SAME particles it dims', () => {
  // Two knobs, one condition. Brightness alone reads as "further away"; pulling
  // the colour toward grey as well reads as "not the thing you are looking at".
  // They must be driven by one branch -- a second, independently written
  // condition could drift and desaturate a different set than it darkens, which
  // looks like a palette bug rather than like a broken highlight.
  const source = stripComments(expand('camBrush.wgsl'));

  // Both assignments inside one if-body, in the order the fragment writes them.
  assert.match(
    source,
    /dim\s*=\s*COHORT_DIM\s*;\s*wash\s*=\s*COHORT_WASH\s*;/,
    'the dim and the wash must be set together, under one condition',
  );
  // MULTIPLIED INTO THE SATURATION, not replacing it: a COHORT_WASH of 1.0 has
  // to leave the colour untouched -- the same "1.0 means off" contract
  // COHORT_DIM has. Assigning saturation outright would make 1.0 a
  // full-saturation BOOST on the unhighlighted particles, which is the opposite
  // of what the constant says it does.
  //
  // THE BASE IS NOW A VARIABLE, not the literal 0.8 this used to pin. The two
  // signal modes still set it to exactly 0.8, but Swatch mode carries the
  // saturation its author picked -- so pinning the literal here would forbid
  // the one mode whose second colour axis is the point. What must not change is
  // that the wash SCALES whatever the mode supplied.
  assert.match(
    source,
    /hsv2rgb\(vec3f\(hue,\s*saturation\s*\*\s*wash,/,
    'the wash must scale the mode-supplied saturation rather than replace it',
  );
  // The two signal modes' base, which keeps their output identical to before.
  assert.match(
    source,
    /var\s+saturation\s*=\s*0\.8\s*;/,
    'Behavior and Cohort must keep the 0.8 base they have always had',
  );
});
