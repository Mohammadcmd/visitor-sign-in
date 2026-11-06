// Keeps one company's records in its Durable Object's SQLite database.
//
// The shared engine (web/js/engine.js) works on a plain object of arrays
// (visitors, visits, badges...). Here each record is one row, so a change
// writes only the rows that changed, not the whole company. Rows remember the
// order records were added in, which the engine relies on (newest visits last).
import { emptyStore } from '../../web/js/engine.js';

const KINDS = Object.keys(emptyStore());
const newRid = () => crypto.randomUUID();

export class RecordStore {
  /** sql: { exec(query, ...bindings) → { toArray() } }, as ctx.storage.sql in a Durable Object. */
  constructor(sql) {
    this.sql = sql;
    sql.exec('CREATE TABLE IF NOT EXISTS records (rid TEXT PRIMARY KEY, kind TEXT NOT NULL, ord INTEGER NOT NULL, data TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS records_order ON records (kind, ord)');
    sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS replies (rid TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL)');
    this.ids = new WeakMap(); // record object → row id
    this.saved = new Map(); // row id → { kind, json, ord } as last written
    this.nextOrd = 1;
  }

  /** Reads every record into a fresh store object. */
  load() {
    const store = emptyStore();
    this.ids = new WeakMap();
    this.saved.clear();
    let max = 0;
    for (const row of this.sql.exec('SELECT rid, kind, ord, data FROM records ORDER BY kind, ord').toArray()) {
      if (!store[row.kind]) continue;
      const rec = JSON.parse(row.data);
      store[row.kind].push(rec);
      this.ids.set(rec, row.rid);
      this.saved.set(row.rid, { kind: row.kind, json: row.data, ord: row.ord });
      max = Math.max(max, row.ord);
    }
    this.nextOrd = max + 1;
    return store;
  }

  /**
   * Writes the records that were added or changed and deletes the ones that are
   * gone. Synchronous, so a Durable Object commits it as one unit.
   * (It compares each record with its saved copy: fine for a company's records,
   * a few MB at most.)
   */
  save(store) {
    const seen = new Set();
    let written = 0, deleted = 0;
    for (const kind of KINDS) {
      for (const rec of store[kind] || []) {
        let rid = this.ids.get(rec);
        if (!rid || seen.has(rid)) { rid = newRid(); this.ids.set(rec, rid); }
        seen.add(rid);
        const json = JSON.stringify(rec);
        const was = this.saved.get(rid);
        if (was && was.kind === kind && was.json === json) continue;
        const ord = was && was.kind === kind ? was.ord : this.nextOrd++;
        this.sql.exec('INSERT INTO records (rid, kind, ord, data) VALUES (?, ?, ?, ?) ON CONFLICT(rid) DO UPDATE SET kind = excluded.kind, ord = excluded.ord, data = excluded.data',
          rid, kind, ord, json);
        this.saved.set(rid, { kind, json, ord });
        written++;
      }
    }
    for (const rid of [...this.saved.keys()]) {
      if (seen.has(rid)) continue;
      this.sql.exec('DELETE FROM records WHERE rid = ?', rid);
      this.saved.delete(rid);
      deleted++;
    }
    return { written, deleted };
  }

  /** A saved value (kiosk key, settings, time zone), or fallback. */
  get(k, fallback = null) {
    const row = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0];
    return row ? JSON.parse(row.v) : fallback;
  }

  set(k, v) {
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v));
  }

  /** The answer already given to this request id, if it's recent. */
  reply(rid, maxAgeMs) {
    const row = this.sql.exec('SELECT at, body FROM replies WHERE rid = ?', rid).toArray()[0];
    return row && Date.now() - row.at < maxAgeMs ? JSON.parse(row.body) : null;
  }

  remember(rid, out, maxAgeMs) {
    this.sql.exec('DELETE FROM replies WHERE at < ?', Date.now() - maxAgeMs);
    this.sql.exec('INSERT INTO replies (rid, at, body) VALUES (?, ?, ?) ON CONFLICT(rid) DO UPDATE SET at = excluded.at, body = excluded.body',
      rid, Date.now(), JSON.stringify(out));
  }
}
