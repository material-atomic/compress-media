# Compress Media

A self-hosted compressor for **videos, images and audio**. It has a drag-and-drop web UI, an HTTP API and a CLI, and is built on ffmpeg and sharp. Your files stay on your own machine.

It is made for huge QuickTime screen recordings: a 2880×1800, 60 fps recording typically comes out **90–98% smaller**.

Made by [RunSnip](https://runsnip.com) · [Source on GitHub](https://github.com/material-atomic/compress-media) · [Report an issue](https://github.com/material-atomic/compress-media/issues)

## Run the web UI

```bash
docker run -d --name compress-media -p 127.0.0.1:4747:4747 runsnip/compress-media
```

Then open **http://localhost:4747**.

The port above is only reachable from this machine. Use `-p 4747:4747` to open it to your network. There is **no authentication**, so only do that on a trusted network or behind a proxy with auth.

With Docker Compose:

```yaml
services:
  compress-media:
    image: runsnip/compress-media:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:4747:4747"
    volumes:
      - media-data:/data
volumes:
  media-data:
```

## Use the CLI (no server)

```bash
docker run --rm -v "$PWD:/work" -w /work runsnip/compress-media \
  compress-media "Screen Recording.mov" --max-res 1080 --fps 30

docker run --rm -v "$PWD:/work" -w /work runsnip/compress-media \
  compress-media photos -r --image-format webp --max-dim 1920 -o web

docker run --rm runsnip/compress-media compress-media --help
```

- Results are written next to each input as `<name>-compressed.<ext>`.
- Add `--json` for a machine-readable report.
- On Linux, add `--user "$(id -u):$(id -g)"` so the results are owned by you.

## What it does

- **Video** (MOV, MP4, MKV, WebM, AVI…) → MP4.
  - H.264 or H.265.
  - Quality presets or a target size in MB.
  - Downscaling, frame-rate cap, and keeping, reducing or removing audio.
- **Images** (JPG, PNG, WebP, AVIF, **HEIC**, GIF, TIFF).
  - Keep the format or convert to JPEG, WebP, AVIF or PNG.
  - Resize, and strip EXIF/GPS.
  - Animated GIFs stay animated.
- **Audio** (WAV, M4A, FLAC, AIFF, MP3…) → MP3, M4A or Opus, with a bitrate setting and optional mono.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `JOB_TTL_HOURS` | `3` | Delete uploads and results after this many hours |
| `MAX_UPLOAD_MB` | `0` | Per-file upload limit (0 = unlimited) |
| `MEDIA_CONCURRENCY` | `1` | Parallel video/audio jobs |
| `IMAGE_CONCURRENCY` | `3` | Parallel image jobs |
| `PORT` | `4747` | Port inside the container |
| `UPLOAD_PART_MB` / `UPLOAD_CONCURRENCY` | `8` / `4` | Resumable, parallel part uploads |
| `STORAGE` | `local` | `s3`: browsers upload straight to an S3-compatible bucket (AWS S3, R2, GCS, MinIO, B2…) |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | Object storage settings (see the GitHub README) |

Uploads and results live in the `/data` volume. Give it room for your largest videos.

**Object storage:** with `STORAGE=s3`, browsers upload straight to the bucket through presigned URLs, and results are served from it. This works with AWS S3, Cloudflare R2, GCS, MinIO, SeaweedFS, B2, Spaces and Wasabi. The bucket needs a CORS rule for your site; `S3_SETUP_CORS=true` adds it. Set `PUBLIC_URL` so the server can check it at startup.

Source and full documentation: **[github.com/material-atomic/compress-media](https://github.com/material-atomic/compress-media)**: [configuration](https://github.com/material-atomic/compress-media/blob/main/docs/configuration.md) · [deployment](https://github.com/material-atomic/compress-media/blob/main/docs/deployment.md) · [HTTP API](https://github.com/material-atomic/compress-media/blob/main/docs/api.md) · [CLI](https://github.com/material-atomic/compress-media/blob/main/docs/cli.md)

## Tags and platforms

- `latest`, `1`, `1.1` and `1.1.0` follow semver (older releases keep their own tags, e.g. `1.0.0`).
- Images are built for `linux/amd64` and `linux/arm64` (Apple Silicon, Raspberry Pi 4/5, Graviton).

Hardware encoding (Apple VideoToolbox) is only available when running natively on macOS, not in Docker.

## License

The code is MIT licensed. The image contains ffmpeg with x264/x265 (GPL) and libheif (LGPL) from Alpine Linux.
