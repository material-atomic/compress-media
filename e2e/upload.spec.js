// Chunked, resumable uploads. Works for STORAGE=local (parts PUT to /api/uploads/:id/parts/:n)
// and STORAGE=s3 (parts PUT to presigned bucket URLs with ?partNumber=n).

const { test, expect, open, addFiles, row, waitDone } = require('./helpers');

/** Part number of a part upload request, or null for anything else. */
function partNumber(request) {
  if (request.method() !== 'PUT') return null;
  const url = new URL(request.url());
  const n = url.pathname.match(/\/api\/uploads\/[^/]+\/parts\/(\d+)$/)?.[1] ?? url.searchParams.get('partNumber');
  return n ? Number(n) : null;
}

/** Counts successful part uploads per part number. */
function trackParts(page) {
  const done = new Map();
  page.on('requestfinished', async (req) => {
    const n = partNumber(req);
    if (n && (await req.response())?.ok()) done.set(n, (done.get(n) || 0) + 1);
  });
  return done;
}

test.describe('chunked upload', () => {
  test.beforeEach(async ({ page }) => open(page));

  test('a failing part is retried transparently', async ({ page }) => {
    let failed = 0;
    await page.route((url) => /parts\/1$|partNumber=1(&|$)/.test(url.href), async (route) => {
      if (route.request().method() === 'PUT' && failed++ === 0) return route.fulfill({ status: 503, body: 'try again' });
      return route.fallback();
    });
    const parts = trackParts(page);
    await addFiles(page, 'clip.mov');
    await waitDone(row(page, 'clip.mov'));
    expect(failed).toBeGreaterThanOrEqual(2); // one refusal + the successful retry
    expect(parts.get(1)).toBe(1);
  });

  test('after the network drops, Resume sends only the missing parts', async ({ page }) => {
    // Part 2 keeps failing at the network level until we "reconnect".
    let offline = true;
    await page.route((url) => /parts\/2$|partNumber=2(&|$)/.test(url.href), (route) =>
      offline && route.request().method() === 'PUT' ? route.abort('internetdisconnected') : route.fallback());
    const parts = trackParts(page);
    await addFiles(page, 'clip.mov');

    const r = row(page, 'clip.mov');
    await expect(r).toHaveAttribute('data-status', 'error', { timeout: 30_000 }); // after the retries
    await expect(r.locator('.meta')).toContainText('Upload interrupted');
    expect(parts.get(1)).toBe(1);

    offline = false;
    await r.getByRole('button', { name: 'Resume' }).click();
    await waitDone(r);
    expect(parts.get(1)).toBe(1); // not uploaded again
    expect(parts.get(2)).toBe(1);
  });

  test('re-adding the same file after a reload resumes the upload', async ({ page }) => {
    // Hold the last part back so the upload can't finish before we reload.
    await page.route((url) => /parts\/3$|partNumber=3(&|$)/.test(url.href), (route) =>
      route.request().method() === 'PUT' ? route.abort('internetdisconnected') : route.fallback());
    const before = trackParts(page);
    await addFiles(page, 'clip.mov');
    await expect.poll(() => (before.get(1) || 0) + (before.get(2) || 0), { timeout: 30_000 }).toBe(2);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await open(page); // reload: the in-memory upload state is gone, localStorage remembers it
    const after = trackParts(page);
    await addFiles(page, 'clip.mov');
    await waitDone(row(page, 'clip.mov'));
    expect(after.get(1)).toBeUndefined();
    expect(after.get(2)).toBeUndefined();
    expect(after.get(3)).toBe(1);
  });

  test('removing a row mid-upload aborts it on the server', async ({ page, request }) => {
    await page.route((url) => /parts\/\d+$|partNumber=\d+/.test(url.href), (route) =>
      route.request().method() === 'PUT' ? new Promise(() => {}) : route.fallback()); // parts hang forever
    const created = page.waitForResponse((res) => res.url().endsWith('/api/uploads') && res.request().method() === 'POST');
    await addFiles(page, 'clip.mov');
    const { uploadId } = await (await created).json();

    await row(page, 'clip.mov').getByRole('button', { name: 'Remove from list' }).click();
    await expect.poll(async () => (await request.get(`/api/uploads/${uploadId}`)).status()).toBe(404);
  });
});
