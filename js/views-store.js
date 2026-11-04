// Saving and loading page adjustments (crop and turn, js/page-view.js). They
// are kept with the page's markings in the annotations store, so Google
// Drive sync and backups carry them the same way.
import * as db from './db.js';
import { libraryEdited } from './data.js';
import { mergePage, pageIsEmpty } from './notes-merge.js';
import { normView } from './page-view.js';

// The views of the pages of these files: Map "fileId:page" → view.
export async function loadViews(fileIds) {
  const out = new Map();
  for (const fileId of new Set(fileIds)) {
    for (const r of await db.getAllByIndex('annotations', 'fileId', fileId)) {
      const v = normView(r.view);
      if (v) out.set(r.id, v);
    }
  }
  return out;
}

// Saves views: [{ fileId, num, view: { rot, tilt, crop } }], stamped now.
export async function saveViews(list) {
  if (!list.length) return;
  const at = Date.now();
  await db.transact(['annotations'], (s) => {
    for (const { fileId, num, view } of list) {
      const key = `${fileId}:${num}`;
      const req = s.annotations.get(key);
      req.onsuccess = () => {
        const merged = mergePage(req.result, { strokes: [], erased: [], view: { rot: view.rot, tilt: view.tilt || 0, crop: view.crop, at } });
        if (!pageIsEmpty(merged)) s.annotations.put({ id: key, fileId, page: num, ...merged, updatedAt: at });
      };
    }
  });
  libraryEdited();
}
