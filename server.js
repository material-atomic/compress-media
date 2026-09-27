'use strict';

// Web UI + HTTP API. The compression itself lives in lib/media.js (shared with the CLI).

// Settings from ./.env (native runs; Compose reads the same file itself). Real environment
// variables win over the file. process.loadEnvFile needs Node 20.12+.
if (typeof process.loadEnvFile === 'function' && require('node:fs').existsSync('.env')) process.loadEnvFile('.env');

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const crypto = require('node:crypto');
const net = require('node:net');
const express = require('express');
const multer = require('multer');
const pkg = require('./package.json');
const { caps, compress, detectCapabilities, detectKind, outputName } = require('./lib/media');
const { fromEnv: storageFromEnv, contentDisposition } = require('./lib/storage');

// ---------------------------------------------------------------------------
// Config (all overridable through environment variables)
// ---------------------------------------------------------------------------

const WORK_DIR = path.resolve(process.env.WORK_DIR || path.join(__dirname, 'tmp'));
const UPLOAD_DIR = path.join(WORK_DIR, 'uploads');
const OUTPUT_DIR = path.join(WORK_DIR, 'outputs');
const JOB_TTL_MS = (Number(process.env.JOB_TTL_HOURS) || 3) * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 0) * 1024 * 1024; // 0 = unlimited
const MEDIA_CONCURRENCY = Number(process.env.MEDIA_CONCURRENCY) || 1;
const IMAGE_CONCURRENCY = Number(process.env.IMAGE_CONCURRENCY) || 3;

// Chunked uploads: the browser sends parts (several in parallel) instead of one huge request, which
// proxies (e.g. Cloudflare's 100 MB body limit) and load balancers can't handle. The defaults follow
// the rules shared by S3-compatible storage (AWS S3, GCS, Cloudflare R2, MinIO, Backblaze B2,
// DigitalOcean Spaces, Wasabi): equal-sized parts except the last, 5 MiB–5 GiB each, ≤ 10,000 parts.
const MiB = 1024 * 1024;
const UPLOAD_PART_BYTES = Math.round(Math.min(Number(process.env.UPLOAD_PART_MB) || 8, 5120) * MiB);
const UPLOAD_MAX_PARTS = Math.max(1, Math.floor(Number(process.env.UPLOAD_MAX_PARTS) || 10_000));
const UPLOAD_CONCURRENCY = Math.min(Math.max(1, Math.floor(Number(process.env.UPLOAD_CONCURRENCY) || 4)), 16);
if (UPLOAD_PART_BYTES < 5 * MiB) {
  console.warn(`UPLOAD_PART_MB=${process.env.UPLOAD_PART_MB} is below the 5 MiB minimum of S3-compatible storage (fine for local disk).`);
}
if (UPLOAD_PART_BYTES > 100 * MiB) {
  console.warn(`UPLOAD_PART_MB=${process.env.UPLOAD_PART_MB} exceeds Cloudflare's 100 MB request limit; parts will fail behind its proxy.`);
}

let storage;
try {
  storage = storageFromEnv();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

/** Part size for a file: the configured size, grown (in whole MiB) if the file would need too many parts. */
function partSizeFor(size) {
  const minimum = Math.ceil(size / UPLOAD_MAX_PARTS / MiB) * MiB;
  return Math.max(UPLOAD_PART_BYTES, minimum);
}

// ---------------------------------------------------------------------------
// Jobs & queues
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} */
const jobs = new Map();

class Queue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.items = [];
  }
  push(job) {
    this.items.push(job);
    this.next();
  }
  remove(job) {
    this.items = this.items.filter((j) => j !== job);
  }
  next() {
    while (this.running < this.concurrency && this.items.length) {
      const job = this.items.shift();
      this.running++;
      runJob(job).finally(() => {
        this.running--;
        this.next();
      });
    }
  }
}

// ffmpeg already uses every core, so media runs one at a time by default; images are cheap.
const mediaQueue = new Queue(MEDIA_CONCURRENCY);
const imageQueue = new Queue(IMAGE_CONCURRENCY);

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    name: job.name,
    status: job.status,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    inputSize: job.inputSize,
    outputSize: job.outputSize,
    outputName: job.outputName,
    outputMime: job.outputMime,
    error: job.error,
    info: job.info,
    options: job.options,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

