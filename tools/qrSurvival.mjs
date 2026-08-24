/**
 * Does the QR stamp survive being posted to X?
 *
 * ## WHY THIS EXISTS
 *
 * The stamp's whole job is to make a round trip nobody controls: upload to a
 * social platform, which resizes and re-encodes it as JPEG on its own terms,
 * then download, copy, and paste back into the app. Every parameter in
 * `qrStamp.ts` -- module size, error correction, quiet zone -- is a bet about
 * what survives that, and betting without measuring is how you ship a feature
 * that works on your machine and fails on everyone's timeline.
 *
 * So this sweeps the parameters against a SIMULATED re-encode and reports what
 * decodes. It is a development tool, not part of `npm test`: it is slow, it
 * depends on `jpeg-js`, and its output is a table to read rather than an
 * assertion to pass.
 *
 * ## THE SIMULATION IS A LOWER BOUND, NOT A PREDICTION
 *
 * What real platforms do is undocumented, varies by account tier and by whether
 * the upload was web or app, and changes without notice. This models the two
 * things they all provably do -- BILINEAR DOWNSCALE to a target width, then
 * JPEG at a quality nobody discloses.
 *
 * That makes a PASS here weak evidence and a FAIL here strong evidence. A
 * configuration that dies in this harness will certainly die on a timeline; one
 * that survives still has to be confirmed by an actual upload, which is what
 * `--emit` is for. Use this to find the candidates worth testing by hand, not
 * to declare the problem solved.
 *
 * ## WHAT THE FIRST RUN ACTUALLY SHOWED, WHICH WAS NOT THE EXPECTED THING
 *
 * The assumption going in was that JPEG QUANTIZATION was the enemy and that
 * error correction was the defence. Measured against real libjpeg, that is
 * WRONG, and the shape of the whole problem changes with it:
 *
 *   - **JPEG barely touches the stamp.** A hard black/white checker at 2px
 *     cells, encoded at quality 50, comes back with 0.00% of its pixels across
 *     the threshold. The symbol is pure luma, and luma is the channel JPEG
 *     never subsamples -- so the artefact everyone worries about lands on the
 *     colourful artwork beside the code, not on the code.
 *   - **DOWNSCALING is the whole risk, and only at some ratios.** A 2px module
 *     scaled by 0.75 loses 37% of its modules; the SAME module scaled by 0.5
 *     loses none. That is not a quality effect, it is phase aliasing: at a
 *     non-integer ratio the resampler's sample grid beats against the module
 *     grid, and whole runs of modules land on the wrong side of the threshold.
 *
 * Two consequences, and they are why `modulePx` is the dial rather than `ecc`.
 * FIRST, stay under the platform's resize threshold and nothing bad happens at
 * all -- hence a 1080-wide canvas. SECOND, when a resize does happen, big
 * modules are what survive it: at 6px and 8px every ratio tested came through
 * intact, because even a bad phase leaves most of the module on the right side.
 *
 * Error correction is still worth having for the cases this does not model, but
 * it is the second line, not the first. Buying robustness with ECC costs
 * version, which costs module size at a fixed stamp budget -- which spends the
 * thing that actually works to buy the thing that mostly does not.
 *
 * ## Usage
 *
 *   node tools/qrSurvival.mjs                 # the default sweep
 *   node tools/qrSurvival.mjs --emit out/     # write images to test by hand
 *   node tools/qrSurvival.mjs --configs 2     # a bigger project = a bigger payload
 *
 * THROUGH npm THE FLAGS NEED `--` FIRST, and this is worth stating because the
 * failure is silent: `npm run qr:survival --emit out/` does NOT pass `--emit` to
 * this script. npm parses it as one of its own options, the script sees no
 * arguments, writes nothing, and still exits 0 -- so it looks like it worked and
 * there is simply no directory. The form that works is:
 *
 *   npm run qr:survival -- --emit out/
 *
 * ## WHAT `--emit` WRITES, AND WHICH ONES TO UPLOAD
 *
 * Two kinds of file, named so they cannot be confused:
 *
 *   `upload-me__*.png`          -- the PRISTINE stamped screenshot, one per
 *                                  configuration. THESE are what you post. They
 *                                  have been through no simulation at all, so
 *                                  whatever damage they come back with is the
 *                                  platform's alone. PNG, because handing a
 *                                  platform a JPEG makes its re-encode a SECOND
 *                                  generation and measures the wrong thing.
 *   `simulated-failure__*.jpg`  -- only the cases this harness could not decode,
 *                                  kept so the breakage can be looked at rather
 *                                  than just counted.
 *
 * The workflow is: post the `upload-me` files, save them back down, and drop
 * them on `tools/qrDecodeImage.mjs` to see which still read.
 *
 * Exits non-zero if nothing in the sweep survived, so it can gate a change to
 * the defaults.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

import jpeg from 'jpeg-js';

import { fromDocument, toDocument } from '../src/config/persistence.ts';
import { encodeShareLink } from '../src/config/shareLink.ts';
import { buildQrMatrix } from '../src/share/qrStamp.ts';
import { blankImage, drawQrStamp, stampOrigin } from '../src/share/qrRender.ts';
import { decodeQrFromImage } from '../src/share/qrDecode.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(here, '..');

// --- the fake screenshot ----------------------------------------------------

/**
 * Artwork with the statistics of a real capture, without needing a GPU.
 *
 * NOT A FLAT COLOUR AND NOT NOISE. A flat background would let the stamp survive
 * anything, because JPEG spends no bits on it and the stamp would be the only
 * detail in the frame. Real Fluoddity output is dense high-frequency filament on
 * dark ground, which is the WORST case for the stamp: it competes for the
 * encoder's bit budget and puts hard edges right against the plate. This
 * approximates that, so the measurement is pessimistic in the same direction as
 * reality.
 */
