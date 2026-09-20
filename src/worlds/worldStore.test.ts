import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIG_STORE,
  DB_VERSION,
  WORLD_STORE,
  WorldStore,
  upgradeSchema,
} from './worldStore.ts';

/**
 * A fake `IDBDatabase` recording what an upgrade did to it.
 *
 * Only the three members `upgradeSchema` touches. A real IndexedDB is not
 * available under `node --test`, and the question here is not whether the
 * browser works -- it is whether the upgrade CREATES ONLY, which is a property
 * of the function and testable without one.
 */
function fakeDb(existing: string[] = []): {
  db: IDBDatabase;
  created: string[];
  deleted: string[];
} {
  const created: string[] = [];
  const deleted: string[] = [];
  const names = new Set(existing);
  const db = {
    objectStoreNames: {
      contains: (name: string) => names.has(name),
    },
    createObjectStore: (name: string) => {
      created.push(name);
      names.add(name);
      return {} as IDBObjectStore;
    },
    deleteObjectStore: (name: string) => {
      deleted.push(name);
      names.delete(name);
    },
  } as unknown as IDBDatabase;
  return { db, created, deleted };
}

// ---------------------------------------------------------------------------
// THE UPGRADE.
//
// THE REGRESSION GUARD for silently deleting every config a user has saved.
//
// `configs` shipped at database version 1. Adding `worlds` means version 2, and
// an `onupgradeneeded` written as a migration -- drop and recreate -- would take
// every existing config with it on the first load after an update, with no
// error and no way back.
// ---------------------------------------------------------------------------

test('upgrading from v1 creates the worlds store and touches nothing else', () => {
  const { db, created, deleted } = fakeDb([CONFIG_STORE]);
  upgradeSchema(db);
  assert.deepEqual(created, [WORLD_STORE], 'only the missing store is created');
  assert.deepEqual(deleted, [], 'nothing may be dropped -- that would be data loss');
});

test('upgrading a fresh database creates both stores', () => {
  const { db, created, deleted } = fakeDb([]);
  upgradeSchema(db);
  assert.deepEqual(created.sort(), [CONFIG_STORE, WORLD_STORE].sort());
  assert.deepEqual(deleted, []);
});

test('the upgrade is idempotent, so running it twice is harmless', () => {
  // Both `idb.ts` and `worldStore.ts` install it; whichever opens first runs it,
  // and a second run must not recreate anything.
  const { db, created, deleted } = fakeDb([CONFIG_STORE, WORLD_STORE]);
  upgradeSchema(db);
  assert.deepEqual(created, [], 'everything already exists');
  assert.deepEqual(deleted, []);
});

test('idb.ts takes the version and the upgrade from here, not from copies', async () => {
  // A mismatch is not a cosmetic bug: whichever module opened with the LOWER
  // version would fail to open at all, and whichever opened with the higher one
  // would run its upgrade against the other's schema.
  //
  // The guarantee is structural -- `idb.ts` IMPORTS these rather than declaring
  // its own -- so this asserts the structure rather than comparing two values
  // that a local redeclaration would keep equal by accident until it didn't.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '..', 'config', 'idb.ts'), 'utf8');

  assert.match(
    source,
    /import \{[^}]*DB_VERSION[^}]*\} from '\.\.\/worlds\/worldStore\.ts'/,
    'idb.ts must import DB_VERSION rather than declaring one',
  );
  assert.match(
    source,
    /import \{[^}]*upgradeSchema[^}]*\} from '\.\.\/worlds\/worldStore\.ts'/,
    'idb.ts must run the shared upgrade, not a second copy of it',
  );
  assert.ok(
    !/const DB_VERSION\s*=/.test(source),
    'a local DB_VERSION would drift from this one silently',
  );
});

test('the database version is past 1, because v1 had no worlds store', () => {
  // A user upgrading from v1 must trigger `onupgradeneeded` so the worlds store
  // is created. Leaving this at 1 would mean it never runs and every world save
  // fails against a store that does not exist.
  assert.ok(DB_VERSION >= 2, `expected at least 2, got ${DB_VERSION}`);
});

// ---------------------------------------------------------------------------
// The store's degraded mode.
// ---------------------------------------------------------------------------

test('a store with no database reports itself unwritable rather than throwing', () => {
  // Private browsing and denied storage must degrade to "worlds cannot be
  // saved", not to a dead app.
  const store = WorldStore.forTesting();
  assert.equal(store.writable, false);
  assert.deepEqual(store.names(), []);
});

test('an unwritable store refuses a save by name', async () => {
  const store = WorldStore.forTesting();
  await assert.rejects(
    () => store.save('anything', {}, null),
    /Saving worlds is unavailable/,
  );
});

test('an unwritable store reads back nothing rather than failing', async () => {
  const store = WorldStore.forTesting(['one']);
  assert.equal(await store.read('one'), null);
});

test('name lookup drives the overwrite prompt', () => {
  const store = WorldStore.forTesting(['Dunes', 'Reef']);
  assert.ok(store.has('Dunes'));
  assert.ok(!store.has('dunes'), 'names are compared exactly, not case-folded');
  assert.ok(!store.has('Missing'));
});
