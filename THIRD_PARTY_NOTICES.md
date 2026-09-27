# Third-party notices

Compress Media's own source code is licensed under the [MIT License](LICENSE). It relies on third-party software that keeps its own licenses. This file lists what that software is, how Compress Media uses it, and what that means for you when you redistribute it.

This is a summary, not legal advice. The license texts ship with each component.

## How the components are combined

| Component | License | How it's used | Where it ends up |
|---|---|---|---|
| **FFmpeg** with x264, x265, libvpx, SVT-AV1, LAME, Opus… | **GPL-2.0-or-later / GPL-3.0-or-later** (x264 and x265 make the build GPL) | Run as a **separate program** (`child_process`); not linked into Compress Media | npm: downloaded by `ffmpeg-static` at install time. Docker: Alpine's `ffmpeg` package. |
| `ffmpeg-static` (npm) | GPL-3.0-or-later | Installer that fetches the FFmpeg binary; only its path is read | `node_modules` (npm installs) |
| FFprobe via `@ffprobe-installer/*` | LGPL-2.1 (package), GPL (binary) | Separate program | `node_modules`; Docker uses Alpine's `ffprobe` |
| **Ghostscript** | **AGPL-3.0-or-later** | Separate program, for PDF compression only | Docker image (optional, see below). Not installed by npm. |
| **libvips** (through sharp) | **LGPL-3.0-or-later** | Dynamically linked shared library, shipped as its own npm package (`@img/sharp-libvips-*`) that can be replaced | `node_modules`, Docker image |
| sharp | Apache-2.0 | Library | `node_modules`, Docker image |
| **libheif** (`heif-dec`) | LGPL-3.0 (tools: MIT) | Separate program, HEIC decoding in Docker | Docker image |
| **Mediabunny** | **MPL-2.0** | Unmodified file served to browsers for in-browser compression (`/vendor/mediabunny.mjs`) | `node_modules`; sent to browsers as-is, license header intact |
| AWS SDK for JavaScript v3 | Apache-2.0 | Library (object storage) | `node_modules` |
| Express, multer, BullMQ, ioredis, yazl and their dependencies | MIT, ISC, BSD, 0BSD, Apache-2.0 | Libraries | `node_modules` |
| Node.js, Alpine Linux, tini | MIT, various (Alpine packages), MIT | Runtime / base image | Docker image |

## What this means

**Compress Media's code stays MIT.** The GPL and AGPL programs (FFmpeg, Ghostscript) are only run as separate programs through their command lines. They are not linked, and their code is not copied into this project. The LGPL library (libvips) is dynamically linked and replaceable.

**If you only use it** (the web UI, API or CLI, even as a hosted service), you have nothing extra to do. The AGPL's network clause applies to people who *modify Ghostscript* and offer it over a network; Compress Media runs it unmodified.

**If you redistribute the Docker image** (push it to your own registry, ship it to customers), the image contains GPL, AGPL and LGPL binaries, and their licenses apply to those binaries:

- **Keep the license notices.** The image contains this file at `/app/THIRD_PARTY_NOTICES.md`, which names each component, its license and where to find the full text. Alpine keeps the full license files in each package's `-doc` package (`apk add ffmpeg-doc`, …), if you want them inside the image.
- **Make the corresponding source available.**
  - The binaries are Alpine's unmodified packages, whose sources are published at [pkgs.alpinelinux.org](https://pkgs.alpinelinux.org) and [gitlab.alpinelinux.org/alpine/aports](https://gitlab.alpinelinux.org/alpine/aports) for the matching Alpine release.
  - Pointing to them, or offering the source on request, is the usual way to comply.
  - If you *modify* any of these programs, you must publish your changes under their licenses.

**If you redistribute the npm package or a build of this repository**, it does not include FFmpeg or Ghostscript binaries itself. `ffmpeg-static` downloads FFmpeg on the user's machine, and Ghostscript is whatever the user installed.

**Mediabunny (MPL-2.0)** is served unmodified, so its source is the file itself. If you change `node_modules/mediabunny`, you must publish those changed files under the MPL-2.0.

## Leaving out Ghostscript (AGPL)

Some organisations don't allow AGPL software at all. PDF compression is optional: without Ghostscript the PDF tab disappears and everything else works.

- **Docker:** use the `-nopdf` images, e.g. `runsnip/compress-media:2.0.0-nopdf` or `:latest-nopdf` (also on GHCR), or build with `--build-arg GHOSTSCRIPT=false`. The images without the suffix include Ghostscript.
- **npm / native:** Ghostscript is only used if it's installed (`gs` on `PATH`, or `GS_PATH`).

## Patents

H.264 (AVC), H.265 (HEVC) and AAC may be covered by patents in some countries. Licensing, if needed, depends on how and where you distribute or use the encoder. AV1, VP9 and Opus were designed to be royalty-free.

## Full license texts

| Component | License text |
|---|---|
| FFmpeg | https://ffmpeg.org/legal.html |
| x264 | https://www.videolan.org/developers/x264.html (GPL-2.0-or-later) |
| x265 | https://bitbucket.org/multicoreware/x265_git (GPL-2.0-or-later) |
| Ghostscript | https://www.ghostscript.com/licensing/ (AGPL-3.0-or-later) |
| libvips | https://github.com/libvips/libvips/blob/master/LICENSE (LGPL-2.1-or-later; prebuilt binaries for sharp: LGPL-3.0-or-later) |
| sharp | https://github.com/lovell/sharp/blob/main/LICENSE (Apache-2.0) |
| libheif | https://github.com/strukturag/libheif/blob/master/COPYING (LGPL-3.0) |
| Mediabunny | https://github.com/Vanilagy/mediabunny/blob/main/LICENSE (MPL-2.0) |
| AWS SDK for JavaScript | https://github.com/aws/aws-sdk-js-v3/blob/main/LICENSE (Apache-2.0) |
| Node.js dependencies | each package's `LICENSE` file in `node_modules/` |
