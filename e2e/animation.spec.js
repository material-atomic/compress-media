// "Make an animation": still images → one animated GIF/WebP/MP4, made on the server.

const { test, expect, open, addFiles, row, waitDone, pick, download, probe } = require('./helpers');

async function animateMode(page) {
  await page.getByRole('tab', { name: 'Make an animation' }).click();
  await expect(page.locator('#animator')).toBeVisible();
}

const frameNames = (page) => page.locator('#frames .frame').evaluateAll((els) => els.map((e) => e.title));

test.describe('make an animation', () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
    await animateMode(page);
  });

  test('frames can be reordered and removed before creating', async ({ page }) => {
    const create = page.getByRole('button', { name: 'Create animation' });
    await addFiles(page, 'frame-1.png');
    await expect(create).toBeDisabled(); // needs at least 2
    await addFiles(page, 'frame-2.png', 'frame-3.png', 'voice.wav'); // not an image: skipped
    await expect(page.locator('#framesInfo')).toContainText('3 frames');
    await expect(create).toBeEnabled();

    const frames = page.locator('#frames .frame');
    await frames.nth(2).getByRole('button', { name: 'Move earlier' }).click();
    expect(await frameNames(page)).toEqual(['frame-1.png', 'frame-3.png', 'frame-2.png']);
    await frames.nth(0).dragTo(frames.nth(2));
    expect(await frameNames(page)).toEqual(['frame-3.png', 'frame-2.png', 'frame-1.png']);
    await frames.nth(1).getByRole('button', { name: 'Remove frame' }).click();
    expect(await frameNames(page)).toEqual(['frame-3.png', 'frame-1.png']);
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(frames).toHaveCount(0);
    await expect(create).toBeDisabled();
  });

  test('creates an animated GIF in the chosen order', async ({ page }, testInfo) => {
    await page.getByLabel('Each frame (ms)').fill('250');
    await addFiles(page, 'frame-1.png', 'frame-2.png', 'frame-3.png');
    await page.getByRole('button', { name: 'Create animation' }).click();
    await expect(page.locator('#frames .frame')).toHaveCount(0); // the strip is emptied for the next one

    const r = row(page, 'frame-1.png +2');
    await waitDone(r);
    await expect(r.locator('.meta')).toContainText('GIF · 250 ms');
    const out = await download(page, r, testInfo);
    expect(out.name).toBe('frame-1-animated.gif');
    const { video, format } = probe(out.file);
    expect(video.codec_name).toBe('gif');
    expect([video.width, video.height]).toEqual([400, 300]); // the first frame's shape
    expect(Number(format.duration)).toBeCloseTo(0.75, 1);
  });

  test('MP4 output, and Redo applies new settings', async ({ page }, testInfo) => {
    await pick(page, 'animation.format', 'mp4');
    await addFiles(page, 'frame-1.png', 'frame-2.png');
    await page.getByRole('button', { name: 'Create animation' }).click();
    const r = row(page, 'frame-1.png +1');
    await waitDone(r);
    let out = await download(page, r, testInfo);
    expect(out.name).toBe('frame-1-animated.mp4');
    expect(probe(out.file).video.codec_name).toBe('h264');

    await r.getByRole('button', { name: 'View' }).click();
    await expect(page.locator('#previewBody video')).toHaveCount(1);
    await page.getByRole('button', { name: 'Close' }).click();

    await pick(page, 'animation.format', 'webp');
    await r.getByRole('button', { name: 'Redo' }).click();
    await waitDone(r);
    out = await download(page, r, testInfo);
    expect(out.name).toBe('frame-1-animated.webp');
  });

  test('the mode and the animation tab follow each other', async ({ page }) => {
    await expect(page.getByRole('tab', { name: 'Animation', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Video' })).toBeHidden();
    await page.getByRole('tab', { name: 'Compress files' }).click();
    await expect(page.locator('#animator')).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Video' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Animation', exact: true })).toBeHidden();
  });
});
