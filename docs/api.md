# HTTP API

The web UI uses this API, and you can too, from scripts or other services. All responses are JSON unless noted. Errors are `{ "error": "<message>" }` with a 4xx/5xx status.

## Authentication

Login is **on by default** (`AUTH_ENABLED`). Every endpoint except `/api/health` and `/api/auth/*` needs one of:

| Method | How |
|---|---|
| HTTP Basic | `curl -u "$AUTH_USERNAME:$AUTH_PASSWORD" …` |
| API token | `Authorization: Bearer $AUTH_TOKEN` (only if the server sets `AUTH_TOKEN`) |
| Session cookie | `POST /api/auth/login` with JSON `{ "username", "password" }`. The response sets an HttpOnly `cm_session` cookie; the web UI uses this. |

- Without credentials you get `401 { "error": "Authentication required" }`. No `WWW-Authenticate` header is sent, so browsers don't pop up a login box.
- `429` means too many wrong passwords from your address; wait 15 minutes.
- `GET /api/auth/session` returns `{ enabled, authenticated, username }`, and `POST /api/auth/logout` clears the cookie.

The example clients read `COMPRESS_MEDIA_USER` + `COMPRESS_MEDIA_PASSWORD`, or `COMPRESS_MEDIA_TOKEN`.

Ready-made clients that handle everything below, including chunking, retries, polling and download:

- [`examples/compress.sh`](../examples/compress.sh), which needs bash, curl and jq;
- [`examples/compress.mjs`](../examples/compress.mjs), for Node.js 20+ with no dependencies.

```bash
export COMPRESS_MEDIA_USER=admin COMPRESS_MEDIA_PASSWORD=…     # or COMPRESS_MEDIA_TOKEN=…
examples/compress.sh "Screen Recording.mov" '{"video":{"resolution":1080,"fps":30}}' http://localhost:4747
```

