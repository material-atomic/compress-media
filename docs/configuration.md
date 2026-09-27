# Configuration

Everything is configured with environment variables, set inline (`PORT=4848 npm start`), with `docker run -e`, or in a **`.env` file**. The server loads `.env` from the folder it starts in (`npm start`, `compress-media serve`), and Docker Compose reads the same file. Real environment variables take precedence over `.env`. [`.env.example`](../.env.example) lists them all. The CLI only reads the [binaries](#binaries) group; everything else applies to the web server (`npm start`, `compress-media serve` or the Docker image).

## Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4747` | HTTP port. The server refuses to start if something already answers on it (IPv4 or IPv6). |
| `HOST` | `127.0.0.1` | Bind address. `0.0.0.0` accepts connections from other machines. The Docker image sets this for you. |
| `PUBLIC_URL` | — | The address users open, e.g. `https://media.example.com`. Used to check bucket CORS when `STORAGE=s3`. |
| `WORK_DIR` | `./tmp` (`/data` in Docker) | Scratch space for uploads and results. Needs room for your largest input plus its output. Only its `uploads/` and `outputs/` subfolders are ever wiped. |
| `JOB_TTL_HOURS` | `3` | Uploads, results and unfinished uploads are deleted this many hours after they were created. |
| `MAX_UPLOAD_MB` | `0` | Per-file size limit. `0` means unlimited. Enforced when an upload starts. |

## Processing

| Variable | Default | Description |
|---|---|---|
| `MEDIA_CONCURRENCY` | `1` | Video and audio jobs that run at the same time. One ffmpeg already uses every CPU core, so raise this only on large machines. |
| `IMAGE_CONCURRENCY` | `3` | Image jobs that run at the same time. |

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
| `STORAGE` | `local` | `local`: parts are sent to this server and kept in `WORK_DIR`. `s3`: browsers upload parts **straight to an S3-compatible bucket** through presigned URLs, and results are served from the bucket. |

With `STORAGE=s3`:

| Variable | Default | Description |
|---|---|---|
| `S3_BUCKET` | — | Bucket name. **Required.** |
| `S3_REGION` | `us-east-1` | Region. Use `auto` for Cloudflare R2. |
| `S3_ENDPOINT` | AWS | Endpoint of any other S3-compatible provider, e.g. `https://<account>.r2.cloudflarestorage.com`. |
| `S3_PUBLIC_ENDPOINT` | `S3_ENDPOINT` | Endpoint written into the presigned URLs browsers receive. Set it when browsers reach the storage at a different address than the server does, e.g. `http://minio:9000` inside Docker vs `https://s3.example.com` outside. |
| `S3_FORCE_PATH_STYLE` | `false` | `true` puts the bucket in the path (`host/bucket/key`). Needed by MinIO, SeaweedFS and most self-hosted stores. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | AWS default chain | Credentials. When unset, the AWS SDK default chain is used (environment, shared config, IAM role). |
| `S3_PREFIX` | `compress-media/` | Key prefix for every object this app writes (`uploads/…`, `outputs/…`, and a `cors-check` probe). |
| `S3_URL_EXPIRES` | `3600` | Lifetime of presigned URLs, in seconds. |
| `S3_SETUP_CORS` | `false` | `true` adds a CORS rule for `PUBLIC_URL` (or `*`) to the bucket at startup. Existing rules are kept. |

Provider examples, CORS, lifecycle rules and permissions are in [deployment.md → Object storage](deployment.md#object-storage).

## Binaries

| Variable | Default | Description |
|---|---|---|
| `FFMPEG_PATH` | bundled `ffmpeg-static` | Path to ffmpeg. The Docker image uses Alpine's (`/usr/bin/ffmpeg`), which is much faster on ARM. |
| `FFPROBE_PATH` | bundled `@ffprobe-installer` | Path to ffprobe. |

HEIC decoding needs no configuration. It uses `sips` on macOS, or `heif-dec`/`heif-convert` (libheif) when found on `PATH`.

## Docker Compose only

| Variable | Default | Description |
|---|---|---|
| `COMPRESS_MEDIA_IMAGE` | `runsnip/compress-media:latest` | Image to run. Pin a version, e.g. `runsnip/compress-media:1.1.0`. |
| `COMPRESS_MEDIA_PORT` | `4747` | Host port to publish (on `127.0.0.1`). |

## Test suite only

| Variable | Description |
|---|---|
| `E2E_BASE_URL` | Run the Playwright tests against an already running instance instead of starting one |
| `E2E_PORT` | Port for the instance Playwright starts (default `4790`) |
| `E2E_JOB_TIMEOUT` | Milliseconds to wait for a compression job in E2E tests (default `90000`; raise it on slow machines) |
