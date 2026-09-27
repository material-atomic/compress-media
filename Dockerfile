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
LABEL org.opencontainers.image.title="Compress Media" \
      org.opencontainers.image.description="Self-hosted video, image and audio compressor — web UI, HTTP API and CLI (ffmpeg + sharp)" \
      org.opencontainers.image.vendor="RunSnip" \
      org.opencontainers.image.url="https://runsnip.com" \
      org.opencontainers.image.source="https://github.com/material-atomic/compress-media" \
      org.opencontainers.image.licenses="MIT"
# ffmpeg does the video/audio work, libheif-tools provides `heif-dec` for HEIC photos,
# tini reaps ffmpeg children.
RUN apk add --no-cache ffmpeg libheif-tools tini

ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    HOST=0.0.0.0 \
    PORT=4747 \
    WORK_DIR=/data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
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
