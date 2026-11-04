// The scroll bar down the right edge of a score: drag its handle to move
// quickly through a long score, or tap the track to jump there. While it's
// held, a label shows the page you'd land on.
//
// It shows with the top bar, and while scrolling by hand. One page at a
// time, it moves a page at a time (without the page-turn animation).
//
// With an index (js/index-ui.js), the score's sections and hymn numbers sit
// along it, as many as fit; tap one to go there.
import { handleTop, fractionAt } from './scrub.js';
import { pickLabels, placeLabel } from './index-logic.js';
import { esc } from './ui.js';

const LABEL_GAP = 30; // px between labels down the bar

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
    this.entries = [];
    this.marksEl = document.createElement('div');
    this.marksEl.className = 'scrub-marks';
    el.appendChild(this.marksEl);
    this.marksRaf = 0;
    this.tapMark = null;

    const sc = viewer.scroller;
    const input = () => { this.lastInput = performance.now(); };
    for (const t of ['touchstart', 'touchmove', 'touchend', 'wheel']) sc.addEventListener(t, input, { passive: true });
    sc.addEventListener('scroll', () => this.#onScroll(), { passive: true });
    viewer.addEventListener('page', () => this.update());
    new ResizeObserver(() => {
      this.update();
      this.#marksSoon();
    }).observe(el);
    const reload = () => {
      this.entries = viewer.marks.entries();
      this.#marksSoon();
    };
    viewer.marks.addEventListener('change', reload);
    viewer.addEventListener('opened', reload);
    viewer.addEventListener('layout', () => this.#marksSoon());

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

  #marksSoon() {
    if (this.marksRaf) return;
    this.marksRaf = requestAnimationFrame(() => {
      this.marksRaf = 0;
      this.#drawMarks();
    });
  }

  // The sections and hymn numbers that fit down the bar.
  #drawMarks() {
    const v = this.viewer;
    const H = this.el.clientHeight;
    const hh = this.handle.offsetHeight || 56;
    if (!v.pages.length || !this.entries.length || !H) {
      this.marksEl.replaceChildren();
      return;
    }
    const items = this.entries.map((e) => ({
      e,
      pos: handleTop(v.fractionAt(e.index, e.y), H, hh) + hh / 2,
      priority: e.kind === 'section' ? 0 : 1,
    }));
    const kept = pickLabels(items, LABEL_GAP);
    this.marksEl.innerHTML = kept.map(({ e, pos }) => {
      const text = e.kind === 'section' ? e.title : e.n;
      return `<button type="button" class="scrub-mark ${e.kind}" data-id="${esc(e.id)}" style="top:${Math.round(pos)}px" tabindex="-1">${esc(text)}</button>`;
    }).join('');
  }

  // What the label beside the handle says.
  #labelText() {
    const v = this.viewer;
    const page = `${v.pageShowing() + 1} / ${v.pages.length}`;
    if (!this.entries.length) return page;
    const [index, y] = v.topPlace();
    const name = placeLabel(this.entries, index, y + 0.02);
    return name ? `${name} · ${page}` : page;
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
    // A section or hymn beside the bar: a tap goes there.
    const mark = e.target.closest && e.target.closest('.scrub-mark');
    if (mark) {
      this.tapMark = { id: e.pointerId, mark: mark.dataset.id, x: e.clientX, y: e.clientY };
      this.onStart();
      return;
    }
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
    const t = this.tapMark;
    if (t && t.id === e.pointerId && Math.hypot(e.clientX - t.x, e.clientY - t.y) > 12) t.mark = null;
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
      this.label.textContent = this.#labelText();
    });
  }

  #up(e) {
    const t = this.tapMark;
    if (t && t.id === e.pointerId) {
      this.tapMark = null;
      const e2 = t.mark && e.type === 'pointerup' && this.entries.find((x) => x.id === t.mark);
      if (e2) this.viewer.goTo(e2.index, e2.y);
      this.update();
      this.onEnd();
      return;
    }
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
