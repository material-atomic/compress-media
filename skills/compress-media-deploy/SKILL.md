---
name: compress-media-deploy
description: Install, configure, deploy, scale, upgrade and troubleshoot a Compress Media server (web UI + HTTP API for compressing video, images, audio and PDF), with Docker, Docker Compose or Node.js, local disk or S3-compatible object storage (AWS S3, Cloudflare R2, GCS, MinIO, B2), login, GPU encoding, a Redis queue with separate workers, behind a reverse proxy. Use when the user wants to host or run Compress Media, expose it to a team, move uploads to a bucket, fix CORS/upload/port/disk problems, or update the running version. To compress files, use the compress-media skill instead.
---

# compress-media-deploy

Compress Media is a Node.js server. It serves a web UI and a JSON API, and compresses with ffmpeg and sharp.

- **Image:** `runsnip/compress-media` on Docker Hub (`linux/amd64`, `linux/arm64`).
- **Port:** 4747.
- **Health check:** `GET /api/health`.
- **Configuration:** environment variables only.

## 1. Pick the setup from the goal

Ask what the user wants if it isn't clear. The choice decides everything else.

| Goal | Setup |
|---|---|
| Compress their own files on a Mac, fastest | Native: `npm install && npm start`. This enables the Apple hardware encoder and HEIC via `sips`. |
| Private tool on a PC, NAS or home server | Docker or Compose, port on `127.0.0.1` (or the LAN) |
| Shared with a team or the public | Docker + reverse proxy **with auth** + `PUBLIC_URL`, usually `STORAGE=s3` |
| Many or large uploads, or behind Cloudflare | `STORAGE=s3`: browsers upload straight to the bucket |
| Heavy video work, many users | `QUEUE=redis` + separate workers (`docker-compose.scale.yml`); `STORAGE=s3` when workers run on other machines |
| Organisation forbids AGPL software | Use the `-nopdf` image tags (e.g. `runsnip/compress-media:2.0.0-nopdf`): no Ghostscript, no PDF feature |

## 2. Run it

**Docker:**

```bash
docker run -d --name compress-media --restart unless-stopped \
  -p 127.0.0.1:4747:4747 -v compress-media-data:/data \
  -e AUTH_USERNAME=admin@example.com -e AUTH_PASSWORD='<ask the user>' \
  -e JOB_TTL_HOURS=3 \
  runsnip/compress-media:2.0.0
```

- Pin a version tag in production; `latest` moves.
- `/data` is scratch space for uploads and results. It needs room for the largest input plus its output.

**Compose:** use the repo's `docker-compose.yml` with settings in `.env`, then `docker compose up -d`. Compose publishes the host port from `COMPRESS_MEDIA_PORT`, not `PORT`; `PORT` is the port inside the container. `docker-compose.s3.yml` runs the app with a local S3 server (SeaweedFS) to try object storage.

**Native:**
- Node.js 20+: `npm install && npm start`. Every variable in section 4 works the same way here: put it inline (`PORT=4801 MAX_UPLOAD_MB=500 npm start`) or in a `.env` file in the folder you start from. Inline values win over `.env`.
- `HOST=0.0.0.0` makes it reachable from other machines on the network. There is no login, so only do this on a trusted LAN.
- On Linux, install `libheif-examples` for HEIC.
- On Linux ARM, set `FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe`.

## 3. Login (on by default)

