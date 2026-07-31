/**
 * Async selection records history against the state from CLICK time.
 *
 * The port of `tests/test_pending_selection.py` (160 lines), all five groups,
 * plus two the web needs and the desktop does not (see the last section).
 *
 * WHY THIS TEST EXISTS. Selection is two-phase: the click dispatches a pick and
 * the NEXT frame adopts the winner's rule. That split creates a way to get
 * history wrong -- recording against the project as it stands when the result
 * lands, rather than as it stood when the user clicked. Anything that changed
 * the project in between would then be swallowed into the selection's undo
 * entry. It also pins last-click-wins for a second click arriving while one is
 * still pending.
 *
 * No GPU: this is the bookkeeping, which is where the ordering bug would live.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SelectionController, type SelectionHost } from './selection.ts';

/** A pick result, stripped to what the controller actually looks at. */
interface FakeResult {
  readonly index: number;
}

const MISS: FakeResult = { index: -1 };

/** One recorded undo entry, as the harness saw it. */
interface Entry {
  readonly before: string;
  readonly after: string;
  readonly label: string;
}

/**
 * The collaborators, recording what they were asked.
 *
 * The project is a plain string that adoption extends (`'P0'` -> `'P0+rule42'`),
 * which is how the Python's `P(str)` lets a test see exactly which state an
 * entry was recorded against.
 */
class Harness implements SelectionHost<string, FakeResult> {
  project = 'P0';
  selected: FakeResult = MISS;
  readonly requests: (readonly [number, number])[] = [];
  readonly recorded: Entry[] = [];

  /** What `retrievePick` will hand back. `null` models "not ready yet". */
  queued: FakeResult | null = MISS;

  requestPick(pixel: readonly [number, number]): void {
    this.requests.push(pixel);
  }
  retrievePick(): FakeResult | null {
    return this.queued;
  }
  isHit(result: FakeResult): boolean {
    return result.index >= 0;
  }
  currentProject(): string {
    return this.project;
  }
  adoptRule(project: string, result: FakeResult): string {
    return `${project}+rule${result.index}`;
  }
  setProject(project: string): void {
    this.project = project;
  }
  recordHistory(before: string, label: string): void {
    this.recorded.push({ before, after: this.project, label });
  }
  setSelected(result: FakeResult): void {
    this.selected = result;
  }
  describe(result: FakeResult): string {
    return `select particle #${result.index}`;
  }
}

function harness(): { host: Harness; sel: SelectionController<string, FakeResult> } {
  const host = new Harness();
  return { host, sel: new SelectionController(host) };
}

// ---------------------------------------------------------------------------
// 1. the click does not resolve anything by itself
// ---------------------------------------------------------------------------

test('a click dispatches a pick and records nothing yet', () => {
  const { host, sel } = harness();
  host.queued = { index: 42 };

  sel.select([10, 20]);

  assert.equal(host.requests.length, 1, 'click dispatches exactly one pick');
  assert.equal(host.project, 'P0', 'click does not change the project');
  assert.deepEqual(host.recorded, [], 'click records no history yet');
  assert.equal(sel.isPending, true, 'click captures a before-state');
});

// ---------------------------------------------------------------------------
// 2. the project moves between click and resolve -- THE CASE THIS ALL EXISTS FOR
// ---------------------------------------------------------------------------

test('history records against the CLICK-time project, not the in-flight edit', () => {
  const { host, sel } = harness();
  host.queued = { index: 42 };

  sel.select([10, 20]);
  // Something else edits the project while the pick is in flight -- a slider
  // drag, a preset load, anything. The selection's undo entry must not swallow
  // it.
  host.project = 'P1_edited_while_in_flight';
  sel.resolve();

  assert.equal(host.recorded.length, 1, 'resolve records ONE entry');
  const entry = host.recorded[0]!;
  assert.equal(entry.before, 'P0', "history 'before' is the click-time project");
  assert.equal(entry.after, 'P1_edited_while_in_flight+rule42', "'after' is the adopted project");
  assert.equal(entry.label, 'select particle #42', 'the label names the entity');
  assert.equal(sel.isPending, false, 'pending cleared after resolve');
});

