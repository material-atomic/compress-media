# Changelog

All notable changes to Compress Media, the self-hosted compressor for video, images, audio and PDF.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

Docker images: [`runsnip/compress-media`](https://hub.docker.com/r/runsnip/compress-media) and `ghcr.io/material-atomic/compress-media`, with the same tags (`X.Y.Z`, `X.Y`, `X`, `latest`, and `-nopdf` variants since 2.0.0).

## [2.1.0] — 2026-09-27

### Added

- **Make an animation (GIF maker).** Turn 2–1000 still images (JPG, PNG, WebP, HEIC…) into one animated **GIF**, animated **WebP** or **MP4**.
  - Web UI: a "Make an animation" mode with a frame strip. Reorder frames by dragging or with ← →, then pick the format, time per frame, loop count, size, fit (borders or crop), border colour and quality. Redo re-makes it with new settings.
  - CLI: `compress-media animate <images|folder> [--format gif|webp|mp4] [--delay ms | --fps n] [--loop n] [--max-dim px] [--fit contain|cover] [--background hex] [--quality 1-100] [-o file]`. Folders are sorted by name with numbers in order (`shot-2` before `shot-10`).
  - HTTP API: `POST /api/animations`, taking multipart frames or chunked upload ids. `GET /api/config` reports `animationMaxFrames`.
- **Subtitles.** Turn the speech in a video or audio file into subtitles with times and text (**SRT** or **WebVTT**), ready to upload to YouTube, using [whisper.cpp](https://github.com/ggml-org/whisper.cpp) on your own server. Or put subtitles into the video.
  - Speech recognition in about 100 languages, including Vietnamese: the language is detected automatically or chosen, and you can translate the subtitles into English. There are five speech models, from `tiny` (75 MB) to `large-v3-turbo` (547 MB); each is downloaded once, on first use. Silence and music are skipped.
  - Subtitles are split into readable cues of at most two lines.
  - Add subtitles to a video as a **track** viewers can turn on (no re-encode), or **burn them into the picture** for TikTok, Reels and other apps that ignore subtitle tracks.
  - Use your own `.srt`/`.vtt` instead of speech recognition.
  - Web UI: a "Subtitles" mode. Drop a video, or a video plus its `.srt` with the same name. **View & edit** shows the video with its subtitles next to an editor; Save makes the result again from your text. Redo switches between SRT, VTT, track and burn-in without listening again.
  - CLI: `compress-media subtitles <video|folder> [--lang vi] [--translate] [--model small] [--format srt|vtt] [--embed none|track|burn] [--font-size …] [--srt file]`.
  - HTTP API: `POST /api/subtitles` and `GET /api/jobs/:id/subtitles?format=srt|vtt`. Jobs report a `stage` (`model`, `transcribe`, `embed`).
  - Configuration: `WHISPER_MODEL`, `WHISPER_MODELS_DIR`, `WHISPER_DOWNLOAD` (off for servers without internet access), `WHISPER_MODEL_URL`, `WHISPER_PATH`, `WHISPER_THREADS`.

### Changed

- The mode switch (Compress files, Make an animation, Subtitles) sits at the top of the page, above the settings and the file list.
- The Docker image includes whisper.cpp and the DejaVu fonts (about 100 MB more; `--build-arg WHISPER=false` leaves whisper.cpp out). Speech models are kept in `/data/models`, on the data volume.

### Fixed

- Animated GIF or WebP input is no longer reduced to its first frame when the chosen image format can't animate. AVIF output becomes animated WebP, and JPEG/PNG output stays GIF. The result says so in the UI, the CLI report and `info.note`.

## [2.0.0] — 2026-09-27

### Breaking

- **Login is required by default.** Set `AUTH_USERNAME` (a username or email) and `AUTH_PASSWORD`, or turn login off with `AUTH_ENABLED=false`. Without a password, one is generated and kept across restarts. Scripts sign in with HTTP Basic or a bearer token (`AUTH_TOKEN`).

### Added

- Built-in login: signed session cookies, HTTP Basic, bearer token, and a rate limit on failed attempts.
- Video:
  - trim to a start and end time;
  - **WebM** (VP9 or AV1 + Opus) and **AV1** in MP4;
  - **video to animated GIF**;
  - two-pass encoding for a target size in MB;
  - GPU encoders detected at startup: NVIDIA NVENC, Intel Quick Sync, VA-API and AMD AMF, next to Apple VideoToolbox.
- **PDF compression** with Ghostscript, with presets from "smallest" to "prepress". Ghostscript is included in the default image; `-nopdf` images leave it out.
- **Compress in the browser.** An optional mode using WebCodecs (Mediabunny), where files never leave the device. Anything the browser can't do falls back to the server, with a note.
- Download all results as one **ZIP**.
- Integrations:
  - live progress over **Server-Sent Events**;
  - **webhooks** signed with HMAC, with retries and SSRF protection;
  - batch status for many jobs in one call.
- **Scale out**: an optional Redis/BullMQ queue (`QUEUE=redis`), `ROLE=web|worker`, and a `compress-media worker` command.
- With object storage, inputs stay in the bucket, so workers on other hosts can fetch them.
- JSDoc types checked with `tsc` (`npm run typecheck`).
- `THIRD_PARTY_NOTICES.md`, and OCI license labels on the images (FFmpeg GPL, Ghostscript AGPL, libvips LGPL, Mediabunny MPL).

### Fixed

- AVIF input was detected as HEIF.

## [1.1.0] — 2026-09-27

### Added

- **Chunked, resumable uploads**, modelled on S3 multipart uploads, for files of several GB. The part size (`UPLOAD_PART_MB`) and parallelism (`UPLOAD_CONCURRENCY`) are configurable, and interrupted uploads resume after a reload.
- **Object storage**: `STORAGE=s3` works with any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, SeaweedFS…). Browsers upload straight to the bucket with presigned URLs. There is a CORS check at startup, and `S3_SETUP_CORS` can set it up.

## 1.0.0 — 2026-09-27

First public release.

- Web UI in English and Vietnamese: drag and drop, presets, before/after preview, redo with new settings, cancel, and download all.
- Video (MOV, MP4, MKV…) to H.264/H.265 MP4; images (JPG, PNG, HEIC, WebP, AVIF, GIF) to JPEG, WebP, AVIF or PNG; audio to MP3, M4A or Opus.
- CLI: `compress`, `probe`, `info` and `serve`, with a JSON report and folder mirroring.
- HTTP API for scripts and integrations.
- Docker image for `linux/amd64` and `linux/arm64`, and Docker Compose files.
- Docs for people (README, `docs/`) and for AI agents (`skills/`, `AGENTS.md`, `llms.txt`).
- Tests: node:test for the API and CLI, and Playwright end-to-end tests on Chromium, Firefox and WebKit.

[2.1.0]: https://github.com/material-atomic/compress-media/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/material-atomic/compress-media/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/material-atomic/compress-media/releases/tag/v1.1.0
