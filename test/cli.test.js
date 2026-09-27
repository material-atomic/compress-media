'use strict';

// CLI tests: run bin/cli.js as a child process against generated sample media.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const ffmpeg = process.env.FFMPEG_PATH || require('ffmpeg-static');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
// realpath: on macOS /var is a symlink to /private/var, and the CLI reports resolved paths.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'compress-media-cli-')));
const run = promisify(execFile);

/** Runs the CLI; resolves with { code, stdout, stderr } instead of throwing on non-zero exits. */
async function cli(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: tmp });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

async function gen(name, args) {
  const file = path.join(tmp, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await run(ffmpeg, ['-v', 'error', '-y', ...args, file]);
  return file;
}

before(async () => {
  await gen('clip.mov', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60', '-f', 'lavfi', '-i', 'sine',
    '-t', '2', '-c:v', 'libx264', '-crf', '8', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le']);
  await gen('album/a.png', ['-f', 'lavfi', '-i', 'testsrc2=size=1200x800', '-frames:v', '1']);
  await gen('album/a.jpg', ['-f', 'lavfi', '-i', 'testsrc2=size=1200x800', '-frames:v', '1', '-q:v', '1']);
  await gen('album/nested/b.png', ['-f', 'lavfi', '-i', 'testsrc2=size=640x480', '-frames:v', '1']);
  await gen('voice.wav', ['-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '3']);
  fs.writeFileSync(path.join(tmp, 'album', 'readme.txt'), 'ignored');
});

after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

test('--help and --version', async () => {
  const help = await cli('--help');
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /--target-mb/);
  const version = await cli('--version');
  assert.equal(version.stdout.trim(), require('../package.json').version);
});

test('info --json reports capabilities', async () => {
  const { code, stdout } = await cli('info', '--json');
  assert.equal(code, 0);
  const info = JSON.parse(stdout);
  assert.equal(typeof info.hardwareEncoder, 'boolean');
  assert.ok(info.formats.video.includes('mov'));
});

test('probe describes files so settings can be chosen', async () => {
  const { code, stdout } = await cli('probe', 'clip.mov', 'album/a.png', 'voice.wav', '--json');
  assert.equal(code, 0);
  const [video, image, audio] = JSON.parse(stdout);
  assert.deepEqual([video.width, video.height, Math.round(video.fps), Math.round(video.duration)], [1280, 720, 60, 2]);
  assert.equal(video.kind, 'video');
  assert.deepEqual([image.kind, image.width, image.format], ['image', 1200, 'png']);
  assert.equal(audio.kind, 'audio');
});

test('compresses a video next to the input and reports JSON', async () => {
  const { code, stdout } = await cli('clip.mov', '--max-res', '480', '--fps', '30', '--speed', 'fast', '--json', '-q');
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  const [r] = report.results;
  assert.equal(r.status, 'done');
  assert.equal(r.output, path.join(tmp, 'clip-compressed.mp4'));
  assert.ok(r.outputSize < r.inputSize);
  assert.equal(r.options.resolution, 480);
  assert.ok(fs.existsSync(r.output));
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.includes('.partial.')), []);
});

test('video: trim to a GIF, WebM/VP9, and two-pass target size', async () => {
  const gif = JSON.parse((await cli('clip.mov', '--video-format', 'gif', '--start', '0.5', '--end', '0:01.5', '--suffix=-gif', '--json', '-q')).stdout);
  assert.equal(gif.results[0].status, 'done', gif.results[0].error);
  assert.equal(path.extname(gif.results[0].output), '.gif');
  const [probed] = JSON.parse((await cli('probe', gif.results[0].output, '--json')).stdout);
  assert.equal(probed.kind, 'image');
  assert.equal(probed.animated, true);

  const webm = JSON.parse((await cli('clip.mov', '--video-format', 'webm', '--max-res', '360', '--speed', 'fast', '--suffix=-vp9', '--json', '-q')).stdout);
  assert.equal(webm.results[0].status, 'done', webm.results[0].error);
  const [v] = JSON.parse((await cli('probe', webm.results[0].output, '--json')).stdout);
  assert.deepEqual([v.videoCodec, v.height, v.audioCodec], ['vp9', 360, 'opus']);

  const trimmed = JSON.parse((await cli('clip.mov', '--start', '0.5', '--end', '1.5', '--speed', 'fast', '--suffix=-trim', '--json', '-q')).stdout);
  const [t] = JSON.parse((await cli('probe', trimmed.results[0].output, '--json')).stdout);
  assert.ok(Math.abs(t.duration - 1) < 0.15, `duration ${t.duration}`);

  const target = JSON.parse((await cli('clip.mov', '--target-mb', '0.5', '--speed', 'fast', '--suffix=-target', '--json', '-q')).stdout);
  assert.equal(target.results[0].status, 'done', target.results[0].error);
  assert.ok(target.results[0].outputSize < 0.5 * 1024 * 1024 * 1.1, `size ${target.results[0].outputSize}`);
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.includes('pass')), [], 'two-pass logs are cleaned up');
});

