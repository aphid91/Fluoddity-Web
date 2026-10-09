/**
 * The camera setup: storage that survives anything, a mirror that follows the
 * camera, and gains that switch off cleanly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMERA_MAPPINGS,
  CAMERA_TRAILS_GAIN,
  CAMERA_WALLS_GAIN,
  DEFAULT_WEBCAM_SETTINGS,
  MAX_BLUR_TEXELS,
  MAX_CAMERA_GAIN,
  STUDIO_CAMERA_STORAGE_KEY,
  SAND_CAMERA_STORAGE_KEY,
  blurTexels,
  cameraStrengths,
  loadCameraShown,
  loadWebcamSettings,
  mappingIndex,
  mirrorDefaultFor,
  saveCameraShown,
  saveWebcamSettings,
  withFacing,
} from './webcamSettings.ts';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

test('the studio and sand keep separate setups', () => {
  assert.notEqual(STUDIO_CAMERA_STORAGE_KEY, SAND_CAMERA_STORAGE_KEY);
  const storage = fakeStorage();
  saveWebcamSettings(
    { ...DEFAULT_WEBCAM_SETTINGS, mapping: 'motion' },
    STUDIO_CAMERA_STORAGE_KEY,
    storage,
  );
  assert.equal(loadWebcamSettings(STUDIO_CAMERA_STORAGE_KEY, storage).mapping, 'motion');
  assert.deepEqual(
    loadWebcamSettings(SAND_CAMERA_STORAGE_KEY, storage),
    DEFAULT_WEBCAM_SETTINGS,
  );
});

test('a saved setup round-trips', () => {
  const storage = fakeStorage();
  const settings = Object.freeze({
    mapping: 'edgesAlong',
    destination: 'walls',
    gain: 2.5,
    blur: 0.75,
    direction: 'away',
    facing: 'environment',
    mirror: true,
    preview: false,
  } as const);
  saveWebcamSettings(settings, 'k', storage);
  assert.deepEqual(loadWebcamSettings('k', storage), settings);
});

test('absent, corrupt and hostile storage all give the defaults', () => {
  assert.deepEqual(loadWebcamSettings('k', null), DEFAULT_WEBCAM_SETTINGS);
  assert.deepEqual(loadWebcamSettings('k', fakeStorage()), DEFAULT_WEBCAM_SETTINGS);
  assert.deepEqual(
    loadWebcamSettings('k', fakeStorage({ k: 'not json' })),
    DEFAULT_WEBCAM_SETTINGS,
  );
  assert.deepEqual(
    loadWebcamSettings('k', {
      getItem: () => {
        throw new Error('denied');
      },
    }),
    DEFAULT_WEBCAM_SETTINGS,
  );
  // Writing never throws either.
  saveWebcamSettings(DEFAULT_WEBCAM_SETTINGS, 'k', {
    setItem: () => {
      throw new Error('quota');
    },
  });
});

test('one bad field falls back alone; the rest of the setup survives', () => {
  const storage = fakeStorage({
    k: JSON.stringify({
      mapping: 'telepathy',
      destination: 'walls',
      gain: 99,
      blur: Number.NaN,
      direction: 'away',
    }),
  });
  const loaded = loadWebcamSettings('k', storage);
  assert.equal(loaded.mapping, DEFAULT_WEBCAM_SETTINGS.mapping);
  assert.equal(loaded.destination, 'walls');
  assert.equal(loaded.gain, MAX_CAMERA_GAIN, 'out of range clamps rather than resets');
  assert.equal(loaded.blur, DEFAULT_WEBCAM_SETTINGS.blur);
  assert.equal(loaded.direction, 'away');
});

test('a record with no mirror field takes its facing’s default, not the default facing’s', () => {
  const back = loadWebcamSettings('k', fakeStorage({ k: '{"facing":"environment"}' }));
  assert.equal(back.mirror, false);
  const front = loadWebcamSettings('k', fakeStorage({ k: '{"facing":"user"}' }));
  assert.equal(front.mirror, true);
});

test('switching cameras puts the mirror back to that camera’s default', () => {
  assert.equal(mirrorDefaultFor('user'), true);
  assert.equal(mirrorDefaultFor('environment'), false);

  // An override on the front camera...
  const overridden = { ...DEFAULT_WEBCAM_SETTINGS, facing: 'user' as const, mirror: false };
  // ...does not follow the user to the back camera, and the back camera's own
  // override does not follow them back.
  const back = withFacing(overridden, 'environment');
  assert.equal(back.mirror, false);
  const backOverridden = { ...back, mirror: true };
  assert.equal(withFacing(backOverridden, 'user').mirror, true);
  assert.equal(withFacing(backOverridden, 'environment'), backOverridden, 'same facing is a no-op');
});

test('the camera tab defaults to hidden on every failure path', () => {
  assert.equal(loadCameraShown(null), false);
  assert.equal(loadCameraShown(fakeStorage()), false);
  assert.equal(
    loadCameraShown({
      getItem: () => {
        throw new Error('denied');
      },
    }),
    false,
  );
  const storage = fakeStorage();
  saveCameraShown(true, storage);
  assert.equal(loadCameraShown(storage), true);
  saveCameraShown(false, storage);
  assert.equal(loadCameraShown(storage), false);
});

test('strengths: exactly one destination while running, none while stopped', () => {
  const walls = { ...DEFAULT_WEBCAM_SETTINGS, destination: 'walls' as const, gain: 2 };
  assert.deepEqual(cameraStrengths(walls, true), { walls: 2 * CAMERA_WALLS_GAIN, trails: 0 });
  const trails = { ...walls, destination: 'trails' as const };
  assert.deepEqual(cameraStrengths(trails, true), { walls: 0, trails: 2 * CAMERA_TRAILS_GAIN });
  // Stopped is the shader's off switch: both exactly zero, whatever the gain.
  assert.deepEqual(cameraStrengths(walls, false), { walls: 0, trails: 0 });
  assert.deepEqual(cameraStrengths(trails, false), { walls: 0, trails: 0 });
});

test('mapping indices are the shader’s numbering', () => {
  // cameraMap.wgsl branches on these exact values; this pins the order.
  assert.deepEqual(
    CAMERA_MAPPINGS.map(mappingIndex),
    [0, 1, 2, 3, 4],
  );
  assert.equal(mappingIndex('motion'), 4);
  assert.equal(mappingIndex('edgesAcross'), 2);
});

test('blur is squared onto the texel range and clamped', () => {
  assert.equal(blurTexels(0), 0);
  assert.equal(blurTexels(1), MAX_BLUR_TEXELS);
  assert.equal(blurTexels(0.5), MAX_BLUR_TEXELS / 4);
  assert.equal(blurTexels(-1), 0);
  assert.equal(blurTexels(3), MAX_BLUR_TEXELS);
});
