# Configuration

Everything is configured with environment variables. You can set them:

- inline: `PORT=4848 npm start`;
- with `docker run -e`;
- in a **`.env` file**, which the server loads from the folder it starts in (`npm start`, `compress-media serve`) and which Docker Compose reads too.

Real environment variables take precedence over `.env`. [`.env.example`](../.env.example) lists them all.

The CLI only reads the [binaries](#binaries) group. Everything else applies to the server (`npm start`, `compress-media serve`, `compress-media worker`, or the Docker image).

## Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4747` | HTTP port. The server refuses to start if something already answers on it (IPv4 or IPv6). |
| `HOST` | `127.0.0.1` | Bind address. `0.0.0.0` accepts connections from other machines. The Docker image sets this for you. |
| `PUBLIC_URL` | — | The address users open, e.g. `https://media.example.com`. Used to check bucket CORS when `STORAGE=s3`. |
| `TRUST_PROXY` | — | Set behind a reverse proxy (`1`, `loopback`, or a subnet) so the login rate limit sees real client addresses. Uses Express's `trust proxy` values. |
| `WORK_DIR` | `./tmp` (`/data` in Docker) | Scratch space for uploads and results, plus `auth.json`. Needs room for your largest input plus its output. Only its `uploads/` and `outputs/` subfolders are ever wiped, and only with `QUEUE=memory`. |
| `JOB_TTL_HOURS` | `3` | Uploads, results and unfinished uploads are deleted this many hours after they were created. |
| `MAX_UPLOAD_MB` | `0` | Per-file size limit. `0` means unlimited. Checked when an upload starts. |

## Login

The web UI and the API require a login **by default**. `/api/health` and the static page stay public.

| Variable | Default | Description |
|---|---|---|
| `AUTH_ENABLED` | `true` | `false` turns login off. Only do that on a trusted network or behind a proxy that authenticates. |
| `AUTH_USERNAME` | `admin` | Username, or an email address. It's compared case-insensitively. `AUTH_EMAIL` works as an alias. |
| `AUTH_PASSWORD` | generated | The password. If it's not set, a random one is generated, **printed in the startup log**, and saved to `WORK_DIR/auth.json` so it survives restarts. |
| `AUTH_TOKEN` | — | Optional API token. Scripts send it as `Authorization: Bearer <token>`. HTTP Basic with username and password always works too. |
| `AUTH_SECRET` | generated | Signs session cookies. It's generated and saved to `auth.json` when unset. Set the same value on every web instance when you run several. |
| `AUTH_SESSION_HOURS` | `168` | How long a browser session lasts (7 days). |

After 10 wrong passwords from one address within 15 minutes, login is blocked for that address for the rest of the window.

## Processing

| Variable | Default | Description |
|---|---|---|
| `MEDIA_CONCURRENCY` | `1` | Video, audio and PDF jobs that run at the same time **per worker**. One ffmpeg already uses every CPU core. |
| `IMAGE_CONCURRENCY` | `3` | Image jobs that run at the same time per worker. |
| `HW_ENCODER` | `auto` | Hardware video encoder: `auto` detects one, `off` disables it, or name one of `videotoolbox`, `nvenc`, `qsv`, `vaapi`, `amf`. Candidates are verified with a test encode at startup. |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | Render node for VA-API (Intel/AMD on Linux). |

## Subtitles (speech recognition)

Speech recognition uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`whisper-cli`), which the Docker image includes. Elsewhere install it yourself (`brew install whisper-cpp` on macOS, your distribution's `whisper.cpp` package, or a release build). Without it, the Subtitles feature still adds your own `.srt`/`.vtt` files to videos.

Models are **not** bundled: each one is downloaded once, the first time it's used, from Hugging Face (`ggerganov/whisper.cpp`). A small voice-activity model (`ggml-silero-v5.1.2.bin`, under 1 MB) comes along to skip silence and music.

| Variable | Default | Description |
|---|---|---|
| `WHISPER_PATH` | `whisper-cli` (or `whisper-cpp`) on `PATH` | The whisper.cpp command. |
| `WHISPER_MODEL` | `small` | Model used when a request doesn't pick one: `tiny` (75 MB), `base` (142 MB), `small` (466 MB), `medium` (1.5 GB) or `large-v3-turbo` (547 MB, the most accurate; it can't translate). For Vietnamese and other languages that aren't English, use `small` or better. |
| `WHISPER_MODELS_DIR` | `WORK_DIR/models` (server), `~/.cache/compress-media/models` (CLI); `/data/models` in Docker | Where models are kept. They're never deleted by the app. |
| `WHISPER_DOWNLOAD` | `true` | `false` never downloads: put the `ggml-*.bin` files in `WHISPER_MODELS_DIR` yourself (for servers without internet access). |
| `WHISPER_MODEL_URL` | `https://huggingface.co/ggerganov/whisper.cpp/resolve/main` | Where models are downloaded from, e.g. your own mirror. |
| `WHISPER_THREADS` | CPU cores, up to 8 | Threads per transcription. |