- Set `AUTH_USERNAME` (a username or an email) and `AUTH_PASSWORD`. If no password is set, one is generated and printed: `docker logs compress-media | grep Login` (it's saved in `/data/auth.json`).
- `AUTH_TOKEN` gives scripts a bearer token.
- Behind a proxy, set `TRUST_PROXY=1` so the login rate limit sees real client addresses.
- Only set `AUTH_ENABLED=false` when the user asks and the server is private, or when a proxy already authenticates.
- Don't invent passwords for the user. Ask, or let the server generate one and tell them where to find it.

## 4. Configure

| Variable | Default | Notes |
|---|---|---|
| `PORT`, `HOST` | `4747`, `127.0.0.1` | The image uses `HOST=0.0.0.0` inside the container. The server refuses to start if the port is taken. |
| `PUBLIC_URL` | — | The URL users open. Needed for the S3 CORS check. |
| `WORK_DIR` | `./tmp`, `/data` in Docker | Only its `uploads/` and `outputs/` are wiped |
| `JOB_TTL_HOURS` | `3` | Uploads, results and unfinished uploads are deleted after this |
| `MAX_UPLOAD_MB` | `0` | 0 = unlimited. Set a cap on shared servers. |
| `MEDIA_CONCURRENCY` / `IMAGE_CONCURRENCY` | `1` / `3` | One ffmpeg already uses all cores |
| `UPLOAD_PART_MB` | `8` | Keep 5–100 (S3 minimum, Cloudflare maximum) |
| `UPLOAD_CONCURRENCY` | `4` | Parallel parts per browser |
| `UPLOAD_MAX_PARTS` | `10000` | S3 limit. The part size grows for huge files. |
| `STORAGE` | `local` | `s3` for object storage |
| `S3_BUCKET` | — | Required for s3 |
| `S3_REGION` | `us-east-1` | `auto` for R2 |
| `S3_ENDPOINT` | AWS | Any S3-compatible endpoint |
| `S3_PUBLIC_ENDPOINT` | = endpoint | When browsers reach the storage at another address |
| `S3_FORCE_PATH_STYLE` | `false` | `true` for MinIO/SeaweedFS |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | AWS chain | |
| `S3_PREFIX` | `compress-media/` | |
| `S3_URL_EXPIRES` | `3600` | |
| `S3_SETUP_CORS` | `false` | `true` adds the CORS rule at startup and keeps existing rules |
| `FFMPEG_PATH` / `FFPROBE_PATH` / `GS_PATH` | bundled / bundled / `gs` | |
| `AUTH_ENABLED` / `AUTH_USERNAME` / `AUTH_PASSWORD` / `AUTH_TOKEN` / `AUTH_SECRET` | `true` / `admin` / generated / — / generated | Login. Share `AUTH_SECRET` across web instances. |
| `TRUST_PROXY` | — | `1` behind one proxy |
| `QUEUE` / `REDIS_URL` / `REDIS_PREFIX` | `memory` / — / `cm` | Shared queue |
| `ROLE` | `all` | `web`, `worker` (needs `QUEUE=redis`) |
| `HW_ENCODER` / `VAAPI_DEVICE` | `auto` / `/dev/dri/renderD128` | Hardware encoder |
| `WEBHOOK_SECRET` / `WEBHOOK_ALLOW_PRIVATE` | — / `false` | Webhook signing; allow webhooks to private addresses |

Keep secrets out of files that get committed: use `.env` (git-ignored) or the platform's secret store.

## 5. Object storage (`STORAGE=s3`)

Browsers PUT upload parts to presigned bucket URLs. Results are uploaded to the bucket and served through presigned GET redirects. The server still needs `WORK_DIR` space while ffmpeg runs.

| Provider | Endpoint / region |
|---|---|
| AWS S3 | no endpoint; `S3_REGION=<region>`. Can use an IAM role instead of keys. |
| Cloudflare R2 | `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`, `S3_REGION=auto` |
| Google Cloud Storage | `S3_ENDPOINT=https://storage.googleapis.com`, HMAC keys from *Settings → Interoperability*. CORS via `gcloud`, not `S3_SETUP_CORS`. |
| Backblaze B2 | `S3_ENDPOINT=https://s3.<region>.backblazeb2.com`, `S3_REGION=<region>` |
| DigitalOcean Spaces | `S3_ENDPOINT=https://<region>.digitaloceanspaces.com` |
| Wasabi | `S3_ENDPOINT=https://s3.<region>.wasabisys.com` |
| MinIO / SeaweedFS / Garage | `S3_ENDPOINT=http://host:port`, `S3_FORCE_PATH_STYLE=true`, and `S3_PUBLIC_ENDPOINT` if browsers use another host |
| Azure Blob | not supported (no S3 API) |

**CORS is required.** Browsers upload from the app's origin. Either set `S3_SETUP_CORS=true` once (it needs `s3:PutBucketCORS`), or add this rule:

```json
[{ "AllowedOrigins": ["https://media.example.com"], "AllowedMethods": ["PUT","GET","HEAD"],
   "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
```

If the bucket is shared with other apps, tell the user before changing its CORS. `S3_SETUP_CORS` appends a rule and never removes existing ones.

**Recommend a lifecycle rule** on the prefix: expire objects after 1 day, and abort incomplete multipart uploads after 1 day.

**Permissions:**
- On `BUCKET/compress-media/*`: `s3:PutObject`, `GetObject`, `DeleteObject`, `AbortMultipartUpload`, `ListMultipartUploadParts`.
- On the bucket: `s3:ListBucket`, plus `GetBucketCORS` and `PutBucketCORS` only if you use `S3_SETUP_CORS`.

## 6. Expose it safely

Keep login on, and put TLS in front with a proxy. The extra `basic_auth` below is optional, for defence in depth. HTTPS is also what lets browsers use "Compress on: This browser", since WebCodecs needs a secure context.

```caddyfile
media.example.com {
	basic_auth {
		team <hash from: caddy hash-password --plaintext '…'>
	}
	reverse_proxy compress-media:4747
}
```

With nginx:
- `client_max_body_size` must be larger than `UPLOAD_PART_MB` (e.g. `16m`);
- set `proxy_request_buffering off`;
- set `proxy_read_timeout 300s`.

Cloudflare's 100 MB request limit is fine with the default 8 MB parts.

## 7. Scale out (`QUEUE=redis`)

- `docker compose -f docker-compose.scale.yml up -d` starts Redis, a web server and 2 workers on one host, sharing a volume. Use `--scale worker=N` for more.
- On several hosts:
  - run web servers with `ROLE=web` behind a load balancer (no sticky sessions needed; share `AUTH_SECRET`);
  - run workers with `ROLE=worker`, or `compress-media worker`;
  - use `STORAGE=s3` so every host sees the files.
- Each worker runs `MEDIA_CONCURRENCY` media jobs. Size the worker count by CPU, since encoding uses every core.

### GPU encoding

- Intel/AMD: `docker run --device /dev/dri …` (VA-API; the image's ffmpeg has no Quick Sync).
- NVIDIA: `--gpus all -e NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`, plus an ffmpeg build with NVENC via `FFMPEG_PATH`.
- Confirm with the startup line `Hardware encoder: …`, or `/api/config` → `hardwareName`.

## 8. Verify

Run these after every deploy or change:

```bash
curl -s http://localhost:4747/api/health                            # {"ok":true} (public)
curl -s -u "$USER:$PASS" http://localhost:4747/api/config | jq       # version, hardwareName, av1, pdf, storage, queue…
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4747/api/config   # 401: login is enforced
docker logs compress-media 2>&1 | head                               # "Storage: … · Queue: …", "Login: …", no "WARNING … CORS"
```

Then do a real round trip. From a repo checkout:

```bash
COMPRESS_MEDIA_USER=… COMPRESS_MEDIA_PASSWORD=… examples/compress.sh some-video.mov '{"video":{"resolution":720}}' <PUBLIC_URL or http://localhost:4747>
```

Or upload a file in the web UI. With S3, open the browser devtools: part `PUT`s should go to the bucket host and return 200.

## 9. Upgrade and roll back

**1.x → 2.0:** login becomes required. Before upgrading, choose `AUTH_USERNAME`/`AUTH_PASSWORD` (or `AUTH_ENABLED=false` for a private box), and give scripts credentials.


```bash
docker pull runsnip/compress-media:<new-version>
docker rm -f compress-media && docker run … runsnip/compress-media:<new-version>   # same flags as before
```

With Compose, set `COMPRESS_MEDIA_IMAGE=runsnip/compress-media:<version>` in `.env`, then run `docker compose pull && docker compose up -d`.

- Jobs in progress are lost on restart, because they live in memory. Upgrade when idle.
- To roll back, run the previous tag.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Port 4747 is already in use by another app` | Another service holds the port (IPv4 or IPv6). Pick another `PORT`, or publish a different host port. |
| `ENOSPC: no space left on device` | `WORK_DIR` or the Docker VM disk is full. Free space, or mount a bigger volume. Don't prune other projects' volumes without asking. |
| Startup: `Cannot reach S3 storage: …` | Wrong bucket, endpoint, region or keys. Check with `aws s3api head-bucket --bucket B [--endpoint-url …]`. |
| Startup: `WARNING … does not allow PUT from <origin> (CORS)` | Add the CORS rule, or set `S3_SETUP_CORS=true`. `PUBLIC_URL` must be exactly the origin users open. |
| Browser: uploads fail at "Uploading x%", console shows CORS errors | Same as above, or `S3_PUBLIC_ENDPOINT` isn't reachable from the browser. |
| `Storage error: EntityTooSmall` | `UPLOAD_PART_MB` is below 5 while `STORAGE=s3`. Raise it. |
| Parts fail with `413` behind a proxy | The proxy body limit is smaller than `UPLOAD_PART_MB`. Raise `client_max_body_size`, or lower the part size. |
| API `413 File is larger than …` | `MAX_UPLOAD_MB` cap. Raise it if intended. |
| HEIC fails: `HEIC needs a decoder` | Native Linux without libheif: install `libheif-examples`. Windows: use Docker. |
| No "Apple hardware" option | Only on native macOS. Docker and Linux use the CPU encoder, as expected. |
| Very slow video on Linux ARM | Using the bundled generic ffmpeg. Set `FFMPEG_PATH`/`FFPROBE_PATH` to the system ffmpeg, or use the Docker image. |
| Several instances lose uploads or jobs | `QUEUE=memory` keeps state per process. Set `QUEUE=redis` + `REDIS_URL` (and `STORAGE=s3` across hosts). |
| `401 Authentication required` from scripts | Pass `-u user:pass` or `Authorization: Bearer $AUTH_TOKEN`. |
| Forgot the generated password | `docker logs … \| grep Login`, or read `WORK_DIR/auth.json`. Or set `AUTH_PASSWORD` and restart. |
| `429` on login | 10 failed attempts from that address; wait 15 minutes. Behind a proxy without `TRUST_PROXY`, everyone shares the proxy's address. |
| `ROLE=web needs a shared queue` | Set `QUEUE=redis` and `REDIS_URL`. |
| Jobs stay "queued" with `ROLE=web` | No worker is running, or workers point at a different `REDIS_URL`/`REDIS_PREFIX`. |
| No PDF tab | Ghostscript is missing (native: install it; Docker: the image was built with `GHOSTSCRIPT=false`). |
| "Compress on: This browser" missing | The page isn't on HTTPS or localhost, or the browser lacks WebCodecs. |

## Rules

- Don't turn login off on a reachable server. Don't change a shared bucket's CORS or lifecycle rules without telling the user.
- Mention licensing when the user redistributes the image (ships it to customers, or pushes it to a public registry). The image contains GPL (FFmpeg), AGPL (Ghostscript) and LGPL (libvips, libheif) binaries; see `THIRD_PARTY_NOTICES.md`.
- Never delete Docker volumes, buckets or objects outside `S3_PREFIX` unless the user explicitly asks.
- Put credentials in `.env` or a secret store, never in committed files or command lines that get logged.
- After any change, run the checks in section 8 and report what you verified.
