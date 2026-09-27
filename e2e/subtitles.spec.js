// "Subtitles": speech → SRT/VTT, or your own subtitles → a video. Always made on the server.

const fs = require('node:fs');
const { test, expect, open, addFiles, row, waitDone, pick, download, probe, serverConfig, fixture } = require('./helpers');

async function subtitlesMode(page) {
  await page.locator('[data-mode="subtitles"]').click();
  await expect(page.locator('[data-tab="subtitles"]')).toHaveAttribute('aria-selected', 'true');
}

test.describe('subtitles', () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
    await subtitlesMode(page);
  });

  test('your own .srt with the same name becomes a subtitle track', async ({ page }, testInfo) => {
    await pick(page, 'subtitles.embed', 'track');
    await addFiles(page, 'clip.mov', 'clip.srt');
    const r = row(page, 'clip.mov');
    await waitDone(r);
    await expect(r.locator('.meta')).toContainText('2 subtitles');
    await expect(r.locator('.meta')).toContainText('Using clip.srt');
    const out = await download(page, r, testInfo);
    expect(out.name).toBe('clip-subtitled.mov');
    const { video } = probe(out.file);
    expect(video.codec_name).toBe('h264');
    // The SRT is offered too, next to the video.
    const [dl] = await Promise.all([page.waitForEvent('download'), r.getByRole('link', { name: 'SRT' }).click()]);
    expect(dl.suggestedFilename()).toBe('clip.srt');
  });

  test('edit the subtitles, preview them, and save a new result', async ({ page }, testInfo) => {
    await addFiles(page, 'clip.mov', 'clip.srt');
    const r = row(page, 'clip.mov');
    await waitDone(r);

    await r.getByRole('button', { name: 'View & edit' }).click();
    const editor = page.getByRole('textbox', { name: 'View & edit' });
    await expect(editor).toHaveValue(/Xin chào mọi người/);
    await expect(page.locator('#previewBody video track')).toHaveCount(1);
    await editor.fill((await editor.inputValue()).replace('Hello everyone', 'Chào cả nhà'));
    await page.getByRole('button', { name: 'Preview changes' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#preview')).not.toBeVisible();

    await waitDone(r);
    await expect(r.locator('.meta')).toContainText('Edited subtitles');
    const out = await download(page, r, testInfo);
    expect(out.name).toBe('clip.srt');
    const text = fs.readFileSync(out.file, 'utf8');
    expect(text).toContain('Chào cả nhà');
    expect(text).not.toContain('Hello everyone');
  });

  test('a subtitle file without its video is refused, and other files too', async ({ page }) => {
    await addFiles(page, 'orphan.srt', 'photo.png');
    await expect(row(page, 'orphan.srt').locator('.err')).toContainText('No video with the same name');
    await expect(row(page, 'photo.png').locator('.err')).toContainText('need a video or audio file');
  });

  test('speech becomes subtitles (whisper.cpp, when installed)', async ({ page }, testInfo) => {
    const cfg = await serverConfig(page);
    test.skip(!cfg.whisper, 'whisper.cpp is not installed on the server');
    test.skip(!fs.existsSync(fixture('talk.mov')), 'no text-to-speech to make the test voice');
    await page.getByLabel('Accuracy (speech model)').selectOption('tiny');
    await addFiles(page, 'talk.mov');
    const r = row(page, 'talk.mov');
    await waitDone(r, 300_000); // the first run downloads the model
    await expect(r.locator('.meta')).toContainText('English');
    const out = await download(page, r, testInfo);
    expect(out.name).toBe('talk.en.srt');
    expect(fs.readFileSync(out.file, 'utf8').toLowerCase()).toContain('screen recording');
  });

  test('the Subtitles tab replaces the compression tabs', async ({ page }) => {
    await expect(page.getByRole('tab', { name: 'Video' })).toBeHidden();
    await expect(page.locator('[data-panel="subtitles"]')).toBeVisible();
    await page.getByRole('tab', { name: 'Compress files' }).click();
    await expect(page.getByRole('tab', { name: 'Video' })).toHaveAttribute('aria-selected', 'true');
  });
});
