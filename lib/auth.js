'use strict';

// Built-in login for the web server. On by default; AUTH_ENABLED=false turns it off.
//
//   Browsers   POST /api/auth/login → signed, HttpOnly session cookie
//   Scripts    HTTP Basic (AUTH_USERNAME:AUTH_PASSWORD) or `Authorization: Bearer <AUTH_TOKEN>`
//
// When no AUTH_PASSWORD is set, a random one is generated, printed at startup and kept in
// WORK_DIR/auth.json (with the session secret) so restarts don't change it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const COOKIE = 'cm_session';
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login', '/api/auth/logout', '/api/auth/session']);
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

const isOff = (v) => /^(0|false|no|off|disabled?)$/i.test(String(v || '').trim());

/** Constant-time string comparison (hashing first makes lengths equal). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Reads the auth settings from the environment, generating and persisting what's missing.
 * @param {{ workDir: string, env?: NodeJS.ProcessEnv }} opts
 */
function loadAuthConfig({ workDir, env = process.env }) {
  if (isOff(env.AUTH_ENABLED)) return { enabled: false };

  const file = path.join(workDir, 'auth.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* first start */ }

  const username = (env.AUTH_USERNAME || env.AUTH_EMAIL || 'admin').trim();
  let password = env.AUTH_PASSWORD || '';
  let generated = false;
  if (!password) {
    password = saved.password || crypto.randomBytes(12).toString('base64url');
    generated = true;
  }
  const secret = env.AUTH_SECRET || saved.secret || crypto.randomBytes(32).toString('base64url');

  const toSave = { secret: env.AUTH_SECRET ? undefined : secret, password: generated ? password : undefined };
  if (toSave.secret !== saved.secret || toSave.password !== saved.password) {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(toSave, null, 2), { mode: 0o600 });
  }

  return {
    enabled: true,
    username,
    password,
    generated,
    file,
    token: env.AUTH_TOKEN || '',
    secret,
    sessionMs: (Number(env.AUTH_SESSION_HOURS) || 168) * 60 * 60 * 1000,
  };
}

/**
 * Express wiring: login/logout/session routes plus a guard for every other /api route.
 * @param {import('express').Express} app
 * @param {ReturnType<typeof loadAuthConfig>} cfg
 */
function setupAuth(app, cfg) {
  const sign = (payload) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', cfg.secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  };
  const verify = (value) => {
    const [body, mac] = String(value || '').split('.');
    if (!body || !mac) return null;
    const expected = crypto.createHmac('sha256', cfg.secret).update(body).digest('base64url');
    if (!safeEqual(mac, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
      return payload.exp > Date.now() && payload.u === cfg.username ? payload : null;
    } catch {
      return null;
    }
  };
  const cookieValue = (req) => {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return decodeURIComponent(v.join('='));
    }
    return null;
  };
  const usernameMatches = (u) => safeEqual(String(u).trim().toLowerCase(), cfg.username.toLowerCase());

  /** Who is calling: from the session cookie, HTTP Basic or a bearer token. */
  function identify(req) {
    if (!cfg.enabled) return 'anonymous';
    const session = verify(cookieValue(req));
    if (session) return session.u;
    const header = String(req.headers.authorization || '');
    if (header.startsWith('Basic ')) {
      const [u, ...p] = Buffer.from(header.slice(6), 'base64').toString().split(':');
      if (usernameMatches(u) && safeEqual(p.join(':'), cfg.password)) return cfg.username;
    } else if (header.startsWith('Bearer ') && cfg.token && safeEqual(header.slice(7).trim(), cfg.token)) {
      return cfg.username;
    }
    return null;
  }

  // Failed logins per client address, to slow down password guessing.
  const failures = new Map();
  const tooManyFailures = (ip) => {
    const f = failures.get(ip);
    if (!f || Date.now() - f.first > FAILURE_WINDOW_MS) return false;
    return f.count >= MAX_FAILURES;
  };
  const recordFailure = (ip) => {
    const f = failures.get(ip);
    if (!f || Date.now() - f.first > FAILURE_WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
    else f.count++;
  };

  const cookieFlags = (req, maxAgeSec) => {
    const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  };

  app.get('/api/auth/session', (req, res) => {
    const user = identify(req);
    res.json({ enabled: cfg.enabled, authenticated: !!user, username: cfg.enabled && user ? user : null });
  });

  app.post('/api/auth/login', (req, res) => {
    if (!cfg.enabled) return res.json({ ok: true });
    const ip = req.ip || req.socket.remoteAddress || '?';
    if (tooManyFailures(ip)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    const { username = '', password = '' } = req.body || {};
    if (!usernameMatches(username) || !safeEqual(password, cfg.password)) {
      recordFailure(ip);
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    failures.delete(ip);
    const token = sign({ u: cfg.username, exp: Date.now() + cfg.sessionMs });
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; ${cookieFlags(req, Math.floor(cfg.sessionMs / 1000))}`);
    res.json({ ok: true, username: cfg.username });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieFlags(req, 0)}`);
    res.json({ ok: true });
  });

  // Everything else under /api needs a user. Static files (the UI itself) stay public: the page
  // shows the login form when /api/auth/session says so.
  app.use('/api', (req, res, next) => {
    if (!cfg.enabled || PUBLIC_PATHS.has(req.baseUrl + req.path)) return next();
    if (identify(req)) return next();
    // No WWW-Authenticate header on purpose: it would make browsers pop up their own login box.
    res.status(401).json({ error: 'Authentication required' });
  });
}

module.exports = { loadAuthConfig, setupAuth };
