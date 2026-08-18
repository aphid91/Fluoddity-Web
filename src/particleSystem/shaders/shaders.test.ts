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

const SHADERS = [
  'entityUpdate.wgsl',
  'canvas.wgsl',
  'brush.wgsl',
  'rule.wgsl',
  'entityPick.wgsl',
] as const;

/** The two shaders that derive a rule, and so must agree about how. */
const RULE_CONSUMERS = ['entityUpdate.wgsl', 'entityPick.wgsl'] as const;

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

/** How many times `re` matches. `re` must carry the /g flag. */
function count(source: string, re: RegExp): number {
  return [...source.matchAll(re)].length;
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

test('rule.wgsl is the single source of the generate-or-mutate branch', () => {
  // WHAT THIS CATCHES: someone inlining the sentinel branch back into one of
  // the shaders "for clarity", after which the two can silently disagree about
  // what rule an entity obeys. That disagreement is a WRONG ADOPTED RULE, which
  // looks like a legitimate result -- the worst failure mode Step 6 exists to
  // eliminate, and the one ARCHITECTURE.md:715-718 records actually happening.
  //
  // Asserted on the EXPANDED source, so exactly one definition means the
  // include supplied it and nothing redeclared it.
  for (const name of RULE_CONSUMERS) {
    const src = stripComments(expand(name));
    assert.equal(count(src, /fn\s+derive_entity_rule\s*\(/g), 1,
      `${name} must have exactly one derive_entity_rule (from rule.wgsl)`);
    assert.equal(count(src, /fn\s+mutate_rule\s*\(/g), 1,
      `${name} must have exactly one mutate_rule (from rule.wgsl)`);
    assert.equal(count(src, /fn\s+generate_random_centers\s*\(/g), 1,
      `${name} must have exactly one generate_random_centers (from rule.wgsl)`);
    // And the sentinel test appears ONCE -- inside derive_entity_rule, nowhere
    // else. An open-coded copy is the drift this test exists to prevent.
    assert.equal(count(src, /centers\[5\]\.amplitude\s*==\s*vec4f\(0\.0\)/g), 1,
      `${name} open-codes the zero-rule sentinel outside derive_entity_rule`);
  }
});

test('pow(h, 2.0) survives in generate_random_centers', () => {
  // NOT a style check. freq_scale and frequency.x draw from the SAME hash lane,
  // and pow(h,2) differs from h*h by 1 ULP, which the chaotic hash amplifies
  // into a completely different rule (measured: seed 0.3088 vs 0.2605 --
  // mutation.py:149). Now that this rule is READ BACK and adopted into the
  // config on click, "simplifying" this line changes what selection gives you.
  const src = stripComments(expand('rule.wgsl'));
  assert.match(
    src,
    /pow\(hash\(vec2f\(seed,\s*f32\(i\s*\*\s*8\s*\+\s*0\)\)\),\s*2\.0\)/,
    'generate_random_centers must use pow(hash(...), 2.0), not h*h',
  );
});

test('get_cohort takes the entity count as a parameter', () => {
  // rule.wgsl is included by two shaders that bind `entities` with DIFFERENT
  // access qualifiers (read_write in entityUpdate, read in entityPick), so a
  // shared function may not name that binding at all.
  //
  // Reverting this to arrayLength(&entities) COMPILES IN entityUpdate and fails
  // only in entityPick -- i.e. in a browser, not in `npm test`. Hence the
  // assertion here, where it is cheap to see.
  const src = stripComments(expand('rule.wgsl'));
  assert.match(
    src,
    /fn\s+get_cohort\s*\(\s*index\s*:\s*u32\s*,\s*config\s*:\s*ConfigData\s*,\s*entity_count\s*:\s*u32\s*\)/,
    'get_cohort must take (index, config, entity_count)',
  );
  assert.ok(
    !src.includes('arrayLength('),
    'rule.wgsl must name no binding -- it is included by shaders that bind differently',
  );
});

test('every get_cohort call passes arrayLength, not a host-supplied count', () => {
  // The entity buffer is sized exactly entityCount * 32, so arrayLength and the
  // host's count agree TODAY. Passing the host's number anyway would make the
  // physics and the picker able to divide by different values if that ever
  // changed -- and a cohort mismatch means the picker derives a rule the entity
  // is not obeying, silently.
  for (const name of RULE_CONSUMERS) {
    const src = stripComments(expand(name));
    // `(?<!fn\s)` skips the DECLARATION, which the include puts in this same
    // expanded text -- without it the assertion reads the signature's
    // `entity_count: u32` as a call argument and fails on correct code.
    const calls = [...src.matchAll(/(?<!fn\s)get_cohort\s*\(([^)]*\([^)]*\)[^)]*|[^)]*)\)/g)];
    assert.ok(calls.length > 0, `${name} calls get_cohort nowhere`);
    for (const call of calls) {
      assert.match(
        call[1]!,
        /arrayLength\(&entities\)\s*$/,
        `${name}: get_cohort(${call[1]}) must pass arrayLength(&entities)`,
      );
    }
  }
});

