# AGENTS.md

This file is for AI coding agents that **work on this repository**.

- To *use* the tool to compress files, read [skills/compress-media/SKILL.md](skills/compress-media/SKILL.md).
- To *deploy or operate* a server, read [skills/compress-media-deploy/SKILL.md](skills/compress-media-deploy/SKILL.md).
- For a map of all the docs, see [llms.txt](llms.txt).

## What this is

Compress Media is a self-hosted compressor for video, images, audio and PDF, with a GIF maker and subtitles from speech.

- Node.js 20+ and CommonJS.
- ffmpeg handles video and audio, sharp handles images, Ghostscript handles PDF, whisper.cpp (`whisper-cli`) turns speech into subtitles.
- There are three front ends over one pipeline: a web UI, an HTTP API and a CLI.
- The web UI can also compress in the browser (WebCodecs through Mediabunny).
- There is no build step and no framework. Types are JSDoc checked by `tsc --noEmit` (`npm run typecheck`).

```
lib/types.d.ts   shared shapes: option objects, capabilities, CompressTask — referenced from JSDoc
lib/media.js     the engine: detectKind, detectCapabilities (caps), probe, pdfPages, compress({ kind, input, options, … }); kind 'animation' (compressAnimation) takes inputs[] frames; kind 'subtitles' (compressSubtitles) transcribes and/or embeds
lib/subtitles.js   SRT/WebVTT parse/format, readable cue splitting, whisper model download (ensureModel)
lib/jobs.js      job lifecycle: create, processJob (worker), cancel, retry, remove, sweep; run tokens; webhooks
lib/store.js     QUEUE=memory|redis: job/upload records, the queue (BullMQ), locks — one interface
lib/storage.js   STORAGE=local|s3: upload parts, inputs/outputs (put/fetch/open/remove), presigned URLs, CORS
lib/auth.js      built-in login: sessions, Basic, bearer token, rate limit, generated password
lib/webhook.js   webhook validation (SSRF guard) and signed delivery
server.js        Express app (ROLE=web|worker|all): uploads, jobs API, /api/animations, /api/subtitles, ZIP, SSE, /vendor/mediabunny.mjs
bin/cli.js       CLI: compress / probe / animate / subtitles / info / serve / worker. Exports { main, buildOptions }.
public/          UI: index.html (English + data-i18n keys), app.js, local.js (in-browser mode), i18n.js, app.css
test/            node:test — smoke.test.js (HTTP API), cli.test.js (CLI)
e2e/             Playwright specs (Chromium, Firefox, WebKit) + global-setup that generates fixtures
examples/        API clients: compress.sh (bash+curl+jq), compress.mjs (Node) — both storage modes, login via env
CHANGELOG.md     every release: Added / Fixed / Breaking; new work goes under [Unreleased]
THIRD_PARTY_NOTICES.md  licenses of FFmpeg (GPL), Ghostscript (AGPL), libvips (LGPL), Mediabunny (MPL), whisper.cpp + models (MIT)…
docs/            cli.md, api.md, configuration.md, deployment.md (reference docs, English)
skills/          compress-media (use the tool) · compress-media-deploy (run the server) — self-contained
README.md        overview + quick starts; README.vi.md is a full Vietnamese translation of it
DOCKERHUB.md     Docker Hub page, synced by the release workflow
llms.txt         index of the docs for LLMs
docker-compose*.yml   published image / build from source / app + SeaweedFS (S3 demo) / web + workers + Redis (scale)
```

## Commands

```bash
npm install
npm run dev                  # web UI on http://localhost:4747 (restarts on change)
node bin/cli.js --help       # CLI
npm run typecheck            # JSDoc types (tsc --noEmit)
npm test                     # API, CLI and login tests (~40 s); also: QUEUE=redis REDIS_URL=… npm test
npm run test:e2e             # Playwright on 3 browsers (~2–5 min); first time: npx playwright install chromium firefox webkit
npx playwright test --project=chromium -g "cancel"   # a focused E2E run
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build   # local image on 127.0.0.1:4747
# (plain `docker compose up` pulls runsnip/compress-media from Docker Hub; releases: push a vX.Y.Z tag)
```

**Done means:**

- `npm run typecheck` and `npm test` pass.
- `npm run test:e2e` passes, at least `--project=chromium` for UI changes.
- New behaviour has a test:
  - pipeline or CLI changes → `test/`;
  - anything a user clicks or sees → `e2e/`.

## Architecture rules

