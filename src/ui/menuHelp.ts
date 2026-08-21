/**
 * Help text for the menu bar's rows.
 *
 * ## Why this is a table rather than an argument on `addItem`
 *
 * `menuBar.ts` builds its rows inline, and threading a paragraph of prose
 * through each `addItem` call would push the structure of the menu off the
 * screen -- the file's whole readable shape is "here is File, here is what is
 * under it", and a five-line string per row destroys that.
 *
 * Keyed by the row's STATIC LABEL, which is already the identity `addItem`
 * writes into `data-item` and which `uiCheck.mjs` and the tests select on. So
 * there is no third name to keep in sync: rename a row and its help follows
 * only if this key is renamed too, which is a lookup that silently returns
 * nothing rather than a mismatch that silently shows the wrong text.
 *
 * ## Two menus deliberately share entries
 *
 * Set Checkpoint and Load Latest Checkpoint describe one feature from two ends,
 * so they take the same words rather than two paraphrases that could drift.
 * Same for the bar buttons that mirror Simulation rows -- but those live in
 * `mutationOverlay.ts`, which imports the shared constants below rather than
 * restating them.
 */

/**
 * What File > Save, the share link and the checkpoint system all cover.
 *
 * ONE STRING, THREE ROWS. Save, Copy Link and Set/Load Checkpoint each store
 * the same thing -- the project panel plus the live particle behavior -- and
 * three hand-written paraphrases of that scope would be three places for it to
 * go stale when the scope changes. The sentence is appended to each row's own
 * lead rather than being a paragraph of its own, because at this length it
 * reads as part of the description rather than as a footnote.
 */
const PROJECT_SCOPE =
  'Stores all the settings on the project panel and current particle behavior ' +
  '(including mutations)';

/**
 * Randomize Behavior, shared with the bar's Reroll All Behavior button.
 *
 * Exported because the bar mirrors this command and the two must not disagree
 * about what it does -- the same argument `refreshReroll` makes for greying the
 * button and the menu row on identical conditions.
 */
export const RANDOMIZE_BEHAVIOR_HELP =
  'Give each cohort a randomly generated brain: Offers a clean slate where ' +
  'each cohort is completely unrelated to the others';

/** Reroll Mutations, shared with the bar's button of the same name. */
export const REROLL_MUTATIONS_HELP =
  'Generate a new set of children from the same parent.';

/** Simulation > Reset, shared with the bar's Reset button. */
export const RESET_HELP =
  'Clear the trail map and place particles in their initial conditions';

/** Editor > Toggle UI Panels, shared with the bar's gear button. */
export const TOGGLE_UI_HELP =
  'Show/Hide the project and preferences control panels';

/**
 * Row label -> help body. A row with no entry gets no tooltip at all, which is
 * the correct degradation: `Tooltip.attach` returns early on empty content, so
 * an unlisted row costs nothing and shows nothing.
 */
export const MENU_HELP: Readonly<Record<string, string>> = {
  'Save...': `Save the current project. ${PROJECT_SCOPE}`,

  'Copy Link to This Project':
    'Copy a url to the clipboard that opens Fluoddity.com to the current ' +
    `project. Encodes all the settings on the project panel and current ` +
    'particle behavior (including mutations)',
  'Load Project from Clipboard URL':
    'Load from a Fluoddity project url in your clipboard (equivalent to ' +
    'pasting into the address bar and reloading the page)',
  'Video Export Controls':
    'Open the recording control panel for creating and downloading mp4 videos ' +
    'of your Fluoddities',

  // ONE STRING FOR BOTH ROWS. They are the two ends of one feature, and the
  // help describes the feature rather than the direction.
  'Set Checkpoint': `Checkpoints let you create/restore quicksaves within a session. ${PROJECT_SCOPE}`,
  'Load Latest Checkpoint': `Checkpoints let you create/restore quicksaves within a session. ${PROJECT_SCOPE}`,
  // KEYED ON THE STATIC LABEL, not on the live one. This row renames itself to
  // `Revert to preset: <name>` when a preset is loaded (see the `live` option
  // on its `addItem` call), and `data-item` deliberately keeps the static
  // string so selectors do not depend on which preset is open. The help lookup
  // has to agree with that choice or it would miss on exactly the rows where
  // the row is most useful.
  'Revert to Saved': 'Equivalent to File->Load <Filename>',

  Select:
    'Click to select a cohort, allowing you to generate children with similar ' +
    'behavior and conduct artificial selection',
  Shove: 'Left mouse to push particles away. Right mouse to attract them',
  Draw: 'Left mouse to create barriers that repel particles. Right mouse to erase them',

  'Toggle Trail-Map View':
    'View the trails left behind by particles instead of the particles ' +
    'themselves. Hue indicates trail direction: Yellow-Green is up, Red is ' +
    'right, Purple is down, and Cyan is left',
  'Reset Editor Preferences...':
    'Restore Fluoddity to factory settings. Equivalent to visiting the website ' +
    'for the first time',
  // NAMES THE GEAR IN WORDS, not with the glyph the request used: this is a
  // text tooltip and a `<Gear symbol>` placeholder would render literally.
  'Toggle UI Panels': `${TOGGLE_UI_HELP}. Equivalent to pressing the gear button`,

  Reset: RESET_HELP,
  'Randomize Behavior': RANDOMIZE_BEHAVIOR_HELP,
  'Reroll Mutations': REROLL_MUTATIONS_HELP,
};
