/**
 * Undo/redo over whole projects. A direct port of `project/history.py` (197).
 *
 * ## What is undoable
 *
 * Every deliberate act: slider edits, particle selection, seed randomization,
 * committed loads, preset cycling, checkpoint restores.
 *
 * TWO THINGS ARE DELIBERATELY EXCLUDED, and neither is an oversight:
 *
 *   HOVER-PREVIEW (and its restore). The load list applies a config as the
 *   cursor crosses each row, then puts it back when you move away. These are
 *   transient states the user never chose -- browsing forty configs would
 *   otherwise leave forty entries and evict real work. Only the COMMITTED load
 *   records. Coalescing cannot help: previews are not rapid edits to merge,
 *   they revert themselves.
 *
 *   UNDO AND REDO. They call the same `setProject` everything else does, so
 *   recording them would make undo push a history entry -- history about
 *   history.
 *
 * ## Coalescing
 *
 * A slider drag fires an edit per frame; without merging, two seconds of
 * dragging would be a hundred entries. Consecutive records sharing a
 * `coalesceKey` within `COALESCE_WINDOW_MS` collapse into one: the entry's
 * END state is updated in place while its start state stays put, so undo jumps
 * over the whole gesture.
 *
 * Keying on the field means moving to a different slider starts a new entry,
 * and pausing does too. Deliberate one-shot acts pass no key, so they never
 * merge -- randomizing the seed twice in a row is two undo steps, which is what
 * you want from a button.
 *
 * ## How it works
 *
 * Entries hold references to `Project`, which is immutable, so a snapshot costs
 * a pointer rather than a copy. `undo`/`redo` move a cursor rather than
 * destroying state, which is what makes redo nearly free.
 *
 * ## The one porting note
 *
 * `time.monotonic()` becomes `performance.now()`, which is milliseconds where
 * the Python is seconds. `COALESCE_WINDOW` is therefore stated in MILLISECONDS
 * here (1500, not 1.5). Getting that wrong does not error -- it makes every edit
 * coalesce forever, or none of them, and both read as "undo is behaving oddly"
 * rather than as a unit bug. `now` is injectable for exactly that reason: the
 * tests drive the window explicitly instead of sleeping.
 */

import type { Project } from './project.ts';

/**
 * Entries kept before the oldest is dropped. The original used 200; with
 * coalescing a drag is one entry, so 100 covers a long session of real actions.
 */
export const MAX_HISTORY = 100;

/**
 * Milliseconds within which same-key records merge. Long enough to bridge the
 * gaps in a slider drag, short enough that a deliberate second adjustment is
 * its own undo step.
 *
 * **MEASURED FROM THE LAST EDIT, NOT THE START OF THE DRAG.** `record` refreshes
 * `lastTime` on every merge, so a continuous drag coalesces for as long as it
 * lasts and this bound only decides how long a PAUSE may be before the gesture
 * is considered over.
 *
 * Raised from the Python's 0.5 s because nothing on the slider path calls
 * `breakCoalescing` -- Tweakpane's `ev.last` release is consumed by the gate
 * hold in `controls.ts` and never reaches history -- so a timeout is the ONLY
 * way a gesture ends. At 500 ms, hesitating on a value mid-drag to look at the
 * result, which is the normal way these sliders get used, split one adjustment
 * into several undo steps. 1.5 s covers that hesitation; a considered second
 * adjustment takes longer than this and still earns its own step.
 */
export const COALESCE_WINDOW_MS = 1500;

/** A project state and what the user did to leave it. */
export interface HistoryEntry {
  readonly project: Project;
  readonly label: string;
}

/**
 * A key identifying a continuous gesture. `(source, field)` on the desktop --
 * a tuple, which JavaScript cannot compare by value, so the port joins them
 * into a string. `null` means "one-shot act, never merge".
 */
export type CoalesceKey = string | null;

/**
 * A bounded undo/redo timeline of project states.
 *
 * THE MODEL: `states` is the full timeline, oldest first, and `cursor` is the
 * index of the state currently live. Undo decrements it, redo increments it,
 * and both simply return `states[cursor]`.
 *
 * Framing it as "where am I on the timeline" rather than "what would undo
 * restore" is what keeps the two operations symmetric -- an earlier version had
 * the cursor trail the live state by one and needed different arithmetic in
 * each direction, which was a bug waiting to happen.
 *
 * Because the live state is always IN the timeline, callers seed it once at
 * startup.
 */
export class History {
  /** The timeline, oldest first. Entry 0 has no label -- nothing produced it. */
  private states: HistoryEntry[] = [];
  /** Index of the live state within `states`; -1 while empty. */
  private cursorIndex = -1;
  private readonly max: number;
  private readonly windowMs: number;
  /** Key and timestamp of the last record, for merging a run of edits. */
  private lastKey: CoalesceKey = null;
  private lastTime = 0;