test('PDF: presets shrink image-heavy documents', async (t) => {
  const info = JSON.parse((await cli('info', '--json')).stdout);
  if (!info.pdf) return t.skip('Ghostscript is not installed');
  const pdf = path.join(__dirname, '..', 'e2e', '.fixtures', 'doc.pdf');
  if (!fs.existsSync(pdf)) return t.skip('PDF fixture is generated by the E2E setup');
  fs.copyFileSync(pdf, path.join(tmp, 'doc.pdf'));

  const [probed] = JSON.parse((await cli('probe', 'doc.pdf', '--json')).stdout);
  assert.deepEqual([probed.kind, probed.pages], ['pdf', 2]);

  const r = JSON.parse((await cli('doc.pdf', '--pdf-quality', 'screen', '--grayscale', '--json', '-q')).stdout).results[0];
  assert.equal(r.status, 'done', r.error);
  assert.equal(path.basename(r.output), 'doc-compressed.pdf');
  assert.ok(r.outputSize < r.inputSize / 4, `${r.inputSize} → ${r.outputSize}`);
  assert.equal(r.info.pages, 2);
  assert.equal((await cli('doc.pdf', '--pdf-quality', 'tiny')).code, 2);
});

test('animated GIFs stay animated even when the format asked for can\'t animate', async () => {
  await run(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10', '-t', '1', path.join(tmp, 'anim.gif')]);
  const sharp = require('sharp');
  for (const [format, ext] of [['avif', '.webp'], ['jpeg', '.gif'], ['png', '.gif'], ['webp', '.webp'], ['auto', '.gif']]) {
    const r = JSON.parse((await cli('anim.gif', '--image-format', format, `--suffix=-${format}`, '--json', '-q')).stdout).results[0];
    assert.equal(r.status, 'done', r.error);
    assert.equal(path.extname(r.output), ext, format);
    assert.equal((await sharp(r.output, { animated: true }).metadata()).pages, 10, `${format}: all frames kept`);
    if (['avif', 'jpeg', 'png'].includes(format)) assert.match(r.info.note, /can't be animated/);
  }
});

test('animate: frames in natural order to GIF, WebP and MP4', async () => {
  // shot-10 must come after shot-2: names are sorted by their numbers, not character by character.
  for (const [n, colour] of [[1, 'red'], [2, 'lime'], [10, 'blue']]) {
    await gen(`shots/shot-${n}.png`, ['-f', 'lavfi', '-i', `color=c=${colour}:size=320x200`, '-frames:v', '1']);
  }
  const sharp = require('sharp');

  const gif = JSON.parse((await cli('animate', 'shots', '--delay', '200', '--json', '-q')).stdout);
  assert.equal(gif.ok, true);
  const r = gif.results[0];
  assert.deepEqual(r.inputs.map((f) => path.basename(f)), ['shot-1.png', 'shot-2.png', 'shot-10.png']);
  assert.equal(path.basename(r.output), 'shot-1-animated.gif');
  const meta = await sharp(r.output, { animated: true }).metadata();
  assert.equal(meta.pages, 3);
  assert.deepEqual(meta.delay, [200, 200, 200]);
  // The last frame is blue: the order made it into the file.
  const last = await sharp(r.output, { page: 2 }).raw().toBuffer();
  assert.ok(last[2] > 200 && last[0] < 50, 'third frame is blue');

  const webp = JSON.parse((await cli('animate', 'shots', '--format', 'webp', '--fps', '5', '-o', 'out/', '--json', '-q')).stdout).results[0];
  assert.equal(webp.output, path.join(tmp, 'out', 'shot-1-animated.webp'));
  assert.deepEqual((await sharp(webp.output, { animated: true }).metadata()).delay, [200, 200, 200]);

  const mp4 = JSON.parse((await cli('animate', 'shots/shot-1.png', 'shots/shot-2.png', '--format', 'mp4', '--max-dim', '101', '-o', 'clip.mp4', '--json', '-q')).stdout).results[0];
  assert.equal(mp4.output, path.join(tmp, 'clip.mp4'));
  assert.equal(mp4.info.width % 2, 0, 'H.264 needs even sizes');

  assert.equal((await cli('animate', 'shots', '-q')).code, 2, 'refuses to overwrite');
  assert.equal((await cli('animate', 'shots', '--overwrite', '-q')).code, 0);
});

test('animate: usage errors', async () => {
  for (const args of [['shots/shot-1.png'], ['shots', '--delay', '100', '--fps', '5'], ['shots', '--format', 'avi'], ['shots', '--loop', '-1'], ['shots', '--background', 'red']]) {
    const { code, stderr } = await cli('animate', ...args);
    assert.equal(code, 2, args.join(' '));
    assert.match(stderr, /^compress-media: /);
  }
});

test('subtitles: your own file as a track or WebVTT, next to the input or in -o', async () => {
  fs.writeFileSync(path.join(tmp, 'clip.srt'), '1\n00:00:00,200 --> 00:00:01,500\nXin chào\n');
  const track = JSON.parse((await cli('subtitles', 'clip.mov', '--srt', 'clip.srt', '--embed', 'track', '--lang', 'vi', '--json', '-q')).stdout);
  assert.equal(track.ok, true, track.results[0].error);
  const r = track.results[0];
  assert.equal(r.output, path.join(tmp, 'clip-subtitled.mov'));
  assert.deepEqual([r.kind, r.info.cues, r.info.language, r.info.embed], ['subtitles', 1, 'vi', 'track']);
  assert.equal(r.options.text, undefined, 'the subtitle text is not repeated in the report');

  const vtt = JSON.parse((await cli('subtitles', 'clip.mov', '--srt', 'clip.srt', '--format', 'vtt', '-o', 'subs', '--json', '-q')).stdout).results[0];
  assert.equal(vtt.output, path.join(tmp, 'subs', 'clip.vtt'));
  assert.match(fs.readFileSync(vtt.output, 'utf8'), /^WEBVTT\n\n00:00:00\.200 --> 00:00:01\.500\nXin chào\n/);
  assert.equal((await cli('subtitles', 'clip.mov', '--srt', 'clip.srt', '--format', 'vtt', '-o', 'subs', '-q')).code, 1, 'refuses to overwrite');
  // clip.mov + clip.srt → clip.srt would replace the user's own file, even with --overwrite.
  const same = await cli('subtitles', 'clip.mov', '--srt', 'clip.srt', '--overwrite', '--json', '-q');
  assert.equal(same.code, 1);
  assert.match(JSON.parse(same.stdout).results[0].error, /would replace clip\.srt/);
  assert.match(fs.readFileSync(path.join(tmp, 'clip.srt'), 'utf8'), /Xin chào/, 'the user\'s file is untouched');

  const info = JSON.parse((await cli('info', '--json')).stdout);
  assert.ok('whisper' in info && 'burnSubtitles' in info);
  assert.ok(info.subtitleModels.some((m) => m.name === 'large-v3-turbo'));
  assert.equal(info.subtitleModel, 'small');
});

test('subtitles: usage errors', async () => {
  for (const args of [[], ['voice.wav', '--embed', 'sideways'], ['clip.mov', '--srt', 'missing.srt'], ['clip.mov', 'voice.wav', '--srt', 'clip.srt'],
    ['album/a.png'], ['clip.mov', '--lang', 'Vietnamese'], ['clip.mov', '--model', 'huge']]) {
    const { code, stderr } = await cli('subtitles', ...args);
    assert.equal(code, 2, args.join(' '));
    assert.match(stderr, /^compress-media: /);
  }
  // Audio has no picture to put subtitles on: that file fails (exit 1), with a reason.
  const { code, stdout } = await cli('subtitles', 'voice.wav', '--srt', 'clip.srt', '--embed', 'track', '--json', '-q');
  assert.equal(code, 1);
  assert.match(JSON.parse(stdout).results[0].error, /only be added to a video/);
});

test('video option validation', async () => {
  for (const args of [['--codec', 'vp9'], ['--video-format', 'webm', '--codec', 'h264'], ['--start', 'soon'], ['--start', '5', '--end', '2']]) {
    const { code, stderr } = await cli('clip.mov', ...args);
    assert.equal(code, 2, args.join(' '));
    assert.match(stderr, /^compress-media: /);
  }
});

test('refuses to overwrite an existing result unless --overwrite', async () => {
  const again = await cli('clip.mov', '--speed', 'fast', '-q');
  assert.equal(again.code, 1);
  const forced = await cli('clip.mov', '--speed', 'fast', '--overwrite', '-q');
  assert.equal(forced.code, 0);
});

test('walks folders recursively, mirrors them under --out-dir and avoids name clashes', async () => {
  const { code, stdout } = await cli('album', '-r', '-o', 'web', '--image-format', 'webp', '--max-dim', '600', '--json', '-q');
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.totals.done, 3); // readme.txt is ignored
  const outputs = report.results.map((r) => path.relative(tmp, r.output)).sort();
  assert.deepEqual(outputs, [
    path.join('web', 'a-jpg-compressed.webp'),
    path.join('web', 'a-png-compressed.webp'),
    path.join('web', 'nested', 'b-compressed.webp'),
  ]);
});

test('audio options: format, bitrate, mono and a custom suffix', async () => {
  const { code, stdout } = await cli('voice.wav', '--audio-format', 'opus', '--bitrate', '48', '--mono', '--suffix=-voice', '--json', '-q');
  assert.equal(code, 0);
  const [r] = JSON.parse(stdout).results;
  assert.equal(path.basename(r.output), 'voice-voice.ogg');
  assert.deepEqual(r.options, { format: 'opus', bitrate: 48, mono: true });
});

test('--skip-larger drops results that grew', async () => {
  // Re-encoding an already tiny WebP at maximum quality as PNG makes it bigger.
  await cli('album/a.png', '--image-format', 'webp', '--image-quality', '20', '--suffix=-tiny', '-q');
  const { code, stdout } = await cli('album/a-tiny.webp', '--image-format', 'png', '--image-quality', '100', '--skip-larger', '--json', '-q');
  assert.equal(code, 0);
  const [r] = JSON.parse(stdout).results;
  assert.equal(r.status, 'skipped');
  assert.equal(fs.existsSync(path.join(tmp, 'album', 'a-tiny-compressed.png')), false);
});

test('usage errors exit with code 2', async () => {
  for (const args of [[], ['clip.mov', '--codec', 'mpeg2'], ['missing.mov'], ['clip.mov', '--nope'], ['clip.mov', '--image-quality', '500']]) {
    const { code, stderr } = await cli(...args);
    assert.equal(code, 2, `args: ${args.join(' ')}`);
    assert.match(stderr, /^compress-media: /);
  }
});

test('failures are reported per file with exit code 1', async () => {
  fs.writeFileSync(path.join(tmp, 'broken.mp4'), 'not a video');
  const { code, stdout } = await cli('broken.mp4', 'voice.wav', '--json', '-q', '--overwrite');
  assert.equal(code, 1);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.results.map((r) => r.status), ['error', 'done']);
});