## Endpoints

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Liveness: `{ "ok": true }` (public) |
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/session` | Browser sessions (public) |
| `GET /api/config` | Server capabilities and limits |
| `POST /api/uploads` | Start a chunked upload |
| `GET /api/uploads/:id` | Upload state, including which parts are stored (for resuming) |
| `PUT /api/uploads/:id/parts/:n` | Send part `n` to the server (`direct: false`) |
| `POST /api/uploads/:id/parts/:n/url` | Get a presigned URL for part `n` (`direct: true`) |
| `POST /api/uploads/:id/complete` | Finish the upload and create a compression job |
| `DELETE /api/uploads/:id` | Abort an upload |
| `POST /api/jobs` | Single-request upload + job (small files, simple scripts) |
| `POST /api/animations` | Make one animated GIF/WebP/MP4 from several images |
| `POST /api/subtitles` | Subtitles for a video or audio file (speech recognition), or add subtitles to a video |
| `GET /api/jobs/:id/subtitles` | The subtitles of a subtitles job, as SRT or WebVTT |
| `GET /api/jobs?ids=a,b,c` | Status of several jobs in one call (unknown ids are left out) |
| `GET /api/jobs/zip?ids=a,b,c` | Every finished result among these jobs, as one ZIP (streamed) |
| `GET /api/jobs/:id` | Job status and progress |
| `GET /api/jobs/:id/events` | Live updates as Server-Sent Events until the job finishes |
| `POST /api/jobs/:id/cancel` | Cancel a queued or running job |
| `POST /api/jobs/:id/retry` | Re-run with new options (no re-upload) |
| `GET /api/jobs/:id/file` | Download the result (`?inline=1` to display instead) |
| `GET /api/jobs/:id/original` | The uploaded original (for an animation, its first frame) |
| `DELETE /api/jobs/:id` | Cancel if running, delete the job and its files |

## `GET /api/config`

```json
{
  "version": "2.1.0",
  "hardwareEncoder": true, "hardwareName": "nvenc", "hardwareCodecs": ["h264", "h265", "av1"],
  "av1": true, "webm": true, "pdf": true, "heicDecoder": "heif-dec",
  "maxUploadBytes": 0, "uploadPartBytes": 8388608, "uploadConcurrency": 4, "jobTtlMs": 10800000,
  "storage": "local", "queue": "memory", "animationMaxFrames": 1000
}
```

| Field | Meaning |
|---|---|
| `hardwareEncoder`, `hardwareName`, `hardwareCodecs` | Whether `encoder: "hardware"` has any effect, with which encoder, and for which codecs |
| `av1`, `webm` | Whether the AV1 codec and the WebM format are available |
| `pdf` | Whether PDF files are accepted (Ghostscript present) |
| `heicDecoder` | `null` when HEIC files can't be read |
| `animationMaxFrames` | Most frames `POST /api/animations` accepts |
| `whisper`, `burnSubtitles` | Speech recognition available (the whisper.cpp command, or `null`); subtitles can be burned in |
| `subtitleModels`, `subtitleModel` | `[{ "name", "mb", "installed" }]` for each speech model, and the default one |

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
3. **Complete.** `POST /api/uploads/:id/complete` with `{ "options": { … }, "webhook": "https://…" }` (`webhook` is optional; see [Options](#options) and [Webhooks](#webhooks)). It returns the new **job**.
   - `409 { "missing": [3, 7] }` means some parts haven't arrived yet; send them and complete again.
   - With object storage, the server assembles the object and fetches it for processing, so this call can take a few seconds for big files.

**Resuming** after a crash or reload: `GET /api/uploads/:id` returns the same shape with `received` filled in; only send the other parts. Unfinished uploads are deleted after `JOB_TTL_HOURS`. `DELETE /api/uploads/:id` aborts one immediately.

## Single-request upload

`POST /api/jobs` as `multipart/form-data` with fields `file`, `options` (a JSON string) and optionally `webhook`. It returns the job. This is fine for small files and quick scripts, but proxies like Cloudflare reject bodies over 100 MB, and a dropped connection means starting over.

```bash
curl -u "$AUTH_USERNAME:$AUTH_PASSWORD" -F file=@photo.heic -F 'options={"image":{"format":"webp","maxDim":1920}}' localhost:4747/api/jobs
```

## Animations

`POST /api/animations` makes **one** job from 2 or more still images, in order. Send the frames either way:

- **Multipart** (small images, scripts): `multipart/form-data` with one `frames` file field per image, in order, plus `options` (a JSON string) and optionally `webhook`.
  ```bash
  curl -u "$AUTH_USERNAME:$AUTH_PASSWORD" -F frames=@1.png -F frames=@2.png -F frames=@3.png \
    -F 'options={"animation":{"format":"gif","delay":700}}' localhost:4747/api/animations
  ```
- **Chunked** (big photos, object storage): upload each image with [chunked uploads](#chunked-uploads) but **don't complete them**. Then send JSON `{ "frames": ["<uploadId>", …], "options": { "animation": { … } }, "webhook": "https://…" }`. The uploads are used up by the job.

It returns the job, with `kind: "animation"` and `frames: [{ "name", "size" }, …]`. Track, download, redo and delete it like any other job. The result is named `<first frame>-animated.<ext>`, and `info` has `{ frames, width, height, durationMs, loop }`.

- `400`: fewer than 2 frames, or more than `animationMaxFrames`.
- `415`: a frame isn't an image.
- `404`: an unknown or already used upload id.
- `409`: an upload still has parts to send. Nothing is used up; send them and try again.

A refused request stores nothing, and chunked uploads stay available for another try.

## Subtitles

`POST /api/subtitles` makes one job for a video or audio file. By default it **listens to the speech** (whisper.cpp) and returns a subtitle file with times and text: `talk.vi.srt`, ready for YouTube Studio (Subtitles → Upload file → With timing). It can also put the subtitles into the video instead.

Send the file either way:

- **Multipart:** `multipart/form-data` with `file` (the video or audio), `options` (a JSON string), optionally `webhook`, and optionally `subtitles`: an `.srt` or `.vtt` file (up to 4 MB) to use **instead of speech recognition**.
  ```bash
  # Speech → Vietnamese subtitles
  curl -u "$AUTH_USERNAME:$AUTH_PASSWORD" -F file=@talk.mov -F 'options={"subtitles":{"language":"vi"}}' localhost:4747/api/subtitles
  # Your own subtitles, drawn into the picture
  curl -u "$AUTH_USERNAME:$AUTH_PASSWORD" -F file=@talk.mov -F subtitles=@talk.srt -F 'options={"subtitles":{"embed":"burn"}}' localhost:4747/api/subtitles
  ```
- **Chunked** (big videos, object storage): upload the file with [chunked uploads](#chunked-uploads) but **don't complete it**. Then send JSON `{ "upload": "<uploadId>", "options": { "subtitles": { … } }, "webhook": "https://…" }`. Put your own subtitles in `options.subtitles.text` as SRT or WebVTT text.

It returns the job with `kind: "subtitles"`. Track, download, redo and delete it like any other job.

- **Result:** with `embed: "none"` a subtitle file named `<name>.<language>.srt` (or `.vtt`). With `track` or `burn`, the video named `<name>-subtitled.<ext>`: `track` keeps MP4/MOV/WebM/MKV (other containers become MKV); `burn` makes an MP4.
- **Progress** comes in stages: `stage` is `model` (downloading the speech model, the first time only), `transcribe`, then `embed`. `progress` is 0–1 **within** the stage.
- **`info`** has `{ cues, language, spokenLanguage, model, duration, embed, words }`. `language` is the language of the subtitles (`en` when translated); `model` is `null` when no speech recognition ran.
- **`GET /api/jobs/:id/subtitles?format=srt|vtt`** returns the subtitles whatever the output (also for `track` and `burn`). Add `&download=1` for an attachment.
- **Redo** (`POST /api/jobs/:id/retry` with `{ "options": { "subtitles": { … } } }`) reuses the subtitles already made, so switching between SRT, VTT, track and burn-in is quick. Speech recognition runs again only when `language`, `translate` or `model` changes. To **edit**, send the corrected text as `options.subtitles.text`; later redos keep your version.
- `options.subtitles.text` is not echoed back in job responses.

Errors, before anything is stored:

- `415`: the file isn't video or audio, or `subtitles` isn't an `.srt`/`.vtt` under 4 MB.
- `400`: the subtitle text has no cues; `track`/`burn` for an audio file; no speech recognition on this server and no subtitles given; `burn` without libass.
- `404`: unknown upload id. `409`: the upload still has parts to send.

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
- **Many jobs:** `GET /api/jobs?ids=a,b,c` returns their statuses in one call (up to 500 ids). `GET /api/jobs/zip?ids=a,b,c` downloads every finished result as a ZIP. Entries are stored without re-compression, and duplicate names become `name (2).ext`.

### Live progress (Server-Sent Events)

`GET /api/jobs/:id/events` streams `event: job` messages with the job JSON whenever it changes, sends a keep-alive comment every 15 s, and closes once the job is `done`, `error` or `cancelled`. If the job is deleted meanwhile, it sends `event: gone`.

```js
const source = new EventSource(`/api/jobs/${id}/events`);          // same-origin, uses the session cookie
source.addEventListener('job', (e) => console.log(JSON.parse(e.data).progress));
```

From scripts: `curl -N -u user:pass http://localhost:4747/api/jobs/$ID/events`.

