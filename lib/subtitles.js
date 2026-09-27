'use strict';

// Subtitle helpers: SRT/WebVTT parsing and writing, readable cue splitting, and the whisper.cpp
// speech models (downloaded on first use). Running ffmpeg and whisper-cli stays in lib/media.js.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

/** @typedef {{ start: number, end: number, text: string }} Cue  times in seconds */

// ---------------------------------------------------------------------------
// SRT / WebVTT
// ---------------------------------------------------------------------------

/** "00:01:02,345", "01:02.345" or "1:02:03.4" → seconds; NaN when malformed. */
function parseTimestamp(value) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (!m) return NaN;
  const [, h = '0', min, s, ms = '0'] = m;
  return Number(h) * 3600 + Number(min) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}

/**
 * Parses SRT or WebVTT text into cues. Styling tags are kept as written; empty cues are dropped.
 * @param {string} text
 * @returns {Cue[]}
 */
function parseSubtitles(text) {
  const blocks = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  /** @type {Cue[]} */
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue; // WEBVTT header, NOTE, STYLE, or a stray number
    const [from, rest] = lines[at].split('-->');
    const start = parseTimestamp(from);
    const end = parseTimestamp(rest.trim().split(/\s+/)[0]); // VTT cue settings follow the time
    const body = lines.slice(at + 1).join('\n').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !body) continue;
    cues.push({ start, end: Math.max(end, start), text: body });
  }
  if (!cues.length && String(text).trim()) throw new Error('No subtitles found: expected SRT or WebVTT with "00:00:01,000 --> 00:00:02,000" times');
  return cues.sort((a, b) => a.start - b.start);
}

function formatTimestamp(sec, sep) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
}

/** @param {Cue[]} cues @param {'srt' | 'vtt'} format */
function formatSubtitles(cues, format) {
  const sep = format === 'vtt' ? '.' : ',';
  const body = cues.map((c, i) => `${format === 'srt' ? `${i + 1}\n` : ''}${formatTimestamp(c.start, sep)} --> ${formatTimestamp(c.end, sep)}\n${c.text}\n`).join('\n');
  return format === 'vtt' ? `WEBVTT\n\n${body}` : body;
}

// ---------------------------------------------------------------------------
// Readable cues: whisper returns sentence-long segments; subtitles want at most two short lines.
// ---------------------------------------------------------------------------

const MAX_LINE = 42; // characters per line, the common broadcast/YouTube guideline

