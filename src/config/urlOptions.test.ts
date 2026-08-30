/**
 * Tests for the URL options.
 *
 * ## WHAT THESE ARE ACTUALLY GUARDING
 *
 * `urlOptions.ts` parses values written by whoever composed a link, not by the
 * person opening it, and hands them to a dialog that offers to change how
 * someone's editor is set up. Three properties matter more than the parsing:
 *
 *   - **Out-of-range values are DROPPED, not clamped.** Clamping is the
 *     tempting reading of "keep it in bounds" and it is the wrong one: it turns
 *     `worldSize=99` into a checkbox offering the maximum, which is not what
 *     the link asked for and not something the user would recognise as a
 *     refusal. Three cases cover it, one per boundary.
 *   - **Settings that already match produce no row.** This is what keeps the
 *     dialog honest -- a list of no-op rows trains people to click Yes without
 *     reading, and the whole point of asking is that they read it.
 *   - **The `Shared-` prefix does not stack.** A link passed between three
 *     people should not be called `Shared-Shared-Shared-Tangle`, and the
 *     collapse runs on the way in so that no amount of re-sharing accumulates
 *     it.
 *
 * The camera-mode case is the one most likely to regress, because it is the
 * only setting that is NOT a preference: it lives on `CameraState`, resets on
 * every load, and can be moved before the prompt runs by the older `?camera`
 * parameter. Its baseline is therefore passed in rather than assumed, and the
 * "already on" case asserts that.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_PREFERENCES } from '../prefs/preferences.ts';
import {
  DEFAULT_LINK_SETTINGS,
  MAX_NAME_LENGTH,
  buildLinkQuery,
  collapseSharedPrefix,
  describeChanges,
  hasProposedSettings,
  loadLinkSettings,
  numericProposal,
  parseUrlOptions,
  sharedNameFor,
  withSharedName,
} from './urlOptions.ts';

// -- splash -----------------------------------------------------------------

test('?splash accepts the three documents and rejects anything else', () => {
  assert.equal(parseUrlOptions('?splash=welcome').splash, 'welcome');
  assert.equal(parseUrlOptions('?splash=guide').splash, 'guide');
  assert.equal(parseUrlOptions('?splash=controls').splash, 'controls');

  // Case and whitespace are forgiven -- these are typed by hand.
  assert.equal(parseUrlOptions('?splash=GUIDE').splash, 'guide');
  assert.equal(parseUrlOptions('?splash=%20guide%20').splash, 'guide');

  // A bad value must not fall back to the welcome: that would silently show a
  // first-run overlay to someone who asked for the key reference.
  assert.equal(parseUrlOptions('?splash=nonsense').splash, null);
  assert.equal(parseUrlOptions('').splash, null);
});

// -- name -------------------------------------------------------------------

test('?name is trimmed, capped, and absent when blank', () => {
  assert.equal(parseUrlOptions('?name=Hello').name, 'Hello');
  assert.equal(parseUrlOptions('?name=%20%20Hello%20%20').name, 'Hello');

  // Whitespace only is a request for nothing, not for a blank title.
  assert.equal(parseUrlOptions('?name=%20%20').name, null);
  assert.equal(parseUrlOptions('').name, null);

  // The cap protects the layout from a name arriving in a stranger's link.
  const long = 'x'.repeat(500);
  const parsed = parseUrlOptions(`?name=${long}`).name;
  assert.equal(parsed?.length, MAX_NAME_LENGTH);
});

test('the Shared- prefix collapses instead of stacking', () => {
  assert.equal(collapseSharedPrefix('Tangle'), 'Tangle');
  assert.equal(collapseSharedPrefix('Shared-Tangle'), 'Tangle');
  assert.equal(collapseSharedPrefix('Shared-Shared-Shared-Tangle'), 'Tangle');

  assert.equal(sharedNameFor('Tangle'), 'Shared-Tangle');
  // The case that matters: opening a shared link and re-sharing it.
  assert.equal(sharedNameFor('Shared-Tangle'), 'Shared-Tangle');
});

test('withSharedName replaces an existing name rather than appending one', () => {
  const loc = { origin: 'https://x.test', pathname: '/', search: '?name=Shared-Old' };
  const next = withSharedName(loc, 'Medusa');

  const params = new URLSearchParams(next.search);
  assert.deepEqual(params.getAll('name'), ['Shared-Medusa']);
});

test('withSharedName preserves every other parameter', () => {
  // `buildShareUrl` keeps the query string so a link copied from `?nopanel`
  // opens without a panel. Settings parameters ride along for the same reason:
  // the recipient is asked about them by the same dialog the sender saw.
  const loc = {
    origin: 'https://x.test',
    pathname: '/',
    search: '?nopanel&brightness=1.5',
  };
  const params = new URLSearchParams(withSharedName(loc, 'Tangle').search);

  assert.equal(params.has('nopanel'), true);
  assert.equal(params.get('brightness'), '1.5');
  assert.equal(params.get('name'), 'Shared-Tangle');
});

// -- numeric settings -------------------------------------------------------

test('in-range numbers are accepted', () => {
  const { settings } = parseUrlOptions('?worldSize=0.5&brightness=1.5');
  assert.equal(settings.worldSize, 0.5);
  assert.equal(settings.brightness, 1.5);
});

test('OUT-OF-RANGE NUMBERS ARE DROPPED, NOT CLAMPED', () => {
  // The whole point: `99` is a malformed request, and silently rewriting it to
  // the maximum would put a checkbox in front of the user offering a value the
  // link never asked for. See the file header.
  assert.equal(parseUrlOptions('?worldSize=99').settings.worldSize, undefined);
  assert.equal(parseUrlOptions('?worldSize=-1').settings.worldSize, undefined);
  assert.equal(parseUrlOptions('?brightness=1000').settings.brightness, undefined);
});

test('unparseable numbers are dropped', () => {
  assert.equal(parseUrlOptions('?worldSize=abc').settings.worldSize, undefined);
  assert.equal(parseUrlOptions('?worldSize=').settings.worldSize, undefined);
  assert.equal(parseUrlOptions('?worldSize=NaN').settings.worldSize, undefined);
  assert.equal(parseUrlOptions('?worldSize=Infinity').settings.worldSize, undefined);
});

test('?trailmap reads both directions and ignores anything else', () => {
  assert.equal(parseUrlOptions('?trailmap=1').settings.cameraMode, 'trail');
  assert.equal(parseUrlOptions('?trailmap=true').settings.cameraMode, 'trail');
  assert.equal(parseUrlOptions('?trailmap=on').settings.cameraMode, 'trail');

  // "Off" has to be expressible: a link turning the trail map off is as
  // reasonable as one turning it on, which is why this is not presence-based
  // like `?debug`.
  assert.equal(parseUrlOptions('?trailmap=0').settings.cameraMode, 'particles');
  assert.equal(parseUrlOptions('?trailmap=false').settings.cameraMode, 'particles');

  assert.equal(parseUrlOptions('?trailmap=maybe').settings.cameraMode, undefined);
  assert.equal(parseUrlOptions('?trailmap').settings.cameraMode, undefined);
});

test('hasProposedSettings distinguishes an empty proposal', () => {
  assert.equal(hasProposedSettings(parseUrlOptions('').settings), false);
  assert.equal(hasProposedSettings(parseUrlOptions('?splash=guide').settings), false);
  assert.equal(hasProposedSettings(parseUrlOptions('?brightness=1.5').settings), true);
});

test('numericProposal refuses the camera mode', () => {
  // `editSetting` takes a number; the camera goes through a toggle instead. The
  // narrowing lives in one place so no call site has to remember.
  const { settings } = parseUrlOptions('?trailmap=1&brightness=1.5');
  assert.equal(numericProposal(settings, 'cameraMode'), undefined);
  assert.equal(numericProposal(settings, 'brightness'), 1.5);
});

// -- describeChanges --------------------------------------------------------

test('a setting that already matches produces NO row', () => {
  // The rule that keeps the dialog honest -- see the file header.
  const settings = { brightness: DEFAULT_PREFERENCES.brightness };
  const rows = describeChanges(settings, DEFAULT_PREFERENCES, 'particles');
  assert.deepEqual(rows, []);
});

test('only the settings that differ are offered', () => {
  const settings = {
    brightness: DEFAULT_PREFERENCES.brightness, // unchanged: omitted
    worldSize: DEFAULT_PREFERENCES.worldSize + 0.25,
  };
  const rows = describeChanges(settings, DEFAULT_PREFERENCES, 'particles');

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.key, 'worldSize');
});

test('a row carries the label and both values', () => {
  // 1.0 rather than 0.5, because 0.5 IS the default -- proposing it would
  // correctly produce no row at all, and the assertion would be testing the
  // omission rule by accident instead of the formatting.
  const rows = describeChanges({ worldSize: 1.0 }, DEFAULT_PREFERENCES, 'particles');
  const row = rows[0];

  // The label comes from `settingsSpec.ts` rather than being typed here, so a
  // relabelled control moves this with it.
  assert.equal(row?.label, 'World Size');
  assert.equal(row?.from, '0.5');
  assert.equal(row?.to, '1');
});

test('the trail map is named for what the user sees, not for the mode', () => {
  const rows = describeChanges({ cameraMode: 'trail' }, DEFAULT_PREFERENCES, 'particles');

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.label, 'Trail Map View');
  assert.equal(rows[0]?.from, 'Off');
  assert.equal(rows[0]?.to, 'On');
});

test('the trail map offers nothing when it is ALREADY on', () => {
  // `?camera=trail` can move the mode before this runs. Its baseline is passed
  // in rather than assumed to be 'particles' precisely so this case produces no
  // row -- offering to turn on a view that is already on is the no-op the
  // omission rule exists to prevent.
  const rows = describeChanges({ cameraMode: 'trail' }, DEFAULT_PREFERENCES, 'trail');
  assert.deepEqual(rows, []);
});

test('the trail map can be offered in the On -> Off direction', () => {
  const rows = describeChanges({ cameraMode: 'particles' }, DEFAULT_PREFERENCES, 'trail');

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.from, 'On');
  assert.equal(rows[0]?.to, 'Off');
});

// -- buildLinkQuery ---------------------------------------------------------

/** A live state to build links against. */
const SOURCE = {
  prefs: DEFAULT_PREFERENCES,
  cameraMode: 'particles' as const,
  projectName: 'Tangle',
};