- **One pipeline.** Encoding logic lives only in `lib/media.js`. The server and the CLI adapt their inputs to `compress(task)`. Never add ffmpeg arguments in `server.js` or `bin/cli.js`.
- **Option shapes are shared.**
  - The per-kind option objects (`video: { quality, targetMB, codec, encoder, speed, resolution, fps, audio }`, `image: {…}`, `audio: {…}`, `animation: {…}`, `subtitles: {…}`) are used by the UI, the API and the CLI. The CLI maps its flags onto them in `buildOptions()` (animation and subtitles in `cmdAnimate` / `cmdSubtitles`).
  - Adding an option means updating `lib/media.js`, the UI (`index.html` + `app.js` defaults + `i18n.js`), `buildOptions` and `HELP` in the CLI, `skills/compress-media/*.md`, and the tests.
- **Platform differences go through `caps`** (`hardwareEncoder`, `heicDecoder`, `whisper`, `burnSubtitles`).
  - The UI hides unsupported options with `data-requires="<cap>"`.
  - `lib/media.js` silently falls back: `--hw` without VideoToolbox → CPU.
- **Jobs go through `lib/jobs.js` and `lib/store.js` only.** `server.js` never reads or writes records directly. Code must work with both stores: in Redis, a record is a JSON copy, not a shared object, so use `patchJob` rather than mutating.
- **Jobs are cancellable at any point, across processes.**
  - Every run has a number (`job.run`); cancel and retry bump it.
  - Workers write only with `patchJob(id, patch, run)`, which is a no-op once the run changed.
  - Workers watch the record (250 ms in memory, 1 s in Redis) and kill ffmpeg when their run is gone.
  - Outputs are per run: `outputs/<jobId>-<run>.<ext>`.
  - The CLI writes `<name>.partial.<ext>` and renames it at the end.
- **Login guards every `/api` route** except health and `/api/auth/*` (`setupAuth` must run before other routes). New endpoints are protected automatically; don't add exceptions without a reason.
- **Inputs may live in the bucket.** With `STORAGE=s3` a job has `inputKey`, not `inputPath`; workers `fetchInput` to a temp file. Never assume the web server's disk has the file.
- **Uploads are chunked and modelled on S3 multipart** (init → parts → complete).
  - `lib/storage.js` decides where the parts go. `local` means `PUT /api/uploads/:id/parts/:n` into a pre-sized file. `s3` means presigned bucket URLs, so the browser never sends file bytes to the server.
  - New storage behaviour goes behind that interface. `server.js` must not branch on the provider.
  - Keep part sizes S3-compatible: equal-sized except the last, at least 5 MiB, at most 10,000 parts. Presigned URLs must not carry SDK checksums (`requestChecksumCalculation: 'WHEN_REQUIRED'`).
  - `POST /api/jobs` (single request) stays for the CLI-less API and small files.
- **Never delete user data.**
  - The server only wipes `WORK_DIR/uploads` and `WORK_DIR/outputs`, never `WORK_DIR` itself.
  - The CLI never writes over an input, and never over an existing output without `--overwrite`.
- **UI strings.**
  - English goes in the HTML with `data-i18n="key"`.
  - Runtime strings use `t('key', vars)` and need an entry in every language in `public/i18n.js`.
