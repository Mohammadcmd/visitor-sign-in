// Switches a license off (new sign-ins pause on that kiosk the next time it's
// online), or back on.
//   npm run license:off -- --id 3f9a1c2b7d4e5f60 [--note "check bounced"]
//   npm run license:on  -- --id 3f9a1c2b7d4e5f60
//
// Switching off never deletes anything on the kiosk: signing out, the roll
// call, the admin screen and exports keep working. The status file is sent
// to the website (site/README.md).
import { fail, findLicense, opt, publishStatus, readLedger, today, writeLedger, writeStatus } from './lib.mjs';

const mode = process.argv[2];
if (mode !== 'off' && mode !== 'on') fail('Usage: node tools/license/switch.mjs off|on --id <license id> [--note "…"]');
const id = opt('id');
if (!id) fail(`Usage: npm run license:${mode} -- --id <license id>${mode === 'off' ? ' [--note "check bounced"]' : ''}`);
const ledger = readLedger();
const lic = findLicense(ledger, id);
lic.status = mode === 'off' ? 'off' : 'active';
(lic.notes ||= []).push(`${today()}: switched ${mode}${opt('note') ? `: ${opt('note')}` : ''}`);
writeLedger(ledger);
const statusFile = writeStatus(lic);
console.error(`${lic.customer} (tablet ${lic.tablet || 'any'}): license switched ${mode}. Status file ${statusFile} updated.`);
console.error(await publishStatus(lic.id));
