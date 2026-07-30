/**
 * Structural checks on the Step 4 shaders.
 *
 * Nothing in this suite compiles WGSL -- that needs a real device, and headless
 * Chrome hands back a null adapter (see "Verification" in web/README.md). What
 * these tests cover is the class of mistake a compiler would NOT catch: a
 * binding number that drifted from the project-wide table, a workgroup size
 * that no longer matches the host's dispatch arithmetic, a GLSL preprocessor
 * line that survived translation, or the `textureDimensions` hoist quietly
 * coming undone.
 *
 * Each of those is silent. A wrong workgroup size under-dispatches and leaves a
 * tail of entities frozen; a lost hoist is a pure performance regression at
 * 600k x 30 invocations. Neither errors, and neither is visible in a
 * screenshot.
 *
 * The assertions run against the EXPANDED source -- the text `resolveIncludes`
 * produces, which is what the GPU is handed -- so an include that stopped
 * resolving would fail here too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveIncludes } from '../../../tools/wgslInclude.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.join(here, '..', '..', 'shaders');

import { WORKGROUP_SIZE } from '../dispatch.ts';

function expand(name: string): string {
  return resolveIncludes(path.join(here, name), { sharedDir: SHARED_DIR });
}

const SHADERS = ['entityUpdate.wgsl', 'canvas.wgsl', 'brush.wgsl'] as const;

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

test('every shader expands with common.wgsl included', () => {
  for (const name of SHADERS) {
    const source = expand(name);
    // A struct only common.wgsl declares, so its presence proves the include
    // resolved rather than merely that the file was read.
    assert.match(source, /struct\s+ConfigData\s*\{/, `${name} is missing ConfigData`);
    assert.match(source, /==== begin include: common\.wgsl ====/, `${name} did not include`);
  }
});

test('no GLSL preprocessor directives survive translation', () => {
  // WGSL has no preprocessor. `#include` is resolved by the plugin BEFORE the
  // GPU sees anything, so an expanded source containing any `#` directive means
  // a GLSL line was copied across -- most likely `#version`, or the
  // `#ifdef HARD_FENCE` block, whose live branch entityUpdate.wgsl inlines.
  for (const name of SHADERS) {
    const source = stripComments(expand(name));
    for (const directive of ['#version', '#define', '#ifdef', '#ifndef', '#endif', '#else']) {
      assert.ok(
        !source.includes(directive),
        `${name} still contains a GLSL ${directive} directive`,
      );
    }
    // #include must be gone too -- an unresolved one would reach the GPU as a
    // syntax error, but failing here names the file.
    assert.ok(!source.includes('#include'), `${name} has an unresolved #include`);
  }
});

test('EntityBuffer and ConfigBuffer keep their project-wide binding numbers', () => {
  // common.wgsl:54-56 records these as a comment for coordination. Nothing else
  // checks them, and a shader bound at the wrong number reads another buffer's
  // bytes as Entities -- which does not crash, it just simulates nonsense.
  const entityUpdate = stripComments(expand('entityUpdate.wgsl'));
  assert.match(
    entityUpdate,
    /@group\(0\)\s*@binding\(0\)\s*var<storage,\s*read_write>\s*entities/,
    'entityUpdate.wgsl must bind entities read_write at group 0 binding 0',
  );
  assert.match(
    entityUpdate,
    /@group\(0\)\s*@binding\(1\)\s*var<storage,\s*read>\s*configs/,
    'entityUpdate.wgsl must bind configs read-only at group 0 binding 1',
  );

  // The brush reads the SAME buffer in its vertex stage, so it must be
  // read-only there -- a read_write storage binding is not permitted in a
  // vertex stage at all, and would fail pipeline creation rather than silently.
  const brush = stripComments(expand('brush.wgsl'));
  assert.match(
    brush,
    /var<storage,\s*read>\s*entities/,
    'brush.wgsl must bind entities READ-ONLY (vertex stages cannot write storage)',
  );
});

test('the compute workgroup size matches the host dispatch arithmetic', () => {
  // These live in different files. `workgroupsFor` divides by WORKGROUP_SIZE,
  // so if the shader's @workgroup_size shrinks, the host under-dispatches and
  // the entities past the last covered index simply stop updating -- they
  // freeze mid-flight while everything around them keeps moving, which reads as
  // a physics quirk rather than as a bug.
  const source = stripComments(expand('entityUpdate.wgsl'));
  const match = /@compute\s*@workgroup_size\((\d+)\)/.exec(source);
  assert.ok(match !== null, 'entityUpdate.wgsl has no @compute @workgroup_size(N)');
  assert.equal(
    Number(match[1]),
    WORKGROUP_SIZE,
    'entityUpdate.wgsl @workgroup_size disagrees with WORKGROUP_SIZE in dispatch.ts',
  );
});

test('entityUpdate.wgsl calls no textureDimensions -- the hoist holds', () => {
  // entity_update.glsl calls textureSize() up to five times PER INVOCATION
  // (:151 twice via the sensor taps, :232 once or twice via reset/fence, :384).
  // The port passes the resolution in the uniform instead. Reintroducing a
  // textureDimensions() call is invisible -- same result, same picture -- and
  // costs 600k x 30 extra queries a frame, so it is asserted rather than
  // trusted to review.
  const source = stripComments(expand('entityUpdate.wgsl'));
  assert.ok(
    !source.includes('textureDimensions('),
    'entityUpdate.wgsl calls textureDimensions(); it must read the hoisted ' +
      'canvas_res uniform instead (see uniforms.ts)',
  );
});

test('compute-stage sampling uses textureSampleLevel, never textureSample', () => {
  // A compute entry point has no implicit derivatives, so `textureSample` is
  // not available there at all. Asserted because the GLSL spells both as
  // `texture()`, making this an easy thing to "simplify" back.
  const source = stripComments(expand('entityUpdate.wgsl'));
  assert.ok(
    !/[^A-Za-z]textureSample\(/.test(source),
    'entityUpdate.wgsl uses textureSample(); compute stages need textureSampleLevel()',
  );
  assert.ok(source.includes('textureSampleLevel('), 'expected textureSampleLevel in entityUpdate');
});

test('brush.wgsl builds its quad in triangle-strip order', () => {
  // WebGPU has no triangle-fan. The desktop's fan order is
  // (-,-) (+,-) (+,+) (-,+); a STRIP over that produces a bowtie. The port
  // reorders to (-,-) (+,-) (-,+) (+,+) and permutes the uv array to match.
  //
  // This is asserted because the failure is INVISIBLE: brush.frag's kernel is
  // radially symmetric about the quad centre, so a wrong uv permutation renders
  // a pixel-identical splat. Nothing downstream would ever reveal it.
  const source = stripComments(expand('brush.wgsl'));
  const uvArray = /uv_coords\s*=\s*array<vec2f,\s*4>\(([\s\S]*?)\);/.exec(source);
  assert.ok(uvArray !== null, 'brush.wgsl has no uv_coords array<vec2f, 4>');
  const uvs = [...uvArray[1]!.matchAll(/vec2f\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/g)].map(
    (m) => `${Number(m[1])},${Number(m[2])}`,
  );
  assert.deepEqual(
    uvs,
    ['0,0', '1,0', '0,1', '1,1'],
    'brush.wgsl uv_coords must be in strip order (0,0) (1,0) (0,1) (1,1)',
  );

  // And the offsets must be permuted the same way, or uv no longer names the
  // corner it sits on.
  const offsets = /offsets\s*=\s*array<vec2f,\s*4>\(([\s\S]*?)\);/.exec(source);
  assert.ok(offsets !== null, 'brush.wgsl has no offsets array<vec2f, 4>');
  const signs = [...offsets[1]!.matchAll(/vec2f\(\s*(-?)size\s*,\s*(-?)size\s*\)/g)].map(
    (m) => `${m[1] === '-' ? '-' : '+'}${m[2] === '-' ? '-' : '+'}`,
  );
  assert.deepEqual(
    signs,
    ['--', '+-', '-+', '++'],
    'brush.wgsl offsets must be in strip order matching uv_coords',
  );
});

test('the two canvas-writing stages agree on the Y flip', () => {
  // OpenGL's framebuffer origin is bottom-left; WebGPU's is top-left. The GLSL
  // therefore needs no flip anywhere, and the port needs one in EVERY stage
  // that rasterizes into the canvas -- brush.wgsl (which writes through
  // world_to_ndc) and canvas.wgsl (whose fullscreen quad reads back the texel
  // it writes).
  //
  // Getting either wrong is not a flipped picture, it is a feedback loop that
  // reads the mirrored row: measured as ~3x less canvas energy by sub-step 3
  // and visibly different dynamics. Both are asserted because both were
  // originally wrong.
  const brush = stripComments(expand('brush.wgsl'));
  assert.match(
    brush,
    /vec4f\(\s*ndc\.x\s*,\s*-ndc\.y/,
    'brush.wgsl must negate NDC y so the splat lands where get_can reads',
  );

  const canvas = stripComments(expand('canvas.wgsl'));
  assert.match(
    canvas,
    /0\.5\s*-\s*p\.y\s*\*\s*0\.5/,
    'canvas.wgsl fullscreen quad must flip v so each fragment reads its own texel',
  );
});

test('canvas.wgsl takes no sampler as a function parameter', () => {
  // WGSL forbids it outright, and canvas.frag:18's `getCan(vec2 p, sampler2D
  // sam)` is exactly that. Inlined in the port; asserted so it does not come
  // back as a "cleanup".
  const source = stripComments(expand('canvas.wgsl'));
  assert.ok(
    !/fn\s+\w+\s*\([^)]*:\s*sampler/.test(source),
    'canvas.wgsl passes a sampler as a function parameter, which WGSL forbids',
  );
});
