'use strict';

// Web UI + HTTP API, and/or a queue worker (ROLE=all|web|worker).
//
//   lib/media.js    the compression engine (shared with the CLI)
//   lib/jobs.js     job lifecycle: create, process, cancel, retry, delete, expiry
//   lib/store.js    where records and queues live (QUEUE=memory|redis)
//   lib/storage.js  where uploads and results live (STORAGE=local|s3)
//   lib/auth.js     built-in login (AUTH_ENABLED, on by default)

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
const { caps, detectCapabilities, detectKind } = require('./lib/media');
const { fromEnv: storageFromEnv, contentDisposition } = require('./lib/storage');
const { createStore } = require('./lib/store');
const { createJobs, publicJob, ACTIVE } = require('./lib/jobs');
const { validateWebhook } = require('./lib/webhook');
const { loadAuthConfig, setupAuth } = require('./lib/auth');
const subtitles = require('./lib/subtitles');

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
// Speech models are big (75 MB–1.5 GB) and kept across restarts, next to (not inside) uploads/outputs.
subtitles.setModelsDir(path.join(WORK_DIR, 'models'));

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
let store;
try {
  storage = storageFromEnv();
  store = createStore();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const jobs = createJobs({ store, storage, uploadDir: UPLOAD_DIR, outputDir: OUTPUT_DIR, ttlMs: JOB_TTL_MS });

/** Part size for a file: the configured size, grown (in whole MiB) if the file would need too many parts. */
function partSizeFor(size) {
  const minimum = Math.ceil(size / UPLOAD_MAX_PARTS / MiB) * MiB;
  return Math.max(UPLOAD_PART_BYTES, minimum);
}

async function removeFile(p) {
  if (p) await fsp.rm(p, { force: true }).catch(() => {});
}

function parseOptions(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
// Behind a reverse proxy, TRUST_PROXY (e.g. "1" or "loopback") makes req.ip the real client address,
// which the login rate limit relies on. See Express "trust proxy".
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.use(express.json({ limit: '4mb' })); // room for a long subtitle file in `options.subtitles.text`
app.use(express.static(path.join(__dirname, 'public')));
// Mediabunny (WebCodecs muxing/demuxing) for in-browser compression, loaded by the page on demand.
const mediabunnyBundle = path.join(path.dirname(require.resolve('mediabunny')), 'mediabunny.min.mjs'); // …/dist/bundles/
app.get('/vendor/mediabunny.mjs', (_req, res) => res.type('text/javascript').sendFile(mediabunnyBundle, { maxAge: '7d' }));

// Workers serve no HTTP; skipping this also keeps them from racing the web server to generate
// (and write) a password in a shared WORK_DIR.
const auth = process.env.ROLE === 'worker' ? { enabled: false } : loadAuthConfig({ workDir: WORK_DIR });
setupAuth(app, auth); // must come before every other /api route

const upload = multer({
  limits: MAX_UPLOAD_BYTES ? { fileSize: MAX_UPLOAD_BYTES } : undefined,
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    // Keep only a safe extension — the original name may contain characters Windows forbids.
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')}`),
  }),
});

/** Rejects kinds this server can't process before any bytes are uploaded. */
function unsupported(kind, name) {
  if (!kind) return `Unsupported file type: ${name}`;
  if (kind === 'pdf' && !caps.pdf) return 'PDF compression is not available on this server (Ghostscript is missing)';
  return null;
}

/** Validates an optional webhook URL; sends a 400 itself and returns false when it's invalid. */
async function webhookOrFail(value, res) {
  if (!value) return null;
  try {
    return await validateWebhook(value);
  } catch (err) {
    res.status(400).json({ error: err.message });
    return false;
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/config', (_req, res) => {
  res.json({
    version: pkg.version,
    ...caps,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    uploadPartBytes: UPLOAD_PART_BYTES,
    uploadConcurrency: UPLOAD_CONCURRENCY,
    jobTtlMs: JOB_TTL_MS,
    storage: storage.kind,
    queue: store.kind,
    animationMaxFrames: MAX_FRAMES,
    subtitleModels: subtitles.listModels(),
    subtitleModel: subtitles.defaultModel(),
  });
});

