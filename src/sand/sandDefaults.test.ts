import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_PREFERENCES } from '../prefs/preferences.ts';
import { EMPTY_SESSION } from './session.ts';
import {
  FALLBACK_SAND_WORLD_SIZE,
  readSandDefaults,
  writeSandDefaults,
} from './sandDefaults.ts';

test('the shipped file parses, with nothing rejected', () => {
  const raw = JSON.parse(readFileSync(new URL('./sandDefaults.json', import.meta.url), 'utf8'));
  const { preferences, session } = readSandDefaults(raw);
  assert.equal(typeof preferences.worldSize, 'number');
  assert.equal(typeof session.theme, 'string');
});

test('export then read is the identity for everything the file carries', () => {
  const prefs = { ...DEFAULT_PREFERENCES, worldSize: 0.3, physicsSteps: 9, brightness: 1.5 };
  const session = {
    ...EMPTY_SESSION,
    theme: 'system7',
    visibleCount: 12,
    brushSizes: { ...EMPTY_SESSION.brushSizes, walls: 0, shove: 3 },
  };
  const back = readSandDefaults(JSON.parse(writeSandDefaults(prefs, session)));
  assert.deepEqual({ ...back.preferences }, { ...prefs });
  assert.equal(back.session.theme, 'system7');
  assert.equal(back.session.visibleCount, 12);
  assert.deepEqual(back.session.brushSizes, session.brushSizes);
});

test('a file from before per-tool sizes gives every tool its brushSize', () => {
  const { session } = readSandDefaults({ session: { brushSize: 0 } });
  assert.deepEqual(session.brushSizes, { brush: 0, erase: 0, shove: 0, walls: 0, trails: 0 });
});

test('the file carries settings, not the palette or the world assignments', () => {
  const session = { ...EMPTY_SESSION, worlds: ['Mine'], selectedWorld: 0 };
  const text = JSON.parse(writeSandDefaults(DEFAULT_PREFERENCES, session));
  assert.equal(text.session.worlds, undefined);
  assert.equal(text.session.slots, undefined);
  assert.equal(text.session.selectedWorld, undefined);
});

test('an empty or broken file falls back field by field', () => {
  const empty = readSandDefaults({});
  assert.equal(empty.preferences.worldSize, FALLBACK_SAND_WORLD_SIZE);
  assert.equal(empty.session.theme, EMPTY_SESSION.theme);

  const broken = readSandDefaults({
    preferences: { physicsSteps: 'lots', brightness: 1.25, nonsense: 3 },
    session: { visibleCount: 'many', theme: 'blueprint' },
  });
  assert.equal(broken.preferences.physicsSteps, DEFAULT_PREFERENCES.physicsSteps);
  assert.equal(broken.preferences.brightness, 1.25);
  assert.equal(broken.session.theme, 'blueprint');
  assert.equal(readSandDefaults('not an object').preferences.worldSize, FALLBACK_SAND_WORLD_SIZE);
});
