// Keynote-style screen transitions, built on the Web Animations API.
//
//   zoom    welcome → choice: the welcome scene pushes past the viewer while the
//           logo flies ("magic move") from the welcome card into the top bar
//   expand  choice → form/returning: the tapped card grows to become the next screen
//   iris    → badge: a circle opens from where the visitor tapped
//   flip    badge → done: the whole screen turns over like a card
//   home    → welcome: the screen falls away into the welcome scene, logo flies back
//   push    everything else: the next screen slides over with depth and parallax
//   cube    between form steps: the step turns like the face of a cube
//
// Every screen's content then cascades in (headline wipes up, items rise and
// sharpen one after another). Reduced-motion users get a plain crossfade.

const EASE_OUT = 'cubic-bezier(.16,1,.3,1)';
const EASE_IN_OUT = 'cubic-bezier(.65,0,.35,1)';
const EASE_SPRING = 'cubic-bezier(.34,1.56,.64,1)';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The transition in flight: its animations and the cleanup that ends it.
let current = null;

/** Ends the in-flight transition at once, so a new one starts from a clean state. */
function settle() {
  if (!current) return;
  const c = current;
  current = null;
  c.anims.forEach((a) => a.cancel());
  c.cleanup();
}

// On older tablets (.lite) blur is too slow to animate smoothly; leave it out.
function lite(keyframes) {
  if (!document.documentElement.classList.contains('lite')) return keyframes;
  return keyframes.map(({ filter, ...rest }) => rest);
}

function anim(el, keyframes, options) {
  return el.animate(lite(keyframes), { fill: 'both', ...options });
}

const done = (anims) => Promise.all(anims.map((a) => a.finished.catch(() => {})));

function center(rect) {
  return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

/** Radius that covers the whole viewport from (x, y). */
function coverRadius({ x, y }) {
  const w = window.innerWidth, h = window.innerHeight;
  return Math.hypot(Math.max(x, w - x), Math.max(y, h - y)) + 20;
}

/**
 * Magic move: a copy of `fromEl` flies to `toEl`'s position and size while both
 * originals stay hidden. Returns the animation.
 */
function morph(fromEl, toEl, duration, delay = 0) {
  if (!fromEl || !toEl) return null;
  const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
  if (!a.width || !b.width) return null;
  const ghost = fromEl.cloneNode(true);
  Object.assign(ghost.style, {
    position: 'fixed', left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px`,
    margin: '0', zIndex: '90', pointerEvents: 'none', transformOrigin: '0 0',
  });
  document.body.appendChild(ghost);
  fromEl.style.visibility = 'hidden';
  toEl.style.visibility = 'hidden';
  const dx = b.left - a.left, dy = b.top - a.top, sx = b.width / a.width, sy = b.height / a.height;
  const lift = Math.min(120, Math.hypot(dx, dy) * 0.18);
  const m = anim(ghost, [
    { transform: 'translate(0,0) scale(1,1)', filter: 'drop-shadow(0 0 0 rgba(0,0,0,0))' },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - lift}px) scale(${(1 + sx) / 2}, ${(1 + sy) / 2})`, filter: 'drop-shadow(0 30px 40px rgba(0,0,0,.35))', offset: 0.55 },
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, filter: 'drop-shadow(0 0 0 rgba(0,0,0,0))' },
  ], { duration, delay, easing: EASE_IN_OUT });
  m.finished.catch(() => {}).then(() => {
    ghost.remove();
    fromEl.style.visibility = '';
    toEl.style.visibility = '';
  });
  return m;
}

// Elements that cascade in on each screen, in order.
const CASCADE = [
  '.bar > :not(.bar-logo):not(.cam-bubble)', '.eyebrow', '.welcome-title', '.welcome-sub', '.tap-cta', '.welcome-foot',
  'h2', '.hint', '.intro-text p', '.field', '.chips .chip', '.options .option', '.rules li', '.agree',
  '.camera-frame', '.camera-actions', '.quick-card', '.quick-actions > *', '.choice-card',
  '.match', '.no-match', '.badge-sub', '.tap-scene', '.badge-status',
  '.done-check', '.done-badge', '.done-text', '.done-wrap > .btn-secondary', '.form-foot',
  '.admin-head', '.admin-row', '.center-card > *',
].join(',');

