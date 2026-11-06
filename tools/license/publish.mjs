// Sends license status files to the website again: every license's, or one.
//   npm run license:publish [-- --id 3f9a1c2b7d4e5f60]
//
// The license tools already send a license's file when they change it. Use
// this when one couldn't be sent (no internet), or after setting up the
// website. The website keeps a file only if it's signed with your key and
// newer than the one it has.
import { readdirSync, existsSync } from 'node:fs';
import { fail, opt, publishStatus, publishTarget } from './lib.mjs';

const dir = opt('out', 'license-status');
if (!existsSync(dir)) fail(`No ${dir} folder here: run this where licenses.json is.`);
const ids = opt('id') ? [opt('id')] : readdirSync(dir).filter((f) => /^[0-9a-f]{16}\.txt$/.test(f)).map((f) => f.slice(0, -4));
if (!ids.length) fail(`No status files in ${dir}.`);
const target = await publishTarget();
if (!target.url) fail(`Not sent: ${target.why}.`);
for (const id of ids) console.log(await publishStatus(id, target));
