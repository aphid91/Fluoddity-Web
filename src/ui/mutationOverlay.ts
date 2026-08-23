/**
 * Mutation Scale, as a wide slider centred above the canvas.
 *
 * ## Why this is not a Tweakpane control
 *
 * Mutation Scale is the single most consequential control in the app -- it was
 * the FIRST entry in the registry for exactly that reason, and being first in a
 * folder in a 320px column is still buried. What it wants is width and a
 * position that reads as primary, and Tweakpane has neither to give: its
 * layout is a fixed label/widget split inside a docked pane, which is the right
 * shape for forty settings and the wrong one for the setting.
 *
 * So this is plain DOM, following the precedent `menuBar.ts` and `dialogs.ts`
 * already set for UI that has outgrown the pane. It lives OUTSIDE both panel
 * containers, is owned by `Panel`, and is hidden along with everything else by
 * `X`.
 *
 * **It is not a second source of truth.** The registry entry still exists
 * (`panel: false`), and the label, bounds and help text are read from it rather
 * than restated here -- so the overlay and the config can never disagree about
 * what the range is. The value round-trips through the command bus exactly as a
 * Tweakpane slider's does.
 *
 * ## The drag guard is this file's `refreshing`
 *
 * `refresh()` runs every frame and writes the authoritative value into the
 * slider. A native `<input type=range>` under the mouse would fight that write:
 * the thumb would snap back to last frame's value mid-drag, every frame. The
 * `dragging` flag is the same idea as the panel's `refreshing` guard, in the
 * other direction -- the panel guards against a refresh being read as a user
 * edit; this guards against a refresh CLOBBERING one.
 */

import {
  type Command,
  type MouseMode,
  type Status,
  MOUSE_MODES,
  mouseModeFromValue,
} from '../orchestrator/commands.ts';
import { IC } from '../particleSystem/config.ts';
import { NO_COHORT } from '../selection/cohortHighlight.ts';
import { bindFocusRelease } from './focusRelease.ts';
import { hotkeyLabel, localHotkeyLabel } from './hotkeys.ts';
import {
  GENERATE_CHILDREN_HELP,
  RANDOMIZE_BEHAVIOR_HELP,
  REROLL_MUTATIONS_HELP,
  RESET_HELP,
  TOGGLE_UI_HELP,
} from './menuHelp.ts';
import { CONFIG, settingFor } from './settingsSpec.ts';
import { type TooltipContent, Tooltip } from './tooltip.ts';

export interface MutationOverlayOptions {
  readonly send: (command: Command) => void;
  /** Where to mount. Defaults to `document.body`. */
  readonly container?: HTMLElement;
  /**
   * Show or hide the side panels: the gear, at the right end of the bar.
   *
   * A CALLBACK RATHER THAN A COMMAND, and it has to be. Hiding the panels is the
   * panel's own business and deliberately never reaches the Orchestrator --
   * `main.ts` routes `X` the same way, and `panel.ts` cites `ui.py:471-473` for
   * it. Sending a command here would give the app two answers to "is the UI
   * hidden". This lands on `Panel.setHidden` exactly as the key and the Editor
   * menu item do, so all three share one flag and one notification.
   *
   * Optional so the bar can still be built without one -- the DOM tests
   * construct it directly, and a gear that toggles nothing is better than a
   * required argument they have to invent.
   */
  readonly onToggleUi?: () => void;
  /**
   * Build the touch layout. Defaults to false, which is the desktop bar.
   *
   * **THE ONLY THING THAT SWITCHES THIS FILE'S LAYOUT**, and it is read at
   * CONSTRUCTION rather than per frame: the two arrangements differ in which
   * elements exist, not merely in how they are styled, so this decides what is
   * built and then never changes. See `ui/mobile.ts` on why that is latched.
   */
  readonly mobile?: boolean;
}

/** Human-readable tool names. Keyed so a new MOUSE_MODES member fails to compile. */
const TOOL_LABELS: Record<MouseMode, string> = {
  select: 'Select',
  shove: 'Shove',
  draw: 'Draw',
};

/** `Tool: Select (1)`, with the key read from the hotkey table. */
function toolOptionLabel(mode: MouseMode): string {
  const key = hotkeyLabel({ kind: 'setMouseMode', mode });
  return `Tool: ${TOOL_LABELS[mode]}${key === '' ? '' : ` (${key})`}`;
}

export class MutationOverlay {
  private readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly readout: HTMLElement;
  private readonly reroll: HTMLButtonElement;
  private readonly rerollAll: HTMLButtonElement;
  private readonly reset: HTMLButtonElement;
  private readonly tool: HTMLSelectElement;
  /** The gear, at the right end. See its construction for why it lives here. */
  private readonly gear: HTMLButtonElement;
  /**
   * The gear's `(X)` suffix, kept so `paintGear` can rebuild its label.
   *
   * Read from the hotkey table once at construction rather than at each repaint:
   * the binding cannot change while the bar is alive, and re-reading it per
   * toggle would make the label's source look more dynamic than it is.
   */
  private readonly uiKeySuffix: string;
  /** Cohort Fences, past the divider at the left group's right edge. */
  private readonly fences: HTMLButtonElement;
  /** The three layout presets by cohort count, so `refresh` can colour them. */
  private readonly layoutButtons = new Map<number, HTMLButtonElement>();

  /**
   * Whether Cohort Fences is on, as of the last refresh.
   *
   * Read by the click handler so it can send the INVERSE. Held rather than
   * re-derived at click time because the click handler has no `Status` -- and
   * held rather than owned, because the panel's checkbox edits the same field
   * and this is a mirror of it, refreshed every frame.
   */
  private fencesOn = false;

  /**
   * What the left group last rendered as active, so `refresh` can skip the
   * common case. Writing `color` on four buttons every frame to say what they
   * already say is the waste every other guard in this file avoids.
   */
  private activeShown: string | null = null;

  // --- the context hint row ------------------------------------------------
  //
  // A second row inside the SAME container as the bar, so it moves with it and
  // does not add a second floating element over the canvas. What it says is
  // decided entirely by `hintFor` -- a pure function of Status, which is what
  // makes the wording testable without a DOM.

  /** The hint row. Holds the three spans and the stepper, in reading order. */
  private readonly hint: HTMLElement;
  /** Text before the cohort stepper, and the whole hint when there is no stepper. */
  private readonly hintLead: HTMLElement;
  /** Text after the stepper. Empty and hidden when there is no stepper. */
  private readonly hintTail: HTMLElement;
  /** The stepper: `< [n] >`, shown only while a cohort is highlighted. */
  private readonly stepper: HTMLElement;
  private readonly stepDown: HTMLButtonElement;
  private readonly stepUp: HTMLButtonElement;
  private readonly cohortInput: HTMLInputElement;
  /** Commits the lit cohort. Replaces the "left click it" clause -- see `hintFor`. */
  private readonly commitButton: HTMLButtonElement;
  /** Wipes the whole strafe field. Draw tool only -- see `hintFor`. */
  private readonly clearFieldButton: HTMLButtonElement;
  /** Puts out the highlight. Shown whenever a cohort is lit -- see `hintFor`. */
  private readonly cancelSelectionButton: HTMLButtonElement;
  /** Commits immediately, with no aiming stage. Highlighting-off only -- see `hintFor`. */
  private readonly generateChildButton: HTMLButtonElement;
  /** Takes back the top of the undo stack, and names it. Unlit Select only. */
  private readonly undoButton: HTMLButtonElement;

  /**
   * Touch only: the red context button, and `null` on the desktop.
   *
   * **IT REPLACES THREE BUTTONS RATHER THAN JOINING THEM.** A mouse has a right
   * button, so the desktop can afford one red button per meaning -- Cancel in
   * the lit states, Undo in the unlit ones, and nothing at all in Shove and
   * Draw, where right-click is real work rather than backing out. A finger has
   * no second button, so the touch bar carries ONE red control whose meaning
   * follows the state, which is what `contextActionFor` decides.
   *
   * Null rather than hidden on the desktop: the element is never created, so
   * there is nothing to leave stale and no chance of it appearing through a
   * styling mistake.
   */
  private readonly contextButton: HTMLButtonElement | null = null;

  /**
   * The context button's last rendered label, or `null` before the first frame.
   *
   * The same bargain as `hintShown` and `activeShown`: guarded on the RENDERED
   * string rather than on the state behind it, so two states that produce the
   * same words cause no write. `null` rather than an empty string so the first
   * frame always paints.
   */
  private contextShown: string | null = null;

  /**
   * Last hint written to the DOM, so `refresh` can skip the common case.
   *
   * Keyed on the RENDERED STRINGS plus the cohort, not on the Status fields
   * they came from: two different states that produce the same words should not
   * cause a write, and `hintFor` is the only thing that knows which those are.
   * `null` before the first frame, so it always writes once.
   */
  private hintShown: string | null = null;

  /**
   * The live cohort as a string, for restoring the field after unparseable
   * input. Kept because the field's own value is what the user just broke.
   */
  private lastCohort = '';

  /** True between pointerdown and pointerup on the slider. See the header. */
  private dragging = false;

  /**
   * The command sink, kept as a field rather than only captured in closures.
   *
   * Every button here wires `opts.send` into its own listener at construction,
   * which is all they need. `runContextAction` is different: it is called from
   * OUTSIDE -- by a canvas long press, through the panel -- so it has no
   * closure to ride on and needs the sink available on the instance.
   */
  private readonly send: (command: Command) => void;

  /**
   * Whether this bar was built for touch. Fixed at construction.
   *
   * Most of the layout branches happen ONCE, in the constructor, and need no
   * field. This exists for the handful of per-frame methods that must also know
   * -- `reposition` above all, whose entire job is a desktop concern.
   */
  private readonly mobile: boolean;

  /**
   * Touch only: whether a one-finger drag imitates the RIGHT mouse button.
   *
   * The push/pull and draw/erase latch, flipped by the context button in Shove
   * and Draw. Held here rather than in `touchBinding.ts` because it is a piece
   * of UI STATE with a control that displays it -- the binding asks for the
   * current answer through a callback and stores nothing.
   *
   * **SESSION-ONLY, AND NOT A PREFERENCE.** Which way the brush is pointing is
   * a moment-to-moment choice like the active tool, not a lasting statement
   * about how someone works, and persisting it would mean a reload could put a
   * user in Erase without their having chosen it this session.
   *
   * Always false on the desktop, where nothing reads or writes it: the mouse
   * has both buttons and needs no stand-in.
   */
  private dragIsRight = false;

  /**
   * The `top` last written to the root, or `null` before the first placement.
   *
   * Guards the write the same way `hintShown` and `activeShown` guard theirs:
   * `reposition` runs every frame, the answer changes only when the window is
   * resized or the bar changes width, and assigning an identical `style.top`
   * sixty times a second is the waste every other guard here avoids.
   */
  private topShown: number | null = null;

  /**
   * Teardown for the resize listener.
   *
   * The bar is repositioned per frame from `refresh`, which is enough while the
   * app is drawing -- but a resize is exactly the event that changes the answer,
   * and `Panel.refresh` skips the overlay's own refresh when the panels are
   * hidden. Without this, dragging the window narrow with the panels hidden
   * would leave the bar wherever the last visible frame put it, which is the
   * state that overlaps the menu bar.
   */
  private readonly releaseResize: () => void;

  /**
   * The bar's help tooltips.
   *
   * The same styled element the panels use, rather than the `title` attribute
   * this bar carried before. A native `title` cannot be styled, takes about a
   * second to appear with no control over the delay, and renders the `\n\n`
   * paragraph breaks these strings are written with as literal blank space in a
   * single-line strip -- see `tooltip.ts`, which was written for exactly those
   * three reasons and was until now only wired into Tweakpane blades.
   *
   * `aria-label` IS STILL SET on every button that had one, and is now set on
   * the ones that only had a `title`. The tooltip is a hover affordance and
   * reaches neither screen readers nor keyboard users, so dropping `title`
   * without that would be a real accessibility loss rather than a cosmetic
   * change. The two carry the same words.
   *
   * Its own instance, for the reason `menuBar.ts` gives for having one: this
   * bar is deliberately outside both panel containers and outlives their
   * rebuilds.
   */
  private readonly tooltip = new Tooltip();

  /**
   * The last `Status` seen by `refresh`, for the live tooltip sources to read.
   *
   * **NOT a second source of truth**, and deliberately not a copy of any field:
   * it is the whole status object as handed in, read only at HOVER time by
   * `attachRerollHelp` and the fences help. Those two describe state that
   * changes under the user, and a tooltip attached once at construction has no
   * other way to see it.
   *
   * `null` until the first refresh, which every reader degrades on rather than
   * asserting -- the bar is constructed before the first frame.
   */
  private lastStatus: Status | null = null;

  /**
   * Last `ruleIsGenerated` written to the DOM, or `null` before the first
   * frame.
   *
   * `refresh` runs every frame and the swap touches six elements; writing all
   * of them sixty times a second to say what they already say is the same waste
   * `panel.ts`'s `setHidden` guards against. `null` rather than a boolean so
   * the first frame always writes, whichever way it goes.
   */
  private generatedShown: boolean | null = null;

  /**
   * What `refreshReroll` last wrote, as a two-character state key, or `null`
   * before the first frame.
   *
   * Same bargain as `generatedShown` and `activeShown`: the method rewrites a
   * label, three styles and a title, and doing that sixty times a second to say
   * what the button already says is the waste every guard in this file avoids.
   */
  private rerollShown: string | null = null;

  /**
   * Teardown for the focus-release listeners.
   *
   * The overlay needs its OWN binding because it deliberately lives outside
   * both panel containers (see the header), so the panel's two bindings cannot
   * reach it -- and a `<input type=range>` keeps focus after a drag exactly as
   * a Tweakpane track does, swallowing every hotkey until something else took
   * it. The tool `<select>` below still blurs itself on `change`; that predates
   * this and is left alone, since it is the same answer arrived at locally.
   */
  private readonly releaseFocus: () => void;

