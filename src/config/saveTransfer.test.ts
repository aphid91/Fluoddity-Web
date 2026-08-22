/**
 * Tests for moving saves between IndexedDB and a folder.
 *
 * ## WHAT IS WORTH ASSERTING HERE
 *
 * Not the copy. Export writes the stored document out and import reads it back
 * in, and a test that a `JSON.parse(JSON.stringify(x))` round-trips is a test of
 * the JSON implementation. What earns a case is every place this module makes a
 * DECISION the user would not see being made wrong:
 *
 *   - **The document is not rewritten.** The whole design rests on a save
 *     already being a v8 file (`idb.ts:8-15`). A round-trip that silently
 *     normalized a field would break the one invariant the feature is built on,
 *     and would look like nothing at all until a config loaded differently.
 *   - **Collisions.** Skipping is silent by request, so a rule that skipped the
 *     wrong file would be invisible -- an overwritten save is not recoverable
 *     and not announced.
 *   - **Validation.** A malformed file must be named at import, not discovered
 *     later as a `ConfigFormatError` naming a category.
 *
 * The DOM halves (`ui/saveFolder.ts`, the picker, the download) are not tested:
 * they are the thin edge this module exists to keep logic out of.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeSimulationConfig, makeWorldSettings } from '../particleSystem/config.ts';
import { toDocument } from './persistence.ts';
import { describeImport, exportFiles, planImport } from './saveTransfer.ts';

/**
 * A real v8 document, built the way a save is.
 *
 * The required block is spelled out because `makeSimulationConfig` demands it:
 * `SimulationConfigRequired` has no defaults by design -- `mutationSeed` in
 * particular, where a defaulted 0.0 is a completely different rule that still
 * looks legitimate (`persistence.ts:26-30`). The values themselves are
 * arbitrary; what matters is that the result round-trips through the real
 * reader, so these tests fail if the document shape drifts.
 */
function document(): unknown {
  const config = makeSimulationConfig({
    cohorts: 4,
    mutationSeed: 0.5,
    sensorGain: 1,
    sensorAngle: 0.4,
    sensorDistance: 8,
    mutationScale: 0.1,
    globalForceMult: 1,
    drag: 0.9,
    strafePower: 0.2,
    axialForce: 0.3,
    lateralForce: 0.1,
    hazardRate: 0,
  });
  return toDocument([config], makeWorldSettings());
}

const text = (): string => `${JSON.stringify(document(), null, 2)}\n`;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

test('export names each file after its save', () => {
  const files = exportFiles([
    { name: 'Krill', document: document() },
    { name: 'Moths', document: document() },
  ]);
  assert.deepEqual(
    files.map((f) => f.filename),
    ['Krill.json', 'Moths.json'],
  );
});

/**
 * THE INVARIANT THE WHOLE FEATURE RESTS ON. A save is already a v8 file, so
 * export must be a byte copy -- if this ever normalizes a field, `persistence.ts`
 * has stopped being the single writer of the format and a file exported as a
 * preset would differ from the save it came from.
 */
test('export does not rewrite the stored document', () => {
  const stored = document();
  const [file] = exportFiles([{ name: 'Krill', document: stored }]);
  assert.deepEqual(JSON.parse(file!.text), stored);
});

test('export pretty-prints, so the files are readable in configs/', () => {
  const [file] = exportFiles([{ name: 'Krill', document: document() }]);
  assert.match(file!.text, /\n {2}"version": 8/);
  assert.ok(file!.text.endsWith('\n'), 'files end with a newline');
});

test('export drops a name with no usable characters rather than writing ".json"', () => {
  assert.deepEqual(exportFiles([{ name: '...', document: document() }]), []);
});

// ---------------------------------------------------------------------------
// Import: collisions
// ---------------------------------------------------------------------------

test('import takes the config name from the filename', () => {
  const plan = planImport([{ filename: 'Krill.json', text: text() }], []);
  assert.equal(plan.accepted.length, 1);
  assert.equal(plan.accepted[0]!.name, 'Krill');
});

