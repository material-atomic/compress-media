# compress-media reference

## CLI

```
compress-media [options] <file|dir>...
compress-media probe <file>... [--json]
compress-media animate <image|dir>... [options]   # still images → one animated GIF / WebP / MP4
compress-media subtitles <video|audio|dir>... [options]   # speech → SRT/VTT, or subtitles → a video
compress-media info [--json]
compress-media serve [--port N] [--host H]
compress-media worker          # queue worker only (QUEUE=redis)
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

### Video → MP4, WebM or GIF

| Flag | Values | Default | Notes |
|---|---|---|---|
| `--video-format` | `mp4` `webm` `gif` | `mp4` | GIF: animated, no sound, defaults to 480p / 12 fps |
| `--quality` | `high` `balanced` `small` `tiny` | `balanced` | CRF per codec. For GIF: number of colours. |
| `--target-mb` | number | — | Overrides `--quality`. Two-pass: bitrate = size / (trimmed) duration − audio. Always uses the CPU. Not for GIF. |
| `--codec` | mp4: `h264` `h265` `av1` · webm: `vp9` `av1` | `h264` / `vp9` | H.265 is tagged `hvc1` so it plays in QuickTime and Safari. AV1 needs `info` → `av1: true`. |
| `--hw` | flag | off | Detected hardware encoder (VideoToolbox, NVENC, Quick Sync, VA-API, AMF); MP4 only. Ignored with a note when there's none, and in target mode. |
| `--start`, `--end` | seconds or `[hh:]mm:ss` | whole video | Trim |
| `--speed` | `fast` `medium` `slow` | `medium` | x264/x265 preset (`fast` = veryfast) |
| `--max-res` | number | keep | Caps the **short** side (works for portrait video too). Never upscales. |
| `--fps` | number | keep | Only applied when the source is faster |
| `--audio` | `keep` `low` `remove` | `keep` | AAC 128 kbps / AAC 64 kbps mono / no audio track |

Metadata is copied and `+faststart` is set, so the video can play before it has fully downloaded.

### Images

| Flag | Values | Default | Notes |
|---|---|---|---|
| `--image-format` | `auto` `jpeg` `webp` `avif` `png` | `auto` | `auto` keeps the format. HEIC→JPEG, still GIF→PNG, animated GIF stays GIF. Animated input is never flattened: `avif` → animated WebP, `jpeg`/`png` → GIF, noted in `info.note`. |
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

### PDF (needs Ghostscript)

| Flag | Values | Default |
|---|---|---|
| `--pdf-quality` | `screen` (72 dpi) `ebook` (150) `printer` (300) `prepress` | `ebook` |
| `--grayscale` | flag | off |

### Animate: still images → GIF, WebP or MP4

`compress-media animate <image|dir>... [options]` makes **one** animation from 2–1000 images. The compress flags don't apply.

| Flag | Values | Default | Notes |
|---|---|---|---|
| `-o, --out-dir` | file or folder | next to the first image | A path with an extension (`demo.gif`) is the output file; otherwise it's a folder. The name is `<first-image-name>-animated.<ext>`. |
| `--format` | `gif` `webp` `mp4` | `gif` | MP4 is H.264 with even dimensions and no sound. |
| `--delay` | ms | 500 | How long each frame shows (clamped to 20–60000). |
| `--fps` | number | — | Instead of `--delay` (not both). |
| `--loop` | whole number | 0 | 0 = forever. Ignored for MP4. |
| `--max-dim` | px | 800 | Long edge of the output. The canvas has the first image's shape (after EXIF rotation). |
| `--fit` | `contain` `cover` | `contain` | Images of another shape: letterbox, or crop. |
| `--background` | hex colour | `#ffffff` | Border colour for `contain`. |
| `--quality` | 1–100 | 80 | GIF colours, WebP quality, MP4 CRF. |
| `-r`, `--overwrite`, `--json`, `-q` | | | As for compress. |

- Frames are used in the order given. Folders contribute their images sorted by name, numbers compared numerically (`shot-2` before `shot-10`). `-r` includes sub-folders. Earlier `*-animated.gif` / `*-animated.webp` files inside a folder are skipped.
- HEIC frames work wherever HEIC compression does.
- The JSON report has one result with `kind: "animation"`, `input` (the first frame), `inputs` (every frame) and `info: { frames, width, height, durationMs, loop }`.

