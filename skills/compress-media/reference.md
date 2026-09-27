# compress-media reference

## CLI

```
compress-media [options] <file|dir>...
compress-media probe <file>... [--json]
compress-media info [--json]
compress-media serve [--port N] [--host H]
```

### Output options

| Flag | Default | Meaning |
|---|---|---|
| `-o, --out-dir <dir>` | next to each input | Write results here. With `-r`, sub-folders are mirrored. |
| `--suffix=<text>` | `-compressed` | Appended to the file stem. Needs `=` when the value starts with `-`. |
| `--overwrite` | off | Replace existing outputs. Without it, that file fails. |
| `-r, --recursive` | off | Walk sub-folders. Hidden files, unsupported types and `*<suffix>.*` are skipped. |
| `--skip-larger` | off | Delete results that are not smaller than the input (status `skipped`). |
| `--json` | off | JSON report on stdout. |
| `-q, --quiet` | off | No progress or summary on stderr. |

### Video → always MP4

| Flag | Values | Default | Notes |
|---|---|---|---|
| `--quality` | `high` `balanced` `small` `tiny` | `balanced` | CRF 21/24/28/32 (x264) or 24/27/30/34 (x265) |
| `--target-mb` | number | — | Overrides `--quality`. Bitrate = size / duration − audio. Always uses the CPU. |
| `--codec` | `h264` `h265` | `h264` | H.265 is tagged `hvc1` so it plays in QuickTime and Safari. |
| `--hw` | flag | off | VideoToolbox (macOS). Ignored elsewhere and in target mode. |
| `--speed` | `fast` `medium` `slow` | `medium` | x264/x265 preset (`fast` = veryfast) |
| `--max-res` | number | keep | Caps the **short** side (works for portrait video too). Never upscales. |
| `--fps` | number | keep | Only applied when the source is faster |
| `--audio` | `keep` `low` `remove` | `keep` | AAC 128 kbps / AAC 64 kbps mono / no audio track |

Metadata is copied and `+faststart` is set, so the video can play before it has fully downloaded.

### Images

| Flag | Values | Default | Notes |
|---|---|---|---|
| `--image-format` | `auto` `jpeg` `webp` `avif` `png` | `auto` | `auto` keeps the format. HEIC→JPEG, still GIF→PNG, animated GIF stays GIF. |
| `--image-quality` | 1–100 | 78 | For PNG: palette quantisation below 100. For GIF: fewer colours. |
| `--max-dim` | px | keep | Caps the long edge. Never upscales. |
| `--keep-metadata` | flag | off | Keeps EXIF, including GPS. Orientation is always applied to the pixels. |

Animated GIF and WebP stay animated when the output is `gif` or `webp`. JPEG output flattens transparency onto white.

### Audio

| Flag | Values | Default |
|---|---|---|
| `--audio-format` | `mp3` `m4a` `opus` (.ogg) | `mp3` |
| `--bitrate` | 32 48 64 96 128 160 192 256 | 128 |
| `--mono` | flag | off |

### Supported inputs

- **video:** mov mp4 m4v mkv avi webm wmv flv 3gp mts m2ts ts mpg mpeg ogv
- **image:** jpg jpeg png webp avif tif tiff heic heif gif bmp
- **audio:** mp3 wav m4a aac flac ogg oga opus aif aiff caf wma amr

### JSON report fields

| Field | Type | Notes |
|---|---|---|
| `ok` | bool | `false` if any result has `status: "error"` |
| `totals` | object | `files`, `done`, `skipped`, `failed`, plus `inputSize`, `outputSize`, `saved` in bytes, counting done files only |
| `results[].status` | `done` \| `skipped` \| `error` | |
| `results[].input` / `output` | absolute paths | `output` is only present when `done` |
| `results[].inputSize` / `outputSize` / `saved` | bytes | |
| `results[].ratio` | number | output / input |
| `results[].larger` | bool | `true` when the output is not smaller (it is kept unless `--skip-larger`) |
| `results[].options` | object | The effective options for that kind |
| `results[].info` | object | Source media info: width, height, fps, duration… |
| `results[].error` / `reason` | string | Why it failed or was skipped |

