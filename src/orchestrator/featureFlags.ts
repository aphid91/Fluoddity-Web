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
 * Reset the simulation whenever the config on screen CHANGES.
 *
 * Many configs only look right from their initial conditions, so thumbing
 * through File -> Load without this shows each preset's settings applied to
 * whatever soup the previous one had already evolved into. With it, every
 * config arrives on a fresh simulation, the same as pressing R.
 *
 * **THE HOVER IS THE LOAD.** The menu applies each row as the pointer reaches
 * it, so that -- not the click afterwards -- is the moment a config first
 * appears and first needs restarting. The committed click changes nothing: the
 * project already holds the previewed config, so resetting there would restart
 * a simulation the user had been watching settle since they hovered the row
 * they chose. Restoring on mouse-out likewise resets, or abandoning the menu
 * would leave the original config's settings running on a previewed sim's
 * evolved state.
 *
 * Covers hover-preview, the mouse-out restore, and the paths with no hover at
 * all: the LEFT/RIGHT preset cycle, Revert to Saved, a shared link opened
 * mid-session, and checkpoint apply/restore. See `Orchestrator.resetForConfig`.
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
export const RESET_ON_CONFIG_UNDO_REDO = false;

/**
 * Re-run the welcome splash and GPU calibration on EVERY visit.
 *
 * Normally both happen exactly once, on a genuine first visit, gated on the
 * `calibrated` preference. With this on, every load behaves like a first one:
 * the splash comes up, the ladder walks, and the result is committed over
 * whatever was already stored.
 *
 * **A DEVELOPMENT AID, NOT A PRODUCT BEHAVIOUR.** For a real user this is
 * plainly wrong -- a modal and a full simulation rebuild every time they open
 * the app. It exists because tuning calibration otherwise means clearing
 * `localStorage` by hand between every single test run, which is enough
 * friction to discourage the measuring that tuning needs.
 *
 * Unlike the two flags above, this one is NOT an open question about the
 * product: the answer is permanently `false` for anything shipped. It stays
 * because the next person to touch the progression, the burn-in or the frame
 * budget will want it again, and rediscovering the trick is wasted work.
 *
 * `?nocalibrate` still overrides it. The verification tools depend on that, and
 * a debug convenience must never be able to break the screenshot comparisons.
 */
export const ALWAYS_CALIBRATE = false;