Burning subtitles into the picture needs an ffmpeg with libass (the bundled one and Alpine's have it) and fonts: the Docker image includes DejaVu, which covers Vietnamese and other Latin, Greek and Cyrillic scripts. For Chinese, Japanese or Korean, add a CJK font (e.g. `font-noto-cjk`) to the image.

## Queue and scaling

| Variable | Default | Description |
|---|---|---|
| `QUEUE` | `memory` | `memory` keeps jobs and the queue inside one process. `redis` keeps them in Redis (BullMQ), so several web servers and workers can share them. |
| `REDIS_URL` | — | Required with `QUEUE=redis`, e.g. `redis://:password@redis:6379/0` (`rediss://` for TLS). |
| `REDIS_PREFIX` | `cm` | Key prefix, so several deployments can share one Redis. |
| `ROLE` | `all` | `all` serves HTTP and processes jobs. `web` only serves HTTP. `worker` only processes jobs (same as `compress-media worker`). `web` and `worker` need `QUEUE=redis`. |

With several machines, workers must see the uploaded files. Use `STORAGE=s3`, or a `WORK_DIR` on a shared network volume. See [deployment.md → Scaling out](deployment.md#scaling-out).

## Uploads

Browsers upload files in parts, several at a time. A part that fails is retried, and an interrupted upload resumes from the parts already stored. See [Chunked uploads](api.md#chunked-uploads).

| Variable | Default | Description |
|---|---|---|
| `UPLOAD_PART_MB` | `8` | Part size. Keep it at **5–100** to stay compatible with S3-style storage (minimum 5 MiB) and Cloudflare's proxy (100 MB per request). The server warns outside that range. |
| `UPLOAD_CONCURRENCY` | `4` | Parts each browser uploads in parallel (1–16). Browsers open about 6 connections per host over HTTP/1.1, so values above that only help over HTTP/2. |
| `UPLOAD_MAX_PARTS` | `10000` | Maximum number of parts per file (S3's limit). For very large files the part size grows automatically, in whole MiB. |

## Storage

| Variable | Default | Description |
|---|---|---|
| `STORAGE` | `local` | `local`: parts are sent to this server and kept in `WORK_DIR`. `s3`: browsers upload parts **straight to an S3-compatible bucket** through presigned URLs. Inputs and results live in the bucket, and workers fetch inputs when they process them. |

With `STORAGE=s3`:

| Variable | Default | Description |
|---|---|---|
| `S3_BUCKET` | — | Bucket name. **Required.** |
| `S3_REGION` | `us-east-1` | Region. Use `auto` for Cloudflare R2. |
| `S3_ENDPOINT` | AWS | Endpoint of any other S3-compatible provider, e.g. `https://<account>.r2.cloudflarestorage.com`. |
| `S3_PUBLIC_ENDPOINT` | `S3_ENDPOINT` | Endpoint written into the presigned URLs browsers receive. Set it when browsers reach the storage at a different address than the server does. |
| `S3_FORCE_PATH_STYLE` | `false` | `true` puts the bucket in the path (`host/bucket/key`). Needed by MinIO, SeaweedFS and most self-hosted stores. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | AWS default chain | Credentials. When unset, the AWS SDK default chain is used (environment, shared config, IAM role). |
| `S3_PREFIX` | `compress-media/` | Key prefix for every object this app writes (`uploads/…`, `outputs/…`, and a `cors-check` probe). |
| `S3_URL_EXPIRES` | `3600` | Lifetime of presigned URLs, in seconds. |
| `S3_SETUP_CORS` | `false` | `true` adds a CORS rule for `PUBLIC_URL` (or `*`) to the bucket at startup. Existing rules are kept. |

Provider examples, CORS, lifecycle rules and permissions are in [deployment.md → Object storage](deployment.md#object-storage).

## Webhooks

Jobs can carry a `webhook` URL that's called when they finish. See [api.md → Webhooks](api.md#webhooks).

| Variable | Default | Description |
|---|---|---|
| `WEBHOOK_SECRET` | — | Signs every delivery. The signature is sent as `X-Compress-Media-Signature: sha256=<HMAC-SHA256 of the body>`. |
| `WEBHOOK_ALLOW_PRIVATE` | `false` | Webhook URLs that resolve to private, loopback or link-local addresses are refused, to protect against SSRF. `true` allows them, e.g. for services on the same network. |

## Binaries

| Variable | Default | Description |
|---|---|---|
| `FFMPEG_PATH` | bundled `ffmpeg-static` | Path to ffmpeg. The Docker image uses Alpine's (`/usr/bin/ffmpeg`), which is much faster on ARM. |
| `FFPROBE_PATH` | bundled `@ffprobe-installer` | Path to ffprobe. |
| `GS_PATH` | `gs` (`gswin64c` on Windows) | Ghostscript, for PDF compression. The PDF feature is off when it's not found. |
| `WHISPER_PATH` | `whisper-cli` | whisper.cpp, for subtitles (see [Subtitles](#subtitles-speech-recognition)). |

HEIC decoding needs no configuration. It uses `sips` on macOS, or `heif-dec`/`heif-convert` (libheif) when found on `PATH`.

## Docker Compose only

| Variable | Default | Description |
|---|---|---|
| `COMPRESS_MEDIA_IMAGE` | `runsnip/compress-media:latest` | Image to run. Pin a version, e.g. `runsnip/compress-media:2.0.0`. |
| `COMPRESS_MEDIA_PORT` | `4747` | Host port to publish (on `127.0.0.1`). `PORT` is the port *inside* the container. |

## Test suite only

| Variable | Description |
|---|---|
| `E2E_BASE_URL` | Run the Playwright tests against an already running instance instead of starting one |
| `E2E_USERNAME`, `E2E_PASSWORD` | Login for that instance (defaults: `e2e@example.com` / `e2e-password`, which the self-started instance uses) |
| `E2E_PORT` | Port for the instance Playwright starts (default `4790`) |
| `E2E_JOB_TIMEOUT` | Milliseconds to wait for a compression job in E2E tests (default `90000`; raise it on slow machines) |