### `probe --json`

An array with one object per file:

- **Every file:** `{ file, kind, size }`.
- **Video:** `duration` (s), `width`, `height`, `fps`, `videoCodec`, `bitrateKbps`, `audioCodec`, `audioChannels`.
- **Audio:** `duration`, `bitrateKbps`, `audioCodec`, `audioChannels`.
- **Images:** `format`, `width`, `height`, `animated`, `hasMetadata`.

Width and height already account for rotation.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `FFMPEG_PATH`, `FFPROBE_PATH` | CLI and server | Use these binaries instead of the bundled ones |
| `PORT`, `HOST` | server | Default `4747`, `127.0.0.1` |
| `WORK_DIR` | server | Scratch space for uploads and results |
| `JOB_TTL_HOURS` | server | Results are deleted after this many hours (default 3) |
| `MAX_UPLOAD_MB` | server | Per-file upload cap (0 = unlimited) |
| `MEDIA_CONCURRENCY`, `IMAGE_CONCURRENCY` | server | Parallel jobs (default 1 / 3) |
| `UPLOAD_PART_MB`, `UPLOAD_CONCURRENCY`, `UPLOAD_MAX_PARTS` | server | Chunked upload part size (8), parallel parts (4), part cap (10000) |
| `STORAGE`, `S3_*`, `PUBLIC_URL` | server | `local` or `s3` object storage (browsers upload straight to the bucket) |

## HTTP API (web UI server)

