// Library screen: grid of scores, add / rename / delete.
import { listFiles, addPdf, renameFile, deleteFile, getThumb, ensureThumb, onLibraryChange } from './data.js';
import { describePdfError } from './pdfdoc.js';
import { $, esc, icon, formatBytes, toast, confirmDialog, promptDialog, actionSheet } from './ui.js';

export function initLibrary({ onOpen }) {
  const grid = $('#lib-grid');
  const empty = $('#lib-empty');
  const noResults = $('#lib-noresults');
  const search = $('#lib-search');
  const sort = $('#lib-sort');
  const input = $('#file-input');
  const thumbUrls = new Map();
  let files = [];
  let thumbChain = Promise.resolve();

  try { sort.value = localStorage.getItem('ms:sort') || 'recent'; } catch { /* storage blocked */ }

  async function refresh() {
    files = await listFiles();
    render();
  }

  function sorted(list) {
    const by = sort.value;
    const copy = list.slice();
    if (by === 'name') copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    else if (by === 'added') copy.sort((a, b) => b.addedAt - a.addedAt);
    else copy.sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
    return copy;
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const list = sorted(files.filter((f) => !q || f.name.toLowerCase().includes(q)));
    empty.hidden = files.length > 0;
    noResults.hidden = !(files.length > 0 && list.length === 0);
    grid.innerHTML = list
      .map(
        (f) => `
      <article class="card" data-id="${esc(f.id)}">
        <button class="card-open" aria-label="Open ${esc(f.name)}">
          <div class="thumb">${thumbUrls.has(f.id) ? `<img alt="" src="${thumbUrls.get(f.id)}">` : icon('file')}</div>
          <div class="card-text">
            <div class="card-title">${esc(f.name)}</div>
            <div class="card-meta">${f.pageCount} ${f.pageCount === 1 ? 'page' : 'pages'} · ${formatBytes(f.size)}</div>
          </div>
        </button>
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

  async function addFiles(list) {
    const pdfs = Array.from(list).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!pdfs.length) {
      toast('Only PDF files can be added.');
      return;
    }
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
      } catch (e) {
        console.warn(e);
        failed.push(`${f.name}: ${describePdfError(e)}`);
      }
    }
    const parts = [];
    if (added) parts.push(`Added ${added} ${added === 1 ? 'score' : 'scores'}.`);
    if (dupes) parts.push(`${dupes} already in your library.`);
    toast(parts.join(' ') || 'Nothing added.', 3000);
    if (failed.length) {
      await confirmDialog({ title: "Some files couldn't be added", message: failed.join('\n'), ok: 'OK', cancel: 'Close' });
    }
  }

  async function showMenu(id) {
    const meta = files.find((f) => f.id === id);
    if (!meta) return;
    const choice = await actionSheet({
      title: meta.name,
      actions: [
        { label: 'Rename', value: 'rename' },
        { label: 'Delete', value: 'delete', danger: true },
      ],
    });
    if (choice === 'rename') {
      const name = await promptDialog({ title: 'Rename score', value: meta.name, ok: 'Save' });
      if (name && name.trim()) await renameFile(id, name);
    } else if (choice === 'delete') {
      const ok = await confirmDialog({
        title: `Delete “${meta.name}”?`,
        message: 'The PDF and its reading position are removed from this iPad. This cannot be undone unless you have a backup.',
        ok: 'Delete',
        danger: true,
      });
      if (ok) {
        await deleteFile(id);
        const url = thumbUrls.get(id);
        if (url) URL.revokeObjectURL(url);
        thumbUrls.delete(id);
        toast('Deleted.');
      }
    }
  }

  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    if (e.target.closest('.card-more')) showMenu(card.dataset.id);
    else if (e.target.closest('.card-open')) onOpen(card.dataset.id);
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
    try { localStorage.setItem('ms:sort', sort.value); } catch { /* storage blocked */ }
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

  return { refresh, addFiles };
}
