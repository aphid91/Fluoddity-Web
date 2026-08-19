/**
 * Choosing where an export lands, and delivering it when nothing was chosen.
 *
 * ## Why this is a module of its own
 *
 * Both functions here are plain DOM -- a file picker and a download link -- with
 * no mediabunny and no GPU behind either. They live apart from `recorder.ts`
 * because of WHEN they must be callable, not because of what they do.
 *
 * `showSaveFilePicker` requires transient user activation: the click's gesture,
 * which any `await` spends. A dynamic `import()` is an await, and on the first
 * export it is a real network fetch of the 185 kB mediabunny chunk. So a picker
 * reached through `import('./recorder.ts')` would lose the gesture EXACTLY ONCE
 * PER SESSION -- on the first export, silently falling back to buffering with no
 * indication why, and working perfectly on every attempt after that. A bug that
 * only reproduces on the first try is one that gets reported as "sometimes it
 * ignores my file choice" and is very hard to find from that description.
 *
 * Keeping these here lets `main.ts` import them STATICALLY. They cost a few
 * hundred bytes in the main bundle and none of what the lazy loading protects:
 * this file imports nothing.
 */

/**
 * What asking for a save location produced.
 *
 * THREE OUTCOMES, and conflating two of them is a bug this type exists to
 * prevent. An earlier version returned `FileSystemWritableFileStream | null`,
 * where null meant BOTH "this browser has no picker" and "the user pressed
 * Cancel" -- so dismissing the picker fell through to the buffered path and
 * started a recording the user had just declined. Cancel must mean cancel.
 *
 *   file        A file is open and the export should stream into it.
 *   unavailable No picker here (Firefox, Safari, any non-secure context).
 *               Fall back to buffering in memory -- the export SHOULD proceed.
 *   cancelled   The user dismissed the picker. Do not record.
 */
export type SaveChoice =
  | { readonly kind: 'file'; readonly writable: FileSystemWritableFileStream }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'cancelled' };

/**
 * Ask the user where to save.
 *
 * **CALL THIS BEFORE ANY OTHER AWAIT IN THE CLICK HANDLER.** See the file
 * header for what happens otherwise.
 */
export async function chooseRecordingFile(
  suggestedName: string,
): Promise<SaveChoice> {
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;
  if (typeof picker !== 'function') return { kind: 'unavailable' };

  try {
    const handle = await picker.call(window, {
      suggestedName,
      types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
    });
    return { kind: 'file', writable: await handle.createWritable() };
  } catch (err: unknown) {
    // `AbortError` is the user dismissing the dialog, and it is the ONLY case
    // that means "do not record". Anything else -- a SecurityError from a spent
    // gesture, a failure to open the chosen file -- is a broken picker rather
    // than a decision, and buffering in memory still gets the user their video.
    //
    // Named rather than matched on the message: `err.name` is specified, the
    // message is not and differs across browsers.
    const name = (err as { name?: string } | null)?.name;
    return name === 'AbortError' ? { kind: 'cancelled' } : { kind: 'unavailable' };
  }
}

/**
 * Hand `blob` to the browser as a download.
 *
 * The buffered path's delivery, for when no file was chosen. The object URL is
 * revoked on a timer rather than immediately: Safari begins the download
 * asynchronously and a URL revoked in the same tick is occasionally dead before
 * it is read.
 */
export function downloadRecording(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}
