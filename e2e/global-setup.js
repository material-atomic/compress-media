// Generates the sample media used by the E2E tests (cached in e2e/.fixtures).

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ffmpeg = process.env.FFMPEG_PATH || require('ffmpeg-static');
const DIR = path.join(__dirname, '.fixtures');
const VERSION = '1'; // bump to regenerate after changing the recipes below

const RECIPES = {
  // A high-bitrate 60 fps "screen recording" with audio, like QuickTime produces.
  'clip.mov': ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '3', '-c:v', 'libx264', '-crf', '10', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le'],
  // Long enough that a slow H.265 encode can be cancelled mid-way.
  'long.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast'],
  'photo.png': ['-f', 'lavfi', '-i', 'testsrc2=size=1600x1000', '-frames:v', '1'],
  'photo.jpg': ['-f', 'lavfi', '-i', 'testsrc2=size=1600x1000', '-frames:v', '1', '-q:v', '1'],
  'anim.gif': ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10', '-t', '2'],
  'voice.wav': ['-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '5'],
};

module.exports = async function globalSetup() {
  const stamp = path.join(DIR, `.v${VERSION}`);
  if (fs.existsSync(stamp)) return;
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  for (const [name, args] of Object.entries(RECIPES)) {
    execFileSync(ffmpeg, ['-v', 'error', '-y', ...args, path.join(DIR, name)]);
  }
  fs.copyFileSync(path.join(DIR, 'photo.png'), path.join(DIR, 'Ảnh chụp màn hình.png'));
  fs.writeFileSync(path.join(DIR, 'notes.txt'), 'not media');
  if (process.platform === 'darwin') {
    execFileSync('sips', ['-s', 'format', 'heic', path.join(DIR, 'photo.png'), '--out', path.join(DIR, 'photo.heic')], { stdio: 'ignore' });
  }
  fs.writeFileSync(stamp, '');
};
