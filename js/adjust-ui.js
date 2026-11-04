// Adjust pages: crop a page to its music and turn it, for one page or many.
//
// The screen shows the whole page with a frame round the part that will
// show; drag the frame's edges and corners, or inside it to move it. Turn
// left and right, Trim margins (finds the music), Whole page. ‹ › go through
// the pages, keeping what was changed on each. "Apply to" uses this page's
// adjustment on all, odd or even pages when Done is tapped; after Trim
// margins, each of those pages is trimmed to its own music.
import { normRot, normCrop, turnRect, musicBounds, luminance, pagesFor, MIN_CROP } from './page-view.js';
import { saveViews } from './views-store.js';
import { $, toast } from './ui.js';

const TRIM_PX = 360; // pages are measured for trimming at about this size

const same = (a, b) => normRot(a.rot) === normRot(b.rot) && JSON.stringify(normCrop(a.crop)) === JSON.stringify(normCrop(b.crop));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export class AdjustUi {
  constructor(viewer, { onOpenChange = () => {} } = {}) {
    this.viewer = viewer;
    this.onOpenChange = onOpenChange;
    this.el = $('#adjust');
    this.stage = this.el.querySelector('.adjust-stage');
    this.paper = this.el.querySelector('.adjust-paper');
    this.frame = this.el.querySelector('.adjust-crop');
    this.open_ = false;
    this.busy = false;
    this.drafts = new Map(); // page index → { rot, crop, auto }
    this.i = 0;
    this.draft = null;
    this.scope = 'page';
    this.drawGen = 0;
    this.drag = null;

    $('#a-cancel').addEventListener('click', () => this.close());
    $('#a-done').addEventListener('click', () => this.#done());
    $('#a-prev').addEventListener('click', () => this.#go(-1));
    $('#a-next').addEventListener('click', () => this.#go(1));
    $('#a-rot-l').addEventListener('click', () => this.#turn(-90));
    $('#a-rot-r').addEventListener('click', () => this.#turn(90));
    $('#a-trim').addEventListener('click', () => this.#trim());
    $('#a-reset').addEventListener('click', () => this.#setCrop(null, false));
    for (const b of this.el.querySelectorAll('#a-scope button')) {
      b.addEventListener('click', () => {
        this.scope = b.dataset.v;
        this.#update();
      });
    }
    this.paper.addEventListener('pointerdown', (e) => this.#down(e));
    this.paper.addEventListener('pointermove', (e) => this.#move(e));
    this.paper.addEventListener('pointerup', (e) => this.#up(e));
    this.paper.addEventListener('pointercancel', (e) => this.#up(e));
    new ResizeObserver(() => { if (this.open_) this.#draw(); }).observe(this.stage);
  }

  get isOpen() {
    return this.open_;
  }

  open() {
    const v = this.viewer;
    if (!v.pages.length || this.open_) return;
    v.ink.commit();
    v.finishAnimation();
    this.open_ = true;
    this.drafts.clear();
    this.scope = 'page';
    this.el.hidden = false;
    this.onOpenChange(true);
    this.#load(Math.max(0, v.pageShowing()));
  }

  close() {
    if (!this.open_ || this.busy) return;
    this.open_ = false;
    this.drag = null;
    this.drawGen++;
    this.el.hidden = true;
    const c = this.paper.querySelector('canvas');
    if (c) {
      c.width = 0;
      c.height = 0;
      c.remove();
    }
    this.onOpenChange(false);
  }

  // Page by page with ‹ ›, and the arrow keys.
  step(dir) {
    if (this.open_ && !this.busy) this.#go(dir);
  }

  #saved(i) {
    const p = this.viewer.pages[i];
    return { rot: p.view ? p.view.rot : 0, crop: p.view ? p.view.crop : null };
  }

  #load(i) {
    this.i = i;
    this.draft = { ...(this.drafts.get(i) || { ...this.#saved(i), auto: false }) };
    this.#draw();
  }

  // Keeps what was done to the page showing.
  #keep() {
    if (same(this.draft, this.#saved(this.i))) this.drafts.delete(this.i);
    else this.drafts.set(this.i, { ...this.draft });
  }

  #go(dir) {
    const j = this.i + dir;
    if (j < 0 || j >= this.viewer.pages.length) return;
    this.#keep();
    this.#load(j);
  }

  #turn(deg) {
    this.draft.rot = normRot(this.draft.rot + deg);
    this.#draw();
  }

  #setCrop(crop, auto) {
    this.draft.crop = normCrop(crop);
    this.draft.auto = auto;
    this.#update();
  }

  async #trim() {
    if (this.busy) return;
    this.#setBusy(true, 'Finding the music…');
    try {
      const crop = await this.#musicOf(this.i);
      if (!crop) toast('No margins to trim on this page.', 2000);
      this.#setCrop(crop, true);
    } catch (e) {
      console.warn(e);
      toast('Couldn’t read this page.', 2000);
    } finally {
      this.#setBusy(false);
    }
  }

  // The crop round the music on page i (null: nothing to trim).
  async #musicOf(i) {
    const c = await this.viewer.paperImage(i, 0, TRIM_PX, TRIM_PX);
    try {
      const data = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
      return musicBounds(luminance(data), c.width, c.height);
    } finally {
      c.width = 0;
      c.height = 0;
    }
  }

  // ---- Drawing ----

  async #draw() {
    const gen = ++this.drawGen;
    const v = this.viewer;
    const p = v.pages[this.i];
    $('#a-num').textContent = `Page ${this.i + 1} of ${v.pages.length}`;
    $('#a-prev').disabled = this.i === 0;
    $('#a-next').disabled = this.i === v.pages.length - 1;
    this.#update();
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rot = this.draft.rot;
    // Room round the page for the handles.
    const maxW = r.width - 36;
    const maxH = r.height - 36;
    const turned = rot % 180 ? [p.ph, p.pw] : [p.pw, p.ph];
    const k = Math.min(maxW / turned[0], maxH / turned[1]);
    this.paper.style.width = Math.round(turned[0] * k) + 'px';
    this.paper.style.height = Math.round(turned[1] * k) + 'px';
    let c;
    try {
      c = await v.paperImage(this.i, rot, maxW, maxH, dpr);
    } catch (e) {
      console.warn(e);
      return;
    }
    if (gen !== this.drawGen) {
      c.width = 0;
      c.height = 0;
      return;
    }
    const old = this.paper.querySelector('canvas');
    if (old) {
      old.width = 0;
      old.height = 0;
      old.replaceWith(c);
    } else {
      this.paper.prepend(c);
    }
  }

  // The frame, the buttons, and what Done will do.
  #update() {
    const d = this.draft;
    if (!d) return;
    const [x, y, w, h] = turnRect(d.crop || [0, 0, 1, 1], d.rot);
    const s = this.frame.style;
    s.left = x * 100 + '%';
    s.top = y * 100 + '%';
    s.width = w * 100 + '%';
    s.height = h * 100 + '%';
    for (const b of this.el.querySelectorAll('#a-scope button')) b.setAttribute('aria-checked', String(b.dataset.v === this.scope));
    $('#a-reset').disabled = !d.crop;
    $('#a-note').textContent = this.#note();
  }

  #note() {
    const pages = this.viewer.pages;
    const n = pagesFor(this.scope, pages, this.i).length;
    const others = [...this.drafts.keys()].filter((k) => k !== this.i).length;
    const also = others ? ` (and the ${others === 1 ? 'other page' : `${others} other pages`} you changed)` : '';
    if (this.scope === 'page') return `Done changes this page${also}.`;
    const which = { all: `all ${n} pages`, odd: `the ${n} odd pages`, even: `the ${n} even pages` }[this.scope];
    if (this.draft.auto) {
      const each = { all: `each of the ${n} pages`, odd: `each of the ${n} odd pages`, even: `each of the ${n} even pages` }[this.scope];
      return `Done trims ${each} to its own music${this.draft.rot ? ', turned the same way' : ''}.`;
    }
    if (!this.draft.crop && !this.draft.rot) return `Done shows ${which} whole, as in the PDF.`;
    return `Done shows ${which} the way this one is.`;
  }

  #setBusy(on, text = '') {
    this.busy = on;
    this.el.classList.toggle('busy', on);
    for (const b of this.el.querySelectorAll('button')) b.disabled = on;
    if (on) $('#a-note').textContent = text;
    else {
      $('#a-prev').disabled = this.i === 0;
      $('#a-next').disabled = this.i === this.viewer.pages.length - 1;
      this.#update();
    }
  }

  // ---- The frame ----

  #down(e) {
    if (this.busy || !e.isPrimary || this.drag) return;
    const handle = e.target.closest('[data-h]');
    const kind = handle ? handle.dataset.h : e.target.closest('.adjust-crop') ? 'move' : null;
    if (!kind) return;
    e.preventDefault();
    try { this.paper.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    const r = this.paper.getBoundingClientRect();
    this.drag = { id: e.pointerId, kind, x: e.clientX, y: e.clientY, w: r.width, h: r.height, rect: turnRect(this.draft.crop || [0, 0, 1, 1], this.draft.rot) };
    this.frame.classList.add('moving');
  }

  #move(e) {
    const g = this.drag;
    if (!g || g.id !== e.pointerId) return;
    const dx = (e.clientX - g.x) / g.w;
    const dy = (e.clientY - g.y) / g.h;
    let [x, y, w, h] = g.rect;
    const k = g.kind;
    if (k === 'move') {
      x = clamp(x + dx, 0, 1 - w);
      y = clamp(y + dy, 0, 1 - h);
    } else {
      const right = x + w;
      const bottom = y + h;
      if (k.includes('w')) x = clamp(x + dx, 0, right - MIN_CROP);
      if (k.includes('e')) w = clamp(w + dx, MIN_CROP, 1 - x);
      if (k.includes('n')) y = clamp(y + dy, 0, bottom - MIN_CROP);
      if (k.includes('s')) h = clamp(h + dy, MIN_CROP, 1 - y);
      if (k.includes('w')) w = right - x;
      if (k.includes('n')) h = bottom - y;
    }
    this.#setCrop(turnRect([x, y, w, h], 360 - this.draft.rot), false);
  }

  #up(e) {
    if (!this.drag || this.drag.id !== e.pointerId) return;
    this.drag = null;
    this.frame.classList.remove('moving');
  }

  // ---- Done ----

  async #done() {
    if (this.busy) return;
    this.#keep();
    const v = this.viewer;
    const pages = v.pages;
    const out = new Map();
    for (const [i, d] of this.drafts) out.set(i, { rot: d.rot, crop: d.crop });
    const d = this.draft;
    if (this.scope !== 'page') {
      const targets = pagesFor(this.scope, pages, this.i);
      this.#setBusy(true, '');
      try {
        let n = 0;
        for (const t of targets) {
          let crop = d.crop;
          if (d.auto && t !== this.i) {
            $('#a-note').textContent = `Trimming page ${++n} of ${targets.length}…`;
            try {
              crop = await this.#musicOf(t);
            } catch (e) {
              console.warn(e);
              crop = this.#saved(t).crop;
            }
            if (!this.open_) return;
          }
          out.set(t, { rot: d.rot, crop });
        }
      } finally {
        this.#setBusy(false);
      }
    } else {
      out.set(this.i, { rot: d.rot, crop: d.crop });
    }
    const changed = [...out].filter(([i, view]) => !same(view, this.#saved(i)));
    if (changed.length) {
      try {
        await saveViews(changed.map(([i, view]) => ({ fileId: pages[i].fileId, num: pages[i].num, view })));
      } catch (e) {
        console.warn(e);
        toast('The adjustments couldn’t be saved. Try again.', 3000);
        return;
      }
      v.setViews(new Map(changed.map(([i, view]) => [i, { ...view, at: Date.now() }])));
    }
    this.close();
    if (changed.length > 1) toast(`${changed.length} pages adjusted.`, 1800);
  }
}
