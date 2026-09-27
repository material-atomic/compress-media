# CLI

`compress-media` compresses files directly. No server is needed. It uses the same engine as the web UI.

## Install

| How | Command |
|---|---|
| From a checkout | `npm install && npm link` (then `compress-media` works everywhere) |
| Without linking | `node bin/cli.js …` |
| Docker | `docker run --rm -v "$PWD:/work" -w /work runsnip/compress-media compress-media …` |

With Docker on Linux, add `--user "$(id -u):$(id -g)"` so the results are owned by you rather than the container user.

## Commands

```
compress-media [options] <file|dir>...      compress
compress-media probe <file>... [--json]     describe files (size, duration, resolution, fps, codecs)
compress-media info [--json]                capabilities: hardware encoder, HEIC support, formats
compress-media serve [--port N] [--host H]  start the web UI (same as npm start; reads the same env vars)
```

## Output

- Results are written **next to each input** as `<name>-compressed.<ext>`. Inputs are never modified.
- Output extensions: video → `.mp4`, audio → `.mp3`, `.m4a` or `.ogg` (Opus), images → the chosen format (`jpeg` → `.jpg`).
- While a file is being written it is named `<name>-compressed.partial.<ext>`. It is renamed when finished, and removed on Ctrl+C.

| Flag | Default | Meaning |
|---|---|---|
| `-o, --out-dir <dir>` | next to input | Write results into `<dir>`. It is relative to the current directory and created if missing. With `-r`, sub-folders are mirrored. |
| `--suffix=<text>` | `-compressed` | Name suffix. Use the `=` form, because the value starts with `-`. |
| `--overwrite` | off | Replace existing results. Without it, that file fails with "already exists". |
| `-r, --recursive` | off | Include sub-folders. Hidden files, unsupported types and earlier `*-compressed.*` results are skipped. |
| `--skip-larger` | off | Delete results that aren't smaller than the input and report them as `skipped`. |
| `--json` | off | Print a JSON report on stdout (see below). |
| `-q, --quiet` | off | No progress or summary on stderr. |

When two inputs would produce the same output name, the source extension is added to keep them apart. For example, `photo.png` and `photo.heic` become `photo-png-compressed.webp` and `photo-heic-compressed.webp`.

## Video (→ MP4)

| Flag | Values | Default | Notes |
|---|---|---|---|
| `--quality <q>` | `high` `balanced` `small` `tiny` | `balanced` | CRF 21/24/28/32 for H.264, 24/27/30/34 for H.265 |
| `--target-mb <n>` | number | — | Aim for a total size. Overrides `--quality` and always uses the CPU encoder. Fails if the target is impossible for the duration. |
| `--codec <c>` | `h264` `h265` | `h264` | H.265 is 30–50% smaller and tagged `hvc1` for QuickTime and Safari. |
| `--hw` | flag | off | Apple VideoToolbox. macOS only, several times faster. Ignored with a note elsewhere. |
| `--speed <s>` | `fast` `medium` `slow` | `medium` | CPU encoder effort. `slow` gives smaller files. |
| `--max-res <n>` | pixels | keep | Caps the **short** side (1080 → 1920×1080 or 1080×1920). Never upscales. |
| `--fps <n>` | number | keep | Frame-rate cap. Only applied when the source is faster. |
| `--audio <a>` | `keep` `low` `remove` | `keep` | AAC 128 kbps / AAC 64 kbps mono / no audio track |

## Images

| Flag | Values | Default | Notes |
|---|---|---|---|
| `--image-format <f>` | `auto` `jpeg` `webp` `avif` `png` | `auto` | `auto` keeps the format. HEIC → JPEG, still GIF → PNG, animated GIF stays GIF. |
| `--image-quality <n>` | 1–100 | `78` | PNG below 100 uses a lossy palette (like pngquant). GIF uses fewer colours. |
| `--max-dim <n>` | pixels | keep | Caps the long edge. Never upscales. |
| `--keep-metadata` | flag | off | Keeps EXIF including **GPS location**. Orientation is always applied to the pixels. |

## Audio

| Flag | Values | Default |
|---|---|---|
| `--audio-format <f>` | `mp3` `m4a` `opus` | `mp3` |
| `--bitrate <kbps>` | 32 48 64 96 128 160 192 256 | `128` |
| `--mono` | flag | off |

## Examples

```bash
# A QuickTime screen recording, shareable anywhere
compress-media "Screen Recording.mov" --max-res 1080 --fps 30

# Fit an email attachment
compress-media clip.mov --target-mb 24

# Smallest file for Apple devices / modern browsers
compress-media clip.mov --codec h265 --speed slow

# Long video on a Mac, fast
compress-media lecture.mov --hw --max-res 1080

# A photo library for the web, mirrored into ./web
compress-media ~/Pictures/trip -r --image-format webp --max-dim 2048 -o web

# Voice memo
compress-media memo.m4a --audio-format opus --bitrate 48 --mono

# Look first, then decide
compress-media probe "Screen Recording.mov"
```

## JSON report (`--json`)

```jsonc
{
  "ok": true,                   // false when any file failed
  "totals": { "files": 2, "done": 2, "skipped": 0, "failed": 0,
              "inputSize": 1288490188, "outputSize": 40265318, "saved": 1248224870 },
  "results": [
    {
      "input": "/abs/Screen Recording.mov", "kind": "video",
      "status": "done",         // done | skipped | error
      "output": "/abs/Screen Recording-compressed.mp4",
      "inputSize": 1288490188, "outputSize": 40265318, "saved": 1248224870,
      "ratio": 0.0313,          // output / input
      "larger": false,          // true when the result isn't smaller (kept unless --skip-larger)
      "durationMs": 48210,
      "options": { "quality": "balanced", "codec": "h264", "resolution": 1080, "fps": 30, … },
      "info": { "width": 2880, "height": 1800, "fps": 60, "duration": 312.4, … }
    },
    { "input": "/abs/notes.txt", "kind": null, "status": "error", "error": "Unsupported file type" }
  ]
}
```

`totals.inputSize` and `totals.outputSize` count only files with status `done`.

`probe --json` returns an array with one object per file:

- **Every file:** `file`, `kind`, `size`.
- **Video:** `duration`, `width`, `height` (rotation applied), `fps`, `videoCodec`, `bitrateKbps`, `audioCodec`, `audioChannels`.
- **Audio:** `duration`, `bitrateKbps`, `audioCodec`, `audioChannels`.
- **Images:** `format`, `width`, `height`, `animated`, `hasMetadata`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every file was compressed or skipped |
| `1` | At least one file failed (see `results[].error`), or a runtime error |
| `2` | Bad usage: unknown flag, invalid value, missing file. The message is on stderr, prefixed `compress-media:`. |
| `130` | Interrupted (Ctrl+C / SIGTERM). Partial files are removed. |

## Performance

- Images take well under a second each, and up to 4 run in parallel.
- Video and audio run one at a time, because each ffmpeg uses every core.
- On the CPU, 1080p video encodes at roughly 0.5–2× real time. `--hw` (macOS) or `--speed fast` is several times quicker.
- On Linux ARM, set `FFMPEG_PATH`/`FFPROBE_PATH` to the distribution's ffmpeg. The bundled generic build is much slower there.
