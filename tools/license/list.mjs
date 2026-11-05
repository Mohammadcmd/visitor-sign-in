// What you've sold, what's coming up for renewal, and what's been paid.
//   npm run license:list                 every license, soonest renewal first
//   npm run license:list -- --due 30     only those ending in the next 30 days (or already ended)
//   npm run license:payments [-- --csv payments.csv]   every payment, for your accountant
import { writeFileSync } from 'node:fs';
import { money, opt, readLedger, today } from './lib.mjs';

const ledger = readLedger();

if (process.argv[2] === 'payments') {
  const cell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const rows = [['Date', 'Customer', 'Tablet', 'License', 'Amount', 'Method', 'Reference', 'Note'],
    ...ledger.payments.map((p) => [p.date, p.customer, p.tablet, p.license, p.amount, p.method, p.ref, p.note])];
  const csv = `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
  const file = opt('csv');
  if (file) {
    writeFileSync(file, csv);
    const total = ledger.payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    console.error(`${ledger.payments.length} payments (${money(total)}) saved to ${file}.`);
  } else process.stdout.write(csv);
  process.exit(0);
}

const due = opt('due') ? Number(opt('due')) : null;
const day = 86400000;
const left = (l) => (l.until ? Math.ceil((new Date(`${l.until}T23:59:59`).getTime() - Date.now()) / day) : Infinity);
const list = ledger.licenses
  .filter((l) => due === null || (l.status === 'active' && left(l) <= due))
  .sort((a, b) => left(a) - left(b));
if (!list.length) {
  console.log(due === null ? 'No licenses yet. Make one with: npm run license:issue' : `Nothing due in the next ${due} days.`);
  process.exit(0);
}
console.log(`Licenses${due === null ? '' : ` ending by ${new Date(Date.now() + due * day).toISOString().slice(0, 10)}`} (today is ${today()}):\n`);
for (const l of list) {
  const d = left(l);
  const when = !l.until ? 'no end date' : d < 0 ? `ENDED ${l.until} (${-d} days ago)` : `paid until ${l.until} (${d} days)`;
  console.log(`  ${l.id}  ${l.customer}  tablet ${l.tablet || 'any'}  ${when}${l.status === 'off' ? '  [switched off]' : ''}${l.email ? `  ${l.email}` : ''}`);
}
