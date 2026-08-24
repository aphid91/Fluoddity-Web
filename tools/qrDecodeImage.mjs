/**
 * Did this image survive? Point it at a file that has been through a platform.
 *
 * ## THE OTHER HALF OF THE EXPERIMENT
 *
 * `qrSurvival.mjs` writes `upload-me__*.png` and predicts what will happen to
 * them. This reads back the files that actually did: post them, save them from
 * the timeline, and run them through here. The simulation is a guess about a
 * pipeline nobody documents -- this is the measurement that settles it.
 *
 * It decodes with the SAME `decodeQrFromImage` the app will use, so a PASS here
 * is a real statement about the app rather than about some other decoder that
 * happens to be more forgiving. It then runs the decoded text through
 * `decodeShareText` and the v8 reader, because a QR that decodes to a corrupted
 * string is not a success and would otherwise look like one.
 *
 * ## Usage
 *
 *   node tools/qrDecodeImage.mjs shot.png
 *   node tools/qrDecodeImage.mjs downloaded/*.jpg
 *   node tools/qrDecodeImage.mjs qr-samples/          # every image in a folder
 *
 * Exits non-zero if any image failed to yield a loadable project, so a batch can
 * be checked in one go.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { fromDocument } from '../src/config/persistence.ts';
import { decodeShareText } from '../src/config/shareLink.ts';
import { decodeQrFromImage } from '../src/share/qrDecode.ts';

/**
 * Any image format, as RGBA, via Pillow.
 *
 * PILLOW RATHER THAN A NODE DECODER because the files coming back from a
 * platform are whatever that platform chose to emit -- progressive JPEG, WebP,
 * a PNG with an alpha channel, occasionally an HEIC. `jpeg-js` reads baseline
 * JPEG and nothing else, which would turn "the platform converted it to WebP"
 * into "the stamp did not survive", and those are entirely different findings.
 */
function readImage(file) {
  const script = `
import sys
from PIL import Image
img = Image.open(sys.argv[1]).convert('RGBA')
sys.stdout.buffer.write(img.width.to_bytes(4, 'little'))
sys.stdout.buffer.write(img.height.to_bytes(4, 'little'))
sys.stdout.buffer.write(img.tobytes())
`;
  for (const python of ['python', 'python3', 'py']) {
    const run = spawnSync(python, ['-c', script, file], { maxBuffer: 1 << 28 });
    if (run.status === 0) {
      const width = run.stdout.readUInt32LE(0);
      const height = run.stdout.readUInt32LE(4);
      return {
        width,
        height,
        data: new Uint8ClampedArray(run.stdout.subarray(8)),
      };
    }
    // A non-zero status from a python that EXISTS is a real read failure worth
    // reporting; one from a python that does not is just the wrong name.
    if (run.error === undefined && run.stderr?.length > 0) {
      throw new Error(`could not read ${file}: ${run.stderr.toString().slice(0, 300)}`);
    }
  }
  throw new Error('no working python with Pillow found (pip install pillow)');
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);

/** Files named on the command line, with directories expanded one level. */
function targets(argv) {
  const files = [];
  for (const arg of argv) {
    if (!fs.existsSync(arg)) {
      console.error(`no such file: ${arg}`);
      continue;
    }
    if (fs.statSync(arg).isDirectory()) {
      for (const entry of fs.readdirSync(arg).sort()) {
        if (IMAGE_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
          files.push(path.join(arg, entry));
        }
      }
    } else {
      files.push(arg);
    }
  }
  return files;
}

const files = targets(process.argv.slice(2));
if (files.length === 0) {
  console.error('usage: node tools/qrDecodeImage.mjs <image|directory>...');
  process.exit(2);
}

let failures = 0;
for (const file of files) {
  const label = path.basename(file);
  let line;
  try {
    const image = readImage(file);
    const found = decodeQrFromImage(image);
    if (found === null) {
      failures += 1;
      line = `FAIL  ${label}  (${image.width}x${image.height}) -- no QR found`;
    } else {
      // A decode is not the claim. The claim is that a PROJECT comes out, so the
      // text goes through the same path a pasted link would take.
      const saved = fromDocument(decodeShareText(found.text), label);
      const note = found.strategy === 'as-is' ? '' : `  [needed: ${found.strategy}]`;
      line = `ok    ${label}  (${image.width}x${image.height})  ` +
        `${saved.configs.length} config(s)${note}`;
    }
  } catch (e) {
    failures += 1;
    line = `FAIL  ${label} -- ${e instanceof Error ? e.message : String(e)}`;
  }
  console.log(line);
}

console.log(`\n${files.length - failures}/${files.length} images yielded a loadable project.`);
process.exit(failures > 0 ? 1 : 0);
