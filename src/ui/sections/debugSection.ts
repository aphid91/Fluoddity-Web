/**
 * The Debug section: read-only rows proving the plumbing works.
 *
 * The port of `ui.py`'s `_debug_panel` (`:299-382`), which is deliberately "not
 * a physics editor" -- it "exists so the plumbing is verifiable by looking at
 * it."
 *
 * ## This does NOT replace `?debug`
 *
 * `main.ts`'s overlay carries frame timings and per-pipeline compile status, and
 * it renders **without Tweakpane in the loop** -- so a panel that failed to
 * build is still diagnosable (`main.ts:34-38`). Folding those rows in here would
 * destroy that property, which is worth more than the deduplication. The two
 * cover different halves: the overlay is about the FRAME, this is about the
 * SIMULATION's state.
 *
 * ## The input rows, and why they are worth their space
 *
 * `ui.py:320-329` calls them the point of the panel: "hover it and `capture`
 * flips to yes, while buttons/keys stop reaching the canvas." The capture rules
 * are the part of the input layer with no compile-time protection and three
 * deliberate asymmetries (`inputState.ts`), so a readout that shows what the
 * canvas actually received is the cheapest way to confirm them -- move the mouse
 * over the panel and watch `buttons` go quiet.
 *
 * These need `InputState`, which the panel does not otherwise hold. Passing it
 * is safe under invariant 10 for the same reason `PickResult` is: it is a plain
 * readonly value type with no methods and no GPU handles, so passing it is
 * passing data (`commands.ts:200-203`).
 */

import type { FolderApi } from 'tweakpane';
import type { Status } from '../../orchestrator/commands.ts';
import type { InputState } from '../inputState.ts';
import { type SectionContext, type SectionHandle } from './section.ts';

export function buildDebugSection(
  folder: FolderApi,
  _status: Status,
  _ctx: SectionContext,
): SectionHandle {
  const readout = {
    preset: '',
    project: '',
    // Strings, not numbers: a numeric monitor renders through Tweakpane's float
    // formatter, so a frame count reads "14340.00". These are counts.
    frame: '',
    entities: '',
    canvas: '',
    window: '',
    camera: '',
    zoom: '',
    pan: '',
    mouse: '',
    selected: '-',
    configs: '',
    checkpoints: '',
    history: '',
    saveError: '',
    storage: '',
    // --- input, from InputState rather than Status. See the file header. ---
    cursor: '',
    buttons: '',
    dragging: '',
    keys: '',
  };

  const row = (key: keyof typeof readout, label: string): void => {
    const blade = folder.addBinding(readout, key, { readonly: true, label });
    (blade.element as HTMLElement).dataset['setting'] = `debug.${key}`;
  };

  row('preset', 'Preset');
  row('project', 'Project');
  row('frame', 'Frame');
  row('entities', 'Entities');
  row('canvas', 'Canvas');
  row('window', 'Window');
  row('camera', 'Camera');
  row('zoom', 'Zoom');
  row('pan', 'Pan');
  row('mouse', 'Mouse world');
  row('selected', 'Selected');
  row('configs', 'Configs');
  row('checkpoints', 'Checkpoints');
  row('history', 'History');
  row('saveError', 'Message');
  // Storage is async and `dispatch` returns void, so this row is how a load or
  // a save that has not landed yet reports itself.
  row('storage', 'Storage');

  // What the CANVAS received, after capture filtering. Hover the panel and
  // these go quiet; that is the whole demonstration.
  row('cursor', 'Cursor px');
  row('buttons', 'Buttons');
  row('dragging', 'Dragging');
  row('keys', 'Keys held');

  return {
    bindings: [],
    refresh: (s: Status, input: InputState) => {
      readout.preset = s.preset;
      readout.project = s.projectName;
      readout.frame = String(s.frameCount);
      readout.entities = String(s.entityCount);
      readout.canvas = s.canvasSize;
      readout.window = s.windowSize;
      readout.camera = s.camMode;
      readout.zoom = `${s.camZoom.toFixed(3)}x`;
      readout.pan = `${s.camPan[0].toFixed(3)}, ${s.camPan[1].toFixed(3)}`;
      readout.mouse = `${s.mouseWorld[0].toFixed(3)}, ${s.mouseWorld[1].toFixed(3)}`;
      readout.selected = describeSelected(s);
      readout.configs = `${s.configCount} (sel ${s.selectedConfig})`;
      readout.checkpoints = String(s.checkpoints.length);
      readout.history =
        `${s.historyCursor + 1}/${s.historyDepth}` +
        (s.undoLabel === '' ? '' : `  (undo: ${s.undoLabel})`);
      readout.saveError = s.saveError;
      readout.storage = s.configBusy;

      readout.cursor = `${input.mousePos[0].toFixed(0)}, ${input.mousePos[1].toFixed(0)}`;
      readout.buttons = flags([
        ['L', input.leftPressed || input.leftDragging],
        ['R', input.rightPressed || input.rightDragging],
      ]);
      readout.dragging = flags([
        ['L', input.leftDragging],
        ['R', input.rightDragging],
      ]);
      // `code` values, minus the `Key`/`Digit` prefix that makes the row
      // unreadable at four keys held.
      readout.keys =
        [...input.keysHeld].map((c) => c.replace(/^(Key|Digit)/, '')).sort().join(' ') || '-';
    },
  };
}

/** `"L R"` for the flags that are set, or `-`. The port of `ui.py:324-328`. */
function flags(entries: readonly (readonly [string, boolean])[]): string {
  const on = entries.filter(([, set]) => set).map(([name]) => name);
  return on.length === 0 ? '-' : on.join(' ');
}

/**
 * The `selected` row, formatted as `ui.py:385-391` does: `#index (x, y) d=dist`,
 * `-` for nothing selected, `miss` for a click that found nothing in range.
 */
export function describeSelected(status: Status): string {
  const result = status.selected;
  if (result === null) return '-';
  if (result.index < 0) return 'miss';
  return (
    `#${result.index} (${result.pos[0].toFixed(3)}, ${result.pos[1].toFixed(3)}) ` +
    `d=${result.distance.toFixed(4)}`
  );
}
