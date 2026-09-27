---
name: compress-media
description: Shrink video, image and audio files with Compress Media, through its local CLI or a running Compress Media server's HTTP API. Examples are QuickTime/screen recordings (MOV→MP4), photos (JPG/PNG/HEIC→JPEG/WebP/AVIF), animated GIFs and WAV/M4A audio. Use when the user wants files smaller, needs to fit an upload or email limit ("under 25 MB"), wants a screen recording converted to MP4, wants a folder of images optimized for the web, or wants photo GPS/EXIF metadata removed. For installing or operating the server itself, use the compress-media-deploy skill.
---

# compress-media

`compress-media` compresses media with ffmpeg (video, audio) and sharp (images). The **CLI** works on local files, needs no server, and never sends files anywhere. Results are written **next to the input** as `<name>-compressed.<ext>`. Originals are never modified.

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
compress-media info --json               # hardwareEncoder (macOS VideoToolbox), heicDecoder
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
| Long video and speed matters (macOS only) | `--hw` (VideoToolbox, several times faster, files slightly larger) |
| Keep quality high, just remove waste | `--quality high` |
| Video without sound | `--audio remove` |
| Images for a website | `--image-format webp --max-dim 1920` (add `-r -o <dir>` for folders) |
| Smallest images, modern browsers only | `--image-format avif` |
| Screenshots, UI or logos (PNG) | default (lossy palette PNG), or `--image-format webp` |
| iPhone HEIC photos | default → becomes JPEG |
| Voice memo or podcast | `--audio-format opus --bitrate 48 --mono` → a `.ogg` file (use `mp3 --bitrate 64 --mono` if it must be `.mp3`) |
| Music | `--audio-format m4a --bitrate 128` or higher |

Defaults when the user gives no preference:

- **Video:** H.264, balanced quality, audio kept.
- **Images:** keep the format, quality 78, strip metadata.
- **Audio:** MP3 at 128 kbps.

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

When the user gives you a Compress Media server URL (their own instance), compress through its API. Check it first: `curl -s <url>/api/config` should return JSON with a `version`.

- If the repo is available, use its client **for every file, small or large**: `<repo>/examples/compress.sh <file> '<options-json>' <url>` (bash + curl + jq) or `COMPRESS_MEDIA_URL=<url> node <repo>/examples/compress.mjs <file> '<options-json>'`. It handles chunking, retries, polling and download.
- Otherwise follow [reference.md → HTTP API](reference.md#http-api-web-ui-server): one request for small files, chunked upload for large ones.
- **Looking before you compress:** the API has no probe endpoint. If the CLI is also available, `compress-media probe <file> --json` works locally without sending anything. Otherwise choose from the goal table, and read the source details from the finished job's `info` field.

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
| API: `415 Unsupported file type` / `413` | Wrong file type, or the server's `MAX_UPLOAD_MB` is lower than the file. |

The full flag list, the HTTP API of the web UI, and the JSON field reference are in [reference.md](reference.md).
