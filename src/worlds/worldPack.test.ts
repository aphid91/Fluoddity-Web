import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ASSIGNABLE_WORLDS } from '../sand/palette.ts';
import {
  PACK_VERSION,
  WorldPackError,
  isGzip,
  packFileName,
  packId,
  readPack,
  writePack,
} from './worldPack.ts';
import { builtinRef, formatWorldRef, isReservedWorldName, parseWorldRef } from './worldRef.ts';

const WORLD = { id: 'dunes', name: 'Dunes', document: 'dunes.ab12cd34.json', scene: 'dunes.ef56.fwldz' };

test('a written pack reads back', () => {
  const pack = {
    worlds: [WORLD, { id: 'reef', name: 'Reef', document: 'reef.1.json', scene: null }],
    assignments: ['dunes', '', 'reef', ''],
    selectedWorld: 2,
    customSlots: [{ name: 'Sand', document: { v: 8 } }],
  };
  const back = readPack(JSON.parse(writePack(pack)));
  assert.equal(back.version, PACK_VERSION);
  assert.deepEqual(back.worlds, pack.worlds);
  assert.deepEqual(back.assignments, pack.assignments);
  assert.equal(back.selectedWorld, 2);
  assert.equal(back.customSlots[0]?.name, 'Sand');
});

test('an unknown version is refused', () => {
  assert.throws(() => readPack({ version: 99 }), WorldPackError);
  assert.throws(() => readPack('nope'), WorldPackError);
});

test('assignments are padded to every button and drop worlds the pack lacks', () => {
  const back = readPack({ version: PACK_VERSION, worlds: [WORLD], assignments: ['dunes', 'ghost'] });
  assert.equal(back.assignments.length, ASSIGNABLE_WORLDS);
  assert.deepEqual(back.assignments.slice(0, 2), ['dunes', '']);
});

test('the start world must be an assigned button, else Custom', () => {
  const base = { version: PACK_VERSION, worlds: [WORLD], assignments: ['dunes'] };
  assert.equal(readPack({ ...base, selectedWorld: 0 }).selectedWorld, 0);
  assert.equal(readPack({ ...base, selectedWorld: 1 }).selectedWorld, -1, 'empty button');
  assert.equal(readPack({ ...base, selectedWorld: 9 }).selectedWorld, -1, 'out of range');
  assert.equal(readPack(base).selectedWorld, -1, 'absent');
});

test('file names that could leave the pack folder are refused', () => {
  const back = readPack({
    version: PACK_VERSION,
    worlds: [
      { ...WORLD, id: 'a', document: '../secrets.json' },
      { ...WORLD, id: 'b', scene: 'sub/dir.fwldz' },
      { ...WORLD, id: 'c', document: '.hidden' },
      { ...WORLD, id: 'Bad Id' },
      WORLD,
      { ...WORLD, name: 'duplicate id' },
    ],
  });
  assert.deepEqual(back.worlds.map((w) => w.id), ['dunes']);
});

test('pack ids are url-safe and unique', () => {
  assert.equal(packId('Sandy Dunes!', new Set()), 'sandy-dunes');
  assert.equal(packId('Dunes', new Set(['dunes'])), 'dunes-2');
  assert.equal(packId('Dunes', new Set(['dunes', 'dunes-2'])), 'dunes-3');
  assert.equal(packId('???', new Set()), 'world');
  assert.equal(packFileName('dunes', 'ab12', 'fwldz'), 'dunes.ab12.fwldz');
});

test('gzip is recognised by its magic number', () => {
  assert.equal(isGzip(new Uint8Array([0x1f, 0x8b, 8])), true);
  assert.equal(isGzip(new Uint8Array([0x46, 0x57])), false);
  assert.equal(isGzip(new Uint8Array([])), false);
});

test('world references: built-in, library, and empty', () => {
  assert.deepEqual(parseWorldRef('builtin:dunes'), { kind: 'builtin', id: 'dunes' });
  assert.deepEqual(parseWorldRef('My World'), { kind: 'library', name: 'My World' });
  assert.equal(parseWorldRef(''), null);
  assert.equal(parseWorldRef('builtin:'), null);
  assert.equal(formatWorldRef({ kind: 'builtin', id: 'reef' }), 'builtin:reef');
  assert.equal(builtinRef(''), '');
  assert.equal(isReservedWorldName('builtin:x'), true);
  assert.equal(isReservedWorldName('Mine'), false);
});