function syntheticArtwork(width, height) {
  const image = blankImage(width, height, 0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      // Interfering sinusoids: smooth, but with fine structure at many scales,
      // which is what a particle trail field looks like to a DCT.
      const v =
        Math.sin(x * 0.11) * Math.sin(y * 0.07) +
        Math.sin((x + y) * 0.031) +
        Math.sin(Math.hypot(x - width / 2, y - height / 2) * 0.05);
      const level = Math.max(0, Math.min(255, Math.round(40 + v * 60)));
      image.data[at] = level;
      image.data[at + 1] = Math.max(0, Math.min(255, Math.round(level * 0.75)));
      image.data[at + 2] = Math.max(0, Math.min(255, Math.round(level * 1.15)));
      image.data[at + 3] = 255;
    }
  }
  return image;
}

// --- the platform simulation ------------------------------------------------

/**
 * Bilinear downscale, which is what every image pipeline does on resize.
 *
 * Written out rather than pulled from a library so the harness has no native
 * dependency and so the filter is VISIBLE: box or Lanczos would give materially
 * different answers about module survival, and a hidden choice there would make
 * the whole table untrustworthy. Bilinear is the conservative middle.
 */
function bilinearResize(image, width, height) {
  const out = blankImage(width, height, 0);
  const xRatio = image.width / width;
  const yRatio = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(image.height - 1, (y + 0.5) * yRatio - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1, (x + 0.5) * xRatio - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = sx - x0;
      const to = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const p00 = image.data[(y0 * image.width + x0) * 4 + c];
        const p01 = image.data[(y0 * image.width + x1) * 4 + c];
        const p10 = image.data[(y1 * image.width + x0) * 4 + c];
        const p11 = image.data[(y1 * image.width + x1) * 4 + c];
        const top = p00 + (p01 - p00) * fx;
        const bottom = p10 + (p11 - p10) * fx;
        out.data[to + c] = Math.round(top + (bottom - top) * fy);
      }
      out.data[to + 3] = 255;
    }
  }
  return out;
}

