const fs = require('node:fs');
const sharp = require('sharp');
const { test, expect, fixture, open, addFiles, row, waitDone, pick, download, serverConfig } = require('./helpers');

test.describe('images', () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: 'Image' }).click();
  });

  test('converts PNG to WebP and fits it within the max edge', async ({ page }, testInfo) => {
    await pick(page, 'image.format', 'webp');
    await page.getByLabel('Max long edge').selectOption('800');
    await addFiles(page, 'photo.png');

    const r = row(page, 'photo.png');
    await waitDone(r);
    await expect(r.locator('.meta')).toContainText('WebP · Q78 · ≤800px');

    const out = await download(page, r, testInfo);
    expect(out.name).toBe('photo-compressed.webp');
    const meta = await sharp(out.file).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width, meta.height)).toBe(800);
  });

  test('keeps the original format by default', async ({ page }, testInfo) => {
    await addFiles(page, 'photo.jpg');
    const r = row(page, 'photo.jpg');
    await waitDone(r);
    await expect(r.locator('.meta')).toContainText('Keep format');
    const out = await download(page, r, testInfo);
    expect(out.name).toBe('photo-compressed.jpg');
    expect(out.size).toBeLessThan(fs.statSync(fixture('photo.jpg')).size);
    expect((await sharp(out.file).metadata()).format).toBe('jpeg');
  });

  test('the quality slider drives the encoder quality', async ({ page }) => {
    const slider = page.getByRole('slider');
    await slider.fill('40');
    await expect(page.locator('#qOut')).toHaveText('40');
    await addFiles(page, 'photo.png');
    const r = row(page, 'photo.png');
    await waitDone(r);
    await expect(r.locator('.meta')).toContainText('Q40');
  });

  test('animated GIFs stay animated when converted to WebP', async ({ page }, testInfo) => {
    await pick(page, 'image.format', 'webp');
    await addFiles(page, 'anim.gif');
    const r = row(page, 'anim.gif');
    await waitDone(r);
    const meta = await sharp((await download(page, r, testInfo)).file, { animated: true }).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.pages).toBeGreaterThan(1);
  });

  test('HEIC photos become JPEG', async ({ page, request }, testInfo) => {
    test.skip(!(await serverConfig(request)).heicDecoder, 'server has no HEIC decoder');
    test.skip(!fs.existsSync(fixture('photo.heic')), 'HEIC fixture is only generated on macOS');
    await addFiles(page, 'photo.heic');
    const r = row(page, 'photo.heic');
    await waitDone(r);
    const out = await download(page, r, testInfo);
    expect(out.name).toBe('photo-compressed.jpg');
    expect((await sharp(out.file).metadata()).format).toBe('jpeg');
  });

  test('preview compares the original with the result', async ({ page }) => {
    await addFiles(page, 'photo.png');
    const r = row(page, 'photo.png');
    await waitDone(r);
    await r.getByRole('button', { name: 'View' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('figcaption')).toHaveText([/Original/, /Compressed/]);
    const images = dialog.locator('img');
    await expect(images).toHaveCount(2);
    for (const img of await images.all()) {
      await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Redo re-encodes with the current settings without re-uploading', async ({ page }, testInfo) => {
    await addFiles(page, 'photo.png');
    const r = row(page, 'photo.png');
    await waitDone(r);

    await pick(page, 'image.format', 'avif');
    let uploads = 0;
    page.on('request', (req) => { if (req.method() === 'POST' && /\/api\/(jobs|uploads)$/.test(req.url())) uploads++; });
    await r.getByRole('button', { name: 'Redo' }).click();
    await expect(r.locator('.meta')).toContainText('AVIF', { timeout: 60_000 });
    await waitDone(r);

    expect(uploads).toBe(0);
    const out = await download(page, r, testInfo);
    expect(out.name).toBe('photo-compressed.avif');
  });
});
