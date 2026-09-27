'use strict';

// Where uploads and results live, chosen with STORAGE=local|s3.
//
//   local  Parts are PUT to this server and written into WORK_DIR; results are served from disk.
//   s3     The browser PUTs parts straight to an S3-compatible bucket through presigned URLs, so
//          upload traffic never touches this server. Results are stored in the bucket and
//          downloaded through presigned URLs. ffmpeg still needs a local copy while it works.
//
// The s3 backend speaks the plain S3 multipart API, so it works with AWS S3, Cloudflare R2,
// Google Cloud Storage (XML API + HMAC keys), MinIO, Backblaze B2, DigitalOcean Spaces, Wasabi…

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');

/** RFC 6266 header with an accent-stripped ASCII fallback for non-ASCII filenames. */
function contentDisposition(type, name) {
  const ascii = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function fromEnv(env = process.env) {
  const kind = (env.STORAGE || 'local').toLowerCase();
  if (kind === 'local') return localStorage();
  if (kind === 's3') {
    const missing = ['S3_BUCKET'].filter((k) => !env[k]);
    if (missing.length) throw new Error(`STORAGE=s3 needs ${missing.join(', ')}`);
    return s3Storage({
      bucket: env.S3_BUCKET,
      region: env.S3_REGION || 'us-east-1',
      endpoint: env.S3_ENDPOINT || undefined,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT || undefined,
      forcePathStyle: /^(1|true|yes)$/i.test(env.S3_FORCE_PATH_STYLE || ''),
      accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
      prefix: env.S3_PREFIX ?? 'compress-media/',
      urlExpires: Number(env.S3_URL_EXPIRES) || 3600,
      publicUrl: env.PUBLIC_URL || undefined,
      setupCors: /^(1|true|yes)$/i.test(env.S3_SETUP_CORS || ''),
    });
  }
  throw new Error(`Unknown STORAGE "${env.STORAGE}" — use "local" or "s3"`);
}

// ---------------------------------------------------------------------------
// Local disk
// ---------------------------------------------------------------------------

/** Removes a file, ignoring "not found". */
const rm = (p) => (p ? fsp.rm(p, { force: true }).catch(() => {}) : Promise.resolve());

function localStorage() {
  return {
    kind: 'local',
    direct: false, // parts go through PUT /api/uploads/:id/parts/:n
    async describe() {
      return 'local disk';
    },
    async initUpload(upload) {
      // Pre-size the file so parts can be written at their offsets in any order, in parallel.
      const fh = await fsp.open(upload.file, 'w');
      await fh.truncate(upload.size);
      await fh.close();
    },
    /** Where a finished upload lives, for the job record. */
    async finishUpload(upload) {
      return { inputPath: upload.file, inputKey: null };
    },
    async abortUpload(upload) {
      await rm(upload.file);
    },
    /** A single-request upload is already on disk. */
    async putInput(job) {
      return { inputPath: job.inputPath, inputKey: null };
    },
    async fetchInput() {
      throw new Error('fetchInput is only used with object storage');
    },
    async inputUrl() {
      return null; // served from disk by the server
    },
    async removeInput(job) {
      await rm(job.inputPath);
    },
    async saveOutput() {
      return {}; // stays at job.outputPath
    },
    async outputUrl() {
      return null; // served from disk by the server
    },
    async openOutput(job) {
      return fs.createReadStream(job.outputPath);
    },
    async removeOutput(job) {
      await rm(job.outputPath);
    },
  };
}

// ---------------------------------------------------------------------------
// S3-compatible object storage
// ---------------------------------------------------------------------------

function s3Storage(cfg) {
  const {
    S3Client, CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand, CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand,
    GetBucketCorsCommand, PutBucketCorsCommand,
  } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const { Upload } = require('@aws-sdk/lib-storage');

  const clientFor = (endpoint) => new S3Client({
    region: cfg.region,
    endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: cfg.accessKeyId ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } : undefined,
    // Newer SDKs add CRC32 checksums to every request by default; presigned browser PUTs can't
    // send them and several S3-compatible providers reject them. Only use them when required.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const s3 = clientFor(cfg.endpoint);
  // Browsers may reach the storage under a different host than this server does
  // (e.g. http://minio:9000 inside Docker vs http://localhost:9000 outside).
  const signer = cfg.publicEndpoint ? clientFor(cfg.publicEndpoint) : s3;
  const Bucket = cfg.bucket;
  const key = (...parts) => `${cfg.prefix}${parts.join('/')}`;

  async function listParts(upload) {
    const parts = [];
    let PartNumberMarker;
    do {
      const res = await s3.send(new ListPartsCommand({ Bucket, Key: upload.key, UploadId: upload.s3UploadId, PartNumberMarker }));
      for (const p of res.Parts || []) parts.push({ PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size });
      PartNumberMarker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
    } while (PartNumberMarker);
    return parts;
  }

  const origin = cfg.publicUrl && new URL(cfg.publicUrl).origin;

  /** Adds a rule letting the app's origin PUT parts and GET results, keeping existing rules. */
  async function setupCors() {
    let rules = [];
    try {
      rules = (await s3.send(new GetBucketCorsCommand({ Bucket }))).CORSRules || [];
    } catch (err) {
      if (err.name !== 'NoSuchCORSConfiguration') throw err;
    }
    const allowed = origin || '*';
    const covered = rules.some((r) => (r.AllowedOrigins || []).some((o) => o === '*' || o === allowed) && (r.AllowedMethods || []).includes('PUT'));
    if (covered) return false;
    rules.push({ AllowedOrigins: [allowed], AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 });
    await s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: rules } }));
    return true;
  }

  /** Asks the bucket the same CORS question a browser would before PUTting a part. */
  async function corsAllowsBrowserUploads() {
    const url = await getSignedUrl(signer, new UploadPartCommand({ Bucket, Key: key('cors-check'), UploadId: 'check', PartNumber: 1 }), { expiresIn: 60 });
    const res = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT' } });
    const allow = res.headers.get('access-control-allow-origin');
    return allow === '*' || allow === origin;
  }

  return {
    kind: 's3',
    direct: true, // the browser uploads parts to presigned URLs
    async describe() {
      await s3.send(new HeadBucketCommand({ Bucket })); // fail fast on bad credentials / bucket
      const notes = [];
      if (cfg.setupCors && (await setupCors())) notes.push(`added a CORS rule for ${origin || '*'}`);
      if (!origin) {
        notes.push('set PUBLIC_URL to verify the bucket CORS rules for browser uploads');
      } else if (!(await corsAllowsBrowserUploads().catch(() => false))) {
        console.warn(`\n  WARNING: bucket "${Bucket}" does not allow PUT from ${origin} (CORS), so browser uploads will fail.`);
        console.warn('  Add a CORS rule (see README → Object storage) or start once with S3_SETUP_CORS=true.\n');
      }
      return `s3://${Bucket}/${cfg.prefix}${cfg.endpoint ? ` at ${cfg.endpoint}` : ''}${notes.length ? ` (${notes.join('; ')})` : ''}`;
    },
    async initUpload(upload) {
      upload.key = key('uploads', upload.id, `input${upload.ext}`);
      const res = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key: upload.key }));
      upload.s3UploadId = res.UploadId;
    },
    async partUrl(upload, n) {
      return getSignedUrl(signer, new UploadPartCommand({ Bucket, Key: upload.key, UploadId: upload.s3UploadId, PartNumber: n }), {
        expiresIn: cfg.urlExpires,
      });
    },
    async receivedParts(upload) {
      // Only parts of the exact expected size count, so a truncated part is simply re-sent.
      return (await listParts(upload))
        .filter((p) => p.Size === (p.PartNumber < upload.partCount ? upload.partSize : upload.size - (upload.partCount - 1) * upload.partSize))
        .map((p) => p.PartNumber);
    },
    /** Assembles the object. It stays in the bucket; workers fetch it when they process the job. */
    async finishUpload(upload) {
      const parts = (await listParts(upload)).map(({ PartNumber, ETag }) => ({ PartNumber, ETag }));
      await s3.send(new CompleteMultipartUploadCommand({ Bucket, Key: upload.key, UploadId: upload.s3UploadId, MultipartUpload: { Parts: parts } }));
      return { inputPath: null, inputKey: upload.key };
    },
    async abortUpload(upload) {
      await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: upload.key, UploadId: upload.s3UploadId })).catch(() => {});
      await rm(upload.file);
    },
    /** Moves a single-request upload from this server's disk into the bucket, so any worker can read it. */
    async putInput(job) {
      const Key = key('uploads', job.id, `input${path.extname(job.inputPath).toLowerCase()}`);
      await new Upload({ client: s3, params: { Bucket, Key, Body: fs.createReadStream(job.inputPath) } }).done();
      await rm(job.inputPath);
      return { inputPath: null, inputKey: Key };
    },
    /** Copies the input to local disk for ffmpeg/sharp. */
    async fetchInput(job, dest) {
      const obj = await s3.send(new GetObjectCommand({ Bucket, Key: job.inputKey }));
      await pipeline(/** @type {import('node:stream').Readable} */ (obj.Body), fs.createWriteStream(dest));
    },
    async inputUrl(job) {
      if (!job.inputKey) return null;
      return getSignedUrl(signer, new GetObjectCommand({ Bucket, Key: job.inputKey }), { expiresIn: cfg.urlExpires });
    },
    async removeInput(job) {
      if (job.inputKey) await s3.send(new DeleteObjectCommand({ Bucket, Key: job.inputKey })).catch(() => {});
      await rm(job.inputPath);
    },
    /** Uploads a finished result (multipart for big files) and frees the local copy. */
    async saveOutput(job) {
      const Key = key('outputs', job.id, `${job.run}-${job.outputName}`);
      await new Upload({
        client: s3,
        params: {
          Bucket,
          Key,
          Body: fs.createReadStream(job.outputPath),
          ContentType: job.outputMime,
          // Stored on the object too: not every S3-compatible store honours the
          // response-content-disposition override on presigned GETs (e.g. SeaweedFS).
          ContentDisposition: contentDisposition('attachment', job.outputName),
        },
      }).done();
      await rm(job.outputPath);
      return { outputKey: Key, outputPath: null };
    },
    async outputUrl(job, { inline }) {
      if (!job.outputKey) return null;
      return getSignedUrl(signer, new GetObjectCommand({
        Bucket,
        Key: job.outputKey,
        ResponseContentType: job.outputMime,
        ResponseContentDisposition: contentDisposition(inline ? 'inline' : 'attachment', job.outputName),
      }), { expiresIn: cfg.urlExpires });
    },
    async openOutput(job) {
      if (!job.outputKey) return fs.createReadStream(job.outputPath);
      const obj = await s3.send(new GetObjectCommand({ Bucket, Key: job.outputKey }));
      return /** @type {import('node:stream').Readable} */ (obj.Body);
    },
    async removeOutput(job) {
      if (job.outputKey) await s3.send(new DeleteObjectCommand({ Bucket, Key: job.outputKey })).catch(() => {});
      await rm(job.outputPath);
    },
  };
}

module.exports = { fromEnv, contentDisposition };
