const fs = require('node:fs');
const { test, expect, fixture, open, addFiles, row, waitDone, pick, download } = require('./helpers');

test.describe('file list', () => {
  test.beforeEach(async ({ page }) => open(page));

  test('batch upload shows a summary and "Download all" saves one ZIP with every result', async ({ page }, testInfo) => {
    await addFiles(page, 'photo.png', 'photo.jpg', 'voice.wav');
    for (const name of ['photo.png', 'photo.jpg', 'voice.wav']) await waitDone(row(page, name));

    const summary = page.locator('.summary-text');
    await expect(summary).toContainText('3 done');
    await expect(summary).toContainText(/saved .+ \(\d+%\)/);

    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download all (ZIP)' }).click()]);
    expect(dl.suggestedFilename()).toMatch(/^compressed-\d{4}-\d{2}-\d{2}\.zip$/);
    const file = testInfo.outputPath('all.zip');
    await dl.saveAs(file);
    const zip = fs.readFileSync(file);
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    // Stored (uncompressed) entries: every file name appears in the archive.
    for (const name of ['photo-compressed.png', 'photo-compressed.jpg', 'voice-compressed.mp3']) {
      expect(zip.includes(Buffer.from(name))).toBe(true);
    }
  });

  test('files can be dropped onto the page', async ({ page }) => {
    const bytes = fs.readFileSync(fixture('photo.png')).toString('base64');
    const dataTransfer = await page.evaluateHandle((b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin], 'dropped.png', { type: 'image/png' }));
      return dt;
    }, bytes);

    const drop = page.locator('#drop');
    await drop.dispatchEvent('dragenter', { dataTransfer });
    await expect(drop).toHaveClass(/over/);
    await drop.dispatchEvent('drop', { dataTransfer });
    await expect(drop).not.toHaveClass(/over/);
    await waitDone(row(page, 'dropped.png'));
  });

  test('unsupported files are rejected without uploading', async ({ page }) => {
    let uploads = 0;
    page.on('request', (req) => { if (/\/api\/(jobs|uploads)/.test(req.url())) uploads++; });
    await addFiles(page, 'notes.txt');
    const r = row(page, 'notes.txt');
    await expect(r).toHaveAttribute('data-status', 'error');
    await expect(r.locator('.meta')).toHaveText('This file type is not supported');
    expect(uploads).toBe(0);
  });

  test('server errors are shown on the row', async ({ page }) => {
    await page.route('**/api/uploads', (route) => route.fulfill({ status: 507, json: { error: 'Disk is full' } }));
    await addFiles(page, 'photo.png');
    const r = row(page, 'photo.png');
    await expect(r).toHaveAttribute('data-status', 'error');
    await expect(r.locator('.meta')).toHaveText('Disk is full');
  });

  test('removing a row deletes the job and its files on the server', async ({ page }) => {
    const created = page.waitForResponse((res) => /\/api\/(jobs|uploads\/[^/]+\/complete)$/.test(res.url()) && res.request().method() === 'POST');
    await addFiles(page, 'photo.png');
    const { id } = await (await created).json();
    const r = row(page, 'photo.png');
    await waitDone(r);

    await r.getByRole('button', { name: 'Remove from list' }).click();
    await expect(r).toHaveCount(0);
    await expect.poll(async () => (await page.request.get(`/api/jobs/${id}`)).status()).toBe(404);
  });

  test('"Clear list" removes finished rows and hides the summary', async ({ page }) => {
    await addFiles(page, 'photo.png', 'photo.jpg');
    await waitDone(row(page, 'photo.png'));
    await waitDone(row(page, 'photo.jpg'));
    await page.getByRole('button', { name: 'Clear list' }).click();
    await expect(page.locator('.row')).toHaveCount(0);
    await expect(page.locator('#summary')).toBeHidden();
  });

  test('non-ASCII filenames survive the round trip', async ({ page }, testInfo) => {
    await addFiles(page, 'Ảnh chụp màn hình.png');
    const r = row(page, 'Ảnh chụp màn hình.png'.normalize('NFC'));
    await waitDone(r);
    const out = await download(page, r, testInfo);
    expect(out.name.normalize('NFC')).toBe('Ảnh chụp màn hình-compressed.png'.normalize('NFC'));
  });
});

test.describe('settings', () => {
  test('are remembered across reloads', async ({ page }) => {
    await open(page);
    await pick(page, 'video.codec', 'h265');
    await page.getByLabel('Max resolution').selectOption('720');
    await page.getByRole('tab', { name: 'Image' }).click();
    await pick(page, 'image.format', 'webp');

    await open(page);
    await expect(page.locator('.seg[data-name="video.codec"] button[data-value="h265"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Max resolution')).toHaveValue('720');
    await page.getByRole('tab', { name: 'Image' }).click();
    await expect(page.locator('.seg[data-name="image.format"] button[data-value="webp"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('hints follow the selected option', async ({ page }) => {
    await open(page);
    await expect(page.getByText('Plays everywhere')).toBeVisible();
    await pick(page, 'video.codec', 'h265');
    await expect(page.getByText('Plays everywhere')).toBeHidden();
    await expect(page.getByText('30–50% smaller than H.264')).toBeVisible();
  });
});

test.describe('language', () => {
  test('switches to Vietnamese, including rendered rows, and remembers it', async ({ page }) => {
    await open(page);
    await addFiles(page, 'photo.png');
    const r = row(page, 'photo.png');
    await waitDone(r);

    await page.getByRole('button', { name: 'VI', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
    await expect(page.getByText('Kéo thả file vào đây')).toBeVisible();
    await expect(r.getByRole('link', { name: 'Tải về' })).toBeVisible();
    await expect(page.locator('.summary-text')).toContainText('1 file xong');

    await open(page);
    await expect(page.getByText('Kéo thả file vào đây')).toBeVisible();
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByText('Drop files here')).toBeVisible();
  });

  test.describe('with a Vietnamese browser', () => {
    test.use({ locale: 'vi-VN' });
    test('defaults to Vietnamese', async ({ page }) => {
      await open(page);
      await expect(page.getByRole('tab', { name: 'Âm thanh' })).toBeVisible();
    });
  });
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('fits the screen without horizontal scrolling', async ({ page }) => {
    await open(page);
    await addFiles(page, 'photo.png');
    const r = row(page, 'photo.png');
    await waitDone(r);
    await r.scrollIntoViewIfNeeded();
    await expect(r.getByRole('link', { name: 'Download' })).toBeInViewport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