function enqueue(job) {
  job.status = 'queued';
  job.progress = 0;
  job.error = null;
  job.eta = null;
  job.speed = null;
  (job.kind === 'image' ? imageQueue : mediaQueue).push(job);
}

async function removeFile(p) {
  if (p) await fsp.rm(p, { force: true }).catch(() => {});
}

async function removeFilesWithPrefix(dir, prefix) {
  const names = await fsp.readdir(dir).catch(() => []);
  await Promise.all(names.filter((n) => n.startsWith(prefix)).map((n) => removeFile(path.join(dir, n))));
}

async function runJob(job) {
  if (job.status !== 'queued') return;
  // Each run gets a token so a cancelled/retried run can't overwrite newer state.
  const run = ++job.run;
  const stale = () => job.run !== run;
  job.status = 'processing';
  job.startedAt = Date.now();
  job.finishedAt = null;
  await removeFile(job.outputPath);
  await storage.removeOutput(job);
  job.outputPath = null;
  try {
    const out = await compress({
      kind: job.kind,
      input: job.inputPath,
      options: job.options,
      // Output files are per-run so a cancelled run can never clobber a newer one.
      outputPath: (ext) => path.join(OUTPUT_DIR, `${job.id}-${run}.${ext}`),
      tempPath: (suffix) => path.join(UPLOAD_DIR, `${job.id}-${run}-${suffix}`),
      onSpawn: (proc) => { if (!stale()) job.proc = proc; },
      onProgress: (p) => { if (!stale()) Object.assign(job, p); },
      isCancelled: stale,
    });
    if (stale()) return void removeFile(out.file);
    job.info = out.info;
    job.outputPath = out.file;
    job.outputName = outputName(job.name, out.ext);
    job.outputMime = out.mime;
    job.outputSize = (await fsp.stat(out.file)).size;
    await storage.saveOutput(job);
    if (stale()) return void storage.removeOutput(job);
    job.progress = 1;
    job.eta = 0;
    job.status = 'done';
  } catch (err) {
    removeFilesWithPrefix(OUTPUT_DIR, `${job.id}-${run}.`);
    if (stale()) return;
    console.error(`[job ${job.id}] ${job.name}:`, err.message);
    job.status = 'error';
    job.error = err.message || String(err);
  } finally {
    if (!stale()) {
      job.finishedAt = Date.now();
      job.proc = null;
    }
  }
}

function cancelJob(job) {
  job.run++; // invalidate the in-flight run
  job.status = 'cancelled';
  (job.kind === 'image' ? imageQueue : mediaQueue).remove(job);
  if (job.proc) job.proc.kill('SIGKILL');
  job.proc = null;
}

async function deleteJob(job) {
  cancelJob(job);
  jobs.delete(job.id);
  await Promise.all([
    storage.removeOutput(job),
    removeFile(job.inputPath),
    removeFilesWithPrefix(OUTPUT_DIR, job.id),
    removeFilesWithPrefix(UPLOAD_DIR, `${job.id}-`),
  ]);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  limits: MAX_UPLOAD_BYTES ? { fileSize: MAX_UPLOAD_BYTES } : undefined,
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    // Keep only a safe extension — the original name may contain characters Windows forbids.
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')}`),
  }),
});

function parseOptions(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/config', (_req, res) => {
  res.json({ version: pkg.version, ...caps, maxUploadBytes: MAX_UPLOAD_BYTES, uploadPartBytes: UPLOAD_PART_BYTES, uploadConcurrency: UPLOAD_CONCURRENCY, jobTtlMs: JOB_TTL_MS });
});

app.post('/api/jobs', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  // multer decodes the filename as latin1; restore UTF-8 (accented names etc.)
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const kind = detectKind(name, req.file.mimetype);
  if (!kind) {
    await removeFile(req.file.path);
    return res.status(415).json({ error: `Unsupported file type: ${name}` });
  }
  res.json(publicJob(createJob({ kind, name, inputPath: req.file.path, inputSize: req.file.size, options: req.body.options })));
});

function createJob({ kind, name, inputPath, inputSize, options }) {
  const job = {
    id: crypto.randomUUID(),
    kind,
    name,
    inputPath,
    inputSize,
    options: parseOptions(options)[kind] || {},
    run: 0,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  enqueue(job);
  return job;
}

// ---------------------------------------------------------------------------
// Chunked, resumable uploads — modelled on S3 multipart uploads (init → parts → complete) so the
// storage can later move to presigned S3 URLs without changing the client.
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} */
const uploads = new Map();