/**
 * RGBA in, JPEG bytes out, RGBA back. One lossy generation.
 *
 * ## THIS PREFERS PILLOW, AND THAT IS A CORRECTNESS REQUIREMENT
 *
 * `jpeg-js` is pure JavaScript and installs anywhere, which is why it is here at
 * all -- but it is NOT the encoder any social platform runs, and the difference
 * is not cosmetic. It does no chroma subsampling and its quality scale is
 * milder than libjpeg's at the same number, so it reports a stamp as surviving
 * conditions that would destroy it. A harness whose whole purpose is to predict
 * a real pipeline must not be gentler than the real pipeline.
 *
 * Pillow is libjpeg, which IS what the platforms run (or close kin to it), so it
 * is used whenever `python` can be found. `jpeg-js` remains the fallback so the
 * tool still runs on a machine without it, and the report says which encoder
 * produced it -- a table built on the fallback is worth strictly less, and
 * should say so rather than quietly look the same.
 */
const PYTHON = (() => {
  for (const candidate of ['python', 'python3', 'py']) {
    const probe = spawnSync(candidate, ['-c', 'import PIL'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
})();

function jpegViaPillow(image, quality) {
  // Raw RGBA over stdin, raw RGB back over stdout -- no temp files, no base64,
  // and nothing that a Windows path could break.
  const script = `
import sys, io
from PIL import Image
w, h, q = ${image.width}, ${image.height}, ${quality}
raw = sys.stdin.buffer.read()
img = Image.frombytes('RGBA', (w, h), raw).convert('RGB')
buf = io.BytesIO()
img.save(buf, 'JPEG', quality=q)
data = buf.getvalue()
sys.stdout.buffer.write(len(data).to_bytes(4, 'little'))
sys.stdout.buffer.write(data)
out = Image.open(io.BytesIO(data)).convert('RGB')
sys.stdout.buffer.write(out.tobytes())
`;
  const run = spawnSync(PYTHON, ['-c', script], {
    input: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength),
    maxBuffer: 1 << 28,
  });
  if (run.status !== 0) {
    throw new Error(`pillow failed: ${run.stderr?.toString().slice(0, 400)}`);
  }
  const out = run.stdout;
  const jpegLength = out.readUInt32LE(0);
  const bytes = out.subarray(4, 4 + jpegLength);
  const rgb = out.subarray(4 + jpegLength);

  // RGB back to RGBA, which is what the renderer and jsQR both speak.
  const data = new Uint8ClampedArray(image.width * image.height * 4);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    data[i] = rgb[j];
    data[i + 1] = rgb[j + 1];
    data[i + 2] = rgb[j + 2];
    data[i + 3] = 255;
  }
  return { image: { width: image.width, height: image.height, data }, bytes };
}

function jpegGeneration(image, quality) {
  if (PYTHON !== null) return jpegViaPillow(image, quality);
  const encoded = jpeg.encode(
    { data: Buffer.from(image.data.buffer.slice(0)), width: image.width, height: image.height },
    quality,
  );
  const decoded = jpeg.decode(encoded.data, { useTArray: true });
  return {
    image: {
      width: decoded.width,
      height: decoded.height,
      data: new Uint8ClampedArray(decoded.data),
    },
    bytes: encoded.data,
  };
}

/**
 * One platform's treatment of an upload.
 *
 * `maxWidth: null` means "no resize", which is the case worth testing precisely
/**
 * The cases are chosen around the finding, not around brand names.
 *
 * `maxWidth: null` is the STRATEGY case -- keep the canvas under the platform's
 * threshold so no resize happens, which the first sweep showed is where all the
 * damage comes from. The awkward widths below it are the ones that matter most:
 * 1080 -> 1017 is a 0.94 ratio, the kind of nearly-but-not-quite-1 resample that
 * aliases module edges worst, and it is exactly what a platform does when its
 * limit sits just under your canvas.
 *
 * `passes: 2` models a screenshot that gets posted, saved by someone else, and
 * posted again -- generation loss is cumulative and the second pass quantizes an
 * image that already has ringing in it.
 */
const PLATFORMS = [
  { name: 'no resize q90', maxWidth: null, quality: 90, passes: 1 },
  { name: 'no resize q75', maxWidth: null, quality: 75, passes: 1 },
  { name: 'no resize q60 x2', maxWidth: null, quality: 60, passes: 2 },
  { name: 'awkward 1017 q80', maxWidth: 1017, quality: 80, passes: 1 },
  { name: 'X ~1200 q85', maxWidth: 1200, quality: 85, passes: 1 },
  { name: 'Bluesky ~1000 q80', maxWidth: 1000, quality: 80, passes: 1 },
  { name: 'harsh 900 q60', maxWidth: 900, quality: 60, passes: 1 },
  { name: 'brutal 800 q50 x2', maxWidth: 800, quality: 50, passes: 2 },
];

function runPlatform(image, platform) {
  let staged = image;
  if (platform.maxWidth !== null && image.width > platform.maxWidth) {
    const scale = platform.maxWidth / image.width;
    staged = bilinearResize(
      staged,
      Math.round(image.width * scale),
      Math.round(image.height * scale),
    );
  }
  let result = jpegGeneration(staged, platform.quality);
  for (let pass = 1; pass < (platform.passes ?? 1); pass += 1) {
    result = jpegGeneration(result.image, platform.quality);
  }
  return result;
}

/**
 * Write an RGBA image as a PNG, using nothing but `node:zlib`.
 *
 * HAND-ROLLED RATHER THAN A DEPENDENCY because PNG's container is genuinely
 * trivial once deflate is available -- four chunks and a CRC -- and the
 * alternative is adding a package to a dev tool for thirty lines. `jpeg-js` is
 * already here under protest; a second image library for the LOSSLESS direction
 * would be harder to justify.
 *
 * Filter byte 0 (None) on every row: the images are written once, read by an
 * upload dialog, and never stored, so trading a larger file for simpler code is
 * the right way round here.
 */
function writePng(file, image) {
  const { width, height, data } = image;

  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const at = y * (width * 4 + 1);
    raw[at] = 0; // filter: None
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, at + 1);
  }

  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    // CRC-32 over type+body, computed inline -- zlib exposes `crc32` only in
    // newer Node, and this keeps the tool running on whatever is installed.
    let crc = 0xffffffff;
    for (let i = 4; i < 8 + body.length; i += 1) {
      crc ^= out[i];
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
    }
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + body.length);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 are compression, filter and interlace methods; 0 is the only legal
  // value for each, and `Buffer.alloc` has already zeroed them.

  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

