#!/usr/bin/env node
'use strict';

// compress-media CLI — compresses files directly (no server needed), or starts the web UI.
// Run `compress-media --help` for usage.

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { parseArgs } = require('node:util');
const pkg = require('../package.json');
const media = require('../lib/media');

const HELP = `compress-media ${pkg.version} — compress video, images and audio

Usage:
  compress-media [options] <file|dir>...   compress files (results are written next to each input)
  compress-media probe <file>... [--json]  show size, duration, resolution, fps and codecs (decide settings first)
  compress-media info [--json]             show detected capabilities (hardware encoder, HEIC support)
  compress-media serve [--port N] [--host H]   start the web UI (default http://127.0.0.1:4747)
  compress-media worker                    run a queue worker only (needs QUEUE=redis and REDIS_URL)

Output:
  -o, --out-dir <dir>        write results into <dir> (sub-folders are mirrored with -r)
      --suffix=<text>        appended to the file name (default: "-compressed")
      --overwrite            replace existing output files (default: fail that file)
  -r, --recursive            descend into sub-directories
      --skip-larger          delete results that are not smaller than the input (status "skipped")
      --json                 print a machine-readable JSON report on stdout
  -q, --quiet                no progress output

Video (MOV, MP4, MKV, WebM, AVI… → MP4, WebM or GIF):
      --video-format <f>     mp4 | webm | gif                          (default: mp4)
      --quality <q>          high | balanced | small | tiny            (default: balanced)
      --target-mb <n>        aim for a total size of n MB (two-pass, overrides --quality, CPU)
      --codec <c>            mp4: h264 (plays everywhere) | h265 (30–50% smaller) | av1 (smallest)
                             webm: vp9 | av1                           (default: h264 / vp9)
      --hw                   hardware encoder: VideoToolbox, NVENC, Quick Sync, VA-API, AMF (see info)
      --start <t>, --end <t> keep only this part; seconds or [hh:]mm:ss, e.g. --start 5 --end 1:30
      --speed <s>            fast | medium | slow — CPU encoder effort  (default: medium)
      --max-res <n>          cap the short side, e.g. 1080, 720        (default: keep)
      --fps <n>              cap the frame rate, e.g. 30               (default: keep)
      --audio <a>            keep | low (64 kbps mono) | remove        (default: keep)

Images (JPG, PNG, WebP, AVIF, HEIC, GIF, TIFF):
      --image-format <f>     auto | jpeg | webp | avif | png  (auto keeps the format; HEIC → JPEG)
      --image-quality <n>    1–100                                     (default: 78)
      --max-dim <n>          cap the long edge in pixels, e.g. 1920    (default: keep)
      --keep-metadata        keep EXIF/GPS (stripped by default)

Audio (WAV, M4A, FLAC, AIFF, MP3…):
      --audio-format <f>     mp3 | m4a | opus                          (default: mp3)
      --bitrate <kbps>       32 | 48 | 64 | 96 | 128 | 160 | 192 | 256 (default: 128)
      --mono                 downmix to mono

PDF (needs Ghostscript; included in the Docker image):
      --pdf-quality <q>      screen (72 dpi images) | ebook (150) | printer (300) | prepress  (default: ebook)
      --grayscale            convert pages to grayscale

  -h, --help                 show this help
  -v, --version              show the version

Exit codes: 0 = every file succeeded (or was skipped), 1 = at least one file failed, 2 = bad usage.

Examples:
  compress-media "Screen Recording.mov" --max-res 1080 --fps 30
  compress-media clip.mov --target-mb 25                      # fit an email attachment
  compress-media demo.mov --start 0:04 --end 0:19 --video-format gif --max-res 480   # a GIF for an issue
  compress-media ~/Pictures/trip -r --image-format webp --max-dim 2048 -o ~/Desktop/web
  compress-media voice.wav --audio-format opus --bitrate 48 --mono
  compress-media cv.pdf --pdf-quality ebook
  compress-media *.mov --json > report.json
`;

