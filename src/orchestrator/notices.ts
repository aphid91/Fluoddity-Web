/**
 * The wording of the transient messages, as pure functions.
 *
 * ## Why this is a leaf with tests
 *
 * These strings are the entire feature. A toast that says the wrong thing is
 * worse than no toast: the user is being told what just happened to their work,
 * and "Undo: Load Preset" after undoing a slider drag actively misleads. The
 * wording is also the part most likely to drift as new commands are added, since
 * nothing about a compiler notices a stale phrase.
 *
 * So the vocabulary lives here, pure and testable under `node --test` -- the
 * Orchestrator needs a GPU and cannot be constructed there, exactly as
 * `blurSchedule` and `recordingSettings` are split out for the same reason.
 *
 * ## The two sources of a message
 *
 * **History labels**, for undo and redo. `History` already stores one per step
 * (`recordHistory(before, 'edit Mutation Scale')`), so undo/redo do not need a
 * second vocabulary -- they need that one presented. `describeHistoryStep`
 * turns the stored form into the displayed one.
 *
 * **Direct events**, for the behaviour changes that are not undo. Loading a
 * preset, committing a selection, restoring a checkpoint and opening a share
 * link all replace what every particle is trying to do, and the picture can take
 * a moment to show it -- which is the under-signalling this feature exists to
 * fix. Those are built by `describeEvent` at the site that knows the details.
 *
 * ## Why the stored labels are not simply displayed
 *
 * They were written for a menu item ("Revert to Saved", "Undo <label>") and read
 * as lowercase verb phrases: `edit Mutation Scale`, `load Crystal`. Prefixing
 * those with `Undo: ` gives "Undo: edit Mutation Scale", which is a sentence
 * with a hiccup in it. Capitalising at the boundary keeps the stored labels
 * unchanged -- they still serve the menu -- while the toast reads as a title.
 */

/** Sentence-case a stored history label: `edit X` -> `Edit X`. */
function capitalize(label: string): string {
  return label === '' ? '' : label[0]!.toUpperCase() + label.slice(1);
}

/**
 * What to say after an undo or a redo.
 *
 * `label` is the history entry's own text. An EMPTY label yields a bare
 * "Undo"/"Redo" rather than a dangling colon: entry 0 carries no label (nothing
 * produced it), and a step recorded before this feature existed may carry none
 * either. Saying just "Undo" is honest about not knowing rather than inventing
 * a description.
 */
export function describeHistoryStep(
  direction: 'undo' | 'redo',
  label: string,
): string {
  const verb = direction === 'undo' ? 'Undo' : 'Redo';
  const what = capitalize(label.trim());
  return what === '' ? verb : `${verb}: ${what}`;
}

/**
 * A behaviour change that is not an undo, described for the toast.
 *
 * These are exactly the events that replace the particles' target rule without
 * the user having dragged anything -- the cases where the app changes
 * underneath you and the picture may take a beat to show it.
 *
 * Named as a closed union rather than taking a free string, so adding another
 * event is a compile error at every site that switches on it rather than a
 * silently missing message.
 *
 * MEMBERSHIP IS EARNED BY BEING RECORDED TO HISTORY, not by being worth
 * announcing: `historyLabelFor` derives an undo label from every member, so a
 * one-shot that pushes no history step does not belong here even when it wants
 * a toast. `describeCheckpointSet` is the standing example of the other case.
 */
export type BehaviorEvent =
  | { readonly kind: 'loadPreset'; readonly name: string }
  | { readonly kind: 'commitSelection'; readonly cohort: number }
  | { readonly kind: 'loadCheckpoint'; readonly name: string }
  | { readonly kind: 'loadSharedLink' }
  | { readonly kind: 'randomizeBehavior' }
  | { readonly kind: 'randomizeSeed' };

export function describeEvent(event: BehaviorEvent): string {
  switch (event.kind) {
    case 'loadPreset':
      return `Load Preset — ${event.name}`;
    case 'commitSelection':
      // The cohort NUMBER, because that is what the user aimed at and what the
      // stepper beside the mutation slider shows. Without it the message cannot
      // be told apart from any other selection.
      return `Commit Selection of cohort ${String(event.cohort)}`;
    case 'loadCheckpoint':
      return `Load checkpoint ${event.name}`;
    case 'loadSharedLink':
      return 'Load project from URL';
    case 'randomizeBehavior':
      // NO NAME TO GIVE, unlike the loads above: the rule is zeroed and the GPU
      // generates a fresh one from the seed, so there is nothing the user could
      // be pointed back to. "Randomize behavior" is the whole of what happened.
      //
      // Lowercase "behavior" matches `loadCheckpoint` above, and the American
      // spelling matches the command name and the menu item ("Randomize
      // Behavior") rather than the British "behaviour" these comments use.
      return 'Randomize behavior';
    case 'randomizeSeed':
      // "MUTATIONS", MATCHING THE BUTTON THAT SENDS IT. This message is only
      // ever reached with an AUTHORED rule -- under the sentinel the command
      // redirects to `randomizeBehavior` and reports as that instead, because
      // there it IS that. So the word is accurate wherever this string can
      // appear, which is exactly the guarantee the redirect buys.
      return 'Reroll mutations';
    default: {
      // Exhaustiveness: a new `BehaviorEvent` member fails to compile here
      // rather than falling through to an empty message at runtime.
      const unreachable: never = event;
      throw new Error(`No message for event ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * What to say when a checkpoint is captured.
 *
 * **NOT A `BehaviorEvent`, deliberately.** Every member of that union replaces
 * what the particles are chasing and is recorded to history, which is why
 * `historyLabelFor` can derive an undo label from any of them. Setting a
 * checkpoint changes no behaviour and is not undoable -- `setCheckpoint` copies
 * the project into a list and returns. Adding it to the union would force a
 * history label for a step that cannot be undone, and the exhaustiveness switch
 * would then owe a message to a case that never appears in history.
 *
 * So it is its own function: same toast, same vocabulary, no undo entry implied.
 *
 * THE NAME IS THE POINT. `CheckpointStore.capture` picks it (`<project><NN>`,
 * numbered per project), and it is what the Checkpoints menu will list the entry
 * under -- so naming it here is what lets a user find again the thing they just
 * set. A bare "Checkpoint set" would announce that something happened without
 * saying what to look for.
 */
export function describeCheckpointSet(name: string): string {
  return `Checkpoint set: ${name}`;
}

/**
 * The history label for a behaviour event, so undo of it reads correctly.
 *
 * **THE SAME EVENT DESCRIBES ITSELF TWICE**, and the two must agree: the toast
 * shown when it happens, and the toast shown when it is undone. Deriving the
 * history label from the same value is what keeps "Load Preset — Crystal" and
 * "Undo: Load Preset — Crystal" describing one act rather than two that happen
 * to be near each other.
 *
 * Lowercased at the front, because that is the convention the stored labels
 * already follow for the menu ("Undo <label>") and `describeHistoryStep`
 * capitalises on the way out.
 */
export function historyLabelFor(event: BehaviorEvent): string {
  const text = describeEvent(event);
  return text[0]!.toLowerCase() + text.slice(1);
}
