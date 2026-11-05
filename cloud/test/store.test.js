// The record store (src/store.js) against a real SQLite database, the same
// engine a Durable Object uses (Node's built-in node:sqlite).
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RecordStore } from '../src/store.js';

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

/** ctx.storage.sql's shape: exec(query, ...bindings) → { toArray() }, counting writes. */
function sqlite() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    writes: 0,
    exec(query, ...bindings) {
      if (/^\s*(INSERT|DELETE|UPDATE)/i.test(query)) sql.writes++;
      // Like ctx.storage.sql.exec, the statement runs straight away.
      const st = db.prepare(query);
      const rows = /^\s*SELECT/i.test(query) ? st.all(...bindings) : (st.run(...bindings), []);
      return { toArray: () => rows };
    },
  };
  return sql;
}

const sql = sqlite();
const rs = new RecordStore(sql);
const s = rs.load();
eq(s, { visitors: [], visits: [], faces: [], passes: [], expected: [], badges: [] }, 'a new company has no records');

s.visitors.push({ id: 'P1', first: 'Peter' }, { id: 'P2', first: 'Samir' });
s.visits.push({ id: 'S1', visitorId: 'P1' });
s.badges.push({ badge: 'V1', status: 'available' });
s.faces.push({ visitorId: 'P1', descriptor: [0.1, 0.2] }); // no id of its own
eq(rs.save(s), { written: 5, deleted: 0 }, 'new records are written');
eq(rs.save(s), { written: 0, deleted: 0 }, 'nothing changed, nothing written');

s.badges[0].status = 'in use';
s.visits.push({ id: 'S2', visitorId: 'P2' });
sql.writes = 0;
eq(rs.save(s), { written: 2, deleted: 0 }, 'only the changed and the new records are written');
eq(sql.writes, 2);

s.visitors = s.visitors.filter((v) => v.id !== 'P1');
s.faces = [];
eq(rs.save(s), { written: 0, deleted: 2 }, 'removed records are deleted');

// A fresh read (a restarted object) gets the same records, in the order they were added.
const again = new RecordStore(sql).load();
eq(again.visitors.map((v) => v.id), ['P2']);
eq(again.visits.map((v) => v.id), ['S1', 'S2'], 'visits keep their order');
eq(again.badges[0].status, 'in use');

// Records added after a reload go after the old ones.
const rs2 = new RecordStore(sql);
const s2 = rs2.load();
s2.visits.push({ id: 'S3' });
s2.visits[0].visitorId = 'P9';
eq(rs2.save(s2), { written: 2, deleted: 0 });
const third = new RecordStore(sql).load();
eq(third.visits.map((v) => v.id), ['S1', 'S2', 'S3']);
eq(third.visits[0].visitorId, 'P9', 'an edit to a reloaded record is saved');

// Settings and other values, and remembered answers for retried requests.
eq(rs.get('kioskKey'), null);
rs.set('kioskKey', 'abc');
rs.set('settings', { org: { name: 'Initech' } });
eq([rs.get('kioskKey'), rs.get('settings').org.name, rs.get('missing', 'UTC')], ['abc', 'Initech', 'UTC']);
rs.remember('rid-1', { ok: true, id: 1 }, 60000);
eq(rs.reply('rid-1', 60000), { ok: true, id: 1 }, 'a retried request gets the first answer');
eq(rs.reply('rid-1', -1), null, 'but not once it is old');
ok(rs.reply('nope', 60000) === null);

console.log(`cloud store tests passed (${checks} checks)`);
