/**
 * Project Link Settings: what a copied share link should carry.
 *
 * Rendered directly rather than through the settings registry, for the reason
 * `recordingSection.ts` gives -- these are not `Preferences` and there is no
 * `editPrefs` payload to bind against. Like that section it owns its own state,
 * and for a stronger version of the same reason: these choices describe a link
 * that does not exist yet, so there is nothing in the Orchestrator for them to
 * be a view onto.
 *
 * ## EVERY ROW IS A CHECKBOX, AND THAT IS THE POINT
 *
 * A ticked box means "match what I have open right now", resolved at COPY time
 * rather than at tick time (`buildLinkQuery`). That is what makes this tab
 * safe to leave ticked: a user who ticks World Size, spends an hour editing,
 * and then copies gets the world size they ended with, not the one they had
 * when they ticked.
 *
 * Offering value inputs here was the obvious alternative and is worse in three
 * ways: it duplicates numbers that already exist in Preferences, it lets the
 * two drift, and it asks the user to type a world size rather than to set one
 * with the control built for it. The single exception is the project name,
 * which is a text field because there is no current value to match -- a name
 * for the recipient is genuinely new information.
 *
 * ## The divider is a promise about consent
 *
 * The rows above it go through the recipient's confirmation dialog; the rows
 * below just happen on open. That is a real difference in what the sender is
 * doing to someone else, so it gets a rule and a heading rather than a footnote
 * -- see `urlOptions.ts` on why the settings are a proposal at all.
 */

import type { FolderApi } from 'tweakpane';
import type { Status } from '../../orchestrator/commands.ts';
import {
  type LinkSettings,
  type SplashVariant,
  loadLinkSettings,
  saveLinkSettings,
} from '../../config/urlOptions.ts';
import { type SectionContext, type SectionHandle } from './section.ts';

/** What the tab reports upward. */
export interface LinkSectionOptions {
  /** Copy a link built from these choices. The panel owns the clipboard. */
  readonly onCopyLink: () => void;
}

export interface LinkSectionHandle extends SectionHandle {
  readonly settings: () => LinkSettings;
}

/** The four preference rows, with the label each one shows. */
const PROMPTED_ROWS = [
  ['worldSize', 'Match World Size'],
  ['canvasAspect', 'Match Canvas Aspect'],
  ['brightness', 'Match Brightness'],
  ['tonemapSoftness', 'Match Tonemap Softness'],
  ['trailMap', 'Match Trail Map View'],
] as const satisfies readonly (readonly [keyof LinkSettings, string])[];

/** The splash choices, as a dropdown of "none" plus the three documents. */
const SPLASH_OPTIONS: Record<string, string> = {
  'None': '',
  'Welcome': 'welcome',
  'Guide': 'guide',
  'Controls': 'controls',
};

