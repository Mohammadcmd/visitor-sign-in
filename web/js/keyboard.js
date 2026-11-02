// On-screen keyboard. The iPad hides its own keyboard while a keyboard-style
// NFC reader is connected, so the kiosk brings its own. Fields are readonly
// <input>s; this writes their value and fires an 'input' event.

const ROWS = {
  text: [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"],
    ['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '-', 'back'],
    [',', '.', 'space', '&', 'done'],
  ],
};

export class Keyboard {
  constructor(root) {
    this.root = root;
    this.input = null;
    this.shift = false;
    this.manualShift = false;
    root.addEventListener('pointerdown', (e) => {
      const key = e.target.closest('[data-key]');
      if (!key) return;
      e.preventDefault();
      key.classList.add('pressed');
      setTimeout(() => key.classList.remove('pressed'), 120);
      this.press(key.dataset.key);
    });
    this.render();
  }

  render() {
    const upper = this.shift;
    this.root.innerHTML = ROWS.text.map((row) => `<div class="kb-row">${row.map((k) => {
      if (k === 'shift') return `<button type="button" class="kb-key kb-wide ${upper ? 'on' : ''}" data-key="shift" aria-label="Shift">⇧</button>`;
      if (k === 'back') return '<button type="button" class="kb-key kb-wide" data-key="back" aria-label="Delete">⌫</button>';
      if (k === 'space') return '<button type="button" class="kb-key kb-space" data-key=" ">space</button>';
      if (k === 'done') return '<button type="button" class="kb-key kb-done" data-key="done">Done</button>';
      const shown = upper ? k.toUpperCase() : k;
      return `<button type="button" class="kb-key" data-key="${shown}">${shown}</button>`;
    }).join('')}</div>`).join('');
  }

  open(input) {
    if (this.input && this.input !== input) this.input.classList.remove('kb-focus');
    this.input = input;
    input.classList.add('kb-focus');
    this.manualShift = false;
    this.autoShift();
    document.body.classList.add('kb-open');
    this.root.hidden = false;
    document.documentElement.style.setProperty('--kb-h', `${this.root.offsetHeight}px`);
    // Keep the field visible in the space left above the keyboard and the action bar.
    requestAnimationFrame(() => {
      const box = input.closest('.form-body');
      if (!box) return;
      const top = box.getBoundingClientRect().top;
      const bottom = window.innerHeight - this.root.offsetHeight - 90;
      const r = input.getBoundingClientRect();
      box.scrollTop += r.top + r.height / 2 - (top + (bottom - top) * 0.5);
    });
  }

  close() {
    if (this.input) this.input.classList.remove('kb-focus');
    this.input = null;
    document.body.classList.remove('kb-open');
    this.root.hidden = true;
  }

  /** Capitalize at the start of each word in name-like fields. */
  autoShift() {
    if (this.manualShift) return;
    const v = this.input ? this.input.value : '';
    const want = !!this.input && this.input.dataset.cap === 'words' && (v === '' || /[\s\-']$/.test(v));
    if (want !== this.shift) { this.shift = want; this.render(); }
  }

  press(k) {
    if (!this.input) return;
    if (k === 'shift') { this.shift = !this.shift; this.manualShift = this.shift; this.render(); return; }
    if (k === 'done') { this.close(); return; }
    this.type(k === 'back' ? 'Backspace' : k);
    if (this.manualShift) { this.manualShift = false; this.shift = false; this.render(); }
    this.autoShift();
  }

  /** Also used for hardware keyboard input. */
  type(k) {
    const el = this.input;
    if (!el) return;
    const max = Number(el.getAttribute('maxlength')) || 120;
    if (k === 'Backspace') el.value = el.value.slice(0, -1);
    else if (el.value.length < max) el.value += k;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    this.autoShift();
  }

  /** Remove characters an NFC reader typed into the field. */
  untype(n) {
    if (!this.input || !n) return;
    this.input.value = this.input.value.slice(0, Math.max(0, this.input.value.length - n));
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
