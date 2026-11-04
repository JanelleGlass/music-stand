// The scroll bar down the right edge of a score: drag its handle to move
// quickly through a long score, or tap the track to jump there. While it's
// held, a label shows the page you'd land on.
//
// It shows with the top bar, and while scrolling by hand. One page at a
// time, it moves a page at a time (without the page-turn animation).
import { handleTop, fractionAt } from './scrub.js';

const SHOW_MS = 1200; // after scrolling by hand stops
const INPUT_MS = 2500; // a scroll this soon after a touch or wheel is by hand (iOS keeps gliding)

export class Scrubber {
  // el: the .scrub element. onStart / onEnd: a drag begins and ends.
  constructor(el, viewer, { onStart = () => {}, onEnd = () => {} } = {}) {
    this.el = el;
    this.viewer = viewer;
    this.handle = el.querySelector('.scrub-handle');
    this.label = el.querySelector('.scrub-label');
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.drag = null;
    this.raf = 0;
    this.lastInput = 0;
    this.hideTimer = 0;

    const sc = viewer.scroller;
    const input = () => { this.lastInput = performance.now(); };
    for (const t of ['touchstart', 'touchmove', 'touchend', 'wheel']) sc.addEventListener(t, input, { passive: true });
    sc.addEventListener('scroll', () => this.#onScroll(), { passive: true });
    viewer.addEventListener('page', () => this.update());
    new ResizeObserver(() => this.update()).observe(el);

    el.addEventListener('pointerdown', (e) => this.#down(e));
    el.addEventListener('pointermove', (e) => this.#move(e));
    el.addEventListener('pointerup', (e) => this.#up(e));
    el.addEventListener('pointercancel', (e) => this.#up(e));
  }

  // Puts the handle where the music is (and hides the bar when the music fits).
  update() {
    const v = this.viewer;
    const sc = v.scroller;
    const none = v.pages.length < 2 || sc.scrollHeight - sc.clientHeight < 2;
    this.el.classList.toggle('none', none);
    if (none || this.drag) return;
    this.#place(v.fraction);
  }

  #place(f) {
    const top = handleTop(f, this.el.clientHeight, this.handle.offsetHeight);
    this.handle.style.transform = `translateY(${top}px)`;
  }

  #onScroll() {
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.update();
      });
    }
    // Scrolling by hand shows the bar for a moment; page turns don't.
    const v = this.viewer;
    if (this.drag || v.paged || v.animating || performance.now() - this.lastInput > INPUT_MS) return;
    this.el.classList.add('show');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.el.classList.remove('show'), SHOW_MS);
  }

  #down(e) {
    const v = this.viewer;
    if (!e.isPrimary || !v.pages.length || v.ink.busy || this.el.classList.contains('none')) return;
    e.preventDefault();
    try { this.el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    const r = this.el.getBoundingClientRect();
    const h = this.handle.offsetHeight;
    const y = e.clientY - r.top;
    const top = handleTop(v.fraction, r.height, h);
    // Holding the handle keeps it under the finger; elsewhere on the track,
    // the handle comes to the finger.
    const grab = y >= top - 8 && y <= top + h + 8 ? Math.max(0, Math.min(h, y - top)) : h / 2;
    this.drag = { id: e.pointerId, grab, f: null };
    this.el.classList.add('dragging');
    this.onStart();
    this.#move(e);
  }

  #move(e) {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const r = this.el.getBoundingClientRect();
    d.f = fractionAt(e.clientY - r.top, r.height, this.handle.offsetHeight, d.grab);
    if (d.raf) return;
    d.raf = requestAnimationFrame(() => {
      d.raf = 0;
      if (this.drag !== d) return;
      this.viewer.jumpTo(d.f);
      this.#place(d.f);
      this.label.textContent = `${this.viewer.pageShowing() + 1} / ${this.viewer.pages.length}`;
    });
  }

  #up(e) {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    cancelAnimationFrame(d.raf);
    if (d.f !== null) this.viewer.jumpTo(d.f);
    this.drag = null;
    this.el.classList.remove('dragging');
    this.update();
    this.onEnd();
  }
}