/** @type {import('node:util').ParseArgsConfig['options']} */
const OPTIONS = {
  'out-dir': { type: 'string', short: 'o' },
  suffix: { type: 'string', default: '-compressed' },
  overwrite: { type: 'boolean' },
  recursive: { type: 'boolean', short: 'r' },
  'skip-larger': { type: 'boolean' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  quality: { type: 'string' },
  'target-mb': { type: 'string' },
  codec: { type: 'string' },
  'video-format': { type: 'string' },
  start: { type: 'string' },
  end: { type: 'string' },
  hw: { type: 'boolean' },
  speed: { type: 'string' },
  'max-res': { type: 'string' },
  fps: { type: 'string' },
  audio: { type: 'string' },
  'image-format': { type: 'string' },
  'image-quality': { type: 'string' },
  'max-dim': { type: 'string' },
  'keep-metadata': { type: 'boolean' },
  'audio-format': { type: 'string' },
  bitrate: { type: 'string' },
  mono: { type: 'boolean' },
  'pdf-quality': { type: 'string' },
  grayscale: { type: 'boolean' },
  port: { type: 'string' },
  host: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

class UsageError extends Error {}

function oneOf(name, value, allowed) {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) throw new UsageError(`--${name} must be one of: ${allowed.join(', ')} (got "${value}")`);
  return value;
}

function positiveNumber(name, value, { max = Infinity } = {}) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!(n > 0) || n > max) throw new UsageError(`--${name} must be a number between 1 and ${max} (got "${value}")`);
  return n;
}

/** Maps CLI flags onto the per-kind option objects used by lib/media.js (same shape as the web UI). */
function buildOptions(v) {
  const targetMB = positiveNumber('target-mb', v['target-mb']);
  const speed = oneOf('speed', v.speed, ['fast', 'medium', 'slow']);
  const videoFormat = oneOf('video-format', v['video-format'], ['mp4', 'webm', 'gif']) || 'mp4';
  const codec = oneOf('codec', v.codec, videoFormat === 'webm' ? ['vp9', 'av1'] : ['h264', 'h265', 'av1']);
  for (const flag of ['start', 'end']) {
    if (v[flag] !== undefined && Number.isNaN(media.parseTime(v[flag]) ?? NaN)) {
      throw new UsageError(`--${flag} must be seconds or [hh:]mm:ss (got "${v[flag]}")`);
    }
  }
  if (v.start !== undefined && v.end !== undefined && media.parseTime(v.end) <= media.parseTime(v.start)) {
    throw new UsageError('--end must be after --start');
  }
  const bitrate = v.bitrate === undefined ? 128 : Number(oneOf('bitrate', v.bitrate, ['32', '48', '64', '96', '128', '160', '192', '256']));
  return {
    video: {
      format: videoFormat,
      quality: targetMB ? 'target' : oneOf('quality', v.quality, ['high', 'balanced', 'small', 'tiny']) || 'balanced',
      targetMB,
      codec: codec || (videoFormat === 'webm' ? 'vp9' : 'h264'),
      encoder: v.hw ? 'hardware' : 'cpu',
      speed: speed === 'fast' ? 'veryfast' : speed || 'medium',
      resolution: positiveNumber('max-res', v['max-res']) || 0,
      fps: positiveNumber('fps', v.fps, { max: 240 }) || 0,
      audio: oneOf('audio', v.audio, ['keep', 'low', 'remove']) || 'keep',
      trimStart: v.start,
      trimEnd: v.end,
    },
    image: {
      format: oneOf('image-format', v['image-format'], ['auto', 'jpeg', 'jpg', 'webp', 'avif', 'png'])?.replace('jpg', 'jpeg') || 'auto',
      quality: positiveNumber('image-quality', v['image-quality'], { max: 100 }) || 78,
      maxDim: positiveNumber('max-dim', v['max-dim']) || 0,
      keepMetadata: !!v['keep-metadata'],
    },
    audio: {
      format: oneOf('audio-format', v['audio-format'], ['mp3', 'm4a', 'opus']) || 'mp3',
      bitrate,
      mono: !!v.mono,
    },
    pdf: {
      quality: oneOf('pdf-quality', v['pdf-quality'], ['screen', 'ebook', 'printer', 'prepress']) || 'ebook',
      grayscale: !!v.grayscale,
    },
  };
}