// Single-request upload (small files, simple scripts). Fields: file, options (JSON), webhook.
app.post('/api/jobs', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  // multer decodes the filename as latin1; restore UTF-8 (accented names etc.)
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const kind = detectKind(name, req.file.mimetype);
  const problem = unsupported(kind, name);
  const webhook = problem ? null : await webhookOrFail(req.body.webhook, res);
  if (problem || webhook === false) {
    await removeFile(req.file.path);
    return problem ? res.status(415).json({ error: problem }) : undefined;
  }
  // With object storage, move the file into the bucket so any worker can read it.
  const where = await storage.putInput({ id: crypto.randomUUID(), inputPath: req.file.path });
  const job = await jobs.create({ kind, name, ...where, inputSize: req.file.size, options: parseOptions(req.body.options)[kind], webhook });
  res.json(publicJob(job));
});

// ---------------------------------------------------------------------------
// Chunked, resumable uploads — modelled on S3 multipart uploads (init → parts → complete), so with
// STORAGE=s3 the browser sends parts straight to the bucket through presigned URLs.
// ---------------------------------------------------------------------------

async function publicUpload(u, received) {
  return {
    uploadId: u.id,
    partSize: u.partSize,
    partCount: u.partCount,
    concurrency: UPLOAD_CONCURRENCY,
    // true: PUT parts to presigned storage URLs from POST …/parts/:n/url; false: PUT them here.
    direct: storage.direct,
    received: received ?? (await receivedParts(u)),
  };
}

/** Parts already stored: listed by the bucket (s3) or recorded as they arrived (local). */
function receivedParts(u) {
  return storage.direct ? storage.receivedParts(u) : store.uploadParts(u.id);
}

function partLength(u, n) {
  return n < u.partCount ? u.partSize : u.size - (u.partCount - 1) * u.partSize;
}

app.post('/api/uploads', async (req, res) => {
  const name = String(req.body?.name || '');
  const size = Number(req.body?.size);
  if (!name || !Number.isSafeInteger(size) || size <= 0) return res.status(400).json({ error: 'name and size are required' });
  const kind = detectKind(name, String(req.body?.type || ''));
  const problem = unsupported(kind, name);
  if (problem) return res.status(415).json({ error: problem });
  if (MAX_UPLOAD_BYTES && size > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: `File is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit` });
  }
  const id = crypto.randomUUID();
  const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const partSize = partSizeFor(size);
  const u = {
    id, name, kind, size, ext,
    file: path.join(UPLOAD_DIR, `${id}${ext}`), // local storage writes parts here
    partSize,
    partCount: Math.ceil(size / partSize),
    createdAt: Date.now(),
  };
  try {
    await storage.initUpload(u);
  } catch (err) {
    console.error('initUpload:', err);
    return res.status(502).json({ error: `Storage error: ${err.message}` });
  }
  await store.saveUpload(u);
  res.status(201).json(await publicUpload(u, []));
});

/** Loads an upload and validates the part number; sends the error response itself. */
async function uploadPart(req, res) {
  const u = await store.getUpload(req.params.id);
  if (!u) return void res.status(404).json({ error: 'Upload not found' });
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1 || n > u.partCount) return void res.status(400).json({ error: `Part must be 1–${u.partCount}` });
  return { u, n };
}

app.get('/api/uploads/:id', async (req, res) => {
  const u = await store.getUpload(req.params.id);
  if (!u) return res.status(404).json({ error: 'Upload not found' });
  try {
    res.json(await publicUpload(u));
  } catch (err) {
    res.status(502).json({ error: `Storage error: ${err.message}` });
  }
});

app.post('/api/uploads/:id/parts/:n/url', async (req, res) => {
  const p = await uploadPart(req, res);
  if (!p) return;
  if (!storage.direct) return res.status(409).json({ error: 'Parts are uploaded to this server: PUT /api/uploads/:id/parts/:n' });
  res.json({ url: await storage.partUrl(p.u, p.n) });
});

app.put('/api/uploads/:id/parts/:n', async (req, res) => {
  const p = await uploadPart(req, res);
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
  if (!(await store.getUpload(u.id))) return res.status(404).json({ error: 'Upload not found' }); // aborted meanwhile
  await store.addUploadPart(u.id, n);
  // S3 returns an ETag per part that CompleteMultipartUpload needs; mirror that contract.
  const etag = `"${u.id.slice(0, 8)}-${n}"`;
  res.setHeader('ETag', etag);
  res.json({ number: n, etag });
});

