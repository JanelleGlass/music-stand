// The markings tools of an open score. They take the place of the page,
// zoom and wink controls in the top bar (away from the hand that writes):
// pen, highlighter, eraser and text (tap the chosen one again for its
// colours and widths or sizes), undo, redo, a menu with writing by finger,
// hiding the markings, opening or collapsing every typed note and clearing a
// page, and Done. Typed notes themselves are js/text-notes.js.
import { getSettings, updateSettings } from './data.js';
import { PENS, HIGHLIGHTERS } from './ink-draw.js';
import { $, esc, icon, toast, confirmDialog, actionSheet } from './ui.js';

const PEN_NAMES = ['Black', 'Red', 'Blue', 'Green', 'Orange'];
const HL_NAMES = ['Yellow', 'Green', 'Pink', 'Blue'];
const WIDTH_NAMES = ['Fine', 'Medium', 'Bold'];
const SIZE_NAMES = ['Small', 'Medium', 'Large'];

export function initNotesUi({ ink, texts, onOpenChange }) {
  const tools = $('#notes-tools');
  const pop = $('#notes-pop');
  const button = $('#v-notes');
  const bar = $('.vbar');

  function render() {
    const s = getSettings();
    const tool = ink.tool;
    const tip = (color) => `<i class="tip" style="background:${esc(color)}"></i>`;
    const toolBtn = (t, ico, label, color) =>
      `<button class="icon-btn" data-tool="${t}" aria-pressed="${tool === t}" aria-label="${label}">${icon(ico)}${color ? tip(color) : ''}</button>`;
    tools.innerHTML =
      toolBtn('pen', 'pen', 'Pen', PENS.colors[s.penColor] === '#1d1d1f' ? '#f2f2f2' : PENS.colors[s.penColor]) +
      toolBtn('hl', 'marker', 'Highlighter', HIGHLIGHTERS.colors[s.hlColor]) +
      toolBtn('eraser', 'eraser', 'Eraser') +
      toolBtn('text', 'text', 'Text', PENS.colors[s.textColor] === '#1d1d1f' ? '#f2f2f2' : PENS.colors[s.textColor]) +
      '<span class="sep"></span>' +
      `<button class="icon-btn" data-act="undo" aria-label="Undo" ${ink.canUndo ? '' : 'disabled'}>${icon('undo')}</button>` +
      `<button class="icon-btn" data-act="redo" aria-label="Redo" ${ink.canRedo ? '' : 'disabled'}>${icon('redo')}</button>` +
      `<button class="icon-btn" data-act="more" aria-label="More markings options">${icon('more')}</button>` +
      '<button class="btn small" data-act="done">Done</button>';
    button.classList.toggle('off', ink.hidden);
    button.setAttribute('aria-label', ink.hidden ? 'Markings (hidden)' : 'Markings');
  }

  // Colours (and widths) of the pen or highlighter, under its button.
  function showLooks(anchor) {
    const s = getSettings();
    if (ink.tool === 'pen') {
      pop.innerHTML = PENS.colors.map((c, i) => `<button class="swatch" role="radio" data-pen-color="${i}" aria-checked="${s.penColor === i}" aria-label="${PEN_NAMES[i]}"><i style="background:${esc(c === '#1d1d1f' && getSettings().nightMode ? PENS.night[0] : c)}"></i></button>`).join('') +
        '<span class="sep"></span>' +
        PENS.widths.map((w, i) => `<button class="size-btn" role="radio" data-pen-width="${i}" aria-checked="${s.penWidth === i}" aria-label="${WIDTH_NAMES[i]}"><i style="width:${4 + i * 4}px;height:${4 + i * 4}px"></i></button>`).join('');
    } else if (ink.tool === 'text') {
      pop.innerHTML = PENS.colors.map((c, i) => `<button class="swatch" role="radio" data-text-color="${i}" aria-checked="${s.textColor === i}" aria-label="${PEN_NAMES[i]}"><i style="background:${esc(c === '#1d1d1f' && getSettings().nightMode ? PENS.night[0] : c)}"></i></button>`).join('') +
        '<span class="sep"></span>' +
        SIZE_NAMES.map((n, i) => `<button class="size-btn text-size" role="radio" data-text-size="${i}" aria-checked="${s.textSize === i}" aria-label="${n} text"><b style="font-size:${13 + i * 5}px">A</b></button>`).join('');
    } else if (ink.tool === 'hl') {
      pop.innerHTML = HIGHLIGHTERS.colors.map((c, i) => `<button class="swatch" role="radio" data-hl-color="${i}" aria-checked="${s.hlColor === i}" aria-label="${HL_NAMES[i]}"><i style="background:${esc(c)}"></i></button>`).join('');
    } else {
      return;
    }
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2))}px`;
  }

  function hideLooks() {
    pop.hidden = true;
  }

  function open() {
    ink.setToolbarOpen(true);
    tools.hidden = false;
    bar.classList.add('marking');
    button.setAttribute('aria-pressed', 'true');
    render();
    onOpenChange(true);
  }

  function close() {
    hideLooks();
    if (tools.hidden) return;
    ink.setToolbarOpen(false);
    tools.hidden = true;
    bar.classList.remove('marking');
    button.setAttribute('aria-pressed', 'false');
    onOpenChange(false);
  }

  async function more() {
    const page = ink.centerPage();
    const actions = [
      { label: ink.fingerDraws ? 'Stop writing with a finger' : 'Write with a finger', value: 'finger' },
      { label: ink.hidden ? 'Show markings' : 'Hide markings', value: 'hide' },
    ];
    const notes = texts.counts();
    if (notes.open) actions.push({ label: notes.all === 1 ? 'Collapse the typed note' : 'Collapse all typed notes', value: 'collapse' });
    if (notes.all > notes.open) actions.push({ label: notes.all === 1 ? 'Show the typed note' : 'Show all typed notes', value: 'expand' });
    if (ink.hasNotes(page)) actions.push({ label: `Clear markings on page ${page.num}…`, value: 'clear', danger: true });
    const choice = await actionSheet({ title: 'Markings', actions });
    if (choice === 'finger') {
      if (ink.tool === 'text') ink.setTool(getSettings().notesTool === 'hl' ? 'hl' : 'pen');
      ink.setFingerDraws(!ink.fingerDraws);
      toast(ink.fingerDraws ? 'Write with one finger. Scroll with two.' : 'Fingers scroll again.', 2400);
    } else if (choice === 'hide') {
      ink.setHidden(!ink.hidden);
      toast(ink.hidden ? 'Markings hidden.' : 'Markings shown.', 1400);
    } else if (choice === 'collapse' || choice === 'expand') {
      const n = texts.setAllOpen(choice === 'expand');
      toast(`${n} note${n === 1 ? '' : 's'} ${choice === 'expand' ? 'shown' : 'collapsed'}.`, 1400);
    } else if (choice === 'clear') {
      const ok = await confirmDialog({
        title: `Clear all markings on page ${page.num}?`,
        message: 'You can undo this until you close the score.',
        ok: 'Clear page',
        danger: true,
      });
      if (ok) ink.clearPage(page);
    }
    render();
  }

  tools.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.tool) {
      if (d.tool === ink.tool && pop.hidden) {
        showLooks(b);
        return;
      }
      hideLooks();
      ink.setTool(d.tool);
      if (d.tool === 'pen' || d.tool === 'hl') updateSettings({ notesTool: d.tool });
      if (d.tool === 'text') toast('Tap the music where the note goes. Tap a note to change it, or drag it.', 2600);
      return;
    }
    hideLooks();
    if (d.act === 'undo') ink.undo();
    else if (d.act === 'redo') ink.redo();
    else if (d.act === 'more') more();
    else if (d.act === 'done') close();
  });

  pop.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.penColor) updateSettings({ penColor: +d.penColor });
    else if (d.penWidth) updateSettings({ penWidth: +d.penWidth });
    else if (d.hlColor) updateSettings({ hlColor: +d.hlColor });
    else if (d.textColor) updateSettings({ textColor: +d.textColor });
    else if (d.textSize) updateSettings({ textSize: +d.textSize });
    hideLooks();
    render();
  });

  // Writing, or tapping anywhere else, puts the colours away.
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !tools.contains(e.target)) hideLooks();
  }, true);

  button.addEventListener('click', () => {
    if (ink.hidden) {
      ink.setHidden(false);
      toast('Markings shown.', 1400);
    }
    open();
  });
  ink.addEventListener('state', () => { if (!tools.hidden) render(); else button.classList.toggle('off', ink.hidden); });

  return {
    close,
    get isOpen() { return !tools.hidden; },
  };
}
