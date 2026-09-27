const fs = require('node:fs');
const { test, expect, fixture, open, addFiles, row, waitDone, pick, download, probe } = require('./helpers');

test.describe('video', () => {
  test.beforeEach(async ({ page }) => open(page));

  test('compresses a QuickTime recording to a smaller, downscaled MP4', async ({ page }, testInfo) => {
    await page.getByLabel('Max resolution').selectOption('720');
    await page.getByLabel('Max FPS').selectOption('30');
    await addFiles(page, 'clip.mov');

    const r = row(page, 'clip.mov');
    await waitDone(r);
    await expect(r.locator('.meta')).toContainText('H.264 · Balanced · 720p · 30fps');
    await expect(r.locator('.badge')).toHaveText(/^−\d+%$/);

    const out = await download(page, r, testInfo);
    expect(out.name).toBe('clip-compressed.mp4');
    expect(out.size).toBeLessThan(fs.statSync(fixture('clip.mov')).size);

    const { video, audio, fps } = probe(out.file);
    expect(video.codec_name).toBe('h264');
    expect(video.height).toBe(720);
    expect(Math.round(fps)).toBe(30);
    expect(audio.codec_name).toBe('aac');
  });

  test('H.265 without audio is tagged hvc1 for Apple playback', async ({ page }, testInfo) => {
    await pick(page, 'video.codec', 'h265');
    await pick(page, 'video.speed', 'veryfast');
    await pick(page, 'video.audio', 'remove');
    await page.getByLabel('Max resolution').selectOption('480');
    await addFiles(page, 'clip.mov');

    const r = row(page, 'clip.mov');
    await waitDone(r);
    await expect(r.locator('.meta')).toContainText('H.265');
    await expect(r.locator('.meta')).toContainText('no audio');

    const { video, audio } = probe((await download(page, r, testInfo)).file);
    expect(video.codec_name).toBe('hevc');
    expect(video.codec_tag_string).toBe('hvc1');
    expect(audio).toBeUndefined();
  });

  test('target-size mode lands close to the requested size', async ({ page }, testInfo) => {
    const target = page.getByRole('spinbutton');
    await expect(target).toBeHidden();
    await pick(page, 'video.quality', 'target');
    await expect(target).toBeVisible();
    await target.fill('1');
    await pick(page, 'video.speed', 'veryfast');
    await page.getByLabel('Max resolution').selectOption('720');
    await addFiles(page, 'clip.mov');

    const r = row(page, 'clip.mov');
    await waitDone(r);
    await expect(r.locator('.meta')).toContainText('≈1 MB');
    const { size } = await download(page, r, testInfo);
    expect(size).toBeLessThan(1.1 * 1024 * 1024);
    expect(size).toBeGreaterThan(0.5 * 1024 * 1024);
  });

  test('a running job can be cancelled and redone with new settings', async ({ page }, testInfo) => {
    // Deliberately slow settings so the job is still running when we cancel.
    await pick(page, 'video.codec', 'h265');
    await pick(page, 'video.quality', 'high');
    await pick(page, 'video.speed', 'slow');
    await addFiles(page, 'long.mp4');

    const r = row(page, 'long.mp4');
    // Regression: progress polling must not re-create the buttons, or clicks get swallowed.
    const cancel = await r.getByRole('button', { name: 'Cancel' }).elementHandle();
    await expect(r.locator('.meta')).toContainText(/Compressing [1-9]/, { timeout: 60_000 });
    expect(await cancel.evaluate((el) => el.isConnected)).toBe(true);

    await r.getByRole('button', { name: 'Cancel' }).click();
    await expect(r).toHaveAttribute('data-status', 'cancelled');
    await expect(r.locator('.meta')).toContainText('Cancelled');

    await pick(page, 'video.codec', 'h264');
    await pick(page, 'video.quality', 'tiny');
    await pick(page, 'video.speed', 'veryfast');
    await page.getByLabel('Max resolution').selectOption('480');
    await r.getByRole('button', { name: 'Redo' }).click();

    await waitDone(r);
    await expect(r.locator('.meta')).toContainText('H.264 · Tiny · 480p');
    const { video } = probe((await download(page, r, testInfo)).file);
    expect(video.height).toBe(480);
  });
});

test.describe('hardware encoder option', () => {
  for (const hardwareEncoder of [true, false]) {
    test(`is ${hardwareEncoder ? 'shown' : 'hidden'} when the server ${hardwareEncoder ? 'supports' : 'lacks'} it`, async ({ page }) => {
      await page.route('**/api/config', async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), hardwareEncoder } });
      });
      await open(page);
      const option = page.getByRole('button', { name: 'Apple hardware' });
      if (hardwareEncoder) await expect(option).toBeVisible();
      else await expect(option).toBeHidden();
    });
  }
});