app.post('/api/uploads/:id/complete', async (req, res) => {
  const u = await store.getUpload(req.params.id);
  if (!u) return res.status(404).json({ error: 'Upload not found' });
  const webhook = await webhookOrFail(req.body?.webhook, res);
  if (webhook === false) return;
  const where = await finishChunked(u, res);
  if (!where) return;
  const job = await jobs.create({ kind: u.kind, name: u.name, ...where, inputSize: u.size, options: parseOptions(req.body?.options)[u.kind], webhook });
  res.json(publicJob(job));
});

/**
 * Checks that every part of an upload arrived, then assembles it. Sends the error response itself
 * and returns undefined on failure.
 */
async function finishChunked(u, res) {
  try {
    const received = new Set(await receivedParts(u));
    const missing = [];
    for (let n = 1; n <= u.partCount; n++) if (!received.has(n)) missing.push(n);
    if (missing.length) {
      return void res.status(409).json({ error: `Missing parts: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}`, missing });
    }
    const where = await storage.finishUpload(u);
    await store.deleteUpload(u.id);
    return where;
  } catch (err) {
    console.error('finishUpload:', err);
    return void res.status(502).json({ error: `Storage error: ${err.message}` });
  }
}

app.delete('/api/uploads/:id', async (req, res) => {
  const u = await store.getUpload(req.params.id);
  if (u) {
    await store.deleteUpload(u.id);
    await storage.abortUpload(u);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Animations: several still images → one animated GIF / WebP / MP4
// ---------------------------------------------------------------------------

const MAX_FRAMES = 1000;

/**
 * Two ways in:
 *   JSON       { frames: [uploadId, …], options: { animation: {…} }, webhook? }
 *              — each frame uploaded with the chunked API (POST /api/uploads … parts), not completed
 *   multipart  fields `frames` (files, in order), `options` (JSON), `webhook`
 */
app.post('/api/animations', upload.array('frames', MAX_FRAMES), async (req, res) => {
  const files = /** @type {Express.Multer.File[] | undefined} */ (req.files);
  const cleanup = () => Promise.all((files || []).map((f) => removeFile(f.path)));
  const webhook = await webhookOrFail(req.body?.webhook, res);
  if (webhook === false) return void (await cleanup());
  const options = parseOptions(req.body?.options).animation || {};

  /** @type {Array<{ inputPath: string|null, inputKey: string|null, name: string, size: number }>} */
  let inputs = [];
  const tooFew = () => res.status(400).json({ error: 'An animation needs at least 2 images' });
  if (files?.length) {
    // Check every frame before storing any, so a refused request leaves nothing behind.
    const names = files.map((f) => Buffer.from(f.originalname, 'latin1').toString('utf8'));
    const bad = names.find((name, i) => detectKind(name, files[i].mimetype) !== 'image');
    if (bad !== undefined || files.length < 2) {
      await cleanup();
      return bad !== undefined ? res.status(415).json({ error: `Not an image: ${bad}` }) : tooFew();
    }
    for (const [i, f] of files.entries()) {
      inputs.push({ ...(await storage.putInput({ id: crypto.randomUUID(), inputPath: f.path })), name: names[i], size: f.size });
    }
  } else {
    const ids = Array.isArray(req.body?.frames) ? req.body.frames.map(String) : [];
    if (ids.length < 2) return tooFew(); // before any upload is used up
    if (ids.length > MAX_FRAMES) return res.status(400).json({ error: `At most ${MAX_FRAMES} frames` });
    const ups = await Promise.all(ids.map((id) => store.getUpload(id)));
    const missing = ids.filter((_, i) => !ups[i]);
    if (missing.length) return res.status(404).json({ error: `Upload not found: ${missing.slice(0, 5).join(', ')}` });
    const notImage = ups.find((u) => u.kind !== 'image');
    if (notImage) return res.status(415).json({ error: `Not an image: ${notImage.name}` });
    try {
      for (const u of ups) {
        const got = new Set(await receivedParts(u));
        for (let n = 1; n <= u.partCount; n++) {
          if (!got.has(n)) return res.status(409).json({ error: `Upload ${u.id} is missing part ${n}` });
        }
      }
      for (const u of ups) {
        inputs.push({ ...(await storage.finishUpload(u)), name: u.name, size: u.size });
        await store.deleteUpload(u.id);
      }
    } catch (err) {
      console.error('animation frames:', err);
      return res.status(502).json({ error: `Storage error: ${err.message}` });
    }
  }
  const job = await jobs.create({
    kind: 'animation',
    name: `${inputs[0].name} +${inputs.length - 1}`,
    inputs,
    inputSize: inputs.reduce((sum, i) => sum + i.size, 0),
    options,
    webhook,
  });
  res.json(publicJob(job));
});

// ---------------------------------------------------------------------------
// Subtitles: speech → SRT/WebVTT (whisper.cpp), or a subtitle file → a video
// ---------------------------------------------------------------------------

const SUBTITLE_EXT = /\.(srt|vtt)$/i;

/** Refuses what this server can't do before anything is stored. Returns an error message or null. */
function subtitleProblem(kind, name, o) {
  if (kind !== 'video' && kind !== 'audio') return { status: 415, error: `Not a video or audio file: ${name}` };
  if (o.text != null && String(o.text).trim()) {
    try {
      subtitles.parseSubtitles(String(o.text));
    } catch (err) {
      return { status: 400, error: err.message };
    }
  }
  // A ROLE=web server hands the work to workers, which may have tools this machine lacks.
  const local = process.env.ROLE !== 'web';
  if (local && !(o.text && String(o.text).trim()) && !caps.whisper) {
    return { status: 400, error: 'Speech recognition is not installed on this server (whisper.cpp); send your own subtitle file instead' };
  }
  if (local && o.embed === 'burn' && !caps.burnSubtitles) return { status: 400, error: 'This server can\'t burn in subtitles (ffmpeg without libass); use embed "track"' };
  if (o.embed && o.embed !== 'none' && kind !== 'video') return { status: 400, error: 'Subtitles can only be added to a video' };
  return null;
}

/**
 * Two ways in:
 *   JSON       { upload: uploadId, options: { subtitles: {…} }, webhook? } — a chunked upload, not completed
 *   multipart  fields `file` (video/audio), optional `subtitles` (.srt/.vtt to use instead of transcribing),
 *              `options` (JSON), `webhook`
 */
app.post('/api/subtitles', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'subtitles', maxCount: 1 }]), async (req, res) => {
  const fields = /** @type {Record<string, Express.Multer.File[]> | undefined} */ (req.files);
  const file = fields?.file?.[0];
  const subFile = fields?.subtitles?.[0];
  const cleanup = () => Promise.all([file, subFile].map((f) => removeFile(f?.path)));
  const options = { ...(parseOptions(req.body?.options).subtitles || {}) };

  if (subFile) {
    const subName = Buffer.from(subFile.originalname, 'latin1').toString('utf8');
    if (!SUBTITLE_EXT.test(subName) || subFile.size > 4 * MiB) {
      await cleanup();
      return res.status(415).json({ error: `Subtitles must be an .srt or .vtt file under 4 MB: ${subName}` });
    }
    options.text = await fsp.readFile(subFile.path, 'utf8');
    await removeFile(subFile.path);
  }
  const webhook = await webhookOrFail(req.body?.webhook, res);
  if (webhook === false) return void (await cleanup());

  let where;
  let name;
  let size;
  let kind;
  if (file) {
    name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    kind = detectKind(name, file.mimetype);
    const problem = subtitleProblem(kind, name, options);
    if (problem) {
      await cleanup();
      return res.status(problem.status).json({ error: problem.error });
    }
    where = await storage.putInput({ id: crypto.randomUUID(), inputPath: file.path });
    size = file.size;
  } else {
    if (!req.body?.upload) return res.status(400).json({ error: 'Send a file, or the id of a chunked upload as "upload"' });
    const u = await store.getUpload(String(req.body.upload));
    if (!u) return res.status(404).json({ error: 'Upload not found' });
    const problem = subtitleProblem(u.kind, u.name, options);
    if (problem) return res.status(problem.status).json({ error: problem.error });
    where = await finishChunked(u, res);
    if (!where) return;
    ({ name, size, kind } = u);
  }
  const job = await jobs.create({ kind: 'subtitles', name, ...where, inputSize: size, options, webhook });
  res.json(publicJob(job));
});