function publicUpload(u) {
  return {
    uploadId: u.id,
    partSize: u.partSize,
    partCount: u.partCount,
    concurrency: UPLOAD_CONCURRENCY,
    // true: PUT parts to presigned storage URLs from POST …/parts/:n/url; false: PUT them here.
    direct: storage.direct,
    received: [...u.received].sort((a, b) => a - b),
  };
}

function partLength(u, n) {
  return n < u.partCount ? u.partSize : u.size - (u.partCount - 1) * u.partSize;
}

app.post('/api/uploads', async (req, res) => {
  const name = String(req.body?.name || '');
  const size = Number(req.body?.size);
  if (!name || !Number.isSafeInteger(size) || size <= 0) return res.status(400).json({ error: 'name and size are required' });
  const kind = detectKind(name, String(req.body?.type || ''));
  if (!kind) return res.status(415).json({ error: `Unsupported file type: ${name}` });
  if (MAX_UPLOAD_BYTES && size > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: `File is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit` });
  }
  const id = crypto.randomUUID();
  const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const partSize = partSizeFor(size);
  const upload = {
    id, name, kind, size, ext,
    file: path.join(UPLOAD_DIR, `${id}${ext}`), // where the job reads it (s3: copied here on complete)
    partSize,
    partCount: Math.ceil(size / partSize),
    received: new Set(),
    createdAt: Date.now(),
  };
  try {
    await storage.initUpload(upload);
  } catch (err) {
    console.error('initUpload:', err);
    return res.status(502).json({ error: `Storage error: ${err.message}` });
  }
  uploads.set(id, upload);
  res.status(201).json(publicUpload(upload));
});

/** Looks up an upload and validates the part number; sends the error response itself. */
function uploadPart(req, res) {
  const u = uploads.get(req.params.id);
  if (!u) return void res.status(404).json({ error: 'Upload not found' });
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1 || n > u.partCount) return void res.status(400).json({ error: `Part must be 1–${u.partCount}` });
  return { u, n };
}

app.get('/api/uploads/:id', async (req, res) => {
  const u = uploads.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Upload not found' });
  try {
    u.received = new Set(await storage.receivedParts(u));
  } catch (err) {
    return res.status(502).json({ error: `Storage error: ${err.message}` });
  }
  res.json(publicUpload(u));
});

app.post('/api/uploads/:id/parts/:n/url', async (req, res) => {
  const p = uploadPart(req, res);
  if (!p) return;
  if (!storage.direct) return res.status(409).json({ error: 'Parts are uploaded to this server: PUT /api/uploads/:id/parts/:n' });
  res.json({ url: await storage.partUrl(p.u, p.n) });
});

app.put('/api/uploads/:id/parts/:n', async (req, res) => {
  const p = uploadPart(req, res);
  if (!p) return;
  if (storage.direct) return res.status(409).json({ error: 'Parts go straight to storage: POST /api/uploads/:id/parts/:n/url' });
  const { u, n } = p;
  const expected = partLength(u, n);
  if (Number(req.headers['content-length']) !== expected) {
    return res.status(400).json({ error: `Part ${n} must be exactly ${expected} bytes` });
  }
  let written = 0;
  req.on('data', (chunk) => { written += chunk.length; });
  try {
    await pipeline(req, fs.createWriteStream(u.file, { flags: 'r+', start: (n - 1) * u.partSize }));
  } catch {
    return res.headersSent || res.destroyed ? undefined : res.status(400).json({ error: `Part ${n} was interrupted` });
  }
  if (written !== expected) return res.status(400).json({ error: `Part ${n} was incomplete` });
  if (!uploads.has(u.id)) return res.status(404).json({ error: 'Upload not found' }); // aborted meanwhile
  u.received.add(n);
  // S3 returns an ETag per part that CompleteMultipartUpload needs; mirror that contract.
  const etag = `"${u.id.slice(0, 8)}-${n}"`;
  res.setHeader('ETag', etag);
  res.json({ number: n, etag });
});

