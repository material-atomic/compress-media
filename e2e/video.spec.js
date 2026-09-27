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

test.describe('video formats', () => {
  test.beforeEach(async ({ page }) => open(page));

  test('trims a clip into an animated GIF', async ({ page }, testInfo) => {
    await pick(page, 'video.format', 'gif');
    await expect(page.getByRole('button', { name: 'Target MB' })).toBeHidden();
    await expect(page.getByText('Audio track')).toBeHidden();
    await page.getByLabel('Start').fill('0.5');
    await page.getByLabel('End').fill('0:02');
    await addFiles(page, 'clip.mov');

    const r = row(page, 'clip.mov');
    await waitDone(r);
    await expect(r.locator('.meta')).toContainText('GIF');
    await expect(r.locator('.meta')).toContainText('✂ 0.5–0:02');
    const out = await download(page, r, testInfo);
    expect(out.name).toBe('clip-compressed.gif');
    const { video, format } = probe(out.file);
    expect(video.codec_name).toBe('gif');
    expect(video.height).toBe(480);
    expect(Number(format.duration)).toBeGreaterThan(1.3);
    expect(Number(format.duration)).toBeLessThan(1.7);
  });

  test('WebM uses VP9 and Opus', async ({ page }, testInfo) => {
    const cfg = await (await page.request.get('/api/config')).json();
    test.skip(!cfg.webm, 'server ffmpeg has no VP9/Opus');
    await pick(page, 'video.format', 'webm');
    await expect(page.locator('.seg[data-name="video.codec"] button[data-value="vp9"]').first()).toHaveAttribute('aria-pressed', 'true');
    await pick(page, 'video.speed', 'veryfast');
    await page.getByLabel('Max resolution').selectOption('360');
    await addFiles(page, 'clip.mov');

    const r = row(page, 'clip.mov');
    await waitDone(r);
    const out = await download(page, r, testInfo);
    expect(out.name).toBe('clip-compressed.webm');
    const { video, audio } = probe(out.file);
    expect(video.codec_name).toBe('vp9');
    expect(audio.codec_name).toBe('opus');
  });

  test('AV1 in MP4 when the server supports it', async ({ page }, testInfo) => {
    const cfg = await (await page.request.get('/api/config')).json();
    test.skip(!cfg.av1, 'server ffmpeg has no AV1 encoder');
    await pick(page, 'video.codec', 'av1');
    await pick(page, 'video.speed', 'veryfast');
    await page.getByLabel('Max resolution').selectOption('360');
    await addFiles(page, 'clip.mov');
    const r = row(page, 'clip.mov');
    await waitDone(r);
    await expect(r.locator('.meta')).toContainText('AV1');
    const { video } = probe((await download(page, r, testInfo)).file);
    expect(video.codec_name).toBe('av1');
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
      const option = page.getByRole('button', { name: /^Hardware/ });
      if (hardwareEncoder) await expect(option).toBeVisible();
      else await expect(option).toBeHidden();
    });
  }
});
