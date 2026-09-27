'use strict';

/*
 * In-browser compression ("Compress on: This browser"). Nothing is uploaded: video and audio go
 * through WebCodecs via Mediabunny (loaded from /vendor on first use), images through a canvas.
 * Whatever the browser can't do throws LocalUnsupported, and the app sends that file to the
 * server instead.
 */
const LocalCompress = (() => {
  class LocalUnsupported extends Error {}

  const supported = typeof VideoEncoder === 'function' && typeof AudioEncoder === 'function' && typeof OffscreenCanvas === 'function';
  /** @type {Promise<any> | undefined} */
  let loading;
  const load = () => (loading ??= import('/vendor/mediabunny.mjs'));

  const parseTime = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const parts = String(v).trim().split(':');
    if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
    return parts.reduce((sum, p) => sum * 60 + Number(p), 0);
  };
  const baseName = (name) => name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._ -]+/gu, '_') || 'file';

  // ---------------------------------------------------------------------------
  // Images: decode with createImageBitmap, encode with OffscreenCanvas (JPEG / WebP only)
  // ---------------------------------------------------------------------------

  async function image(file, o, onProgress) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let format = o.format;
    if (!format || format === 'auto') format = ext === 'webp' ? 'webp' : ['jpg', 'jpeg'].includes(ext) ? 'jpeg' : null;
    if (format !== 'jpeg' && format !== 'webp') throw new LocalUnsupported(`${(format || ext).toUpperCase()} output needs the server`);
    if (ext === 'gif') throw new LocalUnsupported('animated images need the server');

    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      throw new LocalUnsupported(`this browser can't decode ${ext.toUpperCase()}`);
    }
    const max = Number(o.maxDim) || 0;
    const scale = max ? Math.min(1, max / Math.max(bitmap.width, bitmap.height)) : 1;
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (format === 'jpeg') {
      ctx.fillStyle = '#fff'; // JPEG has no transparency
      ctx.fillRect(0, 0, width, height);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    onProgress(0.5);
    const type = `image/${format}`;
    const blob = await canvas.convertToBlob({ type, quality: Math.min(100, Math.max(1, Number(o.quality) || 78)) / 100 });
    // Browsers without a WebP encoder silently return PNG.
    if (blob.type !== type) throw new LocalUnsupported(`this browser can't encode ${format.toUpperCase()}`);
    return { blob, name: `${baseName(file.name)}-compressed.${format === 'jpeg' ? 'jpg' : 'webp'}`, info: { width, height } };
  }

  // ---------------------------------------------------------------------------
  // Video and audio: Mediabunny Conversion (demux → decode → re-encode → mux)
  // ---------------------------------------------------------------------------

  const VIDEO_CODEC = { h264: 'avc', h265: 'hevc', av1: 'av1', vp9: 'vp9' };

  async function media(file, kind, o, onProgress, signal) {
    const mb = await load();
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    let video;
    let audio;
    try {
      video = kind === 'video' ? await input.getPrimaryVideoTrack() : null;
      audio = await input.getPrimaryAudioTrack();
    } catch {
      throw new LocalUnsupported('this browser can\'t read this file');
    }
    if (kind === 'video' && !video) throw new Error('No video stream found in this file');
    if (kind === 'audio' && !audio) throw new Error('No audio stream found in this file');

    const duration = await input.computeDuration();
    const start = parseTime(o.trimStart) ?? 0;
    const end = parseTime(o.trimEnd) ?? duration;
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) throw new Error('Invalid trim times');
    const clip = Math.min(end, duration) - start;

    // Output container and codecs
    let format;
    let ext;
    let mime;
    let videoCodec = null;
    let audioCodec = null;
    let audioKbps = 0;
    if (kind === 'video') {
      if (o.format === 'gif') throw new LocalUnsupported('GIF needs the server');
      const webm = o.format === 'webm';
      videoCodec = webm ? (o.codec === 'av1' ? 'av1' : 'vp9') : VIDEO_CODEC[o.codec] || 'avc';
      format = webm ? new mb.WebMOutputFormat() : new mb.Mp4OutputFormat({ fastStart: 'in-memory' });
      [ext, mime] = webm ? ['webm', 'video/webm'] : ['mp4', 'video/mp4'];
      if (audio && o.audio !== 'remove') {
        audioCodec = webm ? 'opus' : 'aac';
        audioKbps = o.audio === 'low' ? 64 : 128;
      }
    } else {
      if (o.format === 'opus') [format, ext, mime, audioCodec] = [new mb.OggOutputFormat(), 'ogg', 'audio/ogg', 'opus'];
      else if (o.format === 'm4a') [format, ext, mime, audioCodec] = [new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), 'm4a', 'audio/mp4', 'aac'];
      else throw new LocalUnsupported('MP3 output needs the server');
      audioKbps = Number(o.bitrate) || 128;
    }
    if (audioCodec && !(await mb.canEncodeAudio(audioCodec, { bitrate: audioKbps * 1000 }))) {
      throw new LocalUnsupported(`this browser can't encode ${audioCodec.toUpperCase()} audio`);
    }

    // Video size, frame rate and bitrate
    const videoOptions = { discard: !video };
    if (video) {
      const w = video.displayWidth;
      const h = video.displayHeight;
      const cap = Number(o.resolution) || 0;
      let outW = w;
      let outH = h;
      if (cap && Math.min(w, h) > cap) {
        const f = cap / Math.min(w, h);
        outW = Math.round((w * f) / 2) * 2;
        outH = Math.round((h * f) / 2) * 2;
        Object.assign(videoOptions, w >= h ? { height: outH } : { width: outW });
      }
      const fpsCap = Number(o.fps) || 0;
      if (fpsCap && (await video.computePacketStats(120)).averagePacketRate > fpsCap + 0.5) videoOptions.frameRate = fpsCap;

      let bitrate;
      if (o.quality === 'target') {
        bitrate = Math.floor((Number(o.targetMB) * 8 * 1024 * 1024 * 0.96) / clip - audioKbps * 1000);
        if (!(bitrate >= 50_000)) throw new Error(`${o.targetMB} MB is too small for a ${Math.round(clip)}-second video`);
      } else {
        bitrate = { high: mb.QUALITY_HIGH, balanced: mb.QUALITY_MEDIUM, small: mb.QUALITY_LOW, tiny: mb.QUALITY_VERY_LOW }[o.quality] || mb.QUALITY_MEDIUM;
      }
      if (!(await mb.canEncodeVideo(videoCodec, { width: outW, height: outH, bitrate: typeof bitrate === 'number' ? bitrate : undefined }))) {
        throw new LocalUnsupported(`this browser can't encode ${o.codec === 'h265' ? 'H.265' : videoCodec.toUpperCase()} at ${outW}×${outH}`);
      }
      Object.assign(videoOptions, { codec: videoCodec, bitrate, forceTranscode: true });
    }

    const output = new mb.Output({ format, target: new mb.BufferTarget() });
    const conversion = await mb.Conversion.init({
      input,
      output,
      video: videoOptions,
      audio: audioCodec
        ? { codec: audioCodec, bitrate: audioKbps * 1000, forceTranscode: true, ...((o.audio === 'low' || o.mono) ? { numberOfChannels: 1 } : {}) }
        : { discard: true },
      trim: { start, end: Math.min(end, duration) },
    });
    if (!conversion.isValid) {
      const why = conversion.discardedTracks.map((d) => d.reason).join(', ');
      throw new LocalUnsupported(`the browser can't convert this file${why ? ` (${why})` : ''}`);
    }
    conversion.onProgress = (p) => onProgress(Math.min(0.99, p));
    signal?.addEventListener('abort', () => conversion.cancel());
    await conversion.execute();

    const info = video ? { width: video.displayWidth, height: video.displayHeight, duration } : { duration };
    return { blob: new Blob([output.target.buffer], { type: mime }), name: `${baseName(file.name)}-compressed.${ext}`, info };
  }

  /**
   * Compresses `file` in this browser.
   * @returns {Promise<{ blob: Blob, name: string, info: object }>}
   * @throws {LocalUnsupported} when the server has to do it instead
   */
  async function compress(file, kind, options, { onProgress = () => {}, signal } = {}) {
    if (!supported) throw new LocalUnsupported('this browser has no WebCodecs');
    if (kind === 'image') return image(file, options, onProgress);
    if (kind === 'video' || kind === 'audio') return media(file, kind, options, onProgress, signal);
    throw new LocalUnsupported(`${kind.toUpperCase()} needs the server`);
  }

  return { supported, compress, LocalUnsupported };
})();
