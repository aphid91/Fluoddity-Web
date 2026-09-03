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
import type { MouseMode } from '../orchestrator/commands.ts';

const PROJECT_SCOPE =
  'Stores all the settings on the project panel and current particle behavior ' +
  '(including mutations)';

/**
 * What each tool does, keyed by `MouseMode`.
 *
 * **SHARED BY THE TWO SURFACES THAT SELECT A TOOL**: the Editor > Tools submenu
 * and the bar's Tool dropdown. Exported for the same reason
 * `RANDOMIZE_BEHAVIOR_HELP` below is -- two places offer the same act, and a
 * user who read one description must not find a different one on the other.
 *
 * Keyed by mode rather than by label, so `MENU_HELP`'s capitalized row names are
 * derived from this and not the other way round; the dropdown has no labels to
 * key on at all.
 */
export const TOOL_HELP: Readonly<Record<MouseMode, string>> = {
  select:
    'Click to select a cohort, allowing you to generate children with similar ' +
    'behavior and conduct artificial selection',
  shove: 'Left mouse to push particles away. Right mouse to attract them',
  walls: 'Draw barriers that repel particles',
  trails: 'Draw trails like the ones particles leave behind, but permanent',
};

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

/**
 * The commit action, shared by the hint bar's two buttons that perform it.
 *
 * ONE STRING, TWO BUTTONS. "Generate children from selected cohort" and
 * "Generate a child from current behavior" are two labels for one act -- both
 * send `confirmSelection` -- and the difference between them is only WHICH
 * parent is being adopted. What actually happens next is identical, so it is
 * described once here rather than paraphrased twice in `mutationOverlay.ts`.
 *
 * SAYS THE SIMULATION RESETS, which is the part worth hovering for. The labels
 * promise children; they do not warn that the particles are about to be thrown
 * back to their initial conditions, and that is the surprise -- someone watching
 * a pattern they like has no way to learn from the button that pressing it
 * clears the screen.
 */
export const GENERATE_CHILDREN_HELP =
  'This will set the current parent to the chosen cohort. The simulation will ' +
  'reset and each cohort will become a (mutated) child of the one you chose.';

/** Simulation > Reset, shared with the bar's Reset button. */
export const RESET_HELP =
  'Clear the trail map and place particles in their initial conditions';

/** Editor > Toggle UI Panels, shared with the bar's gear button. */
export const TOGGLE_UI_HELP =
  'Show/Hide the project and preferences control panels';

/**
 * Simulation > Pause / Resume, shared with the touch bar's pause button.
 *
 * Exported for the same reason `RESET_HELP` is: the bar mirrors this command,
 * and one string is what stops the row and the button describing the same act
 * two different ways. The touch button is the only place it appears on a phone
 * -- there is no menu bar there -- so this carries the whole explanation.
 */
export const PAUSE_HELP =
  'Pause/Resume the simulation. Particles and trails hold exactly where they are';

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
  // KEYED WITHOUT "URL", which is what the row is actually called. The row was
  // renamed when it learned to read stamped screenshots as well as links, and
  // this key kept the old name -- so the lookup missed and the row silently lost
  // its tooltip. The text below is the one that describes BOTH inputs.
  'Load Project from Clipboard':
    'Decode a fluoddity permalink or QR-code containing screenshot and load it ' +
    'as the current project. Equivalent to paste/ctrl-V',
  // THE ELLIPSIS IS PART OF THE KEY. Both screenshot rows end in a real `…`
  // character rather than three periods, and the lookup is exact -- a key
  // written with `...` here would miss the row it is for.
  'Copy Screenshot…':
    'Select a region of the canvas and copy it to your clipboard',
  'Copy Screenshot with QR Code…':
    'Select a region of the canvas to generate a screenshot, stamped with a QR ' +
    'code containing a permalink to this project. Generates the same url as ' +
    '"Copy Link to This Project"',
  'Export Saves as JSON...':
    'Download the contents of your custom saves as a folder of json files.',
  'Import Saves from JSON...':
    'Upload json files in a folder to your custom saves',
  'Project Link Settings':
    'Choose what a copied link asks the recipient to adopt — your world size, ' +
    'brightness and the rest. They are prompted before anything is applied.',
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

  // THE FOUR TOOL ROWS. Keyed on the row label, which is derived from
  // `MOUSE_MODES` -- so the key here IS the mode name, capitalized. `Draw` was
  // the third tool's label until Trails made the name ambiguous; the entry is
  // renamed rather than kept as an alias, because a stale key silently resolves
  // to no tooltip and nothing points at the omission.
  //
  // Shared with the toolbar's Tool dropdown through `TOOL_HELP` below, so the
  // two surfaces that select a tool cannot describe it differently.
  Select: TOOL_HELP.select,
  Shove: TOOL_HELP.shove,
  Walls: TOOL_HELP.walls,
  Trails: TOOL_HELP.trails,

  'Toggle Trail-Map View':
    'View the trails left behind by particles instead of the particles ' +
    'themselves. Hue indicates trail direction: Yellow-Green is up, Red is ' +
    'right, Purple is down, and Cyan is left',
  'Reset View': 'Return the camera to the default location/zoom',
  'Reset Editor Preferences...':
    'Restore Fluoddity to factory settings. Equivalent to visiting the website ' +
    'for the first time',
  // NAMES THE GEAR IN WORDS, not with the glyph the request used: this is a
  // text tooltip and a `<Gear symbol>` placeholder would render literally.
  'Toggle UI Panels': `${TOGGLE_UI_HELP}. Equivalent to pressing the gear button`,

  'Pause / Resume': PAUSE_HELP,
  Reset: RESET_HELP,
  'Randomize Behavior': RANDOMIZE_BEHAVIOR_HELP,
  'Reroll Mutations': REROLL_MUTATIONS_HELP,
};
