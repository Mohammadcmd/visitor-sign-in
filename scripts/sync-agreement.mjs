// Copies the license agreement (docs/legal/license-agreement.md) into the
// kiosk as HTML (web/js/agreement-text.js), so setup can show it without a
// network. The kiosk fills in the words in braces from its license settings.
//   node scripts/sync-agreement.mjs           rewrite web/js/agreement-text.js
//   node scripts/sync-agreement.mjs --check   fail if it's out of date (npm test runs this)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'docs/legal/license-agreement.md');
const target = join(root, 'web/js/agreement-text.js');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');

/** The small part of Markdown the agreement uses: headings, paragraphs, bullet lists, bold, code. */
export function toHtml(md) {
  const out = [];
  let list = false;
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const li = /^- (.*)/.exec(line);
    if (!li && list) { out.push('</ul>'); list = false; }
    if (!line) continue;
    if (/^# /.test(line) || /^Version: /.test(line) || /^\*\*DRAFT/.test(line)) continue; // shown by the kiosk itself, or for the document only
    const h = /^(#{2,3}) (.*)/.exec(line);
    if (h) { const n = h[1].length + 1; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}

export function render(md) {
  const version = (/^Version: (\S+)/m.exec(md) || [])[1];
  const title = (/^# (.*)/m.exec(md) || [])[1];
  if (!version || !title) throw new Error('license-agreement.md needs a "# Title" and a "Version: ..." line');
  return `// Made by scripts/sync-agreement.mjs from docs/legal/license-agreement.md. Don't edit: edit that file and run the script.
export const AGREEMENT = ${JSON.stringify({ version, title, html: toHtml(md) }, null, 2)};
`;
}

const want = render(readFileSync(source, 'utf8'));
if (process.argv.includes('--check')) {
  let have = '';
  try { have = readFileSync(target, 'utf8'); } catch { /* missing */ }
  if (have !== want) {
    console.error('web/js/agreement-text.js is out of date. Run: node scripts/sync-agreement.mjs');
    process.exit(1);
  }
  console.log('web/js/agreement-text.js matches docs/legal/license-agreement.md');
} else {
  writeFileSync(target, want);
  console.log('Wrote web/js/agreement-text.js');
}
