/**
 * The panel's section layout.
 *
 * ## What these catch
 *
 * `sectionsFor` is the seam `ARCHITECTURE.md`'s tool-selects-controls endpoint
 * will be implemented at, and the failure it protects against is a section
 * silently disappearing -- a folder that stops being built renders nothing, logs
 * nothing, and looks exactly like a folder the user collapsed.
 *
 * The `mode`-independence assertions are the load-bearing ones: they pin
 * TODAY's deliberate behaviour ("every tool sees every section"), so a future
 * change to that is a visible edit here rather than an accident. When the
 * endpoint is implemented, these tests are what should fail first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MOUSE_MODES } from '../orchestrator/commands.ts';
import {
  DEBUG,
  DRAWING,
  PREFERENCES,
  PROJECT,
  TRANSPORT,
  type SectionId,
  sectionsFor,
} from './panelModel.ts';

test('every section id is reachable', () => {
  const ids = sectionsFor('select', true).map((s) => s.id);
  const expected: readonly SectionId[] = [
    TRANSPORT,
    PROJECT,
    PREFERENCES,
    DRAWING,
    DEBUG,
  ];
  assert.deepEqual(ids, expected);
});

test('section ids are unique', () => {
  const ids = sectionsFor('select', true).map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every section has a non-empty title', () => {
  for (const section of sectionsFor('select', true)) {
    assert.ok(section.title.length > 0, `${section.id} has no title`);
  }
});

test('ordering is stable across tiers', () => {
  assert.deepEqual(
    sectionsFor('select', false).map((s) => s.id),
    sectionsFor('select', true).map((s) => s.id),
  );
});

/**
 * TODAY's behaviour, pinned deliberately. See the file header: the
 * tool-selection endpoint is not implemented, and this is what should fail
 * first when it is.
 */
test('every tool sees every section, for now', () => {
  const reference = sectionsFor('select', true).map((s) => s.id);
  for (const mode of MOUSE_MODES) {
    assert.deepEqual(
      sectionsFor(mode, true).map((s) => s.id),
      reference,
      `${mode} disagrees with select`,
    );
  }
});

test('Transport is expanded and Debug is not', () => {
  const sections = sectionsFor('select', true);
  const byId = new Map(sections.map((s) => [s.id, s]));
  assert.equal(byId.get(TRANSPORT)?.expanded, true);
  assert.equal(byId.get(DEBUG)?.expanded, false);
});