// The subtitles of a finished subtitles job, whatever its output (a file, a track or burned in).
app.get('/api/jobs/:id/subtitles', async (req, res) => {
  const job = await jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.kind !== 'subtitles' || !job.transcript) return res.status(404).json({ error: 'No subtitles for this job (yet)' });
  const format = req.query.format === 'vtt' ? 'vtt' : 'srt';
  const text = format === 'vtt' ? subtitles.formatSubtitles(subtitles.parseSubtitles(job.transcript), 'vtt') : job.transcript;
  const lang = job.info?.language ? `.${job.info.language}` : '';
  res.type(format === 'vtt' ? 'text/vtt' : 'application/x-subrip');
  res.setHeader('Content-Disposition', contentDisposition(req.query.download ? 'attachment' : 'inline', `${path.parse(job.name).name}${lang}.${format}`));
  res.send(text);
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const idList = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500);

// Several jobs at once: GET /api/jobs?ids=a,b,c (unknown ids are left out).
app.get('/api/jobs', async (req, res) => {
  const found = await Promise.all(idList(req.query.ids).map((id) => jobs.get(id)));
  res.json(found.filter(Boolean).map(publicJob));
});

// Every finished result as one ZIP: GET /api/jobs/zip?ids=a,b,c
app.get('/api/jobs/zip', async (req, res) => {
  const done = (await Promise.all(idList(req.query.ids).map((id) => jobs.get(id)))).filter((j) => j?.status === 'done');
  if (!done.length) return res.status(404).json({ error: 'No finished jobs among these ids' });
  const yazl = require('yazl');
  const zip = new yazl.ZipFile();
  const used = new Set();
  const unique = (name) => {
    let candidate = name;
    for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = name.replace(/(\.[^.]*)?$/, ` (${i})$1`);
    used.add(candidate.toLowerCase());
    return candidate;
  };
  res.type('application/zip');
  res.setHeader('Content-Disposition', contentDisposition('attachment', `compressed-${new Date().toISOString().slice(0, 10)}.zip`));
  zip.outputStream.pipe(res);
  try {
    for (const job of done) {
      // Media is already compressed: store it as-is (no deflate) and stream it straight through.
      zip.addReadStream(await storage.openOutput(job), unique(job.outputName), { compress: false, size: job.outputSize });
    }
  } catch (err) {
    console.error('zip:', err.message);
  }
  zip.end();
});

