'use strict';

// Media pipeline shared by the web server (server.js), the queue worker and the CLI (bin/cli.js):
// file-type detection, capability detection, ffprobe, and the video / audio / image / PDF encoders.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const sharp = require('sharp');

/** @typedef {import('./types').Kind} Kind */
/** @typedef {import('./types').CompressTask} CompressTask */
/** @typedef {import('./types').CompressResult} CompressResult */
/** @typedef {import('./types').Capabilities} Capabilities */

const execFileAsync = promisify(execFile);

/** @type {string} */
const ffmpegPath = process.env.FFMPEG_PATH || /** @type {any} */ (require('ffmpeg-static'));
/** @type {string} */
const ffprobePath = process.env.FFPROBE_PATH || require('@ffprobe-installer/ffprobe').path;
const gsPath = process.env.GS_PATH || (process.platform === 'win32' ? 'gswin64c' : 'gs');
const subs = require('./subtitles');

// ---------------------------------------------------------------------------
// File types
// ---------------------------------------------------------------------------

/** File types by kind (`animation` and `subtitles` jobs take images / video or audio). @type {Record<Exclude<Kind, 'animation' | 'subtitles'>, string[]>} */
const EXT = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff', 'heic', 'heif', 'gif', 'bmp'],
  video: ['mov', 'mp4', 'm4v', 'mkv', 'avi', 'webm', 'wmv', 'flv', '3gp', 'mts', 'm2ts', 'ts', 'mpg', 'mpeg', 'ogv'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'caf', 'wma', 'amr'],
  pdf: ['pdf'],
};

/** @returns {Kind | null} */
function detectKind(filename, mimetype = '') {
  const ext = path.extname(filename).slice(1).toLowerCase();
  for (const [kind, list] of Object.entries(EXT)) if (list.includes(ext)) return /** @type {Kind} */ (kind);
  if (mimetype === 'application/pdf') return 'pdf';
  const top = mimetype.split('/')[0];
  if (['image', 'video', 'audio'].includes(top)) return /** @type {Kind} */ (top);
  return null;
}

/** "clip.mov" + "mp4" → "clip-compressed.mp4" (unsafe characters replaced). */
function outputName(inputName, ext) {
  const base = path.parse(inputName).name.replace(/[^\p{L}\p{N}._ -]+/gu, '_') || 'file';
  return `${base}-compressed.${ext}`;
}

/**
 * Parses "90", 90, "1:30", "01:02:03.5" into seconds. Empty values give null.
 * @param {import('./types').TimeValue | undefined | null} value
 */
function parseTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : NaN;
  const parts = String(value).trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  return parts.reduce((sum, p) => sum * 60 + Number(p), 0);
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** @type {Capabilities} */
const caps = { hardwareEncoder: false, hardwareName: null, hardwareCodecs: [], av1: false, webm: false, heicDecoder: null, pdf: false, whisper: null, burnSubtitles: false };

/** Internal: the ffmpeg encoder names behind `caps`. */
const encoders = { av1: /** @type {string|null} */ (null), hardware: /** @type {Record<string,string>} */ ({}) };

async function commandExists(cmd, args = ['--version']) {
  try {
    await execFileAsync(cmd, args, { timeout: 5000 });
    return true;
  } catch (err) {
    return err.code !== 'ENOENT' && typeof err.code !== 'string';
  }
}

// Hardware encoders by family; each is verified with a tiny test encode before being offered.
const HW_FAMILIES = {
  videotoolbox: { h264: 'h264_videotoolbox', h265: 'hevc_videotoolbox' },
  nvenc: { h264: 'h264_nvenc', h265: 'hevc_nvenc', av1: 'av1_nvenc' },
  qsv: { h264: 'h264_qsv', h265: 'hevc_qsv', av1: 'av1_qsv' },
  vaapi: { h264: 'h264_vaapi', h265: 'hevc_vaapi', av1: 'av1_vaapi' },
  amf: { h264: 'h264_amf', h265: 'hevc_amf', av1: 'av1_amf' },
};
const vaapiDevice = () => process.env.VAAPI_DEVICE || '/dev/dri/renderD128';