/** Content builds in one piece at a time, like a Keynote build. */
export function cascade(root, { delay = 0, step = 55, skip } = {}) {
  if (reduced()) return;
  const items = [...root.querySelectorAll(CASCADE)].filter((el) => {
    if (skip && skip.contains(el)) return false;
    if (el.closest('[hidden]') || el.offsetParent === null) return false;
    // Only animate the outermost match so nested items don't double-animate.
    const parent = el.parentElement.closest(CASCADE);
    return !parent || !root.contains(parent);
  });
  items.slice(0, 18).forEach((el, i) => {
    const isHeadline = el.matches('h2, .welcome-title');
    const keyframes = isHeadline
      ? [
        { opacity: 0, transform: 'translateY(40%)', clipPath: 'inset(0 0 100% 0)' },
        { opacity: 1, transform: 'translateY(0)', clipPath: 'inset(0 0 -20% 0)' },
      ]
      : el.matches('.choice-card')
        ? [
          { opacity: 0, transform: 'perspective(900px) rotateX(28deg) translateY(60px) scale(.92)' },
          { opacity: 1, transform: 'perspective(900px) rotateX(0) translateY(0) scale(1)' },
        ]
        : [
          { opacity: 0, transform: 'translateY(26px) scale(.98)', filter: 'blur(6px)' },
          { opacity: 1, transform: 'translateY(0) scale(1)', filter: 'blur(0)' },
        ];
    const a = el.animate(lite(keyframes), {
      duration: isHeadline ? 750 : 650,
      delay: delay + i * step,
      easing: el.matches('.choice-card, .done-badge') ? EASE_SPRING : EASE_OUT,
      fill: 'backwards',
    });
    // Leave no inline effect behind once the build is over.
    a.finished.catch(() => {}).then(() => a.cancel());
  });
}

/**
 * Plays the transition from one screen element to another. The caller has
 * already decided which screen is next; this only animates and swaps classes.
 */
export async function screen(from, to, kind, opts = {}) {
  settle();
  if (from === to) return;
  if (reduced()) kind = 'fade';

  from.classList.add('leaving');
  to.classList.add('active');
  from.classList.remove('active');
  from.style.zIndex = '1';
  to.style.zIndex = '2';

  const anims = [];
  const D = 820;
  let contentDelay = 260;

  switch (kind) {
    case 'zoom': {
      from.style.zIndex = '3';
      anims.push(anim(from, [
        { transform: 'scale(1)', opacity: 1, filter: 'blur(0)' },
        { transform: 'scale(1.6)', opacity: 0, filter: 'blur(14px)' },
      ], { duration: D, easing: EASE_IN_OUT }));
      anims.push(anim(to, [
        { transform: 'scale(.82)', opacity: 0 },
        { transform: 'scale(1)', opacity: 1 },
      ], { duration: D, delay: 120, easing: EASE_OUT }));
      const m = morph(from.querySelector('.logo-card img'), to.querySelector('.bar-logo'), D + 80);
      if (m) anims.push(m);
      contentDelay = 360;
      break;
    }
    case 'expand': {
      const r = opts.rect || { left: innerWidth / 2 - 100, top: innerHeight / 2 - 100, width: 200, height: 200 };
      const inset = `inset(${r.top}px ${innerWidth - r.right}px ${innerHeight - r.bottom}px ${r.left}px round 28px)`;
      anims.push(anim(to, [
        { clipPath: inset, filter: 'brightness(1.08)' },
        { clipPath: 'inset(0px 0px 0px 0px round 0px)', filter: 'brightness(1)' },
      ], { duration: D, easing: EASE_IN_OUT }));
      anims.push(anim(from, [
        { transform: 'scale(1)', filter: 'brightness(1) blur(0)' },
        { transform: 'scale(.9)', filter: 'brightness(.6) blur(4px)' },
      ], { duration: D, easing: EASE_IN_OUT }));
      contentDelay = 420;
      break;
    }
    case 'iris': {
      const c = opts.origin || center();
      const R = coverRadius(c);
      anims.push(anim(to, [
        { clipPath: `circle(0px at ${c.x}px ${c.y}px)` },
        { clipPath: `circle(${R}px at ${c.x}px ${c.y}px)` },
      ], { duration: D + 120, easing: EASE_IN_OUT }));
      anims.push(anim(from, [
        { transform: 'scale(1) rotate(0)', filter: 'blur(0)' },
        { transform: 'scale(.92) rotate(-1.5deg)', filter: 'blur(6px)' },
      ], { duration: D + 120, easing: EASE_IN_OUT }));
      contentDelay = 420;
      break;
    }
    case 'flip': {
      const T = 900;
      from.style.backfaceVisibility = 'hidden';
      to.style.backfaceVisibility = 'hidden';
      anims.push(anim(from, [
        { transform: 'perspective(1800px) rotateY(0deg) scale(1)' },
        { transform: 'perspective(1800px) rotateY(90deg) scale(.86)' },
      ], { duration: T / 2, easing: 'cubic-bezier(.55,0,.9,.4)' }));
      anims.push(anim(to, [
        { transform: 'perspective(1800px) rotateY(-90deg) scale(.86)' },
        { transform: 'perspective(1800px) rotateY(0deg) scale(1)' },
      ], { duration: T / 2, delay: T / 2, easing: 'cubic-bezier(.1,.6,.45,1)' }));
      contentDelay = T / 2 + 80;
      break;
    }
    case 'home': {
      from.style.zIndex = '3';
      anims.push(anim(from, [
        { transform: 'translateY(0) scale(1)', opacity: 1, filter: 'blur(0)' },
        { transform: 'translateY(6%) scale(.86)', opacity: 0, filter: 'blur(10px)' },
      ], { duration: D, easing: EASE_IN_OUT }));
      anims.push(anim(to, [
        { transform: 'scale(1.25)', opacity: 0 },
        { transform: 'scale(1)', opacity: 1 },
      ], { duration: D + 200, delay: 80, easing: EASE_OUT }));
      const m = morph(from.querySelector('.bar-logo'), to.querySelector('.logo-card img'), D + 100);
      if (m) anims.push(m);
      contentDelay = 380;
      break;
    }
    case 'rise': {
      anims.push(anim(to, [
        { transform: 'translateY(100%)', boxShadow: '0 -30px 60px rgba(0,0,0,.25)' },
        { transform: 'translateY(0)', boxShadow: '0 0 0 rgba(0,0,0,0)' },
      ], { duration: D, easing: EASE_OUT }));
      anims.push(anim(from, [
        { transform: 'scale(1)', filter: 'brightness(1)' },
        { transform: 'scale(.92)', filter: 'brightness(.5)' },
      ], { duration: D, easing: EASE_OUT }));
      break;
    }
    case 'push': {
      const dir = opts.back ? -1 : 1;
      anims.push(anim(to, [
        { transform: `translateX(${dir * 100}%)`, boxShadow: '-40px 0 80px rgba(3,29,56,.25)' },
        { transform: 'translateX(0)', boxShadow: '0 0 0 rgba(3,29,56,0)' },
      ], { duration: D, easing: EASE_OUT }));
      anims.push(anim(from, [
        { transform: 'translateX(0) scale(1)', filter: 'brightness(1)' },
        { transform: `translateX(${-dir * 28}%) scale(.94)`, filter: 'brightness(.65)' },
      ], { duration: D, easing: EASE_OUT }));
      contentDelay = 300;
      break;
    }
    default: {
      anims.push(anim(to, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 }));
      anims.push(anim(from, [{ opacity: 1 }, { opacity: 0 }], { duration: 300 }));
      contentDelay = 0;
    }
  }

  if (!opts.noCascade) cascade(to, { delay: contentDelay });

  const mine = {
    anims,
    cleanup() {
      from.classList.remove('leaving');
      [from, to].forEach((el) => { el.style.zIndex = ''; el.style.backfaceVisibility = ''; });
    },
  };
  current = mine;
  await done(anims);
  if (current === mine) settle();
}