Use this only when a server is already running, for example on a remote machine or in Docker. For local files, the CLI is simpler.

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /api/health` | | `{ ok: true }` |
| `GET /api/config` | | `{ version, hardwareEncoder, heicDecoder, maxUploadBytes, uploadPartBytes, uploadConcurrency, jobTtlMs }` |
| `POST /api/jobs` | multipart: `file`, `options` = JSON `{ video?:{…}, image?:{…}, audio?:{…} }` | job. Single request, simplest for small files and scripts. |
| `POST /api/uploads` | JSON `{ name, size, type? }` | `{ uploadId, partSize, partCount, concurrency, direct, received }`. Starts a chunked, resumable upload. |
| `PUT /api/uploads/:id/parts/:n` | raw bytes of part `n` (1-based, exactly `partSize` except the last) | `{ number, etag }`. Only when `direct: false`. |
| `POST /api/uploads/:id/parts/:n/url` | | `{ url }`. When `direct: true`: PUT the part's bytes to this presigned object-storage URL, with no extra headers. |
| `GET /api/uploads/:id` | | Same as start, with `received` = part numbers already stored (for resuming) |
| `POST /api/uploads/:id/complete` | JSON `{ options }` | job |
| `DELETE /api/uploads/:id` | | `{ ok: true }`. Aborts the upload. |
| `GET /api/jobs/:id` | | job |
| `POST /api/jobs/:id/cancel` | | job |
| `POST /api/jobs/:id/retry` | JSON `{ options: { <kind>: {…} } }` | job (re-queued, no re-upload) |
| `GET /api/jobs/:id/file` | `?inline=1` to view in the browser | the compressed file |
| `GET /api/jobs/:id/original` | | the uploaded original |
| `DELETE /api/jobs/:id` | | `{ ok: true }`. Cancels the job and deletes its files. |

A job looks like `{ id, kind, name, status: queued|processing|done|error|cancelled, progress 0–1, speed, eta (s), inputSize, outputSize, outputName, outputMime, error, info, options }`. Poll `GET /api/jobs/:id` about once a second until `status` is `done`, `error` or `cancelled`. `GET /api/jobs/:id/file` may answer with a **302 redirect** to object storage, so follow redirects (`curl -L`).

### Options: CLI flag → API field

| CLI flag | API field (inside `video`, `image` or `audio`) |
|---|---|
| `--quality high\|balanced\|small\|tiny` | `video.quality` |
| `--target-mb N` | `video.quality: "target"`, `video.targetMB: N` |
| `--codec h264\|h265` | `video.codec` |
| `--hw` | `video.encoder: "hardware"` (default `"cpu"`) |
| `--speed fast\|medium\|slow` | `video.speed: "veryfast"\|"medium"\|"slow"` |
| `--max-res N` | `video.resolution: N` |
| `--fps N` | `video.fps: N` |
| `--audio keep\|low\|remove` | `video.audio` |
| `--image-format F` | `image.format` |
| `--image-quality N` | `image.quality` |
| `--max-dim N` | `image.maxDim` |
| `--keep-metadata` | `image.keepMetadata: true` |
| `--audio-format F` | `audio.format` |
| `--bitrate N` | `audio.bitrate` |
| `--mono` | `audio.mono: true` |

Both snippets below use `S` for the server URL. Set it to the user's server, not the default port.

### Small files: one request

```bash
S=${COMPRESS_MEDIA_URL:-http://localhost:4747}
id=$(curl -sf -F file=@photo.heic -F 'options={"image":{"format":"webp","maxDim":1920}}' $S/api/jobs | jq -r .id)
while :; do st=$(curl -sf $S/api/jobs/$id | jq -r .status); [ "$st" = queued ] || [ "$st" = processing ] || break; sleep 1; done
[ "$st" = done ] && curl -sfL -o photo-compressed.webp $S/api/jobs/$id/file || curl -s $S/api/jobs/$id | jq -r .error
```

### Large files: chunked upload (use this above ~100 MB, or behind Cloudflare)

1. `POST /api/uploads` with `{"name":"clip.mov","size":<bytes>}` returns `uploadId`, `partSize`, `partCount`, `direct` and `concurrency`.
2. For each part `n` from 1 to `partCount`, take bytes `[(n-1)*partSize, n*partSize)`:
   - if `direct` is **false**: `PUT /api/uploads/<id>/parts/<n>` with `Content-Type: application/octet-stream`;
   - if `direct` is **true**: `POST /api/uploads/<id>/parts/<n>/url` → `{url}`, then `PUT` the bytes to that URL with **no extra headers** (`curl -H 'Content-Type:'`).
   - Retry a part on network errors or `5xx`.
3. `POST /api/uploads/<id>/complete` with `{"options":{…}}` returns the job. If it answers `409 {"missing":[…]}`, send those parts and complete again.
4. Poll and download as above.

In bash:

```bash
S=${COMPRESS_MEDIA_URL:-http://localhost:4747}; F="Screen Recording.mov"; SIZE=$(wc -c < "$F" | tr -d ' ')
U=$(curl -sf -X POST $S/api/uploads -H 'Content-Type: application/json' -d "{\"name\":\"clip.mov\",\"size\":$SIZE}")
ID=$(jq -r .uploadId <<<"$U"); P=$(jq -r .partSize <<<"$U"); N=$(jq -r .partCount <<<"$U"); D=$(jq -r .direct <<<"$U")
for n in $(seq 1 $N); do
  dd if="$F" of=/tmp/part bs=$P skip=$((n-1)) count=1 2>/dev/null
  if [ "$D" = true ]; then curl -sf -X PUT -H 'Content-Type:' --data-binary @/tmp/part "$(curl -sf -X POST $S/api/uploads/$ID/parts/$n/url | jq -r .url)"
  else curl -sf -X PUT -H 'Content-Type: application/octet-stream' --data-binary @/tmp/part $S/api/uploads/$ID/parts/$n; fi >/dev/null
done
JOB=$(curl -sf -X POST $S/api/uploads/$ID/complete -H 'Content-Type: application/json' -d '{"options":{"video":{"resolution":1080,"fps":30}}}' | jq -r .id)
```

The repo has a complete client that works for **any** file size (it always uses the chunked upload) and adds retries, polling and download: `examples/compress.sh <file> '<options-json>' <url>`. Prefer it over these snippets when it's available.