  constructor(max = MAX_HISTORY, windowMs = COALESCE_WINDOW_MS) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /**
   * Record an undoable step from `before` to `after`.
   *
   * BOTH states are needed. Recording only `after` is wrong when anything
   * reaches the project without recording (previews do), because the timeline
   * would still hold a stale start state; re-seating the current entry on
   * `before` means undo returns you to the moment just before you acted.
   *
   * `now` is injectable so tests can drive the coalescing window without
   * sleeping -- the same reason the Python takes it.
   */
  record(
    before: Project,
    after: Project,
    label = '',
    coalesceKey: CoalesceKey = null,
    now: number = performance.now(),
  ): void {
    if (this.canCoalesce(coalesceKey, now)) {
      // Extend the gesture in place: the start state stays put, so undo still
      // jumps over the whole drag, and only the end moves.
      this.states[this.cursorIndex] = { project: after, label };
      this.lastTime = now;
      return;
    }

    if (this.states.length > 0 && this.cursorIndex >= 0) {
      // A new action invalidates any redo entries ahead of the cursor.
      this.states.length = this.cursorIndex + 1;
      // Re-seat the current entry on the state actually being left -- previews
      // can move the project without recording, so the stored one may be stale.
      //
      // **THE PROJECT IS RE-SEATED; THE LABEL IS KEPT.** This used to assign a
      // whole fresh entry with `label: ''`, which silently erased the label of
      // the step already sitting here -- so recording B wiped A's name and only
      // the newest step could describe itself. That was invisible while labels
      // fed `undoLabel` alone (the menu shows one row, always the newest), and
      // became visible the moment undo and redo started announcing themselves.
      //
      // A label describes the act that PRODUCED this state, and re-seating does
      // not change which act that was -- it corrects where that act landed. So
      // the label is not merely safe to keep, it would be wrong to drop.
      const current = this.states[this.cursorIndex];
      this.states[this.cursorIndex] = {
        project: before,
        label: current?.label ?? '',
      };
    } else {
      this.states.push({ project: before, label: '' });
      this.cursorIndex = 0;
    }
    this.states.push({ project: after, label });
    this.trim();

    this.lastKey = coalesceKey;
    this.lastTime = now;
  }

  /** True if this record should extend the previous entry. */
  private canCoalesce(key: CoalesceKey, now: number): boolean {
    return (
      key !== null &&
      key === this.lastKey &&
      this.cursorIndex > 0 && // never merge into the seed
      now - this.lastTime <= this.windowMs
    );
  }

  /**
   * End the current gesture, so the next record starts a new entry.
   *
   * Anything that is not a continuation should call this -- undo/redo most of
   * all, since resuming a drag after undoing must not rewrite the entry the
   * user just stepped back to.
   */
  breakCoalescing(): void {
    this.lastKey = null;
  }

  /** Put the session's starting state on the timeline. */
  seed(project: Project): void {
    this.states = [{ project, label: '' }];
    this.cursorIndex = 0;
  }

  private trim(): void {
    if (this.states.length > this.max) {
      this.states.splice(0, this.states.length - this.max);
    }
    this.cursorIndex = this.states.length - 1;
  }

  /** Move one step back along the timeline. Returns the state to restore. */
  undo(): Project | null {
    if (!this.canUndo) return null;
    this.cursorIndex -= 1;
    return this.states[this.cursorIndex]?.project ?? null;
  }

  /** Move one step forward along the timeline. */
  redo(): Project | null {
    if (!this.canRedo) return null;
    this.cursorIndex += 1;
    return this.states[this.cursorIndex]?.project ?? null;
  }

  get canUndo(): boolean {
    return this.cursorIndex > 0;
  }

  get canRedo(): boolean {
    return this.cursorIndex >= 0 && this.cursorIndex < this.states.length - 1;
  }

  /** Number of states on the timeline, including the live one. */
  get depth(): number {
    return this.states.length;
  }

  get cursor(): number {
    return this.cursorIndex;
  }

  /** What undo would take back, for menu text. Empty when nothing would. */
  undoLabel(): string {
    if (!this.canUndo) return '';
    return this.states[this.cursorIndex]?.label ?? '';
  }

  /**
   * What redo would re-apply. Empty when nothing would.
   *
   * **NOT the mirror of `undoLabel`, and the asymmetry is the point.** A label
   * describes the act that PRODUCED its state. Undo takes back the act at the
   * current cursor, so it reads `cursorIndex`; redo re-applies the act that
   * produced the NEXT state, so it reads `cursorIndex + 1`. Using the same index
   * for both would make redo announce the step it is moving away from -- and the
   * two only differ by one, so it would look almost right.
   */
  redoLabel(): string {
    if (!this.canRedo) return '';
    return this.states[this.cursorIndex + 1]?.label ?? '';
  }
}