/** Splits `text` into chunks of at most `max` characters at word boundaries, as evenly as possible. */
function balance(text, max) {
  const words = text.split(/\s+/).filter(Boolean);
  const parts = Math.max(1, Math.ceil(text.length / max));
  const target = text.length / parts;
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    // Break once this chunk reaches its share, or it would overflow.
    if (cur && (next.length > max || (cur.length >= target && out.length < parts - 1))) {
      out.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Long cues become several two-line cues, timed in proportion to their length; short ones are
 * wrapped onto two lines when needed. Cues with line breaks already (user files) are left alone.
 * @param {Cue[]} cues
 * @returns {Cue[]}
 */
function readableCues(cues, maxLine = MAX_LINE) {
  /** @type {Cue[]} */
  const out = [];
  for (const cue of cues) {
    const text = cue.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (cue.text.includes('\n') || text.length <= maxLine) {
      out.push({ ...cue, text: cue.text.includes('\n') ? cue.text.trim() : text });
      continue;
    }
    // Prefer breaking a long cue after sentence punctuation, then fall back to even chunks.
    const pieces = [];
    for (const sentence of text.split(/(?<=[.!?…。！？])\s+/)) {
      const last = pieces[pieces.length - 1];
      if (last && `${last} ${sentence}`.length <= maxLine * 2) pieces[pieces.length - 1] = `${last} ${sentence}`;
      else pieces.push(...(sentence.length <= maxLine * 2 ? [sentence] : balance(sentence, maxLine * 2)));
    }
    const total = pieces.reduce((n, p) => n + p.length, 0);
    let t = cue.start;
    for (const [i, piece] of pieces.entries()) {
      const end = i === pieces.length - 1 ? cue.end : t + ((cue.end - cue.start) * piece.length) / total;
      out.push({ start: t, end, text: piece.length > maxLine ? balance(piece, maxLine).slice(0, 2).join('\n') : piece });
      t = end;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

// ISO 639-1 (whisper) → 639-2 (MP4/MKV track language). Others are tagged "und".
const ISO3 = {
  vi: 'vie', en: 'eng', zh: 'zho', ja: 'jpn', ko: 'kor', th: 'tha', id: 'ind', ms: 'msa', fr: 'fra', de: 'deu',
  es: 'spa', pt: 'por', it: 'ita', ru: 'rus', uk: 'ukr', pl: 'pol', nl: 'nld', tr: 'tur', ar: 'ara', hi: 'hin',
  sv: 'swe', cs: 'ces', el: 'ell', he: 'heb', fa: 'fas', tl: 'tgl', km: 'khm', lo: 'lao', my: 'mya',
};
const iso3 = (lang) => ISO3[lang] || 'und';

// ---------------------------------------------------------------------------
// Speech models (whisper.cpp ggml files)
// ---------------------------------------------------------------------------

/** Model names users pick, the file behind each, and its size in MB (for the UI). */
const MODELS = {
  tiny: { file: 'ggml-tiny.bin', mb: 75 },
  base: { file: 'ggml-base.bin', mb: 142 },
  small: { file: 'ggml-small.bin', mb: 466 },
  medium: { file: 'ggml-medium.bin', mb: 1500 },
  // Nearly large-v3 accuracy at a fraction of the size and time; can't translate.
  'large-v3-turbo': { file: 'ggml-large-v3-turbo-q5_0.bin', mb: 547 },
};
// Voice activity detection: skips silence and music, which otherwise invites made-up lines.
const VAD_MODEL = { file: 'ggml-silero-v5.1.2.bin', url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin' };

const defaultModel = () => (process.env.WHISPER_MODEL && MODELS[process.env.WHISPER_MODEL] ? process.env.WHISPER_MODEL : 'small');
const downloadsAllowed = () => !/^(0|false|no|off)$/i.test(process.env.WHISPER_DOWNLOAD || '');
const baseUrl = () => (process.env.WHISPER_MODEL_URL || 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main').replace(/\/+$/, '');

let modelsDir = process.env.WHISPER_MODELS_DIR
  || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'compress-media', 'models');
/** The server keeps models in WORK_DIR/models unless WHISPER_MODELS_DIR is set. */
function setModelsDir(dir) {
  if (!process.env.WHISPER_MODELS_DIR) modelsDir = dir;
}
const getModelsDir = () => modelsDir;

/** Which models are on disk, for /api/config and `compress-media info`. */
function listModels() {
  return Object.entries(MODELS).map(([name, m]) => ({ name, mb: m.mb, installed: fs.existsSync(path.join(modelsDir, m.file)) }));
}

/** @type {Map<string, Promise<string>>} one download per file at a time in this process */
const downloads = new Map();

/**
 * Downloads `url` to `dest` through a temporary file, so a crash never leaves a truncated model.
 * @param {(fraction: number) => void} [onProgress]
 * @param {() => boolean} [isCancelled]
 */
async function download(url, dest, onProgress, isCancelled) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.partial`;
  const hint = `, or set WHISPER_DOWNLOAD=false and put it in ${path.dirname(dest)} yourself`;
  /** @type {Response} */
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    throw new Error(`Could not download ${path.basename(dest)} (${err.cause?.code || err.message}). Check the internet connection${hint}`);
  }
  if (!res.ok || !res.body) throw new Error(`Could not download ${path.basename(dest)} (HTTP ${res.status})${hint}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const body = Readable.fromWeb(/** @type {any} */ (res.body));
  body.on('data', (chunk) => {
    got += chunk.length;
    if (isCancelled?.()) body.destroy(new Error('Cancelled'));
    if (total) onProgress?.(got / total);
  });
  try {
    await pipeline(body, fs.createWriteStream(tmp));
    if (total && got !== total) throw new Error(`Download of ${path.basename(dest)} was cut short`);
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return dest;
}

/**
 * The path of a model, downloading it first if needed (and allowed).
 * @param {string | undefined} name
 * @param {{ onProgress?: (fraction: number) => void, isCancelled?: () => boolean }} [opts]
 */
async function ensureModel(name, opts = {}) {
  const key = name && MODELS[name] ? name : defaultModel();
  const file = path.join(modelsDir, MODELS[key].file);
  if (fs.existsSync(file)) return { name: key, file };
  if (!downloadsAllowed()) {
    throw new Error(`The speech model "${key}" isn't installed. Put ${MODELS[key].file} in ${modelsDir}, or allow downloads (WHISPER_DOWNLOAD)`);
  }
  if (!downloads.has(file)) {
    downloads.set(file, download(`${baseUrl()}/${MODELS[key].file}`, file, opts.onProgress, opts.isCancelled)
      .finally(() => downloads.delete(file)));
  }
  return { name: key, file: await /** @type {Promise<string>} */ (downloads.get(file)) };
}

/** The VAD model path, or null when it can't be had (transcription then runs without it). */
async function ensureVadModel() {
  const file = path.join(modelsDir, VAD_MODEL.file);
  if (fs.existsSync(file)) return file;
  if (!downloadsAllowed()) return null;
  try {
    if (!downloads.has(file)) downloads.set(file, download(VAD_MODEL.url, file).finally(() => downloads.delete(file)));
    return await downloads.get(file);
  } catch {
    return null;
  }
}

module.exports = {
  MODELS, ISO3, iso3, parseSubtitles, formatSubtitles, readableCues, parseTimestamp,
  defaultModel, ensureModel, ensureVadModel, listModels, setModelsDir, getModelsDir,
};
