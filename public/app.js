'use strict';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULTS = {
  video: { quality: 'balanced', targetMB: 25, codec: 'h264', encoder: 'cpu', speed: 'medium', resolution: '0', fps: '0', audio: 'keep' },
  image: { format: 'auto', quality: 78, maxDim: '0', keepMetadata: false },
  audio: { format: 'mp3', bitrate: '128', mono: false },
};
const STORAGE_KEY = 'compress-media:settings';

const settings = structuredClone(DEFAULTS);
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  for (const k of Object.keys(DEFAULTS)) Object.assign(settings[k], saved[k] || {});
} catch { /* ignore */ }

const form = document.getElementById('settings');

function getSetting(key) {
  const [group, name] = key.split('.');
  return settings[group][name];
}

function setSetting(key, value) {
  const [group, name] = key.split('.');
  settings[group][name] = value;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  syncForm();
}

function syncForm() {
  for (const seg of form.querySelectorAll('.seg[data-name]')) {
    const value = getSetting(seg.dataset.name);
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === value));
  }
  for (const el of form.querySelectorAll('[name]')) {
    const value = getSetting(el.name);
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value;
  }
  for (const el of form.querySelectorAll('[data-show]')) {
    const [key, value] = el.dataset.show.split('=');
    el.hidden = String(getSetting(key)) !== value;
  }
  document.getElementById('qOut').textContent = settings.image.quality;
}

form.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg button');
  if (btn) setSetting(btn.closest('.seg').dataset.name, btn.dataset.value);
});
form.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.name) return;
  setSetting(el.name, el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? Number(el.value) : el.value);
});
form.addEventListener('submit', (e) => e.preventDefault());

for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
}
function selectTab(name) {
  for (const tab of document.querySelectorAll('[role="tab"]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const p of document.querySelectorAll('.tabpanel')) p.hidden = p.dataset.panel !== name;
}

syncForm();

// Server capabilities: hide the hardware-encoder option where it doesn't exist (Linux, Docker…)
let config = { hardwareEncoder: false };
fetch('/api/config')
  .then((r) => r.json())
  .then((c) => {
    config = c;
    document.getElementById('version').textContent = `v${c.version}`;
    for (const el of document.querySelectorAll('[data-requires]')) el.hidden = !c[el.dataset.requires];
    if (!c.hardwareEncoder && settings.video.encoder === 'hardware') setSetting('video.encoder', 'cpu');
  })
  .catch(() => {});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXT = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff', 'heic', 'heif', 'gif', 'bmp'],
  video: ['mov', 'mp4', 'm4v', 'mkv', 'avi', 'webm', 'wmv', 'flv', '3gp', 'mts', 'm2ts', 'ts', 'mpg', 'mpeg', 'ogv'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'caf', 'wma', 'amr'],
};

function detectKind(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  for (const [kind, list] of Object.entries(EXT)) if (list.includes(ext)) return kind;
  const top = (file.type || '').split('/')[0];
  return ['image', 'video', 'audio'].includes(top) ? top : null;
}

function fmtBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '';
  if (sec < 1) return t('lessThanSecond');
  sec = Math.round(sec);
  if (sec < 60) return t('seconds', { s: sec });
  const m = Math.floor(sec / 60);
  if (m < 60) return t('minutes', { m, s: sec % 60 });
  return t('hours', { h: Math.floor(m / 60), m: m % 60 });
}

const QUALITY_KEYS = { high: 'qHigh', balanced: 'qBalanced', small: 'qSmall', tiny: 'qTiny' };
const IMAGE_FORMATS = { jpeg: 'JPEG', webp: 'WebP', avif: 'AVIF', png: 'PNG' };
const AUDIO_FORMATS = { mp3: 'MP3', m4a: 'M4A', opus: 'Opus' };