  constructor(opts: MutationOverlayOptions) {
    // Held for `runContextAction`, which has no closure to ride on. Every
    // button below still wires `opts.send` directly, unchanged.
    this.send = opts.send;
    this.mobile = opts.mobile ?? false;

    // Bounds from the registry, never restated. A renamed field degrades to the
    // 0..1 fallback rather than to a slider with no range at all.
    const setting = settingFor(CONFIG, 'mutationScale');
    const lo = setting?.lo ?? 0;
    const hi = setting?.hi ?? 1;

    this.root = document.createElement('div');
    this.root.id = 'fluoddity-mutation';
    // BOTTOM-ANCHORED AND FULL-WIDTH ON TOUCH; the desktop keeps the centred
    // strip under the menu bar. See `TOUCH_ROOT_CSS`.
    this.root.style.cssText = opts.mobile === true ? TOUCH_ROOT_CSS : ROOT_CSS;

    const bar = document.createElement('div');
    bar.style.cssText = BAR_CSS;

    this.label = document.createElement('span');
    this.label.textContent = setting?.label ?? 'Mutation Scale';
    this.label.style.cssText = LABEL_CSS;

    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = String(lo);
    this.slider.max = String(hi);
    // Fine enough that the slider is not the limiting factor on a value the
    // shader reads as a continuous float.
    this.slider.step = '0.001';
    // Fills its own row on touch; a fixed share of the viewport on the desktop,
    // where it shares a row with eight other controls.
    this.slider.style.cssText =
      opts.mobile === true ? TOUCH_SLIDER_CSS : SLIDER_CSS;
    this.slider.dataset['setting'] = 'config.mutationScale';

    this.readout = document.createElement('span');
    this.readout.style.cssText = READOUT_CSS;

    // ON ALL THREE ELEMENTS, not just the label. They are one control split
    // across three nodes -- name, track and number -- and a tooltip that
    // appeared over only one of them would look like a bug in the other two.
    // `attach` adds three listeners per element and no DOM, so this is cheap.
    //
    // The registry's `help` is NOT used here: this is the one control whose
    // panel entry is `panel: false`, so no Tweakpane blade renders it and this
    // is the only place its help can appear. The wording is the bar's own.
    const mutationHelp = {
      title: setting?.label ?? 'Mutation Scale',
      body:
        'Controls how different the cohorts are from their parent. Each cohort ' +
        'has a unique mutation. At 0, every cohort is identical to the parent.',
    };
    for (const el of [this.label, this.slider, this.readout]) {
      this.tooltip.attach(el, mutationHelp);
    }

    this.reroll = document.createElement('button');
    this.reroll.type = 'button';
    // The shortcut comes from the hotkey table, not from a literal here -- see
    // `hotkeyLabel`. A rebind moves this label with it.
    const rerollKey = hotkeyLabel({ kind: 'randomizeSeed' });
    this.reroll.textContent =
      rerollKey === '' ? 'Reroll Mutations' : `Reroll Mutations (${rerollKey})`;
    this.reroll.style.cssText = opts.mobile === true ? TOUCH_CONTROL_CSS : BUTTON_CSS;
    this.reroll.dataset['setting'] = 'config.mutationSeed.randomize';

    // Takes the slider's place while the rule is the all-zero sentinel. See
    // `refresh` for why, and `REROLL_ALL_CSS` for why it is that wide.
    //
    // **`B` ALONE, where this used to read "(B or F)".** `F` did land here in
    // the sentinel state, because the Orchestrator redirected it -- and naming
    // two keys for one button meant `F` changed jobs depending on state the
    // user could not see. The redirect is gone (`hotkeys.ts`), so `B` is the
    // only key that randomizes behavior and this label names only it.
    this.rerollAll = document.createElement('button');
    this.rerollAll.type = 'button';
    this.rerollAll.textContent = `Reroll All Behavior${keySuffix([
      hotkeyLabel({ kind: 'randomizeBehavior' }),
    ])}`;
    // **THE FIXED WIDTH IS A DESKTOP CONCERN AND IS DROPPED ON TOUCH.**
    // `REROLL_ALL_CSS` matches the slider group's width so that swapping this
    // button in for it does not change the bar's total width -- which matters
    // because the desktop bar is CENTRED, so any width change moves both edges
    // and slides every other control out from under the pointer. The touch bar
    // spans the viewport and its edges cannot move, so there is nothing to
    // stabilise; here the button just takes its share of the row like its
    // neighbours.
    this.rerollAll.style.cssText =
      opts.mobile === true ? TOUCH_CONTROL_CSS : REROLL_ALL_CSS;
    this.rerollAll.dataset['setting'] = 'config.rule.randomize';
    // SHARED WITH THE SIMULATION MENU ROW it mirrors, imported rather than
    // restated -- the bar and the menu must not disagree about what an action
    // does, the same argument `refreshReroll` makes for greying them together.
    this.tooltip.attach(this.rerollAll, {
      title: 'Reroll All Behavior',
      body: RANDOMIZE_BEHAVIOR_HELP,
    });

    // A real <select>, not a readout: the tool was previously only reachable
    // from the Tools menu and the number keys, and a modal state you can see but
    // not change from where you see it is a worse affordance than either.
    this.tool = document.createElement('select');
    this.tool.style.cssText = opts.mobile === true ? TOUCH_TOOL_CSS : TOOL_CSS;
    this.tool.dataset['setting'] = 'transport.tool';
    for (const mode of MOUSE_MODES) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = toolOptionLabel(mode);
      // Set on each OPTION as well as on the select. An option does not reliably
      // inherit its parent's colours into the OS-drawn popup, which is how the
      // text ended up pale-on-white; stating both ends removes the guess.
      option.style.cssText = TOOL_OPTION_CSS;
      this.tool.append(option);
    }

    // Reset, between Reroll and the tool selector. `R` is named the way every
    // other label here names its key -- from the hotkey table, so a rebind moves
    // it. Deliberately OUTSIDE the sentinel swap: restarting the simulation
    // means the same thing whether the rule is authored or generated.
    this.reset = document.createElement('button');
    this.reset.type = 'button';
    this.reset.textContent = `Reset${keySuffix([hotkeyLabel({ kind: 'reset' })])}`;
    this.reset.style.cssText = opts.mobile === true ? TOUCH_CONTROL_CSS : BUTTON_CSS;
    this.reset.dataset['setting'] = 'transport.reset';
    // Shared with the Simulation menu row, like Reroll All Behavior above.
    this.tooltip.attach(this.reset, { title: 'Reset', body: RESET_HELP });

    // The Reroll button's help depends on why it is greyed, so it is a live
    // source rather than a fixed string -- attached once here, resolved on
    // hover. See `attachRerollHelp`.
    this.attachRerollHelp();

    // The population presets, leftmost. Deliberately OUTSIDE the sentinel swap
    // below: how many cohorts there are and how they are arranged is orthogonal
    // to whether the rule is authored or generated, so these stay live in both
    // states.
    const presets = document.createElement('div');
    presets.style.cssText = PRESETS_CSS;
    for (const count of LAYOUT_PRESETS) {
      const button = this.layoutButton(count, opts.send);
      this.layoutButtons.set(count, button);
      presets.append(button);
    }

    // Cohort Fences, past a divider.
    //
    // THE DIVIDER IS THE POINT of the grouping. The three buttons to its left
    // SET the population -- each is a one-shot that writes a cohort count and a
    // layout. This one TOGGLES a property of whatever population is there. They
    // sit together because both are about how cohorts are arranged, and they
    // must not read as a fourth preset: clicking a preset replaces your layout,
    // clicking this does not, and a user who learned the first three by trying
    // them would reasonably expect the fourth to behave the same way.
    //
    // A rule rather than a gap, because a gap at this size reads as spacing
    // rather than as a boundary -- the buttons are 24px with 3px between them,
    // so any gap large enough to signal a break would look like a mistake.
    const divider = document.createElement('span');
    divider.style.cssText = DIVIDER_CSS;
    presets.append(divider);

    this.fences = document.createElement('button');
    this.fences.type = 'button';
    this.fences.style.cssText = LAYOUT_BUTTON_CSS;
    this.fences.dataset['setting'] = 'config.cohortFences';
    // Dashed to start, matching `fencesOn`'s initial false. The first `refresh`
    // replaces it with whatever the config actually says, so this only has to be
    // right for the frame before that.
    this.fences.append(fencesIcon(false));
    // A LIVE SOURCE: the Grid requirement only applies in some layouts, and the
    // button is greyed rather than rebuilt when it stops applying. Resolved on
    // hover, so `refreshPopulationGroup` no longer pushes text per state.
    this.tooltip.attach(this.fences, () => {
      const layout = this.lastStatus?.editConfig['initialConditions'];
      const body =
        'Cohort fences: When enabled, particles are forced to stay close to ' +
        'their initial locations (Grid only).';
      // The greyed case says so, for the reason `rerollHelp` gives: a disabled
      // control that does not explain itself is a dead end, and the way out is
      // a dropdown a few rows away in the Project panel.
      return {
        title: 'Cohort Fences',
        body:
          layout === IC.GRID || layout === undefined
            ? body
            : `${body}\n\nRequires Initial Conditions: Grid.`,
      };
    });
    this.fences.addEventListener('click', () => {
      const setting = settingFor(CONFIG, 'cohortFences');
      if (setting === null) return;
      // Reads the LIVE value and inverts it, rather than tracking a local flag:
      // the checkbox in the panel edits the same field, and two copies of a
      // boolean is two things to get out of step. `fencesOn` is the same read
      // `refresh` uses to colour the icon.
      opts.send({ kind: 'editSetting', setting, value: !this.fencesOn });
      this.fences.blur();
    });
    presets.append(this.fences);

    // The gear, at the RIGHT END, past the tool selector.
    //
    // It lived in a corner of the canvas for a while, on the argument that
    // everything else on this bar acts on the SIMULATION while this acts on the
    // editor's chrome. True, but it cost more than it bought: a lone button
    // floating over the picture is a thing to hunt for, and the bar is where a
    // user already looks for controls. Grouping it at the far end -- past the
    // tool selector, with the panel-scoped controls rather than the
    // simulation-scoped ones on the left -- says "different category" by
    // position, which is what the corner was trying to say by distance.
    //
    // LABELLED WITH ITS KEY like every other button here, via the hotkey table
    // rather than a literal `(X)`, so a rebind moves the label with it. The gear
    // glyph carries the meaning and the suffix carries the shortcut, which is
    // the pattern Reroll, Reset and Reroll All already follow.
    this.gear = document.createElement('button');
    this.gear.type = 'button';
    this.gear.style.cssText = GEAR_BUTTON_CSS;
    this.uiKeySuffix = keySuffix([localHotkeyLabel('toggleUi')]);
    this.gear.dataset['setting'] = 'transport.toggleUi';
    this.gear.append(gearIcon(), keyCaption(this.uiKeySuffix));
    // GOLD WHILE THE PANELS ARE SHOWING, the same vocabulary the layout presets
    // and Cohort Fences use: gold means "this toggle is the state you are in".
    // The gear was the one toggle on this bar that looked identical in both of
    // its states, which made it the only one you had to press to find out.
    //
    // Seeded to the SHOWN state and then kept honest by `setHidden`. `Panel`
    // calls `applyHidden` at construction only when it starts hidden, so an
    // un-hidden start never calls in -- the default has to be the one that
    // needs no call.
    this.paintGear(false);
    // A live source, so the tooltip reports which way the toggle currently
    // goes. The `(X)` suffix is kept from the hotkey table, as everywhere else
    // on this bar -- the request's wording dropped it, but a rebind has to be
    // able to move it and a label naming no key would be the one control here
    // that hides its shortcut.
    this.tooltip.attach(this.gear, () => ({
      title: 'Toggle UI Panels',
      body: `${TOGGLE_UI_HELP}${this.uiKeySuffix}`,
    }));
    this.gear.addEventListener('click', () => {
      opts.onToggleUi?.();
      // A click leaves the button focused, and `X` would then be swallowed while
      // Space and Enter re-fire this button -- so the key that does the same job
      // stops working right after you use its on-screen twin. Blurring hands the
      // keys straight back, the same answer the tool `<select>` arrives at.
      this.gear.blur();
    });

    // The tool control goes INSIDE the bar, not below it. Floating on its own
    // it read as a stray tooltip over the canvas rather than as part of the UI,
    // and a status line that looks like an error message is worse than none.
    // =====================================================================
    // THE BAR: ONE ROW ON THE DESKTOP, TWO ON TOUCH
    // =====================================================================
    //
    // Same nine controls either way, and the desktop arrangement is untouched:
    // one flex row, in the order it has always been in.
    //
    // A phone cannot hold that row. It is ~900px of controls at a comfortable
    // desktop size, and every one of them has to GROW rather than shrink to be
    // usable with a finger -- so it splits by what the controls are FOR:
    //
    //   TOP     Mutation Scale and the gear. The slider is the most
    //           consequential control in the app and the one that most wants
    //           width, so it gets a row where it can take all of it. The gear
    //           rides along because it is a fixed-width icon that would waste a
    //           row of its own.
    //   BOTTOM  everything that is pressed rather than dragged -- the layout
    //           presets, the rerolls, Reset and the tool selector.
    //
    // The label and readout are DROPPED from the touch layout, not hidden:
    // `LABEL_CSS` names the slider in words the tooltip also carries, and the
    // readout duplicates a value the slider position already shows. On a phone
    // both cost width the slider itself should have.
    if (opts.mobile === true) {
      const top = document.createElement('div');
      top.style.cssText = TOUCH_BAR_ROW_CSS;
      top.append(this.slider, this.gear);

      const bottom = document.createElement('div');
      bottom.style.cssText = TOUCH_BAR_ROW_CSS;
      // `rerollAll` and `reroll` swap places with the state (see `refresh`), so
      // both live here and the swap continues to work untouched.
      bottom.append(presets, this.rerollAll, this.reroll, this.reset, this.tool);

      bar.style.cssText = TOUCH_BAR_CSS;
      bar.append(top, bottom);
    } else {
      bar.append(
        presets,
        this.label,
        this.slider,
        this.readout,
        this.rerollAll,
        this.reroll,
        this.reset,
        this.tool,
        this.gear,
      );
    }
    // --- the context hint row ----------------------------------------------
    //
    // Inside the same rounded container as the bar, as a second row: it is about
    // the tool the bar's own dropdown selects, and a separate floating strip
    // would be a second thing to position against the menu bar and the panels.

    this.hint = document.createElement('div');
    this.hint.style.cssText = opts.mobile === true ? TOUCH_HINT_CSS : HINT_CSS;
    this.hint.dataset['setting'] = 'transport.hint';

    this.hintLead = document.createElement('span');
    this.hintLead.style.cssText = HINT_TEXT_CSS;
    this.hintTail = document.createElement('span');
    this.hintTail.style.cssText = HINT_TEXT_CSS;

    // The stepper: `< [n] >`. Present in the DOM always, shown only while a
    // cohort is lit -- building it once and toggling `display` keeps the
    // listeners attached and avoids re-creating nodes sixty times a second.
    this.stepper = document.createElement('span');
    this.stepper.style.cssText = STEPPER_CSS;

    this.stepDown = this.stepButton('‹', 'Previous cohort (Left arrow)');
    this.stepUp = this.stepButton('›', 'Next cohort (Right arrow)');

    this.cohortInput = document.createElement('input');
    this.cohortInput.type = 'text';
    // `text`, not `number`: a spinner would duplicate the arrows either side of
    // it, and the arrows are the affordance being asked for here. `inputMode`
    // still brings up a numeric keypad on a touch device.
    this.cohortInput.inputMode = 'numeric';
    this.cohortInput.style.cssText = COHORT_INPUT_CSS;
    this.cohortInput.dataset['setting'] = 'transport.cohort';
    this.cohortInput.setAttribute('aria-label', 'Highlighted cohort');

