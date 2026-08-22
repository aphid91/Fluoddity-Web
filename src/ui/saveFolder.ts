/**
 * Choosing a folder to write saves into, and reading one back.
 *
 * A sibling of `recorder/saveFile.ts` and written to the same rules, because it
 * has the same constraint: `showDirectoryPicker` requires transient user
 * activation -- the click's gesture, which any `await` spends. **Call the picker
 * before any other await in the handler.** That file's header explains what
 * happens otherwise, and it is worth reading: a gesture lost behind a dynamic
 * `import()` produces a bug that only reproduces on the first attempt of a
 * session.
 *
 * ## Three outcomes, not two
 *
 * `unavailable` and `cancelled` are separated for exactly the reason
 * `SaveChoice` separates them. Collapsing them into `null` would make dismissing
 * the picker fall through to the ZIP fallback and download an archive the user
 * had just declined. Cancel must mean cancel.
 *
 * ## Why import uses `<input type="file" webkitdirectory>` and not the picker
 *
 * `showDirectoryPicker` would work for reading, and would need a permission
 * prompt to do it -- read access to a folder is a grant the user has to approve,
 * on an API Firefox and Safari do not have at all. The input element needs no
 * permission, exists everywhere, and its `webkitdirectory` attribute is
 * supported by every current browser despite the prefix. Since import only ever
 * READS, the weaker mechanism is the correct one: it asks for less and works in
 * more places.
 */

/** What asking for an export folder produced. See the header. */
export type FolderChoice =
  | { readonly kind: 'folder'; readonly handle: FileSystemDirectoryHandle }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'cancelled' };

/** The subset of the File System Access API this module uses. */
interface DirectoryHandleLike {
  getFileHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<{ createWritable: () => Promise<FileSystemWritableFileStream> }>;
}

/**
 * Ask the user for a folder to export into.
 *
 * **CALL THIS BEFORE ANY OTHER AWAIT IN THE CLICK HANDLER.**
 *
 * `mode: 'readwrite'` is requested up front so the permission prompt happens
 * once, here, rather than on the first write -- by which point the gesture is
 * spent and the grant would be refused.
 */
export async function chooseExportFolder(): Promise<FolderChoice> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: (options?: unknown) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (typeof picker !== 'function') return { kind: 'unavailable' };

  try {
    const handle = await picker.call(window, { id: 'fluoddity-saves', mode: 'readwrite' });
    return { kind: 'folder', handle };
  } catch (err: unknown) {
    // Named rather than matched on the message, like `chooseRecordingFile`:
    // `err.name` is specified and the message is not. `AbortError` is the user
    // dismissing the dialog and is the only case that means "do not export";
    // anything else is a broken picker, and the ZIP still gets them their saves.
    const name = (err as { name?: string } | null)?.name;
    return name === 'AbortError' ? { kind: 'cancelled' } : { kind: 'unavailable' };
  }
}

/**
 * Write files into a chosen folder.
 *
 * SEQUENTIAL, not `Promise.all`. Each write is a separate permission-checked
 * handle acquisition against the same directory, and browsers serialize them
 * anyway; issuing thirty at once buys nothing and makes a mid-way failure report
 * an arbitrary one of them. Writing in order means the count returned is the
 * number that actually landed.
 *
 * OVERWRITES SILENTLY. The user picked this folder for these files; a
 * confirmation per existing file would turn one action into thirty. This is the
 * same argument `ConfigStore.write` makes for overwriting a save without asking.
 */
export async function writeFolder(
  handle: FileSystemDirectoryHandle,
  files: readonly { readonly filename: string; readonly text: string }[],
): Promise<number> {
  const dir = handle as unknown as DirectoryHandleLike;
  let written = 0;
  for (const file of files) {
    const fileHandle = await dir.getFileHandle(file.filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(file.text);
    await writable.close();
    written += 1;
  }
  return written;
}

/**
 * Ask for a folder of `.json` files and read them.
 *
 * Resolves to an EMPTY ARRAY when the user cancels. Unlike export there is
 * nothing to fall back to and nothing to undo -- importing nothing and
 * cancelling an import are the same event from here, and the caller reports
 * "nothing to import" either way.
 *
 * NON-JSON FILES ARE FILTERED OUT RATHER THAN REPORTED. Picking a directory
 * hands over everything in it, including whatever else the user keeps there;
 * listing `notes.txt` as an unreadable save would be noise about a file nobody
 * claimed was one. A `.json` that does not parse IS reported -- there the user's
 * intent is unambiguous.
 *
 * The `<input>` is never attached to the document. It does not need to be to
 * open a picker, and an unattached element cannot be caught by `setHidden`
 * or by a pane rebuild.
 */
export async function readImportFolder(): Promise<
  readonly { readonly filename: string; readonly text: string }[]
> {
  const input = document.createElement('input');
  input.type = 'file';
  // `webkitdirectory` is not in the TS DOM lib under that name on all versions,
  // so it is set as an attribute -- which is what the property sets anyway.
  input.setAttribute('webkitdirectory', '');
  input.setAttribute('multiple', '');
  input.accept = 'application/json,.json';

  const files = await new Promise<FileList | null>((resolve) => {
    // `cancel` fires on dismissal in current browsers. Where it does not, the
    // promise simply never settles and the click is a no-op -- the failure mode
    // is "nothing happened", not a wrong import.
    input.addEventListener('cancel', () => {
      resolve(null);
    });
    input.addEventListener('change', () => {
      resolve(input.files);
    });
    input.click();
  });

  if (files === null || files.length === 0) return [];

  const out: { filename: string; text: string }[] = [];
  for (const file of Array.from(files)) {
    if (!file.name.toLowerCase().endsWith('.json')) continue;
    out.push({ filename: file.name, text: await file.text() });
  }
  return out;
}
