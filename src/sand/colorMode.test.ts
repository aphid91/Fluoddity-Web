import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLOR_BY_BEHAVIOR,
  COLOR_BY_COHORT,
  COLOR_BY_SWATCH,
  COLOR_MODES,
  COLOR_MODE_LABELS,
  DEFAULT_COLOR_MODE,
  asColorMode,
  colorModeIndex,
} from './colorMode.ts';

// ---------------------------------------------------------------------------
// The mode integers -- the protocol with camBrush.wgsl
// ---------------------------------------------------------------------------

// ZERO IS BEHAVIOR so that a uniform buffer which failed to be written -- all
// zeroes -- renders the original look rather than an unrecognised mode the
// shader has to have an opinion about.
test('the zero index is Behavior', () => {
  assert.equal(colorModeIndex(COLOR_BY_BEHAVIOR), 0);
  assert.equal(DEFAULT_COLOR_MODE, COLOR_BY_BEHAVIOR);
});

test('every mode has a distinct index', () => {
  const seen = new Set(COLOR_MODES.map(colorModeIndex));
  assert.equal(seen.size, COLOR_MODES.length, 'two modes share an index');
});

// The studio maps its `colorByCohort` boolean onto these two. If the Cohort
// index moved, the studio's checkbox would silently select a different mode.
test('the studio s boolean mapping still lands on the right two modes', () => {
  assert.equal(colorModeIndex(COLOR_BY_COHORT), 1, 'orchestrator.ts writes 1 for true');
  assert.equal(colorModeIndex(COLOR_BY_BEHAVIOR), 0, 'and 0 for false');
});

test('Swatch is the third mode', () => {
  assert.equal(colorModeIndex(COLOR_BY_SWATCH), 2);
});

// ---------------------------------------------------------------------------
// Reading a stored mode
// ---------------------------------------------------------------------------

test('every mode round-trips through its stored name', () => {
  for (const mode of COLOR_MODES) {
    assert.equal(asColorMode(mode), mode);
  }
});

// A session or world from a build with a mode this one lacks must still render.
test('an unrecognised mode falls back to the default', () => {
  assert.equal(asColorMode('rainbow'), DEFAULT_COLOR_MODE);
  assert.equal(asColorMode(undefined), DEFAULT_COLOR_MODE);
  assert.equal(asColorMode(null), DEFAULT_COLOR_MODE);
  assert.equal(asColorMode(2), DEFAULT_COLOR_MODE, 'the index is not the name');
});

// ---------------------------------------------------------------------------
// The dropdown
// ---------------------------------------------------------------------------

test('every mode has a label for the dropdown', () => {
  for (const mode of COLOR_MODES) {
    const label = COLOR_MODE_LABELS[mode];
    assert.ok(typeof label === 'string' && label !== '', `${mode} has no label`);
  }
});

// Three states, not four. Two independent checkboxes would have had a
// both-on combination that means nothing -- see the module header.
test('there are exactly three modes', () => {
  assert.equal(COLOR_MODES.length, 3);
});