### Subtitles: speech → SRT/VTT, or subtitles → video

`compress-media subtitles <video|audio|dir>... [options]` needs whisper.cpp (`whisper-cli`) for speech recognition; `info` shows `Subtitles:` and `Speech models:`. Without it only `--srt` works. The compress flags don't apply.

| Flag | Values | Default | Notes |
|---|---|---|---|
| `-o, --out-dir` | folder | next to each input | |
| `--lang` | `auto`, `vi`, `en`, `ja`… (ISO 639-1) | `auto` | The spoken language. Give it when known; detection can be wrong on short clips. |
| `--translate` | flag | off | English subtitles from any language. Not with `large-v3-turbo`. |
| `--model` | `tiny` `base` `small` `medium` `large-v3-turbo` | `small` (`WHISPER_MODEL`) | 75 MB / 142 MB / 466 MB / 1.5 GB / 547 MB, downloaded once on first use into `~/.cache/compress-media/models` (`WHISPER_MODELS_DIR`). Non-English speech: `small` or better. |
| `--format` | `srt` `vtt` | `srt` | For `--embed none`. |
| `--embed` | `none` `track` `burn` | `none` | `none`: a subtitle file. `track`: selectable track, no re-encode (MP4/MOV/WebM/MKV kept, others → MKV). `burn`: drawn into the picture, re-encoded MP4. Video inputs only. |
| `--font-size` | `small` `medium` `large` | `medium` | For `--embed burn`. |
| `--srt` | `.srt` or `.vtt` file | — | Use these subtitles instead of speech recognition. One input only. |
| `-r`, `--overwrite`, `--json`, `-q` | | | As for compress. Folders skip earlier `*-subtitled.*` results. |

- **Outputs:** `<name>.<lang>.srt` / `.vtt` (`<name>.srt` when the language is unknown, e.g. `--srt` without `--lang`), or `<name>-subtitled.<ext>` with `track`/`burn`. While running: `<name>.partial.<ext>`.
- Cues are split for reading: at most two lines of about 42 characters.
- The JSON report has one result per input with `kind: "subtitles"` and `info: { cues, language, spokenLanguage, model, duration, embed, words }`. `language` is the subtitles' language (`en` when translated); `model` is `null` with `--srt`.

### Supported inputs

- **video:** mov mp4 m4v mkv avi webm wmv flv 3gp mts m2ts ts mpg mpeg ogv
- **image:** jpg jpeg png webp avif tif tiff heic heif gif bmp
- **audio:** mp3 wav m4a aac flac ogg oga opus aif aiff caf wma amr
- **pdf:** pdf

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
- **PDF:** `pages`.

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
| `AUTH_ENABLED`, `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_TOKEN` | server | Login, on by default |
| `QUEUE`, `REDIS_URL`, `ROLE` | server | Shared Redis queue; `web`/`worker` processes |
| `GS_PATH`, `HW_ENCODER` | CLI and server | Ghostscript path; hardware encoder (`auto`/`off`/family) |
| `WHISPER_PATH`, `WHISPER_MODEL`, `WHISPER_THREADS` | CLI and server | whisper.cpp command; default speech model (`small`); threads (CPU cores, up to 8) |
| `WHISPER_MODELS_DIR`, `WHISPER_DOWNLOAD`, `WHISPER_MODEL_URL` | CLI and server | Model folder (server: `WORK_DIR/models`, CLI: `~/.cache/compress-media/models`, Docker: `/data/models`); `false` = never download; download mirror |

## HTTP API (web UI server)

Use this only when a server is already running, for example on a remote machine or in Docker. For local files, the CLI is simpler.