## Webhooks

Pass a `webhook` URL when you create a job. When the job finishes, fails or is cancelled, the server POSTs:

```json
{ "event": "job.done", "job": { "id": "…", "status": "done", "outputName": "…", "outputSize": 1234, … }, "sentAt": "2026-09-27T10:00:00.000Z" }
```

- `event` is `job.done`, `job.error` or `job.cancelled`. A redo sends another event when it finishes.
- **Signature:** with `WEBHOOK_SECRET` set, the header `X-Compress-Media-Signature: sha256=<hex>` is the HMAC-SHA256 of the raw body. Verify it before trusting the payload.
- **Delivery:** any 2xx counts as delivered. Otherwise the server retries after 1 s, 5 s and 25 s, with a 10 s timeout per attempt. Redirects are not followed.
- **Allowed URLs:** only `http`/`https`. URLs that resolve to private, loopback or link-local addresses are refused with `400` unless `WEBHOOK_ALLOW_PRIVATE=true`.

```js
// Verifying the signature (Node.js)
const expected = 'sha256=' + crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-compress-media-signature'] || ''));
```

## Options

The same objects are used by the web UI and the API. The CLI flags map onto them. In `complete`/`POST /api/jobs` send `{ video?, image?, audio?, pdf? }`; only the one matching the file's kind is used. `POST /api/animations` uses `animation`, `POST /api/subtitles` uses `subtitles`.

