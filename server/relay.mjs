// Keeps this computer reachable through the website (site/worker.js), so
// visitors' phones on any network, and the admin screen anywhere, can reach it
// over HTTPS. There's nothing to set up on the router, and no domain needed:
// this computer opens a connection out to the website and keeps it open.
//
//   phone ── HTTPS ──▶ website /box/<id> ── the open connection ──▶ this computer
//
// The website only passes requests along. It proves this computer is the box
// with the box secret (the first computer to connect with an id sets it), and
// the records never leave this computer.
const CHUNK = 256 * 1024;
const PING_MS = 25 * 1000;
const DEAD_MS = 70 * 1000;

/** Splits a long answer into parts the connection can carry. */
export function chunks(id, type, text) {
  const parts = Math.max(1, Math.ceil(text.length / CHUNK));
  return Array.from({ length: parts }, (_, i) => JSON.stringify({ type, id, part: i, parts, data: text.slice(i * CHUNK, (i + 1) * CHUNK) }));
}

/**
 * Connects and stays connected (reconnecting after a dropped Wi-Fi or a restart).
 *   siteUrl   the website, such as https://visitor-sign-in.example.workers.dev/
 *   box       from openBox (box.mjs)
 *   log       where to report (console.log)
 * Resolves { close(), connected() }.
 */
export function connectRelay({ siteUrl, box, log = () => {}, WebSocketImpl = globalThis.WebSocket }) {
  if (!WebSocketImpl) throw new Error('This Node.js has no WebSocket: install Node.js 22 or newer.');
  const url = `${siteUrl.replace(/\/?$/, '/').replace(/^http/, 'ws')}box/${box.config.boxId}/connect`;
  let ws = null;
  let ready = false;
  let stopped = false;
  let wait = 1000;
  let lastHeard = 0;
  let timer = null;
  const incoming = new Map(); // request id → parts

  function open() {
    if (stopped) return;
    ready = false;
    try { ws = new WebSocketImpl(url); } catch (err) { log(`Can't connect to ${url}: ${err.message}`); retry(); return; }
    ws.addEventListener('open', () => {
      lastHeard = Date.now();
      ws.send(JSON.stringify({ type: 'hello', secret: box.config.boxSecret, name: box.config.name }));
    });
    ws.addEventListener('message', (ev) => {
      lastHeard = Date.now();
      const text = typeof ev.data === 'string' ? ev.data : '';
      if (text === 'pong') return;
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.type === 'ready') {
        ready = true;
        wait = 1000;
        log('Connected to the website: phones and the admin screen can reach this computer.');
      } else if (msg.type === 'refused') {
        log(`The website refused this computer: ${msg.error || 'unknown'}. ${msg.error === 'secret' ? 'Another computer already uses this box id: set up again with a new data folder.' : ''}`);
        wait = 10 * 60 * 1000;
      } else if (msg.type === 'req') {
        const got = incoming.get(msg.id) || [];
        got[msg.part] = msg.data;
        incoming.set(msg.id, got);
        if (got.filter((x) => x !== undefined).length < msg.parts) return;
        incoming.delete(msg.id);
        answer(msg.id, got.join(''));
      }
    });
    ws.addEventListener('close', () => { if (ready) log('Lost the connection to the website: reconnecting…'); ready = false; retry(); });
    ws.addEventListener('error', () => {});
  }

  async function answer(id, body) {
    let out;
    try { out = await box.handle(JSON.parse(body)); } catch (err) { out = { ok: false, error: 'server', detail: String(err.message || err).slice(0, 200) }; }
    if (!ws || ws.readyState !== 1) return;
    for (const part of chunks(id, 'res', JSON.stringify(out))) ws.send(part);
  }

  function retry() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(open, wait);
    wait = Math.min(wait * 2, 60 * 1000);
  }

  // A small ping keeps the connection alive through home routers; silence means it's gone.
  const beat = setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    if (Date.now() - lastHeard > DEAD_MS) { try { ws.close(); } catch { /* closed */ } return; }
    ws.send('ping');
  }, PING_MS);

  open();
  return {
    connected: () => ready,
    close() { stopped = true; clearInterval(beat); clearTimeout(timer); try { ws?.close(); } catch { /* closed */ } },
  };
}
