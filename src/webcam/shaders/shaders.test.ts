/**
 * Structural checks on the camera shaders. Nothing here compiles WGSL (headless
 * Chrome has no adapter -- `tools/browserCheck.mjs` covers that); these catch
 * the mistakes a compiler would let through.
 *
 * THE V FLIP IS THE ONE THAT MATTERS, as it is for the strafe field. The camera
 * picture is flipped exactly once, reading it in ingest; every other pass works
 * in the field's own v-up space. A second flip anywhere would put the picture
 * upside down on the particles -- and in the preview too, so the preview would
 * agree with the bug rather than reveal it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveIncludes } from '../../../tools/wgslInclude.ts';
import { CAMERA_MAPPINGS } from '../webcamSettings.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.join(here, '..', '..', 'shaders');

function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

/** A shader's OWN body, comments stripped, without what it includes. */
function own(name: string): string {
  return stripComments(fs.readFileSync(path.join(here, name), 'utf8'));
}

const FILES = [
  'cameraIngest.wgsl',
  'cameraBlur.wgsl',
  'cameraMap.wgsl',
  'cameraPreview.wgsl',
];

test('every camera shader expands with the shared fullscreen quad', () => {
  for (const name of FILES) {
    const expanded = resolveIncludes(path.join(here, name), { sharedDir: SHARED_DIR });
    assert.match(expanded, /fn fullscreen_vs/, name);
  }
});

test('ingest flips the camera picture vertically exactly once', () => {
  const flips = own('cameraIngest.wgsl').match(/c\.y\s*=\s*1\.0\s*-\s*c\.y/g) ?? [];
  assert.equal(flips.length, 1);
});

test('no other camera pass flips v', () => {
  for (const name of ['cameraBlur.wgsl', 'cameraMap.wgsl', 'cameraPreview.wgsl']) {
    assert.doesNotMatch(own(name), /1\.0\s*-\s*[a-z_]*\.y\b/, name);
  }
});

test('the passes that feed the particles index by position, not by the quad’s uv', () => {
  // `in.uv` is v-up on the SCREEN; texels by `in.clip` are v-up in the field.
  // Mixing the two in a pass that renders into a texture is the flip again.
  for (const name of ['cameraIngest.wgsl', 'cameraBlur.wgsl', 'cameraMap.wgsl']) {
    const body = own(name);
    assert.doesNotMatch(body, /in\.uv/, name);
    assert.match(body, /in\.clip\.xy/, name);
  }
});

test('the map shader handles every mapping the settings offer', () => {
  const body = own('cameraMap.wgsl');
  // Edges (across), 0, is the fall-through; every other index is named.
  for (let i = 1; i < CAMERA_MAPPINGS.length; i++) {
    assert.match(body, new RegExp(`mapping == ${i}\\b`), `mapping ${i}`);
  }
});

test('the particles skip the camera sample entirely while it is off', () => {
  const body = stripComments(
    fs.readFileSync(
      path.join(here, '..', '..', 'particleSystem', 'shaders', 'entityUpdate.wgsl'),
      'utf8',
    ),
  );
  const fn = body.slice(body.indexOf('fn get_camera'));
  assert.match(fn, /if \(strength == 0\.0\) \{ return vec2f\(0\.0\); \}/);
  // The WORLD's aspect, not the square field's -- see get_camera's comment.
  const call = fn.slice(0, fn.indexOf('}', fn.indexOf('textureSampleLevel')));
  assert.match(call, /world_to_uv_bc\(p, canvas_res\(\), bc\)/);
  // And both destinations call it.
  assert.match(body, /get_camera\(p, bc, camera_walls_strength\(\)\)/);
  assert.match(body, /get_camera\(p, bc, camera_trails_strength\(\)\)/);
});
