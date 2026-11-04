// Name, company and NFC tag normalization. Mirrors the helpers in
// apps-script/Code.gs so the kiosk's demo mode matches the real backend.

export function nameKey(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter((t) => t.length > 1).join(' ');
}

const COMPANY_STOP = new Set(['INC', 'LLC', 'LTD', 'CO', 'CORP', 'CORPORATION', 'COMPANY', 'THE',
  'GROUP', 'LP', 'PLC', 'GMBH', 'AND', 'OF', 'NA']);

export function companyWords(s) {
  return nameKey(s).split(' ').filter((w) => w && !COMPANY_STOP.has(w));
}

export function sameCompany(a, b) {
  if (!a.length && !b.length) return true;
  return a.some((x) => x.length >= 3 && b.some((y) => y.length >= 3 && near(x, y)));
}

/** Equal, or both at least 5 characters and one edit apart. */
export function near(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Uppercase A-Z/0-9 only; collapse readers that send the number twice. */
export function normalizeTag(s) {
  let t = String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t.length >= 8 && t.length % 2 === 0 && t.slice(0, t.length / 2) === t.slice(t.length / 2)) {
    t = t.slice(0, t.length / 2);
  }
  return t;
}
