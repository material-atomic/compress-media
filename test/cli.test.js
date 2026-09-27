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

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

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
  for (const args of [[], ['clip.mov', '--codec', 'av1'], ['missing.mov'], ['clip.mov', '--nope'], ['clip.mov', '--image-quality', '500']]) {
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