async function encoderWorks(family, encoder) {
  const pre = family === 'vaapi' ? ['-vaapi_device', vaapiDevice()] : [];
  const vf = family === 'vaapi' ? ['-vf', 'format=nv12,hwupload'] : [];
  try {
    await execFileAsync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', ...pre, '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2', ...vf,
      '-c:v', encoder, '-frames:v', '2', '-f', 'null', '-',
    ], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** @type {Promise<Capabilities> | undefined} */
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
    const { stdout } = await execFileAsync(ffmpegPath, ['-hide_banner', '-encoders'], { maxBuffer: 4 * 1024 * 1024 });
    const has = (name) => new RegExp(`\\s${name}\\s`).test(stdout);

    encoders.av1 = has('libsvtav1') ? 'libsvtav1' : has('libaom-av1') ? 'libaom-av1' : null;
    caps.av1 = !!encoders.av1;
    caps.webm = has('libvpx-vp9') && has('libopus');

    // HW_ENCODER=off disables hardware encoding; a family name forces that one; auto probes.
    const wanted = (process.env.HW_ENCODER || 'auto').toLowerCase();
    if (wanted !== 'off') {
      const order = process.platform === 'darwin' ? ['videotoolbox'] : ['nvenc', 'qsv', 'vaapi', 'amf'];
      for (const family of wanted === 'auto' ? order : [wanted]) {
        const map = HW_FAMILIES[family];
        if (!map || !has(map.h264)) continue;
        // VideoToolbox is always present on Macs; other families need the GPU and driver at runtime.
        if (family !== 'videotoolbox' && !(await encoderWorks(family, map.h264))) continue;
        encoders.hardware = { h264: map.h264 };
        for (const codec of /** @type {const} */ (['h265', 'av1'])) {
          if (map[codec] && has(map[codec]) && (family === 'videotoolbox' || (await encoderWorks(family, map[codec])))) {
            encoders.hardware[codec] = map[codec];
          }
        }
        caps.hardwareEncoder = true;
        caps.hardwareName = family;
        caps.hardwareCodecs = /** @type {any} */ (Object.keys(encoders.hardware));
        break;
      }
    }

    if (process.platform === 'darwin') caps.heicDecoder = 'sips';
    else if (await commandExists('heif-dec')) caps.heicDecoder = 'heif-dec';
    else if (await commandExists('heif-convert')) caps.heicDecoder = 'heif-convert';

    caps.pdf = await commandExists(gsPath, ['--version']);

    // Speech recognition (whisper.cpp) for subtitles; the CLI was called "whisper-cpp"/"main" before 1.7.
    for (const bin of process.env.WHISPER_PATH ? [process.env.WHISPER_PATH] : ['whisper-cli', 'whisper-cpp']) {
      if (await commandExists(bin, ['--help'])) {
        caps.whisper = bin;
        break;
      }
    }
    const { stdout: filters } = await execFileAsync(ffmpegPath, ['-hide_banner', '-filters'], { maxBuffer: 4 * 1024 * 1024 });
    caps.burnSubtitles = /\ssubtitles\s/.test(filters); // needs ffmpeg built with libass
    return caps;
  })();
  return detected;
}

// ---------------------------------------------------------------------------
// Processes
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

/**
 * Runs a process for a task: registers it for cancellation and rejects with its last stderr lines.
 * @param {CompressTask} task
 * @param {string} bin
 * @param {string[]} args
 * @param {(line: string) => void} [onStdoutLine]
 * @param {{ cwd?: string, onStderrLine?: (line: string) => void }} [opts]
 * @returns {Promise<void>}
 */
function run(task, bin, args, onStdoutLine, opts = {}) {
  return new Promise((resolve, reject) => {
    // The task may have been cancelled while we were probing the input.
    if (task.isCancelled?.()) return reject(new Error('Cancelled'));
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd });
    task.onSpawn?.(proc);
    let stderr = '';
    let buf = '';
    let errBuf = '';
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
      if (!opts.onStderrLine) return;
      errBuf += d;
      const lines = errBuf.split('\n');
      errBuf = lines.pop();
      lines.forEach(opts.onStderrLine);
    });
    proc.stdout.on('data', (d) => {
      if (!onStdoutLine) return;
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(onStdoutLine);
    });
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      if (code === 0) return resolve();
      if (signal === 'SIGKILL' || task.isCancelled?.()) return reject(new Error('Cancelled'));
      const msg = stderr.trim().split('\n').filter((l) => !/progress = /.test(l)).slice(-3).join(' ') || `${path.basename(bin)} exited with ${code ?? signal}`;
      reject(new Error(msg));
    });
  });
}

/**
 * Runs ffmpeg and reports progress. `span` maps this run onto part of the overall progress
 * (two-pass encodes report 0–50% and 50–100%).
 * @param {CompressTask} task
 * @param {string[]} args
 * @param {number} duration seconds of output
 * @param {{ from: number, to: number }} [span]
 * @param {{ cwd?: string, stage?: import('./types').Stage }} [opts]
 */