test('import skips a file whose name is already a user save', () => {
  const plan = planImport([{ filename: 'Krill.json', text: text() }], ['Krill']);
  assert.deepEqual(plan.accepted, []);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0]!.reason, 'exists');
});

/**
 * The rule the user chose, and the one worth pinning: only USER saves block.
 * `existing` is `Custom` alone, so a file colliding with a shipped Core preset
 * still imports -- forking a preset and keeping its name is the case this
 * serves. See `planImport`.
 */
test('import accepts a name that collides with a shipped preset', () => {
  // `Krill` ships in Core. It is absent from `existing`, which holds Custom only.
  const plan = planImport([{ filename: 'Krill.json', text: text() }], ['Something else']);
  assert.equal(plan.accepted.length, 1, 'a Core collision does not block an import');
});

test('two files that sanitize to one name do not silently overwrite each other', () => {
  const plan = planImport(
    [
      { filename: 'a:b.json', text: text() },
      { filename: 'ab.json', text: text() },
    ],
    [],
  );
  // `sanitizeName` REMOVES the colon, so both want to be `ab`.
  assert.equal(plan.accepted.length, 1);
  assert.equal(plan.accepted[0]!.name, 'ab');
  assert.equal(plan.skipped[0]!.reason, 'exists', 'the second is reported, not dropped');
});

test('import skips a filename with no usable characters', () => {
  const plan = planImport([{ filename: '....json', text: text() }], []);
  assert.equal(plan.skipped[0]!.reason, 'unnamed');
});

// ---------------------------------------------------------------------------
// Import: validation
// ---------------------------------------------------------------------------

test('import rejects a file that is not JSON, naming it', () => {
  const plan = planImport([{ filename: 'Broken.json', text: 'not json' }], []);
  assert.deepEqual(plan.accepted, []);
  assert.equal(plan.skipped[0]!.reason, 'unreadable');
  assert.equal(plan.skipped[0]!.filename, 'Broken.json');
});

/**
 * The reason import validates at all. A v7 file is well-formed JSON and a
 * plausible config; without the reader it would land in storage and fail much
 * later, at the click, with an error naming a category rather than a file.
 */
test('import rejects a valid-looking config of the wrong version', () => {
  const plan = planImport([{ filename: 'Old.json', text: '{"version":7}' }], []);
  assert.equal(plan.skipped[0]!.reason, 'unreadable');
  assert.match(plan.skipped[0]!.detail, /version/i);
});

test('a rejected file does not consume its name', () => {
  const plan = planImport(
    [
      { filename: 'Krill.json', text: 'not json' },
      { filename: 'Krill.json', text: text() },
    ],
    [],
  );
  // The broken one must not have claimed `Krill` on the way past -- otherwise a
  // corrupt file in a folder would block the good copy beside it.
  assert.equal(plan.accepted.length, 1);
  assert.equal(plan.accepted[0]!.name, 'Krill');
});

test('the accepted document is the original bytes, not a reserialization', () => {
  const stored = document();
  const plan = planImport(
    [{ filename: 'Krill.json', text: `${JSON.stringify(stored, null, 2)}\n` }],
    [],
  );
  assert.deepEqual(plan.accepted[0]!.document, stored);
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test('the summary counts skip reasons separately', () => {
  const plan = planImport(
    [
      { filename: 'New.json', text: text() },
      { filename: 'Krill.json', text: text() },
      { filename: 'Broken.json', text: '{' },
    ],
    ['Krill'],
  );
  const line = describeImport(plan);
  assert.match(line, /Imported 1 save/);
  assert.match(line, /1 already saved/);
  assert.match(line, /1 unreadable/);
});

test('a clean import says only what it imported', () => {
  const plan = planImport([{ filename: 'New.json', text: text() }], []);
  assert.equal(describeImport(plan), 'Imported 1 save.');
});