    this.stepper.append(this.stepDown, this.cohortInput, this.stepUp);

    // The commit button, in place of the "left click it to apply" prose.
    //
    // A BUTTON RATHER THAN A SENTENCE because the action is now reachable three
    // ways -- Enter, clicking the cohort again, and this -- and a line of prose
    // describing two of them is worse than a control that IS the third and names
    // the others. It also puts the commit within reach of someone who arrived by
    // keyboard and never touched the canvas.
    //
    // Built once and shown by `display`, like the stepper beside it: rebuilding
    // per frame would drop the listener and re-create the node sixty times a
    // second.
    // THE GOLD HALF OF THE TOUCH PAIR. On the desktop this is a button sized to
    // sit in a line of prose; on touch it is one of the two controls pressed
    // most often, and it grows to a 44px target beside the red one. The
    // BEHAVIOUR is identical -- only the geometry differs -- which is why this
    // is a CSS swap rather than a second element.
    this.commitButton = document.createElement('button');
    this.commitButton.type = 'button';
    this.commitButton.style.cssText =
      opts.mobile === true ? TOUCH_COMMIT_BUTTON_CSS : COMMIT_BUTTON_CSS;
    this.commitButton.dataset['setting'] = 'transport.confirmSelection';
    this.commitButton.addEventListener('click', () => {
      opts.send({ kind: 'confirmSelection' });
      // Hands the keys straight back, so Enter keeps working right after the
      // button is used -- the same answer the gear and the tool select make.
      this.commitButton.blur();
    });
    // FIXED CONTENT, not a live source: unlike Reroll and Cohort Fences, what
    // this button does never depends on state the tooltip would have to re-read.
    // It is only ever shown in one situation, and it does the same thing there
    // every time. Shared with the Generate A Child button below -- see
    // `GENERATE_CHILDREN_HELP` for why one string serves both.
    //
    // Attached HERE rather than in `refreshHint`, which rewrites these labels:
    // `attach` adds listeners, so attaching where the text is set would add a
    // fresh pair on every state change and leak one per repaint.
    // BELOW, not beside: this button is wide -- its label names three routes to
    // the act -- so a tooltip off its right edge starts far from the words it
    // explains. See `TooltipPlacement`.
    this.tooltip.attach(
      this.commitButton,
      { title: 'Generate Children', body: GENERATE_CHILDREN_HELP },
      'below',
    );

    // Clear All Barriers, the Draw tool's own action on this row.
    //
    // RIGHT OF THE SENTENCE it belongs to, which is why it is appended last: the
    // lead reads "Left click to add barriers | Right click to erase them" and
    // this is the bulk form of that erase, so it follows the description of the
    // single-stroke version rather than interrupting it.
    //
    // "(Can't undo)" IS IN THE LABEL, not a tooltip. `clearStrafeField` is
    // deliberately outside the undo timeline (see the Orchestrator's case for
    // it), and the panel's copy of this button already says so in its own title
    // -- a destructive one-click action whose irreversibility is only discoverable
    // by hovering is the version that gets pressed by accident.
    //
    // NO CONFIRM DIALOG, matching the panel button it mirrors. The field is
    // live-only state that no reload preserves, so the cost of a mistaken press
    // is redrawing rather than losing saved work -- and a dialog on every clear
    // would be friction on the common deliberate case.
    this.clearFieldButton = document.createElement('button');
    this.clearFieldButton.type = 'button';
    this.clearFieldButton.style.cssText = CLEAR_FIELD_BUTTON_CSS;
    this.clearFieldButton.textContent = "Clear all barriers (Can't undo)";
    this.clearFieldButton.dataset['setting'] = 'transport.clearStrafeField';
    this.clearFieldButton.addEventListener('click', () => {
      opts.send({ kind: 'clearStrafeField' });
      // Hands the keys back, like every other button on this bar.
      this.clearFieldButton.blur();
    });

    // Cancel Selection, the Select tool's own backing-out action.
    //
    // A BUTTON RATHER THAN THE SENTENCE it replaces, for the reason the commit
    // button beside it gives: the act was reachable only by a right-click on the
    // canvas, which is undiscoverable from the row that describes it and
    // unreachable for someone who arrived at this selection from the keyboard.
    //
    // **"(Right click)" IS A LITERAL, and deliberately not `keySuffix`.** Every
    // other key named on this bar comes from the hotkey table so a rebind moves
    // it -- but this gesture is not in that table. It is decided in
    // `applyCanvasInput`, which reads the mouse button directly and is not
    // rebindable, so reading it from `hotkeyLabel` would print an empty suffix
    // and quietly stop naming the gesture that actually works.
    this.cancelSelectionButton = document.createElement('button');
    this.cancelSelectionButton.type = 'button';
    this.cancelSelectionButton.style.cssText = CANCEL_SELECTION_BUTTON_CSS;
    this.cancelSelectionButton.textContent = 'Cancel selection (Right click)';
    this.cancelSelectionButton.dataset['setting'] = 'transport.cancelSelection';
    this.cancelSelectionButton.addEventListener('click', () => {
      opts.send({ kind: 'cancelSelection' });
      // Hands the keys back, like every other button on this bar.
      this.cancelSelectionButton.blur();
    });

    // Generate A Child, the one-click state's own action.
    //
    // **THE COMMIT BUTTON'S TWIN, AND DELIBERATELY A SECOND ELEMENT.** It sends
    // the same `confirmSelection`, wears the same gold, and never shares a row
    // with the commit button -- `hintFor` gives them mutually exclusive states.
    // They stay separate because the LABELS differ and always will: one names a
    // cohort you aimed at, the other names the behaviour already running. Fusing
    // them would mean a single node whose text is rewritten by a branch, which is
    // the arrangement that goes stale when only one arm is edited.
    //
    // SINGULAR "a child" against the commit button's plural, and that is the
    // real difference between the states rather than a wording accident: with
    // one cohort there is one thing to vary, and the plural would promise a
    // spread that a single-cohort config cannot produce.
    this.generateChildButton = document.createElement('button');
    this.generateChildButton.type = 'button';
    // The commit button's twin, and it grows on touch for the same reason --
    // these two never share a row, so between them they are always the gold
    // half of the pair.
    this.generateChildButton.style.cssText =
      opts.mobile === true ? TOUCH_COMMIT_BUTTON_CSS : COMMIT_BUTTON_CSS;
    this.generateChildButton.dataset['setting'] = 'transport.confirmSelection';
    this.generateChildButton.addEventListener('click', () => {
      opts.send({ kind: 'confirmSelection' });
      // Hands the keys back, like every other button on this bar.
      this.generateChildButton.blur();
    });
    // THE SAME BODY AS THE COMMIT BUTTON, and deliberately so: these two send
    // the same command and differ only in which parent is being adopted. The
    // TITLE is singular to match this button's own label, for the reason the
    // label itself is singular -- with one cohort there is one thing to vary.
    this.tooltip.attach(
      this.generateChildButton,
      { title: 'Generate A Child', body: GENERATE_CHILDREN_HELP },
      'below',
    );

    // Undo, on the hint row beside it.
    //
    // **RED, AND THE SAME RED AS CANCEL SELECTION**, because it is the same kind
    // of act: the row's backing-out action. It never shares a row WITH cancel --
    // `hintFor` offers this only while nothing is lit and that only while
    // something is -- so the two reds cannot compete for the eye or for the
    // right mouse button they both name.
    //
    // **"(Right click)" IS A LITERAL HERE TOO**, and for the reason the cancel
    // button spells out: the gesture is decided in `applyCanvasInput`, which
    // reads the button directly and is not in the hotkey table. `Z` is NOT a
    // literal -- that one is a real binding, so it comes from `hotkeyLabel` and
    // a rebind moves it.
    this.undoButton = document.createElement('button');
    this.undoButton.type = 'button';
    this.undoButton.style.cssText = UNDO_BUTTON_CSS;
    this.undoButton.dataset['setting'] = 'transport.undo';
    this.undoButton.addEventListener('click', () => {
      opts.send({ kind: 'undo' });
      // Hands the keys back, like every other button on this bar.
      this.undoButton.blur();
    });

    // The touch context button. Built ONLY on touch -- see its declaration for
    // why it is null rather than hidden on the desktop.
    //
    // **BIGGER THAN THE DESKTOP BUTTONS, AND DELIBERATELY SO.** This and the
    // gold commit button beside it are the two controls a touch session presses
    // constantly, and they are the two that must never be mis-tapped: one
    // commits a selection and the other undoes. `TOUCH_ACTION_BUTTON_CSS` gives
    // them a 44px minimum, which is the smallest target a finger hits reliably.
    if (opts.mobile === true) {
      const context = document.createElement('button');
      context.type = 'button';
      context.style.cssText = TOUCH_ACTION_BUTTON_CSS;
      context.dataset['setting'] = 'transport.contextAction';
      context.addEventListener('click', () => {
        this.runContextAction();
        // Hands the keys back, like every other button on this bar.
        context.blur();
      });
      this.contextButton = context;
    }

    // ORDER IS THE READING ORDER of the row. The cancel button goes LAST, after
    // the tail: the row runs "Currently selected: Cohort <n> | <commit>", and
    // backing out belongs at the end of that sentence rather than between the
    // cohort and the action it offers.
    //
    // UNDO SITS AFTER GENERATE-A-CHILD for the same reason, and after the lead:
    // in the unlit states the row reads "<do the thing> | <take back the last
    // thing>", which is the order those two are considered in.
    this.hint.append(
      this.hintLead,
      this.stepper,
      this.commitButton,
      this.generateChildButton,
      this.hintTail,
      this.undoButton,
      this.cancelSelectionButton,
      this.clearFieldButton,
    );
    // LAST, so it sits at the right end of the row -- gold on the left, red on
    // the right, which is the arrangement the two most-used touch controls
    // keep in every state. Appended separately rather than added to the list
    // above because it does not exist on the desktop.
    if (this.contextButton !== null) this.hint.append(this.contextButton);

    // HINT FIRST ON TOUCH, so it sits ABOVE the controls rather than below
    // them. The desktop reads top-down -- controls, then the sentence about the
    // tool they select -- and on a phone the whole strip is at the bottom of the
    // screen, so the same reading order puts the hint nearer the artwork and the
    // controls nearest the thumb. It also keeps the two big buttons on the hint
    // row from being the very bottom edge of the screen, where the home
    // indicator lives.
    if (opts.mobile === true) {
      this.root.append(this.hint, bar);
    } else {
      this.root.append(bar, this.hint);
    }
    (opts.container ?? document.body).append(this.root);
    this.releaseFocus = bindFocusRelease(this.root);

    // AFTER the mount, or the bar measures as a zero rect and every frame until
    // the first refresh would place it at the fallback clearance -- a visible
    // drop on load in the common non-overlapping case.
    this.reposition();
    const onResize = (): void => {
      this.reposition();
    };
    window.addEventListener('resize', onResize);
    this.releaseResize = (): void => {
      window.removeEventListener('resize', onResize);
    };

    // --- events ------------------------------------------------------------

    // `input`, not `change`: `change` fires only on release, so the simulation
    // would not move until the drag ended -- and watching the result while
    // dragging is the entire reason this control is big and on the canvas.
    this.slider.addEventListener('input', () => {
      if (setting === null) return;
      this.readout.textContent = format(this.slider.valueAsNumber);
      opts.send({
        kind: 'editSetting',
        setting,
        value: this.slider.valueAsNumber,
      });
    });

    // See the header. `pointercancel` too: a drag interrupted by a context menu
    // or a window switch never gets its `pointerup`, and a stuck flag would
    // freeze the readout permanently.
    this.slider.addEventListener('pointerdown', () => {
      this.dragging = true;
    });
    const release = (): void => {
      this.dragging = false;
    };
    this.slider.addEventListener('pointerup', release);
    this.slider.addEventListener('pointercancel', release);
    // A keyboard drag has no pointer events at all, and arrow keys on a focused
    // range fire `input` -- so blur is what ends that gesture.
    this.slider.addEventListener('blur', release);

    // --- the stepper -------------------------------------------------------
    //
    // Both arrows and the field send the same command; the Orchestrator wraps,
    // so nothing here has to know the cohort count. `shown` is the value on
    // screen, which is the authority for a relative step -- reading it back
    // rather than tracking a second copy is what stops the two disagreeing when
    // a refresh lands between clicks.
    const step = (delta: number): void => {
      const current = Number.parseInt(this.cohortInput.value, 10);
      if (!Number.isFinite(current)) return;
      opts.send({ kind: 'setHighlightedCohort', cohort: current + delta });
    };
    this.stepDown.addEventListener('click', () => {
      step(-1);
    });
    this.stepUp.addEventListener('click', () => {
      step(1);
    });

    // `change`, not `input`: typing "12" passes through "1", and committing on
    // every keystroke would light cohort 1 on the way to 12. Enter and blur both
    // fire `change`, which is exactly the two moments the user has finished.
    this.cohortInput.addEventListener('change', () => {
      const typed = Number.parseInt(this.cohortInput.value, 10);
      if (!Number.isFinite(typed)) {
        // Unparseable: put the live value back rather than sending nothing and
        // leaving the field showing text that is not the state.
        this.cohortInput.value = this.lastCohort;
        return;
      }
      opts.send({ kind: 'setHighlightedCohort', cohort: typed });
    });