function optionsLabel(kind, o) {
  if (!o) return '';
  if (kind === 'video') {
    const parts = [o.codec === 'h265' ? 'H.265' : 'H.264'];
    if (config.hardwareEncoder && o.encoder === 'hardware' && o.quality !== 'target') parts.push(t('hardware'));
    parts.push(o.quality === 'target' ? `≈${o.targetMB} MB` : t(QUALITY_KEYS[o.quality] || 'qBalanced'));
    if (Number(o.resolution)) parts.push(`${o.resolution}p`);
    if (Number(o.fps)) parts.push(`${o.fps}fps`);
    if (o.audio === 'remove') parts.push(t('noAudio'));
    return parts.join(' · ');
  }
  if (kind === 'image') {
    const parts = [IMAGE_FORMATS[o.format] || t('keepFormat'), `Q${o.quality}`];
    if (Number(o.maxDim)) parts.push(`≤${o.maxDim}px`);
    return parts.join(' · ');
  }
  return `${AUDIO_FORMATS[o.format] || o.format} · ${o.bitrate} kbps${o.mono ? ' · mono' : ''}`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** @type {Array<any>} */
const items = [];
const list = document.getElementById('list');
const rowTpl = document.getElementById('rowTpl');
const uploadQueue = [];
const MAX_UPLOADS = 3;
let uploading = 0;

function addFiles(files) {
  for (const file of files) {
    const kind = detectKind(file);
    const item = {
      file,
      kind,
      name: file.name,
      inputSize: file.size,
      status: kind ? 'waiting' : 'error',
      error: kind ? null : t('unsupported'),
      progress: 0,
      job: null,
      options: structuredClone(settings), // settings at the time the file was added
    };
    item.el = rowTpl.content.firstElementChild.cloneNode(true);
    const thumb = item.el.querySelector('.thumb');
    thumb.dataset.kind = kind || '';
    if (kind === 'image' && !/\.(heic|heif|tiff?)$/i.test(file.name)) {
      item.thumbUrl = URL.createObjectURL(file);
      thumb.append(el('img', { src: item.thumbUrl, alt: '' }));
    } else {
      thumb.textContent = (file.name.split('.').pop() || '?').toUpperCase().slice(0, 4);
    }
    items.unshift(item);
    list.prepend(item.el);
    render(item);
    if (kind) {
      uploadQueue.push(item);
    }
  }
  pumpUploads();
  renderSummary();
}

function snapshotOptions() {
  return structuredClone(settings);
}

function pumpUploads() {
  while (uploading < MAX_UPLOADS && uploadQueue.length) {
    const item = uploadQueue.shift();
    uploading++;
    upload(item).finally(() => {
      uploading--;
      pumpUploads();
    });
  }
}

// ---------------------------------------------------------------------------
// Chunked, resumable upload (mirrors S3 multipart: init → parts → complete)
// ---------------------------------------------------------------------------

// Parallel part requests across all files. The server sets this (UPLOAD_CONCURRENCY); browsers
// only open ~6 connections per host over HTTP/1.1, so higher values mostly help on HTTP/2.
let partSlots = 4;
let busySlots = 0;
const PART_RETRIES = 5;
const RESUME_KEY = 'compress-media:uploads';
const slotWaiters = [];

async function withSlot(fn) {
  if (busySlots < partSlots) busySlots++;
  else await new Promise((r) => slotWaiters.push(r));
  try {
    return await fn();
  } finally {
    const next = slotWaiters.shift();
    if (next) next();
    else busySlots--;
  }
}

/** Upload ids by file fingerprint, so re-adding the same file after a reload resumes it. */
function resumeStore(update) {
  let map = {};
  try { map = JSON.parse(localStorage.getItem(RESUME_KEY) || '{}'); } catch { /* ignore */ }
  if (!update) return map;
  update(map);
  try { localStorage.setItem(RESUME_KEY, JSON.stringify(map)); } catch { /* ignore */ }
  return map;
}
const fingerprint = (f) => `${f.name}|${f.size}|${f.lastModified}`;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * PUTs one part with progress; rejects with HttpError (status 0 = network failure/abort).
 * `direct` uploads go to a presigned object-storage URL, which must not get extra headers.
 */
function putPart(item, url, direct, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.xhrs.add(xhr);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      item.xhrs.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.getResponseHeader('ETag'));
      let msg = '';
      try { msg = JSON.parse(xhr.responseText).error; } catch { /* ignore */ }
      reject(new HttpError(xhr.status, msg || t('uploadFailed', { status: xhr.status })));
    };
    xhr.onerror = xhr.onabort = () => {
      item.xhrs.delete(xhr);
      reject(new HttpError(0, t('uploadInterrupted')));
    };
    xhr.open('PUT', url);
    if (!direct) xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.send(blob);
  });
}

