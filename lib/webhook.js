'use strict';

// Job webhooks: when a job finishes, fails or is cancelled, POST it to the URL given at upload time.
//
//   Body       { "event": "job.done" | "job.error" | "job.cancelled", "job": { …same as GET /api/jobs/:id } }
//   Signature  X-Compress-Media-Signature: sha256=<hex HMAC of the raw body with WEBHOOK_SECRET>
//   Retries    up to 4 attempts (1 s, 5 s, 25 s back-off); any 2xx counts as delivered
//
// Webhook URLs are checked when the job is created: http(s) only, and private, loopback and
// link-local addresses are refused unless WEBHOOK_ALLOW_PRIVATE=true (SSRF protection).

const dns = require('node:dns/promises');
const net = require('node:net');
const crypto = require('node:crypto');

const allowPrivate = () => /^(1|true|yes)$/i.test(process.env.WEBHOOK_ALLOW_PRIVATE || '');

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/**
 * Validates a webhook URL; throws a user-facing Error when it isn't acceptable.
 * @param {string} value
 * @returns {Promise<string>} the normalised URL
 */
async function validateWebhook(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error('webhook must be an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('webhook must be an http(s) URL');
  if (!allowPrivate()) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (!addresses.length) throw new Error(`webhook host ${url.hostname} does not resolve`);
    if (addresses.some(isPrivateAddress)) {
      throw new Error('webhook points to a private or local address (set WEBHOOK_ALLOW_PRIVATE=true to allow it)');
    }
  }
  return url.toString();
}

/**
 * Delivers a job event in the background (never throws).
 * @param {string} url
 * @param {string} event
 * @param {any} job public job object
 */
function sendWebhook(url, event, job) {
  const body = JSON.stringify({ event, job, sentAt: new Date().toISOString() });
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'compress-media-webhook' };
  if (process.env.WEBHOOK_SECRET) {
    headers['X-Compress-Media-Signature'] = `sha256=${crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(body).digest('hex')}`;
  }
  const delays = [0, 1000, 5000, 25000];
  (async () => {
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]).unref?.());
      try {
        const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        if (res.ok) return;
      } catch { /* retry */ }
    }
    console.warn(`[webhook] giving up on ${event} for job ${job?.id} → ${url}`);
  })();
}

module.exports = { validateWebhook, sendWebhook, isPrivateAddress };