// ---------------------------------------------------------------------------
// 3. resolving again does nothing
// ---------------------------------------------------------------------------

test('a second resolve is a no-op', () => {
  const { host, sel } = harness();
  host.queued = { index: 42 };

  sel.select([10, 20]);
  sel.resolve();
  host.recorded.length = 0;

  const again = sel.resolve();
  assert.equal(again, null, 'nothing was pending, so nothing is consumed');
  assert.deepEqual(host.recorded, [], 'second resolve records nothing');
});

// ---------------------------------------------------------------------------
// 4. a MISS changes nothing but `selected`
// ---------------------------------------------------------------------------

test('a miss clears the pending click without touching the project', () => {
  const { host, sel } = harness();
  host.project = 'Q0';
  host.queued = MISS;

  sel.select([1, 1]);
  sel.resolve();

  assert.deepEqual(host.recorded, [], 'miss records no history');
  assert.equal(host.project, 'Q0', 'miss leaves the project alone');
  assert.equal(sel.isPending, false, 'miss clears pending');
  assert.equal(host.selected, MISS, 'miss still updates what is selected');
});

// ---------------------------------------------------------------------------
// 5. last click wins, with ITS OWN before-state
// ---------------------------------------------------------------------------

test('a second click replaces the pending one and carries its own before-state', () => {
  const { host, sel } = harness();
  host.project = 'R0';
  host.queued = { index: 7 };

  sel.select([5, 5]); // first click, before = R0
  host.project = 'R1'; // project moves
  sel.select([6, 6]); // second click, before = R1

  assert.equal(host.requests.length, 2, 'both clicks dispatched');

  sel.resolve();
  assert.equal(host.recorded.length, 1, 'only one entry recorded');
  assert.equal(
    host.recorded[0]!.before,
    'R1',
    "it records against the SECOND click's state, not the first",
  );
});

// ---------------------------------------------------------------------------
// The web-only cases: `null` is not a miss
// ---------------------------------------------------------------------------

test('a pick that is not ready yet keeps waiting instead of resolving', () => {
  // THE DIVERGENCE FROM THE DESKTOP. `picker.py`'s retrieve() always answers,
  // because the readback is synchronous by the time it is called. WebGPU's
  // mapAsync means the answer can simply not be there yet, and `null` says so.
  //
  // If `null` were treated as a miss, every click whose readback took longer
  // than one frame would be silently dropped -- and it would look like "clicks
  // sometimes don't register", which is exactly the kind of bug nobody can
  // reproduce on demand.
  const { host, sel } = harness();
  host.queued = { index: 42 };

  sel.select([10, 20]);
  host.queued = null; // the readback has not landed

  assert.equal(sel.resolve(), null, 'resolve consumes nothing');
  assert.equal(sel.isPending, true, 'the click is STILL pending');
  // `.length` rather than deepEqual against []: comparing the array itself
  // narrows its type to never[] for the rest of the block, and the assertion
  // after the wait then fails to compile.
  assert.equal(host.recorded.length, 0, 'nothing recorded');
  assert.equal(host.project, 'P0', 'project untouched');

  // ...and the next frame, when it does land, it still records against P0.
  host.queued = { index: 42 };
  sel.resolve();
  assert.equal(host.recorded.length, 1);
  assert.equal(host.recorded[0]!.before, 'P0', 'the click-time state survived the wait');
});

test('resolve does nothing when no click is pending', () => {
  // The frame loop calls resolve() unconditionally at the top of every frame,
  // so the overwhelmingly common case is that nothing is pending. It must not
  // consume a result that no click asked for.
  const { host, sel } = harness();
  host.queued = { index: 3 };

  assert.equal(sel.resolve(), null);
  assert.deepEqual(host.recorded, []);
  assert.equal(host.project, 'P0');
});
