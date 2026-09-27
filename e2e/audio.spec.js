const { test, expect, open, addFiles, row, waitDone, pick, download, probe } = require('./helpers');

test.describe('audio', () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
    await page.getByRole('tab', { name: 'Audio' }).click();
  });

  test('WAV to a mono 64 kbps MP3', async ({ page }, testInfo) => {
    await page.getByLabel('Bitrate').selectOption('64');
    await page.getByLabel(/Convert to mono/).check();
    await addFiles(page, 'voice.wav');

    const r = row(page, 'voice.wav');
    await waitDone(r);
    await expect(r.locator('.meta')).toContainText('MP3 · 64 kbps · mono');

    const out = await download(page, r, testInfo);
    expect(out.name).toBe('voice-compressed.mp3');
    const { audio } = probe(out.file);
    expect(audio.codec_name).toBe('mp3');
    expect(audio.channels).toBe(1);
  });

  test('WAV to Opus in an Ogg container', async ({ page }, testInfo) => {
    await pick(page, 'audio.format', 'opus');
    await addFiles(page, 'voice.wav');
    const r = row(page, 'voice.wav');
    await waitDone(r);
    const out = await download(page, r, testInfo);
    expect(out.name).toBe('voice-compressed.ogg');
    expect(probe(out.file).audio.codec_name).toBe('opus');
  });
});
