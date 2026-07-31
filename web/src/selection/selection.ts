/**
 * The pending-selection bookkeeping: which project state a click belongs to.
 *
 * Selection is two-phase. The click dispatches a pick; the NEXT frame reads the
 * winner and adopts its rule. That split creates exactly one way to get history
 * wrong -- recording the undo entry against the project as it stands when the
 * RESULT LANDS, rather than as it stood when the user CLICKED. Anything that
 * edited the project in between would then be swallowed into the selection's
 * entry, and undoing the selection would silently undo that edit too.
 *
 * So the click-time project is captured at click time. That is the whole job.
 *
 * ## Why this is its own module
 *
 * It is pure -- no GPU, no Project type, no DOM -- so it is testable under
 * `node --test`, and `selection.test.ts` is a direct port of
 * `tests/test_pending_selection.py` (160 lines, five groups). The desktop keeps
 * this state on the Orchestrator (`orchestrator/selection_commands.py:97-152`);
 * Step 7 builds the Orchestrator and will hold one of these.
 *
 * ## Generic over the project type, deliberately
 *
 * The only thing this knows about a project is that it has REFERENCE IDENTITY.
 * `_record_history` guards on `before is not self.project`
 * (`selection_commands.py:198`) and `!==` is the port of that -- which means a
 * spread copy anywhere in the chain silently breaks the guard. Being generic is
 * what lets the test use a string stand-in and see exactly which state each
 * entry was recorded against, the same trick the Python's `P(str)` plays.
 */

/**
 * The click-time state of one in-flight pick.
 *
 * LAST CLICK WINS. A second click while one is pending REPLACES it, carrying
 * its own `before` -- because the GPU dispatch is overwritten regardless (there
 * is one result slot), so honouring the older click would adopt a rule from a
 * pick aimed somewhere else. `selection_commands.py:111-113` makes the same
 * argument; here it falls out of plain assignment.
 */
export class PendingSelection<P> {
  private pending: P | null = null;

  /**
   * Record that a pick was just dispatched, against `project`.
   *
   * Call this AT CLICK TIME with the project as it stands at click time. That
   * is the entire contract -- passing the project later, when the result
   * arrives, is the bug this class exists to make hard.
   */
  begin(project: P): void {
    this.pending = project;
  }

  /**
   * Take the click-time project, clearing it. `null` if no pick is pending.
   *
   * CLEARED BEFORE THE CALLER READS THE PICK RESULT, matching
   * `selection_commands.py:140` -- so a second resolve in the same frame, or a
   * resolve after a miss, is a no-op rather than recording a duplicate entry.
   */
  take(): P | null {
    const project = this.pending;
    this.pending = null;
    return project;
  }

  /** Whether a click is waiting for its result. */
  get isPending(): boolean {
    return this.pending !== null;
  }
}

/**
 * What `SelectionController` needs from the rest of the app.
 *
 * Named as an interface rather than taking the real collaborators because those
 * are Step 7's (the Orchestrator, the Project, the command bus) -- and because
 * the ordering this class enforces is testable only against fakes. The shape
 * mirrors the `Harness` in `tests/test_pending_selection.py:48-66`, which is
 * the same list of collaborators for the same reason.
 */
export interface SelectionHost<P, R> {
  /** Dispatch a pick at `pixel`. Phase 1; the result arrives on a later frame. */
  requestPick(pixel: readonly [number, number]): void;
  /**
   * The pick result if one is ready, else `null`.
   *
   * `null` and a MISS ARE DIFFERENT and must stay so. `null` means "no answer
   * yet" -- the readback is still in flight, and the pending click must keep
   * waiting. A miss is an answer: nothing was in range. Collapsing them drops
   * the selection every frame the GPU has not finished.
   */
  retrievePick(): R | null;
  /** Whether a result is a hit worth adopting. */
  isHit(result: R): boolean;
  /** The project as it stands now. */
  currentProject(): P;
  /** Adopt the picked rule, returning the NEW project. */
  adoptRule(project: P, result: R): P;
  /** Install the new project. */
  setProject(project: P): void;
  /** Record one undoable entry. `before` is the CLICK-time project. */
  recordHistory(before: P, label: string): void;
  /** Remember what is selected, hit or miss (the desktop's `self.selected`). */
  setSelected(result: R): void;
  /** How to label the entry in the undo stack. */
  describe(result: R): string;
}

/**
 * The click-to-adopt cycle. The port of `SelectionCommands`
 * (`orchestrator/selection_commands.py:97-152`).
 *
 * TWO ORDERING CONSTRAINTS, both load-bearing, both enforced by where the
 * caller puts these two methods rather than by anything in here:
 *
 *  1. `resolve()` runs at the TOP OF THE FRAME, before input can call
 *     `select()`. Read before write: there is one result slot, so a new
 *     dispatch would clobber the answer being read.
 *  2. `resolve()` runs in the FRAME LOOP, NOT inside `advance()`. `advance()`
 *     is skipped while paused, and clicking to select must keep working when it
 *     is -- which is precisely when a user wants to inspect a particle.
 *
 * `orchestrator.py:260-279` states both, and Step 7's frame loop must preserve
 * them when it takes this over from `main.ts`.
 */
export class SelectionController<P, R> {
  private readonly pending = new PendingSelection<P>();
  // Declared and assigned separately rather than as a constructor parameter
  // property: `npm test` runs TypeScript through Node's STRIP-ONLY type
  // stripping, which rejects `constructor(private readonly host: ...)` outright
  // (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). tsc accepts it, so the failure shows up
  // only when the tests run.
  private readonly host: SelectionHost<P, R>;

  constructor(host: SelectionHost<P, R>) {
    this.host = host;
  }

  /** Whether a click is waiting for its result. */
  get isPending(): boolean {
    return this.pending.isPending;
  }

  /**
   * Phase 1: the click. Dispatches a pick and captures the click-time project.
   *
   * Records NO history and changes NO state beyond the pending slot -- there is
   * nothing to record yet, because which particle was hit is not known until
   * the result comes back.
   */
  select(pixel: readonly [number, number]): void {
    this.host.requestPick(pixel);
    // CAPTURED HERE, not at resolve time. This is the whole point of the class.
    this.pending.begin(this.host.currentProject());
  }

  /**
   * Phase 2: the result. Adopts the winner's rule and records one entry.
   *
   * Returns the result if one was consumed, else `null`.
   */
  resolve(): R | null {
    if (!this.pending.isPending) return null;

    // Ask BEFORE clearing: a `null` here means the readback is still in flight,
    // and the pending click has to survive to the next frame. Clearing first
    // (as the desktop can afford to, because its retrieve() always answers)
    // would drop every click that took more than one frame to come back.
    const result = this.host.retrievePick();
    if (result === null) return null;

    const before = this.pending.take()!;
    this.host.setSelected(result);

    // A miss is a real answer: clear the pending click, record nothing, leave
    // the project alone. `selection_commands.py:145` returns here too.
    if (!this.host.isHit(result)) return result;

    const adopted = this.host.adoptRule(this.host.currentProject(), result);
    this.host.setProject(adopted);
    // NO COALESCE KEY, deliberately (`selection_commands.py:152`): a selection
    // must never merge into a neighbouring slider drag, or undoing the drag
    // would also undo the selection.
    this.host.recordHistory(before, this.host.describe(result));
    return result;
  }
}