    // The arrow keys, so the field steps without reaching for the buttons. Sent
    // as a relative step from what is SHOWN, matching the arrows exactly.
    this.cohortInput.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      // The field is a `text` input, so these would otherwise move the caret to
      // either end -- and on a one- or two-character value that reads as the key
      // doing nothing at all.
      event.preventDefault();
      step(event.key === 'ArrowUp' ? 1 : -1);
    });

    this.reroll.addEventListener('click', () => {
      opts.send({ kind: 'randomizeSeed' });
    });

    this.rerollAll.addEventListener('click', () => {
      opts.send({ kind: 'randomizeBehavior' });
    });

    this.reset.addEventListener('click', () => {
      opts.send({ kind: 'reset' });
    });

    this.tool.addEventListener('change', () => {
      const mode = mouseModeFromValue(this.tool.value);
      if (mode !== null) opts.send({ kind: 'setMouseMode', mode });
    });

    // A <select> keeps keyboard focus after a click, and the number keys would
    // then be swallowed by its own type-ahead instead of reaching the hotkey
    // table -- so picking "Tool: Shove (2)" would leave `2` dead until you
    // clicked elsewhere. Blurring hands the keys straight back.
    this.tool.addEventListener('change', () => {
      this.tool.blur();
    });
  }

  /**
   * Push this frame's state in.
   *
   * Called from `Panel.refresh`, so it is skipped for a hidden panel exactly as
   * the panes are.
   */
  refresh(status: Status): void {
    // FIRST, before anything that could early-return: the live tooltip sources
    // read this at hover time, and a stale one would describe a state the bar
    // has already left.
    this.lastStatus = status;

    this.refreshPopulationGroup(status);

    const scale = status.editConfig['mutationScale'];

    if (typeof scale === 'number') {
      // NOT while dragging -- see the header.
      if (!this.dragging) {
        this.slider.valueAsNumber = scale;
        this.readout.textContent = format(scale);
      }
    }

    this.refreshReroll(status, typeof scale === 'number' ? scale : null);

    // --- the sentinel swap -------------------------------------------------
    //
    // With an all-zero rule the shader GENERATES behaviour from the seed rather
    // than mutating an authored rule, so this bar's two mutation controls are
    // both describing something that is not there: the slider scales a
    // variation from nothing, and "Reroll Mutations" names a mutation that does
    // not exist. Presenting them as live is the confusing part -- the command
    // behind Reroll still works, but a user reading "mutations" in a state that
    // has none has been told the wrong thing about their own document.
    //
    // So the slider's whole group gives up its space to the one action the
    // state does support. Reroll's own fate belongs to `refreshReroll`, which
    // greys it here and in one other state -- see that method for both.
    if (this.generatedShown !== status.ruleIsGenerated) {
      this.generatedShown = status.ruleIsGenerated;
      const generated = status.ruleIsGenerated;

      this.label.style.display = generated ? 'none' : '';
      this.slider.style.display = generated ? 'none' : '';
      this.readout.style.display = generated ? 'none' : '';
      this.rerollAll.style.display = generated ? '' : 'none';
    }

    // The tool selector. It lives here because the Transport section that used
    // to carry it is parked (`panelModel.ts`), and a modal tool with no visible
    // state is a trap -- pressing `2` has to show up somewhere.
    //
    // Written only on an actual change, and never while the select has focus:
    // assigning `value` to an open dropdown closes it, so a per-frame write
    // would make the menu impossible to use with the mouse.
    if (this.tool.value !== status.mouseMode && document.activeElement !== this.tool) {
      this.tool.value = status.mouseMode;
    }

    this.refreshHint(status);

    // LAST, after everything that can change the bar's WIDTH. The sentinel swap
    // above hides three items and shows one, and the hint row's buttons come and
    // go -- both move this bar's edges, which is the input to the overlap test.
    // Measuring first would decide against the previous frame's geometry and
    // leave the bar one frame behind at exactly the moments it changes size.
    this.reposition();
  }

  /**
   * Grey Reroll in the two states where it cannot change the picture.
   *
   * ## The sentinel state, unchanged
   *
   * With an all-zero rule there is no authored behaviour to mutate, and
   * `Reroll All Behavior` has taken the slider's place to offer the action the
   * state DOES support. Reroll greys rather than disappearing: it comes back
   * the moment a rule is picked, and a control that vanishes teaches less than
   * one that visibly does not apply.
   *
   * Renaming it to "Reroll Behaviors" here would be the wrong fix even though
   * the command does reroll behaviour in this state -- `rerollAll` is already
   * on screen doing exactly that, and two adjacent buttons for one action is a
   * worse question to put to a user than one greyed button and one live one.
   *
   * ## Zero scale, and the argument this REVERSES
   *
   * This gate existed once, was removed, and is back on a narrower claim. The
   * removal argued that rerolling at zero and then raising the slider is a real
   * gesture, so gating it made that order unreachable. True as far as it goes --
   * but it weighs an ordering some users might use against a button that, when
   * pressed, does nothing observable. Pressing it still moves the seed and still
   * marks the document dirty (`project.ts` counts a seed move as a change), so
   * the un-gated version spends real state on a no-op and gives no hint why the
   * picture held still. The order the removal protected still works: raise the
   * slider, then reroll. So the gate returns, with a title naming the slider
   * that lifts it -- which is what the earlier version lacked.
   *
   * `scale` is null when the field is missing from `editConfig`; that degrades
   * to "live", since a button that works is the safer failure here.
   */
  private refreshReroll(status: Status, scale: number | null): void {
    const generated = status.ruleIsGenerated;
    const zeroScale = scale === 0;
    const inert = generated || zeroScale;

    // One key for both conditions, so the frame-by-frame case is a single
    // string compare. Both reasons are in it, not just the `inert` result: the
    // TITLE differs between them, so a frame that swaps one cause for the other
    // still has a write to make.
    const key = `${generated ? 'g' : '-'}${zeroScale ? 'z' : '-'}`;
    if (key === this.rerollShown) return;
    this.rerollShown = key;

    // `disabled` as well as the styling: without it the button still takes
    // focus and still fires, and an inert-looking control that works is worse
    // than either. The values match `menuBar.ts`'s greyed rows so the bar and
    // the Simulation menu read as the same state.
    this.reroll.disabled = inert;
    this.reroll.style.opacity = inert ? '0.45' : '1';
    this.reroll.style.cursor = inert ? 'default' : 'pointer';

    // THE TOOLTIP IS NOT WRITTEN HERE ANY MORE. It is a live source attached
    // once in the constructor and resolved when the user actually hovers, so
    // this method no longer has to push text on every state change -- see
    // `rerollHelp`. What stays is the disabled state and its styling, which
    // must be on screen whether or not anyone hovers.
    //
    // `aria-label` DOES stay per-state, because it is the only channel that
    // reaches a screen reader and it cannot be resolved lazily.
    this.reroll.setAttribute('aria-label', rerollHelp(generated, zeroScale).body);
  }

  /**
   * Attach the Reroll button's help, which depends on why it is greyed.
   *
   * A LIVE SOURCE rather than a string, because all three cases are reachable
   * without the button being rebuilt -- see `TooltipSource`. Called once from
   * the constructor; `refreshReroll` no longer touches the tooltip at all.
   */
  private attachRerollHelp(): void {
    this.tooltip.attach(this.reroll, () => {
      const status = this.lastStatus;
      // Before the first refresh there is no state to describe, so the button
      // is presented as live -- which is what it looks like, and matches the
      // `scale === null` degradation `refreshReroll` documents.
      if (status === null) return rerollHelp(false, false);
      const scale = status.editConfig['mutationScale'];
      return rerollHelp(status.ruleIsGenerated, scale === 0);
    });
  }

  /**
   * The context hint and its stepper.
   *
   * Guarded on the RENDERED result rather than on the Status fields behind it:
   * `hintFor` is the only thing that knows which state changes actually change
   * the words, and re-writing four nodes every frame to say what they already
   * say is the same waste `generatedShown` guards against above.
   */
  /**
   * Repaint the touch context button. A no-op on the desktop, where it is null.
   *
   * GUARDED ON THE RENDERED LABEL, exactly as `refreshHint` guards on its key
   * and for the same reason: this runs every frame, and writing the same string
   * sixty times a second is the waste every other guard in this file avoids.
   * The label is a function of both the action and the latch, so it is the one
   * value that changes precisely when something visible has.
   */
  private refreshContextButton(status: Status): void {
    const button = this.contextButton;
    if (button === null) return;

    const action = contextActionFor(status);
    const label = contextLabelFor(action, this.dragIsRight);
    if (this.contextShown === label) return;
    this.contextShown = label;

    button.textContent = label;
    // Never hidden. Unlike the desktop's three red buttons -- which appear and
    // vanish with the state -- this one is always live, because every state has
    // SOME context action. A control that came and went under the thumb would
    // also move the gold button beside it, which is the last thing a
    // frequently-pressed pair should do.
    button.style.display = 'inline-flex';
    // The label alone does not say a latch IS one, so the pressed state is
    // announced rather than left to the wording.
    if (action === 'toggleDragButton') {
      button.setAttribute('aria-pressed', String(this.dragIsRight));
    } else {
      button.removeAttribute('aria-pressed');
    }
    button.setAttribute('aria-label', label);
  }

  private refreshHint(status: Status): void {
    const { lead, cohort, tail, commit, clearField, cancelSelection, generateChild, undo } =
      hintFor(status);

    // OUTSIDE THE GUARD BELOW, and it has to be. The context button's label
    // depends on `dragIsRight`, which is UI state the Orchestrator never sees
    // and which therefore never appears in `hintFor`'s output or in the key
    // built from it. Inside the guard, flipping the latch in Shove would repaint
    // nothing -- the hint words are identical in both positions -- and the
    // button would keep claiming to be in the state it just left.
    //
    // It carries its own guard instead, so this is still one comparison per
    // frame in the common case.
    this.refreshContextButton(status);

    // THE FIELD IS RECONCILED ABOVE THE GUARD, because it can disagree with the
    // state without the STATE having changed. Type "99" over cohort 7 with 8
    // cohorts and press Enter: the command wraps back to 7, the hint is
    // character-for-character identical, the guard below short-circuits -- and
    // the field sits there reading "99" for a cohort that is not lit. Same for
    // anything unparseable that `change` rejected, and for any value that
    // wrapped to where it started. A readout showing something the app does not
    // believe is exactly what this row exists to avoid.
    //
    // NOT WHILE THE FIELD HAS FOCUS. Writing `value` under a caret moves it to
    // the end and would fight someone mid-type -- the same argument the tool
    // `<select>` above makes, and the slider's `dragging` guard makes for a
    // drag. Blur fires `change` first, so a committed value is already on its
    // way back through the Orchestrator by the time this can write.
    if (cohort !== null) {
      this.lastCohort = String(cohort);
      if (
        document.activeElement !== this.cohortInput &&
        this.cohortInput.value !== this.lastCohort
      ) {
        this.cohortInput.value = this.lastCohort;
      }
    }

    // `commit` joins the key, or toggling the button would not repaint: the
    // no-op case and the commit case share a lead, a cohort and -- once the
    // clause moved into the button -- very nearly a tail.
    //
    // `clearField` JOINS IT FOR THE SAME REASON, and it is not redundant with
    // the lead. Both flags are decided by state the words do not always
    // distinguish, and a button whose visibility is not in the key is a button
    // that gets stuck in whichever state it was first written in.
    // `cancelSelection` joins the key too, and for the same reason as the other
    // two: it is decided by state the words do not distinguish, and a button
    // left out of the key is a button stuck in whichever state it was first
    // written in.
    //
    // `undo` JOINS IT AS A STRING, NOT A BOOLEAN, because its LABEL is state:
    // the button names what would be taken back, so the same button visible
    // across two different stack tops has to repaint. `String(null)` is
    // "null", which no label can collide with, so the hidden case stays
    // distinct from any wording.
    const key =
      `${lead} ${String(cohort)} ${tail} ${String(commit)} ` +
      `${String(clearField)} ${String(cancelSelection)} ` +
      `${String(generateChild)} ${String(undo)}`;
    if (this.hintShown === key) return;
    this.hintShown = key;

    // =====================================================================
    // TOUCH: the context button REPLACES the two red ones, it does not join
    // them
    // =====================================================================
    //
    // `hintFor` decides Cancel and Undo independently, which is right for a
    // mouse: each is its own button and there is room for whichever is live.
    // On a phone the context button already IS whichever is live -- that is
    // what `contextActionFor` computes, from these very states -- so rendering
    // the desktop pair as well would put two identical red controls on a 390px
    // row and squeeze the one a finger is meant to hit down to a stub.
    //
    // MEASURED, NOT GUESSED: before this, the context button rendered 26px wide
    // showing "lo (h" while "Nothing to undo" sat beside it taking 200px.
    //
    // The PROSE goes too, and for the same reason rather than to save a line.
    // These sentences name mouse gestures -- "Left click a particle", "Right
    // click to undo" -- which is advice a touch user cannot act on. What
    // replaces them is the pair of buttons, whose labels say what the two
    // gestures that DO exist will do.
    const suppressForTouch = this.mobile;

    this.hintLead.textContent = suppressForTouch ? '' : lead;
    this.hintTail.textContent = suppressForTouch ? '' : tail;

    // The label names EVERY route to the same act, which is the point of
    // replacing the prose: the button is one way, and it says what the other two
    // are rather than leaving them to be discovered. The key comes from the
    // hotkey table, so a rebind moves it and an unbind drops it cleanly.
    if (commit) {
      const enter = hotkeyLabel({ kind: 'confirmSelection' });
      // SHORT ON TOUCH, and the omissions are deliberate rather than arbitrary
      // truncation. The desktop label names every route to the act -- the key
      // and the second click -- which is exactly the part a touch user cannot
      // use: there is no keyboard and, on this layout, clicking a cohort again
      // does NOT commit (see `oneClickSelection` handling). Naming routes that
      // do not exist here is worse than saying less.
      this.commitButton.textContent = suppressForTouch
        ? 'Generate children'
        : 'Generate children from selected cohort' +
          keySuffix([enter, 'Left click cohort again']);
    }
    this.commitButton.style.display = commit ? 'inline-flex' : 'none';

    // Same construction as the commit button above: the label names EVERY route
    // to the act, the left click from the canvas and the key from the table.
    // "Left click" is a literal because the canvas gesture is not rebindable
    // (`applyCanvasInput` reads the button); Enter comes from `hotkeyLabel`, so
    // a rebind moves it and an unbind drops it.
    if (generateChild) {
      const enter = hotkeyLabel({ kind: 'confirmSelection' });
      // Shortened on touch for the reason the commit button above is: the
      // suffix names a key and a mouse click, neither of which a finger has.
      this.generateChildButton.textContent = suppressForTouch
        ? 'Generate a child'
        : 'Generate a child from current behavior' + keySuffix(['Left click', enter]);
    }
    this.generateChildButton.style.display = generateChild ? 'inline-flex' : 'none';

    // NAMES THE STACK TOP, which is the reason this is a button rather than the
    // sentence it replaced: "undo any action" told you the gesture existed,
    // never what it would cost you.
    //
    // **THE EMPTY STACK STILL SHOWS THE BUTTON, DISABLED AND SAYING SO.** Hiding
    // it would make the row twitch as the stack empties and refills, and a
    // control that vanishes teaches nothing about why. `disabled` as well as the
    // dimming, matching `reroll` above: without it the button still takes the
    // pointer and the Tab order, and announces itself as pressable to a screen
    // reader while doing nothing.
    if (undo !== null) {
      const empty = undo === '';
      this.undoButton.textContent = empty
        ? 'Nothing to undo'
        : `Undo ${undo}` + keySuffix(['Right click', hotkeyLabel({ kind: 'undo' })]);
      this.undoButton.disabled = empty;
      this.undoButton.style.opacity = empty ? '0.45' : '1';
      this.undoButton.style.cursor = empty ? 'default' : 'pointer';
    }
    // WITHHELD ON TOUCH: the context button is already whichever of Undo and
    // Cancel is live in this state. See `suppressForTouch` above.
    this.undoButton.style.display =
      undo !== null && !suppressForTouch ? 'inline-flex' : 'none';

    // `inline-flex` RESTATED rather than `''`, for the reason spelled out at the
    // stepper below: this button carries its layout in an inline `style` set
    // from `cssText`, and `''` would REMOVE the property rather than revert it.
    this.clearFieldButton.style.display = clearField ? 'inline-flex' : 'none';

    // `inline-flex` RESTATED, not `''` -- same reason as the two above.
    // WITHHELD ON TOUCH, like the undo button and for the same reason.
    this.cancelSelectionButton.style.display =
      cancelSelection && !suppressForTouch ? 'inline-flex' : 'none';

    const stepping = cohort !== null;
    // `inline-flex` RESTATED, NOT `''`. Both of these elements carry their
    // layout in an inline `style` (set from `cssText` at construction), and
    // assigning `''` REMOVES the property rather than reverting it to what the
    // stylesheet said -- there is no stylesheet here, so the stepper fell back
    // to a `<span>`'s default `display:inline`. Its three children then laid
    // out as inline boxes and wrapped, which is what put the arrows above and
    // below the field instead of either side of it.
    //
    // The tail is a plain text span whose default IS `inline`, so `''` happens
    // to be right for it -- stated explicitly anyway, because the difference
    // between these two lines is otherwise invisible and the next person to
    // copy one onto the other reintroduces the bug.
    this.stepper.style.display = stepping ? 'inline-flex' : 'none';
    this.hintTail.style.display = stepping ? 'inline' : 'none';
  }

  /**
   * Colour the population group: gold means "this is what is running".
   *
   * ## What "active" means, and why it is two conditions
   *
   * A layout preset writes BOTH a cohort count and `initialConditions: GRID`
   * (`setPopulationLayout`), so it is only truthful to light one when both still
   * hold. Testing the count alone would light the 16 button for a config with 16
   * cohorts scattered at random -- a state that button has never produced and
   * would not produce if pressed.
   *
   * At most one is ever lit, because the counts are distinct. None is lit
   * whenever the layout is not Grid, which is the honest answer: no preset
   * describes that state.
   *
   * ## Fences is coloured on its own terms
   *
   * Gold when the fences are ON, independent of which preset is active, because
   * that is what its own toggle says. It also swaps from a DASHED ring to a
   * SOLID one -- the colour says "active" the same way the presets do, and the
   * line style says which of the two states it is in without relying on colour
   * alone.
   *
   * **Read from `editConfig`, which survives a closed panel.**
   * `settingsSources` keeps every config field but `rule` in that payload
   * precisely so the always-visible bar can read it (`asRecord(config,
   * ['rule'])`). Adding `Status` fields for these two would duplicate values
   * already crossing the boundary.
   */
  private refreshPopulationGroup(status: Status): void {
    const layout = status.editConfig['initialConditions'];
    const onGrid = layout === IC.GRID;
    const cohorts = status.cohortCount;

    this.fencesOn = status.editConfig['cohortFences'] === true;

    // One key for the whole group, so the guard is a single string compare
    // rather than four. `refresh` runs every frame and this changes rarely.
    const key = `${onGrid ? String(cohorts) : '-'}:${this.fencesOn ? 'f' : ''}`;
    if (key === this.activeShown) return;
    this.activeShown = key;

    for (const [count, button] of this.layoutButtons) {
      button.style.color = onGrid && count === cohorts ? ACTIVE_GOLD : IDLE_WHITE;
    }

    // GREYED OFF GRID, because the setting genuinely does nothing there: the
    // fence radius is measured from a grid cell, and Random, Center and Ring
    // have no cell to measure (`settingsSpec.ts` greys the panel checkbox on the
    // same condition). A button that can be pressed and changes nothing is worse
    // than one that says it cannot.
    //
    // `disabled` rather than a class, so the pointer, the keyboard and assistive
    // tech all agree it is inert -- and so the click handler needs no guard of
    // its own.
    this.fences.disabled = !onGrid;
    this.fences.style.opacity = onGrid ? '1' : '0.4';
    this.fences.style.cursor = onGrid ? 'pointer' : 'default';
    this.fences.style.color = this.fencesOn ? ACTIVE_GOLD : IDLE_WHITE;
    // The ICON changes with the state too, not just its colour: solid when the
    // fences are holding, dashed when they are not. Rebuilt rather than
    // restyled because the dash pattern is an attribute on the circle, and
    // swapping the whole icon keeps `fencesIcon` the single description of both
    // states.
    this.fences.replaceChildren(fencesIcon(this.fencesOn));

    // The TOOLTIP is a live source attached once in the constructor, so it is
    // not written here -- see `attachFencesHelp`. `aria-label` still is: it is
    // the only channel that reaches a screen reader, and it cannot be resolved
    // lazily on hover the way the tooltip can.
    const state = this.fencesOn ? 'on' : 'off';
    this.fences.setAttribute(
      'aria-label',
      `Cohort Fences: ${state} — hold each cohort near where it started`,
    );
    this.fences.setAttribute('aria-pressed', String(this.fencesOn));
  }

  /**
   * Put the bar at the top, or below the menu bar if it would run into it.
   *
   * The decision is `overlayTop`'s; this is the part that needs a DOM. Called
   * per frame from `refresh` and on `resize` -- see `releaseResize` for why both.
   *
   * **THE MENU BAR IS LOOKED UP BY ID EVERY TIME, not cached.** `MenuBar` owns
   * that element, mounts it on `document.body` and removes it in its own
   * `dispose`, and the two classes are constructed in an order this file does
   * not get to assume -- a reference taken once here could be captured before it
   * exists or held after it is gone. The lookup is one `getElementById` per
   * frame against a document with a handful of top-level nodes.
   *
   * READS BOTH RECTS BEFORE WRITING, and writes at most one property: mixing
   * reads and writes is what turns a per-frame measurement into layout thrash.
   */
  private reposition(): void {
    // **NOTHING TO POSITION ON TOUCH, AND WRITING `top` WOULD BREAK IT.** The
    // whole of this method exists to keep a TOP-anchored bar clear of the menu
    // bar above it. The touch layout is anchored to the BOTTOM instead, where
    // there is nothing to collide with -- and setting `style.top` on an element
    // pinned by `bottom/left/right` would over-constrain it and stretch the bar
    // up the screen.
    if (this.mobile) return;

    const menu = document.getElementById('fluoddity-menubar');
    const top = overlayTop(
      this.root.getBoundingClientRect(),
      menu === null ? null : menu.getBoundingClientRect(),
    );
    if (this.topShown === top) return;
    this.topShown = top;
    this.root.style.top = `${String(top)}px`;
  }

  /** One of the stepper's two arrows. */
  private stepButton(glyph: string, label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = glyph;
    button.style.cssText = STEP_BUTTON_CSS;
    // The glyph is a chevron, which a screen reader reads as punctuation or not
    // at all -- so the name has to be stated.
    button.setAttribute('aria-label', label);
    // TITLE `Cohort`, body the direction. A tooltip with a title and no body
    // renders as a heading over a horizontal rule over nothing, which reads as
    // a control whose help failed to load rather than as a one-line hint.
    this.tooltip.attach(button, { title: 'Cohort', body: label });
    return button;
  }

  /**
   * One population preset: N cohorts, laid out on a grid, from a cold start.
   *
   * The icon carries the meaning and the `title` says it in words -- there is
   * no room for a text label at this size, and "1 / 4 / 16" alone would not say
   * what the number counts.
   */
  private layoutButton(
    count: number,
    send: (command: Command) => void,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.style.cssText = LAYOUT_BUTTON_CSS;

    // **THE ONE-COHORT CASE IS WORDED SEPARATELY.** "1 cohort, grid layout"
    // was generated by the same template as the other two and was misleading
    // for it: a grid of one has no arrangement to speak of, and what the button
    // actually produces is a single cohort in the middle of the world. The
    // other counts really are laid out on a grid, so they keep that wording.
    const description =
      count === 1
        ? 'Single cohort, centered'
        : `${String(count)} cohorts, grid layout`;
    // Not decorative: the icon is the only content, so without this the button
    // is unnamed to a screen reader. The tooltip below is a hover affordance
    // and reaches neither screen readers nor keyboard users, so this stays.
    button.setAttribute('aria-label', description);
    button.dataset['setting'] = `config.cohorts.preset${String(count)}`;
    this.tooltip.attach(button, { title: 'Population Layout', body: description });

    button.append(dotsIcon(count));
    button.addEventListener('click', () => {
      send({ kind: 'setPopulationLayout', cohorts: count });
    });
    return button;
  }

  /**
   * The overlay is deliberately NOT part of what `X` hides -- but its gear
   * REPORTS what `X` did.
   *
   * `X` hides the PANELS so you can see the picture; this bar is the picture's
   * own controls -- the one slider worth reaching for while watching, plus the
   * tool you are watching it with. Hiding it would mean pressing `X` to get a
   * clean view and then having to press `X` again to change anything about it.
   *
   * So this changes no visibility. What it does is colour the gear, which is
   * the one control on the bar whose state lives entirely outside `Status`:
   * hiding the panels never reaches the Orchestrator (see `onToggleUi`), so
   * `refresh` cannot learn it and this is the only notification there is. Every
   * route that flips the flag -- the key, the Editor menu item, and the gear's
   * own click -- goes through `Panel.setHidden`, which is what makes one call
   * site here sufficient.
   */
  setHidden(hidden: boolean): void {
    this.paintGear(hidden);
  }

  /**
   * Colour the gear and state its condition in words.
   *
   * Gold when the panels are SHOWING, matching the layout presets and Cohort
   * Fences: on this bar gold means "this toggle is the state you are in". The
   * title and `aria-label` name the state too, so the button is readable in a
   * screenshot and without colour vision -- the same rule the population group
   * follows, where colour is never the only signal.
   */
  private paintGear(hidden: boolean): void {
    this.gear.style.color = hidden ? IDLE_WHITE : ACTIVE_GOLD;
    // `aria-label` only. The tooltip is attached once in the constructor and
    // reads the panel state on hover, like the other two live sources here.
    this.gear.setAttribute(
      'aria-label',
      `Control panels: ${hidden ? 'hidden' : 'showing'} — show/hide them${this.uiKeySuffix}`,
    );
    this.gear.setAttribute('aria-pressed', String(!hidden));
  }

  // --- the touch context control -------------------------------------------
  //
  // Three small methods rather than one exposed flag, so the LATCH cannot be
  // written from outside: `touchBinding.ts` reads which button to imitate, the
  // canvas long-press asks for the action to be run, and only this class
  // decides what either of those means in the current state.

  /**
   * Which mouse button a one-finger drag should imitate.
   *
   * `false` -- meaning LEFT -- on the desktop and in Select, where the latch is
   * never flipped and a drag is navigation rather than a button anyway.
   */
  get touchDragIsRight(): boolean {
    return this.dragIsRight;
  }

  /**
   * Run the context action for the state the bar is in.
   *
   * Called by the red button and by a canvas long press, which is why it takes
   * no argument saying which: the two routes are deliberately the same act, and
   * a parameter distinguishing them would be an invitation to make them differ.
   *
   * DEGRADES TO NOTHING before the first refresh. `lastStatus` is null until
   * then, and there is no sensible action to guess at without knowing the tool
   * or what is lit -- doing nothing is strictly better than undoing something
   * because the bar had not been told what state it was in yet.
   */
  runContextAction(): void {
    const status = this.lastStatus;
    if (status === null) return;

    const action = contextActionFor(status);
    if (action === 'toggleDragButton') {
      this.dragIsRight = !this.dragIsRight;
      // Repaint at once rather than waiting for the next `refresh`. The latch
      // is the one control here whose label depends on state the Orchestrator
      // never sees, so nothing else would move it -- and a toggle that looks
      // unchanged until the next frame reads as a press that did not register.
      this.refreshContextButton(status);
      return;
    }
    // The other two are ordinary commands, and deliberately THE SAME ones the
    // red buttons send in those states -- see `contextActionFor`.
    this.send({ kind: action === 'cancel' ? 'cancelSelection' : 'undo' });
  }

  dispose(): void {
    this.releaseFocus();
    // The listener is on `window`, not inside `root`, so removing the bar does
    // not take it with it -- a resize after teardown would measure an element
    // that has left the document.
    this.releaseResize();
    // Its element is on `document.body`, not inside `root` -- removing the bar
    // would strand it, and a pending show timer would fire against an anchor
    // that has left the document.
    this.tooltip.dispose();
    this.root.remove();
  }
}

