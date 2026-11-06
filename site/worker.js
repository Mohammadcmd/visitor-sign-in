// The Visitor Sign-In website, on Cloudflare (see site/README.md):
//   /                       the install page (index.html)
//   /web/                   the browser kiosk, and where phone sign-in QR codes point
//   /downloads/…            the Android app and the browser kiosk as a zip
//   /latest.json            the newest version, which kiosks check for updates
//   /license-status/<id>.txt  each license's signed status file, which kiosks read
//                           to pick up renewals and switch-offs
//
// Everything is static files (made by scripts/build-site.mjs), except the
// license status files. Those live in Workers KV and are sent by the seller's
// license tools. The website only accepts one that's signed with the seller's
// key (license-public-key.json, from PAYWALL.publicKey) and newer than the one
// it has, so nobody else can switch a kiosk off or on.
import { verifySigned } from '../web/js/signed.js';

const STATUS = /^\/license-status\/([0-9a-f]{16})\.txt$/;
const MAX_STATUS = 8 * 1024;
const OPEN = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Date',
  'Cache-Control': 'no-store',
};

const reply = (status, body, headers = {}) => new Response(body, { status, headers: { ...OPEN, 'Content-Type': 'text/plain; charset=utf-8', ...headers } });

let publicKey;
/** The seller's public key, published with the site (null until PAYWALL.publicKey is set). */
async function sellerKey(env, request) {
  if (publicKey === undefined) {
    try {
      const res = await env.ASSETS.fetch(new Request(new URL('/license-public-key.json', request.url)));
      if (res.ok) publicKey = await res.json();
      else if (res.status === 404) publicKey = null;
      else return null;
    } catch { return null; } // not kept: try again on the next upload
  }
  return publicKey;
}

/** The payload of a stored status file (it was checked when it was stored). */
function storedAt(text) {
  try {
    const part = String(text).split('.')[1];
    return Date.parse(JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4))).at) || 0;
  } catch { return 0; }
}

async function licenseStatus(request, env, id) {
  const key = `status:${id}`;
  if (request.method === 'OPTIONS') {
    return reply(204, null, { 'Access-Control-Allow-Methods': 'GET, HEAD, PUT', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    const text = await env.LICENSES.get(key);
    if (text === null) return reply(404, request.method === 'HEAD' ? null : 'No status file for this license.\n');
    return reply(200, request.method === 'HEAD' ? null : text);
  }
  if (request.method !== 'PUT' && request.method !== 'POST') return reply(405, 'Use GET to read a status file, PUT to send one.\n', { Allow: 'GET, HEAD, PUT' });

  const body = (await request.text()).trim();
  if (!body || body.length > MAX_STATUS) return reply(400, 'Send the status file (VSS1.…) as the body.\n');
  const pub = await sellerKey(env, request);
  if (!pub) return reply(503, "This website doesn't have the seller's public key yet (PAYWALL.publicKey in web/js/plans.js): publish the site again after setting it.\n");
  const { data, error } = await verifySigned('VSS1', body, pub);
  if (error === 'format') return reply(400, "That isn't a status file: it should start with VSS1.\n");
  if (error) return reply(403, "The signature doesn't match the seller's key: is this the signing key the kiosks use?\n");
  if (String(data.id) !== id) return reply(400, `That status file is for license ${data.id}, not ${id}.\n`);
  if (data.status !== 'active' && data.status !== 'off') return reply(400, 'The status should be active or off.\n');
  const at = Date.parse(data.at) || 0;
  if (!at) return reply(400, 'The status file has no time.\n');
  if (at > Date.now() + 10 * 60 * 1000) return reply(400, "The status file's time is in the future: check this computer's clock.\n");
  const current = await env.LICENSES.get(key);
  if (current !== null && storedAt(current) >= at) {
    if (current.trim() === body) return reply(200, `License ${id}: already published (${data.status}).\n`);
    return reply(409, `The website already has a newer status for license ${id}.\n`);
  }
  await env.LICENSES.put(key, body);
  return reply(200, `License ${id}: published (${data.status}).\n`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = STATUS.exec(url.pathname);
    if (m) return licenseStatus(request, env, m[1]);
    if (url.pathname.startsWith('/license-status/')) return reply(404, 'Not found.\n');
    const res = await env.ASSETS.fetch(request);
    if (url.pathname === '/latest.json') {
      // Read by kiosks on other addresses (the Android app, browser kiosks hosted elsewhere).
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(OPEN)) out.headers.set(k, v);
      return out;
    }
    return res;
  },
};
