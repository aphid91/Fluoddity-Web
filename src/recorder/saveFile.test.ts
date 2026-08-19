/**
 * Choosing a save location, and the three outcomes it has to keep apart.
 *
 * WHY THIS IS WORTH A TEST despite being a thin wrapper over one browser call:
 * the bug it exists to prevent shipped. An earlier version returned
 * `FileSystemWritableFileStream | null`, where null meant BOTH "this browser has
 * no picker" and "the user pressed Cancel" -- so dismissing the file dialog fell
 * through to the buffered path and started a recording the user had just
 * declined, which also unpaused their simulation and ran it at the recording's
 * physics rate. Backing out of a dialog should not do any of that.
 *
 * The distinction is entirely in how a thrown error is classified, which is
 * exactly the kind of thing that looks right by inspection and is checkable only
 * by throwing the errors.
 *
 * `window` is stubbed rather than mocked through a seam in the source: the
 * function reads `window.showSaveFilePicker` because that is where the API
 * lives, and a seam added purely for testing would be indirection that the
 * production path pays for and nothing else uses.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { chooseRecordingFile } from './saveFile.ts';

/** Install a `window` with the given picker, or none at all. */
function stubWindow(picker?: unknown): void {
  (globalThis as { window?: unknown }).window = picker === undefined ? {} : {
    showSaveFilePicker: picker,
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

/** A DOMException-shaped rejection. `name` is what the classifier reads. */
function named(name: string): Error {
  const err = new Error(`stubbed ${name}`);
  err.name = name;
  return err;
}

test('a granted file comes back as a writable to stream into', async () => {
  const writable = { marker: 'the-stream' };
  stubWindow(async () => ({ createWritable: async () => writable }));

  const choice = await chooseRecordingFile('x.mp4');
  assert.equal(choice.kind, 'file');
  assert.equal(
    choice.kind === 'file' ? choice.writable : null,
    writable as unknown,
  );
});

test('AbortError is CANCELLED -- the export must not proceed', async () => {
  // The regression. `AbortError` is what a dismissed picker rejects with, and
  // it is the ONLY outcome that means "do not record".
  stubWindow(async () => {
    throw named('AbortError');
  });

  const choice = await chooseRecordingFile('x.mp4');
  assert.equal(choice.kind, 'cancelled');
});

test('a missing API is UNAVAILABLE -- the export SHOULD proceed, buffered', async () => {
  // Firefox, Safari, and any non-secure context. Not having a picker is not a
  // refusal: buffering in memory still gets the user their video, and treating
  // this as a cancel would mean those browsers could never export at all.
  stubWindow();

  const choice = await chooseRecordingFile('x.mp4');
  assert.equal(choice.kind, 'unavailable');
});

test('any OTHER failure is unavailable, not cancelled', async () => {
  // A spent user gesture (SecurityError), a file that would not open, a
  // browser bug. None of these is a decision by the user, so none of them
  // should silently cancel an export they asked for -- the buffered path is
  // still a working answer.
  for (const name of ['SecurityError', 'NotAllowedError', 'TypeError', 'Whatever']) {
    stubWindow(async () => {
      throw named(name);
    });
    const choice = await chooseRecordingFile('x.mp4');
    assert.equal(choice.kind, 'unavailable', `${name} must not read as cancel`);
  }
});

test('a failure to open the chosen file is unavailable, not cancelled', async () => {
  // The picker succeeded and `createWritable` did not. The user made a choice
  // and the browser could not honour it, which is a broken picker rather than a
  // change of mind.
  stubWindow(async () => ({
    createWritable: async () => {
      throw named('NotAllowedError');
    },
  }));

  const choice = await chooseRecordingFile('x.mp4');
  assert.equal(choice.kind, 'unavailable');
});
