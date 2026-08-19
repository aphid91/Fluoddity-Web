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
 * Ask the user where to save, returning an open file or null to buffer instead.
 *
 * **CALL THIS BEFORE ANY OTHER AWAIT IN THE CLICK HANDLER.** See the file
 * header for what happens otherwise.
 *
 * Returns null in three cases that all mean the same thing downstream -- fall
 * back to buffering in memory:
 *
 *   - the API is absent (Firefox, Safari, and any non-secure context);
 *   - the user dismissed the picker;
 *   - the call threw for any other reason, which is treated as a decline rather
 *     than propagated. Failing to open a file is not a reason to refuse to
 *     record at all when there is a working fallback.
 */
export async function chooseRecordingFile(
  suggestedName: string,
): Promise<FileSystemWritableFileStream | null> {
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;
  if (typeof picker !== 'function') return null;

  try {
    const handle = await picker.call(window, {
      suggestedName,
      types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
    });
    return await handle.createWritable();
  } catch {
    // AbortError when dismissed, SecurityError without a gesture. Both mean
    // "no file", and the buffered path handles that perfectly well.
    return null;
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