/**
 * What the context hint says, given this frame's state.
 *
 * PURE, AND EXPORTED, so the wording is testable under `node --test` -- the
 * overlay itself needs a DOM and cannot be constructed there. The four states
 * are what the tool means for the two mouse buttons, which is the one thing a
 * modal cursor has to tell you and the app previously told you nowhere.
 *
 * `cohort` is non-null exactly when the stepper should be shown, so the caller
 * branches on it rather than re-deriving the highlight rule. `tail` is empty in
 * every other state.
 *
 * ## The [[[TODO]]] markers
 *
 * Two of these strings describe adopting a behaviour, and the wording is not
 * settled -- "adopt" undersells it, because the picked rule becomes what the
 * WHOLE POPULATION varies around (`project.ts`'s `adoptRule`), not just that
 * cohort's. The markers are grep anchors so both sites can be found and revised
 * together. Nothing enforces them, deliberately: the tests match these two
 * sentences loosely so the wording can be rewritten without editing them.
 */
export function hintFor(status: Status): {
  readonly lead: string;
  readonly cohort: number | null;
  readonly tail: string;
  /**
   * Whether to offer the commit BUTTON in place of the "left click it" prose.
   *
   * Decided here rather than in the DOM so it is testable with the wording it
   * replaces -- the two are one decision, and a button that appeared while the
   * sentence still told you to click would be two answers to the same question.
   */
  readonly commit: boolean;
  /**
   * Whether to offer the "clear every barrier" button.
   *
   * Decided here rather than in the DOM for the same reason `commit` is: it is
   * part of what this row SAYS in a given state, and the tests that pin the
   * wording should be able to pin which buttons come with it.
   */
  readonly clearField: boolean;
  /**
   * Whether to offer the "cancel this selection" button.
   *
   * Decided here for the same reason `commit` and `clearField` are. It tracks
   * the HIGHLIGHT rather than the commit: both lit states offer it, including
   * the no-op one where the commit is refused -- backing out of an aim is
   * exactly as available at mutation scale 0 as anywhere else, and it is the
   * useful thing to do in the state where committing is not.
   */
  readonly cancelSelection: boolean;
  /**
   * Whether to offer the "generate a child from the current behaviour" button.
   *
   * The single-cohort / one-click states only. With highlighting off there is no
   * aiming stage, so `confirmSelection` commits immediately -- the same act the
   * `commit` button performs once a cohort IS lit, which is why the two are
   * separate flags rather than one: they are the same command reached from two
   * different states, and no state offers both.
   */
  readonly generateChild: boolean;
  /**
   * Whether to offer the undo button, and what it would take back.
   *
   * `null` MEANS "NO BUTTON", not "nothing to undo" -- an empty stack still
   * shows the button, saying so. The distinction is the whole point: this is
   * offered exactly in the two Select states where right-click undoes, and
   * withheld everywhere right-click means something else. While a cohort is lit
   * right-click CANCELS THE AIM (`applyCanvasInput`), and the red cancel button
   * beside it already claims that gesture -- a second red button promising the
   * same click did something different would be two answers to one question.
   *
   * The string is `undoLabel` verbatim, empty when the stack is empty, so the
   * caller words the empty case once rather than this function guessing at it.
   */
  readonly undo: string | null;
} {
  const none = (lead: string) => ({
    lead,
    cohort: null,
    tail: '',
    commit: false,
    clearField: false,
    cancelSelection: false,
    generateChild: false,
    undo: null,
  });

  if (status.mouseMode === 'shove') {
    return none('Left click to push particles away | Right click to pull them in');
  }
  if (status.mouseMode === 'draw') {
    // THE ONLY STATE THAT OFFERS IT. Clearing the field is a Draw-tool act --
    // the button is the bulk form of the right-click the same sentence
    // describes, so it belongs beside that sentence and nowhere else. Under
    // Select or Shove it would be an unrelated destructive control sitting in a
    // row about something else entirely.
    return { ...none('Left click to add barriers | Right click to erase them'), clearField: true };
  }

  // Select. `highlightedCohort` arrives ALREADY GATED by the Orchestrator, so
  // `NO_COHORT` covers "nothing lit" and "highlighting is switched off" alike --
  // the two want different wording, which is why the one-cohort and
  // one-click-selection cases are distinguished below rather than here.
  // THE NO-OP CASE ONLY CHANGES THE COMMIT CLAUSE. With mutation at zero every
  // cohort obeys the same rule, so the commit is declined -- and a refused click
  // is indistinguishable from a broken one unless the UI says which it is. What
  // it does NOT change is the un-highlighted line: aiming still works there, so
  // that sentence was already accurate and saying more would be noise on the
  // state a user spends most of their time in.
  if (status.selectionIsNoOp && status.highlightedCohort !== NO_COHORT) {
    return {
      lead: 'Currently selected cohort:',
      cohort: status.highlightedCohort,
      // The cancel clause is a BUTTON now, so the tail keeps only the advice
      // that has nowhere else to go.
      tail: ' | Increase Mutation Scale for variations. These children are all identical to their parent',
      // NO COMMIT BUTTON HERE, and this is the case that most needs to say so.
      // The commit is REFUSED at mutation scale 0 (`selectionIsNoOp`), so
      // offering a button that declines when pressed would be worse than the
      // sentence it replaced -- the sentence at least explains what to do.
      commit: false,
      // Select has no barriers to clear. Stated in every branch rather than
      // defaulted, so adding a state to this function is forced to decide.
      clearField: false,
      // OFFERED EVEN THOUGH THE COMMIT IS NOT. Cancelling is not refused here --
      // it is the one action this state fully supports, and a user who cannot
      // commit is exactly the user who wants to back out.
      cancelSelection: true,
      // Highlighting is ON here (a cohort is lit), so the immediate-adopt button
      // belongs to the other branch entirely.
      generateChild: false,
      // NO UNDO BUTTON WHILE A COHORT IS LIT. Right-click cancels the aim in
      // this state, and the cancel button above already says so.
      undo: null,
    };
  }

  if (status.highlightedCohort !== NO_COHORT) {
    return {
      lead: 'Currently selected cohort:',
      cohort: status.highlightedCohort,
      // BOTH clauses are buttons now, so nothing is left for the tail to say.
      // Kept as an empty string rather than dropped, because the field is what
      // `refreshHint` hides the element on.
      tail: '',
      commit: true,
      clearField: false,
      cancelSelection: true,
      // The commit button above IS this act in the lit state; offering both
      // would put two gold buttons for one command on the same row.
      generateChild: false,
      // Withheld for the reason the no-op branch gives: right-click cancels here.
      undo: null,
    };
  }

  // Highlighting off entirely: one click adopts, so promising a cohort
  // selection that will never appear would be a lie about the next click. The
  // two exemptions -- the `oneClickSelection` preference and a single-cohort
  // config -- are already collapsed into this one flag by the Orchestrator, and
  // they produce identical behaviour, so they share a sentence.
  //
  // **THE SENTENCE IS NOW A BUTTON**, for the reason the commit button gives one
  // branch up: the act is reachable three ways -- left click, Enter, and this --
  // and prose describing two of them is worse than a control that IS the third
  // and names the others. It also puts the act within reach of someone who
  // arrived by keyboard, which matters most here: with a single cohort there is
  // no stepper to arrow through, so the canvas was previously the ONLY way in.
  if (!status.highlightEnabled) {
    // **THE BUTTON IS WITHDRAWN AT MUTATION SCALE 0**, for the reason the lit
    // no-op branch above gives: `confirmSelection` is REFUSED there, and a
    // button that declines when pressed is worse than the sentence it replaced.
    // The sentence says what to do about it instead.
    //
    // `selectionIsNoOp` ALREADY EXEMPTS THE SENTINEL, which is what makes this
    // one flag rather than two conditions restated here: with a generated rule
    // the GPU takes its generate branch, every cohort gets a genuinely
    // different rule regardless of mutation scale, and adopting one is the only
    // way to capture it -- so the button stays, and stays useful.
    if (status.selectionIsNoOp) {
      return {
        ...none(
          'Increase Mutation Scale for variations. This child is identical to its parent',
        ),
        // THE UNDO BUTTON STAYS. Only the gold button is refused here -- right
        // click still undoes in this state, exactly as it does in the two
        // branches either side, and dropping the button because a DIFFERENT
        // action became unavailable would make it flicker with the slider.
        undo: status.canUndo ? status.undoLabel : '',
      };
    }
    return {
      ...none(''),
      generateChild: true,
      undo: status.canUndo ? status.undoLabel : '',
    };
  }

  return {
    ...none('Left click a particle to select its cohort'),
    // The "| Right click to undo any action" clause is a BUTTON now, so it comes
    // off the sentence -- and the button says WHAT would be undone, which the
    // clause never could.
    undo: status.canUndo ? status.undoLabel : '',
  };
}

