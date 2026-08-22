/**
 * Drawing Controls: the brush settings for the Draw and Shove tools.
 *
 * The port of `ui/drawing_window.py`. **Rendered directly rather than through
 * the settings registry**, and that is deliberate on both sides: "the registry
 * exists to drive the Project and Preferences windows, where dozens of controls
 * need consistent tiering, grouping and tooltips; three widgets in a dedicated
 * window are not that shape, and routing them through it would mean fabricating
 * `Setting` objects to satisfy a signature" (`drawing_window.py:4-8`).
 *
 * These values are PREFS -- editor state. They persist to `localStorage` so your
 * brush survives a reload, but never into a config and never into history.
 *
 * ## Why the values are indexed, not defaulted
 *
 * `status.editPrefs` is the whole preference record, so it carries every field.
 * Restating a default here would mean a changed default silently disagreeing
 * with the slider (`drawing_window.py:32-39`). A missing key is a bug worth
 * seeing, not worth papering over -- but the payload is legitimately EMPTY while
 * the panel is closed (`settingsSources`'s optimization), so the read is
 * defensive about that one case and only that one.
 */

import type { FolderApi } from 'tweakpane';
import type { DrawPrefField, Status } from '../../orchestrator/commands.ts';
import { addAdvancedToggle } from '../advancedToggle.ts';
import { type SectionContext, type SectionHandle } from './section.ts';

/**
 * One brush control: label, field, bounds, and whether it is Advanced.
 *
 * `advanced` is a plain flag rather than a `Setting.tier`, for the same reason
 * the rest of this table is not a registry entry: five widgets in a dedicated
 * section are not the registry's shape. The Basic pair is what you reach for
 * mid-stroke -- how big the brush is and how hard it pushes; the rest is how
 * the field is DISPLAYED, which is a setup decision rather than a drawing one.
 */
interface DrawControl {
  readonly field: DrawPrefField;
  readonly label: string;
  readonly params: Record<string, unknown>;
  readonly help: string;
  readonly advanced?: boolean;
}

const CONTROLS: readonly DrawControl[] = [
  {
    field: 'drawSize',
    label: 'Brush Size',
    params: { min: 0.01, max: .25 },
    help: 'Determines the radius of the brush reticle',
  },
  {
    field: 'drawPower',
    label: 'Brush Power',
    params: { min: 0.1, max: 5.0 },
    help:
      'Determines the strength of the position offsets applied by shoving and ' +
      'drawn barriers',
  },
  {
    field: 'fieldOpacity',
    label: 'Field Opacity',
    params: { min: 0.0, max: 1.0 },
    help: 'Allows you to see the currently painted barriers',
    advanced: true,
  },
  {
    field: 'fieldAlwaysShow',
    label: 'Always Show Field',
    params: {},
    help: 'Allows you to see the current barriers when not in draw-mode',
    advanced: true,
  },
  // **BRUSH RETICLE WAS REMOVED FROM THIS TABLE**, and the `showReticle`
  // preference no longer has a control anywhere. In practice the reticle is
  // wanted in every session -- it is the only thing that shows where the brush
  // will land and how big it is -- so the checkbox was a way to break the brush
  // tools and nothing else.
  //
  // The FIELD survives in `Preferences` rather than being deleted, because a
  // stored `false` in someone's `localStorage` must not become a parse error on
  // their next visit (`prefs/preferences.ts` validates against its schema). The
  // Orchestrator now ignores it -- see `applyCanvasInput`'s reticle branch.
];

export function buildDrawingSection(
  folder: FolderApi,
  status: Status,
  ctx: SectionContext,
): SectionHandle {
  const proxies = new Map<DrawPrefField, { value: number | boolean }>();

  // FIRST, above the controls it governs. See `projectSection.ts`.
  addAdvancedToggle(folder, 'advancedDrawing', ctx);

  // `advancedFor`, NOT `ctx.advanced`. This section shares a panel -- and
  // therefore a context -- with Preferences, whose tier is what got baked in.
  // Reading that here would make one checkbox drive both tabs, which is the
  // global tier this change exists to get rid of. See `section.ts`.
  const advanced = ctx.advancedFor('advancedDrawing');

  for (const control of CONTROLS) {
    // Not built at all, rather than built and hidden -- the same thing
    // `grouped()` does for a registry group whose members are all Advanced.
    if (control.advanced === true && !advanced) continue;

    const initial = status.editPrefs[control.field] ?? 0;
    const proxy = { value: initial };
    proxies.set(control.field, proxy);

    const blade = folder.addBinding(proxy, 'value', {
      label: control.label,
      ...control.params,
    });
    (blade.element as HTMLElement).dataset['setting'] = `prefs.${control.field}`;
    ctx.tooltip.attach(blade.element as HTMLElement, {
      title: control.label,
      body: control.help,
    });

    blade.on('change', (ev) => {
      if (ctx.isRefreshing()) return;
      ctx.send({
        kind: 'editDrawPref',
        field: control.field,
        value: ev.value as number | boolean,
      });
    });
  }

  // Not undoable, and the button says so: the field is live-only state that
  // never survives a restart either, and History is a timeline of Projects.
  const clear = folder.addButton({ title: 'Clear Field (not undoable)' });
  clear.on('click', () => {
    ctx.send({ kind: 'clearStrafeField' });
  });
  ctx.tooltip.attach(clear.element as HTMLElement, {
    title: 'Clear Field',
    body: 'Remove all currently painted barriers',
  });

  return {
    bindings: [],
    refresh: (s) => {
      for (const [field, proxy] of proxies) {
        const authoritative = s.editPrefs[field];
        if (authoritative !== undefined) proxy.value = authoritative;
      }
    },
  };
}