/** Cube rotation between two form steps inside the same screen. */
export async function step(from, to, back = false) {
  settle();
  if (!from || from === to) { to.classList.add('active'); cascade(to); return; }
  if (reduced()) {
    from.classList.remove('active');
    to.classList.add('active');
    return;
  }
  const host = to.parentElement;
  const top = from.offsetTop;
  from.classList.add('leaving');
  Object.assign(from.style, { position: 'absolute', top: `${top}px`, left: `${from.offsetLeft}px`, width: `${from.offsetWidth}px` });
  from.classList.remove('active');
  to.classList.add('active');
  host.style.perspective = '1600px';

  const d = back ? -1 : 1;
  const T = 760;
  const out = from.animate([
    { transform: 'translateX(0) rotateY(0deg)', opacity: 1, transformOrigin: d > 0 ? '0% 50%' : '100% 50%' },
    { transform: `translateX(${-d * 45}%) rotateY(${d * 70}deg)`, opacity: 0, transformOrigin: d > 0 ? '0% 50%' : '100% 50%' },
  ], { duration: T, easing: EASE_IN_OUT, fill: 'both' });
  const inn = to.animate([
    { transform: `translateX(${d * 45}%) rotateY(${-d * 70}deg)`, opacity: 0, transformOrigin: d > 0 ? '100% 50%' : '0% 50%' },
    { transform: 'translateX(0) rotateY(0deg)', opacity: 1, transformOrigin: d > 0 ? '100% 50%' : '0% 50%' },
  ], { duration: T, easing: EASE_IN_OUT, fill: 'both' });
  cascade(to, { delay: 280, step: 45 });
  const mine = {
    anims: [out, inn],
    cleanup() {
      from.classList.remove('leaving');
      from.style.cssText = '';
      host.style.perspective = '';
    },
  };
  current = mine;
  await done(mine.anims);
  if (current === mine) settle();
}

/** Celebration burst in Shock Tech's colors. */
export function confetti(origin) {
  if (reduced()) return;
  const canvas = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '95' });
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const colors = ['#f39220', '#b5121b', '#6a9a3a', '#1a7fd0', '#0a5ea8', '#ffffff'];
  const o = origin || { x: innerWidth / 2, y: innerHeight * 0.32 };
  const parts = Array.from({ length: 160 }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.3;
    const speed = 7 + Math.random() * 11;
    return {
      x: o.x, y: o.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      w: 6 + Math.random() * 8, h: 8 + Math.random() * 10, r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4, c: colors[(Math.random() * colors.length) | 0],
      round: Math.random() < 0.3,
    };
  });
  const start = performance.now();
  (function frame(t) {
    const life = (t - start) / 2600;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.32;
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - life);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.scale(1, Math.cos(p.r * 2));
      ctx.fillStyle = p.c;
      if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (life < 1) requestAnimationFrame(frame);
    else canvas.remove();
  })(start);
}
