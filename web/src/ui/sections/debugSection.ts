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
 * 10f adds the live input rows (buttons held, dragging, keys, capture), which
 * are what actually prove the capture filtering works and which need
 * `InputState` passed alongside `Status`.
 */

import type { FolderApi } from 'tweakpane';
import type { Status } from '../../orchestrator/commands.ts';
import { type SectionContext, type SectionHandle } from './section.ts';

export function buildDebugSection(
  folder: FolderApi,
  _status: Status,
  _ctx: SectionContext,
): SectionHandle {
  const readout = {
    preset: '',
    project: '',
    frame: 0,
    entities: 0,
    canvas: '',
    window: '',
    camera: '',
    zoom: '',
    pan: '',
    mouse: '',
    selected: '-',
    configs: '',
    checkpoints: 0,
    history: '',
    saveError: '',
    storage: '',
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

  return {
    bindings: [],
    refresh: (s) => {
      readout.preset = s.preset;
      readout.project = s.projectName;
      readout.frame = s.frameCount;
      readout.entities = s.entityCount;
      readout.canvas = s.canvasSize;
      readout.window = s.windowSize;
      readout.camera = s.camMode;
      readout.zoom = `${s.camZoom.toFixed(3)}x`;
      readout.pan = `${s.camPan[0].toFixed(3)}, ${s.camPan[1].toFixed(3)}`;
      readout.mouse = `${s.mouseWorld[0].toFixed(3)}, ${s.mouseWorld[1].toFixed(3)}`;
      readout.selected = describeSelected(s);
      readout.configs = `${s.configCount} (sel ${s.selectedConfig})`;
      readout.checkpoints = s.checkpoints.length;
      readout.history =
        `${s.historyCursor + 1}/${s.historyDepth}` +
        (s.undoLabel === '' ? '' : `  (undo: ${s.undoLabel})`);
      readout.saveError = s.saveError;
      readout.storage = s.configBusy;
    },
  };
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