test('an untouched tab produces just the name, as Copy Link always did', () => {
  const query = buildLinkQuery(DEFAULT_LINK_SETTINGS, SOURCE);
  const params = new URLSearchParams(query);

  assert.equal(params.get('name'), 'Shared-Tangle');
  // Nothing else: an unticked box must not put a parameter in the link.
  assert.deepEqual([...params.keys()], ['name']);
});

test('a ticked box carries the CURRENT value, not a stored one', () => {
  // The property the whole tab rests on -- ticking is a standing instruction,
  // resolved when the link is built. Here that is expressed by building against
  // a source whose value differs from the default.
  const source = {
    ...SOURCE,
    prefs: Object.freeze({ ...DEFAULT_PREFERENCES, brightness: 1.25 }),
  };
  const query = buildLinkQuery(
    { ...DEFAULT_LINK_SETTINGS, brightness: true },
    source,
  );

  assert.equal(new URLSearchParams(query).get('brightness'), '1.25');
});

test('the trail map is carried in BOTH directions', () => {
  // "Match current" has to be able to mean OFF. Omitting it when off would say
  // "no opinion" instead, and the recipient would keep their own view.
  const on = buildLinkQuery(
    { ...DEFAULT_LINK_SETTINGS, trailMap: true },
    { ...SOURCE, cameraMode: 'trail' },
  );
  assert.equal(new URLSearchParams(on).get('trailmap'), '1');

  const off = buildLinkQuery(
    { ...DEFAULT_LINK_SETTINGS, trailMap: true },
    { ...SOURCE, cameraMode: 'particles' },
  );
  assert.equal(new URLSearchParams(off).get('trailmap'), '0');
});

