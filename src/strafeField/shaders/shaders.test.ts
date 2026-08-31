/**
 * Structural checks on the Strafe Field's brush shader.
 *
 * Nothing here compiles WGSL -- headless Chrome hands back a null adapter. What
 * these cover is the class of mistake a compiler cannot catch, and this shader
 * has an unusual concentration of them: three separate decisions that are
 * correct-looking when wrong and produce no error, no warning and (in two cases)
 * no visible artifact at the default settings.
 *
 * THE Y FLIP IS THE ONE THAT MATTERS. Get it wrong and the field overlay draws
 * the stroke exactly where you painted it while the physics reads its mirror --
 * so the app's own debug view CONFIRMS the bug. There is no screenshot that
 * catches that; only this assertion and the paired browser check do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveIncludes } from '../../../tools/wgslInclude.ts';

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

const SOURCE = stripComments(expand('strafeDraw.wgsl'));

/**
 * This file's OWN body, with `common.wgsl` cut away.
 *
 * Needed because `common.wgsl` legitimately uses `select()` twice
 * (`world_to_uv_bc`, `letterbox_scale`) where both arms are safe to evaluate,
 * and the ban below is about THIS shader's two guards, where they are not. The
 * resolver's `end include` banner is the seam; the banners survive
 * `stripComments` because they are emitted as text, not as `//` lines.
 */
const OWN_BODY = (() => {
  const raw = expand('strafeDraw.wgsl');
  const marker = raw.lastIndexOf('end include');
  const after = marker === -1 ? raw : raw.slice(raw.indexOf('\n', marker) + 1);
  return stripComments(after);
})();