/**
 * Expands the positional arguments into media files: [{ file, rel }], where `rel` is the
 * file's folder relative to the directory argument it was found in ('' for direct files).
 */
async function collectInputs(args, recursive, suffix) {
  const files = [];
  let root = '';
  const visit = async (p, fromDir) => {
    let stat;
    try {
      stat = await fsp.stat(p);
    } catch {
      if (fromDir) return;
      throw new UsageError(`No such file or directory: ${p}`);
    }
    if (stat.isDirectory()) {
      if (fromDir && !recursive) return;
      for (const name of (await fsp.readdir(p)).sort()) {
        if (!name.startsWith('.')) await visit(path.join(p, name), true);
      }
      return;
    }
    // Inside directories, only pick up media we can handle and skip our own previous outputs.
    if (fromDir && (!media.detectKind(p) || path.parse(p).name.endsWith(suffix))) return;
    const file = path.resolve(p);
    files.push({ file, rel: fromDir ? path.relative(root, path.dirname(file)) : '' });
  };
  for (const arg of args) {
    root = path.resolve(arg);
    await visit(arg, false);
  }
  const seen = new Set();
  return files.filter((f) => !seen.has(f.file) && seen.add(f.file));
}

/**
 * Picks an output folder and file stem for every input so that no two results collide,
 * e.g. photo.png + photo.heic → photo-png-compressed.webp + photo-heic-compressed.webp.
 */
function planOutputs(inputs, outDir) {
  const plans = inputs.map(({ file, rel }) => ({
    input: file,
    outDir: outDir ? path.join(outDir, rel) : path.dirname(file),
    stem: path.parse(file).name,
  }));
  // Case-insensitive, since macOS and Windows file systems usually are.
  const key = (p) => `${p.outDir}\0${p.stem}`.toLowerCase();
  const groups = new Map();
  for (const p of plans) groups.set(key(p), [...(groups.get(key(p)) || []), p]);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const p of group) p.stem = `${p.stem}-${path.extname(p.input).slice(1).toLowerCase()}`;
    const again = new Map();
    for (const p of group) again.set(key(p), [...(again.get(key(p)) || []), p]);
    for (const same of again.values()) if (same.length > 1) same.forEach((p, i) => { p.stem += `-${i + 1}`; });
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Progress output
// ---------------------------------------------------------------------------

const fmtBytes = (n) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
};

