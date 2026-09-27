# HTTP API

The web UI uses this API, and you can too, from scripts or other services. All responses are JSON unless noted. Errors are `{ "error": "<message>" }` with a 4xx/5xx status.

There is **no authentication**. Put the server behind a proxy with auth if it's reachable by others (see [deployment.md](deployment.md#reverse-proxy)).

Ready-made clients that handle everything below, including chunking, retries, polling and download:

- [`examples/compress.sh`](../examples/compress.sh), which needs bash, curl and jq;
- [`examples/compress.mjs`](../examples/compress.mjs), for Node.js 20+ with no dependencies.

```bash
examples/compress.sh "Screen Recording.mov" '{"video":{"resolution":1080,"fps":30}}' http://localhost:4747
```

## Endpoints

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Liveness: `{ "ok": true }` |
| `GET /api/config` | Server capabilities and limits |
| `POST /api/uploads` | Start a chunked upload |
| `GET /api/uploads/:id` | Upload state, including which parts are stored (for resuming) |
| `PUT /api/uploads/:id/parts/:n` | Send part `n` to the server (`direct: false`) |
| `POST /api/uploads/:id/parts/:n/url` | Get a presigned URL for part `n` (`direct: true`) |
| `POST /api/uploads/:id/complete` | Finish the upload and create a compression job |
| `DELETE /api/uploads/:id` | Abort an upload |
| `POST /api/jobs` | Single-request upload + job (small files, simple scripts) |
| `GET /api/jobs/:id` | Job status and progress |
| `POST /api/jobs/:id/cancel` | Cancel a queued or running job |
| `POST /api/jobs/:id/retry` | Re-run with new options (no re-upload) |
| `GET /api/jobs/:id/file` | Download the result (`?inline=1` to display instead) |
| `GET /api/jobs/:id/original` | The uploaded original |
| `DELETE /api/jobs/:id` | Cancel if running, delete the job and its files |

## `GET /api/config`

```json
{
  "version": "1.1.0",
  "hardwareEncoder": false,
  "heicDecoder": "heif-dec",
  "maxUploadBytes": 0,
  "uploadPartBytes": 8388608,
  "uploadConcurrency": 4,
  "jobTtlMs": 10800000
}
```

`hardwareEncoder` tells you whether `encoder: "hardware"` has any effect (macOS only). `heicDecoder` is `null` when HEIC files can't be read.

## Chunked uploads

Use this for anything bigger than a few MB. It is modelled on S3 multipart uploads:

1. **Start.** `POST /api/uploads` with `{ "name": "clip.mov", "size": 1288490188, "type": "video/quicktime" }` (`type` is optional). The response is `201`:
   ```json
   { "uploadId": "…", "partSize": 8388608, "partCount": 154, "concurrency": 4, "direct": false, "received": [] }
   ```
   - `415` means the file type is unsupported (checked by extension first, then `type`).
   - `413` means the file is over `MAX_UPLOAD_MB`.
   - `502` means the storage backend failed.
2. **Send the parts.** Part `n` (1-based) is bytes `[(n−1)·partSize, n·partSize)` of the file. Every part is exactly `partSize` except the last. Send up to `concurrency` parts at once, in any order.
   - **`direct: false`** (local storage): `PUT /api/uploads/:id/parts/:n` with the raw bytes and `Content-Type: application/octet-stream`. The server replies `{ "number": n, "etag": "…" }`. It rejects a wrong length with `400`, and an interrupted body is not counted.
   - **`direct: true`** (object storage): `POST /api/uploads/:id/parts/:n/url` returns `{ "url": "…" }`. `PUT` the raw bytes to that URL **with no extra headers**; it goes straight to the bucket. Ask for a fresh URL on each attempt, because they expire after `S3_URL_EXPIRES`.
   - Retry network errors, `408`, `429` and `5xx` with backoff. Other `4xx` errors are final.
