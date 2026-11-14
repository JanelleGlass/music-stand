// The scroll bar down the right edge of a score: drag its handle to move
// quickly through a long score, or tap the track to jump there. While it's
// held, a label shows the page you'd land on.
//
// It shows with the top bar, and while scrolling by hand. One page at a
// time, it moves a page at a time (without the page-turn animation).
//
// With an index (js/index-ui.js), the score's sections and hymn numbers sit
// along it, round numbers first, as many as fit; tap one to go there. While
// the bar is held, a magnifier beside the finger takes the label's place:
// the hymns around where you'd land, big, the one you'd land on lit. Slide
// left onto it and it goes a hymn per row instead, to pick one exactly;
// back onto the bar for big moves again. Letting go goes there.
import { handleTop, fractionAt, rowAt, boxTop } from './scrub.js';
import { pickLandmarks, placeLabel, placeIndex, sortEntries } from './index-logic.js';
import { esc } from './ui.js';

const LABEL_GAP = 30; // px between labels down the bar

const SHOW_MS = 1200; // after scrolling by hand stops
const INPUT_MS = 2500; // a scroll this soon after a touch or wheel is by hand (iOS keeps gliding)

// The magnifier.
const ROW = 44; // px a row
const ROWS = 9; // rows, at most
const FOOT = 30; // px of its foot (the page)
const ABOVE = 0; // px above the bar it can use (none: the top bar shows while the bar is held)
const BELOW = 44; // and below it (.scrub's bottom in css/app.css, less a margin)
const FINE_IN = 16; // px left of the bar that pick from the magnifier
const FINE_OUT = 4; // px into the bar that go back to the bar
const EDGE_MS = 150; // holding its first or last row at the screen's edge brings in a row this often

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
    this.entries = []; // in the order of the music
    this.marksEl = document.createElement('div');
    this.marksEl.className = 'scrub-marks';
    el.appendChild(this.marksEl);
    this.marksRaf = 0;
    this.tapMark = null;
    this.loupe = document.createElement('div');
    this.loupe.className = 'scrub-loupe';
    this.loupe.innerHTML = '<div class="loupe-rows"></div><div class="loupe-foot"><span class="loupe-hint">‹ Slide here to pick one</span><span class="loupe-page"></span></div>';
    el.appendChild(this.loupe);
    this.loupeRows = this.loupe.querySelector('.loupe-rows');
    this.loupePage = this.loupe.querySelector('.loupe-page');

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
      this.entries = sortEntries(viewer.marks.entries());
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
      kind: e.kind,
      n: e.n,
      pos: handleTop(v.fractionAt(e.index, e.y), H, hh) + hh / 2,
    }));
    const kept = pickLandmarks(items, LABEL_GAP);
    this.marksEl.innerHTML = kept.map(({ e, pos }) => {
      const text = e.kind === 'section' ? e.title : e.n;
      return `<button type="button" class="scrub-mark ${e.kind}" data-id="${esc(e.id)}" style="top:${Math.round(pos)}px" tabindex="-1">${esc(text)}</button>`;
    }).join('');
  }

  // What the label beside the handle says (without an index; with one, the
  // magnifier shows instead).
  #labelText() {
    const v = this.viewer;
    const page = this.#pageText();
    if (!this.entries.length) return page;
    const [index, y] = v.topPlace();
    const name = placeLabel(this.entries, index, y + 0.02);
    return name ? `${name} · ${page}` : page;
  }

  #pageText() {
    const v = this.viewer;
    return `${v.pageShowing() + 1} / ${v.pages.length}`;
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
    // y: the finger, px down the bar. k: the entry lit in the magnifier, its
    // row at rowY. fine: picking from the magnifier, entry k0's row at y0.
    this.drag = { id: e.pointerId, grab, f: null, y, k: -1, rowY: y, fine: null, went: -1, edge: 0, edgeTimer: 0 };
    this.el.classList.add('dragging');
    this.el.classList.toggle('looking', this.entries.length > 0);
    this.onStart();
    this.#move(e);
  }

  #move(e) {
    const t = this.tapMark;
    if (t && t.id === e.pointerId && Math.hypot(e.clientX - t.x, e.clientY - t.y) > 12) t.mark = null;
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const r = this.el.getBoundingClientRect();
    d.y = e.clientY - r.top;
    d.f = fractionAt(d.y, r.height, this.handle.offsetHeight, d.grab);
    // Off the bar to the left, onto the magnifier: a hymn per row, its rows
    // staying where they are. Back onto the bar: the bar again.
    if (this.entries.length) {
      if (!d.fine && e.clientX < r.left - FINE_IN) {
        d.fine = d.k < 0 ? { k0: 0, y0: d.rowY + ROW } : { k0: d.k, y0: d.rowY };
        d.went = -1;
      } else if (d.fine && e.clientX > r.left + FINE_OUT) {
        d.fine = null;
      }
    }
    if (d.raf) return;
    d.raf = requestAnimationFrame(() => {
      d.raf = 0;
      if (this.drag === d) this.#frame(d);
    });
  }

  // Moves the music (and the handle) to where the finger says, and draws the
  // magnifier or the label.
  #frame(d) {
    const v = this.viewer;
    if (d.fine) {
      d.k = rowAt(d.fine.k0, d.fine.y0, d.y, ROW, this.entries.length);
      d.rowY = d.fine.y0 + (d.k - d.fine.k0) * ROW;
      const at = this.entries[d.k];
      if (at && d.k !== d.went) {
        v.goTo(at.index, at.y);
        d.went = d.k;
      }
      this.#place(v.fraction);
    } else {
      v.jumpTo(d.f);
      this.#place(d.f);
      if (this.entries.length) {
        const [index, y] = v.topPlace();
        d.k = placeIndex(this.entries, index, y + 0.02);
        d.rowY = d.y;
      }
    }
    if (this.entries.length) this.#drawLoupe(d);
    else this.label.textContent = this.#labelText();
  }

  // The magnifier: centred on the finger (within the screen), entry k's row
  // at rowY and the others above and below it, a row each.
  #drawLoupe(d) {
    const list = this.entries;
    const room = this.el.clientHeight + ABOVE + BELOW - FOOT;
    let n = Math.max(1, Math.min(ROWS, Math.floor(room / ROW)));
    if (n % 2 === 0) n -= 1;
    const rowsH = n * ROW;
    const top = boxTop(d.y, rowsH, -ABOVE, this.el.clientHeight + BELOW - FOOT);
    const k0 = d.k < 0 ? -1 : d.k;
    const from = Math.max(0, k0 + Math.floor((top - d.rowY) / ROW) - 1);
    const to = Math.min(list.length - 1, k0 + Math.ceil((top + rowsH - d.rowY) / ROW) + 1);
    let html = '';
    for (let k = from; k <= to; k++) {
      const e = list[k];
      const y = Math.round(d.rowY + (k - k0) * ROW - ROW / 2 - top);
      const text = e.kind === 'section'
        ? `<span class="t">${esc(e.title)}</span>`
        : `<b>${esc(e.n)}</b><span class="t">${esc(e.title || '')}</span>`;
      html += `<div class="loupe-row ${e.kind}${k === d.k ? ' on' : ''}" style="top:${y}px">${text}</div>`;
    }
    this.loupe.style.top = `${top}px`;
    this.loupe.classList.toggle('fine', !!d.fine);
    this.loupeRows.style.height = `${rowsH}px`;
    this.loupeRows.innerHTML = html;
    this.loupePage.textContent = this.#pageText();
    this.#edge(d, d.fine && n >= 3 ? (d.y < top + ROW ? -1 : d.y > top + rowsH - ROW ? 1 : 0) : 0);
  }

  // Picking from the magnifier with the finger on its first or last row,
  // up against the screen's edge: the rows beyond come in, one at a time.
  #edge(d, dir) {
    if ((dir < 0 && d.k <= 0) || (dir > 0 && d.k >= this.entries.length - 1)) dir = 0;
    d.edge = dir;
    if (dir && !d.edgeTimer) {
      d.edgeTimer = setInterval(() => {
        if (this.drag !== d || !d.fine || !d.edge) return this.#stopEdge(d);
        d.fine.y0 -= d.edge * ROW;
        this.#frame(d);
      }, EDGE_MS);
    } else if (!dir) {
      this.#stopEdge(d);
    }
  }

  #stopEdge(d) {
    clearInterval(d.edgeTimer);
    d.edgeTimer = 0;
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
    this.#stopEdge(d);
    // Where the finger last was: a place on the bar, or the hymn picked.
    if (d.fine) {
      const at = this.entries[rowAt(d.fine.k0, d.fine.y0, d.y, ROW, this.entries.length)];
      if (at) this.viewer.goTo(at.index, at.y);
    } else if (d.f !== null) {
      this.viewer.jumpTo(d.f);
    }
    this.drag = null;
    this.el.classList.remove('dragging', 'looking');
    this.update();
    this.onEnd();
  }
}