test('unticking a box removes its parameter from an existing query', () => {
  // Copying twice with a box unticked in between must not leave the first
  // copy's parameter behind -- the link would keep asking for something the
  // sender has since decided against.
  const query = buildLinkQuery(DEFAULT_LINK_SETTINGS, SOURCE, '?brightness=1.5&nopanel');
  const params = new URLSearchParams(query);

  assert.equal(params.has('brightness'), false);
  // Parameters the tab does not own are preserved, as `buildShareUrl` promises.
  assert.equal(params.has('nopanel'), true);
});

test('a custom project name beats the Shared- default and is capped', () => {
  const named = buildLinkQuery(
    { ...DEFAULT_LINK_SETTINGS, projectName: '  My Piece  ' },
    SOURCE,
  );
  assert.equal(new URLSearchParams(named).get('name'), 'My Piece');

  const long = buildLinkQuery(
    { ...DEFAULT_LINK_SETTINGS, projectName: 'y'.repeat(500) },
    SOURCE,
  );
  assert.equal(new URLSearchParams(long).get('name')?.length, MAX_NAME_LENGTH);
});

test('the splash choice rides along unprompted', () => {
  const query = buildLinkQuery({ ...DEFAULT_LINK_SETTINGS, splash: 'guide' }, SOURCE);
  assert.equal(new URLSearchParams(query).get('splash'), 'guide');
});

