// The open score's index marks (js/notes-merge.js): hymns, sections and tap
// areas. Loaded when the score opens, changed in memory, saved a moment
// later, merged with what is stored, so they travel with the page's
// markings (Google Drive sync, backups).
//
// Tap areas are drawn as an svg layer over each page that has some, sized
// and turned like the markings layers (js/ink-draw.js placeLayer).
import * as db from './db.js';
import { libraryEdited } from './data.js';
import { mergePage, mergeMarks, pageIsEmpty } from './notes-merge.js';
import { shownToPage } from './page-view.js';
import { PAGE_W, placeLayer } from './ink-draw.js';
import { linkAt } from './index-logic.js';

const SAVE_DELAY_MS = 400;
const SVG_NS = 'http://www.w3.org/2000/svg';
const key = (fileId, num) => `${fileId}:${num}`;

export function newMarkId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export class Marks extends EventTarget {
  constructor(viewer) {
    super();
    this.viewer = viewer;
    this.byPage = new Map(); // "fileId:num" → marks (deleted ones too)
    this.unsaved = new Set();
    this.timer = 0;
    this.saving = Promise.resolve();
    this.batching = 0;
    this.pending = false;
  }

  async open(pages) {
    this.byPage.clear();
    for (const fileId of new Set(pages.map((p) => p.fileId))) {
      for (const r of await db.getAllByIndex('annotations', 'fileId', fileId)) {
        if (r.marks && r.marks.length) this.byPage.set(r.id, mergeMarks(r.marks, null));
      }
    }
  }

  close() {
    this.flush();
    this.byPage.clear();
  }

  // ---- Reading ----

  #live(fileId, num) {
    return (this.byPage.get(key(fileId, num)) || []).filter((m) => !m.gone);
  }

  // Hymns and sections, with where they are in the viewer.
  entries() {
    const out = [];
    this.viewer.pages.forEach((p, index) => {
      for (const m of this.#live(p.fileId, p.num)) {
        if (m.kind !== 'link') out.push({ ...m, index, num: p.num, fileId: p.fileId });
      }
    });
    return out;
  }

  links(p) {
    return this.#live(p.fileId, p.num).filter((m) => m.kind === 'link');
  }

  get(id) {
    for (const [k, marks] of this.byPage) {
      const m = marks.find((x) => x.id === id && !x.gone);
      if (m) {
        const i = k.lastIndexOf(':');
        return { mark: m, fileId: k.slice(0, i), num: Number(k.slice(i + 1)) };
      }
    }
    return null;
  }

  // ---- Changes ----

  // Adds marks: [{ fileId, num, mark }] (the mark without id or at).
  add(list) {
    const at = Date.now();
    for (const { fileId, num, mark } of list) this.#put(fileId, num, { ...mark, id: newMarkId(), at });
    this.#changed();
  }

  // Changes a mark. With num, it moves to that page (of the same file).
  update(id, patch, num = null) {
    const found = this.get(id);
    if (!found) return;
    const { mark, fileId } = found;
    const at = Math.max(Date.now(), mark.at + 1);
    const next = { ...mark, ...patch, at };
    if (num != null && num !== found.num) {
      this.#put(fileId, found.num, { id, at, gone: true });
      this.#put(fileId, num, { ...next, id: newMarkId() });
    } else {
      this.#put(fileId, found.num, next);
    }
    this.#changed();
  }

  remove(ids) {
    for (const id of [].concat(ids)) {
      const found = this.get(id);
      if (found) this.#put(found.fileId, found.num, { id, at: Math.max(Date.now(), found.mark.at + 1), gone: true });
    }
    this.#changed();
  }

  #put(fileId, num, mark) {
    const k = key(fileId, num);
    this.byPage.set(k, mergeMarks(this.byPage.get(k), [mark]));
    this.unsaved.add(k);
  }

  // Runs fn, telling everyone once at the end about all it changed.
  batch(fn) {
    this.batching++;
    try {
      fn();
    } finally {
      this.batching--;
      if (!this.batching && this.pending) {
        this.pending = false;
        this.#changed();
      }
    }
  }

  #changed() {
    if (this.batching) {
      this.pending = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    for (const p of this.viewer.pages) if (p.links || this.links(p).length) this.#draw(p);
    this.dispatchEvent(new Event('change'));
  }

  flush() {
    clearTimeout(this.timer);
    if (!this.unsaved.size) return this.saving;
    const writes = [...this.unsaved].map((k) => [k, this.byPage.get(k)]);
    this.unsaved.clear();
    this.saving = this.saving.then(() => save(writes)).catch((e) => {
      console.warn('Saving the index failed', e);
      for (const [k] of writes) this.unsaved.add(k);
      this.dispatchEvent(new CustomEvent('hint', { detail: 'The index couldn’t be saved. Close and reopen the score to try again.' }));
    });
    return this.saving;
  }

  // ---- Tap areas on the pages ----

  // A page came near the screen (show) or left it (hide).
  show(p) {
    if (!p.links && this.links(p).length) this.#draw(p);
  }

  hide(p) {
    if (p.links) p.links.remove();
    p.links = null;
  }

  // The page was laid out again.
  place(p) {
    if (p.links) placeLayer(p.links, p);
  }

  #draw(p) {
    const links = this.links(p);
    if (!links.length) {
      this.hide(p);
      return;
    }
    if (!p.el) return;
    if (!p.links) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'links');
      svg.setAttribute('viewBox', `0 0 ${PAGE_W} ${Math.round((PAGE_W * p.ph) / p.pw * 10) / 10}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      placeLayer(svg, p);
      p.el.appendChild(svg);
      p.links = svg;
    }
    p.links.replaceChildren(...links.map((l) => {
      const r = document.createElementNS(SVG_NS, 'rect');
      const [x, y, w, h] = l.box;
      r.setAttribute('x', x);
      r.setAttribute('y', y);
      r.setAttribute('width', w);
      r.setAttribute('height', h);
      r.setAttribute('rx', 4);
      r.dataset.id = l.id;
      return r;
    }));
  }

  // The page under a point on the screen, and the point in its units.
  pointAt(clientX, clientY) {
    const under = document.elementFromPoint(clientX, clientY);
    const el = under && under.closest && under.closest('.page');
    if (!el || !this.viewer.pagesEl.contains(el)) return null;
    const page = this.viewer.pages[+el.dataset.index];
    if (!page) return null;
    const r = el.getBoundingClientRect();
    const k = page.w / r.width;
    const [u, v] = shownToPage(page.view, page.pw, page.ph, (clientX - r.left) * k, (clientY - r.top) * k);
    const s = PAGE_W / page.pw;
    return { page, u: Math.max(0, Math.min(PAGE_W, u * s)), v: Math.max(0, Math.min((PAGE_W * page.ph) / page.pw, v * s)), unitsPerPx: (k * s) };
  }

  // The tap area under a point on the screen, if any.
  linkAtPoint(clientX, clientY) {
    const at = this.pointAt(clientX, clientY);
    if (!at) return null;
    const link = linkAt(this.links(at.page), at.u, at.v, 6 * at.unitsPerPx);
    return link ? { link, page: at.page } : null;
  }
}

// Writes pages' marks, merged with the stored copies, and tells sync.
async function save(writes) {
  const at = Date.now();
  await db.transact(['annotations'], (s) => {
    for (const [k, marks] of writes) {
      const i = k.lastIndexOf(':');
      const fileId = k.slice(0, i);
      const num = Number(k.slice(i + 1));
      const req = s.annotations.get(k);
      req.onsuccess = () => {
        const merged = mergePage(req.result, { strokes: [], erased: [], marks });
        if (pageIsEmpty(merged)) s.annotations.delete(k);
        else s.annotations.put({ id: k, fileId, page: num, ...merged, updatedAt: at });
      };
    }
  });
  libraryEdited();
}
