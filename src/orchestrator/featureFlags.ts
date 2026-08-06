/**
 * Build-time feature flags: experiments that are not yet decided.
 *
 * A flag lives here only while the question "do we keep this?" is genuinely
 * open. Once answered, the flag and the branch it guards should BOTH go --
 * either the code inlines or it is deleted. A permanent `if (FLAG)` is a
 * permanent second code path to reason about, which is the cost these are
 * meant to be paying off, not accruing.
 *
 * Deliberately plain `const`s rather than preferences: these are not settings
 * the user chooses, and they must not accumulate UI, persistence or a
 * migration. Flipping one is an edit to this file.
 */

/**
 * Reset the simulation whenever a config is committed.
 *
 * Many configs only look right from their initial conditions, so thumbing
 * through File -> Load without this shows each preset's settings applied to
 * whatever soup the previous one had already evolved into. With it, every
 * committed load starts the simulation over, the same as pressing R.
 *
 * Covers the committed paths only -- File -> Load, the LEFT/RIGHT preset
 * cycle, Revert to Saved, a shared link opened mid-session, and restoring a
 * checkpoint. Hover-preview is deliberately NOT covered: browsing forty rows
 * would restart the simulation forty times, and the restore on mouse-out could
 * not put back what the resets destroyed. See `Orchestrator.resetForConfig`.
 */
export const RESET_ON_CONFIG_LOAD = true;

/**
 * Reset the simulation on undo and redo.
 *
 * The sister of `RESET_ON_CONFIG_LOAD`, for the same reason: an undo that
 * restores a config's settings without restoring its opening conditions shows
 * a state the user never actually had. Kept separate because stepping through
 * an edit gesture is a different act from loading a preset, and wanting the
 * one restarted is not wanting the other restarted.
 */
export const RESET_ON_CONFIG_UNDO_REDO = true;
