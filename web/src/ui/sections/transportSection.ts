/**
 * Transport: pause, reset, the tool selector, the camera, and history.
 *
 * The port of `ui/toolbar.py` plus the Simulation, Edit and View menus'
 * one-shots (`config_menu.py:94-156`). It exists as a section rather than as a
 * menu because these are the controls a user reaches for constantly, and burying
 * a Pause button two clicks deep in a menu would be worse than the desktop's
 * floating toolbar rather than better.
 *
 * **10e moved the menu-only items to the real menu bar**, and what stays here is
 * what the desktop's toolbar covers: the transport, the tool, and the camera.
 * Undo, checkpoints, presets, save and delete all live in the menu bar now --
 * the Presets and Save folders that stood in for them between 10a and 10e are
 * gone, along with the staleness note they carried (they were built once at
 * construction; the Load menu reads `status.configCategories` every frame).
 *
 * ## The tool selector mirrors MOUSE_MODES by order
 *
 * "MEMBER ORDER IS THE TOOLBAR ORDER and the 1/2/3 key order"
 * (`commands.ts:67`). Built from that array rather than written out, so adding a
 * tool needs one array member and nothing here -- the desktop zips against
 * `TOOLS` for the same reason (`ui.py:466-469`).
 */

import type { FolderApi } from 'tweakpane';
import {
  type MouseMode,
  type Status,
  MOUSE_MODES,
} from '../../orchestrator/commands.ts';
import { type SectionContext, type SectionHandle } from './section.ts';

export function buildTransportSection(
  folder: FolderApi,
  status: Status,
  ctx: SectionContext,
): SectionHandle {
  const toggles = {
    paused: status.paused,
    tool: status.mouseMode as MouseMode,
  };

  const paused = folder.addBinding(toggles, 'paused', { label: 'Paused' });
  (paused.element as HTMLElement).dataset['setting'] = 'transport.paused';
  paused.on('change', (ev) => {
    if (ctx.isRefreshing()) return;
    // Dispatched as a TOGGLE rather than a set, because that is the command the
    // desktop has. Compared against the LIVE status rather than the captured
    // one, so a pause toggled from anywhere else cannot make this fire a second
    // time and undo it.
    if (ev.value !== currentPaused()) ctx.send({ kind: 'togglePause' });
  });

  const tool = folder.addBinding(toggles, 'tool', {
    label: 'Tool',
    options: Object.fromEntries(
      MOUSE_MODES.map((m) => [`${m[0]!.toUpperCase()}${m.slice(1)}`, m]),
    ),
  });
  (tool.element as HTMLElement).dataset['setting'] = 'transport.tool';
  tool.on('change', (ev) => {
    if (ctx.isRefreshing()) return;
    ctx.send({ kind: 'setMouseMode', mode: ev.value as MouseMode });
  });

  folder.addButton({ title: 'Reset Simulation' }).on('click', () => {
    ctx.send({ kind: 'reset' });
  });
  folder.addButton({ title: 'Toggle Camera Mode' }).on('click', () => {
    ctx.send({ kind: 'toggleCameraMode' });
  });
  folder.addButton({ title: 'Reset Camera' }).on('click', () => {
    ctx.send({ kind: 'resetCamera' });
  });

  /** The live paused flag, re-read at click time. See the handler above. */
  let latest: Status = status;
  function currentPaused(): boolean {
    return latest.paused;
  }

  return {
    bindings: [],
    refresh: (s) => {
      latest = s;
      toggles.paused = s.paused;
      toggles.tool = s.mouseMode;
    },
  };
}
