# Compress Media

**English** · [Tiếng Việt](README.vi.md)

[![CI](https://github.com/material-atomic/compress-media/actions/workflows/ci.yml/badge.svg)](https://github.com/material-atomic/compress-media/actions/workflows/ci.yml)
[![Docker Hub](https://img.shields.io/docker/v/runsnip/compress-media?label=docker&sort=semver)](https://hub.docker.com/r/runsnip/compress-media)
[![Image size](https://img.shields.io/docker/image-size/runsnip/compress-media?sort=semver)](https://hub.docker.com/r/runsnip/compress-media)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A self-hosted compressor for **videos, images, audio and PDFs**, with a GIF maker and **subtitles from speech**. It comes with a drag-and-drop web UI, a CLI and an HTTP API, and uses ffmpeg, sharp, Ghostscript and whisper.cpp. It can also compress **right in the browser**, so files never leave the device.

- It was built for multi-gigabyte QuickTime screen recordings: a typical 2880×1800 60 fps recording comes out **90–98% smaller**.
- Files are processed on your own machine or server.
- Large uploads are chunked and resumable, and can go straight to S3-compatible object storage.

![Compress Media screenshot](docs/screenshot.png)

## Contents

[Features](#features) · [Planned for 2.2](#planned-for-22) · [Ways to use it](#ways-to-use-it) · [Quick start](#quick-start) · [Web UI](#web-ui) · [CLI](#cli) · [HTTP API](#http-api) · [Configuration](#configuration) · [Object storage](#object-storage) · [Platforms](#platform-support) · [AI agents](#use-with-ai-agents) · [Security](#security) · [Development](#development) · [License](#license)

## Features

- **Video** (MOV, MP4, MKV, WebM, AVI, …) → MP4, WebM or animated **GIF**.
  - H.264, which plays everywhere, H.265 (30–50% smaller), **AV1** (smaller still), or VP9 in WebM.
  - Quality presets, or a **target size in MB** for upload limits (two-pass).
  - **Trim** to a start and end time, downscaling, frame-rate cap, and keeping, reducing or removing audio.
  - **Hardware encoding**: Apple VideoToolbox, NVIDIA NVENC, Intel Quick Sync, VA-API and AMD AMF, detected automatically.
- **Images** (JPG, PNG, WebP, AVIF, **HEIC**, GIF, TIFF).
  - Keep the format or convert to JPEG, WebP, AVIF or PNG.
  - Quality setting and maximum edge.
  - Lossy PNG palette, like pngquant.
  - Animated GIF and WebP stay animated, even when the chosen format can't animate.
  - EXIF and GPS metadata are removed by default.
- **Audio** (WAV, M4A, FLAC, AIFF, MP3, …) → MP3, M4A or Opus, with a bitrate setting and optional mono.
- **PDF** → smaller PDF, with presets from 72 to 300 dpi images and optional grayscale (Ghostscript).
- **Animations from still images** (GIF maker): 2–1000 screenshots or photos → one animated GIF, animated WebP or MP4, with a delay per frame, looping and a size cap.
- **Subtitles**: speech in a video or audio file → an SRT or WebVTT file with times and text (whisper.cpp, language detected or chosen, optional translation to English), or subtitles added to the video as a selectable track or burned into the picture. Your own `.srt`/`.vtt` works too.
- **In-browser mode (beta)**: videos, audio and images compressed on the user's own device with WebCodecs. Nothing is uploaded, and the server takes over whatever the browser can't do.
- **Uploads**
  - Chunked (8 MB parts, 4 in parallel).
  - Failed parts are retried, and an interrupted upload resumes, even after a page reload.
  - Parts can go straight to AWS S3, Cloudflare R2, GCS, MinIO, B2, …
- **Workflow**
  - Batch drag-and-drop or paste.
  - Live progress and ETA.
  - Side-by-side preview.
  - Re-compress with new settings without re-uploading.
  - Cancel, and **download all as one ZIP**.
- **Built-in login**, on by default: username/email and password from the environment, with API tokens for scripts.
- **Integrations**: an HTTP API with Server-Sent Events, signed webhooks and batch status.
- **Scales out**: an optional Redis queue with separate workers.
- **Web UI** in English and Vietnamese, with light and dark themes. It works on phones.

## Planned for 2.2

Next up; not built yet, and details may change.

- **Cleaner sound.** Loudness normalisation to the level YouTube and TikTok expect (−14 LUFS), and background-noise reduction (fans, air conditioning) for video and audio.
- **Rotate, flip and change speed.** Turn a sideways video upright, mirror it, or play it 1.5×, 2× or as a timelapse.
- **Cut the silences.** Remove long pauses from talking videos automatically (jump cuts), using the same speech detection as subtitles.
- **Watermark.** Put a logo or text on videos and images, with position and opacity.
- **YouTube chapters.** Chapter timestamps suggested from the subtitles, ready to paste into the video description.
- **Translate subtitles** into other languages, not only English (for example English → Vietnamese).
- **Join videos.** Put several clips together into one.

What changed in each release, including upgrade notes: [CHANGELOG.md](CHANGELOG.md).

## Ways to use it

| | Best for | Start with |
|---|---|---|
| **Web UI** | People: drag files in, download results | `docker run … runsnip/compress-media` or `npm start` |
| **CLI** | Scripts, batch folders, AI agents; no server needed | `compress-media clip.mov` |
| **HTTP API** | Other services and apps that call a shared instance | [docs/api.md](docs/api.md), [examples/](examples) |
| **AI agents** | Asking Claude or another agent to compress files, or to deploy the service | [skills/](skills) |

## Quick start

**Docker** (any OS):

```bash
docker run -d --name compress-media -p 127.0.0.1:4747:4747 -v compress-media-data:/data \
  -e AUTH_USERNAME=me@example.com -e AUTH_PASSWORD='choose-a-password' runsnip/compress-media
```

Then open http://localhost:4747 and sign in. Without `AUTH_PASSWORD`, a password is generated: see `docker logs compress-media | grep Login`.

**Docker Compose** (settings from `.env`):

```bash
cp .env.example .env    # optional
docker compose up -d
```

**Node.js 20+** (recommended on a Mac: hardware encoding and HEIC):

```bash
npm install
npm start               # http://localhost:4747
```

You don't need to install ffmpeg; `npm install` downloads a build. The startup log prints the login (set `AUTH_USERNAME`/`AUTH_PASSWORD` in `.env`, or `AUTH_ENABLED=false` for a private machine). If port 4747 is taken, the server refuses to start rather than colliding with the other app; run `PORT=4848 npm start` instead.

For PDF compression natively, install Ghostscript (`brew install ghostscript`, `apt install ghostscript`); for subtitles from speech, install whisper.cpp (`brew install whisper-cpp`). The Docker image includes both.

## Web UI

1. Sign in, then choose settings in the **Video**, **Image**, **Audio** and **PDF** tabs. They are remembered in the browser. Optionally pick **Compress on: This browser** to keep files on the device (HTTPS or localhost only).
2. Drop files onto the page, pick them, or paste them. Several files are processed at once.
3. Each row shows upload and compression progress. When a file is done:
   - **Download** saves the result;
   - **View** compares the original and the result side by side;
   - **Redo** re-compresses with the current settings, without uploading again.
4. If the network drops, the row shows **Resume**. Only the missing parts are sent. Adding the same file again after a reload also resumes.
5. **Download all** saves every result, and **Clear list** removes finished rows (and their files on the server).

The switch at the top of the page picks what to do: **Compress files**, **Make an animation** or **Subtitles**. The settings and the file area follow it.

To make a GIF from screenshots, switch to **Make an animation**. Dropped images become numbered frames: drag them (or use ← →) to reorder, remove one, or **Clear**. Choose the format, time per frame, loop and size in the **Animation** tab, then press **Create animation**. The result is one row, with **Redo** and **View** like any other. Animations are always made on the server, even with **Compress on: This browser**.

For subtitles, switch to **Subtitles** and drop videos (or audio). In the **Subtitles** tab choose the result (**Subtitle file**, **Video + track** or **Burned in**), the file format (SRT or WebVTT), the spoken language, **Translate into English subtitles** and the accuracy (the speech model; the first use downloads it). To use your own subtitles, drop the `.srt`/`.vtt` together with the video, with the same name (`talk.mov` + `talk.srt`). Rows show each stage: downloading the model, listening and writing subtitles, adding them to the video. When done, **Download** saves the result (and **SRT** the subtitle file, when the result is a video). **View & edit** plays the video with the subtitles next to an editor: **Preview changes**, then **Save** to make the result again from your text, without new speech recognition. **Redo** reuses the transcript unless the language, translation or model changed. Subtitles are always made on the server.

Rows warn you when a result isn't smaller than the original; in that case, keep the original. The UI language follows the browser, and you can switch with EN/VI in the header.

## CLI

The same engine, straight from the terminal. It needs no server.

```bash
npm install && npm link                                   # or: node bin/cli.js …

compress-media "Screen Recording.mov" --max-res 1080 --fps 30
compress-media clip.mov --target-mb 24                   # fit an email attachment
compress-media clip.mov --codec h265 --speed slow        # smallest, for Apple / modern browsers
compress-media ~/Pictures/trip -r --image-format webp --max-dim 2048 -o web
compress-media memo.m4a --audio-format opus --bitrate 48 --mono
compress-media demo.mov --start 0:04 --end 0:19 --video-format gif   # a GIF for an issue
compress-media cv.pdf --pdf-quality ebook                            # a CV for email
compress-media animate shot-*.png --delay 700 --max-dim 1200 -o walkthrough.gif   # screenshots → GIF
compress-media subtitles talk.mov --lang vi              # speech → talk.vi.srt (e.g. for YouTube)
compress-media subtitles talk.mov --srt talk.srt --embed burn --font-size large   # your subtitles, drawn into the video
compress-media probe clip.mov                             # resolution, fps, duration, codecs
compress-media *.mov --json -q > report.json              # machine-readable report
compress-media serve                                      # the web UI
```

- Results are written next to each input as `<name>-compressed.<ext>`. Inputs are never touched.
- Exit codes: `0` means everything succeeded, `1` means some files failed, `2` means bad usage.
- Through Docker: `docker run --rm -v "$PWD:/work" -w /work runsnip/compress-media compress-media clip.mov`.

Every flag, the JSON report format and performance notes are in **[docs/cli.md](docs/cli.md)**.

## HTTP API

The web UI is built on a small JSON API you can call yourself. Authenticate with HTTP Basic or `Authorization: Bearer $AUTH_TOKEN`:

1. Start a chunked upload.
2. PUT the parts, to the server or straight to the bucket.
3. Complete the upload, which creates a job.
4. Poll the job.
5. Download the result.

Animations have their own endpoint, `POST /api/animations`, which takes the frames in order, and so do subtitles: `POST /api/subtitles` takes a video (and optionally your `.srt`/`.vtt`), and `GET /api/jobs/:id/subtitles` returns the text as SRT or WebVTT. There's also a ZIP of many results, live progress over Server-Sent Events, and signed webhooks when a job finishes. Two ready-to-use clients handle retries and both storage modes:

```bash
export COMPRESS_MEDIA_USER=me@example.com COMPRESS_MEDIA_PASSWORD=…
examples/compress.sh "Screen Recording.mov" '{"video":{"resolution":1080,"fps":30}}' http://localhost:4747   # bash + curl + jq
node examples/compress.mjs photo.heic '{"image":{"format":"webp"}}'                                        # Node.js 20+
```

The endpoints, options, status codes and upload protocol are in **[docs/api.md](docs/api.md)**.

## Configuration

Everything is set with environment variables: inline, with `docker run -e`, or in a `.env` file (read by both `npm start` and Docker Compose; real environment variables win). The most used:

| Variable | Default | Description |
|---|---|---|
| `PORT` / `HOST` | `4747` / `127.0.0.1` | Where the web server listens |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | `admin` / generated | Login (username or email). `AUTH_ENABLED=false` turns it off; `AUTH_TOKEN` enables an API token. |
| `PUBLIC_URL` | — | Public address, e.g. `https://media.example.com` (used to check bucket CORS) |
| `JOB_TTL_HOURS` | `3` | Files are deleted after this many hours |
| `MAX_UPLOAD_MB` | `0` | Per-file limit (0 = unlimited) |
| `MEDIA_CONCURRENCY` | `1` | Video/audio jobs in parallel |
| `UPLOAD_PART_MB` / `UPLOAD_CONCURRENCY` | `8` / `4` | Upload part size (keep 5–100) and parallel parts |
| `STORAGE` | `local` | `local` (disk) or `s3` (object storage) |
| `QUEUE` / `REDIS_URL` / `ROLE` | `memory` / — / `all` | Shared Redis queue, and `web` / `worker` processes for scaling out |
| `HW_ENCODER` | `auto` | `off`, or force `videotoolbox` / `nvenc` / `qsv` / `vaapi` / `amf` |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | Object storage |
| `WHISPER_MODEL` | `small` | Speech model for subtitles: `tiny`, `base`, `small`, `medium` or `large-v3-turbo` |
| `WHISPER_MODELS_DIR` / `WHISPER_DOWNLOAD` | `WORK_DIR/models` / `true` | Where speech models are kept; `false` never downloads them (offline servers) |

All variables are in **[docs/configuration.md](docs/configuration.md)**, and a commented template is in [`.env.example`](.env.example).

## Object storage

Set `STORAGE=s3` and browsers upload **directly to your bucket** through presigned URLs, so upload traffic never passes through the app server. Results are stored in the bucket and downloaded from it.

It works with AWS S3, Cloudflare R2, Google Cloud Storage, MinIO, SeaweedFS, Backblaze B2, DigitalOcean Spaces and Wasabi (not Azure).

```env
STORAGE=s3
S3_BUCKET=compress-media
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
PUBLIC_URL=https://media.example.com
S3_SETUP_CORS=true        # adds the CORS rule browsers need (existing rules are kept)
```

To try it locally with a bundled S3 server: `docker compose -f docker-compose.s3.yml up -d`.

**More machines:** with `QUEUE=redis`, any number of web servers and workers share one queue. `docker compose -f docker-compose.scale.yml up -d` starts a web server, 2 workers and Redis. See [deployment.md → Scaling out](docs/deployment.md#scaling-out).

Per-provider settings, CORS, a lifecycle rule, an IAM policy and scaling notes are in **[docs/deployment.md](docs/deployment.md)**, along with Caddy and nginx configs for exposing the app safely.

## Platform support

| | macOS | Linux | Windows |
|---|---|---|---|
| Docker (`amd64`, `arm64`) | ✅ | ✅ | ✅ (Docker Desktop) |
| `npm start` / CLI | ✅ | ✅ x64 & arm64 | ✅ x64 |
| Hardware encoding | ✅ VideoToolbox | NVENC, VA-API, Quick Sync (auto-detected) | NVENC, Quick Sync, AMF (auto-detected) |
| HEIC photos | ✅ built in | install `libheif-examples` / `libheif-tools` | use Docker |
| PDF | install Ghostscript | install `ghostscript` | install Ghostscript, or use Docker |
| Subtitles from speech | `brew install whisper-cpp` | the `whisper.cpp` package, or build it | a whisper.cpp release build (`WHISPER_PATH`), or use Docker |
| In-browser mode | Chrome, Edge, Firefox, Safari (over HTTPS or localhost; codecs vary by browser, and the server fills the gaps) | | |

On Linux ARM, point `FFMPEG_PATH`/`FFPROBE_PATH` at the distribution's ffmpeg; the bundled generic build is much slower there. The Docker image already does this.

## Recommended settings

| Goal | Web UI / API | CLI |
|---|---|---|
| Screen recording to share anywhere | H.264 · Balanced · 1080p · 30 fps | `--max-res 1080 --fps 30` |
| Fit an upload limit | Target MB | `--target-mb 24` |
| Smallest, Apple devices / modern browsers | H.265 · CPU · Slow | `--codec h265 --speed slow` |
| Long video, fast (macOS) | Apple hardware | `--hw` |
| Images for a website | WebP · max 1920 px | `--image-format webp --max-dim 1920` |
| Voice memo | Opus · 48 kbps · mono | `--audio-format opus --bitrate 48 --mono` |
| A clip for docs or an issue | GIF · trim · 480p | `--video-format gif --start 4 --end 19` |
| CV or portfolio PDF | PDF · Balanced | `--pdf-quality ebook` |
| A GIF from screenshots | Make an animation · GIF · 700 ms | `animate shot-*.png --delay 700` |
| Subtitles for YouTube | Subtitles · Subtitle file · SRT · Balanced | `subtitles talk.mov --lang vi` |
| Captions for TikTok / Reels | Subtitles · Burned in · Large | `subtitles clip.mov --embed burn --font-size large` |

## Use with AI agents

| For | File |
|---|---|
| An agent that **compresses files for you** (CLI or API): finding the tool, choosing settings from your goal, reading the report, never deleting originals | [`skills/compress-media/`](skills/compress-media/SKILL.md) |
| An agent that **deploys or operates the service**: Docker, reverse proxy, object storage, CORS, troubleshooting | [`skills/compress-media-deploy/`](skills/compress-media-deploy/SKILL.md) |
| An agent that **works on this codebase**: architecture, commands, definition of done, known pitfalls | [`AGENTS.md`](AGENTS.md) (Claude Code loads it through `CLAUDE.md`) |
| An LLM that needs a map of the docs | [`llms.txt`](llms.txt) |

To install the skills in Claude Code:

```bash
cp -r skills/* ~/.claude/skills/        # all projects
cp -r skills/* .claude/skills/          # one project
```

Other agents can be pointed at the `SKILL.md` files directly; each skill is self-contained.

## Security

**Login is required by default.** It uses signed HttpOnly session cookies, HTTP Basic or a bearer token for scripts, and repeated wrong passwords are rate-limited. The server also binds to `127.0.0.1` by default, and the Compose files publish the port on `127.0.0.1` only. For public exposure, add TLS with a reverse proxy ([examples](docs/deployment.md#reverse-proxy)).

- Uploaded file names are never used as paths.
- Webhook URLs to private networks are refused by default (SSRF protection).
- The server only deletes its own `uploads/` and `outputs/` folders.
- With object storage, browsers only ever get short-lived presigned URLs.

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## How it works

```
browser ──parts──▶ server.js (web) ───────────────────┐        (STORAGE=local)
browser ──parts──▶ S3 bucket ◀── presign ── server.js │        (STORAGE=s3)
browser ── WebCodecs (public/local.js) ── nothing uploaded      ("Compress on: This browser")
                          job queue (memory, or Redis) ▼
                    worker(s) ──▶ lib/media.js ──▶ ffmpeg / sharp / Ghostscript / whisper.cpp
terminal / agent ──▶ bin/cli.js ──▶ lib/media.js
```

| Path | What it is |
|---|---|
| [`lib/media.js`](lib/media.js) | The engine: type detection, capabilities (VideoToolbox, HEIC), ffprobe, encoders |
| [`lib/subtitles.js`](lib/subtitles.js) | SRT/WebVTT reading and writing, readable subtitle lines, speech model downloads |
| [`lib/storage.js`](lib/storage.js) | Where uploads and results live (`local` or `s3`) |
| [`lib/jobs.js`](lib/jobs.js) · [`lib/store.js`](lib/store.js) | Job lifecycle, and where jobs and the queue live (`memory` or `redis`) |
| [`lib/auth.js`](lib/auth.js) · [`lib/webhook.js`](lib/webhook.js) | Login, and signed webhooks |
| [`server.js`](server.js) | Express app: chunked uploads, API, ZIP, SSE; runs as web, worker or both |
| [`bin/cli.js`](bin/cli.js) | The CLI |
| [`public/`](public) | The web UI: plain HTML, CSS and JS with no build step (`local.js` = in-browser mode, `i18n.js` = translations) |

## Development

```bash
npm run dev             # web UI with auto-restart
npm run typecheck       # JSDoc types checked by TypeScript (nothing is compiled)
npm test                # API, CLI and login tests (generates sample media with ffmpeg)
npx playwright install chromium firefox webkit   # once
npm run test:e2e        # browser tests on Chromium, Firefox and WebKit
```

To run the tests in object-storage mode against any S3-compatible server:

```bash
STORAGE=s3 S3_BUCKET=… S3_ENDPOINT=… S3_FORCE_PATH_STYLE=true S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… npm test
QUEUE=redis REDIS_URL=redis://localhost:6379 npm test       # the shared-queue mode
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

**Releases:** bump `version` in `package.json` and push a matching `vX.Y.Z` tag. CI then builds multi-arch images and publishes them to Docker Hub and GHCR.

## License

The code is [MIT](LICENSE) licensed. Compress Media runs third-party software under its own licenses:

| Component | License | How it's used |
|---|---|---|
| **FFmpeg** with x264/x265 | **GPL** | Separate program |
| **Ghostscript** (PDF) | **AGPL-3.0** | Separate program. Not in the `-nopdf` images (`runsnip/compress-media:2.0.0-nopdf`, `latest-nopdf`). |
| **sharp / libvips** | Apache-2.0 / **LGPL-3.0** | Dynamically linked, replaceable |
| **libheif** (Docker) | LGPL-3.0 | Separate program |
| **Mediabunny** (in-browser mode) | **MPL-2.0** | Served unmodified |
| **whisper.cpp** (subtitles) | MIT | Separate program. Its speech models (MIT) are downloaded on first use, not shipped. |
| **DejaVu fonts** (Docker) | Bitstream Vera / DejaVu (free) | Fonts for burned-in subtitles |
| AWS SDK, Express, BullMQ, ioredis, yazl… | Apache-2.0 / MIT / ISC / BSD | Libraries |

Your own code that uses Compress Media is not affected. **If you redistribute the Docker image**, it contains GPL/AGPL/LGPL binaries whose licenses apply to them. See **[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)** for what that means, where the sources are, and patent notes on H.264/H.265/AAC.

Made by [RunSnip](https://runsnip.com).
