// @ts-check
const path = require('node:path');
const os = require('node:os');
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT) || 4790;
// Point at an already running instance (e.g. the Docker container) instead of starting one.
const EXTERNAL = process.env.E2E_BASE_URL;
const BASE_URL = EXTERNAL || `http://127.0.0.1:${PORT}`;
const CI = !!process.env.CI;

module.exports = defineConfig({
  testDir: './e2e',
  globalSetup: require.resolve('./e2e/global-setup.js'),
  timeout: Math.max(120_000, (Number(process.env.E2E_JOB_TIMEOUT) || 0) + 60_000),
  expect: { timeout: 15_000 },
  // One server with a serial media queue is shared by all workers; keep contention low.
  workers: CI ? 2 : 3,
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    locale: 'en-US',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: EXTERNAL
    ? undefined
    : {
        command: 'node server.js',
        url: `${BASE_URL}/api/health`,
        reuseExistingServer: false,
        timeout: 30_000,
        env: {
          PORT: String(PORT),
          HOST: '127.0.0.1',
          WORK_DIR: path.join(os.tmpdir(), 'compress-media-e2e'),
          // One video job per worker, so parallel tests don't wait on each other's encodes.
          MEDIA_CONCURRENCY: '3',
        },
      },
});
