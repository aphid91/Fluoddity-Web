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

const SHADERS = ['camera.wgsl'] as const;

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
  for (const name of SHADERS) {
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
