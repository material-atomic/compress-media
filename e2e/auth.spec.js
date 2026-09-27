const { test, expect, open, USERNAME, PASSWORD } = require('./helpers');

test.describe('login', () => {
  test('the app asks for a login, rejects a wrong password and signs in', async ({ page }) => {
    await page.goto('/');
    const form = page.locator('#loginForm');
    await expect(form).toBeVisible();
    await expect(page.locator('#drop')).toBeHidden();

    await form.getByLabel('Username or email').fill(USERNAME);
    await form.getByLabel('Password').fill('not-the-password');
    await form.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#loginError')).toHaveText('Wrong username or password');

    await form.getByLabel('Password').fill(PASSWORD);
    await form.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#drop')).toBeVisible();
    await expect(page.locator('#version')).not.toBeEmpty();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('the session survives a reload, and signing out brings the form back', async ({ page }) => {
    await open(page);
    await page.reload();
    await expect(page.locator('#drop')).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.locator('#loginForm')).toBeVisible();
    expect((await page.request.get('/api/config')).status()).toBe(401);
  });

  test('the form is translated', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'VI', exact: true }).click();
    await expect(page.locator('#loginForm h2')).toHaveText('Đăng nhập');
  });
});
