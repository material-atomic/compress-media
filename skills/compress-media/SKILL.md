---
name: compress-media
description: Shrink video, image, audio and PDF files with Compress Media, through its local CLI or a running Compress Media server's HTTP API. Examples are QuickTime/screen recordings (MOV→MP4/WebM/GIF, trimmed), photos (JPG/PNG/HEIC→JPEG/WebP/AVIF), WAV/M4A audio and image-heavy PDFs (CVs, portfolios, reports). Use when the user wants files smaller, needs to fit an upload or email limit ("under 25 MB"), wants a clip or GIF cut from a recording, wants images optimized for the web, wants photo GPS/EXIF metadata removed, wants several screenshots or photos turned into one animated GIF, WebP or MP4, or wants subtitles/captions for a video (speech → SRT/VTT, e.g. for YouTube, or subtitles burned into a video for TikTok/Reels). For installing or operating the server itself, use the compress-media-deploy skill.
---

# compress-media

`compress-media` compresses media with ffmpeg (video, audio) and sharp (images), and makes subtitles from speech with whisper.cpp. The **CLI** works on local files, needs no server, and never sends files anywhere. Results are written **next to the input** as `<name>-compressed.<ext>`. Originals are never modified.

Prefer the CLI for files on this machine. Use the [HTTP API](#using-a-server-instead) only when the user points you at a Compress Media server (a URL), or the files must be processed there.

## 1. Find the CLI

Try these in order and use the first one that works:

```bash
compress-media --version                      # installed globally (npm link / npm i -g)
node <repo>/bin/cli.js --version              # a checkout of the repo (run `npm install` in it once)
docker run --rm -v "$PWD:/work" -w /work runsnip/compress-media compress-media --version   # Docker Hub image
```

- With Docker, file paths must be inside the mounted folder. Use paths relative to it, e.g. `compress-media clip.mov`, not `/Users/…/clip.mov`.
- On Linux, add `--user "$(id -u):$(id -g)"` so the results are owned by the user.

If none works, tell the user it isn't installed and point them to the repo README. Don't install anything globally without asking.

## 2. Look before you compress

```bash
compress-media probe <files...> --json   # size, duration, resolution, fps, codecs, per file
compress-media info --json               # hardwareEncoder/hardwareName, av1, webm, pdf, heicDecoder, whisper, burnSubtitles, subtitleModels
```

Use `probe` to choose settings, for example:

- a 2880×1800 60 fps screen recording → cap it at `--max-res 1080 --fps 30`;
- a 12-minute video with a 25 MB limit → `--target-mb 25`, but warn that quality will be low.

## 3. Pick settings from the goal

| User's goal | Flags |
|---|---|
| "Make it smaller", share anywhere (default choice) | `--max-res 1080 --fps 30` |
| Screen recording / tutorial / slides | `--max-res 1080 --fps 30 --quality small` (static screens compress extremely well) |
| Must fit a limit (Gmail 25 MB, Discord 10 MB, Slack…) | `--target-mb <limit minus ~5%>` |
| Smallest file, Apple devices or modern browsers | `--codec h265 --speed slow` |
| Long video and speed matters | `--hw` if `info` shows a hardware encoder (VideoToolbox, NVENC, Quick Sync, VA-API, AMF): several times faster, files slightly larger |
| Only part of a video ("the first 30 seconds", "from 1:10 to 2:00") | `--start 1:10 --end 2:00` (seconds or `[hh:]mm:ss`) |
| A GIF for docs, an issue, a chat | `--video-format gif --start … --end …` (defaults to 480p and 12 fps; keep clips short, since GIFs grow fast) |
| Smallest video for the web, modern browsers | `--video-format webm --codec av1` if `info` shows `av1`; else `--video-format webm` (VP9) |
| Keep quality high, just remove waste | `--quality high` |
| Video without sound | `--audio remove` |
| Images for a website | `--image-format webp --max-dim 1920` (add `-r -o <dir>` for folders) |
| Smallest images, modern browsers only | `--image-format avif` |
| Screenshots, UI or logos (PNG) | default (lossy palette PNG), or `--image-format webp` |
| iPhone HEIC photos | default → becomes JPEG |
| Voice memo or podcast | `--audio-format opus --bitrate 48 --mono` → a `.ogg` file (use `mp3 --bitrate 64 --mono` if it must be `.mp3`) |
| Music | `--audio-format m4a --bitrate 128` or higher |
| PDF to email or upload (CV, portfolio, report) | `--pdf-quality ebook` (150 dpi images); `screen` is smaller but blurry in print; `printer` keeps 300 dpi |
| Scanned or photo-heavy PDF that needs to be tiny | `--pdf-quality screen`, plus `--grayscale` if colour doesn't matter |
| A GIF / slideshow from several screenshots or photos | `compress-media animate <images or folder> …`, see [Make an animation](#make-an-animation) |
| Subtitles for a video, YouTube captions, a transcript with times | `compress-media subtitles <video> --lang <code>` → `<name>.<lang>.srt`, see [Subtitles](#subtitles) |
| Burn subtitles into a video (TikTok, Reels, Zalo, players without subtitle support) | `compress-media subtitles <video> --embed burn [--font-size large]` (add `--srt <file>` to use existing subtitles) |
| Add a subtitle track viewers can turn on | `compress-media subtitles <video> --embed track` (no re-encode) |

Defaults when the user gives no preference:

- **Video:** H.264, balanced quality, audio kept.
- **Images:** keep the format, quality 78, strip metadata.
- **Audio:** MP3 at 128 kbps.
- **PDF:** `ebook`. PDFs that are mostly text barely shrink, and a result that isn't smaller is reported as `larger`. PDF needs Ghostscript: check `info --json` → `pdf`.

H.264 plays everywhere. Only pick H.265 when the user's audience can play it.

## 4. Run it

```bash
compress-media <files or folders> [flags] --json -q
```

- `--json` prints one report on stdout, and `-q` silences the progress lines on stderr.
- Folders: add `-r` to include sub-folders. Only supported media is picked up, and earlier `*-compressed.*` outputs are skipped.
- `-o <dir>` collects the results in one place, mirroring sub-folders. A relative `<dir>` is resolved against the current working directory and created if missing. Output extensions follow the format: video → `.mp4`, `opus` → `.ogg`, `m4a` → `.m4a`, `jpeg` → `.jpg`.
- When two inputs share a name (`photo.png` + `photo.heic`), the source extension is added to keep them apart: `photo-png-compressed…`.
- Existing outputs make that file fail unless you pass `--overwrite`. Use `--suffix=-web` for a different name. Note the `=`, which is needed because the value starts with `-`.
- `--skip-larger` discards results that aren't smaller, so the user can keep the original.

**Timing:** images take well under a second each. On the CPU, 1080p video encodes at roughly 0.5–2× real time, so a 10-minute recording can take 5–20 minutes. `--hw` or `--speed fast` is much quicker. For anything longer than a couple of minutes, run the command in the background and poll, instead of blocking on a short tool timeout. Ctrl+C / SIGTERM cleans up partial files.

### Make an animation

`animate` turns 2–1000 still images into **one** animated GIF, animated WebP or MP4. It's a separate command, and none of the compress flags above apply to it.

```bash
compress-media animate shot-*.png --delay 700 --max-dim 1200 -o walkthrough.gif --json -q
compress-media animate frames/ --format webp --fps 2             # a folder, sorted by name
```

- Frames are used in the order given. A folder contributes its images sorted by name, with numbers compared numerically (`shot-2` before `shot-10`); add `-r` for sub-folders. Earlier `*-animated.gif` / `*-animated.webp` results in a folder are skipped.
- The output is `<first-image-name>-animated.<gif|webp|mp4>` next to the first image. `-o` takes a file (`demo.gif`) or a folder.
- The canvas has the first image's shape, with the long edge capped by `--max-dim` (default 800). Images of another shape get borders (`--fit contain`, colour `--background`) or are cropped (`--fit cover`).
- Pick the format from where it will be shown: `gif` opens anywhere (email, chat, issues) but is the largest; `webp` is much smaller and plays in modern browsers; `mp4` is the smallest, has no transparency and ignores `--loop`.

Flags: `--format gif|webp|mp4` (default gif) · `--delay <ms>` (500) or `--fps <n>`, not both · `--loop <n>` (0 = forever) · `--max-dim <n>` (800) · `--fit contain|cover` · `--background <hex>` (#ffffff) · `--quality 1–100` (80) · `--overwrite`, `--json`, `-q`. The report has the usual shape, with one result of `kind: "animation"`, its frames in `inputs`, and `info: { frames, width, height, durationMs, loop }`.

### Subtitles

`subtitles` listens to the speech in videos or audio (whisper.cpp) and writes a subtitle file with times and text, or puts subtitles into the video. It's a separate command; the compress flags don't apply.

```bash
compress-media subtitles talk.mov --lang vi --json -q                              # → talk.vi.srt
compress-media subtitles talk.mov --srt talk.srt --embed burn --font-size large    # your subtitles, drawn in → talk-subtitled.mp4
compress-media subtitles lectures/ -r --model large-v3-turbo --format vtt          # a folder, most accurate model
```

- **Check first:** `info --json` → `whisper` (the whisper.cpp command, or `null`) and `burnSubtitles`. Without whisper.cpp only `--srt` works; tell the user to install it (`brew install whisper-cpp`, the distro's `whisper.cpp` package) or use the Docker image.
- **The first run downloads a speech model** (once, into `~/.cache/compress-media/models`): `tiny` 75 MB, `base` 142 MB, `small` 466 MB (default), `medium` 1.5 GB, `large-v3-turbo` 547 MB (most accurate). Tell the user before a large download. `info --json` → `subtitleModels[].installed` shows what's there.
- **Pass `--lang`** when you know the language (`vi`, `en`, `ja`…, ISO 639-1); detection can guess wrong on short clips. For Vietnamese and other non-English speech use `small` or better. `--translate` gives English subtitles from any language (not with `large-v3-turbo`).
- **Outputs:** `--embed none` (default) → `<name>.<lang>.srt` (`--format vtt` → `.vtt`), which YouTube Studio takes under Subtitles → Upload file → With timing. `--embed track` → `<name>-subtitled.<ext>` with a selectable track, no re-encode (MP4/MOV/WebM/MKV kept, others → MKV). `--embed burn` → `<name>-subtitled.mp4`, re-encoded, text drawn into the picture.
- **Own subtitles:** `--srt file.srt|.vtt` skips speech recognition (one input at a time). With the default `--embed none` and no `--lang`, the output is `<name>.srt` — the same name as a `talk.srt` given for `talk.mov`. Pass `--lang <code>` (→ `talk.vi.srt`) or `-o <dir>`, and never add `--overwrite` there, or the user's file is replaced.
- **Timing:** bigger models are slower (`medium` most of all); `--embed burn` re-encodes the whole video. Run long videos in the background and poll.
- Each JSON result has `kind: "subtitles"` and `info: { cues, language, spokenLanguage, model, duration, embed, words }`. `cues: 0` means no speech was recognised.

Flags: `--lang auto|<code>` · `--translate` · `--model tiny|base|small|medium|large-v3-turbo` · `--format srt|vtt` · `--embed none|track|burn` · `--font-size small|medium|large` (burn) · `--srt <file>` · `-o <dir>`, `-r`, `--overwrite`, `--json`, `-q`.

## 5. Read the report

```jsonc
{
  "ok": true,                               // false if any file failed
  "totals": { "files": 2, "done": 2, "skipped": 0, "failed": 0, "inputSize": 1288490188, "outputSize": 40265318, "saved": 1248224870 },
  "results": [
    { "input": "/abs/Screen Recording.mov", "kind": "video", "status": "done",   // done | skipped | error
      "output": "/abs/Screen Recording-compressed.mp4",
      "inputSize": 1288490188, "outputSize": 40265318, "saved": 1248224870, "ratio": 0.0313,
      "larger": false, "durationMs": 48210, "options": { … }, "info": { "width": 2880, "height": 1800, "fps": 60, … } },
    { "input": "/abs/notes.txt", "status": "error", "error": "Unsupported file type" }
  ]
}
```

Exit codes: `0` means every file was done or skipped, `1` means at least one failed (see `results[].error`), `2` means bad arguments (the message is on stderr).

When you report back, give before and after sizes plus the output path, e.g. "1.2 GB → 38 MB (−97%), saved as `Screen Recording-compressed.mp4`". If `larger` is true, say the original was already efficient and suggest keeping it.

## Using a server instead

When the user gives you a Compress Media server URL (their own instance), compress through its API.

- **It needs a login.** Ask the user for `AUTH_USERNAME`/`AUTH_PASSWORD`, or an `AUTH_TOKEN`, unless they already gave them. Pass them as `COMPRESS_MEDIA_USER` + `COMPRESS_MEDIA_PASSWORD`, or `COMPRESS_MEDIA_TOKEN`. Never write them into files.
- **Check the server first:** `curl -s -u user:pass <url>/api/config` should return JSON with a `version`, and it lists what the server can do (`pdf`, `av1`, `webm`, `hardwareEncoder`).

- If the repo is available, use its client **for every file, small or large**: `<repo>/examples/compress.sh <file> '<options-json>' <url>` (bash + curl + jq) or `COMPRESS_MEDIA_URL=<url> node <repo>/examples/compress.mjs <file> '<options-json>'`. It handles chunking, retries, polling and download.
- Otherwise follow [reference.md → HTTP API](reference.md#http-api-web-ui-server): one request for small files, chunked upload for large ones.
- **Looking before you compress:** the API has no probe endpoint. If the CLI is also available, `compress-media probe <file> --json` works locally without sending anything. Otherwise choose from the goal table, and read the source details from the finished job's `info` field.

- **Animations** have their own endpoint: `POST /api/animations` with the frames in order. See [reference.md → Animations](reference.md#animations).
- **Subtitles** too: `POST /api/subtitles` with the video (and optionally a `subtitles` file), then `GET /api/jobs/:id/subtitles?format=srt` for the text. Check `/api/config` → `whisper` first. See [reference.md → Subtitles](reference.md#subtitles).

The API takes option **objects**, not CLI flags. For example, `--max-res 1080 --fps 30` becomes `{"video":{"resolution":1080,"fps":30}}`, and `--image-format webp --max-dim 1920` becomes `{"image":{"format":"webp","maxDim":1920}}`. The full mapping is in reference.md.

## Rules

- **Never delete or replace the user's originals** unless they explicitly ask. Even then, confirm the result plays or opens first. You can verify with `compress-media probe <output> --json`.
- Don't pass `--overwrite` on the user's files unless they asked to redo a previous result.
- Don't send files anywhere except a Compress Media server the user chose. The CLI is local on purpose.
- `--keep-metadata` keeps GPS location in photos. Only use it when the user wants that.
- A target size far below what the content needs gives blurry video. Estimate the video bitrate as `target_MB × 8192 / duration_s` kbps and compare it with these rough minimums:

  | Resolution | Camera footage | Screen recording |
  |---|---|---|
  | 1080p | ~1500 kbps | ~400 kbps |
  | 720p | ~800 kbps | ~200 kbps |
  | 480p | ~400 kbps | ~100 kbps |

  Below the minimum, add a lower `--max-res` (and `--fps 30` or less), or tell the user the quality will suffer.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `HEIC needs a decoder` | Linux: install `libheif-examples` (or `libheif-tools`). Windows: use Docker. |
| `note: no hardware encoder` | `--hw` only works on macOS. The CPU encoder was used instead; nothing to fix. |
| `already exists (use --overwrite)` | A previous result is there. Use `--overwrite` or `--suffix=…`. |
| `… MB is too small for a N-second video` | The target is impossible. Raise `--target-mb`, or trim the video first. |
| Very slow on Linux ARM | Set `FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe` (system ffmpeg), or use Docker. |
| Docker: `No such file or directory` | The path isn't inside the mounted folder. Run from the file's folder with `-v "$PWD:/work" -w /work`. |
| API: `415 Unsupported file type` / `413` | Wrong file type (or a PDF on a server without Ghostscript), or the server's `MAX_UPLOAD_MB` is lower than the file. |
| API: `401 Authentication required` / `429` | Missing or wrong credentials, or too many failed logins (wait 15 minutes). |
| `PDF compression needs Ghostscript` | Install it (`brew install ghostscript`, `apt install ghostscript`) or use the Docker image. |
| `animate needs at least 2 images` / `use either --delay or --fps` | Give at least two images (a folder without `-r` skips its sub-folders), and choose one of `--delay` and `--fps`. |
| `Speech recognition needs whisper.cpp` / API `400` "Speech recognition is not installed" | whisper.cpp isn't installed. `brew install whisper-cpp` (macOS), the `whisper.cpp` package (Linux), `WHISPER_PATH`, or the Docker image. Own `.srt`/`.vtt` files still work. |
| Subtitles: long pause at the start of the first run | The speech model is downloading (`small` is 466 MB). It happens once. `The speech model "…" isn't installed` means downloads are off (`WHISPER_DOWNLOAD=false`): put the `ggml-*.bin` file in the models folder. |
| Subtitles in the wrong language or gibberish | Pass `--lang <code>` (API: `subtitles.language`), and use `small` or better for non-English speech. |
| `can't burn in subtitles (it needs libass)` | This ffmpeg lacks libass. Use `--embed track`, or the bundled ffmpeg / Docker image. |
| `Subtitles can only be added to a video` | `--embed track/burn` on an audio file. Use `--embed none`. |
| `AV1 encoding is not available` | This ffmpeg build lacks an AV1 encoder. Use `--codec h265`, or WebM with VP9. |

The full flag list, the HTTP API of the web UI, and the JSON field reference are in [reference.md](reference.md).
