'use strict';

// Media pipeline shared by the web server (server.js) and the CLI (bin/cli.js):
// file-type detection, capability detection, ffprobe, and the video / audio / image encoders.

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const sharp = require('sharp');

const execFileAsync = promisify(execFile);

const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');
const ffprobePath = process.env.FFPROBE_PATH || require('@ffprobe-installer/ffprobe').path;

// ---------------------------------------------------------------------------
// File types
// ---------------------------------------------------------------------------

const EXT = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff', 'heic', 'heif', 'gif', 'bmp'],
  video: ['mov', 'mp4', 'm4v', 'mkv', 'avi', 'webm', 'wmv', 'flv', '3gp', 'mts', 'm2ts', 'ts', 'mpg', 'mpeg', 'ogv'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'caf', 'wma', 'amr'],
};

/** @returns {'image'|'video'|'audio'|null} */
function detectKind(filename, mimetype = '') {
  const ext = path.extname(filename).slice(1).toLowerCase();
  for (const [kind, list] of Object.entries(EXT)) if (list.includes(ext)) return kind;
  const top = mimetype.split('/')[0];
  if (['image', 'video', 'audio'].includes(top)) return top;
  return null;
}

/** "clip.mov" + "mp4" → "clip-compressed.mp4" (unsafe characters replaced). */
function outputName(inputName, ext) {
  const base = path.parse(inputName).name.replace(/[^\p{L}\p{N}._ -]+/gu, '_') || 'file';
  return `${base}-compressed.${ext}`;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Filled in by detectCapabilities(). */
const caps = { hardwareEncoder: false, heicDecoder: null };

async function commandExists(cmd, args = ['--version']) {
  try {
    await execFileAsync(cmd, args, { timeout: 5000 });
    return true;
  } catch (err) {
    return err.code !== 'ENOENT' && typeof err.code !== 'string';
  }
}

let detected;
/** Checks binaries once and fills `caps`. Safe to call repeatedly. */
function detectCapabilities() {
  detected ??= (async () => {
    if (!fs.existsSync(ffmpegPath)) {
      throw new Error(`ffmpeg not found at ${ffmpegPath} — run \`npm rebuild ffmpeg-static\` or set FFMPEG_PATH`);
    }
    // Some npm-installed binaries (notably @ffprobe-installer on Linux) lose the executable bit.
    for (const bin of [ffmpegPath, ffprobePath]) {
      try {
        fs.accessSync(bin, fs.constants.X_OK);
      } catch {
        try { fs.chmodSync(bin, 0o755); } catch { /* reported when it fails to spawn */ }
      }
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync(ffmpegPath, ['-hide_banner', '-encoders'], { maxBuffer: 4 * 1024 * 1024 });
      caps.hardwareEncoder = stdout.includes('h264_videotoolbox');
      caps.heicDecoder = 'sips';
    } else if (await commandExists('heif-dec')) {
      caps.heicDecoder = 'heif-dec';
    } else if (await commandExists('heif-convert')) {
      caps.heicDecoder = 'heif-convert';
    }
    return caps;
  })();
  return detected;
}

// ---------------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------------

async function probe(file) {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { maxBuffer: 16 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const v = data.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = data.streams.find((s) => s.codec_type === 'audio');
  const fraction = (str) => {
    const [n, d] = String(str || '0/1').split('/').map(Number);
    return d ? n / d : 0;
  };
  let width = v?.width || 0;
  let height = v?.height || 0;
  const rotation = Math.abs(Number(v?.side_data_list?.find((s) => s.rotation != null)?.rotation ?? v?.tags?.rotate ?? 0));
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  return {
    duration: Number(data.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0,
    bitrate: Number(data.format?.bit_rate) || 0,
    hasVideo: !!v,
    hasAudio: !!a,
    width,
    height,
    fps: fraction(v?.avg_frame_rate) || fraction(v?.r_frame_rate),
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    audioChannels: a?.channels || 0,
  };
}

function runFfmpeg(task, args, duration) {
  return new Promise((resolve, reject) => {
    // The task may have been cancelled while we were probing the input.
    if (task.isCancelled?.()) return reject(new Error('Cancelled'));
    const startedAt = Date.now();
    const proc = spawn(ffmpegPath, [
      '-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', '-loglevel', 'error', ...args,
    ]);
    task.onSpawn?.(proc);
    let stderr = '';
    let buf = '';
    const state = { progress: 0, speed: null, eta: null };
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    proc.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const [key, value] = line.split('=');
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const sec = Number(value) / 1e6;
          if (duration > 0 && Number.isFinite(sec) && sec >= 0) {
            state.progress = Math.min(0.99, sec / duration);
            const elapsed = (Date.now() - startedAt) / 1000;
            if (state.progress > 0.01) state.eta = Math.round(elapsed / state.progress - elapsed);
          }
        } else if (key === 'speed') {
          const s = parseFloat(value);
          if (Number.isFinite(s)) state.speed = s;
        } else if (key === 'progress') {
          task.onProgress?.({ ...state });
        }
      }
    });
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      if (code === 0) return resolve();
      if (signal === 'SIGKILL' || task.isCancelled?.()) return reject(new Error('Cancelled'));
      const msg = stderr.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited with ${code ?? signal}`;
      reject(new Error(msg));
    });
  });
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

const VIDEO_QUALITY = {
  // CRF for software encoders, -q:v (0..100, higher = better) for VideoToolbox
  high: { x264: 21, x265: 24, vt: 65 },
  balanced: { x264: 24, x265: 27, vt: 55 },
  small: { x264: 28, x265: 30, vt: 45 },
  tiny: { x264: 32, x265: 34, vt: 35 },
};

const AUDIO_BITRATE = { keep: 128, low: 64, remove: 0 };

async function compressVideo(task) {
  const o = task.options;
  const info = await probe(task.input);
  if (!info.hasVideo) throw new Error('No video stream found in this file');

  const codec = o.codec === 'h265' ? 'h265' : 'h264';
  // VideoToolbox overshoots bitrate targets badly, so target-size mode always uses x264/x265.
  const hw = caps.hardwareEncoder && o.encoder === 'hardware' && o.quality !== 'target';
  const quality = VIDEO_QUALITY[o.quality] || VIDEO_QUALITY.balanced;
  const args = ['-i', task.input, '-map', '0:v:0'];

  const audioKbps = info.hasAudio ? (AUDIO_BITRATE[o.audio] ?? 128) : 0;
  if (audioKbps) args.push('-map', '0:a:0?');

  // Filters: downscale (limit the short side) and cap frame rate
  const filters = [];
  const maxShort = Number(o.resolution) || 0;
  const shortSide = Math.min(info.width, info.height);
  if (maxShort && shortSide > maxShort) {
    filters.push(info.width >= info.height ? `scale=-2:${maxShort}` : `scale=${maxShort}:-2`);
  }
  const fpsCap = Number(o.fps) || 0;
  if (fpsCap && info.fps > fpsCap + 0.5) filters.push(`fps=${fpsCap}`);
  filters.push('format=yuv420p');
  args.push('-vf', filters.join(','));

  // Encoder
  let targetKbps = 0;
  if (o.quality === 'target') {
    const mb = Number(o.targetMB);
    if (!(mb > 0)) throw new Error('Invalid target size');
    if (!(info.duration > 0)) throw new Error('Could not read the video duration to compute a bitrate');
    targetKbps = Math.floor((mb * 8192 * 0.96) / info.duration - audioKbps);
    if (targetKbps < 50) throw new Error(`${mb} MB is too small for a ${Math.round(info.duration)}-second video`);
  }

  if (hw) {
    args.push('-c:v', codec === 'h265' ? 'hevc_videotoolbox' : 'h264_videotoolbox');
    args.push('-q:v', String(quality.vt));
    args.push('-allow_sw', '1');
  } else {
    args.push('-c:v', codec === 'h265' ? 'libx265' : 'libx264');
    args.push('-preset', ['ultrafast', 'veryfast', 'fast', 'medium', 'slow'].includes(o.speed) ? o.speed : 'medium');
    if (targetKbps) args.push('-b:v', `${targetKbps}k`, '-maxrate', `${Math.round(targetKbps * 1.5)}k`, '-bufsize', `${targetKbps * 2}k`);
    else args.push('-crf', String(codec === 'h265' ? quality.x265 : quality.x264));
    if (codec === 'h265') args.push('-x265-params', 'log-level=error');
  }
  if (codec === 'h265') args.push('-tag:v', 'hvc1'); // required for QuickTime / Safari playback

  if (audioKbps) {
    args.push('-c:a', 'aac', '-b:a', `${audioKbps}k`);
    if (o.audio === 'low') args.push('-ac', '1');
  } else {
    args.push('-an');
  }

  const file = task.outputPath('mp4');
  args.push('-map_metadata', '0', '-movflags', '+faststart', file);
  await runFfmpeg(task, args, info.duration);
  return { file, ext: 'mp4', mime: 'video/mp4', info };
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

const AUDIO_FORMATS = {
  mp3: { ext: 'mp3', mime: 'audio/mpeg', codec: ['-c:a', 'libmp3lame'] },
  m4a: { ext: 'm4a', mime: 'audio/mp4', codec: ['-c:a', 'aac', '-movflags', '+faststart'] },
  opus: { ext: 'ogg', mime: 'audio/ogg', codec: ['-c:a', 'libopus', '-vbr', 'on'] },
};

async function compressAudio(task) {
  const o = task.options;
  const info = await probe(task.input);
  if (!info.hasAudio) throw new Error('No audio stream found in this file');
  const fmt = AUDIO_FORMATS[o.format] || AUDIO_FORMATS.mp3;
  const kbps = [32, 48, 64, 96, 128, 160, 192, 256].includes(Number(o.bitrate)) ? Number(o.bitrate) : 128;
  const args = ['-i', task.input, '-map', '0:a:0', '-vn', ...fmt.codec, '-b:a', `${kbps}k`];
  if (o.mono) args.push('-ac', '1');
  if (o.format === 'opus') args.push('-ar', '48000');
  const file = task.outputPath(fmt.ext);
  args.push('-map_metadata', '0', file);
  await runFfmpeg(task, args, info.duration);
  return { file, ext: fmt.ext, mime: fmt.mime, info };
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const IMAGE_MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif' };

/**
 * sharp's prebuilt libvips reads HEIC headers but can't decode the pixels (patent-encumbered),
 * so HEIC/HEIF goes through an external decoder: `sips` on macOS, libheif's CLI elsewhere.
 */
async function loadImageInput(task) {
  if (!/\.(heic|heif)$/i.test(task.input)) {
    return { input: task.input, meta: await sharp(task.input).metadata() };
  }
  if (!caps.heicDecoder) throw new Error('HEIC needs a decoder on this system — install libheif (heif-dec on PATH) or run the Docker image');
  const tmp = task.tempPath('decoded.png');
  const args = caps.heicDecoder === 'sips' ? ['-s', 'format', 'png', task.input, '--out', tmp] : [task.input, tmp];
  await execFileAsync(caps.heicDecoder, args);
  return { input: tmp, meta: await sharp(tmp).metadata(), heic: true };
}

async function compressImage(task) {
  const o = task.options;
  const { input, meta, heic } = await loadImageInput(task);
  const animated = (meta.pages || 1) > 1;
  const info = { width: meta.width, height: meta.pageHeight || meta.height, format: heic ? 'heic' : meta.format, animated };

  let format = o.format;
  if (!format || format === 'auto') {
    const src = heic ? 'heic' : meta.format;
    if (src === 'png') format = 'png';
    else if (src === 'webp') format = 'webp';
    else if (src === 'avif') format = 'avif';
    else if (src === 'gif') format = animated ? 'gif' : 'png';
    else format = 'jpeg';
  }
  if (!IMAGE_MIME[format]) throw new Error(`Unsupported output format: ${format}`);
  const q = Math.min(100, Math.max(1, Number(o.quality) || 78));

  let img = sharp(input, { animated: animated && ['gif', 'webp'].includes(format), limitInputPixels: false }).rotate();
  const maxDim = Number(o.maxDim) || 0;
  if (maxDim) img = img.resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });
  if (o.keepMetadata) img = img.keepMetadata();
  if (format === 'jpeg') img = img.flatten({ background: '#ffffff' });

  switch (format) {
    case 'jpeg':
      img = img.jpeg({ quality: q, mozjpeg: true, progressive: true });
      break;
    case 'webp':
      img = img.webp({ quality: q, effort: 5, smartSubsample: true });
      break;
    case 'avif':
      img = img.avif({ quality: Math.max(1, q - 20), effort: 5 });
      break;
    case 'png':
      // Lossy palette quantisation (like pngquant) unless quality is maxed out
      img = q >= 100 ? img.png({ compressionLevel: 9, effort: 10 }) : img.png({ compressionLevel: 9, palette: true, quality: q, effort: 10 });
      break;
    case 'gif':
      img = img.gif({ effort: 10, colours: q >= 90 ? 256 : q >= 70 ? 128 : 64, interFrameMaxError: q >= 90 ? 0 : 8, reuse: true });
      break;
  }
  task.onProgress?.({ progress: 0.5, speed: null, eta: null });
  const ext = format === 'jpeg' ? 'jpg' : format;
  const file = task.outputPath(ext);
  try {
    await img.toFile(file);
  } finally {
    if (heic) await fsp.rm(input, { force: true }).catch(() => {});
  }
  return { file, ext, mime: IMAGE_MIME[format], info };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Compresses one file.
 *
 * @param {object} task
 * @param {'video'|'image'|'audio'} task.kind
 * @param {string} task.input                    path of the source file
 * @param {object} task.options                  options for that kind (see README / CLI --help)
 * @param {(ext: string) => string} task.outputPath  where to write, given the output extension
 * @param {(suffix: string) => string} task.tempPath scratch file path (HEIC decoding)
 * @param {(p: {progress: number, speed: number|null, eta: number|null}) => void} [task.onProgress]
 * @param {(proc: import('node:child_process').ChildProcess) => void} [task.onSpawn]
 * @param {() => boolean} [task.isCancelled]
 * @returns {Promise<{file: string, ext: string, mime: string, info: object}>}
 */
async function compress(task) {
  await detectCapabilities();
  const fn = { image: compressImage, video: compressVideo, audio: compressAudio }[task.kind];
  if (!fn) throw new Error(`Unsupported kind: ${task.kind}`);
  return fn(task);
}

module.exports = { EXT, caps, compress, detectCapabilities, detectKind, outputName, probe, ffmpegPath, ffprobePath };
