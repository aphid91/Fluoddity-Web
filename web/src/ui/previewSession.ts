/**
 * Hover-to-preview, for the two surfaces that browse config collections.
 *
 * A verbatim port of `ui/hover_preview.py` (118 lines, zero imgui). The contract:
 *
 *     open        snapshot the current ConfigBuffer
 *     hover X     apply X (previewing)
 *     hover none  restore the snapshot
 *     close       restore the snapshot...
 *     click X     ...UNLESS a click committed, which drops the snapshot so the
 *                 closing restore cannot undo the user's choice
 *
 * **That last row is the one that is easy to get wrong**, and getting it wrong
 * is silent: a naive implementation restores on close and throws away the config
 * the user just picked. They see it load and then unload for no reason.
 *
 * ## Why this is a class rather than state on the menu
 *
 * Two surfaces browse this way -- File > Load and the checkpoint list -- and the
 * first implementation kept a single shared snapshot slot. With two independent
 * surfaces that breaks: hovering a checkpoint while the Load menu is also open
 * overwrites the menu's snapshot, and unhovering restores the wrong state. Each
 * surface owns its own session, and each session takes its own snapshot, so they
 * cannot clobber one another regardless of what is open
 * (`hover_preview.py:13-19`).
 *
 * The Orchestrator's `previewOrigins` is keyed by surface for the same reason --
 * Step 10 made that a `Map` rather than the desktop's single field.
 *
 * The session holds no config data itself: it calls back into the host for the
 * three operations it needs, so it works for stored configs and in-memory
 * checkpoints alike.
 */

/** What a session does to the world. Injected, so this module has no host. */
export interface PreviewCallbacks<T> {
  /** Capture the current state. */
  readonly onSnapshot: () => void;
  /** Put the captured state back. */
  readonly onRestore: () => void;
  /** Apply the hovered item, for preview. */
  readonly onApply: (item: T) => void;
}

export class PreviewSession<T, K> {
  private readonly callbacks: PreviewCallbacks<T>;
  private readonly keyOf: (item: T) => K;

  private open = false;
  /**
   * Whether a snapshot is outstanding.
   *
   * A boolean rather than the snapshot itself: on the web the state lives in the
   * Orchestrator (keyed by surface), so what this tracks is whether a restore is
   * still owed -- the desktop holds the `Project` here because its callback
   * returns one synchronously.
   */
  private snapshot = false;
  private committed = false;
  /** Key of the item currently previewed, or `null`. */
  private previewing: K | null = null;

  constructor(callbacks: PreviewCallbacks<T>, keyOf: (item: T) => K) {
    this.callbacks = callbacks;
    this.keyOf = keyOf;
  }

  /** Call when the surface opens. Idempotent within a session. */
  begin(): void {
    if (this.open) return;
    this.open = true;
    this.committed = false;
    this.previewing = null;
    this.snapshot = true;
    this.callbacks.onSnapshot();
  }

  /** Call when the surface closes. Restores unless a click committed. */
  end(): void {
    if (!this.open) return;
    this.open = false;
    if (!this.committed && this.snapshot) this.callbacks.onRestore();
    this.snapshot = false;
    this.previewing = null;
  }

  /**
   * Apply or undo previews as the hovered item changes. Once per frame.
   *
   * Driven from the frame loop rather than from the events themselves: a
   * row-to-row move fires `mouseleave` then `mouseenter`, and reacting to each
   * would restore the snapshot between two previews -- a visible flicker back to
   * the original config on every row the cursor crosses.
   */
  sync(hovered: T | null): void {
    if (!this.open) return;
    const key = hovered === null ? null : this.keyOf(hovered);
    if (key === this.previewing) return;

    if (hovered === null) {
      // A committed choice is no longer a preview: unhovering must not undo it.
      // This matters for surfaces that stay open after a click -- the cursor is
      // still on the row afterwards, and moving it away would otherwise restore
      // the state the user just deliberately chose.
      if (this.committed) {
        this.previewing = null;
        return;
      }
      this.restoreNow();
    } else {
      this.callbacks.onApply(hovered);
    }
    this.previewing = key;
  }

  /**
   * Mark the current preview as chosen.
   *
   * Neither `end()` nor a later unhover will undo it: the snapshot is dropped
   * outright, so there is nothing left to restore by any path.
   */
  commit(key: K | null = null): void {
    this.committed = true;
    this.snapshot = false;
    this.previewing = key;
  }

  /** Put the snapshot back without ending the session. No-op after a commit. */
  restoreNow(): void {
    if (this.snapshot) this.callbacks.onRestore();
  }

  /**
   * Drop the snapshot without restoring, and take a fresh one.
   *
   * For when the snapshot has become meaningless -- the previewed item was
   * deleted, so restoring it would resurrect state the user just discarded.
   */
  forget(): void {
    this.snapshot = true;
    this.callbacks.onSnapshot();
    this.previewing = null;
  }

  /** Whether the surface is open. */
  get isOpen(): boolean {
    return this.open;
  }
}