**Authentication** (on by default): `curl -u "$USER:$PASSWORD"` (HTTP Basic), or `-H "Authorization: Bearer $TOKEN"`. Without it you get `401`. `/api/health` is public.

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /api/health` | | `{ ok: true }` |
| `GET /api/config` | | `{ version, hardwareEncoder, heicDecoder, maxUploadBytes, uploadPartBytes, uploadConcurrency, jobTtlMs, animationMaxFrames, whisper, burnSubtitles, subtitleModels, subtitleModel, … }` |
| `POST /api/jobs` | multipart: `file`, `options` = JSON `{ video?:{…}, image?:{…}, audio?:{…} }` | job. Single request, simplest for small files and scripts. |
| `POST /api/uploads` | JSON `{ name, size, type? }` | `{ uploadId, partSize, partCount, concurrency, direct, received }`. Starts a chunked, resumable upload. |
| `PUT /api/uploads/:id/parts/:n` | raw bytes of part `n` (1-based, exactly `partSize` except the last) | `{ number, etag }`. Only when `direct: false`. |
| `POST /api/uploads/:id/parts/:n/url` | | `{ url }`. When `direct: true`: PUT the part's bytes to this presigned object-storage URL, with no extra headers. |
| `GET /api/uploads/:id` | | Same as start, with `received` = part numbers already stored (for resuming) |
| `POST /api/uploads/:id/complete` | JSON `{ options, webhook? }` | job. `webhook` is POSTed `{ event, job }` when the job finishes. |
| `DELETE /api/uploads/:id` | | `{ ok: true }`. Aborts the upload. |
| `POST /api/animations` | multipart: `frames` (repeated, in order), `options` = JSON `{ animation:{…} }`, `webhook?` · or JSON `{ frames: [uploadId, …], options, webhook? }` | job with `kind: "animation"`. See [Animations](#animations). |
| `POST /api/subtitles` | multipart: `file`, `subtitles?` (.srt/.vtt), `options` = JSON `{ subtitles:{…} }`, `webhook?` · or JSON `{ upload: uploadId, options, webhook? }` | job with `kind: "subtitles"`. See [Subtitles](#subtitles). |
| `GET /api/jobs/:id/subtitles` | `?format=srt\|vtt`, `&download=1` for an attachment | the subtitles text of a finished subtitles job (whatever its output) |
| `GET /api/jobs?ids=a,b` | | `[job, …]` (batch status) |
| `GET /api/jobs/zip?ids=a,b` | | ZIP of every finished result |
| `GET /api/jobs/:id` | | job |
| `GET /api/jobs/:id/events` | | Server-Sent Events: `event: job` with the job JSON until it finishes |
| `POST /api/jobs/:id/cancel` | | job |
| `POST /api/jobs/:id/retry` | JSON `{ options: { <kind>: {…} } }` | job (re-queued, no re-upload) |
| `GET /api/jobs/:id/file` | `?inline=1` to view in the browser | the compressed file |
| `GET /api/jobs/:id/original` | | the uploaded original (for an animation, the first frame) |
| `DELETE /api/jobs/:id` | | `{ ok: true }`. Cancels the job and deletes its files. |

A job looks like `{ id, kind, name, status: queued|processing|done|error|cancelled, progress 0–1, stage?, speed, eta (s), inputSize, outputSize, outputName, outputMime, error, info, options }`. Poll `GET /api/jobs/:id` about once a second until `status` is `done`, `error` or `cancelled`. `GET /api/jobs/:id/file` may answer with a **302 redirect** to object storage, so follow redirects (`curl -L`).

### Options: CLI flag → API field

| CLI flag | API field (inside `video`, `image`, `audio`, `pdf` or `subtitles`) |
|---|---|
| `--quality high\|balanced\|small\|tiny` | `video.quality` |
| `--target-mb N` | `video.quality: "target"`, `video.targetMB: N` |
| `--codec h264\|h265` | `video.codec` |
| `--hw` | `video.encoder: "hardware"` (default `"cpu"`) |
| `--speed fast\|medium\|slow` | `video.speed: "veryfast"\|"medium"\|"slow"` |
| `--max-res N` | `video.resolution: N` |
| `--fps N` | `video.fps: N` |
| `--audio keep\|low\|remove` | `video.audio` |
| `--video-format mp4\|webm\|gif` | `video.format` |
| `--start T` / `--end T` | `video.trimStart` / `video.trimEnd` |
| `--pdf-quality Q` | `pdf.quality` |
| `--grayscale` | `pdf.grayscale: true` |
| `--image-format F` | `image.format` |
| `--image-quality N` | `image.quality` |
| `--max-dim N` | `image.maxDim` |
| `--keep-metadata` | `image.keepMetadata: true` |
| `--audio-format F` | `audio.format` |
| `--bitrate N` | `audio.bitrate` |
| `--mono` | `audio.mono: true` |
| `subtitles --lang L` / `--translate` / `--model M` | `subtitles.language` / `subtitles.translate: true` / `subtitles.model` |
| `subtitles --format F` / `--embed E` / `--font-size S` | `subtitles.format` / `subtitles.embed` / `subtitles.fontSize` |
| `subtitles --srt file` | multipart field `subtitles`, or `subtitles.text` (the file's contents) |

Both snippets below use `S` for the server URL. Set it to the user's server, not the default port.

### Small files: one request

```bash
S=${COMPRESS_MEDIA_URL:-http://localhost:4747}
AUTH=(-u "$COMPRESS_MEDIA_USER:$COMPRESS_MEDIA_PASSWORD")   # or: AUTH=(-H "Authorization: Bearer $COMPRESS_MEDIA_TOKEN")
id=$(curl -sf "${AUTH[@]}" -F file=@photo.heic -F 'options={"image":{"format":"webp","maxDim":1920}}' $S/api/jobs | jq -r .id)
while :; do st=$(curl -sf "${AUTH[@]}" $S/api/jobs/$id | jq -r .status); [ "$st" = queued ] || [ "$st" = processing ] || break; sleep 1; done
[ "$st" = done ] && curl -sfL "${AUTH[@]}" -o photo-compressed.webp $S/api/jobs/$id/file || curl -s "${AUTH[@]}" $S/api/jobs/$id | jq -r .error
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
AUTH=(-u "$COMPRESS_MEDIA_USER:$COMPRESS_MEDIA_PASSWORD")   # server calls only — never on presigned URLs
U=$(curl -sf "${AUTH[@]}" -X POST $S/api/uploads -H 'Content-Type: application/json' -d "{\"name\":\"clip.mov\",\"size\":$SIZE}")
ID=$(jq -r .uploadId <<<"$U"); P=$(jq -r .partSize <<<"$U"); N=$(jq -r .partCount <<<"$U"); D=$(jq -r .direct <<<"$U")
for n in $(seq 1 $N); do
  dd if="$F" of=/tmp/part bs=$P skip=$((n-1)) count=1 2>/dev/null
  if [ "$D" = true ]; then curl -sf -X PUT -H 'Content-Type:' --data-binary @/tmp/part "$(curl -sf "${AUTH[@]}" -X POST $S/api/uploads/$ID/parts/$n/url | jq -r .url)"
  else curl -sf "${AUTH[@]}" -X PUT -H 'Content-Type: application/octet-stream' --data-binary @/tmp/part $S/api/uploads/$ID/parts/$n; fi >/dev/null
done
JOB=$(curl -sf "${AUTH[@]}" -X POST $S/api/uploads/$ID/complete -H 'Content-Type: application/json' -d '{"options":{"video":{"resolution":1080,"fps":30}}}' | jq -r .id)
```

The repo has a complete client that works for **any** file size (it always uses the chunked upload) and adds retries, polling and download: `examples/compress.sh <file> '<options-json>' <url>`. Prefer it over these snippets when it's available.

### Animations

`POST /api/animations` makes one animated GIF, WebP or MP4 from 2 to `animationMaxFrames` (1000) images. Send the frames in one of two ways:

- **multipart/form-data:** one `frames` file field per image, in order, plus `options` (a JSON string) and an optional `webhook`.
- **JSON** `{ "frames": ["<uploadId>", …], "options": { "animation": {…} }, "webhook"? }`: each id is a chunked upload (`POST /api/uploads` + parts) whose parts have **all** been sent. Don't call `/complete` on them; the animation consumes the uploads.

The answer is a job with `kind: "animation"` and `frames: [{ name, size }, …]`. Poll and download it like any job. Errors: `400` fewer than 2 frames, `415` a frame isn't an image, `404` an unknown upload id, `409` an upload is missing parts.

The `animation` options object (all optional):

| Field | Values | Default | CLI flag |
|---|---|---|---|
| `format` | `gif` `webp` `mp4` | `gif` | `--format` |
| `delay` | ms, or an array with one value per frame | 500 | `--delay` / `--fps` |
| `loop` | 0 = forever, or a count | 0 | `--loop` |
| `maxDim` | px, long edge | 800 | `--max-dim` |
| `fit` | `contain` `cover` | `contain` | `--fit` |
| `background` | hex colour | `#ffffff` | `--background` |
| `quality` | 1–100 | 80 | `--quality` |

With `S` and `AUTH` set as in the snippets above:

```bash
curl -sf "${AUTH[@]}" -F frames=@shot-1.png -F frames=@shot-2.png -F frames=@shot-3.png \
  -F 'options={"animation":{"format":"gif","delay":700,"maxDim":1200}}' $S/api/animations | jq -r .id
```

The result is named `<first-frame-name>-animated.<gif|webp|mp4>`. Retry with new settings through `POST /api/jobs/:id/retry` and `{ "options": { "animation": {…} } }`.

### Subtitles

`POST /api/subtitles` makes one job for a video or audio file: speech → a subtitle file (whisper.cpp), or subtitles put into the video. Check `/api/config` first: `whisper` is `null` when the server can't do speech recognition (then send your own subtitles), and `burnSubtitles` must be true for `embed: "burn"`.

- **multipart/form-data:** `file` (video or audio), `options` (a JSON string), optional `webhook`, and optional `subtitles`: an `.srt`/`.vtt` file under 4 MB used **instead of** speech recognition.
- **JSON** `{ "upload": "<uploadId>", "options": { "subtitles": {…} }, "webhook"? }` for a chunked upload whose parts have all been sent. Don't call `/complete`. Own subtitles go in `options.subtitles.text`.

The `subtitles` options object (all optional):

| Field | Values | Default | CLI flag |
|---|---|---|---|
| `language` | `auto` or ISO 639-1 (`vi`, `en`…) | `auto` | `--lang` |
| `translate` | bool | `false` | `--translate` (not with `large-v3-turbo`) |
| `model` | `tiny` `base` `small` `medium` `large-v3-turbo` | server's `subtitleModel` | `--model` |
| `format` | `srt` `vtt` | `srt` | `--format` |
| `embed` | `none` `track` `burn` | `none` | `--embed` |
| `fontSize` | `small` `medium` `large` | `medium` | `--font-size` |
| `text` | SRT or WebVTT text | — | `--srt` (never echoed back in job responses) |

With `S` and `AUTH` set as in the snippets above:

```bash
id=$(curl -sf "${AUTH[@]}" -F file=@talk.mov -F 'options={"subtitles":{"language":"vi"}}' $S/api/subtitles | jq -r .id)
while :; do j=$(curl -sf "${AUTH[@]}" $S/api/jobs/$id); st=$(jq -r .status <<<"$j"); [ "$st" = queued ] || [ "$st" = processing ] || break; sleep 2; done
[ "$st" = done ] && curl -sfL "${AUTH[@]}" -OJ "$S/api/jobs/$id/subtitles?format=srt&download=1" || jq -r .error <<<"$j"
```

- While it runs, `stage` is `model` (downloading the speech model, first use only), `transcribe`, then `embed`; `progress` is 0–1 within the stage. The first job on a server can wait minutes for the model download.
- The result is `<name>.<language>.srt|vtt` for `embed: "none"`, or `<name>-subtitled.<ext>` (`track` keeps MP4/MOV/WebM/MKV, others → MKV; `burn` → MP4). `GET /api/jobs/:id/file` returns it; `GET /api/jobs/:id/subtitles?format=srt|vtt` returns the text either way.
- `info` is `{ cues, language, spokenLanguage, model, duration, embed, words }`.
- **Redo** with `POST /api/jobs/:id/retry` and `{ "options": { "subtitles": {…} } }` reuses the transcript (fast), unless `language`, `translate` or `model` changed. To fix the text, send it as `subtitles.text`; later redos keep that version.
- Errors: `415` not video/audio, or `subtitles` isn't an `.srt`/`.vtt` under 4 MB; `400` no cues in the text, `track`/`burn` on audio, no whisper.cpp and no subtitles given, or `burn` without libass; `404` unknown upload; `409` upload missing parts.
