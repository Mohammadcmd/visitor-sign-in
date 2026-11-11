// The website (site/): the Worker keeps a license status file only when it's
// signed with the seller's key and newer than the one it has; kiosks on any
// address can read status files and latest.json; the license tools send their
// files to it; and scripts/build-site.mjs puts together what the site serves.
//   node tests/site.test.mjs
import assert from 'node:assert';
import { execFileSync, execFile } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks++; };

/** A fresh copy of the Worker (it remembers the seller's key once read). */
let copies = 0;
const loadWorker = async () => (await import(`${pathToFileURL(join(root, 'site/worker.js')).href}?copy=${++copies}`)).default;
const kv = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } }; };
const assets = (files) => ({
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    if (!(p in files)) return new Response('<!doctype html>Page not found', { status: 404, headers: { 'Content-Type': 'text/html' } });
    return new Response(files[p], { headers: { 'Content-Type': p.endsWith('.json') ? 'application/json' : 'text/html' } });
  },
});

const seller = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = seller.publicKey.export({ format: 'jwk' });
const signed = (payload, key = seller.privateKey) => {
  const body = `VSS1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${body}.${sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
};
const id = '0123456789abcdef';
const url = `https://site.example/license-status/${id}.txt`;
const req = (method, body, path = url) => new Request(path, { method, body });
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

// ------------------------------------------------------------------ the Worker

{
  // Before the seller's key is on the site, nothing is accepted.
  const w = await loadWorker();
  const env = { ASSETS: assets({ '/index.html': 'home' }), LICENSES: kv() };
  const res = await w.fetch(req('PUT', signed({ id, status: 'active', key: 'VSI1.x.y', at: ago(1) })), env);
  eq(res.status, 503, 'no public key on the site yet: refused');
  ok(/PAYWALL\.publicKey/.test(await res.text()), 'and it says what to do');
  eq(env.LICENSES.m.size, 0, 'nothing stored');
}

const w = await loadWorker();
const env = { ASSETS: assets({ '/license-public-key.json': JSON.stringify(jwk), '/latest.json': '{"version":"9.9.9"}', '/index.html': 'home' }), LICENSES: kv() };
const run = async (method, body, path) => { const res = await w.fetch(req(method, body, path), env); return { status: res.status, text: await res.text(), headers: res.headers }; };

let r = await run('GET');
eq(r.status, 404, 'no status file yet');
eq(r.headers.get('Access-Control-Allow-Origin'), '*', 'kiosks on any address can ask');
r = await run('OPTIONS');
eq(r.status, 204, 'the browser check before sending is answered');
ok(/PUT/.test(r.headers.get('Access-Control-Allow-Methods')), 'and allows sending');
eq((await run('PUT', 'hello')).status, 400, 'not a status file');
eq((await run('PUT', signed({ id, status: 'off', key: '', at: ago(1) }, stranger.privateKey))).status, 403, "someone else's key can't switch a kiosk off");
eq((await run('PUT', signed({ id: 'fedcba9876543210', status: 'off', key: '', at: ago(1) }))).status, 400, "a file for another license isn't stored under this one");
eq((await run('PUT', signed({ id, status: 'paused', key: '', at: ago(1) }))).status, 400, 'only active or off');
eq((await run('PUT', signed({ id, status: 'off', key: '', at: new Date(Date.now() + 3600000).toISOString() }))).status, 400, 'a time in the future is refused (a wrong clock)');
eq(env.LICENSES.m.size, 0, 'none of those were stored');

const first = signed({ id, status: 'active', key: 'VSI1.a.b', at: ago(30) });
r = await run('PUT', first);
eq(r.status, 200, 'a signed status file is kept');
ok(/published \(active\)/.test(r.text), r.text);
r = await run('GET');
eq([r.status, r.text], [200, first], 'and kiosks read it back');
eq(r.headers.get('Access-Control-Expose-Headers'), 'Date', 'with the server time readable (against clock rollback)');
eq(r.headers.get('Cache-Control'), 'no-store', 'never cached');
eq((await run('PUT', first)).status, 200, 'sending the same file again is fine');
eq((await run('PUT', signed({ id, status: 'off', key: '', at: ago(60) }))).status, 409, 'an older file (replayed) is refused');
const off = signed({ id, status: 'off', key: 'VSI1.a.b', at: ago(5) });
eq((await run('PUT', off)).status, 200, 'a newer one replaces it');
eq((await run('GET')).text, off, 'kiosks now read "off"');
eq((await run('PUT', first)).status, 409, "the old \"active\" can't be sent again to switch it back on");
eq((await run('DELETE')).status, 405, 'no other methods');
eq((await run('GET', undefined, 'https://site.example/license-status/../../etc.txt')).status, 404, 'only license ids');
r = await run('GET', undefined, 'https://site.example/latest.json');
ok(r.status === 200 && r.headers.get('Access-Control-Allow-Origin') === '*' && r.text.includes('9.9.9'), 'latest.json is readable from the Android app and other addresses');
eq((await run('GET', undefined, 'https://site.example/index.html')).text, 'home', 'everything else is the site files');

// ------------------------------------------------------------------ the license tools send their files to it

const server = createServer(async (q, s) => {
  const body = await new Promise((done) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => done(b)); });
  const res = await w.fetch(new Request(`https://site.example${q.url}`, { method: q.method, body: ['GET', 'HEAD'].includes(q.method) ? undefined : body }), toolEnv);
  s.writeHead(res.status, Object.fromEntries(res.headers));
  s.end(await res.text());
});
const toolEnv = { ASSETS: env.ASSETS, LICENSES: kv() };
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const statusUrl = `http://127.0.0.1:${server.address().port}/license-status/`;
const dir = mkdtempSync(join(tmpdir(), 'vsi-site-'));
const tool = async (script, args) => (await promisify(execFile)(process.execPath, [join(root, 'tools/license', script), ...args], { cwd: dir, encoding: 'utf8' }));
try {
  writeFileSync(join(dir, 'license-private.pem'), seller.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const issued = await tool('issue.mjs', ['--customer', 'Acme Robotics', '--tablet', 'K7M2-9XQ4', '--publish', statusUrl]);
  const lid = JSON.parse(readFileSync(join(dir, 'licenses.json'), 'utf8')).licenses[0].id;
  ok(/Sent to the website: License [0-9a-f]{16}: published \(active\)/.test(issued.stderr), `issuing sends the status file: ${issued.stderr.split('\n').at(-2)}`);
  ok(toolEnv.LICENSES.m.get(`status:${lid}`)?.startsWith('VSS1.'), 'the website has it');
  const sw = await tool('switch.mjs', ['off', '--id', lid, '--publish', statusUrl]);
  ok(/published \(off\)/.test(sw.stderr), 'switching off sends it too');
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const { verifyStatus } = await import(pathToFileURL(join(root, 'web/js/plans.js')).href);
  const read = await (await fetch(`${statusUrl}${lid}.txt`)).text();
  eq((await verifyStatus(read, jwk))?.status, 'off', 'and the kiosk reads "off" from the website');
  const again = await tool('publish.mjs', ['--publish', statusUrl]);
  ok(/already published \(off\)/.test(again.stdout), 'license:publish sends them all again, harmlessly');
  const notYet = await tool('renew.mjs', ['--id', lid]);
  ok(/Not sent to the website: licensing isn't switched on/.test(notYet.stderr), `with licensing off in plans.js, nothing is sent: ${notYet.stderr.split('\n').at(-2)}`);
  // A website that refuses (here: no seller key on it) is reported, and the tool exits with an error.
  const bare = { ASSETS: assets({}), LICENSES: kv() };
  const w2 = await loadWorker();
  const srv2 = createServer(async (q, s) => { let b = ''; for await (const c of q) b += c; const res = await w2.fetch(new Request(`https://site.example${q.url}`, { method: q.method, body: b || undefined }), bare); s.writeHead(res.status); s.end(await res.text()); });
  await new Promise((done) => srv2.listen(0, '127.0.0.1', done));
  try {
    await tool('switch.mjs', ['on', '--id', lid, '--publish', `http://127.0.0.1:${srv2.address().port}/license-status/`]);
    assert.fail('expected the tool to fail');
  } catch (err) {
    ok(/The website refused it \(503\)/.test(String(err.stderr)), 'a refusal is reported');
  } finally { srv2.close(); }
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ the build

const out = mkdtempSync(join(tmpdir(), 'vsi-site-build-'));
try {
  const apk = join(out, 'fake.apk');
  writeFileSync(apk, 'not really an apk');
  const site = join(out, 'site');
  execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(root, 'scripts/build-site.mjs'), '--out', site, '--apk', apk], { encoding: 'utf8' });
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const siteUrl = /^\s*SITE_URL: '([^']*)'/m.exec(readFileSync(join(root, 'web/config.js'), 'utf8'))[1];
  for (const f of ['index.html', 'sw.js', 'web/index.html', 'web/js/app.js', 'web/js/signed.js', 'latest.json', 'downloads.html', 'launch.html', 'privacy-notice.html', '404.html']) ok(existsSync(join(site, f)), `the site has ${f}`);
  ok(new RegExp(`const BUILD = '${version.replace(/\./g, '\\.')}-\\w+';`).test(readFileSync(join(site, 'web/sw.js'), 'utf8')), 'browser kiosks get the new build');
  const latest = JSON.parse(readFileSync(join(site, 'latest.json'), 'utf8'));
  eq(latest.version, version, 'latest.json has this version');
  eq(latest.apk && [latest.apk.version, latest.apk.name, latest.apk.url, latest.apk.size], [version, `visitor-sign-in-${version}.apk`, `${siteUrl}downloads/visitor-sign-in-${version}.apk`, 17], 'and the app to download');
  ok(existsSync(join(site, 'downloads', `visitor-sign-in-${version}.apk`)), 'the app is in downloads/');
  ok(readFileSync(join(site, 'downloads.html'), 'utf8').includes(`downloads/visitor-sign-in-${version}.apk`), 'the downloads page links to it');
  ok(!existsSync(join(site, 'license-public-key.json')), 'no public key file until PAYWALL.publicKey is set');
  // Screenless sign-in: the Raspberry Pi / PC program, and the Pi installer.
  const serverZip = join(site, 'downloads', 'visitor-sign-in-server.zip');
  ok(existsSync(serverZip) && latest.server?.url === `${siteUrl}downloads/visitor-sign-in-server.zip`, 'the Raspberry Pi / PC program is a download');
  const unzipped = join(out, 'server-app');
  execFileSync('unzip', ['-q', serverZip, '-d', unzipped]);
  const printed = execFileSync(process.execPath, [join(unzipped, 'server/visitor-server.mjs'), '--data', join(out, 'server-data'), '--print-link'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  ok(/^http:\/\/[^/]+:8080\/web\/\?api=http%3A%2F%2F[^&]+%3A8080%2Fbox%2F[a-z0-9]{20}&key=k-[A-Z0-9]{30}\s*$/.test(printed), `the unzipped program runs on its own and prints its setup link on the Wi-Fi: ${printed.trim().slice(0, 90)}…`);
  ok(existsSync(join(unzipped, 'web/index.html')) && existsSync(join(unzipped, 'START HERE.txt')), 'with the kiosk it serves, and a START HERE note');
  const installer = readFileSync(join(site, 'downloads', 'install-pi.sh'), 'utf8');
  ok(!installer.includes('@SITE@') && installer.includes(`SITE="\${VSI_SITE:-${siteUrl}}"`), 'the Pi installer knows the website');
  ok(readFileSync(join(site, 'downloads.html'), 'utf8').includes('install-pi.sh | sudo bash'), 'the downloads page shows the one command for a Pi');
  const launch = readFileSync(join(site, 'launch.html'), 'utf8');
  ok(/<h1>Launch checklist<\/h1>/.test(launch) && /class="checklist"/.test(launch), 'the launch checklist is a page');
  ok(!/\]\(\.\.\//.test(launch) && !/href="\.\.\//.test(launch), 'with no links into the (private) repository');
  ok(/<h1>/.test(readFileSync(join(site, 'privacy-notice.html'), 'utf8')), 'the privacy notice template is a page');
} finally {
  rmSync(out, { recursive: true, force: true });
}

// ------------------------------------------------------------------ the Worker's settings

const cfg = JSON.parse(readFileSync(join(root, 'site/wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
eq(cfg.assets.directory, '../dist/site', 'the Worker serves what build-site makes');
ok(cfg.assets.run_worker_first.includes('/license-status/*') && cfg.assets.run_worker_first.includes('/latest.json'), 'the Worker answers status files and latest.json');
ok(cfg.kv_namespaces.some((n) => n.binding === 'LICENSES' && /^[0-9a-f]{32}$/.test(n.id)), 'status files are kept in KV');
const plansSrc = readFileSync(join(root, 'web/js/plans.js'), 'utf8');
const configSrc = readFileSync(join(root, 'web/config.js'), 'utf8');
const site = /^\s*SITE_URL: '([^']*)'/m.exec(configSrc)[1];
ok(plansSrc.includes(`statusUrl: '${site}license-status/'`), 'kiosks read status files from the website');
ok(site === `https://${cfg.name}.mohammadjalbibi.workers.dev/` || !/workers\.dev/.test(site), 'SITE_URL is this Worker (or a custom domain)');

console.log(`site tests passed (${checks} checks)`);
