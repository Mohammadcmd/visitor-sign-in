// Puts the website together in dist/site/ for site/worker.js (see site/README.md):
// the install page, the browser kiosk (web/), downloads, latest.json (the
// update check), the seller's public key for license status uploads, and a
// few pages made from docs/.
//   node scripts/build-site.mjs [--apk app.apk] [--web-zip kiosk.zip] [--out dir]
// Without --apk, the Android app already on the website is kept (from its
// latest.json), so publishing the site between releases doesn't remove it.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback = '') => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
const out = resolve(opt('out', join(root, 'dist/site')));
const read = (f) => readFileSync(join(root, f), 'utf8');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The kiosk's own settings: version, website address (web/config.js, which needs a browser to load) and the seller's key.
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { PAYWALL } = await import(pathToFileURL(join(root, 'web/js/plans.js')).href);
const { version } = JSON.parse(read('package.json'));
const siteUrl = ((/^\s*SITE_URL: '([^']*)'/m.exec(read('web/config.js')) || [])[1] || '').replace(/^(.+?)\/?$/, '$1/');
let sha = (process.env.GITHUB_SHA || '').slice(0, 8);
if (!sha) { try { sha = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { sha = 'local'; } }

if (basename(out) !== 'site' && !opt('out')) throw new Error(`Unexpected output folder ${out}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The install page, the old root service worker (it removes itself), and the kiosk.
copyFileSync(join(root, 'index.html'), join(out, 'index.html'));
copyFileSync(join(root, 'sw.js'), join(out, 'sw.js'));
cpSync(join(root, 'web'), join(out, 'web'), { recursive: true });
// Stamp this build into the kiosk's offline cache, so every browser kiosk picks it up.
const swFile = join(out, 'web/sw.js');
const sw = readFileSync(swFile, 'utf8');
if (!sw.includes("const BUILD = 'dev';")) throw new Error("web/sw.js should have const BUILD = 'dev';");
writeFileSync(swFile, sw.replace("const BUILD = 'dev';", `const BUILD = '${version}-${sha}';`));

// The seller's public key: the website only accepts license status files signed with it.
if (PAYWALL.publicKey) writeFileSync(join(out, 'license-public-key.json'), `${JSON.stringify(PAYWALL.publicKey)}\n`);

// Downloads: the Android app (new, or the one already published) and the browser kiosk zip.
mkdirSync(join(out, 'downloads'), { recursive: true });
const file = (name) => ({ name, url: `${siteUrl}downloads/${name}`, size: statSync(join(out, 'downloads', name)).size });
let apk = null;
let webZip = null;
if (opt('apk')) {
  const name = `visitor-sign-in-${version}.apk`;
  copyFileSync(resolve(opt('apk')), join(out, 'downloads', name));
  apk = { version, ...file(name) };
} else if (siteUrl && !args.includes('--no-keep')) {
  try {
    const live = await (await fetch(`${siteUrl}latest.json`, { cache: 'no-store' })).json();
    if (live?.apk?.url && live.apk.name && /^[\w.-]+\.apk$/.test(live.apk.name)) {
      const res = await fetch(live.apk.url);
      if (!res.ok) throw new Error(`${res.status}`);
      writeFileSync(join(out, 'downloads', live.apk.name), Buffer.from(await res.arrayBuffer()));
      apk = { version: String(live.apk.version || live.version), ...file(live.apk.name) };
      console.log(`Kept the published Android app ${live.apk.name}`);
    }
  } catch (err) { console.log(`No Android app on the website yet (${err.message || err}): the install page offers the browser kiosk.`); }
}
if (opt('web-zip')) {
  const name = `visitor-sign-in-web-${version}.zip`;
  copyFileSync(resolve(opt('web-zip')), join(out, 'downloads', name));
  webZip = file(name);
}

// What's new in this version, from CHANGELOG.md.
const changelog = read('CHANGELOG.md');
const at = changelog.indexOf(`## ${version}`);
const notes = at < 0 ? '' : changelog.slice(changelog.indexOf('\n', at) + 1, (changelog.indexOf('\n## ', at + 1) + 1 || changelog.length + 1) - 1).trim();
writeFileSync(join(out, 'latest.json'), `${JSON.stringify({ version, build: `${version}-${sha}`, published: new Date().toISOString(), page: siteUrl, apk, web: webZip, notes }, null, 2)}\n`);

// ------------------------------------------------------------------ pages made from docs/

/** The Markdown these docs use: headings, paragraphs, lists and checklists, bold, italics, code and links. */
function markdown(md) {
  const html = [];
  let list = '';
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => (/^https:\/\//.test(href.replace(/&amp;/g, '&')) ? `<a href="${href}">${text}</a>` : text));
  const close = () => { if (list) { html.push(`</${list}>`); list = ''; } };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const ul = /^\s*[-*] (?:\[[ x]\] )?(.*)/.exec(line);
    const ol = /^\s*\d+\. (.*)/.exec(line);
    const want = ul ? 'ul' : ol ? 'ol' : '';
    if (list && want !== list) close();
    if (!line.trim()) continue;
    const h = /^(#{1,4}) (.*)/.exec(line);
    if (h) { html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (want) {
      if (!list) { html.push(`<${want}${ul && /\[[ x]\]/.test(line) ? ' class="checklist"' : ''}>`); list = want; }
      html.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    if (/^\|/.test(line) || /^```/.test(line) || /^<!--/.test(line)) continue;
    html.push(`<p>${inline(line.replace(/^> /, ''))}</p>`);
  }
  close();
  return html.join('\n');
}

const page = (title, body) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · Visitor Sign-In</title>
  <link rel="icon" href="web/assets/icon-512.png">
  <style>
    body { margin: 0; font: 17px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #0d1b2a; background: #f5f8fb; }
    main { max-width: 820px; margin: 0 auto; padding: 32px 20px 56px; }
    .back { color: #0a5ea8; font-weight: 700; text-decoration: none; }
    article { background: #fff; border-radius: 22px; box-shadow: 0 14px 40px rgba(3,29,56,.1); padding: 28px 32px; margin-top: 16px; }
    h1 { font-size: 30px; margin: 0 0 12px; } h2 { font-size: 22px; margin: 26px 0 8px; } h3 { font-size: 18px; margin: 20px 0 6px; }
    code { background: #eef3f8; border-radius: 6px; padding: 1px 6px; font-size: .92em; }
    ul.checklist { list-style: none; padding-left: 4px; } ul.checklist li::before { content: '☐'; margin-right: 10px; color: #0a5ea8; }
    li { margin: 4px 0; } a { color: #0a5ea8; }
    table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 10px 8px; border-bottom: 1px solid #d9e2ec; }
    .small { color: #4a5a6b; font-size: 15px; }
  </style>
</head>
<body><main><a class="back" href="./">← Visitor Sign-In</a><article>
${body}
</article></main></body>
</html>
`;

writeFileSync(join(out, 'privacy-notice.html'), page('Privacy notice template', markdown(read('docs/privacy-notice.md'))));
writeFileSync(join(out, 'launch.html'), page('Launch checklist', markdown(read('docs/LAUNCH.md'))));
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const rows = [
  apk && `<tr><td><a href="downloads/${esc(apk.name)}">${esc(apk.name)}</a></td><td>The Android app, version ${esc(apk.version)}</td><td>${mb(apk.size)}</td></tr>`,
  webZip && `<tr><td><a href="downloads/${esc(webZip.name)}">${esc(webZip.name)}</a></td><td>The browser kiosk, to host on your own website over HTTPS</td><td>${mb(webZip.size)}</td></tr>`,
].filter(Boolean);
writeFileSync(join(out, 'downloads.html'), page('Downloads', `<h1>Downloads</h1>
<p>Version ${esc(version)}. <a href="web/">Open the browser kiosk</a> on an iPad or any tablet, or install the Android app.</p>
${rows.length ? `<table><tr><th>File</th><th>What it is</th><th>Size</th></tr>${rows.join('')}</table>` : '<p class="small">The Android app will be here with the next release.</p>'}
${notes ? `<h2>What's new in ${esc(version)}</h2>\n${markdown(notes)}` : ''}`));
writeFileSync(join(out, '404.html'), page('Not found', '<h1>Page not found</h1><p>That page isn\'t here. <a href="./">Go to the install page</a> or <a href="web/">open the kiosk</a>.</p>'));

console.log(`Built ${out}: version ${version} (${version}-${sha})${apk ? `, ${apk.name}` : ''}${PAYWALL.publicKey ? ', with the license public key' : ''}`);
