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
      // Speech models are big: share the CLI's cache instead of downloading into the temp WORK_DIR.
      WHISPER_MODELS_DIR: process.env.WHISPER_MODELS_DIR || path.join(os.homedir(), '.cache', 'compress-media', 'models'),
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

test('animations: multipart frames or chunked uploads → one animated job', async () => {
  const red = await gen('red.png', ['-f', 'lavfi', '-i', 'color=c=red:size=320x200', '-frames:v', '1']);
  const blue = await gen('blue.jpg', ['-f', 'lavfi', '-i', 'color=c=blue:size=200x320', '-frames:v', '1']);
  const wav = await gen('beep.wav', ['-f', 'lavfi', '-i', 'sine', '-t', '1']);
  const sharp = require('sharp');

  const post = async (files, options) => {
    const form = new FormData();
    form.append('options', JSON.stringify(options));
    for (const f of files) form.append('frames', await fs.openAsBlob(f), path.basename(f));
    const res = await fetch(`${BASE}/api/animations`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
  };

  assert.equal((await post([red], {})).status, 400, 'one frame is not an animation');
  assert.equal((await post([red, wav], {})).status, 415, 'frames must be images');
  const json0 = (body) => fetch(`${BASE}/api/animations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await json0({ frames: ['nope'] })).status, 400, 'too few frames is checked before uploads are looked up');
  assert.equal((await json0({ frames: ['nope', 'nada'] })).status, 404);

  const made = await post([red, blue, red], { animation: { format: 'gif', delay: 300, maxDim: 160 } });
  assert.equal(made.status, 200, made.body.error);
  assert.equal(made.body.kind, 'animation');
  assert.deepEqual(made.body.frames.map((f) => f.name), ['red.png', 'blue.jpg', 'red.png']);
  const job = await waitFor(made.body.id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.outputName, 'red-animated.gif');
  assert.deepEqual([job.info.frames, job.info.width, job.info.height], [3, 160, 100]);
  const gif = Buffer.from(await (await fetch(`${BASE}/api/jobs/${job.id}/file`)).arrayBuffer());
  const meta = await sharp(gif, { animated: true }).metadata();
  assert.equal(meta.pages, 3);
  assert.deepEqual(meta.delay, [300, 300, 300]);
  // "original" is the first frame
  assert.equal((await fetch(`${BASE}/api/jobs/${job.id}/original`)).headers.get('content-type'), 'image/png');

  // Redo with other options, like the UI's Redo button.
  const redo = await (await fetch(`${BASE}/api/jobs/${job.id}/retry`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ options: { animation: { format: 'webp' } } }),
  })).json();
  assert.ok(['queued', 'processing'].includes(redo.status), redo.status);
  const again = await waitFor(job.id);
  assert.equal(again.outputName, 'red-animated.webp');

  // Chunked: upload each frame, then reference the upload ids.
  const json = (method, url, body) => fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const uploadIds = [];
  for (const f of [blue, red]) {
    const bytes = fs.readFileSync(f);
    const up = await (await json('POST', '/api/uploads', { name: path.basename(f), size: bytes.length })).json();
    assert.equal(up.partCount, 1);
    const url = up.direct ? (await (await json('POST', `/api/uploads/${up.uploadId}/parts/1/url`)).json()).url : `${BASE}/api/uploads/${up.uploadId}/parts/1`;
    assert.equal((await fetch(url, { method: 'PUT', body: bytes, headers: up.direct ? {} : { 'Content-Type': 'application/octet-stream' } })).status, 200);
    uploadIds.push(up.uploadId);
  }
  const chunked = await json('POST', '/api/animations', { frames: uploadIds, options: { animation: { format: 'mp4', delay: 500 } } });
  assert.equal(chunked.status, 200);
  const done = await waitFor((await chunked.json()).id);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.outputName, 'blue-animated.mp4');
  assert.equal(done.info.width % 2, 0);
  // The uploads were consumed by the job.
  assert.equal((await json('GET', `/api/uploads/${uploadIds[0]}`)).status, 404);
  assert.equal((await json('POST', '/api/animations', { frames: uploadIds })).status, 404, 'upload ids can only be used once');

  await fetch(`${BASE}/api/jobs/${job.id}`, { method: 'DELETE' });
  assert.equal((await fetch(`${BASE}/api/jobs/${job.id}`)).status, 404);
});

/** Speech in a video, made with the system's text-to-speech (`say` on macOS, espeak-ng on Linux). */
async function speechVideo() {
  const run = promisify(execFile);
  const speech = path.join(tmp, 'speech.aiff');
  const text = 'Hello everyone. Today I will show you how to compress a screen recording.';
  try {
    if (process.platform === 'darwin') await run('say', ['-v', 'Samantha', '-o', speech, text]);
    else await run('espeak-ng', ['-w', speech, text]);
  } catch {
    return null;
  }
  return gen('talk.mov', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-i', speech, '-shortest',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
}

test('subtitles: your own file as a track, burned in, or converted; errors', async () => {
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  const video = await gen('subs.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine', '-t', '3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
  const srtFile = path.join(tmp, 'subs.srt');
  fs.writeFileSync(srtFile, '1\n00:00:00,500 --> 00:00:01,500\nXin chào\n\n2\n00:00:01,500 --> 00:00:02,500\nmọi người\n');
  const post = async (fields) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === 'string') form.append(k, v);
      else form.append(k, await fs.openAsBlob(v.file), path.basename(v.file));
    }
    const res = await fetch(`${BASE}/api/subtitles`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
  };
  const probeStreams = async (buf, name) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, buf);
    const ffprobe = process.env.FFPROBE_PATH || require('@ffprobe-installer/ffprobe').path;
    const { stdout } = await promisify(execFile)(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', file]);
    return JSON.parse(stdout).streams;
  };

  // A selectable track: streams are copied, the subtitles become mov_text tagged "vie".
  const track = await post({ file: { file: video }, subtitles: { file: srtFile }, options: JSON.stringify({ subtitles: { embed: 'track', language: 'vi' } }) });
  assert.equal(track.status, 200, track.body.error);
  assert.equal(track.body.kind, 'subtitles');
  assert.equal(track.body.options.text, undefined, 'the text is not echoed back');
  let job = await waitFor(track.body.id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.outputName, 'subs-subtitled.mp4');
  assert.deepEqual([job.info.cues, job.info.language, job.info.embed], [2, 'vi', 'track']);
  const streams = await probeStreams(Buffer.from(await (await fetch(`${BASE}/api/jobs/${job.id}/file`)).arrayBuffer()), 'track.mp4');
  const sub = streams.find((st) => st.codec_type === 'subtitle');
  assert.equal(sub.codec_name, 'mov_text');
  assert.equal(sub.tags.language, 'vie');
  assert.equal(streams.find((st) => st.codec_type === 'video').codec_name, 'h264');

  // The subtitles stay available whatever the output, as SRT or WebVTT.
  const vtt = await fetch(`${BASE}/api/jobs/${job.id}/subtitles?format=vtt`);
  assert.equal(vtt.headers.get('content-type').split(';')[0], 'text/vtt');
  assert.match(await vtt.text(), /^WEBVTT\n\n00:00:00\.500 --> 00:00:01\.500\nXin chào/);
  assert.match(vtt.headers.get('content-disposition'), /subs\.vi\.vtt/);

  // Redo as a subtitle file: the given subtitles are reused, not transcribed.
  await fetch(`${BASE}/api/jobs/${job.id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ options: { subtitles: { embed: 'none', format: 'vtt' } } }) });
  job = await waitFor(job.id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.outputName, 'subs.vi.vtt');
  assert.match(await (await fetch(`${BASE}/api/jobs/${job.id}/file`)).text(), /mọi người/);

  // Burned in (needs ffmpeg with libass): re-encoded, no subtitle stream.
  if (cfg.burnSubtitles) {
    const edited = '1\n00:00:00,000 --> 00:00:03,000\nĐã sửa\n';
    await fetch(`${BASE}/api/jobs/${job.id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ options: { subtitles: { embed: 'burn', text: edited } } }) });
    job = await waitFor(job.id);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.outputName, 'subs-subtitled.mp4');
    const burned = await probeStreams(Buffer.from(await (await fetch(`${BASE}/api/jobs/${job.id}/file`)).arrayBuffer()), 'burn.mp4');
    assert.equal(burned.some((st) => st.codec_type === 'subtitle'), false);
    assert.match(await (await fetch(`${BASE}/api/jobs/${job.id}/subtitles`)).text(), /Đã sửa/, 'the edited text is kept');
  }

  // Errors
  const wav = await gen('voice.wav', ['-f', 'lavfi', '-i', 'sine', '-t', '1']);
  assert.equal((await post({ file: { file: srtFile } })).status, 415, 'not a video');
  assert.equal((await post({ file: { file: wav }, subtitles: { file: srtFile }, options: JSON.stringify({ subtitles: { embed: 'track' } }) })).status, 400, 'audio has no picture');
  const junk = path.join(tmp, 'notes.txt');
  fs.writeFileSync(junk, 'hi');
  assert.equal((await post({ file: { file: video }, subtitles: { file: junk } })).status, 415, 'subtitles must be srt/vtt');
  if (!cfg.whisper) assert.equal((await post({ file: { file: video } })).status, 400, 'no speech recognition without whisper');
  const json = (body) => fetch(`${BASE}/api/subtitles`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await json({ upload: 'nope' })).status, 404);
  assert.equal((await json({})).status, 400);
  // Broken subtitle text is refused up front with a clear message.
  const broken = await post({ file: { file: video }, options: JSON.stringify({ subtitles: { text: 'not subtitles' } }) });
  assert.equal(broken.status, 400);
  assert.match(broken.body.error, /No subtitles found/);
});

test('subtitles: speech recognition (whisper.cpp, when installed)', async (t) => {
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  if (!cfg.whisper) return t.skip('whisper.cpp is not installed');
  const video = await speechVideo();
  if (!video) return t.skip('no text-to-speech (say / espeak-ng) to make a test voice');
  const form = new FormData();
  form.append('file', await fs.openAsBlob(video), 'talk.mov');
  form.append('options', JSON.stringify({ subtitles: { model: 'tiny' } }));
  const res = await (await fetch(`${BASE}/api/subtitles`, { method: 'POST', body: form })).json();
  const job = await waitFor(res.id, 300_000); // the first run downloads the model (75 MB)
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.info.language, 'en');
  assert.equal(job.outputName, 'talk.en.srt');
  const srt = await (await fetch(`${BASE}/api/jobs/${job.id}/file`)).text();
  assert.match(srt, /^1\n00:00:\d\d,\d{3} --> /);
  assert.match(srt.toLowerCase(), /screen recording/);
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