function runFfmpeg(task, args, duration, span = { from: 0, to: 1 }, opts = {}) {
  const startedAt = Date.now();
  /** @type {import('./types').Progress} */
  const state = { progress: span.from, speed: null, eta: null, ...(opts.stage ? { stage: opts.stage } : {}) };
  return run(task, ffmpegPath, ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', '-loglevel', 'error', ...args], (line) => {
    const [key, value] = line.split('=');
    if (key === 'out_time_us' || key === 'out_time_ms') {
      const sec = Number(value) / 1e6;
      if (duration > 0 && Number.isFinite(sec) && sec >= 0) {
        const part = Math.min(1, sec / duration);
        state.progress = Math.min(0.99, span.from + (span.to - span.from) * part);
        const elapsed = (Date.now() - startedAt) / 1000;
        // ETA for the remaining overall work, assuming the other pass takes as long as this one.
        if (part > 0.01) state.eta = Math.round((elapsed / part) * (1 - part) + (elapsed / part) * (1 - span.to) / Math.max(span.to - span.from, 0.01));
      }
    } else if (key === 'speed') {
      const s = parseFloat(value);
      if (Number.isFinite(s)) state.speed = s;
    } else if (key === 'progress') {
      task.onProgress?.({ ...state });
    }
  }, { cwd: opts.cwd });
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

/** Quality presets: CRF-like values per encoder family (lower = better, except VideoToolbox). */
const VIDEO_QUALITY = {
  high: { x264: 21, x265: 24, av1: 30, vp9: 30, vt: 65, hw: 23 },
  balanced: { x264: 24, x265: 27, av1: 35, vp9: 34, vt: 55, hw: 27 },
  small: { x264: 28, x265: 30, av1: 40, vp9: 38, vt: 45, hw: 31 },
  tiny: { x264: 32, x265: 34, av1: 46, vp9: 44, vt: 35, hw: 35 },
};
const AUDIO_BITRATE = { keep: 128, low: 64, remove: 0 };
const GIF_COLOURS = { high: 256, balanced: 256, small: 128, tiny: 64 };

