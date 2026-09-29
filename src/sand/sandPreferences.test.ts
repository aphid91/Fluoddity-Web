import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PREFERENCES,
  STORAGE_KEY,
  type PreferenceStorage,
} from '../prefs/preferences.ts';
import {
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

const SEED = { ...DEFAULT_PREFERENCES, worldSize: 0.15, physicsSteps: 7 };

test('a first run takes the seed, not the studio’s record, and saves it', () => {
  const storage = memory({
    [STORAGE_KEY]: JSON.stringify({ worldSize: 1.0, physicsSteps: 12 }),
  });
  const prefs = loadSandPreferences(SEED, storage);
  assert.equal(prefs.worldSize, 0.15);
  assert.equal(prefs.physicsSteps, 7, 'nothing comes from the studio');
  assert.ok(storage.data[SAND_STORAGE_KEY] !== undefined, 'the seed is saved');
});

test('a returning visitor keeps their own record, not the seed', () => {
  const storage = memory({ [SAND_STORAGE_KEY]: JSON.stringify({ worldSize: 0.4 }) });
  assert.equal(loadSandPreferences(SEED, storage).worldSize, 0.4);
});

test('sand writes its own key and never the studio’s', () => {
  const studio = JSON.stringify({ worldSize: 1.0 });
  const storage = memory({ [STORAGE_KEY]: studio });
  const prefs = loadSandPreferences(SEED, storage);
  saveSandPreferences({ ...prefs, worldSize: 0.4 }, storage);
  assert.equal(storage.data[STORAGE_KEY], studio);
  assert.equal(loadSandPreferences(SEED, storage).worldSize, 0.4);
});

test('with no storage at all, the seed applies', () => {
  assert.equal(loadSandPreferences(SEED, null).physicsSteps, 7);
});
