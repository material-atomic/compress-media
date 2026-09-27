// Shared shapes for the web UI, the HTTP API and the CLI. Referenced from JSDoc
// (`@type {import('./types').VideoOptions}`) and checked by `npm run typecheck` — nothing is compiled.

export type Kind = 'video' | 'image' | 'audio' | 'pdf';

/** "90", 90, "1:30" and "0:01:30.5" are all accepted wherever a time is expected. */
export type TimeValue = number | string;

export interface VideoOptions {
  /** CRF preset, or `target` to aim for `targetMB`. Default `balanced`. */
  quality?: 'high' | 'balanced' | 'small' | 'tiny' | 'target';
  /** Total size to aim for when `quality` is `target` (two-pass encode where supported). */
  targetMB?: number;
  /** Container. `gif` has no audio and ignores `codec`. Default `mp4`. */
  format?: 'mp4' | 'webm' | 'gif';
  /** MP4: `h264` (default), `h265`, `av1`. WebM: `vp9` (default) or `av1`. */
  codec?: 'h264' | 'h265' | 'av1' | 'vp9';
  /** `hardware` uses the detected GPU/VideoToolbox encoder; falls back to `cpu`. Default `cpu`. */
  encoder?: 'cpu' | 'hardware';
  /** CPU encoder effort. Default `medium`. */
  speed?: 'ultrafast' | 'veryfast' | 'fast' | 'medium' | 'slow';
  /** Cap on the short side in pixels; 0 keeps it. */
  resolution?: number | string;
  /** Frame-rate cap; 0 keeps it. */
  fps?: number | string;
  /** Default `keep`. */
  audio?: 'keep' | 'low' | 'remove';
  /** Start of the part to keep. */
  trimStart?: TimeValue;
  /** End of the part to keep. */
  trimEnd?: TimeValue;
}

export interface ImageOptions {
  format?: 'auto' | 'jpeg' | 'webp' | 'avif' | 'png';
  /** 1–100, default 78. */
  quality?: number | string;
  /** Cap on the long edge in pixels; 0 keeps it. */
  maxDim?: number | string;
  keepMetadata?: boolean;
}

export interface AudioOptions {
  format?: 'mp3' | 'm4a' | 'opus';
  bitrate?: number | string;
  mono?: boolean;
}

export interface PdfOptions {
  /** Ghostscript preset: 72 / 150 / 300 dpi images, or prepress. Default `ebook`. */
  quality?: 'screen' | 'ebook' | 'printer' | 'prepress';
  grayscale?: boolean;
}

export interface MediaOptions {
  video?: VideoOptions;
  image?: ImageOptions;
  audio?: AudioOptions;
  pdf?: PdfOptions;
}

export interface Capabilities {
  /** True when some hardware video encoder works (kept for API compatibility). */
  hardwareEncoder: boolean;
  /** `videotoolbox`, `nvenc`, `qsv`, `vaapi`, `amf` or null. */
  hardwareName: string | null;
  /** Codecs the hardware encoder can produce. */
  hardwareCodecs: Array<'h264' | 'h265' | 'av1'>;
  av1: boolean;
  webm: boolean;
  heicDecoder: string | null;
  pdf: boolean;
}

export interface Progress {
  progress: number;
  speed: number | null;
  eta: number | null;
}

export interface CompressTask {
  kind: Kind;
  input: string;
  options: VideoOptions & ImageOptions & AudioOptions & PdfOptions;
  outputPath: (ext: string) => string;
  tempPath: (suffix: string) => string;
  onProgress?: (p: Progress) => void;
  onSpawn?: (proc: import('node:child_process').ChildProcess) => void;
  isCancelled?: () => boolean;
}

export interface CompressResult {
  file: string;
  ext: string;
  mime: string;
  info: Record<string, unknown>;
}
