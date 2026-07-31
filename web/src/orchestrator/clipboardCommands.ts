/**
 * Config Clipboard: in-session checkpoints of the whole project.
 * The port of `orchestrator/clipboard_commands.py` (85 lines).
 *
 * A scratch space for experimenting -- checkpoint before changing things and
 * you can get back, without committing anything to disk. Session-only: saving
 * (Step 9) is the route for anything worth keeping.
 *
 * ## Why this is a class where the desktop's is a mixin
 *
 * `ClipboardCommands` on the desktop "owns no state of its own beyond what
 * lives there" -- it reads and replaces `self.checkpoints` and
 * `self._checkpoint_serial` on the Orchestrator. That is exactly the coupling
 * the plan asks Step 7 to make explicit, and a checkpoint list is genuinely a
 * thing with its own invariants (unique names, newest first, opaque keys), so
 * it becomes a small owned collaborator rather than functions taking a mutable
 * array.
 *
 * The Orchestrator holds one and asks it questions; it never reaches inside.
 */

import { type Project, renamed } from '../project/project.ts';
import type { CheckpointView } from './commands.ts';

/**
 * An in-session snapshot of the whole project.
 *
 * Holds a `Project` rather than a bare config list, so restoring one restores
 * the name and selection too.
 *
 * `key` is an OPAQUE ID rather than the name, so the hover-preview machinery
 * keeps tracking the right entry even if two checkpoints ever share a name.
 * That is not hypothetical: `checkpointName` numbers per project, so switching
 * projects and back can reissue a name that a surviving checkpoint already has.
 */
export interface Checkpoint {
  readonly name: string;
  readonly project: Project;
  readonly key: number;
}

/** Newest first, with unique names and opaque keys. */
export class CheckpointStore {
  private items: Checkpoint[] = [];
  /** Monotonic, never reused -- see `Checkpoint.key`. */
  private nextKey = 0;
  /**
   * Fallback counter for the past-100-of-a-name case. Separate from `nextKey`
   * because it numbers NAMES, not identities, and the two run out at different
   * rates.
   */
  private serial = 0;

  /**
   * Unique `<project><NN>` name, numbered per project.
   *
   * Numbering SCANS existing checkpoints rather than using a global counter, so
   * deleting entries frees their numbers back up and the list does not drift
   * into high numbers after a lot of churn.
   */
  private nameFor(project: Project): string {
    const stem = project.name || 'Project';
    const taken = new Set(this.items.map((c) => c.name));
    for (let n = 0; n < 100; n++) {
      const candidate = `${stem}${String(n).padStart(2, '0')}`;
      if (!taken.has(candidate)) return candidate;
    }
    // Past 100 of the same name, fall back to something guaranteed unique.
    this.serial += 1;
    return `${stem}_${this.serial}`;
  }

  /**
   * Capture the whole project. Newest goes on top.
   *
   * The stored project is RENAMED to the checkpoint's name, so restoring one
   * renames the project to match what the user picked from the list -- the
   * desktop does the same (`clipboard_commands.py:60`), and it is what stops a
   * restored checkpoint claiming to be the project it was cloned from.
   */
  capture(project: Project): Checkpoint {
    const name = this.nameFor(project);
    const checkpoint: Checkpoint = {
      name,
      project: renamed(project, name),
      key: this.nextKey++,
    };
    this.items.unshift(checkpoint);
    return checkpoint;
  }

  remove(key: number): void {
    this.items = this.items.filter((c) => c.key !== key);
  }

  byKey(key: number): Checkpoint | null {
    return this.items.find((c) => c.key === key) ?? null;
  }

  latest(): Checkpoint | null {
    return this.items[0] ?? null;
  }

  get count(): number {
    return this.items.length;
  }

  /**
   * The list as the UI sees it: names and keys, no projects.
   *
   * The narrowing is the point (invariant 10). A `Checkpoint` carries a live
   * `Project`; handing that to the UI would give it simulation state to hold,
   * and the UI's only legitimate need is to draw a row and say which one was
   * clicked -- which a key answers.
   */
  views(): readonly CheckpointView[] {
    return this.items.map(({ name, key }) => ({ name, key }));
  }
}
