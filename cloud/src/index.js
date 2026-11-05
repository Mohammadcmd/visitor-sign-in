// The Visitor Sign-In cloud service (Cloudflare Workers).
//
//   POST /v1/c/<company id>   a kiosk call: { key, action, args, rid } → JSON
//   GET  /                    health check
//
// Each company id goes to that company's own Durable Object (src/company.js).
// Bodies are sent as text/plain, as the kiosk does for the Google script, so
// browsers skip the CORS preflight.
import { Company, BACKEND_VERSION } from './company.js';

export { Company };

const MAX_BODY = 6 * 1024 * 1024;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' && request.method === 'GET') return json({ ok: true, service: 'visitor-sign-in-cloud', version: BACKEND_VERSION });

    const m = /^\/v1\/c\/([A-Za-z0-9-]{8,64})$/.exec(url.pathname);
    if (!m) return json({ ok: false, error: 'not_found' }, 404);
    if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
    if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return json({ ok: false, error: 'too_big' }, 413);
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ ok: false, error: 'too_big' }, 413);
    let req;
    try { req = JSON.parse(text); } catch { return json({ ok: false, error: 'bad_request' }, 400); }
    if (!req || typeof req !== 'object' || Array.isArray(req)) return json({ ok: false, error: 'bad_request' }, 400);

    const company = env.COMPANY.get(env.COMPANY.idFromName(m[1]));
    try {
      return json(await company.handle({ key: req.key, action: req.action, args: req.args, rid: req.rid, tz: req.tz }));
    } catch (err) {
      console.error(err && err.stack || err);
      return json({ ok: false, error: 'server' }, 500);
    }
  },
};