test('entityPick.wgsl binds entities READ-ONLY at the project-wide numbers', () => {
  // Read-only is what lets rule.wgsl be shared: a function included by both
  // shaders cannot name a binding they qualify differently, which is why
  // get_cohort takes the entity count as a parameter. Making this read_write
  // "to match entityUpdate" would remove the reason for that signature and
  // invite someone to revert it.
  const source = stripComments(expand('entityPick.wgsl'));
  assert.match(
    source,
    /@group\(0\)\s*@binding\(0\)\s*var<storage,\s*read>\s*entities/,
    'entityPick.wgsl must bind entities READ-ONLY at group 0 binding 0',
  );
  assert.match(
    source,
    /@group\(0\)\s*@binding\(1\)\s*var<storage,\s*read>\s*configs/,
    'entityPick.wgsl must bind configs read-only at group 0 binding 1',
  );
  // Binding 2 mirrors PICK_RESULT_BINDING in picker.py:41.
  assert.match(
    source,
    /@group\(0\)\s*@binding\(2\)\s*var<storage,\s*read_write>\s*result/,
    'the pick result must be read_write at group 0 binding 2',
  );
});

test('the pick reduce pass matches the host dispatch arithmetic', () => {
  // Same hazard as entityUpdate's: workgroupsFor divides by WORKGROUP_SIZE, so
  // a shrunken @workgroup_size under-dispatches and the entities past the last
  // covered index simply stop being pickable -- silently, and only in the tail
  // of the buffer.
  const source = stripComments(expand('entityPick.wgsl'));
  const match = /@compute\s*@workgroup_size\((\d+)\)\s*fn\s+reduce/.exec(source);
  assert.ok(match !== null, 'entityPick.wgsl has no @compute reduce entry point');
  assert.equal(Number(match[1]), WORKGROUP_SIZE, 'reduce disagrees with WORKGROUP_SIZE');
});

test('the pick derive pass runs exactly one invocation', () => {
  // AT 256 THIS WOULD PROBABLY STILL LOOK RIGHT: every thread in the group
  // computes the same rule from the same key, so the 320 bytes they race to
  // write are identical. It would be a data race that happens to be benign on
  // the hardware it was tried on -- the worst kind to leave in. Asserted.
  const source = stripComments(expand('entityPick.wgsl'));
  const match = /@compute\s*@workgroup_size\((\d+)\)\s*fn\s+derive/.exec(source);
  assert.ok(match !== null, 'entityPick.wgsl has no @compute derive entry point');
  assert.equal(Number(match[1]), 1, 'derive must be @workgroup_size(1) -- one invocation');
});

