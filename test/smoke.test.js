'use strict';

// End-to-end smoke test: boots the real server, generates tiny media files with ffmpeg,
// compresses each kind and checks the results. Run with `npm test`.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const ffmpeg = process.env.FFMPEG_PATH || require('ffmpeg-static');

const PORT = 47000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compress-media-test-'));
let server;

// Async on purpose: blocking the event loop while ffmpeg runs lets the server close an idle
// keep-alive socket that fetch then reuses, which fails with EPIPE.
async function gen(name, args) {
  const file = path.join(tmp, name);
  await promisify(execFile)(ffmpeg, ['-v', 'error', '-y', ...args, file]);
  return file;
}

async function submit(file, options = {}) {
  const form = new FormData();
  form.append('options', JSON.stringify(options));
  form.append('file', await fs.openAsBlob(file), path.basename(file));
  const res = await fetch(`${BASE}/api/jobs`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

async function waitFor(id, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const job = await (await fetch(`${BASE}/api/jobs/${id}`)).json();
    if (!['queued', 'processing'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`job ${id} timed out`);
}

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    // Small parts so the chunked-upload test spans several of them (S3 requires at least 5 MiB).
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', WORK_DIR: path.join(tmp, 'work'),
      UPLOAD_PART_MB: process.env.STORAGE === 's3' ? '5' : '1',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
});

after(() => {
  server?.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('exposes config', async () => {
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  assert.equal(typeof cfg.version, 'string');
  assert.equal(typeof cfg.hardwareEncoder, 'boolean');
});

test('compresses a video, downscaling and capping fps', async () => {
  const input = await gen('clip.mov', [
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '2', '-c:v', 'libx264', '-crf', '5', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le',
  ]);
  const { body } = await submit(input, { video: { quality: 'small', speed: 'veryfast', resolution: '720', fps: '30' } });
  const job = await waitFor(body.id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.outputName, 'clip-compressed.mp4');
  assert.ok(job.outputSize < job.inputSize, 'output should be smaller');

  const res = await fetch(`${BASE}/api/jobs/${job.id}/file`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="clip-compressed\.mp4"/);
  await res.arrayBuffer();
});

test('converts an image to WebP and resizes it', async () => {
  const input = await gen('shot.png', ['-f', 'lavfi', '-i', 'testsrc2=size=1600x1000', '-frames:v', '1']);
  const { body } = await submit(input, { image: { format: 'webp', quality: 70, maxDim: '800' } });
  const job = await waitFor(body.id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.outputMime, 'image/webp');
  assert.ok(job.outputSize < job.inputSize);
});

test('compresses audio to MP3', async () => {
  const input = await gen('voice.wav', ['-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '3']);
  const { body } = await submit(input, { audio: { format: 'mp3', bitrate: '64', mono: true } });
  const job = await waitFor(body.id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.outputMime, 'audio/mpeg');
  assert.ok(job.outputSize < job.inputSize);
});

test('keeps non-ASCII filenames intact', async () => {
  const input = await gen('Màn hình ghi.wav', ['-f', 'lavfi', '-i', 'sine', '-t', '1']);
  const { body } = await submit(input, { audio: { format: 'm4a' } });
  const job = await waitFor(body.id);
  assert.equal(job.outputName, 'Màn hình ghi-compressed.m4a');
  const res = await fetch(`${BASE}/api/jobs/${job.id}/file`);
  assert.match(res.headers.get('content-disposition'), /filename="Man hinh ghi-compressed\.m4a"; filename\*=UTF-8''M%C3%A0n/);
  await res.arrayBuffer();
});

test('rejects unsupported files', async () => {
  const file = path.join(tmp, 'notes.txt');
  fs.writeFileSync(file, 'hello');
  const { status, body } = await submit(file);
  assert.equal(status, 415);
  assert.match(body.error, /Unsupported/);
});

test('cancels, retries and deletes a job', async () => {
  const input = await gen('long.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast']);
  const { body } = await submit(input, { video: { codec: 'h265', speed: 'slow', quality: 'high' } });
  const cancelled = await (await fetch(`${BASE}/api/jobs/${body.id}/cancel`, { method: 'POST' })).json();
  assert.equal(cancelled.status, 'cancelled');

  const retried = await fetch(`${BASE}/api/jobs/${body.id}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ options: { video: { quality: 'tiny', speed: 'ultrafast', resolution: '480' } } }),
  });
  assert.equal((await retried.json()).status, 'queued');
  const job = await waitFor(body.id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.options.resolution, '480');

  await fetch(`${BASE}/api/jobs/${body.id}`, { method: 'DELETE' });
  assert.equal((await fetch(`${BASE}/api/jobs/${body.id}`)).status, 404);
});

test('chunked upload: parts in any order, validation, resume status, complete', async () => {
  // Lossless, so it's big enough (> 10 MB) to span several parts even at S3's 5 MiB minimum.
  const input = await gen('chunked.mov', [
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '4', '-c:v', 'libx264', '-crf', '0', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  ]);
  const bytes = fs.readFileSync(input);
  const json = (method, url, body) => fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });

  // Unsupported types are rejected before any byte is uploaded.
  assert.equal((await json('POST', '/api/uploads', { name: 'notes.txt', size: 10 })).status, 415);

  const init = await json('POST', '/api/uploads', { name: 'chunked.mov', size: bytes.length });
  assert.equal(init.status, 201);
  const up = await init.json();
  assert.ok(up.partCount >= 2, `fixture should span several ${up.partSize}-byte parts`);
  const part = (n) => bytes.subarray((n - 1) * up.partSize, Math.min(n * up.partSize, bytes.length));
  // STORAGE=local: PUT parts to this server. STORAGE=s3: PUT them to presigned bucket URLs.
  const put = async (n, body = part(n)) => {
    if (!up.direct) {
      return fetch(`${BASE}/api/uploads/${up.uploadId}/parts/${n}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body,
      });
    }
    const { url } = await (await json('POST', `/api/uploads/${up.uploadId}/parts/${n}/url`)).json();
    return fetch(url, { method: 'PUT', body });
  };

  if (up.direct) {
    // Size checks happen in the bucket; here we only check the server refuses bad part numbers.
    // (Re-uploading a part number isn't exercised: S3 overwrites it, but some stores keep both.)
    assert.equal((await json('POST', `/api/uploads/${up.uploadId}/parts/${up.partCount + 1}/url`)).status, 400, 'out-of-range part is refused');
  } else {
    assert.equal((await put(1, part(1).subarray(1))).status, 400, 'wrong part size is refused');
    assert.equal((await put(up.partCount + 1, part(1))).status, 400, 'out-of-range part is refused');
  }

  // Upload every part except the first, last one first.
  for (let n = up.partCount; n >= 2; n--) {
    const res = await put(n);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('etag'));
  }
  const early = await json('POST', `/api/uploads/${up.uploadId}/complete`, {});
  assert.equal(early.status, 409);
  assert.deepEqual((await early.json()).missing, [1]);

  // A resuming client learns which parts the server already has.
  const status = await (await fetch(`${BASE}/api/uploads/${up.uploadId}`)).json();
  assert.equal(status.received.length, up.partCount - 1);

  assert.equal((await put(1)).status, 200);
  const done = await json('POST', `/api/uploads/${up.uploadId}/complete`, { options: { video: { quality: 'tiny', speed: 'ultrafast', resolution: '480' } } });
  assert.equal(done.status, 200);
  const job = await waitFor((await done.json()).id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.inputSize, bytes.length);

  // The reassembled upload is byte-identical to the source.
  const original = Buffer.from(await (await fetch(`${BASE}/api/jobs/${job.id}/original`)).arrayBuffer());
  assert.ok(original.equals(bytes));
  assert.equal((await fetch(`${BASE}/api/uploads/${up.uploadId}`)).status, 404, 'upload record is gone after complete');
});
