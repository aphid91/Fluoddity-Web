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
  /**
   * Exponent bending the slider's TRAVEL, as `settingsSpec`'s `curve` does.
   *
   *     value = lo + (hi - lo) * pos**curve
   *
   * Above 1 spends most of the handle's travel near `lo`. Requires `min` and
   * `max` in `params`, since those are the bounds the curve is taken over.
   *
   * **Only the POSITION curves; the value never does.** What is dispatched,
   * stored and shown in the readout is the real number, so adding or retuning a
   * curve cannot change what any brush setting means.
   */
  readonly curve?: number;
}

const CONTROLS: readonly DrawControl[] = [
  {
    field: 'drawSize',
    label: 'Brush Size',
    params: { min: 0.001, max: .25 },
    help: 'Determines the radius of the brush reticle',
    // **CURVED, for the reason Hazard Rate is** (`settingsSpec.ts`): the useful
    // range is crammed against the bottom of the bounds. Most drawing happens
    // between 0.001 and 0.02, which is the first 7.6% of a LINEAR slider -- three
    // or four pixels of travel, where a one-pixel slip is a doubling.
    //
    // At 2.5 that band spans ~36% of the handle instead, so the sizes actually
    // used get about a third of the slider and the large end stays reachable.
    // Tuned against the bounds above: `min` and `max` are what the curve is taken
    // over, so re-check where 0.02 lands if either moves.
    curve: 2.5,
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
    field: 'brushMode',
    label: 'Brush Mode',
    // A tweakpane `options` binding over the INDEX, matching how `brushMode` is
    // stored -- see the preference. The labels are the user's vocabulary; the
    // values are `BRUSH_MODES`' order.
    params: {
      options: {
        'Out / Diverge': 0,
        'In / Converge': 1,
        Stroke: 2,
        Fixed: 3,
      },
    },
    help:
      'Which way a stroke pushes. Out/Diverge and In/Converge push away from ' +
      'and toward the stroke; Stroke pushes along the direction you drag; ' +
      'Fixed pushes one way everywhere, set by Draw Angle',
    advanced: true,
  },
  {
    field: 'drawAngle',
    label: 'Draw Angle',
    // -PI..PI, so the two ends meet at straight down and the centre is up.
    params: { min: -Math.PI, max: Math.PI, step: 0.01 },
    help:
      'The direction the Fixed brush pushes. 0 is up. The arrow on the brush ' +
      'reticle turns with it',
    advanced: true,
  },
  {
    field: 'wallsStrength',
    label: 'Walls Field Strength',
    params: { min: 0.0, max: 4.0 },
    help:
      'Scales how hard the painted walls push, applied as they are read rather ' +
      'than as they are drawn -- so it retunes walls you painted earlier, and 0 ' +
      'mutes them without erasing them',
    advanced: true,
  },
  {
    field: 'trailsStrength',
    label: 'Trails Field Strength',
    params: { min: 0.0, max: 4.0 },
    help:
      'Scales how strongly the painted trails register on particle sensors. ' +
      'Like Walls Field Strength, it applies at read time, so a drawn pattern ' +
      'can be tuned or muted without redrawing it',
    advanced: true,
  },
  {
    field: 'fieldOpacity',
    label: 'Field Opacity',
    params: { min: 0.0, max: 1.0 },
    help: 'How strongly the painted walls and trails are drawn on screen',
    advanced: true,
  },
  {
    field: 'fieldAlwaysShow',
    label: 'Always Show Walls',
    params: {},
    help:
      'Keep the painted walls visible in every tool, including Trails. The ' +
      'Walls tool shows them either way',
    advanced: true,
  },
  {
    field: 'trailsAlwaysShow',
    label: 'Always Show Trails',
    params: {},
    help:
      'Keep the painted trails visible in every tool, including Walls. The ' +
      'Trails tool shows them either way',
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
  /** Refreshers for the curved sliders, which hold a position rather than a value. */
  const curvedRefreshers: ((status: Status) => void)[] = [];
  /** Teardowns for anything that outlives the folder. See `SectionHandle.dispose`. */
  const teardowns: (() => void)[] = [];

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

    if (control.curve !== undefined) {
      curved(folder, control, asNumber(initial), curvedRefreshers, teardowns, ctx);
      continue;
    }

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

  // TWO BUTTONS, ONE PER LAYER. Not undoable, and both say so: the field is
  // live-only state that never survives a restart either, and History is a
  // timeline of Projects.
  //
  // Both are offered here regardless of the active tool, unlike the hint bar's
  // single contextual button. The panel is where you address the drawing system
  // as a whole -- clearing the walls you painted five minutes ago while the
  // Trails tool is selected is a reasonable thing to want, and switching tools
  // just to reach a button would not be.
  for (const [layer, title, body] of [
    ['walls', 'Clear Walls (not undoable)', 'Remove all currently painted barriers'],
    ['trails', 'Clear Trails (not undoable)', 'Remove all currently painted trails'],
  ] as const) {
    const clear = folder.addButton({ title });
    clear.on('click', () => {
      ctx.send({ kind: 'clearStrafeField', layer });
    });
    ctx.tooltip.attach(clear.element as HTMLElement, { title, body });
  }

  return {
    bindings: [],
    // The panel rebuilds this section on every Advanced toggle, and the Brush
    // Size slider watches the WINDOW for the end of a drag -- so without this,
    // each rebuild would leave a live listener set behind, every one of them
    // still writing the preview flag. Recording Controls carries the same
    // hazard and the same answer.
    dispose: () => {
      for (const teardown of teardowns) teardown();
    },
    refresh: (s) => {
      for (const [field, proxy] of proxies) {
        const authoritative = s.editPrefs[field];
        if (authoritative !== undefined) proxy.value = authoritative;
      }
      // Curved controls hold a POSITION, not a value, so they cannot be written
      // from the same loop -- see `curved`.
      for (const refreshOne of curvedRefreshers) refreshOne(s);
    },
  };
}

/** Coerce a preference to a number; booleans never reach a curved slider. */
function asNumber(value: number | boolean): number {
  return typeof value === 'number' ? value : 0;
}

/** Where `value` sits along a curved travel, as 0..1. Clamped. */
function curvePosition(value: number, lo: number, hi: number, curve: number): number {
  const span = hi - lo;
  if (span === 0) return 0;
  const norm = Math.min(1, Math.max(0, (value - lo) / span));
  return norm ** (1 / curve);
}

/** Inverse of `curvePosition`: the value at 0..1 along the travel. */
function curveValueAt(pos: number, lo: number, hi: number, curve: number): number {
  const clamped = Math.min(1, Math.max(0, pos));
  return lo + (hi - lo) * clamped ** curve;
}

/**
 * A brush slider whose travel is bent.
 *
 * **The widget is driven in 0..1 POSITION space and the real value is mapped in
 * and out around it** -- the same trick `addMapped` plays in `controls.ts`, for
 * the same reason: Tweakpane has no power-scaled slider. This is a second, much
 * smaller implementation rather than a call into that one because `addMapped`
 * takes a registry `Setting` and dispatches `editSetting`; these are draw prefs
 * rendered directly and dispatch `editDrawPref`. Fabricating a `Setting` to
 * satisfy that signature is exactly what this section's header rules out.
 *
 * The readout is written into the slider's OWN number box rather than a second
 * blade, so a curved row's number sits where every other row's number sits. A
 * Tweakpane slider bound to 0..1 would otherwise print "0.46" where the user
 * needs "0.008".
 */
function curved(
  folder: FolderApi,
  control: DrawControl,
  initial: number,
  /**
   * Where this control's own refresher is registered.
   *
   * **Passed in, NOT a module-level array.** The panel is rebuilt whenever the
   * Advanced tier toggles, and a module-scoped list would accumulate a closure
   * per rebuild -- each writing into a blade that has already been torn down.
   * Owned by the section call, so it dies with the section.
   */
  refreshers: ((status: Status) => void)[],
  /** Where this control's window listeners register their removal. See `dispose`. */
  teardowns: (() => void)[],
  ctx: SectionContext,
): void {
  const lo = control.params['min'] as number;
  const hi = control.params['max'] as number;
  const curve = control.curve ?? 1;

  const handle = { value: curvePosition(initial, lo, hi, curve) };
  // NOT in `proxies`: that map is refreshed by writing the raw preference into
  // `.value`, which for this control is a position. Registering here would make
  // every refresh slam the handle to a nonsense place.
  const blade = folder.addBinding(handle, 'value', {
    label: control.label,
    min: 0,
    max: 1,
    // No step: it would quantize the POSITION, which on a bent curve is a wildly
    // uneven quantization of the value.
  });
  (blade.element as HTMLElement).dataset['setting'] = `prefs.${control.field}`;
  ctx.tooltip.attach(blade.element as HTMLElement, {
    title: control.label,
    body: control.help,
  });

  // Enough places to distinguish the bottom of the range, where this control
  // spends most of its travel: 0.001 and 0.002 must not both read "0.00".
  const format = (v: number): string => v.toFixed(4);

  const box = (blade.element as HTMLElement).querySelector('input');
  if (box !== null) {
    box.readOnly = true;
    box.value = format(initial);
  }
  const writeReadout = (value: number): void => {
    if (box !== null) box.value = format(value);
  };

  /**
   * Show a centred brush reticle for as long as this slider is being dragged.
   *
   * **BRUSH SIZE ONLY**, which is why it is gated on the field rather than
   * applied to every curved control: the reticle IS the brush's size drawn at
   * scale, so it reports what this slider does and nothing else. Brush Power
   * shares this helper and has no such picture -- a ring that sat there
   * unchanged while its number moved would be a worse answer than no ring.
   */
  const previewing = control.field === 'drawSize' ? ctx.setBrushSizePreview : undefined;
  let shown = false;

  function showPreview(on: boolean): void {
    // Guarded so a settled slider does not re-report a state it is already in:
    // `change` fires per pointermove, and this runs on every one of them.
    if (previewing === undefined || shown === on) return;
    shown = on;
    previewing(on);
  }

  blade.on('change', (ev) => {
    if (ctx.isRefreshing()) return;
    const value = curveValueAt(ev.value as number, lo, hi, curve);
    writeReadout(value);
    ctx.send({ kind: 'editDrawPref', field: control.field, value });

    // **`ev.last` IS THE RELEASE SIGNAL, NOT A DOM `pointerup`** -- the same
    // discriminator `addMapped` in `controls.ts` relies on, and for the same
    // reason its comment spells out. Tweakpane emits `last: false` from
    // `onPointerMove_` and `last: true` from `onPointerUp_`.
    //
    // A capturing `pointerup` on the WINDOW looked equivalent and was not, in a
    // way that produced exactly the stuck ring this replaced: the slider calls
    // `setPointerCapture`, so the release is retargeted to the blade and the
    // capture-phase window listener sees it on the way DOWN -- strictly before
    // Tweakpane turns it into the final `change`. The flag was cleared and then
    // immediately re-armed by that last event, leaving the reticle up until some
    // unrelated later click or keyup happened to clear it again.
    //
    // Driving BOTH edges from this one event is what keeps them ordered: the
    // arm and the release are now the same stream, so no ordering between two
    // different event sources can put them the wrong way round.
    showPreview(!ev.last);
  });

  if (previewing !== undefined) {
    const element = blade.element as HTMLElement;
    // The two gestures `change` cannot see the end of, exactly as `addMapped`
    // guards its gate hold: one the OS interrupted, and one that finished on
    // the value it started from -- `setRawValue` returns early when nothing
    // moved, so no final `last: true` ever arrives. Either would strand the
    // ring on screen.
    //
    // ON THE BLADE rather than the window, and that is safe HERE precisely
    // because of the pointer capture described above: the release is retargeted
    // to this element, so a drag that ends far away over the canvas still
    // arrives. These only ever clear, so an extra call is harmless.
    const release = (): void => {
      showPreview(false);
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('lostpointercapture', release);
    // The keyboard half: the slider is focusable and the arrow keys step it,
    // producing `change` with no pointer and so no `last: true` to end it.
    element.addEventListener('keyup', release);
    element.addEventListener('blur', release, true);

    teardowns.push(() => {
      element.removeEventListener('pointerup', release);
      element.removeEventListener('lostpointercapture', release);
      element.removeEventListener('keyup', release);
      element.removeEventListener('blur', release, true);
      // **AND THE FLAG ITSELF IS CLEARED.** A rebuild mid-drag -- toggling
      // Advanced with the pointer still down -- would otherwise dispose the
      // only listeners that could ever put the reticle away, stranding it on
      // screen for the rest of the session.
      release();
    });
  }

  refreshers.push((s: Status) => {
    const authoritative = s.editPrefs[control.field];
    if (authoritative === undefined) return;
    const value = asNumber(authoritative);
    handle.value = curvePosition(value, lo, hi, curve);
    writeReadout(value);
  });
}
