# AGENTS.md

This file is for AI coding agents that **work on this repository**.

- To *use* the tool to compress files, read [skills/compress-media/SKILL.md](skills/compress-media/SKILL.md).
- To *deploy or operate* a server, read [skills/compress-media-deploy/SKILL.md](skills/compress-media-deploy/SKILL.md).
- For a map of all the docs, see [llms.txt](llms.txt).

## What this is

Compress Media is a self-hosted compressor for video, images and audio.

- Node.js 20+ and CommonJS.
- ffmpeg handles video and audio, sharp handles images.
- There are three front ends over one pipeline: a web UI, an HTTP API and a CLI.
- There is no build step and no framework.

```
lib/media.js     the pipeline: detectKind, detectCapabilities (caps), probe, compress({ kind, input, options, outputPath, … })
lib/storage.js   STORAGE=local|s3 backends: chunked upload lifecycle, where results live, contentDisposition
server.js        Express app: chunked upload → in-memory job queue → lib/media → download. Exports { app, start }.
bin/cli.js       CLI: compress / probe / info / serve. Exports { main, buildOptions }.
public/          UI: index.html (English text + data-i18n keys), app.js, i18n.js (translations), app.css
test/            node:test — smoke.test.js (HTTP API), cli.test.js (CLI)
e2e/             Playwright specs (Chromium, Firefox, WebKit) + global-setup that generates fixtures
examples/        API clients: compress.sh (bash+curl+jq), compress.mjs (Node) — both storage modes
docs/            cli.md, api.md, configuration.md, deployment.md (reference docs, English)
skills/          compress-media (use the tool) · compress-media-deploy (run the server) — self-contained
README.md        overview + quick starts; README.vi.md is a full Vietnamese translation of it
DOCKERHUB.md     Docker Hub page, synced by the release workflow
llms.txt         index of the docs for LLMs
docker-compose*.yml   published image / build from source / app + SeaweedFS (S3 demo)
```

## Commands

```bash
npm install
npm run dev                  # web UI on http://localhost:4747 (restarts on change)
node bin/cli.js --help       # CLI
npm test                     # API + CLI tests (~30 s)
npm run test:e2e             # Playwright on 3 browsers (~2–5 min); first time: npx playwright install chromium firefox webkit
npx playwright test --project=chromium -g "cancel"   # a focused E2E run
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build   # local image on 127.0.0.1:4747
# (plain `docker compose up` pulls runsnip/compress-media from Docker Hub; releases: push a vX.Y.Z tag)
```

**Done means:**

- `npm test` passes.
- `npm run test:e2e` passes, at least `--project=chromium` for UI changes.
- New behaviour has a test:
  - pipeline or CLI changes → `test/`;
  - anything a user clicks or sees → `e2e/`.

## Architecture rules

- **One pipeline.** Encoding logic lives only in `lib/media.js`. The server and the CLI adapt their inputs to `compress(task)`. Never add ffmpeg arguments in `server.js` or `bin/cli.js`.
- **Option shapes are shared.**
  - The per-kind option objects (`video: { quality, targetMB, codec, encoder, speed, resolution, fps, audio }`, `image: {…}`, `audio: {…}`) are used by the UI, the API and the CLI. The CLI maps its flags onto them in `buildOptions()`.
  - Adding an option means updating `lib/media.js`, the UI (`index.html` + `app.js` defaults + `i18n.js`), `buildOptions` and `HELP` in the CLI, `skills/compress-media/*.md`, and the tests.
- **Platform differences go through `caps`** (`hardwareEncoder`, `heicDecoder`).
  - The UI hides unsupported options with `data-requires="<cap>"`.
  - `lib/media.js` silently falls back: `--hw` without VideoToolbox → CPU.
- **Jobs are cancellable at any point.**
  - Every run gets a token (`job.run`), and stale runs must not touch job state (`isCancelled`, `stale()`).
  - Outputs are per run: `outputs/<jobId>-<run>.<ext>`.
  - The CLI writes `<name>.partial.<ext>` and renames it at the end.
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

  | When you change… | Also update |
  |---|---|
  | a CLI flag or command | `bin/cli.js` HELP, `docs/cli.md`, `skills/compress-media/SKILL.md` + `reference.md` (flag → API table), `test/cli.test.js` |
  | an option field | `docs/api.md` (Options), `skills/compress-media/reference.md`, the UI, the CLI mapping |
  | an endpoint or response | `docs/api.md`, `skills/compress-media/reference.md`, `examples/`, `test/smoke.test.js` |
  | an environment variable | `docs/configuration.md`, `.env.example`, `docker-compose*.yml`, `skills/compress-media-deploy/SKILL.md`, README config table (both languages) |
  | anything in README.md | the same section in README.vi.md |

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
  - SeaweedFS ignores `response-content-disposition`, so `Content-Disposition` is also stored on the object.
  - Some stores keep both copies when a part number is re-uploaded, which breaks CompleteMultipartUpload. Don't design flows that re-send a part that already succeeded.
  - Browsers need bucket CORS for PUT (`S3_SETUP_CORS`, startup check with `PUBLIC_URL`).
- **Downloads may redirect cross-origin** (to a presigned bucket URL). "Download all" therefore uses one hidden iframe per file, because successive anchor clicks cancel each other.
- **Test S3 mode locally** with any S3-compatible container. `docker compose -f docker-compose.s3.yml up -d` starts the app with SeaweedFS (MinIO no longer publishes community images). Run `STORAGE=s3 S3_… npm test`, and run `E2E_BASE_URL=… npx playwright test` against a server started with those variables. Use `UPLOAD_PART_MB` ≥ 5 in S3 mode.
- **Docker Desktop disk**: when the VM disk is full, containers fail with `ENOSPC`, and S3 test servers report "no free space". Don't prune volumes you didn't create; ask the user.
- **E2E shares one server.**
  - The `page` fixture in `e2e/helpers.js` deletes the jobs each test created. This stops a failed test's ffmpeg from blocking the queue.
  - On a slow or loaded machine, set `E2E_JOB_TIMEOUT=300000`.

## Style

- 2-space indent, semicolons, single quotes, `'use strict'` in CommonJS files.
- Comments explain *why*. Match the density of the surrounding code.
- Error messages are user-facing English sentences. The API returns them as `{ error }`, and the CLI prints them after `compress-media: `.
