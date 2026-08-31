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

const SHADERS = [
  'frameAssembly.wgsl',
  'bloomDownsample.wgsl',
  'bloomUpsample.wgsl',
] as const;

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

  // THE OVERLAY BLOCK'S OWN GUARD, found by NESTING rather than by proximity.
  //
  // An earlier version took "the last `if (a || b)` before the first fwidth",
  // which was only ever a proxy for "the block the fwidth is inside". It broke
  // the moment a sibling branch appeared between the two -- the field-sample
  // block `if ((...) && inside)`, which legitimately reads `inside`, CLOSES
  // before any fwidth and so does not guard one at all. The proxy read it as the
  // guard and failed on correct code.
  //
  // So: find the overlay guard by its content, then verify every fwidth in the
  // file sits inside a branch chain that reads no per-fragment name.
  const guardMatch = /if\s*\(([^{]*u\.reticle\.z[^{]*)\)\s*\{/.exec(source);
  assert.ok(guardMatch !== null, 'expected an overlay guard testing u.reticle.z');
  const condition = guardMatch[1]!;

  for (const perFragment of ['inside', 'canvas_uv', 'in.uv', 'color']) {
    assert.ok(
      !condition.includes(perFragment),
      `the guard around fwidth reads "${perFragment}", which is PER-FRAGMENT -- ` +
        'that makes the control flow non-uniform and fwidth illegal',
    );
  }
  // Positively: it should be testing the overlay switches, all uniforms.
  assert.match(condition, /u\.tone\.w/, 'expected the field_opacity switch');
  assert.match(condition, /u\.reticle\.z/, 'expected the reticle_radius switch');

  // AND THE STRONGER FORM: no fwidth may sit inside a branch whose condition
  // names a per-fragment value. Walks the brace nesting and tracks the condition
  // of every open `if`, which is what the proximity heuristic was approximating.
  const openGuards: string[] = [];
  const tokens = [...source.matchAll(/if\s*\(([^{]*?)\)\s*\{|\{|\}|fwidth/g)];
  let depth = 0;
  // Depth at which each open `if` block started, so `}` can pop the right one.
  const guardDepths: number[] = [];
  for (const token of tokens) {
    const text = token[0];
    if (text.startsWith('if')) {
      openGuards.push(token[1]!);
      guardDepths.push(depth);
      depth++;
    } else if (text === '{') {
      depth++;
    } else if (text === '}') {
      depth--;
      if (guardDepths.length > 0 && guardDepths[guardDepths.length - 1] === depth) {
        guardDepths.pop();
        openGuards.pop();
      }
    } else {
      // An fwidth: every enclosing `if` condition must be uniform.
      for (const open of openGuards) {
        for (const perFragment of ['inside', 'canvas_uv', 'in.uv', ' color']) {
          assert.ok(
            !open.includes(perFragment),
            `an fwidth sits inside \`if (${open.trim()})\`, which reads the ` +
              `per-fragment value "${perFragment.trim()}" -- fwidth requires ` +
              'uniform control flow and this will fail to compile in a browser',
          );
        }
      }
    }
  }
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

test('the downsample takes four half-texel taps', () => {
  // Each tap lands exactly between four source texels so bilinear filtering
  // averages them for free -- four samples covering a 4x4 neighbourhood. An
  // offset of 1.0 instead of 0.5 would sample texel centres and lose half the
  // neighbourhood, which reads as a slightly sharper bloom rather than as a bug.
  const source = stripComments(expand('bloomDownsample.wgsl'));
  const offsets = [...source.matchAll(/vec2f\(\s*(-?[01]\.5)\s*,\s*(-?[01]\.5)\s*\)/g)]
    .map((m) => `${m[1]},${m[2]}`);
  assert.deepEqual(offsets, ['-0.5,-0.5', '0.5,-0.5', '-0.5,0.5', '0.5,0.5']);
  assert.match(source, /\*\s*0\.25/, 'the four taps must be averaged');
});

test('the threshold preserves hue rather than clamping per channel', () => {
  // Subtracting from the MAX channel and rescaling keeps the colour vector's
  // direction. Clamping each channel independently would tint bright colours
  // toward white -- a plausible-looking bloom that is subtly wrong.
  const source = stripComments(expand('bloomDownsample.wgsl'));
  assert.match(source, /max\(\s*color\.r\s*,\s*max\(\s*color\.g\s*,\s*color\.b\s*\)\s*\)/);
  assert.match(source, /color\s*\*=\s*max\(0\.0,\s*brightness\s*-\s*u\.params\.z\)/);
});

test('the upsample is a 1-2-1 / 2-4-2 / 1-2-1 tent over 16', () => {
  // Nine taps. A wrong weight is invisible in isolation and changes the
  // falloff's shape, which is exactly what the A/B is asked to judge by eye.
  const source = stripComments(expand('bloomUpsample.wgsl'));
  const weights = [...source.matchAll(/\.rgb\s*\*\s*([0-9.]+)/g)].map((m) => m[1]);
  assert.deepEqual(weights, ['1.0', '2.0', '1.0', '2.0', '4.0', '2.0', '1.0', '2.0', '1.0']);
  assert.match(source, /sum\s*\/=\s*16\.0/, 'the tent must be normalised by 16');
});

test('both bloom shaders read the SOURCE texel size', () => {
  // bloom.py:113,121 takes the texel size from `src`, the level being READ.
  // Using the destination's would halve every offset -- a narrower blur that
  // reads as a tuning difference, not as a bug. The comment is the only place
  // this is recorded, so assert the uniform is at least named for it.
  for (const name of ['bloomDownsample.wgsl', 'bloomUpsample.wgsl']) {
    const source = expand(name);
    assert.match(source, /SOURCE/, `${name} should record that the texel size is the source's`);
  }
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
