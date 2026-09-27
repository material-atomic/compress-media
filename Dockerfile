# syntax=docker/dockerfile:1

# ---- dependencies ---------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# The image uses Alpine's ffmpeg/ffprobe rather than the npm-bundled static builds: the generic
# static arm64 build is 5-10x slower. --ignore-scripts skips ffmpeg-static's download (sharp
# needs no install script), and the unused ffprobe binaries are dropped.
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force \
 && rm -rf node_modules/@ffprobe-installer

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine
# Ghostscript (AGPL-3.0) powers PDF compression. Build with --build-arg GHOSTSCRIPT=false to leave it
# out; the PDF tab then disappears and everything else works. See THIRD_PARTY_NOTICES.md.
ARG GHOSTSCRIPT=true
# whisper.cpp (MIT) turns speech into subtitles; its models are downloaded on first use into
# /data/models, not shipped. --build-arg WHISPER=false leaves it out (own .srt/.vtt files still work).
ARG WHISPER=true
LABEL org.opencontainers.image.title="Compress Media" \
      org.opencontainers.image.description="Self-hosted video, image, audio and PDF compressor with a GIF maker and subtitles — web UI, HTTP API and CLI" \
      org.opencontainers.image.vendor="RunSnip" \
      org.opencontainers.image.url="https://runsnip.com" \
      org.opencontainers.image.source="https://github.com/material-atomic/compress-media" \
      org.opencontainers.image.licenses="MIT AND GPL-2.0-or-later AND LGPL-3.0-or-later AND AGPL-3.0-or-later AND Apache-2.0 AND MPL-2.0 AND Bitstream-Vera"
# ffmpeg (GPL) does the video/audio work, libheif-tools (LGPL) provides `heif-dec` for HEIC photos,
# tini reaps child processes. All are run as separate programs, never linked into the app.
# DejaVu fonts (with fontconfig) let burned-in subtitles draw Vietnamese and other accented text.
RUN apk add --no-cache ffmpeg libheif-tools tini fontconfig font-dejavu \
 && if [ "$GHOSTSCRIPT" = "true" ]; then apk add --no-cache ghostscript; fi \
 && if [ "$WHISPER" = "true" ]; then apk add --no-cache whisper.cpp; fi

ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    HOST=0.0.0.0 \
    PORT=4747 \
    WORK_DIR=/data \
    WHISPER_MODELS_DIR=/data/models

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js LICENSE THIRD_PARTY_NOTICES.md ./
COPY lib ./lib
COPY bin ./bin
COPY public ./public

# `compress-media` on PATH, for one-off CLI runs:
#   docker run --rm -v "$PWD:/work" -w /work compress-media compress-media clip.mov
RUN ln -s /app/bin/cli.js /usr/local/bin/compress-media \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4747

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
