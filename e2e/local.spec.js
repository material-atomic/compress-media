// "Compress on: This browser" — WebCodecs via local.js. Nothing may be uploaded, and whatever a
// browser can't do must fall back to the server with a note.

const { test, expect, open, addFiles, row, waitDone, pick, download, probe } = require('./helpers');

/** Records requests that would upload file data to the server. */
function trackUploads(page) {
  const uploads = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/api\/(jobs|uploads)$/.test(new URL(req.url()).pathname)) uploads.push(req.url());
    if (req.method() === 'PUT') uploads.push(req.url());
  });
  return uploads;
}

test.describe('in-browser compression', () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
    await pick(page, 'general.where', 'browser');
  });

  test('a video is compressed on the device, never uploaded', async ({ page }, testInfo) => {
    const uploads = trackUploads(page);
    await page.getByLabel('Max resolution').selectOption('360');
    await pick(page, 'video.audio', 'remove'); // Firefox has no AAC encoder; keep this test about video
    await addFiles(page, 'clip.mov');

    const r = row(page, 'clip.mov');
    await waitDone(r);
    await expect(r.locator('.meta')).toContainText('in browser');
    expect(uploads).toEqual([]);

    const out = await download(page, r, testInfo);
    expect(out.name).toBe('clip-compressed.mp4');
    const { video, audio } = probe(out.file);
    expect(video.codec_name).toBe('h264');
    expect(video.height).toBe(360);
    expect(audio).toBeUndefined();
  });

  test('trimming works in the browser too', async ({ page }, testInfo) => {
    await page.getByLabel('Max resolution').selectOption('360');
    await pick(page, 'video.audio', 'remove');
    await page.getByLabel('Start').fill('1');
    await page.getByLabel('End').fill('2');
    await addFiles(page, 'clip.mov');
    const r = row(page, 'clip.mov');
    await waitDone(r);
    const { format } = probe((await download(page, r, testInfo)).file);
    expect(Number(format.duration)).toBeGreaterThan(0.8);
    expect(Number(format.duration)).toBeLessThan(1.3);
  });

  test('images become WebP on the device, or fall back where the browser can\'t encode WebP', async ({ page, browserName }, testInfo) => {
    const uploads = trackUploads(page);
    await page.getByRole('tab', { name: 'Image' }).click();
    await pick(page, 'image.format', 'webp');
    await page.getByLabel('Max long edge').selectOption('800');
    await addFiles(page, 'photo.jpg');

    const r = row(page, 'photo.jpg');
    await waitDone(r);
    const out = await download(page, r, testInfo);
    expect(out.name).toBe('photo-compressed.webp');
    if (browserName === 'webkit') {
      // Safari's canvas can't encode WebP: the server did it, and the row says so.
      await expect(r.locator('.note')).toContainText("can't encode WEBP");
      expect(uploads.length).toBeGreaterThan(0);
    } else {
      await expect(r.locator('.meta')).toContainText('in browser');
      expect(uploads).toEqual([]);
    }
  });

  test('work the browser can\'t do (GIF) goes to the server with a note', async ({ page }) => {
    await pick(page, 'video.format', 'gif');
    await addFiles(page, 'clip.mov');
    const r = row(page, 'clip.mov');
    await waitDone(r);
    await expect(r.locator('.note')).toContainText('GIF needs the server');
    await expect(r.locator('.meta')).not.toContainText('in browser');
  });

  test('Redo re-runs in the browser with the new settings', async ({ page }, testInfo) => {
    await page.getByLabel('Max resolution').selectOption('360');
    await pick(page, 'video.audio', 'remove');
    await addFiles(page, 'clip.mov');
    const r = row(page, 'clip.mov');
    await waitDone(r);

    await page.getByLabel('Max resolution').selectOption('480');
    await r.getByRole('button', { name: 'Redo' }).click();
    await waitDone(r);
    const { video } = probe((await download(page, r, testInfo)).file);
    expect(video.height).toBe(480);
  });
});
