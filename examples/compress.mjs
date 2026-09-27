// Compress files through a running Compress Media server with the chunked upload API.
// Node.js 20+, no dependencies. Works with STORAGE=local and STORAGE=s3 servers.
//
//   node compress.mjs "Screen Recording.mov" '{"video":{"resolution":1080,"fps":30}}'
//   COMPRESS_MEDIA_URL=https://media.example.com node compress.mjs photo.png '{"image":{"format":"webp"}}'

import { createWriteStream, openAsBlob } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.COMPRESS_MEDIA_URL || 'http://localhost:4747';

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${url} → HTTP ${res.status}`);
  return data;
}

/** Uploads one part, retrying network errors and 5xx with exponential backoff. */
async function putPart(upload, n, blob) {
  for (let attempt = 0; ; attempt++) {
    try {
      const url = upload.direct
        ? (await api('POST', `/api/uploads/${upload.uploadId}/parts/${n}/url`)).url // presigned bucket URL
        : `${BASE}/api/uploads/${upload.uploadId}/parts/${n}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: upload.direct ? {} : { 'Content-Type': 'application/octet-stream' },
        body: blob,
      });
      if (res.ok) return;
      if (res.status < 500) throw Object.assign(new Error(`part ${n}: HTTP ${res.status}`), { fatal: true });
    } catch (err) {
      if (err.fatal || attempt >= 4) throw err;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
}

export async function compressFile(file, options = {}) {
  const blob = await openAsBlob(file);

  // 1. Start: the server decides part size/count and whether parts go to it or to object storage.
  const upload = await api('POST', '/api/uploads', { name: path.basename(file), size: blob.size });

  // 2. Parts, `upload.concurrency` at a time. After a crash, GET /api/uploads/:id lists what's already there.
  const pending = Array.from({ length: upload.partCount }, (_, i) => i + 1).filter((n) => !upload.received.includes(n));
  await Promise.all(Array.from({ length: upload.concurrency }, async () => {
    for (let n; (n = pending.shift()); ) {
      const start = (n - 1) * upload.partSize;
      await putPart(upload, n, blob.slice(start, start + upload.partSize));
    }
  }));

  // 3. Complete → job; 4. poll until it finishes.
  let job = await api('POST', `/api/uploads/${upload.uploadId}/complete`, { options });
  while (['queued', 'processing'].includes(job.status)) {
    await new Promise((r) => setTimeout(r, 1000));
    job = await api('GET', `/api/jobs/${job.id}`);
  }
  if (job.status !== 'done') throw new Error(`job ${job.status}: ${job.error}`);

  // 5. Download (fetch follows the redirect to object storage) and delete the job.
  const out = path.join(path.dirname(file), job.outputName);
  const res = await fetch(`${BASE}/api/jobs/${job.id}/file`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(out)); // streamed: results can be large
  await api('DELETE', `/api/jobs/${job.id}`);
  return { output: out, inputSize: job.inputSize, outputSize: job.outputSize };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, options = '{}'] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node compress.mjs <file> [options-json]');
    process.exit(2);
  }
  const r = await compressFile(file, JSON.parse(options));
  console.log(`${r.inputSize} → ${r.outputSize} bytes  ${r.output}`);
}
