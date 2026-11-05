// The Visitor Sign-In cloud service (Cloudflare Workers).
//
// Every call is a POST with a JSON body, sent as text/plain (as the kiosk does
// for the Google script), so browsers skip the CORS preflight.
//
// Staff accounts (src/directory.js):
//   /v1/auth/start      { email }                      emails a six-digit code (signs up if new)
//   /v1/auth/verify     { email, code }                → { session, user, companies }
//   /v1/auth/me         { session }                    → { user, companies }
//   /v1/auth/signout    { session }
//   /v1/companies       { session, name, tz }          a new company, with you as its owner
//   /v1/c/<id>/members  { session, email, role }       add a colleague: owner, admin or frontdesk
//
// Tablets (src/company.js):
//   /v1/c/<id>/devices/activate   { session, publicKey, name }   a manager registers this tablet
//   /v1/c/<id>/devices/list       { session }
//   /v1/c/<id>/devices/retire     { session, deviceId }
//   /v1/c/<id>/devices/challenge  { deviceId }                   → { nonce }
//   /v1/c/<id>/devices/checkin    { deviceId, nonce, signature } → { token } (the tablet signs the nonce)
//
// The kiosk:
//   /v1/c/<id>          { key, action, args, rid }    key: the tablet's device token (or a kiosk key)
//   GET /               health check
import { Company, BACKEND_VERSION } from './company.js';
import { Directory, MANAGERS } from './directory.js';

export { Company, Directory };

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

const directory = (env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
const company = (env, id) => env.COMPANY.get(env.COMPANY.idFromName(id));

/** Checks the session belongs to someone who manages this company. */
async function manager(env, session, id) {
  const { user, role } = await directory(env).roleAt(session, id);
  if (!user) return { error: 'session' };
  if (!MANAGERS.has(role)) return { error: 'forbidden' };
  return { user };
}

async function route(env, path, body) {
  if (path === '/v1/auth/start') return directory(env).startSignIn(body.email);
  if (path === '/v1/auth/verify') return directory(env).verifySignIn(body.email, body.code);
  if (path === '/v1/auth/me') return directory(env).me(body.session);
  if (path === '/v1/auth/signout') return directory(env).signOut(body.session);
  if (path === '/v1/companies') {
    const made = await directory(env).createCompany(body.session, body.name);
    if (!made.ok) return made;
    await company(env, made.company.id).init({ name: made.company.name, tz: body.tz });
    return { ok: true, company: made.company };
  }

  const m = /^\/v1\/c\/([A-Za-z0-9-]{8,64})(?:\/(members|devices\/(?:activate|list|retire|challenge|checkin)))?$/.exec(path);
  if (!m) return null;
  const [, id, sub] = m;
  const co = company(env, id);
  switch (sub) {
    case undefined: return co.handle({ key: body.key, action: body.action, args: body.args, rid: body.rid, tz: body.tz });
    case 'members': return directory(env).addMember(body.session, id, body.email, body.role);
    case 'devices/challenge': return co.deviceChallenge(body.deviceId);
    case 'devices/checkin': return co.deviceCheckIn(body.deviceId, body.nonce, body.signature);
  }
  const who = await manager(env, body.session, id);
  if (who.error) return { ok: false, error: who.error };
  if (sub === 'devices/activate') return co.activateDevice({ publicKey: body.publicKey, name: body.name, by: who.user.email });
  if (sub === 'devices/list') return co.listDevices();
  return co.retireDevice(body.deviceId);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' && request.method === 'GET') return json({ ok: true, service: 'visitor-sign-in-cloud', version: BACKEND_VERSION });
    if (!url.pathname.startsWith('/v1/')) return json({ ok: false, error: 'not_found' }, 404);
    if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
    if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return json({ ok: false, error: 'too_big' }, 413);
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ ok: false, error: 'too_big' }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'bad_request' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ ok: false, error: 'bad_request' }, 400);
    try {
      const out = await route(env, url.pathname, body);
      return out ? json(out) : json({ ok: false, error: 'not_found' }, 404);
    } catch (err) {
      console.error(err && err.stack || err);
      return json({ ok: false, error: 'server' }, 500);
    }
  },
};
