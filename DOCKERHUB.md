# Compress Media

A self-hosted compressor for **videos, images, audio and PDFs**, with a GIF maker and **subtitles from speech**. It has a drag-and-drop web UI, an HTTP API and a CLI, and is built on ffmpeg, sharp, Ghostscript and whisper.cpp. Your files stay on your own machine, and there's even an in-browser mode where they never leave the device.

It is made for huge QuickTime screen recordings: a 2880×1800, 60 fps recording typically comes out **90–98% smaller**.

Made by [RunSnip](https://runsnip.com) · [Source on GitHub](https://github.com/material-atomic/compress-media) · [Report an issue](https://github.com/material-atomic/compress-media/issues)

## Run the web UI

```bash
docker run -d --name compress-media -p 127.0.0.1:4747:4747 -v compress-media-data:/data \
  -e AUTH_USERNAME=me@example.com -e AUTH_PASSWORD='choose-a-password' runsnip/compress-media
```

Then open **http://localhost:4747** and sign in. Without `AUTH_PASSWORD`, a password is generated: `docker logs compress-media | grep Login`.

The port above is only reachable from this machine. Use `-p 4747:4747` to open it to your network, and put HTTPS in front with a reverse proxy when it's public.

With Docker Compose:

```yaml
services:
  compress-media:
    image: runsnip/compress-media:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:4747:4747"
    environment:
      AUTH_USERNAME: me@example.com
      AUTH_PASSWORD: choose-a-password
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

docker run --rm -v "$PWD:/work" -v compress-media-data:/data -w /work runsnip/compress-media \
  compress-media subtitles talk.mov --lang vi          # → talk.vi.srt; the /data volume keeps the speech model

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
- **PDF** → smaller PDF (72–300 dpi image presets, optional grayscale).
- **Animations from still images** (GIF maker): 2–1000 screenshots or photos → one animated GIF, animated WebP or MP4, in the web UI ("Make an animation"), the CLI (`compress-media animate shot-*.png -o demo.gif`) or the API (`POST /api/animations`).
- **Subtitles**: speech in a video or audio file → an SRT or WebVTT file with times and text (whisper.cpp; language detected or chosen, optional translation to English), e.g. for YouTube Studio. Or subtitles added to the video as a selectable track, or burned into the picture for TikTok and Reels. Your own `.srt`/`.vtt` works too. Web UI "Subtitles", CLI `compress-media subtitles`, API `POST /api/subtitles`.
- **Video extras**
  - Trim.
  - WebM (VP9/AV1), AV1 in MP4, and animated GIF.
  - Two-pass target size.
  - GPU encoding (`--device /dev/dri` for VA-API on Intel/AMD; NVENC and Quick Sync need a different ffmpeg build via `FFMPEG_PATH`).
- Login, ZIP downloads, live progress (SSE), signed webhooks, and a Redis queue with separate workers (`ROLE=web|worker`).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `JOB_TTL_HOURS` | `3` | Delete uploads and results after this many hours |
| `MAX_UPLOAD_MB` | `0` | Per-file upload limit (0 = unlimited) |
| `MEDIA_CONCURRENCY` | `1` | Parallel video/audio jobs |
| `IMAGE_CONCURRENCY` | `3` | Parallel image jobs |
| `PORT` | `4747` | Port inside the container |
| `AUTH_USERNAME` / `AUTH_PASSWORD` / `AUTH_TOKEN` | `admin` / generated / — | Login; `AUTH_ENABLED=false` turns it off |
| `QUEUE` / `REDIS_URL` / `ROLE` | `memory` / — / `all` | Shared queue and separate web/worker containers |
| `UPLOAD_PART_MB` / `UPLOAD_CONCURRENCY` | `8` / `4` | Resumable, parallel part uploads |
| `STORAGE` | `local` | `s3`: browsers upload straight to an S3-compatible bucket (AWS S3, R2, GCS, MinIO, B2…) |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | Object storage settings (see the GitHub README) |
| `WHISPER_MODEL` | `small` | Speech model for subtitles: `tiny` (75 MB), `base` (142 MB), `small` (466 MB), `medium` (1.5 GB), `large-v3-turbo` (547 MB, most accurate) |
| `WHISPER_DOWNLOAD` | `true` | `false` never downloads models (servers without internet: copy the `ggml-*.bin` files into `/data/models`) |

Uploads and results live in the `/data` volume. Give it room for your largest videos. It also keeps the speech models in `/data/models`: they are **not** in the image, but downloaded once from Hugging Face the first time subtitles are made.

**Object storage:** with `STORAGE=s3`, browsers upload straight to the bucket through presigned URLs, and results are served from it. This works with AWS S3, Cloudflare R2, GCS, MinIO, SeaweedFS, B2, Spaces and Wasabi. The bucket needs a CORS rule for your site; `S3_SETUP_CORS=true` adds it. Set `PUBLIC_URL` so the server can check it at startup.

Source and full documentation: **[github.com/material-atomic/compress-media](https://github.com/material-atomic/compress-media)**: [configuration](https://github.com/material-atomic/compress-media/blob/main/docs/configuration.md) · [deployment](https://github.com/material-atomic/compress-media/blob/main/docs/deployment.md) · [HTTP API](https://github.com/material-atomic/compress-media/blob/main/docs/api.md) · [CLI](https://github.com/material-atomic/compress-media/blob/main/docs/cli.md)

## Tags and platforms

- `latest`, `2`, `2.1` and `2.1.0` follow semver; older releases keep their own tags (e.g. `1.1.0`).
- **`-nopdf` variants** (`latest-nopdf`, `2.1.0-nopdf`, …) leave out Ghostscript (AGPL-3.0) and PDF support. They're about 100 MB smaller, for organisations that don't allow AGPL software.
- Images are built for `linux/amd64` and `linux/arm64` (Apple Silicon, Raspberry Pi 4/5, Graviton).

Hardware encoding (Apple VideoToolbox) is only available when running natively on macOS, not in Docker.

## License

The code is MIT licensed. The image also contains, from Alpine Linux:

- FFmpeg with x264/x265 (**GPL**), run as a separate program;
- Ghostscript (**AGPL-3.0**), for PDF;
- libheif (LGPL);
- libvips through sharp (LGPL-3.0);
- whisper.cpp (MIT), for subtitles, and DejaVu fonts (free license), for burned-in text.

These keep their own licenses, which apply if you redistribute the image. Sources are at pkgs.alpinelinux.org. The `-nopdf` tags have no Ghostscript (they do include whisper.cpp). The speech models (MIT) are downloaded at runtime and aren't part of the image. Details: `THIRD_PARTY_NOTICES.md` in the repository and at `/app/THIRD_PARTY_NOTICES.md` in the image.
