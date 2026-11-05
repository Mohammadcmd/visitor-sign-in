// The signature pad on the visitor rules step: smooth finger strokes on a
// canvas, a check that it's a real signature (not a stray tap), and a small,
// trimmed PNG of the result.

export class SignaturePad {
  constructor(canvas, { onChange = () => {} } = {}) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.strokes = [];
    this.current = null;
    this.ink = 0; // total stroke length in CSS pixels
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) canvas.addEventListener(ev, () => this.up());
  }

  /** Matches the drawing surface to the canvas's size on screen (call when it becomes visible). */
  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.scale = dpr;
    this.redraw();
  }

  point(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  down(e) {
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    // The pad may have been measured mid-transition: match its size before drawing.
    const r = this.canvas.getBoundingClientRect();
    if (!this.scale || Math.abs(this.canvas.width - Math.round(r.width * this.scale)) > 1) this.resize();
    this.current = [this.point(e)];
    this.strokes.push(this.current);
  }

  move(e) {
    if (!this.current) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const p = this.point(ev);
      const last = this.current[this.current.length - 1];
      const d = Math.hypot(p.x - last.x, p.y - last.y);
      if (d < 1) continue;
      this.ink += d;
      this.current.push(p);
    }
    this.redraw();
  }

  up() {
    if (!this.current) return;
    this.current = null;
    this.onChange(this.isSigned());
  }

  /** Enough ink to be a signature rather than a tap or a dot. */
  isSigned() { return this.ink >= 60; }

  clear() {
    this.strokes = [];
    this.current = null;
    this.ink = 0;
    this.redraw();
    this.onChange(false);
  }

  redraw(ctx = this.canvas.getContext('2d'), scale = this.scale || 1, dx = 0, dy = 0) {
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (ctx.canvas === this.canvas) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = '#0d1b2a';
    for (const s of this.strokes) {
      ctx.beginPath();
      ctx.moveTo(s[0].x - dx, s[0].y - dy);
      if (s.length === 1) ctx.lineTo(s[0].x - dx + 0.1, s[0].y - dy);
      // Smooth curves through the midpoints between samples.
      for (let i = 1; i < s.length - 1; i++) {
        const mx = (s[i].x + s[i + 1].x) / 2, my = (s[i].y + s[i + 1].y) / 2;
        ctx.quadraticCurveTo(s[i].x - dx, s[i].y - dy, mx - dx, my - dy);
      }
      if (s.length > 1) ctx.lineTo(s[s.length - 1].x - dx, s[s.length - 1].y - dy);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** The signature cropped to its ink with a little margin, on a transparent background. */
  toDataURL() {
    const pts = this.strokes.flat();
    if (!pts.length) return '';
    const pad = 8;
    const minX = Math.min(...pts.map((p) => p.x)) - pad, minY = Math.min(...pts.map((p) => p.y)) - pad;
    const w = Math.max(...pts.map((p) => p.x)) + pad - minX, h = Math.max(...pts.map((p) => p.y)) + pad - minY;
    const scale = Math.min(2, 600 / w);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * scale));
    out.height = Math.max(1, Math.round(h * scale));
    this.redraw(out.getContext('2d'), scale, minX, minY);
    return out.toDataURL('image/png');
  }
}
