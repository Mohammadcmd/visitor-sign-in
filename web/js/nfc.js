// USB/Bluetooth NFC readers act as keyboards: they "type" the tag number and
// press Enter. A tap is told apart from a person typing by speed.
import { normalizeTag } from './match.js';

const MIN_CHARS = 4;
const MAX_AVG_GAP_MS = 45;
const MAX_ENTER_GAP_MS = 150;
const RESET_GAP_MS = 120;
const DOUBLE_READ_MS = 3000;

/**
 * onTap(tag, typedCount): a badge was tapped; typedCount characters were also
 *   delivered to onKey and should be removed from wherever they went.
 * onKey(key): any other printable key or Backspace (lets a hardware keyboard type into fields).
 */
export function listenForTaps(onTap, onKey) {
  let buf = [];
  let last = { tag: '', at: 0 };

  document.addEventListener('keydown', (e) => {
    const t = performance.now();
    if (e.key === 'Enter') {
      const gaps = buf.slice(1).map((c, i) => c.t - buf[i].t);
      const avg = gaps.length ? gaps.reduce((x, y) => x + y, 0) / gaps.length : Infinity;
      const isTap = buf.length >= MIN_CHARS && avg < MAX_AVG_GAP_MS && t - buf[buf.length - 1].t < MAX_ENTER_GAP_MS;
      const typed = buf.length;
      const raw = buf.map((c) => c.k).join('');
      buf = [];
      if (!isTap) return;
      e.preventDefault();
      e.stopPropagation();
      const tag = normalizeTag(raw);
      if (!tag) return;
      if (tag === last.tag && t - last.at < DOUBLE_READ_MS) { onTap(null, typed); return; }
      last = { tag, at: t };
      onTap(tag, typed);
      return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (buf.length && t - buf[buf.length - 1].t > RESET_GAP_MS) buf = [];
      buf.push({ k: e.key, t });
      e.preventDefault();
      onKey(e.key);
    } else if (e.key === 'Backspace') {
      buf = [];
      e.preventDefault();
      onKey('Backspace');
    }
  }, true);
}
