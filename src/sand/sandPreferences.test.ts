import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STORAGE_KEY, type PreferenceStorage } from '../prefs/preferences.ts';
import {
  DEFAULT_SAND_WORLD_SIZE,
  SAND_STORAGE_KEY,
  loadSandPreferences,
  saveSandPreferences,
} from './sandPreferences.ts';

function memory(initial: Record<string, string> = {}): PreferenceStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

test('a first run seeds from the studio, at the sand default world size', () => {
  const storage = memory({
    [STORAGE_KEY]: JSON.stringify({ worldSize: 1.0, physicsSteps: 12 }),
  });
  const prefs = loadSandPreferences(storage);
  assert.equal(prefs.worldSize, DEFAULT_SAND_WORLD_SIZE);
  assert.equal(prefs.physicsSteps, 12, 'the rest comes from the studio');
  assert.ok(storage.data[SAND_STORAGE_KEY] !== undefined, 'the seed is saved');
});

test('sand writes its own key and never the studio’s', () => {
  const studio = JSON.stringify({ worldSize: 1.0 });
  const storage = memory({ [STORAGE_KEY]: studio });
  const prefs = loadSandPreferences(storage);
  saveSandPreferences({ ...prefs, worldSize: 0.4 }, storage);
  assert.equal(storage.data[STORAGE_KEY], studio);
  assert.equal(loadSandPreferences(storage).worldSize, 0.4);
});

test('with no storage at all, the default world size still applies', () => {
  assert.equal(loadSandPreferences(null).worldSize, DEFAULT_SAND_WORLD_SIZE);
});