app.post('/api/uploads/:id/complete', async (req, res) => {
  const u = uploads.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Upload not found' });
  if (u.completing) return res.status(409).json({ error: 'Upload is already being completed' });
  u.completing = true;
  try {
    const received = new Set(await storage.receivedParts(u));
    const missing = [];
    for (let n = 1; n <= u.partCount; n++) if (!received.has(n)) missing.push(n);
    if (missing.length) {
      u.completing = false;
      return res.status(409).json({ error: `Missing parts: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}`, missing });
    }
    await storage.finishUpload(u);
  } catch (err) {
    u.completing = false;
    console.error('finishUpload:', err);
    return res.status(502).json({ error: `Storage error: ${err.message}` });
  }
  uploads.delete(u.id);
  res.json(publicJob(createJob({ kind: u.kind, name: u.name, inputPath: u.file, inputSize: u.size, options: req.body?.options })));
});

app.delete('/api/uploads/:id', async (req, res) => {
  const u = uploads.get(req.params.id);
  if (u) {
    uploads.delete(u.id);
    await storage.abortUpload(u);
  }
  res.json({ ok: true });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(publicJob(job));
});

app.post('/api/jobs/:id/retry', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'processing' || job.status === 'queued') cancelJob(job);
  const options = parseOptions(req.body?.options);
  job.options = options[job.kind] || job.options;
  job.outputSize = null;
  enqueue(job);
  res.json(publicJob(job));
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'processing' || job.status === 'queued') cancelJob(job);
  res.json(publicJob(job));
});

app.delete('/api/jobs/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (job) await deleteJob(job);
  res.json({ ok: true });
});

app.get('/api/jobs/:id/file', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).send('Result not ready');
  // Object storage: send the browser straight to the bucket instead of streaming it through here.
  const url = await storage.outputUrl(job, { inline: !!req.query.inline });
  if (url) return res.redirect(302, url);
  res.type(job.outputMime || 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(req.query.inline ? 'inline' : 'attachment', job.outputName));
  res.sendFile(job.outputPath);
});

app.get('/api/jobs/:id/original', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send('Job not found');
  res.sendFile(job.inputPath);
});

app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit` });
  }
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function portTaken(port) {
  const tryHost = (host) =>
    new Promise((resolve) => {
      const sock = net.connect({ port, host });
      sock.setTimeout(500);
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
      sock.once('error', () => resolve(false));
    });
  return Promise.all([tryHost('127.0.0.1'), tryHost('::1')]).then((r) => r.some(Boolean));
}

/** Starts the web server. Used by `node server.js` and `compress-media serve`. */
async function start({ port = Number(process.env.PORT) || 4747, host = process.env.HOST || '127.0.0.1' } = {}) {
  // Only wipe our own subfolders — WORK_DIR itself may be a user-supplied path.
  for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
  }
  let where;
  try {
    await detectCapabilities();
    where = await storage.describe();
  } catch (err) {
    console.error(storage.kind === 's3' ? `Cannot reach S3 storage: ${err.message}` : err.message);
    process.exit(1);
  }
  // Binding 127.0.0.1 succeeds even when another app holds the port on IPv6 (*:PORT),
  // which makes "localhost" ambiguous — so refuse if anything already answers.
  if (await portTaken(port)) {
    console.error(`\n  Port ${port} is already in use by another app. Pick another one, e.g.  PORT=4848 npm start\n`);
    process.exit(1);
  }

  // Expired jobs & stray files
  setInterval(async () => {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (job.status !== 'processing' && job.status !== 'queued' && now - job.createdAt > JOB_TTL_MS) await deleteJob(job);
    }
    // Abandoned uploads (tab closed mid-way and never resumed)
    for (const u of uploads.values()) {
      if (now - u.createdAt > JOB_TTL_MS) {
        uploads.delete(u.id);
        await storage.abortUpload(u).catch(() => {});
      }
    }
  }, 10 * 60 * 1000).unref();

  const server = app.listen(port, host, () => {
    const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log(`\n  Compress Media v${pkg.version} running at  http://${shown}:${port}`);
    console.log(`  Hardware encoder: ${caps.hardwareEncoder ? 'VideoToolbox' : 'none'} · HEIC: ${caps.heicDecoder || 'unsupported'}`);
    console.log(`  Storage: ${where} · upload parts ${UPLOAD_PART_BYTES / MiB} MB × ${UPLOAD_CONCURRENCY} in parallel\n`);
  });

  const shutdown = (signal) => {
    console.log(`\n  ${signal} received, shutting down…`);
    for (const job of jobs.values()) if (job.proc) job.proc.kill('SIGKILL');
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { app, start };