3. **Complete.** `POST /api/uploads/:id/complete` with `{ "options": { … } }` (see [Options](#options)). It returns the new **job**.
   - `409 { "missing": [3, 7] }` means some parts haven't arrived yet; send them and complete again.
   - With object storage, the server assembles the object and fetches it for processing, so this call can take a few seconds for big files.

**Resuming** after a crash or reload: `GET /api/uploads/:id` returns the same shape with `received` filled in; only send the other parts. Unfinished uploads are deleted after `JOB_TTL_HOURS`. `DELETE /api/uploads/:id` aborts one immediately.

## Single-request upload

`POST /api/jobs` as `multipart/form-data` with fields `file` and `options` (a JSON string). It returns the job. This is fine for small files and quick scripts, but proxies like Cloudflare reject bodies over 100 MB, and a dropped connection means starting over.

```bash
curl -F file=@photo.heic -F 'options={"image":{"format":"webp","maxDim":1920}}' localhost:4747/api/jobs
```

## Jobs

```json
{
  "id": "…", "kind": "video", "name": "Screen Recording.mov",
  "status": "processing",
  "progress": 0.42, "speed": 1.8, "eta": 37,
  "inputSize": 1288490188, "outputSize": null,
  "outputName": null, "outputMime": null,
  "error": null,
  "info": { "width": 2880, "height": 1800, "fps": 60, "duration": 312.4, … },
  "options": { … },
  "startedAt": 1790000000000, "finishedAt": null
}
```

| Field | Meaning |
|---|---|
| `status` | `queued`, `processing`, `done`, `error` or `cancelled` |
| `progress` | 0–1 |
| `speed` | ffmpeg's speed relative to real time |
| `eta` | Estimated seconds remaining |

Poll `GET /api/jobs/:id` about once a second until the status is `done`, `error` or `cancelled`.

- **Download:** `GET /api/jobs/:id/file`. With object storage this is a **302 redirect** to a presigned bucket URL, so follow redirects (`curl -L`; `fetch` does by default). The file name comes from `Content-Disposition`.
- **Redo:** `POST /api/jobs/:id/retry` with `{ "options": { "<kind>": { … } } }`. It re-queues the same upload with new options, and cancels the job first if it's running.
- **Cancel:** `POST /api/jobs/:id/cancel`. Redo still works afterwards.
- **Clean up:** `DELETE /api/jobs/:id`. Otherwise everything is removed after `JOB_TTL_HOURS`.

## Options

The same objects are used by the web UI and the API. The CLI flags map onto them. In `complete`/`POST /api/jobs` send `{ video?, image?, audio? }`; only the one matching the file's kind is used.

```jsonc
{
  "video": {
    "quality": "balanced",   // high | balanced | small | tiny | target
    "targetMB": 25,          // when quality = "target"
    "codec": "h264",         // h264 | h265
    "encoder": "cpu",        // cpu | hardware (macOS VideoToolbox; ignored elsewhere and in target mode)
    "speed": "medium",       // veryfast | medium | slow
    "resolution": 1080,      // cap the short side; 0 = keep
    "fps": 30,               // cap; 0 = keep
    "audio": "keep"          // keep | low (64 kbps mono) | remove
  },
  "image": {
    "format": "auto",        // auto | jpeg | webp | avif | png
    "quality": 78,           // 1–100
    "maxDim": 1920,          // cap the long edge; 0 = keep
    "keepMetadata": false    // true keeps EXIF incl. GPS
  },
  "audio": {
    "format": "mp3",         // mp3 | m4a | opus (.ogg)
    "bitrate": 128,          // 32 48 64 96 128 160 192 256
    "mono": false
  }
}
```

Omitted fields take the defaults shown.

## Status codes

| Code | When |
|---|---|
| `400` | Bad input: missing name/size, part number out of range, wrong part length |
| `404` | Unknown upload or job (or already deleted/expired); result not ready yet |
| `409` | Missing parts on complete; part sent to the wrong place for this storage mode |
| `413` | Over `MAX_UPLOAD_MB` |
| `415` | Unsupported file type |
| `502` | The storage backend (S3) failed |