/**
 * What the touch layout's context button does right now.
 *
 * =============================================================================
 * ONE BUTTON, BECAUSE ONE GESTURE IS MISSING
 * =============================================================================
 *
 * The desktop reaches four different acts through the RIGHT MOUSE BUTTON, and a
 * touchscreen has no such button. `hintFor` already knows which of them is live
 * in a given state -- it decides whether to offer the red Cancel button or the
 * red Undo button -- so this reads the same states and names the act, rather
 * than inventing a second opinion about them.
 *
 * PURE AND MODULE-LEVEL, for the reason `hintFor` above is: the mapping from
 * state to action is the whole of the feature and it should be assertable
 * without a DOM.
 *
 * ## The three actions, and why Shove and Draw differ from Select
 *
 *   CANCEL   a cohort is lit. Right-click cancels the aim on the desktop, so
 *            this does. The gold commit button beside it is the other half.
 *   UNDO     Select with nothing lit -- the desktop's plain right-click undo.
 *   TOGGLE   Shove and Draw. These two tools use BOTH mouse buttons for real
 *            work (push/pull, draw/erase) rather than for backing out, so
 *            there is nothing to cancel and no undo to reach; what a finger
 *            lacks here is the second button itself. The context control
 *            becomes a latch that says which button a drag imitates.
 *
 * **THE TOGGLE IS DELIBERATELY NOT REACHABLE BY LONG PRESS.** `touchBinding`
 * polls for long presses in Select only, and `touchGestures` refuses one on a
 * dragging finger -- two independent guards for the same hazard, which is that
 * resting mid-stroke is normal and flipping draw into erase underneath a stroke
 * in progress would erase what was just drawn. The button is the only route.
 */
export type ContextAction = 'cancel' | 'undo' | 'toggleDragButton';

export function contextActionFor(status: Status): ContextAction {
  // SHOVE AND DRAW FIRST, because the question they answer is different in kind:
  // the other two branches ask "what would backing out do here", and these two
  // have no backing-out to offer at all.
  if (status.mouseMode === 'shove' || status.mouseMode === 'draw') {
    return 'toggleDragButton';
  }
  // READ THROUGH THE SAME GATE `applyCanvasInput` USES. `highlightedCohort`
  // arrives already gated by the Orchestrator, so `NO_COHORT` covers both
  // "nothing lit" and "highlighting is off" -- and in both of those right-click
  // undoes rather than cancelling. Testing the raw cohort without that gate
  // would offer Cancel in a state where nothing is lit to cancel.
  if (status.highlightedCohort !== NO_COHORT) return 'cancel';
  return 'undo';
}

/**
 * What the context button should be LABELLED, given what it will do.
 *
 * Split from the action so the wording can be revised without touching the
 * behaviour, and so a test can pin the two independently. The label names the
 * long-press shortcut where one exists -- which is exactly the Select states,
 * since that is where `touchBinding` polls for it.
 */
export function contextLabelFor(action: ContextAction, dragIsRight: boolean): string {
  switch (action) {
    case 'cancel':
      return 'Cancel (hold)';
    case 'undo':
      return 'Undo (hold)';
    case 'toggleDragButton':
      // NAMES THE STATE IT IS IN, not the state it would move to. A latch
      // labelled with its destination reads as a description of the present to
      // anyone who has not just pressed it, which is the classic way to make a
      // toggle ambiguous. No "(hold)": long press is refused in these tools.
      return dragIsRight ? 'Erase / Pull' : 'Draw / Push';
    default: {
      const unreachable: never = action;
      throw new Error(`Unhandled context action: ${String(unreachable)}`);
    }
  }
}

/**
 * What the Reroll button says, given why it is (or is not) greyed.
 *
 * PURE AND MODULE-LEVEL, so the three cases can be read together and tested
 * without a DOM -- the same reason `hintFor` above is.
 *
 * Each greyed state says WHY and how to leave it. A disabled control that does
 * not explain itself is a dead end, and in both cases the way out is a control
 * sitting right beside it, which is worth naming.
 *
 * THE SENTINEL CASE IS CHECKED FIRST because both can hold at once, and it is
 * the one with somewhere to go: `Reroll All Behavior` has taken the slider's
 * place, so pointing at Mutation Scale would name a slider that is not on
 * screen.
 *
 * **THE SENTINEL TEXT NO LONGER NAMES `F`.** It used to say "and F does it
 * too", which was true while the Orchestrator redirected the key to Randomize
 * Behavior. That redirect is gone: `F` is now inert wherever this button is
 * greyed, so the old sentence would promise a shortcut that does nothing.
 */
function rerollHelp(generated: boolean, zeroScale: boolean): TooltipContent {
  if (generated) {
    return {
      title: 'Reroll Mutations',
      body:
        'There is no authored behaviour to mutate yet.\n\n' +
        'Reroll All Behavior is the action for this state.',
    };
  }
  if (zeroScale) {
    return {
      title: 'Reroll Mutations',
      body:
        'Mutation Scale is 0, so every seed looks the same.\n\n' +
        'Raise Mutation Scale to reroll.',
    };
  }
  return { title: 'Reroll Mutations', body: REROLL_MUTATIONS_HELP };
}

/** Two decimals: enough to read, few enough not to jitter under a drag. */
function format(value: number): string {
  return value.toFixed(2);
}

/**
 * ` (B or F)` from a list of keys, or `''` if none are bound.
 *
 * Every key comes from `hotkeyLabel`, which returns `''` for an unbound
 * command -- so a rebind moves these labels and an UNBIND removes the key from
 * the list rather than rendering "( or F)".
 */
function keySuffix(keys: readonly string[]): string {
  const bound = keys.filter((key) => key !== '');
  return bound.length === 0 ? '' : ` (${bound.join(' or ')})`;
}

/**
 * Cohort counts the preset buttons offer. Each must be a perfect square, since
 * `dotsIcon` lays it out as one -- 1, 4 and 16 read as die faces at this size.
 */
const LAYOUT_PRESETS: readonly number[] = [1, 4, 16];

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * `count` dots on a square grid, as a die face reads.
 *
 * The first SVG in the project. `createElementNS` is required: `createElement`
 * would silently build an inert HTML element with the same tag name, which
 * renders as nothing at all rather than failing.
 *
 * `fill:currentColor` rather than a literal, so the dots follow the button's
 * `color` -- which is what lets a disabled or hovered state recolour the icon
 * without this function knowing about either.
 */
function dotsIcon(count: number): SVGSVGElement {
  const side = Math.round(Math.sqrt(count));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${String(ICON_BOX)} ${String(ICON_BOX)}`);
  svg.setAttribute('width', String(ICON_BOX));
  svg.setAttribute('height', String(ICON_BOX));
  svg.style.display = 'block';

  // Dots sit at cell centres, and the radius is a fraction of the CELL rather
  // than a constant -- at 4x4 a fixed radius either merges the dots or leaves
  // the 1x1 face a speck.
  const cell = ICON_BOX / side;
  const radius = Math.max(cell * 0.22, 0.9);
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', String((col + 0.5) * cell));
      dot.setAttribute('cy', String((row + 0.5) * cell));
      dot.setAttribute('r', String(radius));
      dot.setAttribute('fill', 'currentColor');
      svg.append(dot);
    }
  }
  return svg;
}

/**
 * The Cohort Fences ring: dashed when off, solid when on.
 *
 * A RING because that is the shape of the thing -- a fence holds each cohort
 * inside a circle of half a grid cell (`config.ts`), so the icon is a picture of
 * the boundary rather than a symbol standing in for one.
 *
 * DASHED reads as "a boundary that is not currently holding", which is exactly
 * the off state; solid reads as closed. That difference survives at 16px and
 * survives without colour, which is what makes the gold a reinforcement rather
 * than the only signal -- the same rule the recording readout follows.
 *
 * `stroke:currentColor`, so the button's `color` drives it and this function
 * never needs to know about gold.
 */
function fencesIcon(solid: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${String(ICON_BOX)} ${String(ICON_BOX)}`);
  svg.setAttribute('width', String(ICON_BOX));
  svg.setAttribute('height', String(ICON_BOX));
  svg.style.display = 'block';

  const c = ICON_BOX / 2;
  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('cx', String(c));
  ring.setAttribute('cy', String(c));
  // Inset by the stroke's half-width plus a hair, so a solid ring does not
  // clip against the viewBox edge at this size.
  ring.setAttribute('r', String(c - 2.2));
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', 'currentColor');
  ring.setAttribute('stroke-width', '1.8');
  if (!solid) {
    // Tuned against the circumference rather than picked: r=5.8 gives ~36.4, so
    // a 2.6+2.4 cell repeats ~7.3 times. A pattern that does not divide evenly
    // leaves one visibly short dash at the seam, which reads as a rendering
    // fault rather than as a dashed line.
    ring.setAttribute('stroke-dasharray', '2.6 2.4');
    ring.setAttribute('stroke-linecap', 'round');
  }
  svg.append(ring);
  return svg;
}

