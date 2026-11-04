// QR codes for links a person should open on another device (connecting a
// tablet, getting an update, buying a license), drawn as crisp SVG.
import qrcode from '../vendor/qrcode/qrcode.js';

/** An <svg> string for the text; size is the drawn width in pixels. */
export function qrSvg(text, { size = 220, label = 'QR code' } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  const w = n + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="qr" role="img" aria-label="${label.replace(/"/g, '&quot;')}" width="${size}" height="${size}" viewBox="0 0 ${w} ${w}" shape-rendering="crispEdges"><rect width="${w}" height="${w}" fill="#fff"/><path fill="#0d1b2a" d="${d}"/></svg>`;
}
