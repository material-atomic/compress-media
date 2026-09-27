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
      AUTH_ENABLED: 'false', // login is covered by auth.test.js
      WEBHOOK_ALLOW_PRIVATE: 'true', // the test receiver runs on localhost
      WEBHOOK_SECRET: 'hook-secret',
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

after(async () => {
  // Wait for the server to exit: on Windows a running process keeps its files locked (EBUSY).
  if (server && server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); });
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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

test('batch status, ZIP of results, live events and webhooks', async () => {
  const http = require('node:http');
  const crypto = require('node:crypto');
  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      received.push({ body, signature: req.headers['x-compress-media-signature'] });
      res.end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  const hook = `http://127.0.0.1:${receiver.address().port}/hook`;

  const a = await gen('zip-a.wav', ['-f', 'lavfi', '-i', 'sine', '-t', '1']);
  const b = await gen('zip-b.png', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240', '-frames:v', '1']);
  const form = new FormData();
  form.append('options', '{}');
  form.append('webhook', hook);
  form.append('file', await fs.openAsBlob(a), 'zip-a.wav');
  const ja = await (await fetch(`${BASE}/api/jobs`, { method: 'POST', body: form })).json();

  // Server-Sent Events: read until the job reports done.
  const events = await fetch(`${BASE}/api/jobs/${ja.id}/events`);
  assert.equal(events.headers.get('content-type'), 'text/event-stream');
  const statuses = [];
  const reader = events.body.getReader();
  let text = '';
  while (!statuses.includes('done')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString();
    for (const m of text.matchAll(/event: job\ndata: (.+)\n\n/g)) statuses.push(JSON.parse(m[1]).status);
    text = text.slice(text.lastIndexOf('\n\n') + 2);
  }
  assert.ok(statuses.includes('done'), statuses.join(','));

  const jb = (await submit(b)).body;
  await waitFor(jb.id);

  const batch = await (await fetch(`${BASE}/api/jobs?ids=${ja.id},${jb.id},missing`)).json();
  assert.deepEqual(batch.map((j) => j.status), ['done', 'done']);

  const zip = await fetch(`${BASE}/api/jobs/zip?ids=${ja.id},${jb.id}`);
  assert.equal(zip.status, 200);
  assert.match(zip.headers.get('content-disposition'), /attachment; filename="compressed-.*\.zip"/);
  const bytes = Buffer.from(await zip.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  assert.ok(bytes.includes(Buffer.from('zip-a-compressed.mp3')) && bytes.includes(Buffer.from('zip-b-compressed.png')));
  assert.equal((await fetch(`${BASE}/api/jobs/zip?ids=missing`)).status, 404);

  // The webhook arrives signed with WEBHOOK_SECRET.
  for (let i = 0; i < 50 && !received.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1);
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.event, 'job.done');
  assert.equal(payload.job.id, ja.id);
  const expected = `sha256=${crypto.createHmac('sha256', 'hook-secret').update(received[0].body).digest('hex')}`;
  assert.equal(received[0].signature, expected);
  receiver.close();

  // Invalid webhook URLs are refused up front.
  const bad = new FormData();
  bad.append('webhook', 'file:///etc/passwd');
  bad.append('file', await fs.openAsBlob(b), 'zip-b.png');
  assert.equal((await fetch(`${BASE}/api/jobs`, { method: 'POST', body: bad })).status, 400);
});

test('webhook URLs to private networks are refused by default', async () => {
  const saved = process.env.WEBHOOK_ALLOW_PRIVATE;
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
  const { validateWebhook, isPrivateAddress } = require('../lib/webhook');
  try {
    for (const url of ['http://127.0.0.1/x', 'http://localhost/x', 'http://10.0.0.5/x', 'http://[::1]/x', 'http://169.254.169.254/latest']) {
      await assert.rejects(validateWebhook(url), /private or local/, url);
    }
    await assert.rejects(validateWebhook('ftp://example.com/x'), /http\(s\)/);
    assert.equal(isPrivateAddress('93.184.216.34'), false);
    assert.equal(isPrivateAddress('::ffff:192.168.1.1'), true);
  } finally {
    if (saved !== undefined) process.env.WEBHOOK_ALLOW_PRIVATE = saved;
  }
});