/**
 * A gear. Moved here from `panelToggle.ts` with the button itself.
 *
 * Eight teeth as rotated rectangles plus a stroked hub, rather than a `<path>`
 * traced from a design tool: at this size the silhouette is all that survives,
 * and generating it keeps the file free of an opaque coordinate blob nobody can
 * adjust.
 *
 * `fill`/`stroke` of `currentColor` so the icon follows the button's `color` --
 * which is what lets a hover or disabled state recolour it without this function
 * knowing either exists.
 */
function gearIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${String(ICON_BOX)} ${String(ICON_BOX)}`);
  svg.setAttribute('width', String(ICON_BOX));
  svg.setAttribute('height', String(ICON_BOX));
  svg.style.display = 'block';

  const c = ICON_BOX / 2;
  const teeth = 8;
  for (let i = 0; i < teeth; i++) {
    const tooth = document.createElementNS(SVG_NS, 'rect');
    tooth.setAttribute('x', String(c - 1.4));
    tooth.setAttribute('y', String(c - 9.0));
    tooth.setAttribute('width', '2.8');
    tooth.setAttribute('height', '5.2');
    tooth.setAttribute('rx', '0.9');
    tooth.setAttribute('fill', 'currentColor');
    // Rotated about the centre rather than placed by trigonometry here: the
    // transform is what makes "eight evenly spaced" obvious at a glance.
    tooth.setAttribute(
      'transform',
      `rotate(${String((360 / teeth) * i)} ${String(c)} ${String(c)})`,
    );
    svg.append(tooth);
  }

  // The body and its hole, drawn as ONE stroked ring rather than two filled
  // circles -- so the hole stays transparent over any background instead of
  // being painted in a colour that has to match one.
  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('cx', String(c));
  ring.setAttribute('cy', String(c));
  ring.setAttribute('r', '4.3');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', 'currentColor');
  ring.setAttribute('stroke-width', '3.2');
  svg.append(ring);

  return svg;
}

/**
 * The `(X)` beside an icon, as a dimmed span.
 *
 * A separate element rather than text appended to the button, so the glyph and
 * the key can be sized and dimmed independently -- the icon carries the meaning
 * at full contrast and the shortcut sits back out of the way. Empty input
 * yields an empty span, which costs one node and keeps the caller free of a
 * conditional.
 */
function keyCaption(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.textContent = text.trim();
  span.style.cssText = KEY_CAPTION_CSS;
  return span;
}

// -- styling ----------------------------------------------------------------
//
// `pointer-events` is the load-bearing part. The root spans the full width so
// its contents can be centred, which would otherwise put an invisible input
// trap across the whole top of the canvas -- so the ROOT ignores the pointer
// and only the bar takes it back. Without this, a drag started near the top of
// the canvas would hit nothing.
//
// ## The geometry, and the two bugs it fixes
//
// **`top` clears the menu bar.** The bar is fixed at `top:0` and runs about
// 26px tall (`menuBar.ts`); at `top:8px` this overlay ran straight through it.
//
// **THE `top` HERE IS ONLY THE STARTING VALUE.** `reposition` overwrites it
// from the first frame onward, and `overlayTop` decides what it becomes: the
// clearance only when the two bars actually overlap horizontally, and 8px when
// they do not. What this declaration is for is the frame before the first
// measurement -- it starts in the arm that cannot overlap the menu bar, so a
// bar that is never measured is merely lower than it needs to be rather than
// sitting on top of File and Share.
//
// MENU_BAR_CLEARANCE POSITIONS THIS OVERLAY ONLY. `panel.ts` does not import it
// -- its `PANEL_TOP_PX` is a hand-computed literal that has to clear the menu
// bar AND this bar's full height, and the two are related by intent rather than
// by code. So they CAN drift, and changing either alone is how they overlap.
// (A previous version of this comment claimed the opposite; it was never true.)
//
// **`transform`, not flex, does the centring.** With `left:0;right:0` and
// `align-items:center` the bar was centred in whatever width the root happened
// to have -- and `position:fixed` resolves that against the viewport, which
// changes when a scrollbar appears or disappears as the panels are toggled with
// `X`. The bar visibly jumped. Anchoring the LEFT EDGE at 50% and pulling back
// by half the bar's own width centres it against a fixed reference instead, so
// nothing about the panels can move it.
// **THE CLEARANCE IS NOW A FALLBACK, NOT THE POSITION.** It is what the bar
// uses before it has been measured (a hidden or not-yet-laid-out element
// measures as a zero rect) and whenever the menu bar cannot be found at all.
// `overlayTop` is what decides the real number, per frame -- see it for why the
// static value was costing vertical space in the common case.
const MENU_BAR_CLEARANCE = 34;

// **BOTH OF THESE ARE DELIBERATELY TINY**, and they were 8px each when this
// rule was first written. 8px is the ordinary spacing constant in this file and
// it is the wrong one here: the whole point of measuring the collision is to
// stop spending vertical space that buys nothing, and a margin large enough to
// read as a deliberate gap is that same waste in a smaller denomination. 2px is
// enough to keep the two borders from appearing to merge into one thick rule,
// which is the only thing separation has to achieve here.

/** Breathing room between the menu bar's bottom edge and the mutation bar. */
const MENU_BAR_GAP_PX = 2;

/** Where the bar sits when nothing is in its way: hard against the top. */
const TOP_MARGIN_PX = 2;

/**
 * A rectangle, as much of one as `overlayTop` reads.
 *
 * Structurally compatible with `DOMRect`, so callers hand one straight in. Its
 * own type so the geometry can be tested under `node --test`, where `DOMRect`
 * does not exist.
 */
export interface Rect {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * How far down the mutation bar has to start, given who is beside it.
 *
 * ## Why this is measured rather than a constant
 *
 * The bar used to sit at a fixed `MENU_BAR_CLEARANCE`, which cleared the menu
 * bar unconditionally -- and the menu bar is a strip at the TOP LEFT that is
 * only as wide as its six titles, while this bar is CENTRED. On any window wide
 * enough for both, they do not overlap horizontally at all, so the clearance was
 * buying nothing and spending ~26px of the picture to buy it. That cost is worst
 * exactly where it hurts most: the two rows here are already the tallest chrome
 * on screen.
 *
 * So the rule is the one a human would apply by eye. If the two rectangles
 * OVERLAP HORIZONTALLY, drop below the menu bar. If they do not, go to the top.
 *
 * ## Why the test is horizontal only
 *
 * Both elements are `position:fixed` near `top:0`, so they are always at the
 * same height -- vertical overlap is a given and testing for it would make the
 * condition self-referential (the bar is only clear of the menu bar BECAUSE this
 * function moved it, so a two-axis test would flip back and forth every frame).
 * Horizontal separation is decided by widths this function does not control,
 * which is what makes it a stable input.
 *
 * ## Degrading
 *
 * `menu` is null when the menu bar is absent, and a zero-width rect (`left ===
 * right`) is what an unlaid-out or hidden element measures as. Both fall back to
 * the static clearance rather than to the top: overlapping the menu bar is the
 * failure that makes controls unclickable, and this is the arm that cannot cause
 * it.
 */
export function overlayTop(bar: Rect, menu: Rect | null): number {
  if (menu === null) return MENU_BAR_CLEARANCE;
  // An unmeasured rect. Not `bar`, which is allowed to be zero-width on the
  // very first frame -- a bar with no width overlaps nothing, and the next
  // frame corrects it.
  if (menu.right <= menu.left) return MENU_BAR_CLEARANCE;
  // STRICT INEQUALITIES, so edges that merely touch are not an overlap: a bar
  // starting at exactly the menu bar's right edge clears it.
  const overlaps = bar.left < menu.right && menu.left < bar.right;
  if (!overlaps) return TOP_MARGIN_PX;
  return Math.round(menu.bottom) + MENU_BAR_GAP_PX;
}

const ROOT_CSS =
  `position:fixed;top:${MENU_BAR_CLEARANCE}px;left:50%;transform:translateX(-50%);` +
  'z-index:30;display:flex;flex-direction:column;align-items:center;gap:4px;' +
  'pointer-events:none;';

const BAR_CSS =
  'display:flex;align-items:center;gap:10px;pointer-events:auto;' +
  'background:rgba(28,28,30,0.92);border:1px solid rgba(255,255,255,0.12);' +
  'border-radius:6px;padding:7px 12px;box-shadow:0 4px 16px rgba(0,0,0,0.45);';

const LABEL_CSS =
  'font:12px system-ui,sans-serif;color:#e8e8ea;white-space:nowrap;' +
  'user-select:none;';

// =========================================================================
// TOUCH: the bar moves to the BOTTOM and becomes two rows
// =========================================================================
//
// **BOTTOM, BECAUSE THAT IS WHERE THUMBS REACH.** On a phone held one-handed
// the top of the screen is the hardest place to touch and the bottom is the
// easiest, which is the reverse of a desktop window where the menu bar is the
// natural home for controls. The hint row stays directly above the bar, so the
// pair reads bottom-up: what the tool does, then the controls that change it.
//
// `left:0;right:0` REPLACES THE CENTRING TRANSFORM. The desktop bar is centred
// with `translateX(-50%)` and sized by its contents; this one spans the
// viewport, because on a phone there is no spare width to centre within and the
// controls should use all of it.
//
// `padding-bottom` CARRIES THE SAFE-AREA INSET. On a notched phone the bottom
// of the viewport is behind the home indicator, and a bar flush to `bottom:0`
// puts its controls under it -- reachable only by a swipe that the OS claims.
// `env()` resolves to 0 where there is no inset, so this costs nothing
// elsewhere. It is ARMED by `viewport-fit=cover` in `index.html`; without that
// meta tag the value is always 0 and this silently does nothing.
const TOUCH_ROOT_CSS =
  'position:fixed;bottom:0;left:0;right:0;' +
  'z-index:30;display:flex;flex-direction:column;align-items:stretch;gap:4px;' +
  'padding:0 6px calc(6px + env(safe-area-inset-bottom,0px));' +
  'box-sizing:border-box;pointer-events:none;';

// The two-row container. Column rather than the desktop's single row.
const TOUCH_BAR_CSS =
  'display:flex;flex-direction:column;gap:6px;pointer-events:auto;' +
  'background:rgba(28,28,30,0.92);border:1px solid rgba(255,255,255,0.12);' +
  'border-radius:10px;padding:8px;box-shadow:0 4px 16px rgba(0,0,0,0.45);';

// One row inside it.
//
// `gap:8px` is wider than the desktop's 10px looks, because these controls are
// bigger and adjacent 44px targets need visible separation to be told apart by
// touch rather than by sight.
const TOUCH_BAR_ROW_CSS =
  'display:flex;align-items:center;gap:8px;width:100%;min-width:0;';

// The hint row, which on touch carries the gold/red button pair.
//
// **`max-width:96vw` IS GONE, AND `width:100%` REPLACES IT.** The desktop row
// shrink-wraps its sentence and is capped so a long one cannot run off screen.
// Here the row is a container for two buttons that should SPLIT the viewport
// evenly, so it takes all of it and lets `flex:1` on each button do the
// division.
//
// The prose is still allowed to shrink and ellipsize (`HINT_TEXT_CSS` on the
// spans), which matters more here than on the desktop: several of these
// sentences were written for a 1400px bar and this row is 390px wide.
const TOUCH_HINT_CSS =
  'display:flex;align-items:center;gap:6px;flex-wrap:nowrap;pointer-events:auto;' +
  'background:rgba(28,28,30,0.92);border:1px solid rgba(255,255,255,0.12);' +
  'border-radius:10px;padding:6px;box-shadow:0 4px 16px rgba(0,0,0,0.45);' +
  'font:12px system-ui,sans-serif;color:#a8a8ad;white-space:nowrap;' +
  'user-select:none;width:100%;box-sizing:border-box;overflow:hidden;';

// The slider, filling its row rather than taking a fixed share of the viewport.
//
// `min-width:0` IS LOAD-BEARING: a flex item defaults to `min-width:auto`,
// which refuses to shrink below its intrinsic size and would push the gear off
// the row on a narrow phone.
//
// `height:44px` gives the TRACK a finger-sized hit area. The thumb is drawn
// inside it and stays its natural size, so this widens what can be grabbed
// without making the control look inflated.
const TOUCH_SLIDER_CSS =
  'flex:1;min-width:0;height:44px;accent-color:#8ab4f8;cursor:pointer;';

// The bottom row's buttons and the tool dropdown.
//
// `flex:1` with `min-width:0` lets the five controls divide the row evenly and
// shrink together rather than the last one wrapping. 44px minimum, like
// everything else a finger has to hit.
const TOUCH_CONTROL_CSS =
  'flex:1;min-width:0;min-height:44px;padding:6px 8px;' +
  'background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.14);' +
  'border-radius:8px;color:#e8e8ea;font:12px system-ui,sans-serif;' +
  'cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';

// The context hint, as a second row in the same container.
//
// `pointer-events:auto` because the root turns them off (see ROOT_CSS) and the
// stepper has to be clickable. DIMMER THAN THE BAR'S OWN LABELS: this is
// instructional text that is always on screen, so it should read as available
// rather than compete with the controls above it.
// `flex-wrap:nowrap` is explicit rather than relying on the default: this row
// mixes long text with a three-part control, and the whole failure mode here is
// things wrapping when they are asked to fit in too little space.
const HINT_CSS =
  'display:flex;align-items:center;gap:6px;flex-wrap:nowrap;pointer-events:auto;' +
  'background:rgba(28,28,30,0.92);border:1px solid rgba(255,255,255,0.12);' +
  'border-radius:6px;padding:5px 12px;box-shadow:0 4px 16px rgba(0,0,0,0.45);' +
  'font:11px system-ui,sans-serif;color:#a8a8ad;white-space:nowrap;' +
  'user-select:none;max-width:96vw;overflow:hidden;';

// The two text spans, which ARE allowed to shrink -- something has to when the
// row runs out of room, and losing the tail of a sentence to `overflow:hidden`
// is better than deforming the control the sentence is about.
const HINT_TEXT_CSS = 'min-width:0;overflow:hidden;text-overflow:ellipsis;';

// `‹ [n] ›`, tight enough to read as one control rather than three.
//
// **`flex:none` IS LOAD-BEARING, NOT TIDINESS.** The hint row is a flex
// container and its items shrink by default, so the two long text spans either
// side squeezed this below the width of its own contents -- at which point its
// three children wrapped and the arrows stacked VERTICALLY above and below the
// field instead of sitting either side of it. `flex-wrap` is not the fix
// (nothing here should ever wrap); refusing to shrink is.
const STEPPER_CSS =
  'display:inline-flex;align-items:center;gap:2px;flex:none;';

// Square and small: these sit inside a line of 11px text, so anything with the
// bar buttons' padding would set the row's height on its own.
const STEP_BUTTON_CSS =
  'background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.14);' +
  'border-radius:3px;color:#e8e8ea;font:12px system-ui,sans-serif;line-height:1;' +
  'padding:0;width:16px;height:16px;cursor:pointer;display:flex;' +
  'align-items:center;justify-content:center;flex:none;';

// Wide enough for the two digits a 64-cohort maximum needs, and centred so the
// number does not shift as it gains one.
const COHORT_INPUT_CSS =
  'background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.14);' +
  'border-radius:3px;color:#e8e8ea;font:11px ui-monospace,monospace;' +
  'width:2.6em;height:16px;padding:0 2px;text-align:center;box-sizing:border-box;';

// Wide enough to be worth having left the pane for, capped so it does not run
// under either panel on a narrow window.
// The slider's width, as ONE expression used by both the slider and the
// sentinel-state button that replaces its group. Written down once because
// `REROLL_ALL_CSS` adds a measured constant to it -- two copies of the term
// would let the two states' bar widths drift apart silently, which is the jump
// `LABEL_EXTRA_PX` exists to cancel.
//
// 20% narrower than the original `min(46vw,420px)`, to make room for the Reset
// button and the gear. Both terms scale together, so the cap and the viewport
// fraction still describe the same slider at every window width.
const SLIDER_WIDTH = 'min(36.8vw,336px)';

const SLIDER_CSS = `width:${SLIDER_WIDTH};accent-color:#8ab4f8;cursor:pointer;`;

