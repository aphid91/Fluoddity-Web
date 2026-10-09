/**
 * The load menu's Worlds section: which palettes it lists, and that a swatch
 * read from either shape keeps everything that made it that swatch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CUSTOM_SOURCE,
  OPEN_SOURCE,
  listSwatchSources,
  swatchesFromStored,
  swatchesFromWorld,
  worldRefOfKey,
  worldSourceKey,
} from './swatchSources.ts';
import type { WorldDocument } from '../worlds/worldFormat.ts';

const DOC = { version: 8, configs: [] };
const PINK = { hue: 0.9, saturation: 0.6 };

test('a stored palette keeps slot, name, colour and icon, and drops empty slots', () => {
  const swatches = swatchesFromStored([
    { name: 'Master', document: DOC, color: PINK },
    { name: '', document: null, color: PINK },
    undefined,
    { name: 'Moss', document: DOC, icon: 'data:image/png;base64,AAAA' },
  ]);
  assert.deepEqual(swatches, [
    { slot: 0, name: 'Master', document: DOC, color: PINK },
    { slot: 3, name: 'Moss', document: DOC, icon: 'data:image/png;base64,AAAA' },
  ]);
});

test('a world’s sparse slots come back in slot order with their own indices', () => {
  const world = {
    slots: [
      { slot: 7, name: 'Late', document: DOC, color: PINK },
      { slot: 0, name: 'First', document: DOC, icon: 'https://x/icon.png' },
    ],
  } as unknown as WorldDocument;
  assert.deepEqual(swatchesFromWorld(world), [
    { slot: 0, name: 'First', document: DOC, icon: 'https://x/icon.png' },
    { slot: 7, name: 'Late', document: DOC, color: PINK },
  ]);
});

const WORLDS = [
  { ref: 'builtin:dunes', label: 'Dunes' },
  { ref: 'My World', label: 'My World' },
  { ref: 'Other', label: 'Other' },
];

test('Custom open: the live palette first, then every saved world', () => {
  const sources = listSwatchSources({
    openLabel: 'Custom',
    customIsOpen: true,
    customAvailable: true,
    worlds: WORLDS,
    openRef: null,
  });
  assert.deepEqual(
    sources.map((s) => s.label),
    ['Custom (open)', 'Dunes', 'My World', 'Other'],
  );
  assert.equal(sources[0]!.key, OPEN_SOURCE);
});

test('a saved world open: listed live, its stored copy omitted, Custom offered', () => {
  const sources = listSwatchSources({
    openLabel: 'My World',
    customIsOpen: false,
    customAvailable: true,
    worlds: WORLDS,
    openRef: 'My World',
  });
  assert.deepEqual(
    sources.map((s) => s.label),
    ['My World (open)', 'Custom', 'Dunes', 'Other'],
  );
  assert.equal(sources[1]!.key, CUSTOM_SOURCE);
});

test('an empty Custom is not offered', () => {
  const sources = listSwatchSources({
    openLabel: 'Dunes',
    customIsOpen: false,
    customAvailable: false,
    worlds: WORLDS,
    openRef: 'builtin:dunes',
  });
  assert.ok(!sources.some((s) => s.key === CUSTOM_SOURCE));
  assert.ok(!sources.some((s) => s.label === 'Dunes'), 'the open built-in is offered live only');
});

test('a library world named like a special source cannot collide with it', () => {
  const sources = listSwatchSources({
    openLabel: 'Custom',
    customIsOpen: true,
    customAvailable: false,
    worlds: [
      { ref: 'open', label: 'open' },
      { ref: 'custom', label: 'custom' },
    ],
    openRef: null,
  });
  const keys = sources.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys.slice(1), [worldSourceKey('open'), worldSourceKey('custom')]);
  assert.equal(worldRefOfKey(worldSourceKey('open')), 'open');
  assert.equal(worldRefOfKey(OPEN_SOURCE), null);
  assert.equal(worldRefOfKey(worldSourceKey('builtin:dunes')), 'builtin:dunes');
});
