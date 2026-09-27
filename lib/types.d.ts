// Shared shapes for the web UI, the HTTP API and the CLI. Referenced from JSDoc
// (`@type {import('./types').VideoOptions}`) and checked by `npm run typecheck` — nothing is compiled.

export type Kind = 'video' | 'image' | 'audio' | 'pdf' | 'animation' | 'subtitles';

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

/** "Make animation": several still images → one animated GIF, animated WebP or MP4. */
export interface AnimationOptions {
  /** Default `gif`. */
  format?: 'gif' | 'webp' | 'mp4';
  /** Milliseconds each frame is shown (default 500). A single number, or one per frame. */
  delay?: number | string | number[];
  /** Times to play; 0 = forever (default). Ignored for MP4. */
  loop?: number | string;
  /** Long edge of the output in pixels (default 800); frames are fitted to the first frame's shape. */
  maxDim?: number | string;
  /** How frames of another shape fit the canvas (default `contain`). */
  fit?: 'contain' | 'cover';
  /** Canvas colour behind `contain`ed frames (default white). */
  background?: string;
  /** 1–100 (default 80): GIF colours, WebP quality, MP4 CRF. */
  quality?: number | string;
}

/** "Subtitles": speech → SRT/WebVTT (whisper.cpp), or subtitles → video. */
export interface SubtitleOptions {
  /** Spoken language as an ISO 639-1 code (`vi`, `en`…), or `auto` (default). */
  language?: string;
  /** Translate the speech into English subtitles (not with `large-v3-turbo`). */
  translate?: boolean;
  /** Speech model; default `small` (or WHISPER_MODEL). Downloaded on first use. */
  model?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo';
  /** Subtitle file format when `embed` is `none`. Default `srt`. */
  format?: 'srt' | 'vtt';
  /** `none` (default) returns the subtitle file; `track` adds a selectable track; `burn` draws the text into the picture. */
  embed?: 'none' | 'track' | 'burn';
  /** Text size when burning in. Default `medium`. */
  fontSize?: 'small' | 'medium' | 'large';
  /** SRT or WebVTT to use instead of transcribing (your own file, or an edited transcript). */
  text?: string;
}

export interface MediaOptions {
  video?: VideoOptions;
  image?: ImageOptions;
  audio?: AudioOptions;
  pdf?: PdfOptions;
  animation?: AnimationOptions;
  subtitles?: SubtitleOptions;
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
  /** The whisper.cpp command for speech recognition, or null. */
  whisper: string | null;
  /** Whether ffmpeg can burn in subtitles (libass). */
  burnSubtitles: boolean;
}

/** What a multi-step job is doing; `progress` is relative to the current stage. */
export type Stage = 'model' | 'transcribe' | 'embed';

export interface Progress {
  progress: number;
  speed: number | null;
  eta: number | null;
  stage?: Stage;
}

export interface CompressTask {
  kind: Kind;
  /** The input file; for `animation` the first frame. */
  input: string;
  /** Every frame, in order (`animation` only). */
  inputs?: string[];
  /** The name the user gave the input, when `input` is a temporary path. */
  inputName?: string;
  /** The option object for `kind` (each compressor narrows it). */
  options: VideoOptions | ImageOptions | AudioOptions | PdfOptions | AnimationOptions | SubtitleOptions;
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
  /** Suggested download name when it isn't "<input>-compressed.<ext>". */
  name?: string;
  /** Download name = the input's name without extension + this (e.g. ".vi.srt", "-subtitled.mp4"). */
  suffix?: string;
  /** `subtitles`: the subtitles as SRT, kept with the job for editing and re-use. */
  transcript?: string;
}