test('strafeDraw expands with common.wgsl included', () => {
  // `aspect_correct_uv` is the one function it takes from there, and the whole
  // reason for the include -- so its absence means the include stopped
  // resolving, not merely that a helper was renamed.
  assert.match(SOURCE, /fn\s+aspect_correct_uv\s*\(/);
});

test('THE V FLIP: the fullscreen quad flips v, exactly as canvas.wgsl does', () => {
  // This pass rasterizes INTO a texture that entityUpdate.wgsl samples through
  // world_to_uv_bc -- the same Y-up mapping get_can uses for the canvas. So the
  // field is on the same side of the rule as canvas.wgsl:
  //
  //   Rasterizing INTO the canvas -> flip.  Sampling it TO the screen -> no flip.
  //
  // Without the flip, strokes deflect particles in the MIRRORED direction while
  // frameAssembly.wgsl's overlay -- which samples with the same unflipped uv the
  // mouse produced -- draws the stroke where you painted it. The overlay
  // confirms the wrong thing, which is why this assertion exists rather than
  // relying on looking at the screen.
  assert.match(
    SOURCE,
    /0\.5\s*-\s*p\.y\s*\*\s*0\.5/,
    'strafeDraw.wgsl must flip v -- see the file header and canvas.wgsl:80',
  );
});

test('strafeDraw does NOT use the shared fullscreen quad', () => {
  // fullscreenQuad.wgsl is unflipped by construction and its header (:12-18)
  // excludes exactly this case. Importing it would silently undo the flip above
  // -- the file would still compile and still cover the screen.
  assert.doesNotMatch(
    expand('strafeDraw.wgsl'),
    /fn\s+fullscreen_vs\s*\(/,
    'strafeDraw.wgsl must carry its own flipped quad, not the shared unflipped one',
  );
});

test('nearest is returned in RAW uv, not the aspect-corrected metric', () => {
  // dist_to_stroke returns a distance in the CORRECTED metric and a point in RAW
  // uv. The asymmetry is load-bearing: the only consumer of `nearest` re-corrects
  // it, so returning it pre-corrected double-applies the correction and skews the
  // repel direction by the aspect ratio.
  //
  // That is CORRECT ON A SQUARE CANVAS -- which is the default -- and silently
  // wrong on every other. No behavioural test at default settings can see it.
  assert.match(
    SOURCE,
    /StrokeHit\s*\(\s*length\s*\([^)]*\)\s*,\s*mix\s*\(\s*a\s*,\s*b\s*,\s*h\s*\)\s*\)/,
    'nearest must be mix(a, b, h) with no aspect_correct_uv wrapping it',
  );
});

test('the degenerate-input guards use if, never select()', () => {
  // select() EVALUATES BOTH ARMS. Here the discarded arms are a divide by zero
  // (denom == 0 on a stroke's first frame) and a normalize of a zero vector
  // (a fragment exactly on the stroke, or a `stroke` mode brush that has not
  // moved).
  //
  // The normalize is the dangerous one: the target is fp16 under ADDITIVE
  // BLENDING, so a single NaN texel is permanent -- it survives every later
  // frame, renders as black in the overlay (indistinguishable from empty), and
  // poisons the physics every sub-step until a clear happens to cover it.
  // Nothing catches that at runtime, which is why it is asserted here.
  // Scoped to this file's own body: common.wgsl uses select() twice, legitimately
  // -- both arms are safe to evaluate there. See OWN_BODY.
  assert.doesNotMatch(
    OWN_BODY,
    /\bselect\s*\(/,
    'strafeDraw.wgsl must not use select() -- it evaluates both arms; use var + if',
  );
  assert.match(OWN_BODY, /if\s*\(\s*denom\s*>\s*0\.0\s*\)/);
  // TWO `len > 0.0` guards now, not one: the diverge/converge normalize and the
  // stroke-direction normalize. Both divide by a length that can be zero.
  assert.equal(
    [...OWN_BODY.matchAll(/if\s*\(\s*len\s*>\s*0\.0\s*\)/g)].length,
    2,
    'both normalizes -- the repel direction and the stroke direction -- need a zero-length guard',
  );
});

test('every brush mode is dispatched, and the numbering matches fieldLayer.ts', () => {
  // The mode constants are declared here and in `BRUSH_MODES`, and the two are
  // only connected by this assertion. A shader that renumbered them would paint
  // in the WRONG MODE -- a plausible-looking picture rather than a broken one,
  // which is the failure this catches.
  for (const [name, index] of [
    ['MODE_DIVERGE', 0],
    ['MODE_CONVERGE', 1],
    ['MODE_STROKE', 2],
    ['MODE_FIXED', 3],
  ] as const) {
    assert.match(
      SOURCE,
      new RegExp(`const\\s+${name}\\s*:\\s*i32\\s*=\\s*${index}\\s*;`),
      `${name} must be ${index}, matching BRUSH_MODES' order in fieldLayer.ts`,
    );
  }
});

test('the four modes share one kernel, one radius and one power term', () => {
  // The modes differ in DIRECTION ONLY. `brush_direction` returns a unit vector
  // and the caller applies the magnitude, which is what guarantees switching mode
  // cannot change how hard the brush feels. A mode that scaled its own return
  // value would break that silently -- it would just feel wrong.
  assert.match(
    SOURCE,
    /fn\s+brush_direction\s*\(/,
    'the per-mode branch must live in brush_direction, with magnitude applied by its caller',
  );
  // Exactly one gaussian in the file, so no mode can have grown its own.
  assert.equal(
    [...SOURCE.matchAll(/exp\s*\(\s*-hit\.dist/g)].length,
    1,
    'one kernel for all four modes',
  );
});

test('the layer selector places the vector in rg or ba, never both', () => {
  // The other half of the layer separation is the pipeline's write mask
  // (LAYER_WRITE_MASK). This half decides which channels the shader targets, and
  // the two must agree: a stroke written to channels the mask discards is a brush
  // that silently draws nothing.
  assert.match(SOURCE, /fn\s+place_in_layer\s*\(/);
  assert.match(SOURCE, /vec4f\s*\(\s*v\s*,\s*0\.0\s*,\s*0\.0\s*\)/, 'walls must land in rg');
  assert.match(SOURCE, /vec4f\s*\(\s*0\.0\s*,\s*0\.0\s*,\s*v\s*\)/, 'trails must land in ba');
});

test('the fragment entry point writes all four channels', () => {
  // It returned a vec2f while the field was rg16float. Returning a vec2f against
  // an rgba16float target is a compile error, so this is really an assertion that
  // the format widening reached the shader -- the one place a stale signature
  // would not show up until the pipeline is built at runtime.
  assert.match(SOURCE, /fn\s+fs_main\s*\([^)]*\)\s*->\s*@location\(0\)\s*vec4f/);
});

test('both discards survive translation', () => {
  // The erase branch's discard is what makes the eraser a circle rather than a
  // full-screen zero-fill; the draw branch's is what makes a zero-power brush a
  // no-op. Losing the first erases the whole field on every erase frame.
  //
  // discard in non-uniform control flow is legal in WGSL -- unlike
  // implicit-derivative sampling, which is what bit Step 5 twice. Asserted so
  // nobody "fixes" these into early returns.
  assert.equal(
    [...SOURCE.matchAll(/\bdiscard\s*;/g)].length,
    2,
    'expected exactly two discards: the eraser rim and the zero-power brush',
  );
});

test('the eraser radius is 2 sigma, matching the reticle', () => {
  // The drawn gaussian's visible extent is roughly 2 sigma, so the eraser
  // matches what you can see -- and the Orchestrator draws the reticle at
  // `2.0 * drawSize` for the same reason. If one changes the other must.
  assert.match(SOURCE, /hit\.dist\s*<\s*draw_size\(\)\s*\*\s*2\.0/);
});

test('the deposit formula matches the desktop, constants and all', () => {
  // `strafe_draw.frag:97`. The /5.0 normalizes draw_power against the top of its
  // 0.1..5.0 slider range, and the trailing /draw_size keeps total painted
  // impulse roughly constant as the footprint shrinks. Both are tuning the A/B
  // is measured against, so a drift here is a drift in what "power 1.0" means.
  //
  // `line_gain()` joins them as a multiplier that is 1.0 for every freehand
  // stroke -- so this is still the desktop's formula wherever the desktop had
  // one, and the line tool is the only caller that changes it.
  assert.match(
    SOURCE,
    /dir\s*\*\s*0\.01\s*\*\s*\(\s*draw_power\(\)\s*\/\s*5\.0\s*\)\s*\*\s*kernel\s*\*\s*line_gain\(\)\s*\/\s*draw_size\(\)/,
  );
});

test('erase_mode is read as a bit-punned i32, not a float compare', () => {
  // One packing convention across the port (`uniforms.ts:29-36`): ints ride in
  // float lanes and come back through bitcast. Read as a float, a 1 is a
  // denormal -- so `> 0.5` would be false and the eraser would silently draw.
  assert.match(SOURCE, /bitcast<i32>\s*\(\s*u\.brush\.z\s*\)\s*!=\s*0/);
});
