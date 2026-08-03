/**
 * Transport: pause, reset, the tool selector, the camera, and history.
 *
 * The port of `ui/toolbar.py` plus the Simulation, Edit and View menus'
 * one-shots (`config_menu.py:94-156`). It exists as a section rather than as a
 * menu because these are the controls a user reaches for constantly, and burying
 * a Pause button two clicks deep in a menu would be worse than the desktop's
 * floating toolbar rather than better.
 *
 * **10e moves the menu-only items to the real menu bar** -- what stays here is
 * what the desktop's toolbar and the always-visible hotkeys cover. The Presets
 * and Save folders here are DELIBERATELY TEMPORARY: they exist so the storage
 * path stays drivable between 10a and 10e, and 10e replaces them with the
 * browse-by-hover Load menu and the real save dialog.
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

  // --- Edit -----------------------------------------------------------------
  // No `refreshing` guard on any button: a click is always the user's. The guard
  // exists for BINDINGS, whose `change` fires on a programmatic refresh too.
  const edit = folder.addFolder({ title: 'Edit', expanded: false });
  edit.addButton({ title: 'Undo' }).on('click', () => {
    ctx.send({ kind: 'undo' });
  });
  edit.addButton({ title: 'Redo' }).on('click', () => {
    ctx.send({ kind: 'redo' });
  });
  edit.addButton({ title: 'Randomize Behavior' }).on('click', () => {
    ctx.send({ kind: 'randomizeBehavior' });
  });
  edit.addButton({ title: 'Randomize Seed' }).on('click', () => {
    ctx.send({ kind: 'randomizeSeed' });
  });
  edit.addButton({ title: 'Checkpoint' }).on('click', () => {
    ctx.send({ kind: 'setCheckpoint' });
  });
  edit.addButton({ title: 'Restore Latest Checkpoint' }).on('click', () => {
    ctx.send({ kind: 'loadLatestCheckpoint' });
  });

  // --- Presets and Save: TEMPORARY. See the file header. --------------------
  // Built once at construction, so a config saved this session does not appear
  // until a reload. 10e's Load menu reads `status.configCategories` every frame
  // and does not have this problem.
  const presets = folder.addFolder({ title: 'Presets', expanded: false });
  presets.addButton({ title: '< Prev' }).on('click', () => {
    ctx.send({ kind: 'prevPreset' });
  });
  presets.addButton({ title: 'Next >' }).on('click', () => {
    ctx.send({ kind: 'nextPreset' });
  });
  for (const [category, names] of Object.entries(status.configCategories)) {
    for (const name of names) {
      presets.addButton({ title: name, label: category }).on('click', () => {
        // (category, name), not just the name: two categories may hold the same
        // name, and the identity is the pair.
        ctx.send({ kind: 'loadConfig', category, name });
      });
    }
  }

  const saveAs = { name: '' };
  const save = folder.addFolder({ title: 'Save', expanded: false });
  // NOT refreshed from status, unlike everything else here -- it is the user's
  // own text, and overwriting it each frame would make it impossible to type in.
  save.addBinding(saveAs, 'name', { label: 'Name' });
  save.addButton({ title: 'Save to Custom' }).on('click', () => {
    ctx.send({ kind: 'saveConfig', name: saveAs.name });
  });
  save.addButton({ title: 'Revert to Saved' }).on('click', () => {
    ctx.send({ kind: 'revertConfig' });
  });
  save.addButton({ title: 'Delete (Custom)' }).on('click', () => {
    ctx.send({ kind: 'deleteConfig', category: 'Custom', name: saveAs.name });
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
