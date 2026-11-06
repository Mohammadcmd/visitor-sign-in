// Renews a license for another year (or to a date), usually after a payment.
//   npm run license:renew -- --id 3f9a1c2b7d4e5f60 [--paid check --amount 149 --ref 1234] [--until 2028-11-05 | --years 2]
//
// The new year starts from the current paid-until date (or today, if it ended
// long ago). Writes the license's status file: once you publish the
// license-status folder, the kiosk picks up the renewal by itself the next
// time it's online. The new key is printed too, for a kiosk that's offline.
import { addYears, fail, findLicense, isDate, makeKey, money, opt, readLedger, recordPayment, today, writeLedger, writeStatus } from './lib.mjs';

const id = opt('id');
if (!id) fail('Usage: npm run license:renew -- --id <license id> [--paid check --amount 149 --ref 1234] [--until 2028-11-05 | --years 2]');
const ledger = readLedger();
const lic = findLicense(ledger, id);
if (!lic.until) fail(`License ${id} has no end date: nothing to renew.`);
let until = opt('until');
if (until && !isDate(until)) fail('--until should look like 2028-11-05');
if (!until) {
  const from = lic.until >= today() ? lic.until : today();
  until = addYears(from, Number(opt('years', '1')) || 1);
}
if (until <= lic.until) fail(`${until} isn't after the current paid-until date (${lic.until}).`);

const before = lic.until;
Object.assign(lic, { until, status: 'active' });
lic.key = makeKey(lic);
const paid = recordPayment(ledger, lic, `Renewal to ${until}`);
writeLedger(ledger);
const statusFile = writeStatus(lic);

console.log(lic.key);
console.error(`\n${lic.customer}: tablet ${lic.tablet || 'any'}, paid until ${until} (was ${before}).`);
if (paid) console.error(`Payment recorded: ${money(paid.amount)} by ${paid.method}${paid.ref ? ` (${paid.ref})` : ''}.`);
console.error(`Status file ${statusFile} updated: publish the license-status folder and the kiosk renews itself when it's next online.`);