app.get('/api/jobs/:id', async (req, res) => {
  const job = await jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(publicJob(job));
});

// Live updates as Server-Sent Events until the job finishes: `event: job` with the job JSON.
app.get('/api/jobs/:id/events', async (req, res) => {
  let job = await jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  let last = '';
  let beat = Date.now();
  const send = () => {
    const data = JSON.stringify(publicJob(job));
    if (data !== last) {
      res.write(`event: job\ndata: ${data}\n\n`);
      last = data;
      beat = Date.now();
    } else if (Date.now() - beat > 15_000) {
      res.write(': keep-alive\n\n'); // stops proxies from closing an idle stream
      beat = Date.now();
    }
  };
  send();
  const timer = setInterval(async () => {
    job = await jobs.get(req.params.id).catch(() => job);
    if (!job) {
      res.write('event: gone\ndata: {}\n\n');
      return end();
    }
    send();
    if (!ACTIVE.has(job.status)) end();
  }, 500);
  const end = () => {
    clearInterval(timer);
    res.end();
  };
  req.on('close', () => clearInterval(timer));
  if (!ACTIVE.has(job.status)) end();
});

app.post('/api/jobs/:id/retry', async (req, res) => {
  const current = await jobs.get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Job not found' });
  const options = parseOptions(req.body?.options)[current.kind];
  res.json(publicJob(await jobs.retry(current.id, options)));
});

app.post('/api/jobs/:id/cancel', async (req, res) => {
  const job = await jobs.cancel(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(publicJob(job));
});

app.delete('/api/jobs/:id', async (req, res) => {
  await jobs.remove(req.params.id);
  res.json({ ok: true });
});

app.get('/api/jobs/:id/file', async (req, res) => {
  const job = await jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).send('Result not ready');
  // Object storage: send the browser straight to the bucket instead of streaming it through here.
  const url = await storage.outputUrl(job, { inline: !!req.query.inline });
  if (url) return res.redirect(302, url);
  res.type(job.outputMime || 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(req.query.inline ? 'inline' : 'attachment', job.outputName));
  res.sendFile(job.outputPath);
});