// Tabular numerals and a fixed width, so the bar does not reflow as digits
// change under a drag.
const READOUT_CSS =
  'font:12px ui-monospace,monospace;color:#e8e8ea;width:3.2em;text-align:right;' +
  'font-variant-numeric:tabular-nums;user-select:none;';

const BUTTON_CSS =
  'background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.14);' +
  'border-radius:4px;color:#e8e8ea;font:11px system-ui,sans-serif;' +
  'padding:5px 10px;cursor:pointer;white-space:nowrap;';

// The sentinel-state stand-in for the slider.
//
// **THE WIDTH REPLACES A GROUP, NOT ONE CONTROL, and that is the whole point.**
// The bar is centred with `transform:translateX(-50%)`, so a bar that changed
// width would shift BOTH its edges -- every remaining control would slide out
// from under the pointer at the instant the state flipped. Matching only
// `SLIDER_CSS` was not enough: the label and readout vanish too, and with them
// two of the bar's 10px gaps, which measured as a 430px jump.
//
// So this is the slider's width PLUS what the label, the readout and TWO OF THE
// BAR'S 10px GAPS contribute -- three items collapsing to one takes the gaps
// between them with it, which is a third of this number and the part that is
// easiest to forget.
//
// `LABEL_EXTRA_PX` was MEASURED, not derived: the two states' bar widths, at
// viewports 1280 and 900, adjusted until the delta reached 0. Only the fixed
// part needs measuring -- the slider's own width term is common to both states
// and CANCELS, which is why one constant holds at both widths, and why
// narrowing the slider did not require re-measuring it. A font change or a
// relabelled Mutation Scale is what would invalidate it.
const LABEL_EXTRA_PX = 141;

// `SLIDER_WIDTH`, not a second copy of the expression: the cancellation above
// only holds while the two states agree about the slider's width to the pixel.
const REROLL_ALL_CSS =
  `${BUTTON_CSS}width:calc(${SLIDER_WIDTH} + ${String(LABEL_EXTRA_PX)}px);` +
  'text-align:center;';

// The three population presets, grouped so the gap between them is tighter than
// the bar's own 10px -- they are one control, not three neighbours.
const PRESETS_CSS = 'display:flex;align-items:center;gap:3px;';

/** The icon's viewBox and its rendered size. Square, so one constant. */
const ICON_BOX = 16;

// Square, and sized from the icon rather than from the text metrics every other
// button here uses: `padding:0` plus an explicit box is what keeps all three the
// same size regardless of how many dots are in them.
const LAYOUT_BUTTON_CSS =
  'background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.14);' +
  'border-radius:4px;color:#e8e8ea;padding:0;cursor:pointer;' +
  'display:flex;align-items:center;justify-content:center;' +
  'width:24px;height:24px;flex:none;';

/**
 * The two states of the population group's icons.
 *
 * Gold means "this is what is running" -- the active layout preset, and fences
 * when they are holding. White is the resting state every other icon on this bar
 * uses, so the gold reads as a departure from it rather than as its own scheme.
 *
 * NEVER THE ONLY SIGNAL. The fences icon also changes from dashed to solid, and
 * every button states its condition in `title` and `aria-label`, so the group is
 * readable in a screenshot and without colour vision.
 */
const ACTIVE_GOLD = '#e8c14a';
const IDLE_WHITE = '#e8e8ea';

// The rule between the layout presets and Cohort Fences. See its construction:
// the three to the left SET a population, the one to the right TOGGLES a
// property of it, and the divider is what stops the fourth reading as a preset.
const DIVIDER_CSS =
  'width:1px;height:16px;flex:none;margin:0 2px;' +
  'background:rgba(255,255,255,0.22);';

// The gear, at the right end of the bar.
//
// NOT `LAYOUT_BUTTON_CSS`: this one carries a key caption beside its icon, so it
// cannot be a fixed 24px square. Text padding like `BUTTON_CSS`, an icon-sized
// gap, and `height:24px` so it lines up with the layout buttons at the far end
// of the same row rather than making the bar taller than they do.
const GEAR_BUTTON_CSS =
  'background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.14);' +
  'border-radius:4px;color:#e8e8ea;cursor:pointer;padding:0 8px;height:24px;' +
  'display:flex;align-items:center;gap:5px;flex:none;';

// The commit button on the hint row.
//
// Sized to the hint's 11px text rather than to the bar's buttons above: it sits
// INSIDE a line of prose and has to read as part of that sentence, not as a
// control that wandered down from the row above. Gold-tinted because it commits
// the thing the gold ring and the gold layout dots are already about -- the
// active cohort -- so the colour is a continuation rather than a new vocabulary.
const COMMIT_BUTTON_CSS =
  'display:none;align-items:center;margin:0 6px;padding:2px 8px;' +
  'background:rgba(232,193,74,0.14);border:1px solid rgba(232,193,74,0.45);' +
  'border-radius:4px;color:#e8c14a;cursor:pointer;' +
  'font:11px system-ui,sans-serif;white-space:nowrap;';

// Clear All Barriers, on the hint row under the Draw tool.
//
// **THE COMMIT BUTTON'S SHAPE, IN THE COMMIT BUTTON'S PLACE.** Same 11px text,
// same padding, same radius, same `flex:none` -- because it is the same KIND of
// thing: the one action the current tool's hint row offers, sized to sit inside
// a line of prose rather than to match the bar's controls above. Sharing the
// geometry is what makes the two read as one affordance that changes with the
// tool, rather than as two unrelated buttons that happen to live nearby.
//
// **THE COLOUR IS THE ONE DELIBERATE DIFFERENCE.** Gold on the commit button
// means "the active cohort", continuing the gold of the layout dots and the
// fence ring. That vocabulary has nothing to say about erasing a field, and
// borrowing it would imply a connection to the cohort selection that does not
// exist. Red is the app's existing destructive tint -- `DELETE_BUTTON_CSS` in
// `menuBar.ts` uses `#d06060` for the X that destroys a stored config, and this
// is the same family, mixed the way the commit button mixes its gold: a low
// alpha fill, a stronger border, and the full colour on the text.
//
// NEVER THE ONLY SIGNAL, the same rule the population group follows: the label
// says "(Can't undo)" in words, so the warning survives without colour vision
// and in a screenshot.
//
// `flex:none` IS LOAD-BEARING here exactly as it is on the stepper. The hint row
// is a flex container whose text spans are allowed to shrink; without this the
// button would be squeezed below its own content and its label would wrap
// mid-sentence.
const CLEAR_FIELD_BUTTON_CSS =
  'display:none;align-items:center;margin:0 6px;padding:2px 8px;flex:none;' +
  'background:rgba(208,96,96,0.14);border:1px solid rgba(208,96,96,0.45);' +
  'border-radius:4px;color:#d06060;cursor:pointer;' +
  'font:11px system-ui,sans-serif;white-space:nowrap;';

// Cancel Selection, on the hint row under the Select tool.
//
// **THE SAME CSS AS CLEAR ALL BARRIERS, and shared rather than copied.** Both
// are the red, backing-out action of their tool's hint row -- one throws away an
// aim, the other throws away a field -- so they are the same kind of thing and
// the geometry argument `CLEAR_FIELD_BUTTON_CSS` makes above applies unchanged.
// Aliasing means a tweak to one cannot leave the other behind; if they ever need
// to diverge, that is the moment to write a second string rather than now.
//
// RED RATHER THAN GOLD, for the reason the clear button gives: gold on this row
// means "the active cohort" and is what the commit button beside it uses. This
// button ENDS that selection, so wearing the selection's own colour would be
// precisely backwards.
//
// The colour is not the only signal here either: the label says "Cancel
// selection" in words, and names the right-click that does the same thing.
const CANCEL_SELECTION_BUTTON_CSS = CLEAR_FIELD_BUTTON_CSS;

// Undo, on the hint row under the Select tool with nothing lit.
//
// **THE SAME RED AGAIN, ALIASED FOR THE SAME REASON.** It is the third of the
// row's backing-out actions -- throw away a field, throw away an aim, take back
// the last act -- and sharing the string is what keeps a tweak to one from
// leaving the others behind. It never co-occurs with either (see `hintFor`), so
// the shared colour is never two red buttons competing on one row.
//
// The colour is not the only signal: the label says "Undo" and names what would
// be taken back, so it survives a screenshot and a colour-blind reader alike.
const UNDO_BUTTON_CSS = CLEAR_FIELD_BUTTON_CSS;

// =========================================================================
// TOUCH: the two big hint-row buttons
// =========================================================================
//
// **44px MINIMUM, WHICH IS WHY THESE ARE NOT THE DESKTOP STRINGS.** The buttons
// above are sized to sit inside a line of prose -- 11px text, 2px of vertical
// padding, about 22px tall -- which a mouse hits precisely and a fingertip does
// not. 44px is the smallest target that is reliably hit without looking, and
// these two are the controls a touch session presses most: one commits a
// selection, the other undoes or cancels. A mis-tap between them is expensive
// in both directions.
//
// SHARED GEOMETRY, DIFFERING ONLY IN COLOUR, for the reason the desktop's three
// red buttons share a string: they are a matched pair and must stay one.
// `flex:1` rather than `flex:none` is the other departure -- on a phone the row
// has width to give and two buttons that fill it are easier to hit than two that
// shrink-wrap their labels.
const TOUCH_BUTTON_BASE_CSS =
  'display:none;align-items:center;justify-content:center;' +
  'min-height:44px;padding:8px 12px;margin:0 4px;flex:1;' +
  'border-radius:8px;cursor:pointer;font:13px system-ui,sans-serif;' +
  'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';

// RED, and the same red the desktop's backing-out buttons wear -- this is the
// touch layout's single replacement for all three of them, so it inherits their
// colour rather than introducing a fourth meaning. See `contextButton`.
const TOUCH_ACTION_BUTTON_CSS =
  `${TOUCH_BUTTON_BASE_CSS}` +
  'background:rgba(208,96,96,0.16);border:1px solid rgba(208,96,96,0.5);' +
  'color:#d06060;';

// GOLD, matching the desktop commit button it enlarges. Gold on this row means
// "the active cohort", which is exactly what this button acts on.
const TOUCH_COMMIT_BUTTON_CSS =
  `${TOUCH_BUTTON_BASE_CSS}` +
  'background:rgba(232,193,74,0.16);border:1px solid rgba(232,193,74,0.5);' +
  'color:#e8c14a;';

// The `(X)` beside an icon. Dimmed and a size down, so the glyph stays the thing
// you see first and the shortcut sits behind it.
const KEY_CAPTION_CSS =
  'font:10px system-ui,sans-serif;color:rgba(232,232,234,0.6);white-space:nowrap;';

// The tool dropdown, matching the bar it sits in.
//
// **THIS WAS DELIBERATELY LIGHT ONCE, AND THE REASON IT CHANGED MATTERS.** An
// earlier attempt styled it dark and leaned on `color-scheme:dark` to carry that
// into the option list. The popup is drawn by the platform, `color-scheme` is a
// HINT, and where it was ignored the list opened white while KEEPING the pale
// text it had been given -- unreadable. Going light was the safe retreat: black
// on white is legible whichever way the popup resolves.
//
// The retreat is no longer necessary, because the failure it avoided came from
// setting only ONE end. Every option below states an OPAQUE dark background and
// a light colour of its own (see the `<option>` loop), so a popup that ignores
// `color-scheme` still paints the rows from those declarations rather than
// falling back to a white sheet under pale text. The hint is stated as well, for
// the platforms that do honour it -- but nothing depends on it now.
//
// The cost of the light version was that the one control in the middle of a dark
// bar looked like a foreign object, which is what this fixes. The background is
// OPAQUE rather than the `rgba(255,255,255,0.10)` the buttons use: a translucent
// closed select shows the canvas through it, and the open list has to be opaque
// regardless, so matching them keeps the two states the same colour.
const TOOL_CSS =
  'background:#2c2c2e;border:1px solid rgba(255,255,255,0.14);' +
  'border-radius:4px;color:#e8e8ea;font:11px system-ui,sans-serif;' +
  'padding:5px 8px;cursor:pointer;color-scheme:dark;';

/**
 * One row of the tool dropdown's popup.
 *
 * OPAQUE, and stating both ends. See `TOOL_CSS`: the option list is drawn by the
 * platform and does not reliably inherit the select's colours, so each row has
 * to name its own background AND its own text. Naming only one is what produced
 * the pale-on-white failure that sent this control light in the first place.
 */
const TOOL_OPTION_CSS = 'background:#2c2c2e;color:#e8e8ea;';

/**
 * The tool dropdown at finger size.
 *
 * **BUILT ON `TOOL_CSS` RATHER THAN ON `TOUCH_CONTROL_CSS`**, which is the one
 * departure from how every other touch control here is styled -- and it is
 * deliberate. `TOOL_CSS` carries `background:#2c2c2e` and `color-scheme:dark`
 * for a reason the comment above records at length: the option list is drawn by
 * the PLATFORM, does not reliably inherit, and styling it wrong once already
 * produced pale-on-white text. Starting from the generic control string would
 * drop both and reopen exactly that bug.
 *
 * So this keeps the colours and overrides only the geometry. The later
 * declarations win, this being a single `cssText`.
 */
const TOUCH_TOOL_CSS =
  `${TOOL_CSS}flex:1;min-width:0;min-height:44px;` +
  'border-radius:8px;font:12px system-ui,sans-serif;padding:6px 8px;';
