// Library screen: grid of scores, add / rename / delete, and the bar of
// Favorites and folders along the bottom.
import * as db from './db.js';
import { listFiles, addPdf, renameFile, deleteFile, getThumb, ensureThumb, onLibraryChange } from './data.js';
import { getFolders, scoresIn, createFolder, renameFolder, deleteFolder, setMember, setMembers, FAVORITES } from './lists.js';
import { describePdfError } from './pdfdoc.js';
import { syncAccount } from './gdrive-auth.js';
import { $, esc, icon, formatBytes, toast, confirmDialog, promptDialog, actionSheet, openModal, whileBusy } from './ui.js';

const TAB_KEY = 'ms:tab';
const SORT_KEY = 'ms:sort';
const FOLDER_SORT_KEY = 'ms:sortFolder';
const ALL = 'all';

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function stored(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
}

export function initLibrary({ onOpen }) {
  const grid = $('#lib-grid');
  const empty = $('#lib-empty');
  const noResults = $('#lib-noresults');
  const search = $('#lib-search');
  const sort = $('#lib-sort');
  const input = $('#file-input');
  const tabs = $('#lib-tabs');
  const head = $('#folder-head');
  const folderEmpty = $('#folder-empty');
  const folderOrder = sort.querySelector('option[value="folder"]');
  const thumbUrls = new Map();
  let files = [];
  let folders = [];
  let tab = stored(TAB_KEY, ALL);
  // Un-starred in the Favorites tab: kept in view, in its place, until the
  // tab changes or a score is opened, so a mistaken tap is easy to put right.
  // id → its time in Favorites (its place in Folder order).
  const keepShown = new Map();
  let scrolledTo = null; // the tab the bar was last scrolled to
  let thumbChain = Promise.resolve();

  async function refresh() {
    const before = new Map(files.map((f) => [f.id, f.hash]));
    [files, folders] = await Promise.all([listFiles(), getFolders()]);
    // A new version of a PDF (from Google Drive) needs a new thumbnail.
    for (const f of files) {
      if (before.has(f.id) && before.get(f.id) !== f.hash && thumbUrls.has(f.id)) {
        URL.revokeObjectURL(thumbUrls.get(f.id));
        thumbUrls.delete(f.id);
      }
    }
    if (tab !== ALL && !currentFolder()) tab = ALL; // deleted, here or on another device
    render();
  }

  // With no scores there's nothing to show in a folder: the library's welcome shows.
  const currentFolder = () => (tab === ALL || !files.length ? null : folders.find((f) => f.id === tab) || null);
  const favorites = () => scoresIn(folders.find((f) => f.id === FAVORITES));

  // Each tab kind keeps its own sort: folders start in their own order.
  function applySort() {
    const inFolder = tab !== ALL;
    // Only folders have an order of their own (iPadOS ignores hidden options).
    if (inFolder && !folderOrder.parentNode) sort.prepend(folderOrder);
    if (!inFolder && folderOrder.parentNode) folderOrder.remove();
    sort.value = inFolder ? stored(FOLDER_SORT_KEY, 'folder') : stored(SORT_KEY, 'recent');
    if (!sort.value || (!inFolder && sort.value === 'folder')) sort.value = 'recent';
  }

  function selectTab(id) {
    tab = id;
    keepShown.clear();
    store(TAB_KEY, id);
    render();
    $('.lib-scroll').scrollTop = 0;
  }

  function sorted(list, folder) {
    const by = sort.value;
    const copy = list.slice();
    if (by === 'folder' && folder) {
      const at = new Map([...folder.members.filter((m) => m.in).map((m) => [m.score, m.at]), ...keepShown]);
      copy.sort((a, b) => (at.get(a.id) || 0) - (at.get(b.id) || 0) || byName(a, b));
    } else if (by === 'name') copy.sort(byName);
    else if (by === 'added') copy.sort((a, b) => b.addedAt - a.addedAt);
    else copy.sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
    return copy;
  }

  function renderTabs() {
    tabs.hidden = files.length === 0;
    if (tabs.hidden) return;
    const here = new Set(files.map((f) => f.id));
    const count = (folder) => [...scoresIn(folder)].filter((id) => here.has(id)).length;
    const button = (id, label, n, extra = '') =>
      `<button class="tab" role="tab" data-tab="${esc(id)}" aria-selected="${tab === id}">${extra}<span>${esc(label)}</span><span class="count">${n}</span></button>`;
    const fav = folders.find((f) => f.id === FAVORITES);
    const scroll = tabs.querySelector('.tab-scroll');
    const scrolled = scroll ? scroll.scrollLeft : 0;
    tabs.innerHTML = button(ALL, 'All', files.length) +
      button(FAVORITES, 'Favorites', count(fav), icon('star')) +
      `<div class="tab-scroll">${folders.filter((f) => f.id !== FAVORITES).map((f) => button(f.id, f.name, count(f))).join('')}</div>` +
      `<button class="tab add" data-new aria-label="New folder">${icon('plus')}</button>`;
    const box = tabs.querySelector('.tab-scroll');
    box.scrollLeft = scrolled;
    // Bring a newly chosen folder into view, but leave the strip where the
    // person scrolled it otherwise.
    if (scrolledTo !== tab) {
      scrolledTo = tab;
      const sel = box.querySelector('[aria-selected="true"]');
      if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function render() {
    applySort();
    renderTabs();
    const folder = currentFolder();
    const inFolder = folder ? scoresIn(folder) : null;
    const scope = inFolder ? files.filter((f) => inFolder.has(f.id) || keepShown.has(f.id)) : files;
    const query = search.value.trim();
    const q = query.toLowerCase();
    const list = sorted(scope.filter((f) => !q || f.name.toLowerCase().includes(q)), folder);
    const fav = favorites();

    head.hidden = !folder;
    if (folder) {
      $('#folder-name').textContent = folder.name;
      $('#folder-count').textContent = plural(scope.filter((f) => inFolder.has(f.id)).length, 'score', 'scores');
      $('#folder-rename').hidden = folder.id === FAVORITES;
      $('#folder-delete').hidden = folder.id === FAVORITES;
    }
    empty.hidden = files.length > 0;
    folderEmpty.hidden = !(files.length > 0 && folder && scope.length === 0);
    if (!folderEmpty.hidden) {
      $('#folder-empty-text').textContent = folder.id === FAVORITES
        ? 'Tap the star on a score, or in the top bar while it’s open, to keep it here.'
        : `No scores in “${folder.name}” yet.`;
    }
    noResults.hidden = !(scope.length > 0 && list.length === 0);
    if (!noResults.hidden) {
      $('#lib-noresults-text').textContent = folder ? `Nothing in “${folder.name}” matches “${query}”.` : 'No scores match your search.';
      $('#search-all').hidden = !folder;
    }

    grid.innerHTML = list
      .map(
        (f) => `
      <article class="card" data-id="${esc(f.id)}">
        <button class="card-open" aria-label="Open ${esc(f.name)}">
          <div class="thumb">${thumbUrls.has(f.id) ? `<img alt="" src="${thumbUrls.get(f.id)}">` : icon('file')}</div>
          <div class="card-text">
            <div class="card-title">${esc(f.name)}</div>
            <div class="card-meta">${plural(f.pageCount, 'page', 'pages')} · ${formatBytes(f.size)}</div>
          </div>
        </button>
        <button class="card-star icon-btn" aria-pressed="${fav.has(f.id)}" aria-label="${fav.has(f.id) ? 'Remove from' : 'Add to'} Favorites">${icon('star')}</button>
        <button class="card-more icon-btn" aria-label="Options for ${esc(f.name)}">${icon('more')}</button>
      </article>`
      )
      .join('');
    for (const f of list) if (!thumbUrls.has(f.id)) queueThumb(f);
  }

  function queueThumb(meta) {
    thumbChain = thumbChain.then(async () => {
      if (thumbUrls.has(meta.id)) return;
      let blob = await getThumb(meta.id);
      if (!blob) blob = await ensureThumb(meta).catch(() => null);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      thumbUrls.set(meta.id, url);
      const box = grid.querySelector(`.card[data-id="${CSS.escape(meta.id)}"] .thumb`);
      if (box) box.innerHTML = `<img alt="" src="${url}">`;
    }).catch(() => {});
  }

  function addFiles(list) {
    return whileBusy(() => addEach(list));
  }

  async function addEach(list) {
    const pdfs = Array.from(list).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!pdfs.length) {
      toast('Only PDF files can be added.');
      return;
    }
    // PDFs added while a folder (or Favorites) is showing go into it too.
    const folder = currentFolder();
    const stillThere = () => folder && folders.some((f) => f.id === folder.id);
    const chosen = new Map();
    let added = 0;
    let dupes = 0;
    const failed = [];
    for (let i = 0; i < pdfs.length; i++) {
      const f = pdfs[i];
      const label = pdfs.length > 1 ? `Adding ${i + 1} of ${pdfs.length}: ${f.name}` : `Adding ${f.name}…`;
      toast(label, 0);
      try {
        const res = await addPdf(f, (n, total) => toast(`${label} (${Math.round((n / total) * 100)}%)`, 0));
        if (res.status === 'added') added++;
        else dupes++;
        if (folder && res.meta) chosen.set(res.meta.id, true);
      } catch (e) {
        console.warn(e);
        failed.push(`${f.name}: ${describePdfError(e)}`);
      }
    }
    // The folder may have been deleted meanwhile (on another device).
    const target = stillThere() ? folder : null;
    if (target && chosen.size) await setMembers(target.id, chosen);
    const parts = [];
    if (added) parts.push(`Added ${plural(added, 'score', 'scores')}${target ? ` to ${target.name}` : ''}.`);
    if (dupes) parts.push(`${dupes} already in your library${target ? `, now in ${target.name} too` : ''}.`);
    toast(parts.join(' ') || 'Nothing added.', 3000);
    if (failed.length) {
      await confirmDialog({ title: "Some files couldn't be added", message: failed.join('\n'), ok: 'OK', cancel: 'Close' });
    }
  }

  // ---- Folders ----

  // A name for a new or renamed folder; null if cancelled.
  async function askName(title, value = '', ok = 'Save') {
    const name = await promptDialog({ title, value, placeholder: 'For example: Christmas, Sunday, Wedding', ok });
    return name && name.trim() ? name.trim() : null;
  }

  // A folder with this name already (another one than except), if any.
  const named = (name, except) => folders.find((f) => f.id !== FAVORITES && f.id !== except && f.name.toLowerCase() === name.toLowerCase());

  async function newFolder() {
    const name = await askName('New folder', '', 'Create');
    if (!name) return null;
    if (name.toLowerCase() === 'favorites') return FAVORITES;
    const same = named(name);
    const id = same ? same.id : await createFolder(name);
    await refresh();
    return id;
  }

  // Checkbox list in a dialog. rows: [{ id, label, on }]. Resolves to the
  // Map of rows whose box changed (id → checked, in the order they were
  // ticked), or null if cancelled. extra: the label of a second button; it
  // resolves to { extra: true, changes }.
  function pickDialog({ title, rows, ok = 'Done', searchable = false, extra = null, emptyText = 'No folders yet.' }) {
    return openModal((dlg, finish) => {
      // The heading takes the focus, so the keyboard doesn't come up over the list.
      dlg.innerHTML = `
        <div class="modal-body">
          <h2 tabindex="-1" autofocus>${esc(title)}</h2>
          ${searchable ? '<input class="field" type="search" placeholder="Search" autocomplete="off" autocorrect="off" spellcheck="false">' : ''}
          <div class="pick-list">${rows.length ? rows.map((r) => `
            <label class="pick-row" data-id="${esc(r.id)}"><input type="checkbox" ${r.on ? 'checked' : ''}><span>${esc(r.label)}</span></label>`).join('') : `<div class="pick-empty">${esc(emptyText)}</div>`}
          </div>
        </div>
        <div class="modal-actions">
          ${extra ? `<button class="btn" data-v="extra">${esc(extra)}</button>` : ''}
          <button class="btn" data-v="0">Cancel</button>
          <button class="btn primary" data-v="1">${esc(ok)}</button>
        </div>`;
      const field = dlg.querySelector('input[type="search"]');
      if (field) {
        field.addEventListener('input', () => {
          const q = field.value.trim().toLowerCase();
          for (const row of dlg.querySelectorAll('.pick-row')) row.hidden = !!q && !row.textContent.toLowerCase().includes(q);
        });
      }
      const ticked = []; // ids in the order their boxes changed
      dlg.querySelector('.pick-list').addEventListener('change', (e) => {
        const row = e.target.closest('.pick-row');
        if (!row) return;
        const i = ticked.indexOf(row.dataset.id);
        if (i >= 0) ticked.splice(i, 1);
        ticked.push(row.dataset.id);
      });
      const changes = () => {
        const out = new Map();
        for (const id of ticked) {
          const r = rows.find((x) => x.id === id);
          const row = [...dlg.querySelectorAll('.pick-row')].find((x) => x.dataset.id === id);
          const on = row.querySelector('input').checked;
          if (r && on !== r.on) out.set(id, on);
        }
        return out;
      };
      dlg.querySelector('[data-v="0"]').onclick = () => finish(null);
      dlg.querySelector('[data-v="1"]').onclick = () => finish(changes());
      const more = dlg.querySelector('[data-v="extra"]');
      if (more) more.onclick = () => finish({ extra: true, changes: changes() });
    });
  }

  // Picks the scores in a folder.
  async function chooseScores(folder) {
    const inFolder = scoresIn(folder);
    const rows = [...files].sort(byName).map((f) => ({ id: f.id, label: f.name, on: inFolder.has(f.id) }));
    const title = folder.id === FAVORITES ? 'Favorites' : `Scores in ${folder.name}`;
    const changes = await pickDialog({ title, rows, searchable: true, emptyText: 'No scores yet.' });
    if (changes && changes.size) await setMembers(folder.id, changes);
  }

  // Picks the folders a score is in.
  async function chooseFolders(meta) {
    for (;;) {
      const own = folders.filter((f) => f.id !== FAVORITES);
      const rows = own.map((f) => ({ id: f.id, label: f.name, on: scoresIn(f).has(meta.id) }));
      const res = await pickDialog({ title: `Folders for “${meta.name}”`, rows, extra: 'New folder…' });
      if (!res) return;
      const changes = res.extra ? res.changes : res;
      for (const [id, on] of changes) await setMember(id, meta.id, on);
      if (!res.extra) return;
      const id = await newFolder();
      if (id) await setMember(id, meta.id, true);
      await refresh();
    }
  }

  async function folderFromTab() {
    const id = await newFolder();
    if (!id) return;
    selectTab(id);
    const folder = currentFolder();
    if (folder && files.length) await chooseScores(folder);
  }

  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    if (b.hasAttribute('data-new')) folderFromTab();
    else selectTab(b.dataset.tab);
  });

  const addToCurrent = () => { const f = currentFolder(); if (f) chooseScores(f); };
  $('#folder-add').addEventListener('click', addToCurrent);
  $('#folder-empty-add').addEventListener('click', addToCurrent);
  $('#folder-empty-pdf').addEventListener('click', () => input.click());
  $('#search-all').addEventListener('click', () => selectTab(ALL));
  $('#folder-rename').addEventListener('click', async () => {
    const folder = currentFolder();
    if (!folder) return;
    const name = await askName('Rename folder', folder.name);
    if (!name || name === folder.name) return;
    if (named(name, folder.id) || name.toLowerCase() === 'favorites') {
      toast(`There’s already a folder called “${name}”.`);
      return;
    }
    await renameFolder(folder.id, name);
  });
  $('#folder-delete').addEventListener('click', async () => {
    const folder = currentFolder();
    if (!folder) return;
    const here = new Set(files.map((f) => f.id));
    const n = [...scoresIn(folder)].filter((id) => here.has(id)).length;
    const ok = await confirmDialog({
      title: `Delete the folder “${folder.name}”?`,
      message: (n ? `Its ${plural(n, 'score stays', 'scores stay')} in your library.` : 'It has no scores.') +
        (syncAccount() ? ' The folder goes from your other devices too.' : ''),
      ok: 'Delete folder',
      danger: true,
    });
    if (ok) {
      await deleteFolder(folder.id);
      selectTab(ALL);
    }
  });

  // ---- Score menu ----

  async function showMenu(id) {
    const meta = files.find((f) => f.id === id);
    if (!meta) return;
    const folder = currentFolder();
    const actions = [];
    if (folder && scoresIn(folder).has(id)) actions.push({ label: folder.id === FAVORITES ? 'Remove from Favorites' : `Remove from “${folder.name}”`, value: 'out' });
    actions.push(
      { label: 'Add to folder…', value: 'folders' },
      { label: 'Rename', value: 'rename' },
      { label: 'Delete from library…', value: 'delete', danger: true },
    );
    const choice = await actionSheet({ title: meta.name, actions });
    if (choice === 'out') {
      await setMember(folder.id, id, false);
    } else if (choice === 'folders') {
      await chooseFolders(meta);
    } else if (choice === 'rename') {
      const name = await promptDialog({ title: 'Rename score', value: meta.name, ok: 'Save' });
      if (name && name.trim()) await renameFile(id, name);
    } else if (choice === 'delete') {
      await confirmDelete(meta);
    }
  }

  async function confirmDelete(meta) {
    const marked = (await db.getAllByIndex('annotations', 'fileId', meta.id)).some((r) => r.strokes && r.strokes.length);
    const inFolders = folders.filter((f) => f.id !== FAVORITES && scoresIn(f).has(meta.id)).length;
    const starred = favorites().has(meta.id);
    const places = [starred ? 'Favorites' : '', inFolders ? (inFolders === 1 ? 'its folder' : `${inFolders} folders`) : ''].filter(Boolean).join(' and ');
    // With sync, Drive keeps markings and folder places by the PDF, so they
    // come back with it (restored from the Drive trash, or added again).
    const extra = syncAccount()
      ? (marked || places ? 'Its markings and folder places stay in Google Drive and come back if this PDF is added again.' : '')
      : [marked ? 'Your markings on it are deleted too.' : '', places ? `It’s also taken out of ${places}.` : ''].filter(Boolean).join(' ');
    const ok = await confirmDialog({
      title: `Delete “${meta.name}” from your library?`,
      message: (syncAccount()
        ? 'It’s removed from this iPad and your other devices. Google Drive keeps the PDF in its trash for 30 days.'
        : 'The PDF and its reading position are removed from this iPad. This cannot be undone unless you have a backup.') +
        (extra ? ` ${extra}` : ''),
      ok: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await deleteFile(meta.id);
    const url = thumbUrls.get(meta.id);
    if (url) URL.revokeObjectURL(url);
    thumbUrls.delete(meta.id);
    toast('Deleted.');
  }

  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest('.card-more')) showMenu(id);
    else if (e.target.closest('.card-star')) {
      const on = !favorites().has(id);
      if (!on && tab === FAVORITES) {
        const m = folders.find((f) => f.id === FAVORITES).members.find((x) => x.score === id);
        if (!keepShown.has(id)) keepShown.set(id, m ? m.at : 0); // its first place
      }
      setMember(FAVORITES, id, on);
      toast(on ? 'Added to Favorites.' : 'Removed from Favorites.', 1400);
    } else if (e.target.closest('.card-open')) onOpen(id);
  });

  const pick = () => input.click();
  $('#lib-add').addEventListener('click', pick);
  $('#lib-add-empty').addEventListener('click', pick);
  input.addEventListener('change', async () => {
    const list = Array.from(input.files || []);
    input.value = '';
    if (list.length) await addFiles(list);
  });
  search.addEventListener('input', render);
  sort.addEventListener('change', () => {
    store(tab === ALL ? SORT_KEY : FOLDER_SORT_KEY, sort.value);
    render();
  });

  // Drag & drop (iPad split view from Files, or a desktop browser).
  const lib = $('#library');
  const hint = $('#drop-hint');
  let dragDepth = 0;
  lib.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    hint.hidden = false;
  });
  lib.addEventListener('dragover', (e) => e.preventDefault());
  lib.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; hint.hidden = true; }
  });
  lib.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    hint.hidden = true;
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  onLibraryChange(refresh);

  // The library shows again (after a score): un-starred favorites go.
  function shown() {
    keepShown.clear();
    scrolledTo = null; // renders while it was hidden couldn't scroll the strip
    return refresh();
  }

  return { refresh, shown, addFiles };
}
