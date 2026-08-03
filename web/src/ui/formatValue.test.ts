/**
 * Readout precision, and INPUT parsing.
 *
 * The precision tests pin the formula against the desktop's, because the failure
 * is subtle: too few decimals and a whole useful range renders as "0.000", which
 * reads as a broken slider rather than as a formatting choice.
 *
 * The parsing tests are about a different kind of damage. INPUT controls are the
 * DISRUPTIVE ones -- World Size and Canvas Aspect -- which reallocate GPU
 * buffers and reset the running simulation when they commit. So the interesting
 * cases are all the ones that must be REJECTED: a value that looks parseable but
 * is not what the user meant costs them their simulation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INPUT, SETTINGS, type Setting } from './settingsSpec.ts';
import { decimalsFor, formatSeed, formatValue, parseInput } from './formatValue.ts';

const worldSize = SETTINGS.find((s) => s.field === 'worldSize')!;
const hazardRate = SETTINGS.find((s) => s.field === 'hazardRate')!;

test('decimalsFor matches the desktop formula', () => {
  // max(3, min(8, round(-log10(span)) + 4))
  assert.equal(decimalsFor(1.0), 4);
  assert.equal(decimalsFor(0.01), 6); // Hazard Rate
  assert.equal(decimalsFor(10.0), 3); // floors at 3
  assert.equal(decimalsFor(1e-6), 8); // caps at 8
});

test('decimalsFor never returns fewer than 3 or more than 8', () => {
  for (const span of [1e-12, 1e-3, 0.5, 1, 2, 100, 1e9]) {
    const d = decimalsFor(span);
    assert.ok(d >= 3 && d <= 8, `span ${span} gave ${d}`);
  }
});

test('a degenerate span does not produce NaN decimals', () => {
  assert.equal(decimalsFor(0), 3);
  assert.equal(decimalsFor(Number.NaN), 3);
  assert.equal(decimalsFor(Number.POSITIVE_INFINITY), 3);
});

/** The reason `decimalsFor` exists at all. */
test("Hazard Rate's useful range does not render as 0.000", () => {
  // A rate of 0.001 already resets most of the population within a second, so
  // it has to be legible. At three decimals it would read "0.001" -- and 0.0001
  // would read "0.000", which is the failure.
  assert.notEqual(formatValue(hazardRate, 0.0001), '0.000');
  assert.ok(formatValue(hazardRate, 0.0001).includes('1'));
});

test('formatValue uses the setting range, not the value', () => {
  assert.equal(formatValue(worldSize, 1), (1).toFixed(decimalsFor(worldSize.hi - worldSize.lo)));
});

test('formatSeed is four decimals', () => {
  assert.equal(formatSeed(0.30880001), '0.3088');
  assert.equal(formatSeed(0), '0.0000');
});

// --- parseInput ------------------------------------------------------------

test('parseInput accepts a plain number', () => {
  assert.equal(parseInput(worldSize, '2'), 2);
  assert.equal(parseInput(worldSize, '  2.5  '), 2.5);
});

test('parseInput clamps into the setting bounds', () => {
  assert.equal(parseInput(worldSize, '999'), worldSize.hi);
  assert.equal(parseInput(worldSize, '-999'), worldSize.lo);
});

test('parseInput rejects the empty string rather than reading it as zero', () => {
  // `Number('')` is 0, and 0 is a plausible-looking World Size that would
  // rebuild the simulation at its minimum.
  assert.equal(parseInput(worldSize, ''), null);
  assert.equal(parseInput(worldSize, '   '), null);
});

test('parseInput rejects a trailing typo rather than truncating it', () => {
  // `parseFloat('4abc')` is 4, which would accept a typo as the intended value.
  assert.equal(parseInput(worldSize, '4abc'), null);
  assert.equal(parseInput(worldSize, '1.2.3'), null);
});

test('parseInput rejects non-finite input', () => {
  assert.equal(parseInput(worldSize, 'NaN'), null);
  assert.equal(parseInput(worldSize, 'Infinity'), null);
  assert.equal(parseInput(worldSize, '-Infinity'), null);
});

test('every INPUT setting has usable bounds to clamp against', () => {
  const inputs = SETTINGS.filter((s: Setting) => s.kind === INPUT);
  assert.ok(inputs.length > 0);
  for (const setting of inputs) {
    assert.ok(setting.hi > setting.lo, setting.label);
    assert.equal(parseInput(setting, String(setting.hi * 10)), setting.hi);
    assert.ok(setting.disruptive, `${setting.label} should be disruptive`);
  }
});