function createReporter({ quiet, total }) {
  const tty = process.stderr.isTTY && !quiet;
  const active = new Map();
  let lastDraw = 0;
  const clear = () => { if (tty) process.stderr.write('\r\x1b[2K'); };
  const draw = () => {
    if (!tty || !active.size) return;
    const [name, p] = [...active.entries()].at(-1);
    const parts = [`${Math.round(p.progress * 100)}%`];
    if (p.speed) parts.push(`${p.speed.toFixed(1)}×`);
    if (p.eta != null && p.progress > 0.02) parts.push(`~${p.eta}s left`);
    clear();
    process.stderr.write(`  ${name}  ${parts.join(' · ')}`.slice(0, process.stderr.columns - 1 || 100));
  };
  return {
    progress(name, p) {
      active.set(name, p);
      if (Date.now() - lastDraw > 150) { lastDraw = Date.now(); draw(); }
    },
    done(index, r) {
      active.delete(path.basename(r.input));
      if (quiet) return;
      clear();
      const label = `[${index}/${total}] ${path.basename(r.input)}`;
      let line;
      if (r.status === 'error') line = `✗ ${label}: ${r.error}`;
      else if (r.status === 'skipped') line = `– ${label}: ${r.reason}`;
      else {
        const pct = Math.round((1 - r.outputSize / r.inputSize) * 100);
        line = `✓ ${label}  ${fmtBytes(r.inputSize)} → ${fmtBytes(r.outputSize)}  (${pct >= 0 ? '−' : '+'}${Math.abs(pct)}%)  ${path.relative(process.cwd(), r.output) || r.output}`;
        if (r.larger) line += '  ⚠ not smaller than the original';
      }
      process.stderr.write(`${line}\n`);
      draw();
    },
  };
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

const running = new Set(); // ffmpeg processes, killed on Ctrl+C
const partials = new Set(); // half-written outputs, removed on Ctrl+C

async function compressOne({ input, outDir, stem }, opts, tmpDir, reporter) {
  const kind = media.detectKind(input);
  const started = Date.now();
  const inputSize = fs.statSync(input).size;
  const base = { input, kind, inputSize };
  if (!kind) return { ...base, status: 'error', error: 'Unsupported file type' };

  const name = `${stem}${path.extname(input)}`;
  await fsp.mkdir(outDir, { recursive: true });
  const predicted = predictExt(kind, opts.media[kind]);
  if (predicted && !opts.overwrite) {
    const existing = path.join(outDir, outputName(name, predicted, opts.suffix));
    if (fs.existsSync(existing)) return { ...base, status: 'error', error: `${existing} already exists (use --overwrite)` };
  }
  let partial;
  try {
    const out = await media.compress({
      kind,
      input,
      options: opts.media[kind],
      // Write to "<name>.partial.<ext>" and rename at the end, so an interrupted run never
      // leaves a truncated file under the final name. The extension stays last for ffmpeg/sharp.
      outputPath: (ext) => {
        partial = path.join(outDir, outputName(name, ext, opts.suffix).replace(/\.([^.]+)$/, '.partial.$1'));
        partials.add(partial);
        return partial;
      },
      tempPath: (suffix) => path.join(tmpDir, `${process.pid}-${Math.random().toString(36).slice(2)}-${suffix}`),
      onSpawn: (proc) => { running.add(proc); proc.on('close', () => running.delete(proc)); },
      onProgress: (p) => reporter.progress(path.basename(input), p),
    });
    const output = path.join(outDir, outputName(name, out.ext, opts.suffix));
    if (path.resolve(output) === path.resolve(input)) throw new Error('Output would overwrite the input; use --suffix or --out-dir');
    if (fs.existsSync(output) && !opts.overwrite) throw new Error(`${output} already exists (use --overwrite)`);
    const outputSize = fs.statSync(out.file).size;
    const larger = outputSize >= inputSize;
    if (larger && opts.skipLarger) {
      await fsp.rm(out.file, { force: true });
      partials.delete(partial);
      return { ...base, status: 'skipped', reason: 'result was not smaller than the original', outputSize, durationMs: Date.now() - started };
    }
    await fsp.rename(out.file, output);
    partials.delete(partial);
    return {
      ...base,
      status: 'done',
      output,
      outputSize,
      saved: inputSize - outputSize,
      ratio: Number((outputSize / inputSize).toFixed(4)),
      larger,
      durationMs: Date.now() - started,
      options: opts.media[kind],
      info: out.info,
    };
  } catch (err) {
    if (partial) {
      await fsp.rm(partial, { force: true }).catch(() => {});
      partials.delete(partial);
    }
    return { ...base, status: 'error', error: err.message || String(err), durationMs: Date.now() - started };
  }
}

/** Output extension when it is known up front (image "auto" depends on the decoded input). */
function predictExt(kind, o) {
  if (kind === 'video') return o.format === 'gif' ? 'gif' : o.format === 'webm' ? 'webm' : 'mp4';
  if (kind === 'audio') return { mp3: 'mp3', m4a: 'm4a', opus: 'ogg' }[o.format];
  if (kind === 'pdf') return 'pdf';
  if (o.format && o.format !== 'auto') return o.format === 'jpeg' ? 'jpg' : o.format;
  return null;
}

function outputName(inputName, ext, suffix) {
  return media.outputName(inputName, ext).replace(/-compressed(\.[^.]+)$/, `${suffix}$1`);
}

/** Images are cheap and run in parallel; video/audio run one at a time (ffmpeg uses every core). */
async function runAll(plans, opts, reporter) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'compress-media-'));
  let finished = 0;
  const pool = async (indexes, size) => {
    const queue = [...indexes];
    await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) {
        const i = queue.shift();
        results[i] = await compressOne(plans[i], opts, tmpDir, reporter);
        reporter.done(++finished, results[i]);
      }
    }));
  };
  const results = new Array(plans.length);
  const idx = plans.map((_, i) => i);
  const isImage = (i) => media.detectKind(plans[i].input) === 'image';
  try {
    await Promise.all([pool(idx.filter(isImage), 4), pool(idx.filter((i) => !isImage(i)), 1)]);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function probeFile(file) {
  const kind = media.detectKind(file);
  const size = fs.statSync(file).size;
  if (!kind) return { file, kind: null, size, error: 'Unsupported file type' };
  try {
    if (kind === 'pdf') return { file, kind, size, pages: await media.pdfPages(file) };
    if (kind === 'image') {
      if (/\.(heic|heif)$/i.test(file)) return { file, kind, size, format: 'heic' };
      const sharp = require('sharp');
      const m = await sharp(file, { animated: true }).metadata();
      return { file, kind, size, format: m.format, width: m.width, height: m.pageHeight || m.height, animated: (m.pages || 1) > 1, hasMetadata: !!(m.exif || m.icc) };
    }
    const p = await media.probe(file);
    const out = { file, kind, size, duration: Number(p.duration.toFixed(2)), bitrateKbps: Math.round(p.bitrate / 1000) };
    if (kind === 'video') Object.assign(out, { width: p.width, height: p.height, fps: Number(p.fps.toFixed(2)), videoCodec: p.videoCodec });
    Object.assign(out, { audioCodec: p.audioCodec || null, audioChannels: p.audioChannels });
    return out;
  } catch (err) {
    return { file, kind, size, error: err.message.split('\n')[0] };
  }
}

async function cmdProbe(files, json) {
  if (!files.length) throw new UsageError('probe needs at least one file');
  const missing = files.find((f) => !fs.existsSync(f));
  if (missing) throw new UsageError(`No such file: ${missing}`);
  await media.detectCapabilities();
  const results = [];
  for (const f of files) results.push(await probeFile(path.resolve(f)));
  if (json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  else {
    for (const r of results) {
      const bits = [r.kind || 'unsupported', fmtBytes(r.size)];
      if (r.width) bits.push(`${r.width}×${r.height}`);
      if (r.fps) bits.push(`${r.fps} fps`);
      if (r.duration) bits.push(`${r.duration}s`);
      if (r.videoCodec) bits.push(r.videoCodec);
      if (r.bitrateKbps) bits.push(`${r.bitrateKbps} kbps`);
      if (r.audioCodec) bits.push(`audio ${r.audioCodec}${r.audioChannels === 1 ? ' mono' : ''}`);
      if (r.format && r.kind === 'image') bits.push(r.format + (r.animated ? ' (animated)' : ''));
      if (r.pages) bits.push(`${r.pages} page${r.pages === 1 ? '' : 's'}`);
      if (r.error) bits.push(`error: ${r.error}`);
      console.log(`${path.relative(process.cwd(), r.file) || r.file}: ${bits.join(' · ')}`);
    }
  }
  return results.some((r) => r.error) ? 1 : 0;
}

async function cmdInfo(json) {
  const caps = await media.detectCapabilities();
  const info = {
    version: pkg.version,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    ffmpeg: media.ffmpegPath,
    ffprobe: media.ffprobePath,
    hardwareEncoder: caps.hardwareEncoder,
    hardwareName: caps.hardwareName,
    hardwareCodecs: caps.hardwareCodecs,
    av1: caps.av1,
    webm: caps.webm,
    pdf: caps.pdf,
    heicDecoder: caps.heicDecoder,
    formats: media.EXT,
  };
  if (json) process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  else {
    console.log(`compress-media ${info.version} (${info.platform}, node ${info.node})`);
    console.log(`ffmpeg:            ${info.ffmpeg}`);
    console.log(`hardware encoder:  ${info.hardwareEncoder ? `${info.hardwareName} (${info.hardwareCodecs.join(', ')}) — use --hw` : 'none (CPU only)'}`);
    console.log(`AV1 / WebM / GIF:  ${info.av1 ? 'yes' : 'no'} / ${info.webm ? 'yes' : 'no'} / yes`);
    console.log(`PDF compression:   ${info.pdf ? 'yes (Ghostscript)' : 'no — install Ghostscript or use Docker'}`);
    console.log(`HEIC photos:       ${info.heicDecoder ? `yes (${info.heicDecoder})` : 'no — install libheif or use Docker'}`);
    for (const [kind, exts] of Object.entries(info.formats)) console.log(`${`${kind}:`.padEnd(19)}${exts.join(' ')}`);
  }
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values: v, positionals } = parsed;
  if (v.help) return void process.stdout.write(HELP);
  if (v.version) return void console.log(pkg.version);

  const [command, ...rest] = positionals;
  if (command === 'info' && !rest.length) return cmdInfo(v.json);
  if (command === 'probe') return cmdProbe(rest, v.json);
  if (command === 'serve' && !rest.length) {
    const server = require('../server');
    await server.start({
      port: positiveNumber('port', v.port, { max: 65535 }) || Number(process.env.PORT) || 4747,
      host: v.host || process.env.HOST || '127.0.0.1',
    });
    return 'serving';
  }
  if (command === 'worker' && !rest.length) {
    process.env.ROLE = 'worker'; // read when server.js loads
    await require('../server').start({ role: 'worker' });
    return 'serving';
  }
  if (!positionals.length) throw new UsageError('No input files. Run `compress-media --help` for usage.');

  const opts = {
    media: buildOptions(v),
    outDir: v['out-dir'] && path.resolve(v['out-dir']),
    suffix: v.suffix,
    overwrite: !!v.overwrite,
    skipLarger: !!v['skip-larger'],
  };
  if (!opts.suffix && !opts.outDir) throw new UsageError('An empty --suffix needs --out-dir, or outputs would replace the inputs');
  const inputs = await collectInputs(positionals, !!v.recursive, opts.suffix || '-compressed');
  if (!inputs.length) throw new UsageError('No supported media files found.');
  const plans = planOutputs(inputs, opts.outDir);
  try {
    await media.detectCapabilities();
  } catch (err) {
    throw new Error(err.message);
  }
  if (v.hw && !media.caps.hardwareEncoder && !v.quiet) {
    process.stderr.write('note: no hardware encoder on this system, using the CPU encoder\n');
  }

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const reporter = createReporter({ quiet: !!v.quiet, total: plans.length });
  const results = await runAll(plans, opts, reporter);

  const done = results.filter((r) => r.status === 'done');
  const failed = results.filter((r) => r.status === 'error');
  const totals = {
    files: results.length,
    done: done.length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: failed.length,
    inputSize: done.reduce((s, r) => s + r.inputSize, 0),
    outputSize: done.reduce((s, r) => s + r.outputSize, 0),
  };
  totals.saved = totals.inputSize - totals.outputSize;

  if (v.json) {
    process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, totals, results }, null, 2)}\n`);
  } else if (!v.quiet && results.length > 1) {
    const pct = totals.inputSize ? Math.round((totals.saved / totals.inputSize) * 100) : 0;
    process.stderr.write(`\n${totals.done} done, ${totals.skipped} skipped, ${totals.failed} failed · saved ${fmtBytes(Math.max(0, totals.saved))} (${pct}%)\n`);
  }
  return failed.length ? 1 : 0;
}

function onSignal() {
  for (const proc of running) proc.kill('SIGKILL');
  for (const p of partials) try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  process.stderr.write('\ninterrupted\n');
  process.exit(130);
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { if (code !== 'serving') process.exitCode = Number(code ?? 0); },
    (err) => {
      if (err instanceof UsageError) {
        process.stderr.write(`compress-media: ${err.message}\n`);
        process.exitCode = 2;
      } else {
        process.stderr.write(`compress-media: ${err.stack || err}\n`);
        process.exitCode = 1;
      }
    },
  );
}

module.exports = { main, buildOptions };