test('the reduce pass never writes a rule, and derive never writes the key', () => {
  // THE INVARIANT THE TWO-PASS SPLIT EXISTS FOR. A thread that loses the
  // atomicMin still runs its next instruction, so a rule written from the
  // reduce pass could be a LOSER's rule -- the picked particle's index would be
  // right and its rule would belong to someone else. Nothing downstream could
  // detect that; it just adopts a plausible wrong rule.
  const source = stripComments(expand('entityPick.wgsl'));
  // Anchored on `fn reduce(` / `fn derive(` -- a bare 'fn derive' also matches
  // `fn derive_entity_rule` from the rule.wgsl include, which sits BEFORE both
  // entry points and would slice the reduce body away to nothing.
  const reduceAt = source.indexOf('fn reduce(');
  const deriveAt = source.indexOf('fn derive(');
  assert.ok(reduceAt !== -1, 'entityPick.wgsl has no reduce entry point');
  assert.ok(deriveAt > reduceAt, 'expected derive to follow reduce in the file');
  const reduce = source.slice(reduceAt, deriveAt);
  const derive = source.slice(deriveAt);

  assert.ok(reduce.includes('atomicMin('), 'reduce must do the atomic reduction');
  assert.ok(
    !/result\.rule\s*=/.test(reduce),
    'reduce writes result.rule -- a losing thread could overwrite the winner',
  );
  assert.ok(
    !/result\.pos_[xy]\s*=/.test(reduce),
    'reduce writes result.pos -- same hazard as the rule',
  );
  assert.ok(
    !reduce.includes('derive_entity_rule('),
    'reduce derives a rule; only the single-invocation derive pass may',
  );
  assert.ok(!derive.includes('atomicMin('), 'derive must not touch the key it reads');
  assert.ok(derive.includes('derive_entity_rule('), 'derive must derive the rule');
});

test('the pick result stores its position as two f32s, not a vec2f', () => {
  // `vec2f` HAS ALIGNMENT 8. At offset 4 -- in the padding that Rule's 16-byte
  // alignment forces -- WGSL cannot place one, so it pushes pos to 8, the pad
  // to 16 and the rule to 32, and the struct becomes 352 bytes. The host
  // allocates PICK_RESULT_SIZE (336) and the driver then rejects the binding as
  // too small, which is a hard error at the first click and NOT visible to
  // `npm test`, since nothing here parses WGSL layout.
  //
  // Two f32s align to 4 and genuinely fit in the hole, so the position is free.
  // Asserted because `vec2f` is the obvious, tidier-looking spelling and this
  // is exactly the kind of thing a later cleanup would "fix".
  const source = stripComments(expand('entityPick.wgsl'));
  const struct = /struct\s+PickResult\s*\{([\s\S]*?)\}/.exec(source);
  assert.ok(struct !== null, 'entityPick.wgsl declares no PickResult struct');
  assert.ok(
    !/vec2f/.test(struct[1]!),
    'PickResult holds a vec2f; its alignment 8 would grow the struct to 352 bytes',
  );
  assert.match(struct[1]!, /pos_x\s*:\s*f32/, 'PickResult must store pos_x as an f32');
  assert.match(struct[1]!, /pos_y\s*:\s*f32/, 'PickResult must store pos_y as an f32');
});