- **Frontend** is plain browser JS with no build and no dependencies. Keep it that way.
- **Docs are part of the change.** They are written for other people, so they must match the code exactly.
- **README describes the current version and what's planned, nothing else.** Release history ("New in X", upgrade notes) goes in `CHANGELOG.md` only; planned work goes in the README's "Planned for …" section, and moves out of it when it ships.

  | When you change… | Also update |
  |---|---|
  | a CLI flag or command | `bin/cli.js` HELP, `docs/cli.md`, `skills/compress-media/SKILL.md` + `reference.md` (flag → API table), `test/cli.test.js` |
  | an option field | `docs/api.md` (Options), `skills/compress-media/reference.md`, the UI, the CLI mapping |
  | an endpoint or response | `docs/api.md`, `skills/compress-media/reference.md`, `examples/`, `test/smoke.test.js` |
  | an environment variable | `docs/configuration.md`, `.env.example`, `docker-compose*.yml`, `skills/compress-media-deploy/SKILL.md`, README config table (both languages) |
  | anything in README.md | the same section in README.vi.md |
  | anything a user or integrator would notice | `CHANGELOG.md` under `[Unreleased]` |
  | a dependency or bundled binary | `THIRD_PARTY_NOTICES.md` (license, how it's used), README license table (both languages) |

  Examples in docs are meant to be run: after editing one, run it.

## Gotchas (each of these was a real bug)

- **Don't rebuild row buttons on every progress poll.**
  - `render()` runs every 800 ms.
  - If a button is replaced between mousedown and mouseup, the browser never fires the click, so "Cancel" silently fails.
  - Actions are keyed by `actions.dataset.key`; only re-create them when that key changes.
- **Cancelling during `probe`**: ffmpeg must not start after a cancel. `runFfmpeg` checks `isCancelled()` before it spawns.
- **Port check**: binding `127.0.0.1:PORT` succeeds even when another app holds `*:PORT` on IPv6. `start()` probes both addresses and refuses to start. Don't remove this.
- **ffmpeg binaries**:
  - `ffmpeg-static`'s Linux ARM64 build is 5–60× slower than a distro build. The Docker image uses Alpine's ffmpeg through `FFMPEG_PATH`/`FFPROBE_PATH` and installs with `--ignore-scripts`.
  - `@ffprobe-installer`'s Linux binaries ship without the exec bit, so `detectCapabilities()` chmods them.
- **HEIC**: sharp reads the HEIC header but can't decode the pixels. Decode through `sips` (macOS) or `heif-dec`/`heif-convert` (libheif), never sharp directly.
- **Tests**:
  - Don't use `execFileSync` while a server is running in the same process. Blocking the event loop lets keep-alive sockets go stale, and the next `fetch` fails with EPIPE.
  - On macOS, `os.tmpdir()` is behind the `/var` → `/private/var` symlink. Use `fs.realpathSync` when you compare paths.
- **npm scripts must work in cmd.exe**: no shell globs, so use `node --test` rather than `node --test test/*.js`.
- **S3 providers differ**:
  - SeaweedFS ignores `response-content-disposition`, and drops the stored `Content-Disposition` of multipart uploads (files over 5 MB). Output keys therefore end in the download name itself: `outputs/<job>/<run>/<name>`.
  - Some stores keep both copies when a part number is re-uploaded, which breaks CompleteMultipartUpload. Don't design flows that re-send a part that already succeeded.
  - Browsers need bucket CORS for PUT (`S3_SETUP_CORS`, startup check with `PUBLIC_URL`).
- **Downloads may redirect cross-origin** (to a presigned bucket URL). "Download all" is therefore one server-built ZIP (`/api/jobs/zip`), not many downloads, which cancelled each other.
- **In-browser mode (`public/local.js`)**:
  - WebCodecs exists only in secure contexts (HTTPS or localhost), and support differs by browser. For example, Firefox has no AAC encoder, Chromium no HEVC, and Safari's canvas can't encode WebP.
  - Anything unsupported must throw `LocalUnsupported` so the app falls back to the server with a note. Check with `canEncodeVideo`/`canEncodeAudio`; never assume.
  - Local jobs (`job.local`) never exist on the server, so exclude them from polling, ZIP and DELETE calls.
- **AV1 input in sharp** is reported as format `heif` with compression `av1`; map it to `avif` (the type checker caught this).
- **whisper.cpp** (subtitles):
  - `whisper-cli` prints its detected language and progress on stderr only without `-np`. Don't add `-np`: the detected language and the progress bar are read from those lines.
  - The `subtitles` ffmpeg filter runs with cwd set to a temp folder, so the file name needs no filter escaping. Keep it that way rather than escaping paths.
  - Models are downloaded on first use (`ensureModel`), never bundled into the repo or the image; `WHISPER_DOWNLOAD=false` must keep working offline.
- **Ghostscript** is AGPL: it must stay an external program (never linked or bundled into npm), and optional in the Docker image (`GHOSTSCRIPT` build arg).
- **Test S3 mode locally** with any S3-compatible container. `docker compose -f docker-compose.s3.yml up -d` starts the app with SeaweedFS (MinIO no longer publishes community images). Run `STORAGE=s3 S3_… npm test`, and run `E2E_BASE_URL=… npx playwright test` against a server started with those variables. Use `UPLOAD_PART_MB` ≥ 5 in S3 mode.
- **Docker Desktop disk**: when the VM disk is full, containers fail with `ENOSPC`, and S3 test servers report "no free space". Don't prune volumes you didn't create; ask the user.
- **E2E shares one server.**
  - The `page` fixture in `e2e/helpers.js` deletes the jobs each test created. This stops a failed test's ffmpeg from blocking the queue.
  - On a slow or loaded machine, set `E2E_JOB_TIMEOUT=300000`.

## Style

- 2-space indent, semicolons, single quotes, `'use strict'` in CommonJS files.
- Comments explain *why*. Match the density of the surrounding code.
- Error messages are user-facing English sentences. The API returns them as `{ error }`, and the CLI prints them after `compress-media: `.
