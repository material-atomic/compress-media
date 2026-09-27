# Contributing

Thanks for helping out! Issues and pull requests are welcome. If you use an AI agent, point it to [AGENTS.md](AGENTS.md).

## Setup

```bash
npm install
npm run dev      # http://localhost:4747, restarts when server.js changes
npm run typecheck   # JSDoc types
npm test         # API, CLI and login tests
npx playwright install chromium firefox webkit   # once
npm run test:e2e # browser E2E tests across Chromium, Firefox and WebKit
```

Useful Playwright flags: `--project=chromium` (one browser), `--ui` (interactive runner), `-g "cancel"` (filter by name). Failed runs leave a trace. Open it with `npx playwright show-report`.

To test object-storage mode (browsers uploading straight to a bucket), start an S3-compatible server and point the tests at it:

```bash
docker compose -f docker-compose.s3.yml up -d s3 bucket      # SeaweedFS on 127.0.0.1:8333 with a "compress-media" bucket
export STORAGE=s3 S3_BUCKET=compress-media S3_ENDPOINT=http://127.0.0.1:8333 S3_FORCE_PATH_STYLE=true \
       S3_ACCESS_KEY_ID=compress-media S3_SECRET_ACCESS_KEY=change-me-please S3_SETUP_CORS=true UPLOAD_PART_MB=5
npm test
PUBLIC_URL=http://127.0.0.1:4790 npx playwright test --project=chromium --workers=1
```

To test the shared queue, run a local Redis (`docker run -p 6379:6379 redis:7-alpine`, or `brew install redis`):

```bash
QUEUE=redis REDIS_URL=redis://localhost:6379 npm test
```

To check the Docker image:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
docker run --rm -v "$PWD/test:/app/test:ro" -e HOST=127.0.0.1 compress-media:local node --test test/smoke.test.js
```

### What CI runs

- **Pull requests** run everything: Node 20 and 22 on Linux, macOS and Windows, E2E in Chromium, Firefox and WebKit, object storage (SeaweedFS), the Redis queue with separate workers, and the Docker image.
- **Pushes to `main`** run a lighter set: Node 22 on Linux and Windows, E2E in Chromium.
- **Release tags** (`vX.Y.Z`) run the full set first; the images are only published if it passes.
- Changes that only touch documentation (`*.md`, `docs/`) don't run CI. To run the full set by hand: Actions → CI → Run workflow.

## Project layout

| Path | What it is |
|---|---|
| `lib/media.js` | The compression pipeline (ffmpeg, sharp, HEIC, capabilities), shared by the server and the CLI |
| `lib/types.d.ts` | Shared types for JSDoc (options, capabilities, tasks) |
| `lib/storage.js` | Storage backends (`local` disk, `s3` object storage) for chunked uploads, inputs and results |
| `lib/jobs.js`, `lib/store.js` | Job lifecycle; memory or Redis/BullMQ records and queue |
| `lib/auth.js`, `lib/webhook.js` | Login; webhook validation and delivery |
| `server.js` | Express API: uploads, jobs, ZIP, SSE; web and/or worker role |
| `bin/cli.js` | The `compress-media` command |
| `public/` | Web UI: `index.html` (English text + `data-i18n` keys), `app.js`, `local.js` (in-browser mode), `i18n.js`, `app.css` |
| `test/smoke.test.js` | HTTP API tests (also run in S3 mode with `STORAGE=s3 …`) |
| `test/cli.test.js` | CLI tests: flags, JSON report, folders, collisions, video formats, trim, PDF, exit codes |
| `test/auth.test.js` | Login: sessions, Basic/bearer, rate limit, generated password |
| `e2e/*.spec.js` | Playwright browser tests: uploads (retry, resume, reload), settings, downloads (checked with ffprobe/sharp), preview, cancel/redo, i18n, mobile |
| `e2e/global-setup.js` | Generates sample media into `e2e/.fixtures` (cached) |
| `examples/` | Ready-to-use API clients (bash, Node) |
| `docs/` | Reference docs: CLI, API, configuration, deployment |
| `skills/` | Agent Skills for using the tool and for deploying it |

## Guidelines

- **No build step.** The frontend is plain JS served as-is. Please keep it that way.
- **Keep dependencies minimal.** Talk about new runtime dependencies in an issue first.
- **Any user-visible string needs a translation.**
  - In HTML, add a `data-i18n` key. The English text stays in the markup.
  - In JS, use `t('key')` and add the key to every language in `public/i18n.js`.
- **Platform differences go through `caps`** in `server.js`. For example, VideoToolbox exists only on macOS, and HEIC decoding depends on `sips` or libheif. The UI hides options the server can't provide by using `data-requires`.
- **Add or extend a test.** Compression behaviour goes in `test/smoke.test.js`. Anything a user clicks or sees goes in `e2e/`.
- **Keep the docs in sync.** The table in [AGENTS.md → Architecture rules](AGENTS.md#architecture-rules) lists which docs to update for each kind of change. README.md and README.vi.md must say the same things.

## Adding a language

1. Copy the `vi` block in `public/i18n.js` and translate it.
2. Add a `<button type="button" data-lang="xx">XX</button>` in the header of `index.html`.
3. Optionally, add a `README.xx.md`.
