# Deployment

| You want… | Use |
|---|---|
| Compress your own files on a Mac, as fast as possible | [Native on macOS](#native-macos-or-linux) (Apple hardware encoder) |
| A private tool on a PC, NAS or home server | [Docker](#docker) or [Docker Compose](#docker-compose) |
| A shared service for a team or the public | [Docker](#docker) + a [reverse proxy with auth](#reverse-proxy) + [object storage](#object-storage) |
| Batch jobs in scripts or CI | The [CLI](cli.md), directly or through the Docker image |
| Many users, or heavy video work | [Scaling out](#scaling-out) with Redis and separate workers |

## Native (macOS or Linux)

Requires Node.js 20+.

```bash
git clone https://github.com/material-atomic/compress-media.git && cd compress-media
npm install
npm start                       # http://localhost:4747
```

- macOS gets the **VideoToolbox hardware encoder** and HEIC support (`sips`) automatically.
- On Linux, install `libheif-examples` (Debian/Ubuntu) or `libheif-tools` (Alpine/Fedora) for HEIC.
- On Linux ARM, use the distribution's ffmpeg: `FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe npm start`.
- Windows x64 works too. For HEIC or Windows on ARM, use Docker.

To keep it running in the background on macOS, run `npm start` in a terminal tab, or use a process manager such as `pm2 start server.js --name compress-media`.

## Login

Login is **on by default**. The first time the server starts without `AUTH_PASSWORD`, it generates a password and prints it:

```
  Login: admin / 3vQk…   (generated; set AUTH_PASSWORD, or see /data/auth.json)
```

- Set your own with `AUTH_USERNAME` (a username or an email) and `AUTH_PASSWORD`.
- Give scripts an `AUTH_TOKEN`.
- Behind a reverse proxy, set `TRUST_PROXY=1` so the login rate limit sees real client addresses.
- `AUTH_ENABLED=false` turns login off: use it only on a trusted network or behind a proxy that already authenticates.

## Docker

Images for `linux/amd64` and `linux/arm64` are published as [`runsnip/compress-media`](https://hub.docker.com/r/runsnip/compress-media). Releases built by CI also go to GitHub Container Registry as `ghcr.io/material-atomic/compress-media`.

```bash
docker run -d --name compress-media --restart unless-stopped \
  -p 127.0.0.1:4747:4747 \
  -v compress-media-data:/data \
  runsnip/compress-media
```

- `-p 127.0.0.1:4747:4747` keeps it private to this machine. Use `-p 4747:4747` only on a trusted network or behind a proxy.
- `/data` holds uploads and results. Give it room for your largest video plus its output.
- Pass settings with `-e`, e.g. `-e JOB_TTL_HOURS=1 -e MAX_UPLOAD_MB=4096`. The full list is in [configuration.md](configuration.md).
- Update with `docker pull runsnip/compress-media && docker rm -f compress-media`, then run the command above again.
- Health check: `GET /api/health`. The image has a `HEALTHCHECK` built in.
- Login: `docker logs compress-media | grep Login` shows the generated password. Set `-e AUTH_USERNAME=… -e AUTH_PASSWORD=…` to choose your own.
- **Without Ghostscript (AGPL):** use the `-nopdf` tags (`runsnip/compress-media:latest-nopdf`, `2.0.0-nopdf`, …), or build with `--build-arg GHOSTSCRIPT=false`. PDF compression is then unavailable, and everything else works. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

### GPU encoding in Docker

The encoder is detected at startup, and `docker logs` shows `Hardware encoder: …`. Give the container the GPU:

| GPU | `docker run` flags |
|---|---|
| Intel / AMD (VA-API) | `--device /dev/dri` (optionally `-e HW_ENCODER=vaapi`). The image's ffmpeg has VA-API encoders for H.264, H.265 and AV1; Quick Sync (`qsv`) needs a different ffmpeg build. |
| NVIDIA (NVENC) | `--gpus all -e NVIDIA_DRIVER_CAPABILITIES=compute,video,utility` (needs the NVIDIA Container Toolkit, and an ffmpeg build with NVENC. Alpine's package may not include it; set `FFMPEG_PATH` to one that does.) |

Apple's VideoToolbox is only available when running natively on macOS, not in Docker. Hardware encoders are not used for "target MB" (they miss bitrate targets) or for WebM/GIF.

## Docker Compose

| File | What it runs |
|---|---|
| [`docker-compose.yml`](../docker-compose.yml) | The published image, local disk storage, settings from `.env` |
| [`docker-compose.build.yml`](../docker-compose.build.yml) | Override that builds the image from this checkout |
| [`docker-compose.s3.yml`](../docker-compose.s3.yml) | The app + SeaweedFS, to try object-storage mode locally |
| [`docker-compose.scale.yml`](../docker-compose.scale.yml) | A web server + 2 workers + Redis ([scaling out](#scaling-out)) |

```bash
cp .env.example .env            # optional: edit settings
docker compose up -d            # published image
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build   # from source
docker compose -f docker-compose.s3.yml up -d                                     # object storage demo
```

## Reverse proxy

The app has **no login**. Before exposing it beyond your machine, put it behind a proxy that adds authentication and TLS. Uploads arrive as parts of `UPLOAD_PART_MB` (8 MB by default), so the proxy's request-size limit only needs to be a little above that. The long single-request uploads that proxies usually choke on never happen.

**Caddy** (automatic HTTPS):

```caddyfile
media.example.com {
	basic_auth {
		# user  <hash from: caddy hash-password --plaintext 'your-password'>
		team $2a$14$...
	}
	reverse_proxy compress-media:4747
}
```

**nginx:**

```nginx
server {
  listen 443 ssl;
  server_name media.example.com;
  # ssl_certificate …; ssl_certificate_key …;

  auth_basic "Compress Media";
  auth_basic_user_file /etc/nginx/htpasswd;

  client_max_body_size 16m;       # > UPLOAD_PART_MB; raise it if you use single-request POST /api/jobs
  proxy_request_buffering off;

  location / {
    proxy_pass http://127.0.0.1:4747;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;      # completing a large upload in S3 mode can take a moment
  }
}
```

**Cloudflare:** the free plan limits request bodies to 100 MB. Keep `UPLOAD_PART_MB` under that; the default 8 is fine.

Set `PUBLIC_URL=https://media.example.com` so the server can check bucket CORS for that origin, and `TRUST_PROXY=1` so the login rate limit sees real client addresses.

**HTTPS matters for "Compress on: This browser".** Browsers only allow WebCodecs on `https://` pages and on `localhost`. Over plain HTTP on a LAN address the option is simply hidden.

## Object storage

With `STORAGE=s3`, the browser uploads parts **directly to a bucket** using presigned URLs. The app server never carries upload traffic: it starts the multipart upload, signs URLs, and completes it. Results are uploaded to the bucket and downloaded from it through presigned URLs. ffmpeg still works on a local copy in `WORK_DIR` while a job runs.

### Providers

Any S3-compatible service works. Tested with SeaweedFS; the configuration follows the standard S3 multipart rules shared by all of these.

**AWS S3**

```env
STORAGE=s3
S3_BUCKET=my-compress-media
S3_REGION=eu-central-1
S3_ACCESS_KEY_ID=AKIA…            # or leave unset to use an IAM role
S3_SECRET_ACCESS_KEY=…
PUBLIC_URL=https://media.example.com
```

**Cloudflare R2** (no egress fees, a good fit for downloads)

```env
STORAGE=s3
S3_BUCKET=compress-media
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=…                # R2 API token → S3 credentials
S3_SECRET_ACCESS_KEY=…
PUBLIC_URL=https://media.example.com
```

**Google Cloud Storage** (XML API with HMAC keys: *Cloud Storage → Settings → Interoperability*)

```env
STORAGE=s3
S3_BUCKET=my-compress-media
S3_REGION=auto
S3_ENDPOINT=https://storage.googleapis.com
S3_ACCESS_KEY_ID=GOOG…
S3_SECRET_ACCESS_KEY=…
```

GCS CORS can't be set through the S3 API, so `S3_SETUP_CORS` won't work there. Set it with `gcloud storage buckets update gs://BUCKET --cors-file=cors.json` instead.

**Backblaze B2 · DigitalOcean Spaces · Wasabi**

```env
STORAGE=s3
S3_BUCKET=compress-media
S3_REGION=us-west-004                          # the bucket's region
S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com   # Spaces: https://<region>.digitaloceanspaces.com · Wasabi: https://s3.<region>.wasabisys.com
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
```

**MinIO, SeaweedFS, Garage and other self-hosted stores**

```env
STORAGE=s3
S3_BUCKET=compress-media
S3_ENDPOINT=http://minio:9000                  # how the app reaches it
S3_PUBLIC_ENDPOINT=https://s3.example.com      # how browsers reach it, if different
S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
```

Azure Blob Storage has no S3 API and isn't supported.

### CORS (required)

Browsers PUT parts to the bucket from your app's origin, so the bucket must allow it. Either start once with `S3_SETUP_CORS=true`, which adds the rule and keeps existing ones, or add it yourself:

```json
[
  {
    "AllowedOrigins": ["https://media.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

```bash
aws s3api put-bucket-cors --bucket BUCKET --cors-configuration '{"CORSRules": <the array above>}'   # AWS, R2, B2, MinIO… (add --endpoint-url for non-AWS)
```

With `PUBLIC_URL` set, the server sends a CORS preflight to the bucket at startup and prints a **WARNING** if browsers would be blocked.

### Lifecycle rule (recommended)

The app deletes its objects after `JOB_TTL_HOURS`. A bucket lifecycle rule is a safety net for anything a crash leaves behind:

```json
{
  "Rules": [
    {
      "ID": "compress-media-cleanup",
      "Filter": { "Prefix": "compress-media/" },
      "Status": "Enabled",
      "Expiration": { "Days": 1 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration --bucket BUCKET --lifecycle-configuration file://lifecycle.json
```

### Permissions

Give the app credentials scoped to one bucket (or prefix):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": "arn:aws:s3:::BUCKET/compress-media/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketCORS", "s3:PutBucketCORS"],
      "Resource": "arn:aws:s3:::BUCKET"
    }
  ]
}
```

`s3:PutBucketCORS` is only needed with `S3_SETUP_CORS=true`. Browsers never receive credentials, only presigned URLs that expire after `S3_URL_EXPIRES`.

## Scaling out

One instance handles many users well. Uploads are parts of a few MB, so connections stay short, and with object storage upload bandwidth never touches the server. **Encoding is CPU-bound**, so heavy video work is what needs more machines.

Set `QUEUE=redis` and the job queue, job records and in-progress uploads move to Redis (BullMQ):

- **Web servers** (`ROLE=web`) accept uploads and serve the UI and API. Run several behind a load balancer; no sticky sessions are needed. Give them the same `AUTH_SECRET` (or a shared `WORK_DIR`) so a session works on any of them.
- **Workers** (`ROLE=worker`, or `compress-media worker`) take jobs from the queue. Add as many as you need. Each runs `MEDIA_CONCURRENCY` video/audio/PDF jobs and `IMAGE_CONCURRENCY` image jobs at a time.
- **Files must be visible to every machine.** Use `STORAGE=s3`: inputs stay in the bucket until a worker fetches them, and results go back to the bucket. On a single host, a shared volume for `WORK_DIR` also works.

The quickest start on one host is [`docker-compose.scale.yml`](../docker-compose.scale.yml):

```bash
docker compose -f docker-compose.scale.yml up -d
docker compose -f docker-compose.scale.yml up -d --scale worker=4   # more workers
```

More details:

- **Cancelling and redoing** work across machines. A worker notices within about a second that its run was cancelled, and stops ffmpeg.
- **Expiry:** one web instance at a time (guarded by a Redis lock) sweeps expired jobs and abandoned uploads every 10 minutes.
- **Disk:** each worker needs room in its `WORK_DIR` for the input and output of the jobs it's running.
- **Crashed workers:** if a worker dies mid-job, BullMQ notices after about a minute and hands the job to another worker, once. If that attempt fails too, the job stays "processing" until you redo it (UI, or `POST /api/jobs/:id/retry`) or it expires.