// --- the sweep --------------------------------------------------------------

function parseArgs(argv) {
  const args = { emit: null, configs: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--emit') args.emit = argv[++i] ?? 'qr-samples';
    else if (argv[i] === '--configs') args.configs = Number(argv[++i] ?? 1);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// A REAL payload, from a real preset, because the length is what drives the QR
// version and a made-up string would not have the right one.
const configDir = path.join(REPO_ROOT, 'configs');
const presetFile = fs.readdirSync(configDir).filter((f) => f.endsWith('.json')).sort()[0];
const preset = fromDocument(
  JSON.parse(fs.readFileSync(path.join(configDir, presetFile), 'utf8')),
  presetFile,
);
const configs = Array.from({ length: args.configs }, () => preset.configs[0]);
const payload = encodeShareLink(toDocument(configs, preset.world, ''));

console.log(`payload: ${payload.length} chars, from ${presetFile} x${args.configs}`);
console.log(
  PYTHON !== null
    ? `encoder: Pillow/libjpeg via ${PYTHON} -- the real thing`
    : 'encoder: jpeg-js FALLBACK -- gentler than any real pipeline, so a PASS ' +
      'here means little. Install Pillow (pip install pillow) for a usable table.',
);
console.log('');

const MODULE_SIZES = [2, 3, 4, 6, 8];
const ECC_LEVELS = ['L', 'M', 'Q'];
// 1080 wide is the interesting canvas: it is at or under most platforms'
// resize threshold, which is the whole strategy -- avoid the downscale rather
// than survive it.
const CANVAS = { width: 1080, height: 720 };

if (args.emit) fs.mkdirSync(args.emit, { recursive: true });

const rows = [];
for (const ecc of ECC_LEVELS) {
  for (const modulePx of MODULE_SIZES) {
    const options = { modulePx, ecc, quietModules: 4, padPx: 8 };
    let matrix;
    try {
      matrix = buildQrMatrix(payload, options);
    } catch (e) {
      console.log(`ECC ${ecc} @ ${modulePx}px: ${e.message}`);
      continue;
    }
    if (matrix.sizePx > Math.min(CANVAS.width, CANVAS.height)) {
      rows.push({ ecc, modulePx, matrix, tooBig: true, results: [] });
      continue;
    }

    const shot = syntheticArtwork(CANVAS.width, CANVAS.height);
    const at = stampOrigin(shot.width, shot.height, matrix, 16);
    drawQrStamp(shot, matrix, at.x, at.y);

    // THE PRISTINE ORIGINAL, which is what a real upload test actually needs.
    // The simulated outputs below have already been downscaled and requantized;
    // posting one of those measures OUR pipeline plus the platform's, and the
    // whole question is what the PLATFORM alone does. PNG so that nothing is
    // lost before the upload -- handing a platform a JPEG means it re-encodes an
    // image that already has ringing in it, which is a second generation, not a
    // first.
    if (args.emit) {
      const slug = `${ecc}-${modulePx}px-v${matrix.version}-${matrix.sizePx}px`;
      writePng(path.join(args.emit, `upload-me__${slug}.png`), shot);
    }

    const results = [];
    for (const platform of PLATFORMS) {
      const { image, bytes } = runPlatform(shot, platform);
      const decoded = decodeQrFromImage(image);
      const ok = decoded !== null && decoded.text === payload;
      results.push({ platform: platform.name, ok, strategy: decoded?.strategy ?? '-' });

      // The simulated results are emitted too, but only for the configurations
      // that FAILED -- those are the ones worth looking at by eye to see how the
      // stamp actually broke. Writing all 88 buries the interesting six.
      if (args.emit && !ok) {
        const slug = `${ecc}-${modulePx}px-${platform.name.replace(/[^a-z0-9]+/gi, '_')}`;
        fs.writeFileSync(path.join(args.emit, `simulated-failure__${slug}.jpg`), bytes);
      }
    }
    rows.push({ ecc, modulePx, matrix, tooBig: false, results });
  }
}

// --- the report -------------------------------------------------------------

const header = ['ecc', 'mod', 'ver', 'stamp', ...PLATFORMS.map((p) => p.name)];
const widths = header.map((h) => h.length);
const body = rows.map((r) => {
  const cells = [
    r.ecc,
    `${r.modulePx}px`,
    `v${r.matrix.version}`,
    `${r.matrix.sizePx}px`,
    ...(r.tooBig
      ? PLATFORMS.map(() => 'too big')
      : r.results.map((x) => (x.ok ? 'PASS' : 'fail'))),
  ];
  cells.forEach((c, i) => (widths[i] = Math.max(widths[i], c.length)));
  return cells;
});

console.log(header.map((h, i) => h.padEnd(widths[i])).join('  '));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const cells of body) console.log(cells.map((c, i) => c.padEnd(widths[i])).join('  '));

// Which strategy carried each pass -- an as-is pass is robust, one that needed a
// 3x upscale is on the edge of not working at all.
console.log('\nhow each pass decoded:');
for (const r of rows) {
  if (r.tooBig) continue;
  const notes = r.results.filter((x) => x.ok).map((x) => `${x.platform}: ${x.strategy}`);
  if (notes.length > 0) console.log(`  ECC ${r.ecc} @ ${r.modulePx}px -- ${notes.join('; ')}`);
}

const survivors = rows.filter((r) => !r.tooBig && r.results.every((x) => x.ok));
console.log(
  `\n${survivors.length} configuration(s) survived every simulated platform` +
    (survivors.length > 0
      ? `: ${survivors.map((r) => `ECC ${r.ecc} @ ${r.modulePx}px (${r.matrix.sizePx}px stamp)`).join(', ')}`
      : ''),
);
if (args.emit) {
  console.log(
    `\nwritten to ${args.emit}/\n` +
      `  upload-me__*.png          post these, save them back, then:\n` +
      `                              node tools/qrDecodeImage.mjs <the saved files>\n` +
      `  simulated-failure__*.jpg  how the failures above actually broke`,
  );
}

// A sweep where nothing survives is a real result and should be loud.
process.exit(rows.some((r) => !r.tooBig && r.results.some((x) => x.ok)) ? 0 : 1);
