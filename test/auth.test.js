'use strict';

// Built-in login: sessions for the browser, HTTP Basic and bearer tokens for scripts, rate limiting,
// and the generated password when AUTH_PASSWORD is not set.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compress-media-auth-'));
const servers = [];

/** Starts a server with the given env; resolves with { base, logs }. */
async function start(env) {
  const port = 48000 + Math.floor(Math.random() * 900);
  const workDir = path.join(tmp, `work-${port}`);
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', WORK_DIR: workDir, AUTH_PASSWORD: '', AUTH_TOKEN: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: tmp, // no .env here
  });
  servers.push(proc);
  let logs = '';
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 75; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { base, workDir, logs: () => logs, proc };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start:\n${logs}`);
}

after(() => {
  for (const p of servers) p.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
});

const login = (base, username, password) => fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
});
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

test('login is required by default; health and the UI stay public', async () => {
  const { base } = await start({ AUTH_USERNAME: 'me@example.com', AUTH_PASSWORD: 's3cret-pass' });
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 200);
  const denied = await fetch(`${base}/api/config`);
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('www-authenticate'), null, 'no browser login pop-up');
  assert.equal((await fetch(`${base}/api/uploads`, { method: 'POST' })).status, 401);
  assert.deepEqual(await (await fetch(`${base}/api/auth/session`)).json(), { enabled: true, authenticated: false, username: null });
});

test('the browser signs in with a session cookie and signs out', async () => {
  const { base } = await start({ AUTH_USERNAME: 'me@example.com', AUTH_PASSWORD: 's3cret-pass' });
  assert.equal((await login(base, 'me@example.com', 'wrong')).status, 401);

  const ok = await login(base, 'ME@example.com ', 's3cret-pass'); // usernames are case/space-insensitive
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /^cm_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+/);
  const session = cookie.split(';')[0];

  const config = await fetch(`${base}/api/config`, { headers: { cookie: session } });
  assert.equal(config.status, 200);
  assert.equal((await (await fetch(`${base}/api/auth/session`, { headers: { cookie: session } })).json()).authenticated, true);

  // A tampered cookie is rejected.
  const forged = session.replace(/\.[^.]+$/, '.AAAA');
  assert.equal((await fetch(`${base}/api/config`, { headers: { cookie: forged } })).status, 401);

  const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: session } });
  assert.match(out.headers.get('set-cookie'), /cm_session=; .*Max-Age=0/);
});

test('scripts use HTTP Basic or a bearer token', async () => {
  const { base } = await start({ AUTH_USERNAME: 'bot', AUTH_PASSWORD: 'pa:ss', AUTH_TOKEN: 'tok-123' });
  assert.equal((await fetch(`${base}/api/config`, { headers: { authorization: basic('bot', 'pa:ss') } })).status, 200);
  assert.equal((await fetch(`${base}/api/config`, { headers: { authorization: basic('bot', 'nope') } })).status, 401);
  assert.equal((await fetch(`${base}/api/config`, { headers: { authorization: 'Bearer tok-123' } })).status, 200);
  assert.equal((await fetch(`${base}/api/config`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
});

test('repeated wrong passwords are rate limited', async () => {
  const { base } = await start({ AUTH_PASSWORD: 'right' });
  for (let i = 0; i < 10; i++) assert.equal((await login(base, 'admin', 'wrong')).status, 401);
  const blocked = await login(base, 'admin', 'right');
  assert.equal(blocked.status, 429, 'even the right password waits out the lockout');
});

test('without AUTH_PASSWORD a password is generated, printed and kept across restarts', async () => {
  const first = await start({});
  const printed = first.logs().match(/Login: admin \/ (\S+)\s+\(generated/);
  assert.ok(printed, first.logs());
  const saved = JSON.parse(fs.readFileSync(path.join(first.workDir, 'auth.json'), 'utf8'));
  assert.equal(saved.password, printed[1]);
  assert.equal((fs.statSync(path.join(first.workDir, 'auth.json')).mode & 0o777).toString(8), process.platform === 'win32' ? '666' : '600');
  assert.equal((await login(first.base, 'admin', printed[1])).status, 200);

  // Same WORK_DIR → same password after a restart.
  first.proc.kill('SIGTERM');
  await new Promise((r) => first.proc.once('exit', r));
  const again = await start({ WORK_DIR: first.workDir });
  assert.equal((await login(again.base, 'admin', printed[1])).status, 200);
});

test('AUTH_ENABLED=false turns it off', async () => {
  const { base, logs } = await start({ AUTH_ENABLED: 'false' });
  assert.equal((await fetch(`${base}/api/config`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/auth/session`)).json(), { enabled: false, authenticated: true, username: null });
  assert.match(logs(), /Login: disabled/);
});