test('entityPick.wgsl selects its config the same way entityUpdate does', () => {
  // A different clamp bound reads a different ConfigData than the physics used,
  // and derives a rule the entity is not obeying. Both must clamp against
  // world_config_count(world), which is why `world` rides in the pick uniform
  // at all -- the desktop's pick shader needs no world.
  const pick = stripComments(expand('entityPick.wgsl'));
  const update = stripComments(expand('entityUpdate.wgsl'));
  const clamp = /configs\[clamp\(config_index,\s*0,\s*world_config_count\(u\.world\)\s*-\s*1\)\]/;
  assert.match(update, clamp, 'entityUpdate.wgsl changed how it selects a config');
  assert.match(pick, clamp, 'entityPick.wgsl must select the config identically');
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

test('entityPick.wgsl reports the cohort, FLOORED, from the derive pass', () => {
  // The host cannot recompute this. `get_cohort` divides by
  // arrayLength(&entities), and reproducing that host-side is the same class of
  // mistake as reproducing the rule -- so the shader reports it.
  //
  // FLOORED HERE, because floor() is what cohort identity means (rule.wgsl:104)
  // and entityUpdate.wgsl stores floor(cohort) into col_params.y. camBrush.wgsl
  // compares the two directly. If this stopped flooring, the raw ramp would
  // differ for every entity in a cohort: two picks on the SAME cohort would
  // report different values, never agree, and the highlight would simply never
  // appear -- a feature that silently does nothing.
  const source = stripComments(expand('entityPick.wgsl'));

  assert.match(
    source,
    /result\.cohort\s*=\s*floor\(\s*cohort\s*\)/,
    'derive must write floor(cohort) into the result',
  );
  // In the struct at the offset pick.ts reads, replacing what was _pad. The
  // field order IS the byte layout, so `cohort` must sit after the two position
  // floats and before the rule.
  assert.match(
    source,
    /struct\s+PickResult\s*\{[^}]*pos_x\s*:\s*f32\s*,\s*pos_y\s*:\s*f32\s*,\s*cohort\s*:\s*f32\s*,\s*rule\s*:\s*Rule/,
    'cohort must occupy the padding lane between pos_y and rule',
  );
});

test('the reduce pass snaps a highlighted-cohort hit to distance zero', () => {
  // THE CONFIRMATION SNAP. Confirming a cohort means clicking any of its
  // members a second time, but they are scattered among everything else -- so a
  // click aimed at one often lands with an unrelated particle a few pixels
  // nearer, and a plain nearest-wins reduce hands the pick to that interloper.
  // The confirmation then silently RE-AIMS at a cohort the user was not
  // pointing at, which is the worst way this feature can fail.
  const source = stripComments(expand('entityPick.wgsl'));
  const reduce = source.slice(
    source.indexOf('fn reduce('),
    source.indexOf('fn derive('),
  );

  assert.match(
    reduce,
    /const\s+CONFIRM_SNAP_FRACTION\s*:\s*f32\s*=|CONFIRM_SNAP_FRACTION/,
    'the snap radius must stay a named constant',
  );
  assert.match(
    reduce,
    /dist_norm\s*=\s*0\.0/,
    'a confirming hit must be treated as distance zero, so it wins the atomicMin',
  );
  // GATED ON BOTH HALVES. Without the radius test the highlighted cohort would
  // win every pick anywhere on screen and the highlight could never be moved by
  // clicking; without the sentinel test an unhighlighted session would compare
  // against -1 and snap nothing, which is harmless but means the guard is not
  // saying what it means.
  assert.match(
    reduce,
    /highlighted_cohort\(\)\s*>=\s*0\.0/,
    'the snap must not apply when no cohort is highlighted',
  );
  assert.match(
    reduce,
    /dist_norm\s*<=\s*CONFIRM_SNAP_FRACTION/,
    'the snap must be limited to a radius around the cursor',
  );
});

test('the reduce pass derives the cohort exactly as derive and entityUpdate do', () => {
  // The snap compares against `col_params.y`, which entityUpdate floors, and
  // against the host's floored uniform. All THREE must agree: a raw cohort here
  // would match nothing (the ramp is continuous), and a different config clamp
  // could select a different ConfigData than the physics used and put a particle
  // in the wrong cohort. Either way the shader snaps to a different set of
  // particles than it is drawing bright, and both halves look self-consistent.
  const source = stripComments(expand('entityPick.wgsl'));
  const reduce = source.slice(
    source.indexOf('fn reduce('),
    source.indexOf('fn derive('),
  );

  assert.match(
    reduce,
    /floor\(\s*get_cohort\(index,\s*config,\s*arrayLength\(&entities\)\)\s*\)/,
    'reduce must floor get_cohort, with the entity count from arrayLength',
  );
  assert.match(
    reduce,
    /configs\[clamp\(config_index,\s*0,\s*world_config_count\(u\.world\)\s*-\s*1\)\]/,
    'reduce must select the config with the same clamp bound the others use',
  );
});