export function buildLinkSection(
  folder: FolderApi,
  _status: Status,
  ctx: SectionContext,
  opts: LinkSectionOptions,
): LinkSectionHandle {
  let settings = loadLinkSettings();

  const persist = (): void => {
    saveLinkSettings(settings);
  };

  // --- the prompted rows ----------------------------------------------------
  //
  // Built FIRST so the prose can be anchored against real blades -- see
  // `noteBefore` on why appending to the folder does not work. The first one is
  // kept so the explanation can go above it.
  let firstRow: HTMLElement | null = null;
  for (const [key, label] of PROMPTED_ROWS) {
    const proxy = { value: settings[key] };
    const blade = folder.addBinding(proxy, 'value', { label });
    (blade.element as HTMLElement).dataset['setting'] = `link.${key}`;
    firstRow ??= blade.element as HTMLElement;
    ctx.tooltip.attach(blade.element as HTMLElement, {
      title: label,
      body:
        `Include your current ${label.replace('Match ', '').toLowerCase()} in ` +
        `the link. The recipient is asked before it is applied.`,
    });
    blade.on('change', (ev) => {
      if (ctx.isRefreshing()) return;
      settings = Object.freeze({ ...settings, [key]: ev.value as boolean });
      persist();
    });
  }

  // --- the unprompted rows --------------------------------------------------
  //
  // A DROPDOWN, not three checkboxes: only one splash can be in front, so three
  // boxes would encode a state that cannot exist and would need a rule to
  // resolve. A single choice cannot be ambiguous.
  const splashProxy = { value: settings.splash ?? '' };
  const splashBlade = folder.addBinding(splashProxy, 'value', {
    label: 'Open Splash',
    options: SPLASH_OPTIONS,
  });
  (splashBlade.element as HTMLElement).dataset['setting'] = 'link.splash';
  ctx.tooltip.attach(splashBlade.element as HTMLElement, {
    title: 'Open Splash',
    body:
      'Open the link with this page in front. A first-time visitor always ' +
      'sees the welcome regardless.',
  });
  splashBlade.on('change', (ev) => {
    if (ctx.isRefreshing()) return;
    const value = ev.value as string;
    settings = Object.freeze({
      ...settings,
      splash: value === '' ? null : (value as SplashVariant),
    });
    persist();
  });

  const nameProxy = { value: settings.projectName };
  const nameBlade = folder.addBinding(nameProxy, 'value', { label: 'Project Name' });
  (nameBlade.element as HTMLElement).dataset['setting'] = 'link.projectName';
  ctx.tooltip.attach(nameBlade.element as HTMLElement, {
    title: 'Project Name',
    body:
      'What the recipient sees the project called. Leave empty for ' +
      '"Shared-" plus the name you have open.',
  });
  nameBlade.on('change', (ev) => {
    if (ctx.isRefreshing()) return;
    settings = Object.freeze({ ...settings, projectName: String(ev.value) });
    persist();
  });

  // --- copy -----------------------------------------------------------------
  //
  // The tab carries its own copy button as well as leaving Share > Copy Link
  // working, because this page is where someone decides what the link should
  // say -- and making them leave it to act on that decision would be a menu
  // trip in the middle of one task. Both routes build the identical URL.
  const copyButton = folder.addButton({ title: 'Copy Link to This Project' });
  (copyButton.element as HTMLElement).dataset['setting'] = 'link.copy';
  copyButton.on('click', () => {
    opts.onCopyLink();
  });

  // --- the prose, inserted last and positioned by anchor ---------------------
  //
  // LAST because both notes are placed relative to blades that have to exist
  // first, and inserting bottom-up keeps each anchor valid: the divider goes
  // above the splash row, and the intro above the very first checkbox.
  //
  // **THE DIVIDER IS A RULE AND A HEADING, not just a gap.** What separates the
  // two groups is whether the recipient gets a say -- the most consequential
  // fact on this page, and one that is invisible from the row labels alone.
  // The rule goes in first and the heading after it, both anchored on the
  // splash row itself -- each insertion lands directly above that row, so the
  // second one ends up between the rule and the row. Anchoring the rule on
  // `previousElementSibling` instead would depend on what Tweakpane happens to
  // have put there.
  const splashEl = splashBlade.element as HTMLElement;
  dividerBefore(splashEl);
  noteBefore(
    splashEl,
    'No user confirmation — these apply as soon as the link opens.',
    true,
  );

  // FIRST on the page, and deliberately before any control: a user who reads
  // nothing else should still learn that the ticks below are requests rather
  // than commands.
  if (firstRow !== null) {
    noteBefore(
      firstRow,
      'Recipients are prompted to adopt these settings, and can refuse any of ' +
        'them. Each box sends whatever you have set when you copy the link.',
    );
  }

  return {
    bindings: [],
    // NOTHING TO REFRESH. Every control here is its own source of truth -- the
    // values a link carries are read from the live state when it is built, not
    // mirrored into this tab first. See the header.
    refresh: () => {},
    settings: () => settings,
  };
}

/**
 * A line of explanatory prose, placed directly ABOVE a blade.
 *
 * **ANCHORED ON A BLADE RATHER THAN APPENDED TO THE FOLDER**, which is the
 * whole reason this takes an `anchor`. Tweakpane owns the folder element and
 * keeps its blades in a container inside it, so appending to the folder puts
 * prose after EVERY blade no matter when it is called -- which silently sinks
 * the heading and the divider to the bottom of the page. `recordingSection.ts`
 * anchors its own inserted rows the same way.
 */
function noteBefore(anchor: HTMLElement, text: string, emphasis = false): void {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText =
    'font-size:10px;line-height:1.45;padding:6px 8px;' +
    (emphasis ? 'opacity:0.8;font-weight:600;' : 'opacity:0.65;');
  anchor.parentElement?.insertBefore(el, anchor);
}

/** A hairline rule directly above a blade. See `noteBefore` on the anchoring. */
function dividerBefore(anchor: HTMLElement): void {
  const el = document.createElement('div');
  el.style.cssText =
    'height:1px;margin:10px 4px 4px;background:rgba(255,255,255,0.18);';
  anchor.parentElement?.insertBefore(el, anchor);
}
