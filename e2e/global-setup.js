// Generates the sample media used by the E2E tests (cached in e2e/.fixtures).

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ffmpeg = process.env.FFMPEG_PATH || require('ffmpeg-static');
const DIR = path.join(__dirname, '.fixtures');
const VERSION = '2'; // bump to regenerate after changing the recipes below

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

function hasGhostscript() {
  try {
    execFileSync(process.env.GS_PATH || 'gs', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

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
  // A 2-page PDF with a high-resolution photo scaled down on each page (like a CV or portfolio).
  if (hasGhostscript()) {
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=3200x2000', '-frames:v', '1', '-q:v', '1', path.join(DIR, 'big.jpg')]);
    fs.writeFileSync(path.join(DIR, 'doc.ps'), `<< /PageSize [595 842] >> setpagedevice
1 1 2 { pop /DeviceRGB setcolorspace gsave 20 420 translate 555 347 scale
  << /ImageType 1 /Width 3200 /Height 2000 /BitsPerComponent 8 /Decode [0 1 0 1 0 1]
     /ImageMatrix [3200 0 0 -2000 0 2000] /DataSource (big.jpg) (r) file /DCTDecode filter >> image
  grestore /Helvetica findfont 18 scalefont setfont 40 380 moveto (Compress Media sample) show showpage } for
`);
    execFileSync(process.env.GS_PATH || 'gs', ['-q', '-dBATCH', '-dNOPAUSE', '-dNOSAFER', '-sDEVICE=pdfwrite', '-dPDFSETTINGS=/prepress',
      '-dPassThroughJPEGImages=true', '-o', 'doc.pdf', 'doc.ps'], { cwd: DIR });
    fs.rmSync(path.join(DIR, 'big.jpg'));
    fs.rmSync(path.join(DIR, 'doc.ps'));
  }
  if (process.platform === 'darwin') {
    execFileSync('sips', ['-s', 'format', 'heic', path.join(DIR, 'photo.png'), '--out', path.join(DIR, 'photo.heic')], { stdio: 'ignore' });
  }
  fs.writeFileSync(stamp, '');
};
