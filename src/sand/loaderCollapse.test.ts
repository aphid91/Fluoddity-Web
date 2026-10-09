import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOADER_COLLAPSED_STORAGE_KEY,
  loadCollapsedCategories,
  saveCollapsedCategories,
} from './loaderCollapse.ts';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

test('collapsed categories round-trip', () => {
  const storage = fakeStorage();
  saveCollapsedCategories(new Set(['Archive', 'Core']), storage);
  assert.deepEqual([...loadCollapsedCategories(storage)].sort(), ['Archive', 'Core']);
});

test('nothing stored, junk, or a hostile store all mean everything expanded', () => {
  assert.equal(loadCollapsedCategories(null).size, 0);
  assert.equal(loadCollapsedCategories(fakeStorage()).size, 0);
  assert.equal(
    loadCollapsedCategories(fakeStorage({ [LOADER_COLLAPSED_STORAGE_KEY]: '{oops' })).size,
    0,
  );
  assert.deepEqual(
    [...loadCollapsedCategories(fakeStorage({ [LOADER_COLLAPSED_STORAGE_KEY]: '["Core", 3]' }))],
    ['Core'],
  );
  assert.equal(
    loadCollapsedCategories({
      getItem: () => {
        throw new Error('denied');
      },
    }).size,
    0,
  );
  saveCollapsedCategories(new Set(['Core']), {
    setItem: () => {
      throw new Error('quota');
    },
  });
});