async function startOrResumeUpload(file) {
  const saved = resumeStore()[fingerprint(file)];
  if (saved) {
    try {
      return await api('GET', `/api/uploads/${saved}`);
    } catch { /* expired or server restarted: start over */ }
  }
  const upload = await api('POST', '/api/uploads', { name: file.name, size: file.size, type: file.type });
  resumeStore((m) => { m[fingerprint(file)] = upload.uploadId; });
  return upload;
}

async function upload(item) {
  const { file } = item;
  item.status = 'uploading';
  item.error = null;
  item.xhrs = new Set();
  render(item);
  try {
    const up = await startOrResumeUpload(file);
    item.uploadId = up.uploadId;
    if (up.concurrency) partSlots = up.concurrency;
    const received = new Set(up.received);
    const sizeOf = (n) => (n < up.partCount ? up.partSize : file.size - (up.partCount - 1) * up.partSize);
    let doneBytes = [...received].reduce((sum, n) => sum + sizeOf(n), 0);
    const inflight = new Map();
    const showProgress = () => {
      let bytes = doneBytes;
      for (const b of inflight.values()) bytes += b;
      item.progress = bytes / file.size;
      render(item);
    };
    showProgress();

    const pending = [];
    for (let n = 1; n <= up.partCount; n++) if (!received.has(n)) pending.push(n);
    await Promise.all(pending.map((n) => withSlot(async () => {
      const blob = file.slice((n - 1) * up.partSize, (n - 1) * up.partSize + sizeOf(n));
      for (let attempt = 0; ; attempt++) {
        if (item.status === 'removed') throw new HttpError(0, 'removed');
        try {
          // Presigned URLs are fetched per attempt, so a retry never uses an expired one.
          const url = up.direct
            ? (await api('POST', `/api/uploads/${up.uploadId}/parts/${n}/url`)).url
            : `/api/uploads/${up.uploadId}/parts/${n}`;
          await putPart(item, url, up.direct, blob, (loaded) => { inflight.set(n, loaded); showProgress(); });
          inflight.delete(n);
          doneBytes += blob.size;
          showProgress();
          return;
        } catch (err) {
          inflight.delete(n);
          // Retry network failures and server hiccups with backoff; client errors are final.
          const retryable = err.status === 0 || err.status >= 500 || err.status === 408 || err.status === 429;
          if (!retryable || attempt + 1 >= PART_RETRIES || item.status === 'removed') throw err;
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
    })));

    const job = await api('POST', `/api/uploads/${up.uploadId}/complete`, { options: item.options });
    resumeStore((m) => { delete m[fingerprint(file)]; });
    applyJob(item, job);
    item.file = null; // allow GC — the server has it now
  } catch (err) {
    for (const xhr of item.xhrs) xhr.abort();
    if (item.status === 'removed') return;
    item.status = 'error';
    item.error = err.message || t('uploadInterrupted');
    // Network-type failures can be resumed from the parts already on the server.
    item.resumable = !(err instanceof HttpError) || err.status === 0 || err.status >= 500;
  }
  render(item);
  renderSummary();
}

function resumeUpload(item) {
  item.resumable = false;
  item.status = 'waiting';
  render(item);
  uploadQueue.push(item);
  pumpUploads();
}

function applyJob(item, job) {
  item.job = job;
  item.status = job.status;
  item.progress = job.progress;
  item.error = job.error;
}

// Poll active jobs
setInterval(async () => {
  const active = items.filter((i) => i.job && (i.status === 'queued' || i.status === 'processing'));
  await Promise.all(active.map(async (item) => {
    try {
      const job = await api('GET', `/api/jobs/${item.job.id}`);
      if (item.status === 'removed') return;
      applyJob(item, job);
    } catch (err) {
      item.status = 'error';
      item.error = t('lostConnection');
    }
    render(item);
  }));
  if (active.length) renderSummary();
}, 800);

async function retry(item) {
  if (!item.job) return;
  try {
    applyJob(item, await api('POST', `/api/jobs/${item.job.id}/retry`, { options: snapshotOptions() }));
  } catch (err) {
    item.status = 'error';
    item.error = err.message;
  }
  render(item);
  renderSummary();
}

async function cancel(item) {
  if (!item.job) return;
  try { applyJob(item, await api('POST', `/api/jobs/${item.job.id}/cancel`)); } catch { /* ignore */ }
  render(item);
}

function remove(item) {
  item.status = 'removed';
  for (const xhr of item.xhrs || []) xhr.abort();
  if (item.uploadId && !item.job) {
    api('DELETE', `/api/uploads/${item.uploadId}`).catch(() => {});
    if (item.file) resumeStore((m) => { delete m[fingerprint(item.file)]; });
  }
  const qi = uploadQueue.indexOf(item);
  if (qi >= 0) uploadQueue.splice(qi, 1);
  if (item.job) api('DELETE', `/api/jobs/${item.job.id}`).catch(() => {});
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  item.el.remove();
  items.splice(items.indexOf(item), 1);
  renderSummary();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(item) {
  const { el: row, job } = item;
  row.dataset.status = item.status;
  row.querySelector('.name').textContent = item.name;
  row.querySelector('.name').title = item.name;

  const meta = row.querySelector('.meta');
  const bar = row.querySelector('.bar i');
  const actions = row.querySelector('.actions');
  meta.replaceChildren();

  const size = fmtBytes(item.inputSize);
  switch (item.status) {
    case 'waiting':
      meta.append(t('waitingUpload', { size }));
      bar.style.width = '0%';
      break;
    case 'uploading':
      meta.append(t('uploading', { pct: Math.round(item.progress * 100), size }));
      bar.style.width = `${item.progress * 100}%`;
      break;
    case 'queued':
      meta.append(t('queued', { size }));
      break;
    case 'processing': {
      const parts = [t('compressing', { pct: Math.round((job.progress || 0) * 100) })];
      if (job.speed) parts.push(`${job.speed.toFixed(1)}×`);
      if (job.eta != null && job.progress > 0.02) parts.push(t('remaining', { time: fmtDuration(job.eta) }));
      meta.append(parts.join(' · '));
      bar.style.width = `${(job.progress || 0) * 100}%`;
      break;
    }
    case 'done': {
      const ratio = job.outputSize / job.inputSize;
      const pct = Math.round((1 - ratio) * 100);
      meta.append(
        el('span', {}, size, el('span', { class: 'arrow' }, ' → '), el('span', { class: 'new' }, fmtBytes(job.outputSize))),
        ratio < 1
          ? el('span', { class: `badge ${pct >= 10 ? 'good' : 'warn'}` }, `−${pct}%`)
          : el('span', { class: 'badge warn', title: t('keepOriginalTitle') }, `+${Math.abs(pct)}% · ${t('keepOriginalBadge')}`),
        el('span', {}, optionsLabel(item.kind, job.options)),
      );
      if (job.finishedAt && job.startedAt) meta.append(el('span', {}, t('took', { time: fmtDuration((job.finishedAt - job.startedAt) / 1000) })));
      break;
    }
    case 'cancelled':
      meta.append(t('cancelled', { size }));
      break;
    case 'error':
      meta.append(el('span', { class: 'err' }, item.error || t('genericError')));
      break;
  }

  // Actions. Only rebuilt when they actually change: rows re-render on every progress poll,
  // and swapping a button between mousedown and mouseup would swallow the user's click.
  const mode = item.status === 'queued' || item.status === 'processing' ? 'active' : item.status;
  const actionsKey = [mode, job?.id, job?.outputName, job?.finishedAt, item.resumable, lang].join('|');
  if (actions.dataset.key === actionsKey) return;
  actions.dataset.key = actionsKey;
  actions.replaceChildren();
  if (item.status === 'done') {
    actions.append(
      el('a', { class: 'btn small', href: `/api/jobs/${job.id}/file`, download: job.outputName }, t('download')),
      el('button', { type: 'button', class: 'btn ghost small', onclick: () => openPreview(item) }, t('view')),
      el('button', { type: 'button', class: 'btn ghost small', title: t('redoTitle'), onclick: () => retry(item) }, t('redo')),
    );
  } else if (item.status === 'queued' || item.status === 'processing') {
    actions.append(el('button', { type: 'button', class: 'btn ghost small', onclick: () => cancel(item) }, t('cancel')));
  } else if ((item.status === 'error' || item.status === 'cancelled') && item.job) {
    actions.append(el('button', { type: 'button', class: 'btn ghost small', onclick: () => retry(item) }, t('redo')));
  } else if (item.status === 'error' && item.resumable && item.file) {
    actions.append(el('button', { type: 'button', class: 'btn ghost small', title: t('resumeTitle'), onclick: () => resumeUpload(item) }, t('resume')));
  }
  actions.append(el('button', { type: 'button', class: 'icon-btn', title: t('remove'), 'aria-label': t('remove'), onclick: () => remove(item) }, '✕'));
}

const summary = document.getElementById('summary');
function renderSummary() {
  summary.hidden = items.length === 0;
  const done = items.filter((i) => i.status === 'done');
  const active = items.filter((i) => ['waiting', 'uploading', 'queued', 'processing'].includes(i.status)).length;
  const text = summary.querySelector('.summary-text');
  text.replaceChildren();
  if (done.length) {
    const before = done.reduce((s, i) => s + i.job.inputSize, 0);
    // Where compression made a file bigger, the user keeps the original.
    const after = done.reduce((s, i) => s + Math.min(i.job.outputSize, i.job.inputSize), 0);
    text.append(
      el('b', {}, t('filesDone', { n: done.length })), ` · ${fmtBytes(before)} → ${fmtBytes(after)} · `,
      el('span', { class: 'saved' }, t('saved', { size: fmtBytes(before - after), pct: Math.round((1 - after / before) * 100) })),
    );
  }
  if (active) text.append(done.length ? ' · ' : '', t('processing', { n: active }));
  document.getElementById('downloadAll').hidden = done.length < 2;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const dialog = document.getElementById('preview');
document.getElementById('previewClose').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => {
  for (const m of dialog.querySelectorAll('video, audio')) m.pause();
  document.getElementById('previewBody').replaceChildren();
});

function openPreview(item) {
  const { job } = item;
  const body = document.getElementById('previewBody');
  document.getElementById('previewTitle').textContent = item.name;
  const media = (src) => {
    if (item.kind === 'image') return el('img', { src, alt: '', loading: 'lazy' });
    if (item.kind === 'video') return el('video', { src, controls: true, preload: 'metadata', playsinline: true });
    return el('audio', { src, controls: true, preload: 'metadata' });
  };
  const figure = (label, size, src) => el('figure', {}, media(src), el('figcaption', {}, el('span', {}, label), el('b', {}, fmtBytes(size))));
  body.replaceChildren(
    figure(t('original'), job.inputSize, `/api/jobs/${job.id}/original`),
    figure(t('compressed'), job.outputSize, `/api/jobs/${job.id}/file?inline=1&v=${job.finishedAt}`),
  );
  dialog.showModal();
}

// ---------------------------------------------------------------------------
// Input: drop, pick, paste
// ---------------------------------------------------------------------------

const drop = document.getElementById('drop');
const fileInput = document.getElementById('fileInput');

fileInput.addEventListener('change', () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  if (files.length) addFiles(files);
});
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; drop.classList.add('over'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('over'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('over');
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) addFiles(files);
});
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) addFiles(files);
});

document.getElementById('downloadAll').addEventListener('click', async () => {
  // One hidden iframe per file: with object storage the link redirects to another origin, and
  // successive anchor clicks would then cancel each other instead of downloading in parallel.
  for (const item of items.filter((i) => i.status === 'done')) {
    const frame = el('iframe', { src: `/api/jobs/${item.job.id}/file`, hidden: true, title: item.job.outputName });
    document.body.append(frame);
    setTimeout(() => frame.remove(), 60_000);
    await new Promise((r) => setTimeout(r, 300));
  }
});

document.getElementById('clearDone').addEventListener('click', () => {
  for (const item of [...items]) {
    if (!['waiting', 'uploading', 'queued', 'processing'].includes(item.status)) remove(item);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (items.some((i) => ['waiting', 'uploading', 'queued', 'processing'].includes(i.status))) e.preventDefault();
});

// Re-render dynamic text when the language changes
document.addEventListener('langchange', () => {
  for (const item of items) render(item);
  renderSummary();
});
