// Native bits of the Android app (see android/), and saving files from the kiosk.

/** The Android app's Kiosk plugin, or null in a browser. */
export const Kiosk = window.Capacitor?.isNativePlatform?.() ? window.Capacitor.registerPlugin?.('Kiosk') || null : null;

/**
 * Saves a text file for the person at the tablet. In the Android app it goes
 * to the Downloads folder (a web download does nothing in the app); in a
 * browser it's a normal download. Resolves with where it went.
 */
export async function saveFile(name, text, mime = 'text/plain') {
  if (Kiosk?.saveFile) {
    const out = await Kiosk.saveFile({ name, text, mime });
    return out?.where || 'Downloads';
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return 'your downloads';
}

/** A CSV file that opens cleanly in Excel and Google Sheets, with formula-looking cells defused. */
export function toCsv(header, rows) {
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** "2026-11-04" for file names, in the tablet's own time zone. */
export function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
