/**
 * Structural checks on the assembler shaders.
 *
 * The two that earn their keep here are the `asinh` formula and the `fwidth`
 * uniformity guard. A bare `asinh(` would simply fail to compile, so that is
 * not the risk -- the risk is the SIGN-LOSING variant, which compiles fine and
 * is correct for every input this shader currently sees. And the `fwidth`
 * guard is a refactor hazard: the fix that breaks it (hoisting `inside` into
 * the outer condition) looks like a tidy-up.
 *
 * See `camera/shaders/shaders.test.ts` for why these run against the expanded
 * source and strip comments first.
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

function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

const SHADERS = ['frameAssembly.wgsl'] as const;

test('every assembler shader expands with its includes resolved', () => {
  for (const name of SHADERS) {
    const source = expand(name);
    assert.match(source, /fn\s+fullscreen_vs\s*\(/, `${name} is missing the quad`);
    assert.match(
      source,
      /==== begin include: fullscreenQuad\.wgsl ====/,
      `${name} did not include the shared quad`,
    );
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

test('asinh is the NON-NEGATIVE form, spelled out', () => {
  // asinh is not a WGSL builtin. The general identity is
  // sign(x) * log(|x| + sqrt(x*x + 1)); this shader's argument is a length
  // times a clamped-positive preference, so the unsigned form is correct AND
  // cheaper. Asserting the formula rather than merely "a helper exists" is what
  // catches someone rewriting it into something subtly different.
  const source = stripComments(expand('frameAssembly.wgsl'));
  assert.match(
    source,
    /log\s*\(\s*x\s*\+\s*sqrt\s*\(\s*x\s*\*\s*x\s*\+\s*1\.0\s*\)\s*\)/,
    'expected asinh(x) = log(x + sqrt(x*x + 1.0))',
  );
  // No bare builtin call. This would fail to compile, but failing here names
  // the file and the reason.
  assert.ok(
    !/[^_A-Za-z]asinh\s*\(/.test(source.replace(/asinh_f32\s*\(/g, 'HELPER(')),
    'frameAssembly.wgsl must not call a bare asinh() -- it is not a WGSL builtin',
  );
});

test('the tone curve acts on the colour LENGTH, not per channel', () => {
  // Per-channel would desaturate bright regions toward white, because each
  // channel would compress independently. Acting on the length preserves the
  // colour vector's direction -- hue and saturation -- and only scales it.
  const source = stripComments(expand('frameAssembly.wgsl'));
  assert.match(source, /let\s+len\s*=\s*length\s*\(\s*color\s*\)/);
  assert.match(source, /asinh_f32\s*\(\s*len\s*\*\s*softness\s*\)\s*\/\s*\(\s*len\s*\*\s*softness\s*\)/);
});

test('fwidth sits inside branches on UNIFORMS ONLY', () => {
  // WGSL permits derivative builtins only in uniform control flow. Both fwidth
  // calls are nested inside two `if`s, and the outer one must test only
  // uniforms. `inside` is per-fragment and is RIGHT THERE two lines above --
  // hoisting it into the outer condition is the plausible-looking tidy-up that
  // makes this shader fail to compile in a browser, which the Node suite would
  // otherwise never see.
  const source = stripComments(expand('frameAssembly.wgsl'));

  // Take the LAST `if (a || b)` before the first fwidth, not the first one in
  // the file: the expanded source begins with common.wgsl, whose
  // `letterbox_scale` opens with `if (window_res.x <= 0.0 || ...)`. Anchoring
  // on the first match tests the wrong function entirely -- and passes, because
  // that condition happens to reference no per-fragment name either.
  const upToFwidth = source.slice(0, source.indexOf('fwidth'));
  assert.ok(upToFwidth.length > 0, 'expected an fwidth call');
  const guards = [...upToFwidth.matchAll(/if\s*\(([^{]*?\|\|[^{]*?)\)\s*\{/g)];
  assert.ok(guards.length > 0, 'expected an outer `if (a || b)` guarding the fwidth calls');
  const condition = guards[guards.length - 1]![1]!;

  for (const perFragment of ['inside', 'canvas_uv', 'in.uv', 'color']) {
    assert.ok(
      !condition.includes(perFragment),
      `the guard around fwidth reads "${perFragment}", which is PER-FRAGMENT -- ` +
        'that makes the control flow non-uniform and fwidth illegal',
    );
  }
  // Positively: it should be testing the two overlay switches, both uniforms.
  assert.match(condition, /u\.tone\.w/, 'expected the field_opacity switch');
  assert.match(condition, /u\.reticle\.z/, 'expected the reticle_radius switch');
});

test('the dashed ring derives its arc footprint from the RADIAL measure', () => {
  // fwidth(cell) is wrong: atan2 wraps once per revolution, and at that seam
  // the derivative explodes and smears one dash cell into a solid blob.
  // Deriving from fwidth(d) instead is continuous everywhere.
  const source = stripComments(expand('frameAssembly.wgsl'));
  assert.match(
    source,
    /let\s+arc\s*=\s*fwidth\s*\(\s*d\s*\)/,
    'the dash antialiasing must derive from fwidth(d), not fwidth(cell)',
  );
  assert.ok(
    !/fwidth\s*\(\s*cell\s*\)/.test(source),
    'fwidth(cell) explodes at the atan2 seam -- see frame_assembly.frag:137-142',
  );
});

test('every texture read uses textureSampleLevel', () => {
  // The strafe field sample sits inside a branch on `inside`, which is
  // per-fragment -- non-uniform control flow, where implicit-derivative
  // sampling is forbidden. The other two would be legal either way; one form
  // throughout means nobody has to work out which is which.
  const source = stripComments(expand('frameAssembly.wgsl'));
  assert.ok(
    !/[^A-Za-z]textureSample\s*\(/.test(source),
    'frameAssembly.wgsl must not call textureSample -- the field read is in ' +
      'non-uniform control flow',
  );
  assert.equal(
    [...source.matchAll(/textureSampleLevel\s*\(/g)].length,
    3,
    'expected exactly three texture reads: source, bloom, strafe field',
  );
});

test('the overlays run AFTER the tone curve', () => {
  // They are annotations, not part of the image: running the reticle's white
  // through a compressive curve would dim it and make its apparent thickness
  // depend on scene brightness.
  const source = stripComments(expand('frameAssembly.wgsl'));
  const curve = source.indexOf('asinh_f32(len');
  // The CALL, not common.wgsl's declaration of the same function -- the
  // include is expanded above this file's own body, so indexOf on the bare
  // name would find the definition and the ordering would look reversed.
  const overlays = source.search(/let\s+canvas_uv\s*=\s*screen_ndc_to_canvas_uv/);
  assert.ok(curve > 0 && overlays > 0);
  assert.ok(curve < overlays, 'the tone curve must precede the overlay block');
});

test('bloom is composited BEFORE brightness and the curve', () => {
  // Adding light, then exposing it. Both are physical quantities and both must
  // happen while the values still mean energy.
  const source = stripComments(expand('frameAssembly.wgsl'));
  const bloom = source.indexOf('bloom_tex');
  const brightness = source.search(/color\s*\*=\s*u\.tone\.y/);
  const curve = source.indexOf('asinh_f32(len');
  assert.ok(bloom > 0 && brightness > 0 && curve > 0);
  assert.ok(bloom < brightness, 'bloom must be added before brightness');
  assert.ok(brightness < curve, 'brightness must be applied before the tone curve');
});