test('what buildLinkQuery emits is what parseUrlOptions reads back', () => {
  // The round trip is the real contract: these two functions are the two ends
  // of one feature, and a link that cannot be parsed by the app that wrote it
  // would fail silently on the recipient's machine.
  const settings = {
    ...DEFAULT_LINK_SETTINGS,
    worldSize: true,
    brightness: true,
    trailMap: true,
    splash: 'controls' as const,
    projectName: 'Round Trip',
  };
  const parsed = parseUrlOptions(buildLinkQuery(settings, SOURCE));

  assert.equal(parsed.splash, 'controls');
  assert.equal(parsed.name, 'Round Trip');
  assert.equal(parsed.settings.worldSize, DEFAULT_PREFERENCES.worldSize);
  assert.equal(parsed.settings.brightness, DEFAULT_PREFERENCES.brightness);
  assert.equal(parsed.settings.cameraMode, 'particles');
});

test('loadLinkSettings survives absent, corrupt and hostile storage', () => {
  // `preferences.ts`'s contract: a bad entry outlives a reload, so throwing
  // would make the panel permanently unbuildable.
  assert.deepEqual(loadLinkSettings(null), DEFAULT_LINK_SETTINGS);
  assert.deepEqual(
    loadLinkSettings({ getItem: () => 'not json' }),
    DEFAULT_LINK_SETTINGS,
  );
  assert.deepEqual(
    loadLinkSettings({ getItem: () => { throw new Error('denied'); } }),
    DEFAULT_LINK_SETTINGS,
  );
  // Wrong types are dropped rather than trusted.
  assert.deepEqual(
    loadLinkSettings({ getItem: () => '{"worldSize":"yes","splash":"nope"}' }),
    DEFAULT_LINK_SETTINGS,
  );
});

test('a whole link parses end to end', () => {
  const { splash, name, settings } = parseUrlOptions(
    '?splash=guide&name=Demo&worldSize=0.5&trailmap=1&preset=Medusa',
  );

  assert.equal(splash, 'guide');
  assert.equal(name, 'Demo');
  assert.equal(settings.worldSize, 0.5);
  assert.equal(settings.cameraMode, 'trail');
  // `?preset` is not this module's business and must pass through untouched.
  assert.equal('preset' in settings, false);
});
