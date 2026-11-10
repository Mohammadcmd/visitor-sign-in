// The Visitor Sign-In website, on Cloudflare (see site/README.md):
//   /                       the install page (index.html)
//   /web/                   the browser kiosk, and where phone sign-in QR codes point
//   /downloads/…            the Android app and the browser kiosk as a zip
//   /latest.json            the newest version, which kiosks check for updates
//   /license-status/<id>.txt  each license's signed status file, which kiosks read
//                           to pick up renewals and switch-offs
//   /box/<id>               a Raspberry Pi or PC with a business's records
//                           (server/): phones and the admin screen send it
//                           requests here, and it answers over the connection
//                           it keeps open (/box/<id>/connect)
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

// ------------------------------------------------------------------ the relay to a Raspberry Pi or PC

const BOX = /^\/box\/([a-z0-9]{20})(\/connect)?$/;
const MAX_REQUEST = 4 * 1024 * 1024;
const BOX_WAIT_MS = 25 * 1000;
const CHUNK = 256 * 1024;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...OPEN, 'Content-Type': 'application/json' } });
async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One box (a Raspberry Pi or PC running server/visitor-server.mjs). It keeps a
 * WebSocket open to this object; each request from a phone or the admin screen
 * is passed to it and its answer passed back. Nothing is stored here except the
 * hash of the box's secret: the first box to connect with an id sets it.
 */
export class Box {
  constructor(state) {
    this.state = state;
    this.pending = new Map();
    // Keep-alive pings are answered without waking the object up.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** The box's open connection, once it has proved its secret. */
  socket() {
    return this.state.getWebSockets().filter((ws) => ws.deserializeAttachment()?.ready).at(-1) || null;
  }

  async fetch(request) {
    if (new URL(request.url).pathname.endsWith('/connect')) {
      if (request.headers.get('Upgrade') !== 'websocket') return reply(426, 'Connect with a WebSocket.\n');
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ ready: false });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (request.method === 'OPTIONS') return reply(204, null, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
    if (request.method !== 'POST') return json(405, { ok: false, error: 'post' });
    const body = await request.text();
    if (body.length > MAX_REQUEST) return json(413, { ok: false, error: 'too_large' });
    const ws = this.socket();
    if (!ws) return json(503, { ok: false, error: 'box_offline' });
    const id = crypto.randomUUID();
    const answer = new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, BOX_WAIT_MS);
      this.pending.set(id, { resolve, timer, parts: [] });
    });
    const parts = Math.max(1, Math.ceil(body.length / CHUNK));
    try {
      for (let i = 0; i < parts; i++) ws.send(JSON.stringify({ type: 'req', id, part: i, parts, data: body.slice(i * CHUNK, (i + 1) * CHUNK) }));
    } catch {
      clearTimeout(this.pending.get(id)?.timer);
      this.pending.delete(id);
      return json(503, { ok: false, error: 'box_offline' });
    }
    const out = await answer;
    if (out === null) return json(504, { ok: false, error: 'box_timeout' });
    return new Response(out, { headers: { ...OPEN, 'Content-Type': 'application/json' } });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (msg.type === 'hello') {
      if (typeof msg.secret !== 'string' || msg.secret.length < 32 || msg.secret.length > 200) { ws.send(JSON.stringify({ type: 'refused', error: 'secret' })); ws.close(4003, 'secret'); return; }
      const have = await sha256(msg.secret);
      const want = await this.state.storage.get('secret');
      if (want && want !== have) { ws.send(JSON.stringify({ type: 'refused', error: 'secret' })); ws.close(4003, 'secret'); return; }
      if (!want) await this.state.storage.put('secret', have);
      // A box that reconnects replaces its old connection.
      for (const old of this.state.getWebSockets()) if (old !== ws && old.deserializeAttachment()?.ready) { try { old.close(4000, 'replaced'); } catch { /* gone */ } }
      ws.serializeAttachment({ ready: true, since: Date.now() });
      ws.send(JSON.stringify({ type: 'ready' }));
      return;
    }
    if (msg.type === 'res' && ws.deserializeAttachment()?.ready) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      p.parts[msg.part] = msg.data;
      if (p.parts.filter((x) => x !== undefined).length < msg.parts) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(p.parts.join(''));
    }
  }

  async webSocketClose(ws) { try { ws.close(); } catch { /* closed */ } }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = STATUS.exec(url.pathname);
    if (m) return licenseStatus(request, env, m[1]);
    const b = BOX.exec(url.pathname);
    if (b) return env.BOXES.get(env.BOXES.idFromName(b[1])).fetch(request);
    if (url.pathname.startsWith('/box/')) return json(404, { ok: false, error: 'box_unknown' });
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
