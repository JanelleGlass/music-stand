// Favorites and folders: collections of scores shown along the bottom of the
// library. A score can be in any number of folders; Favorites is a folder
// with a fixed id and name. Stored in the `lists` store, one record per
// folder (see js/notes-merge.js for the record and how copies combine).
import * as db from './db.js';
import { libraryEdited, newId } from './data.js';
import { normaliseFolder } from './notes-merge.js';

export const FAVORITES = 'favorites';

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

// Times only move forward, so a change made right after another one wins.
function after(prev) {
  return Math.max(Date.now(), (prev || 0) + 1);
}

function blank(id, name) {
  return { id, name, nameAt: 0, createdAt: Date.now(), deleted: false, deletedAt: 0, members: [] };
}

// Changes one folder in one transaction and tells the library and sync. fn gets the record (or undefined) and returns the new
// one, or undefined to leave it alone.
async function change(id, fn) {
  let wrote = false;
  await db.transact(['lists'], (s) => {
    const req = s.lists.get(id);
    req.onsuccess = () => {
      const next = fn(req.result ? normaliseFolder(req.result) : undefined);
      if (next === undefined) return;
      wrote = true;
      s.lists.put(next);
    };
  });
  if (wrote) libraryEdited();
  return wrote;
}

// Folders that aren't deleted, Favorites first, then by name.
export async function getFolders() {
  const all = (await db.getAll('lists')).map(normaliseFolder).filter((f) => !f.deleted);
  const fav = all.find((f) => f.id === FAVORITES) || blank(FAVORITES, 'Favorites');
  return [{ ...fav, name: 'Favorites' }, ...all.filter((f) => f.id !== FAVORITES).sort(byName)];
}

// The ids of the scores in a folder.
export function scoresIn(folder) {
  return new Set(((folder && folder.members) || []).filter((m) => m.in).map((m) => m.score));
}

export async function createFolder(name) {
  const id = newId();
  const now = Date.now();
  await change(id, () => ({ ...blank(id, name.trim()), nameAt: now, createdAt: now }));
  return id;
}

export function renameFolder(id, name) {
  const clean = name.trim();
  if (!clean || id === FAVORITES) return Promise.resolve(false);
  return change(id, (f) => (f && !f.deleted && f.name !== clean ? { ...f, name: clean, nameAt: after(f.nameAt) } : undefined));
}

export function deleteFolder(id) {
  if (id === FAVORITES) return Promise.resolve(false);
  return change(id, (f) => (f && !f.deleted ? { ...f, deleted: true, deletedAt: after(f.deletedAt) } : undefined));
}

// Puts scores into a folder or takes them out. changes: Map scoreId →
// true/false, in the order they were chosen, which becomes the folder's order.
export function setMembers(folderId, changes) {
  return change(folderId, (f) => {
    if (f && f.deleted) return undefined;
    const folder = f ? normaliseFolder(f) : blank(folderId, folderId === FAVORITES ? 'Favorites' : 'Folder');
    const members = new Map(folder.members.map((m) => [m.score, m]));
    let changed = false;
    let at = Date.now() - 1;
    for (const [score, inFolder] of changes) {
      const prev = members.get(score);
      if (prev ? prev.in === inFolder : !inFolder) continue;
      at = Math.max(at + 1, (prev ? prev.at : 0) + 1);
      members.set(score, { score, in: inFolder, at });
      changed = true;
    }
    return changed ? { ...folder, members: [...members.values()] } : undefined;
  });
}

export function setMember(folderId, scoreId, inFolder) {
  return setMembers(folderId, new Map([[scoreId, inFolder]]));
}
