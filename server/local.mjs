// The sign-in page on the building's Wi-Fi: this computer serves the kiosk
// (web/) and answers its requests itself, at http://<this computer>:8080/.
// No website, no accounts and no internet needed. Visitors' phones must be on
// the same Wi-Fi to reach it, and since the page isn't https, phones can't use
// their camera: the box tells them to skip the photo.
//
//   /            → /web/
//   /web/…       the kiosk's files (the admin screen, and visitors' phones)
//   /box/<id>    requests, the same as through the website (box.mjs)
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.bin': 'application/octet-stream',
};
const MAX_REQUEST = 6 * 1024 * 1024;

/** This computer's address on the local network (192.168.x.x…), or 'localhost'. */
export function lanAddress() {
  const all = Object.values(networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal);
  const priv = all.find((n) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address));
  return (priv || all[0] || { address: 'localhost' }).address;
}

/**
 * Serves the kiosk and the box on the local network.
 *   box      from openBox (box.mjs)
 *   webDir   the kiosk's files (../web next to server/)
 *   port     8080 unless given
 * Resolves { server, port, base } once listening; base is http://<address>:<port>/.
 */
export function serveLocal({ box, webDir, port = 8080, host = '0.0.0.0', address = lanAddress() }) {
  const root = normalize(webDir) + sep;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const send = (status, body, type = 'text/plain; charset=utf-8', extra = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', ...extra });
      res.end(body);
    };
    if (url.pathname === `/box/${box.config.boxId}`) {
      if (req.method === 'OPTIONS') return send(204, '', 'text/plain', { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      if (req.method !== 'POST') return send(405, JSON.stringify({ ok: false, error: 'post' }), 'application/json');
      let body = '';
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_REQUEST) return send(413, JSON.stringify({ ok: false, error: 'too_large' }), 'application/json');
        body += chunk;
      }
      let parsed;
      try { parsed = JSON.parse(body); } catch { return send(400, JSON.stringify({ ok: false, error: 'bad_request' }), 'application/json'); }
      const out = await box.handle(parsed, { secure: false });
      return send(200, JSON.stringify(out), 'application/json');
    }
    if (url.pathname.startsWith('/box/')) return send(404, JSON.stringify({ ok: false, error: 'box_unknown' }), 'application/json');
    if (url.pathname === '/' || url.pathname === '/web') return send(302, '', 'text/plain', { Location: `/web/${url.search}` });
    if (!url.pathname.startsWith('/web/') || req.method !== 'GET') return send(404, 'Not found.\n');
    let file = normalize(join(webDir, decodeURIComponent(url.pathname.slice('/web/'.length))));
    if (!(file + sep).startsWith(root) && file !== normalize(webDir)) return send(404, 'Not found.\n');
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!file.startsWith(root) || !existsSync(file)) return send(404, 'Not found.\n');
    return send(200, readFileSync(file), TYPES[extname(file).toLowerCase()] || 'application/octet-stream');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({ server, port: actual, base: `http://${address}:${actual}/` });
    });
  });
}
