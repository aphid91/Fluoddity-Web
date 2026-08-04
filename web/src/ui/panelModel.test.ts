/**
 * The panels' section layout.
 *
 * ## What these catch
 *
 * The failure they protect against has not changed: a section silently
 * disappearing. A folder that stops being built renders nothing, logs nothing,
 * and looks exactly like a folder the user collapsed.
 *
 * What HAS changed is the shape. There used to be one `sectionsFor(mode, tier)`
 * returning every section, with the `mode`-independence assertions pinning
 * "every tool sees every section" as deliberate placeholder behaviour -- and
 * this file's header said those tests should be the first to fail when the
 * tool-selection endpoint arrived. They did, and this is the edit.
 *
 * The endpoint arrived as a split by what the state IS -- Project on the left,
 * editor state on the right -- with the tool-selection part landing one level
 * down, as a TAB inside the right panel. So there is no `mode` parameter here
 * to be independent of any more: `sections/settingsSection.ts` owns that, and
 * `panel.ts` drives it.
 *
 * The parked-section assertion is the load-bearing one now. Transport and Debug
 * are deliberately absent from both panels but still fully built code, and the
 * distinction between "parked" and "deleted" is exactly the kind of thing that
 * rots silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEBUG,
  PROJECT,
  SETTINGS,
  TRANSPORT,
  type SectionId,
  leftSections,
  rightSections,
} from './panelModel.ts';

/** Both panels' sections, in the order the screen shows them. */
function allSections() {
  return [...leftSections(), ...rightSections()];
}

test('the left panel is the project, the right is the settings host', () => {
  assert.deepEqual(
    leftSections().map((s) => s.id),
    [PROJECT] as readonly SectionId[],
  );
  assert.deepEqual(
    rightSections().map((s) => s.id),
    [SETTINGS] as readonly SectionId[],
  );
});

test('section ids are unique across BOTH panels', () => {
  // Across both, not per panel: `data-section` is the DOM hook `uiCheck.mjs`
  // selects on, and a duplicate would make a query ambiguous rather than wrong
  // -- which is harder to notice than a miss.
  const ids = allSections().map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every section has a non-empty title', () => {
  for (const section of allSections()) {
    assert.ok(section.title.length > 0, `${section.id} has no title`);
  }
});

test('every section starts expanded', () => {
  // Both panels hold a single section now, so a collapsed one would present as
  // an empty panel with a header. Debug's `expanded: false` was the only
  // exception and Debug is parked.
  for (const section of allSections()) {
    assert.ok(section.expanded, `${section.id} starts collapsed`);
  }
});

/**
 * Transport and Debug are PARKED, not deleted.
 *
 * The ids stay exported and `panel.ts`'s `buildSection` keeps an arm for each,
 * so restoring one is a single line in `panelModel.ts`. This asserts the
 * parking itself: if either reappears in a panel it should be because someone
 * meant it, and that someone should have to edit this test to say so.
 */
test('Transport and Debug are parked', () => {
  const ids = new Set<SectionId>(allSections().map((s) => s.id));
  assert.ok(!ids.has(TRANSPORT), 'Transport is in a panel again');
  assert.ok(!ids.has(DEBUG), 'Debug is in a panel again');
});