/** @param {CompressTask} task @returns {Promise<CompressResult>} */
async function compressVideo(task) {
  const o = /** @type {import('./types').VideoOptions} */ (task.options);
  const info = await probe(task.input);
  if (!info.hasVideo) throw new Error('No video stream found in this file');

  // Trim
  const start = parseTime(o.trimStart) ?? 0;
  const end = parseTime(o.trimEnd);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new Error('Trim times must be seconds or [hh:]mm:ss');
  if (end !== null && end <= start) throw new Error('Trim end must be after the start');
  if (info.duration && start >= info.duration) throw new Error(`Trim start is past the end of the video (${info.duration.toFixed(1)} s)`);
  const stop = end !== null && info.duration ? Math.min(end, info.duration) : end ?? info.duration;
  const duration = Math.max(0, (stop || 0) - start);
  const input = [...(start ? ['-ss', String(start)] : []), '-i', task.input, ...(end !== null ? ['-t', String(duration)] : [])];

  const format = o.format === 'gif' || o.format === 'webm' ? o.format : 'mp4';
  const qualityName = o.quality && o.quality !== 'target' ? o.quality : 'balanced';
  const quality = VIDEO_QUALITY[qualityName] || VIDEO_QUALITY.balanced;
  const maxShort = Number(o.resolution) || 0;
  const fpsCap = Number(o.fps) || 0;
  const scaleFilter = (cap) => (cap && Math.min(info.width, info.height) > cap
    ? [info.width >= info.height ? `scale=-2:${cap}` : `scale=${cap}:-2`]
    : []);

  // Animated GIF: palette generated from the clip itself, no audio.
  if (format === 'gif') {
    const fps = Math.min(fpsCap || 12, info.fps || 12);
    const filters = [`fps=${fps}`, ...scaleFilter(maxShort || 480).map((f) => `${f}:flags=lanczos`)].join(',');
    const colours = GIF_COLOURS[qualityName] || 256;
    const dither = qualityName === 'high' ? 'sierra2_4a' : 'bayer:bayer_scale=3';
    const file = task.outputPath('gif');
    await runFfmpeg(task, [...input, '-an', '-filter_complex',
      `[0:v]${filters},split[a][b];[a]palettegen=max_colors=${colours}:stats_mode=diff[p];[b][p]paletteuse=dither=${dither}`,
      '-loop', '0', file], duration);
    return { file, ext: 'gif', mime: 'image/gif', info: { ...info, trimmed: duration } };
  }

  const audioKbps = info.hasAudio ? (AUDIO_BITRATE[o.audio] ?? 128) : 0;
  let targetKbps = 0;
  if (o.quality === 'target') {
    const mb = Number(o.targetMB);
    if (!(mb > 0)) throw new Error('Invalid target size');
    if (!(duration > 0)) throw new Error('Could not read the video duration to compute a bitrate');
    targetKbps = Math.floor((mb * 8192 * 0.96) / duration - audioKbps);
    if (targetKbps < 50) throw new Error(`${mb} MB is too small for a ${Math.round(duration)}-second video`);
  }

  // Encoder choice
  if (format === 'mp4' && o.codec === 'vp9') throw new Error('VP9 needs the WebM format');
  const codec = format === 'webm' ? (o.codec === 'av1' ? 'av1' : 'vp9') : (o.codec === 'h265' || o.codec === 'av1' ? o.codec : 'h264');
  if (codec === 'av1' && !encoders.av1) throw new Error('AV1 encoding is not available in this ffmpeg build');
  if (codec === 'vp9' && !caps.webm) throw new Error('WebM encoding is not available in this ffmpeg build');
  // Hardware encoders overshoot bitrate targets badly, so target-size mode always uses the CPU.
  const hwEncoder = o.encoder === 'hardware' && !targetKbps && format === 'mp4' ? encoders.hardware[codec] : undefined;

  const filters = [...scaleFilter(maxShort)];
  if (fpsCap && info.fps > fpsCap + 0.5) filters.push(`fps=${fpsCap}`);
  const pre = [];
  if (hwEncoder && caps.hardwareName === 'vaapi') {
    pre.push('-vaapi_device', vaapiDevice());
    filters.push('format=nv12', 'hwupload');
  } else {
    filters.push('format=yuv420p');
  }

  /** @type {string[]} */
  const video = ['-vf', filters.join(',')];
  const speed = ['ultrafast', 'veryfast', 'fast', 'medium', 'slow'].includes(o.speed) ? o.speed : 'medium';
  if (hwEncoder) {
    video.push('-c:v', hwEncoder);
    if (caps.hardwareName === 'videotoolbox') video.push('-q:v', String(quality.vt), '-allow_sw', '1');
    else if (caps.hardwareName === 'nvenc') video.push('-preset', 'p5', '-rc', 'vbr', '-cq', String(quality.hw), '-b:v', '0');
    else if (caps.hardwareName === 'qsv') video.push('-global_quality', String(quality.hw));
    else if (caps.hardwareName === 'vaapi') video.push('-qp', String(quality.hw));
    else if (caps.hardwareName === 'amf') video.push('-rc', 'cqp', '-qp_i', String(quality.hw), '-qp_p', String(quality.hw));
  } else if (codec === 'av1') {
    const svt = encoders.av1 === 'libsvtav1';
    video.push('-c:v', encoders.av1);
    if (svt) video.push('-preset', String({ ultrafast: 12, veryfast: 10, fast: 9, medium: 8, slow: 5 }[speed]));
    else video.push('-cpu-used', String({ ultrafast: 8, veryfast: 7, fast: 6, medium: 5, slow: 3 }[speed]), '-row-mt', '1');
    if (targetKbps) video.push('-b:v', `${targetKbps}k`);
    else video.push('-crf', String(quality.av1), ...(svt ? [] : ['-b:v', '0']));
  } else if (codec === 'vp9') {
    video.push('-c:v', 'libvpx-vp9', '-row-mt', '1', '-deadline', 'good',
      '-cpu-used', String({ ultrafast: 5, veryfast: 4, fast: 3, medium: 2, slow: 1 }[speed]));
    if (targetKbps) video.push('-b:v', `${targetKbps}k`);
    else video.push('-crf', String(quality.vp9), '-b:v', '0');
  } else {
    video.push('-c:v', codec === 'h265' ? 'libx265' : 'libx264', '-preset', speed);
    if (targetKbps) video.push('-b:v', `${targetKbps}k`, '-maxrate', `${Math.round(targetKbps * 1.5)}k`, '-bufsize', `${targetKbps * 2}k`);
    else video.push('-crf', String(codec === 'h265' ? quality.x265 : quality.x264));
  }
  if (codec === 'h265') video.push('-tag:v', 'hvc1'); // required for QuickTime / Safari playback

  /** @type {string[]} */
  const audio = [];
  if (audioKbps) {
    audio.push('-map', '0:a:0?', '-c:a', format === 'webm' ? 'libopus' : 'aac', '-b:a', `${audioKbps}k`);
    if (o.audio === 'low') audio.push('-ac', '1');
  } else {
    audio.push('-an');
  }

  const ext = format === 'webm' ? 'webm' : 'mp4';
  const file = task.outputPath(ext);
  const container = ext === 'mp4' ? ['-movflags', '+faststart'] : [];
  const x265Log = codec === 'h265' && !hwEncoder ? ['-x265-params', 'log-level=error'] : [];

  // Target size: two passes (first analyses, second hits the bitrate) for x264, x265 and VP9.
  const twoPass = targetKbps && !hwEncoder && ['h264', 'h265', 'vp9'].includes(codec);
  if (twoPass) {
    const log = task.tempPath('pass');
    const passArgs = (n) => (codec === 'h265'
      ? ['-x265-params', `pass=${n}:stats=${log}.log:log-level=error`]
      : ['-pass', String(n), '-passlogfile', log]);
    try {
      await runFfmpeg(task, [...pre, ...input, '-map', '0:v:0', ...video, ...passArgs(1), '-an', '-f', 'null', '-'], duration, { from: 0, to: 0.5 });
      await runFfmpeg(task, [...pre, ...input, '-map', '0:v:0', ...video, ...passArgs(2), ...audio,
        '-map_metadata', '0', ...container, file], duration, { from: 0.5, to: 1 });
    } finally {
      const dir = path.dirname(log);
      const prefix = path.basename(log);
      for (const f of await fsp.readdir(dir).catch(() => [])) {
        if (f.startsWith(prefix)) await fsp.rm(path.join(dir, f), { force: true }).catch(() => {});
      }
    }
  } else {
    await runFfmpeg(task, [...pre, ...input, '-map', '0:v:0', ...video, ...x265Log, ...audio, '-map_metadata', '0', ...container, file], duration);
  }
  return { file, ext, mime: ext === 'webm' ? 'video/webm' : 'video/mp4', info: { ...info, trimmed: end !== null || start ? duration : undefined } };
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

const AUDIO_FORMATS = {
  mp3: { ext: 'mp3', mime: 'audio/mpeg', codec: ['-c:a', 'libmp3lame'] },
  m4a: { ext: 'm4a', mime: 'audio/mp4', codec: ['-c:a', 'aac', '-movflags', '+faststart'] },
  opus: { ext: 'ogg', mime: 'audio/ogg', codec: ['-c:a', 'libopus', '-vbr', 'on'] },
};

/** @param {CompressTask} task @returns {Promise<CompressResult>} */
async function compressAudio(task) {
  const o = /** @type {import('./types').AudioOptions} */ (task.options);
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
 * @param {CompressTask} task
 */
async function loadImageInput(task) {
  return decodeImage(task.input, task.tempPath('decoded.png'));
}

/** Makes `file` readable by sharp: HEIC/HEIF is decoded to `tmp` first. */
async function decodeImage(file, tmp) {
  if (!/\.(heic|heif)$/i.test(file)) {
    return { input: file, meta: await sharp(file).metadata(), heic: false };
  }
  if (!caps.heicDecoder) throw new Error('HEIC needs a decoder on this system — install libheif (heif-dec on PATH) or run the Docker image');
  const args = caps.heicDecoder === 'sips' ? ['-s', 'format', 'png', file, '--out', tmp] : [file, tmp];
  await execFileAsync(caps.heicDecoder, args);
  return { input: tmp, meta: await sharp(tmp).metadata(), heic: true };
}

/** @param {CompressTask} task @returns {Promise<CompressResult>} */
async function compressImage(task) {
  const o = /** @type {import('./types').ImageOptions} */ (task.options);
  const { input, meta, heic } = await loadImageInput(task);
  const animated = (meta.pages || 1) > 1;
  // sharp reports AVIF files as format "heif" with AV1 compression.
  const sourceFormat = heic ? 'heic' : meta.format === 'heif' && meta.compression === 'av1' ? 'avif' : meta.format;
  /** @type {Record<string, any>} */
  const info = { width: meta.width, height: meta.pageHeight || meta.height, format: sourceFormat, animated, frames: meta.pages || 1 };

  let format = o.format;
  if (!format || format === 'auto') {
    if (sourceFormat === 'png') format = 'png';
    else if (sourceFormat === 'webp') format = 'webp';
    else if (sourceFormat === 'avif') format = 'avif';
    else if (sourceFormat === 'gif') format = animated ? /** @type {any} */ ('gif') : 'png';
    else format = 'jpeg';
  }
  if (!IMAGE_MIME[format]) throw new Error(`Unsupported output format: ${format}`);
  // Never drop an animation silently: JPEG, PNG and AVIF (in sharp) hold a single frame, so keep
  // animated input animated — as WebP when AVIF was asked for (both modern), else as GIF.
  if (animated && !['gif', 'webp'].includes(format)) {
    const kept = format === 'avif' ? 'webp' : 'gif';
    info.note = `${format.toUpperCase()} can't be animated; saved as animated ${kept.toUpperCase()}`;
    format = /** @type {any} */ (kept);
  }
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
    default: // gif
      img = img.gif({ effort: 10, colours: q >= 90 ? 256 : q >= 70 ? 128 : 64, interFrameMaxError: q >= 90 ? 0 : 8, reuse: true });
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
// PDF (Ghostscript)
// ---------------------------------------------------------------------------

/** @param {CompressTask} task @returns {Promise<CompressResult>} */
async function compressPdf(task) {
  if (!caps.pdf) throw new Error('PDF compression needs Ghostscript — install it (gs on PATH, or GS_PATH) or run the Docker image');
  const o = /** @type {import('./types').PdfOptions} */ (task.options);
  const preset = ['screen', 'ebook', 'printer', 'prepress'].includes(o.quality) ? o.quality : 'ebook';
  const file = task.outputPath('pdf');
  const args = [
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.6',
    `-dPDFSETTINGS=/${preset}`, '-dDetectDuplicateImages=true',
  ];
  if (o.grayscale) args.push('-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray');
  args.push(`-sOutputFile=${file}`, task.input);
  task.onProgress?.({ progress: 0.1, speed: null, eta: null });
  await run(task, gsPath, args);
  return { file, ext: 'pdf', mime: 'application/pdf', info: { preset, pages: await pdfPages(task.input) } };
}

/** Page count of a PDF (null when Ghostscript is missing or the file can't be read). */
async function pdfPages(file) {
  if (!caps.pdf) return null;
  try {
    // -sFile passes the path as a string, so names with parentheses or backslashes are safe.
    const { stdout } = await execFileAsync(gsPath, ['-q', '-dNODISPLAY', '-dSAFER', `--permit-file-read=${file}`, `-sFile=${file}`,
      '-c', 'File (r) file runpdfbegin pdfpagecount = quit'], { timeout: 30000 });
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Animation: several still images → animated GIF, animated WebP or MP4
// ---------------------------------------------------------------------------

const MAX_FRAMES = 1000;

/** @param {CompressTask} task @returns {Promise<CompressResult>} */
async function compressAnimation(task) {
  const o = /** @type {import('./types').AnimationOptions} */ (task.options);
  const files = task.inputs?.length ? task.inputs : [task.input];
  if (files.length < 2) throw new Error('An animation needs at least 2 images');
  if (files.length > MAX_FRAMES) throw new Error(`An animation can have at most ${MAX_FRAMES} frames`);

  const format = o.format === 'webp' || o.format === 'mp4' ? o.format : 'gif';
  const q = Math.min(100, Math.max(1, Number(o.quality) || 80));
  const fit = o.fit === 'cover' ? 'cover' : 'contain';
  const background = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(o.background || '')) ? `#${String(o.background).replace('#', '')}` : '#ffffff';
  const loop = Math.max(0, Math.floor(Number(o.loop) || 0));
  // GIF stores delays in 1/100 s, and browsers clamp anything under 20 ms.
  const clampDelay = (d) => Math.min(60_000, Math.max(20, Math.round(Number(d) || 500)));
  const delays = files.map((_, i) => clampDelay(Array.isArray(o.delay) ? o.delay[i] ?? o.delay[o.delay.length - 1] : o.delay));

  // Canvas: the first frame's shape (after EXIF rotation), long edge capped at maxDim.
  const temps = [];
  const decode = async (file, i) => {
    const d = await decodeImage(file, task.tempPath(`frame${i}.png`));
    if (d.heic) temps.push(d.input);
    return d.input;
  };
  try {
    const first = await sharp(await decode(files[0], 0), { limitInputPixels: false }).rotate().toBuffer({ resolveWithObject: true });
    const maxDim = o.maxDim === undefined || o.maxDim === '' ? 800 : Number(o.maxDim) || 4096;
    const scale = Math.min(1, maxDim / Math.max(first.info.width, first.info.height));
    let width = Math.max(2, Math.round(first.info.width * scale));
    let height = Math.max(2, Math.round(first.info.height * scale));
    if (format === 'mp4') [width, height] = [width - (width % 2), height - (height % 2)]; // H.264 needs even sizes

    /** @type {Buffer[]} */
    const frames = [];
    for (let i = 0; i < files.length; i++) {
      if (task.isCancelled?.()) throw new Error('Cancelled');
      const input = i === 0 ? first.data : await decode(files[i], i);
      frames.push(await sharp(input, { limitInputPixels: false }).rotate()
        .resize({ width, height, fit, background, position: 'centre' })
        .flatten({ background })
        .png({ compressionLevel: 1 })
        .toBuffer());
      task.onProgress?.({ progress: (0.7 * (i + 1)) / files.length, speed: null, eta: null });
    }

    const stem = path.parse(path.basename(files[0])).name.replace(/[^\p{L}\p{N}._ -]+/gu, '_') || 'animation';
    const info = { frames: files.length, width, height, durationMs: delays.reduce((a, b) => a + b, 0), loop };
    const name = `${stem}-animated.${format}`;
    const file = task.outputPath(format);

    if (format === 'mp4') {
      // concat demuxer: one entry per frame with its own duration (the last is repeated so it shows).
      const dir = task.tempPath('frames');
      await fsp.mkdir(dir, { recursive: true });
      temps.push(dir);
      const lines = [];
      for (let i = 0; i < frames.length; i++) {
        const f = path.join(dir, `f${String(i).padStart(5, '0')}.png`);
        await fsp.writeFile(f, frames[i]);
        lines.push(`file '${f.replace(/'/g, "'\\''")}'`, `duration ${(delays[i] / 1000).toFixed(3)}`);
      }
      lines.push(lines[lines.length - 2]);
      const list = path.join(dir, 'list.txt');
      await fsp.writeFile(list, `${lines.join('\n')}\n`);
      const crf = Math.round(40 - q * 0.22); // quality 80 → CRF 22
      await runFfmpeg(task, ['-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264',
        '-crf', String(crf), '-preset', 'medium', '-movflags', '+faststart', '-an', file], info.durationMs / 1000, { from: 0.7, to: 1 });
      return { file, ext: 'mp4', mime: 'video/mp4', info, name };
    }

    let img = sharp(frames, { join: { animated: true } });
    img = format === 'webp'
      ? img.webp({ delay: delays, loop, quality: q, effort: 5 })
      : img.gif({ delay: delays, loop, colours: q >= 80 ? 256 : q >= 60 ? 128 : 64, effort: 7, dither: q >= 80 ? 1 : 0.5 });
    await img.toFile(file);
    return { file, ext: format, mime: format === 'webp' ? 'image/webp' : 'image/gif', info, name };
  } finally {
    await Promise.all(temps.map((t) => fsp.rm(t, { recursive: true, force: true }).catch(() => {})));
  }
}

// ---------------------------------------------------------------------------
// Subtitles: speech → SRT/WebVTT with whisper.cpp, and subtitles → video (a track, or burned in)
// ---------------------------------------------------------------------------

const BURN_SIZE = { small: 14, medium: 18, large: 24 }; // libass units: 288 = the video height

/**
 * Transcribes the input's speech. Progress: the model download and the transcription each report
 * their own 0–1 under `stage` ("model", "transcribe").
 * @param {CompressTask} task
 * @param {import('./types').SubtitleOptions} o
 * @param {number} duration
 */
async function transcribe(task, o, duration) {
  if (!caps.whisper) throw new Error('Speech recognition is not installed on this machine (whisper.cpp). You can still add your own SRT or VTT file.');
  const language = String(o.language || 'auto').toLowerCase();
  if (language !== 'auto' && !/^[a-z]{2,3}$/.test(language)) throw new Error(`Unknown language code: ${o.language}`);
  if (o.translate && o.model === 'large-v3-turbo') throw new Error('The large-v3-turbo model can\'t translate; choose small or medium');

  const model = await subs.ensureModel(o.model, {
    onProgress: (p) => task.onProgress?.({ progress: Math.min(0.99, p), speed: null, eta: null, stage: 'model' }),
    isCancelled: task.isCancelled,
  });
  const vad = await subs.ensureVadModel();
  if (task.isCancelled?.()) throw new Error('Cancelled');

  // whisper.cpp reads 16 kHz mono WAV.
  const wav = task.tempPath('speech.wav');
  const base = task.tempPath('speech');
  try {
    await runFfmpeg(task, ['-i', task.input, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], duration,
      { from: 0, to: 0.05 }, { stage: 'transcribe' });
    let detected = language === 'auto' ? null : language;
    const startedAt = Date.now();
    const threads = Number(process.env.WHISPER_THREADS) || Math.max(1, Math.min(8, os.availableParallelism?.() ?? os.cpus().length));
    await run(task, caps.whisper, [
      '-m', model.file, '-f', wav, '-l', language, '-t', String(threads), '-osrt', '-of', base, '-pp',
      ...(o.translate ? ['-tr'] : []),
      ...(vad ? ['--vad', '-vm', vad] : []),
    ], undefined, {
      onStderrLine: (line) => {
        const lang = /auto-detected language: (\w+)/.exec(line);
        if (lang) detected = lang[1];
        const pct = /progress =\s*(\d+)%/.exec(line);
        if (pct) {
          const part = Number(pct[1]) / 100;
          const elapsed = (Date.now() - startedAt) / 1000;
          task.onProgress?.({ progress: Math.min(0.99, 0.05 + 0.95 * part), speed: null, eta: part > 0.02 ? Math.round((elapsed / part) * (1 - part)) : null, stage: 'transcribe' });
        }
      },
    });
    const cues = subs.readableCues(subs.parseSubtitles(await fsp.readFile(`${base}.srt`, 'utf8').catch(() => '')));
    return { cues, language: o.translate ? 'en' : detected, spokenLanguage: detected, model: model.name };
  } finally {
    await Promise.all([wav, `${base}.srt`].map((f) => fsp.rm(f, { force: true }).catch(() => {})));
  }
}

/** @param {CompressTask} task @returns {Promise<CompressResult>} */
async function compressSubtitles(task) {
  const o = /** @type {import('./types').SubtitleOptions} */ (task.options);
  const info = await probe(task.input);
  const embed = o.embed === 'track' || o.embed === 'burn' ? o.embed : 'none';
  if (embed !== 'none' && !info.hasVideo) throw new Error('Subtitles can only be added to a video; choose an SRT or VTT file instead');
  if (embed === 'burn' && !caps.burnSubtitles) throw new Error('This ffmpeg build can\'t burn in subtitles (it needs libass); add them as a track instead');

  // Given subtitles (the user's file, or an edited transcript) skip speech recognition.
  let result;
  if (o.text != null && String(o.text).trim()) {
    const lang = /^[a-z]{2,3}$/i.test(String(o.language || '')) ? String(o.language).toLowerCase() : null;
    result = { cues: subs.parseSubtitles(o.text), language: lang, spokenLanguage: lang, model: null };
  } else {
    if (!info.hasAudio) throw new Error('No audio found to transcribe');
    result = await transcribe(task, o, info.duration);
  }
  const { cues } = result;
  const srt = subs.formatSubtitles(cues, 'srt');
  const out = {
    cues: cues.length,
    language: result.language,
    spokenLanguage: result.spokenLanguage,
    model: result.model,
    duration: info.duration,
    embed,
    words: cues.reduce((n, c) => n + c.text.split(/\s+/).filter(Boolean).length, 0),
  };
  const langPart = result.language ? `.${result.language}` : '';

  if (embed === 'none') {
    const format = o.format === 'vtt' ? 'vtt' : 'srt';
    const file = task.outputPath(format);
    await fsp.writeFile(file, subs.formatSubtitles(cues, format));
    return { file, ext: format, mime: format === 'vtt' ? 'text/vtt' : 'application/x-subrip', info: out, suffix: `${langPart}.${format}`, transcript: srt };
  }
  if (!cues.length) throw new Error('No speech was recognised, so there are no subtitles to add');

  const dir = task.tempPath('subs');
  await fsp.mkdir(dir, { recursive: true });
  try {
    await fsp.writeFile(path.join(dir, 'subs.srt'), srt);
    if (embed === 'track') {
      // A selectable track, streams copied as they are: MP4/MOV use mov_text, MKV SRT, WebM WebVTT.
      const inExt = path.extname(task.inputName || task.input).slice(1).toLowerCase();
      const ext = ['mp4', 'm4v', 'mov'].includes(inExt) ? inExt : inExt === 'webm' ? 'webm' : 'mkv';
      const codec = { mp4: 'mov_text', m4v: 'mov_text', mov: 'mov_text', webm: 'webvtt', mkv: 'srt' }[ext];
      const file = task.outputPath(ext);
      await runFfmpeg(task, ['-i', task.input, '-i', path.join(dir, 'subs.srt'), '-map', '0:v', '-map', '0:a?', '-map', '1:0',
        '-c', 'copy', '-c:s', codec, '-metadata:s:s:0', `language=${subs.iso3(result.language)}`, '-disposition:s:0', 'default',
        '-map_metadata', '0', ...(ext === 'mkv' || ext === 'webm' ? [] : ['-movflags', '+faststart']), file],
      info.duration, { from: 0, to: 1 }, { stage: 'embed' });
      const mime = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska' }[ext];
      return { file, ext, mime, info: out, suffix: `-subtitled.${ext}`, transcript: srt };
    }
    // Burned in: part of the picture, so it shows everywhere (TikTok, Reels…); re-encodes the video.
    // ffmpeg runs in the temp folder so the filter gets a plain relative file name (no escaping).
    const size = BURN_SIZE[o.fontSize] || BURN_SIZE.medium;
    const style = `FontSize=${size},Outline=1.2,Shadow=0,MarginV=${Math.round(size * 1.1)},BorderStyle=1`;
    const file = task.outputPath('mp4');
    await runFfmpeg(task, ['-i', path.resolve(task.input), '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', `subtitles=subs.srt:force_style='${style}',format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-c:a', 'aac', '-b:a', '160k', '-map_metadata', '0', '-movflags', '+faststart', path.resolve(file)],
    info.duration, { from: 0, to: 1 }, { cwd: dir, stage: 'embed' });
    return { file, ext: 'mp4', mime: 'video/mp4', info: out, suffix: '-subtitled.mp4', transcript: srt };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Compresses one file.
 * @param {CompressTask} task
 * @returns {Promise<CompressResult>}
 */
async function compress(task) {
  await detectCapabilities();
  const fn = { image: compressImage, video: compressVideo, audio: compressAudio, pdf: compressPdf, animation: compressAnimation, subtitles: compressSubtitles }[task.kind];
  if (!fn) throw new Error(`Unsupported kind: ${task.kind}`);
  return fn(task);
}

module.exports = { EXT, caps, compress, detectCapabilities, detectKind, outputName, parseTime, pdfPages, probe, ffmpegPath, ffprobePath };
