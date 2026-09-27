// Shared fixtures and helpers for the E2E specs.

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const base = require('@playwright/test');

const { expect } = base;
const FIXTURES = path.join(__dirname, '.fixtures');
const ffprobe = process.env.FFPROBE_PATH || require('@ffprobe-installer/ffprobe').path;

const fixture = (name) => path.join(FIXTURES, name);

/**
 * - Every test fails if the page throws or logs an error (network noise excluded).
 * - Jobs a test created are deleted afterwards, so a failed or slow test can't leave an
 *   ffmpeg process running that blocks the shared server's queue for the next tests.
 */
const test = base.test.extend({
  page: async ({ page }, use) => {
    const jobIds = new Set();
    page.on('response', async (res) => {
      // Jobs come from single-request uploads (POST /api/jobs) or chunked ones (…/complete).
      if (res.request().method() !== 'POST' || !/\/api\/(jobs|uploads\/[^/]+\/complete)$/.test(res.url()) || !res.ok()) return;
      try { jobIds.add((await res.json()).id); } catch { /* routed/mocked response */ }
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      // Expected HTTP errors in negative tests, and the web font when offline.
      if (/Failed to load resource|fonts\.(googleapis|gstatic)/.test(text)) return;
      errors.push(text);
    });
    await use(page);
    await Promise.all([...jobIds].map((id) => page.request.delete(`/api/jobs/${id}`).catch(() => {})));
    expect(errors, 'page errors').toEqual([]);
  },
});

/** Opens the app and waits until the server config has been applied. */
async function open(page) {
  const config = page.waitForResponse('**/api/config');
  await page.goto('/');
  await config;
  await expect(page.locator('#version')).not.toBeEmpty();
}

async function addFiles(page, ...names) {
  await page.locator('#fileInput').setInputFiles(names.map(fixture));
}

function row(page, name) {
  return page.locator('.row').filter({ has: page.locator('.name', { hasText: name }) });
}

// Raise on slow or heavily loaded machines, e.g. E2E_JOB_TIMEOUT=300000.
const JOB_TIMEOUT = Number(process.env.E2E_JOB_TIMEOUT) || 90_000;

async function waitDone(rowLocator, timeout = JOB_TIMEOUT) {
  await expect(rowLocator).toHaveAttribute('data-status', 'done', { timeout });
}

/** Clicks a segmented-control option, e.g. pick(page, 'video.codec', 'h265'). */
async function pick(page, name, value) {
  const button = page.locator(`.seg[data-name="${name}"] button[data-value="${value}"]`);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/** Clicks the row's Download link and saves the file; returns { name, file, size }. */
async function download(page, rowLocator, testInfo) {
  const [dl] = await Promise.all([page.waitForEvent('download'), rowLocator.getByRole('link', { name: 'Download' }).click()]);
  const name = dl.suggestedFilename();
  const file = testInfo.outputPath(name);
  await dl.saveAs(file);
  return { name, file, size: fs.statSync(file).size };
}

function probe(file) {
  const out = execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const data = JSON.parse(out.toString());
  const video = data.streams.find((s) => s.codec_type === 'video');
  const audio = data.streams.find((s) => s.codec_type === 'audio');
  const [n, d] = String(video?.avg_frame_rate || '0/1').split('/').map(Number);
  return { video, audio, fps: d ? n / d : 0, format: data.format };
}

async function serverConfig(request) {
  return (await request.get('/api/config')).json();
}

module.exports = { test, expect, fixture, open, addFiles, row, waitDone, pick, download, probe, serverConfig };