```jsonc
{
  "video": {
    "format": "mp4",         // mp4 | webm | gif
    "quality": "balanced",   // high | balanced | small | tiny | target (not for gif)
    "targetMB": 25,          // when quality = "target" (two-pass encode)
    "codec": "h264",         // mp4: h264 | h265 | av1 · webm: vp9 | av1
    "encoder": "cpu",        // cpu | hardware (GPU/VideoToolbox if detected; mp4 only, not in target mode)
    "speed": "medium",       // veryfast | medium | slow
    "resolution": 1080,      // cap the short side; 0 = keep (gif defaults to 480)
    "fps": 30,               // cap; 0 = keep (gif defaults to 12)
    "audio": "keep",         // keep | low (64 kbps mono) | remove
    "trimStart": "0:05",     // optional: seconds or [hh:]mm:ss
    "trimEnd": "1:30"        // optional
  },
  "image": {
    "format": "auto",        // auto | jpeg | webp | avif | png — animated input stays animated (avif → webp, jpeg/png → gif; info.note)
    "quality": 78,           // 1–100
    "maxDim": 1920,          // cap the long edge; 0 = keep
    "keepMetadata": false    // true keeps EXIF incl. GPS
  },
  "audio": {
    "format": "mp3",         // mp3 | m4a | opus (.ogg)
    "bitrate": 128,          // 32 48 64 96 128 160 192 256
    "mono": false
  },
  "pdf": {
    "quality": "ebook",      // screen (72 dpi) | ebook (150) | printer (300) | prepress
    "grayscale": false
  },
  "subtitles": {
    "language": "auto",      // spoken language: auto | vi | en | ja … (ISO 639-1)
    "translate": false,      // English subtitles whatever the spoken language (not with large-v3-turbo)
    "model": "small",        // tiny | base | small | medium | large-v3-turbo (default: WHISPER_MODEL)
    "format": "srt",         // srt | vtt, when embed = none
    "embed": "none",         // none (a subtitle file) | track (selectable, no re-encode) | burn (drawn into the picture)
    "fontSize": "medium",    // small | medium | large, for burn
    "text": "1\n00:00:01,000 --> …"  // optional: SRT/WebVTT to use instead of speech recognition
  },
  "animation": {
    "format": "gif",         // gif | webp | mp4
    "delay": 500,            // ms per frame (20–60000), or an array with one value per frame
    "loop": 0,               // times to play; 0 = forever (not for mp4)
    "maxDim": 800,           // long edge of the canvas (the first frame's shape); 0 = up to 4096
    "fit": "contain",        // contain (add borders) | cover (crop) for frames of another shape
    "background": "#ffffff", // border colour, and what shows through transparency
    "quality": 80            // 1–100: GIF colours, WebP quality, MP4 CRF
  }
}
```

Omitted fields take the defaults shown.

## Status codes

| Code | When |
|---|---|
| `400` | Bad input: missing name/size, part number out of range, wrong part length, invalid webhook URL, too few or too many animation frames |
| `401` | Login required (see [Authentication](#authentication)) |
| `404` | Unknown upload or job (or already deleted/expired); result not ready yet |
| `409` | Missing parts on complete; part sent to the wrong place for this storage mode |
| `413` | Over `MAX_UPLOAD_MB` |
| `415` | Unsupported file type, or PDF on a server without Ghostscript |
| `429` | Too many failed logins from this address |
| `502` | The storage backend (S3) failed |