app.get('/api/jobs/:id/original', async (req, res) => {
  let job = await jobs.get(req.params.id);
  if (!job) return res.status(404).send('Job not found');
  if (job.inputs) job = { ...job, ...job.inputs[0] }; // animations: the first frame
  const url = await storage.inputUrl(job);
  if (url) return res.redirect(302, url);
  res.sendFile(job.inputPath);
});

app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit` });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    // More `frames` than an animation may have, or a file in an unknown field.
    return res.status(400).json({ error: err.field === 'frames' ? `At most ${MAX_FRAMES} frames` : `Unexpected file field: ${err.field}` });
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

/**
 * Starts the web server and/or a worker.
 * @param {{ port?: number, host?: string, role?: string }} [opts]
 */
async function start({
  port = Number(process.env.PORT) || 4747,
  host = process.env.HOST || '127.0.0.1',
  role = (process.env.ROLE || 'all').toLowerCase(),
} = {}) {
  if (!['all', 'web', 'worker'].includes(role)) {
    console.error(`Unknown ROLE "${role}" — use all, web or worker`);
    process.exit(1);
  }
  if (store.kind === 'memory' && role !== 'all') {
    console.error(`ROLE=${role} needs a shared queue: set QUEUE=redis and REDIS_URL`);
    process.exit(1);
  }
  // With the in-memory queue nothing survives a restart, so leftovers can go. With Redis the
  // folders may be shared with other instances; the sweeper removes expired files instead.
  for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
    if (store.kind === 'memory') await fsp.rm(dir, { recursive: true, force: true });
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

  if (role !== 'web') await store.startWorker((id, run) => jobs.processJob(id, run), { media: MEDIA_CONCURRENCY, image: IMAGE_CONCURRENCY });
  const sweeper = role !== 'worker' ? setInterval(() => jobs.sweep().catch((err) => console.error('sweep:', err.message)), 10 * 60 * 1000) : null;
  sweeper?.unref();

  const banner = [
    `  Hardware encoder: ${caps.hardwareName || 'none'} · AV1: ${caps.av1 ? 'yes' : 'no'} · HEIC: ${caps.heicDecoder || 'unsupported'} · PDF: ${caps.pdf ? 'yes' : 'no'}`,
    `  Storage: ${where} · Queue: ${store.kind}${store.kind === 'redis' ? ` (role: ${role})` : ''}`,
  ];

  let server = null;
  if (role !== 'worker') {
    // Binding 127.0.0.1 succeeds even when another app holds the port on IPv6 (*:PORT),
    // which makes "localhost" ambiguous — so refuse if anything already answers.
    if (await portTaken(port)) {
      console.error(`\n  Port ${port} is already in use by another app. Pick another one, e.g.  PORT=4848 npm start\n`);
      process.exit(1);
    }
    server = app.listen(port, host, () => {
      const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
      console.log(`\n  Compress Media v${pkg.version} running at  http://${shown}:${port}`);
      console.log(banner.join('\n'));
      console.log(`  Upload parts: ${UPLOAD_PART_BYTES / MiB} MB × ${UPLOAD_CONCURRENCY} in parallel`);
      if (!auth.enabled) {
        console.log('  Login: disabled (AUTH_ENABLED=false) — anyone who can reach this port can use it\n');
      } else if (auth.generated) {
        console.log(`  Login: ${auth.username} / ${auth.password}   (generated; set AUTH_PASSWORD, or see ${auth.file})\n`);
      } else {
        console.log(`  Login: ${auth.username} / (AUTH_PASSWORD)${auth.token ? ' · API token enabled' : ''}\n`);
      }
    });
  } else {
    console.log(`\n  Compress Media v${pkg.version} worker (media × ${MEDIA_CONCURRENCY}, images × ${IMAGE_CONCURRENCY})`);
    console.log(`${banner.join('\n')}\n`);
  }

  const shutdown = async (signal) => {
    console.log(`\n  ${signal} received, shutting down…`);
    jobs.stopAll();
    setTimeout(() => process.exit(0), 3000).unref();
    if (server) {
      server.close();
      server.closeAllConnections();
    }
    await store.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { app, start };
