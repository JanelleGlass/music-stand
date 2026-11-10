// The markings tools of an open score. They take the place of the page,
// zoom and wink controls in the top bar (away from the hand that writes):
// pen, highlighter, eraser and text (tap the chosen one again for its
// colours and widths or sizes; any colour can be picked or typed as a hex
// code, saved to the list, or taken off it), undo, redo, a menu with writing by finger,
// hiding the markings, opening or collapsing every typed note and clearing a
// page, and Done. Typed notes themselves are js/text-notes.js.
import { getSettings, updateSettings } from './data.js';
import { PENS } from './ink-draw.js';
import { PEN_COLORS, palette, chosen, listKey, withColor, withoutColor, isBuiltIn, colorName, normalHex } from './colors.js';
import { $, esc, icon, toast, confirmDialog, actionSheet } from './ui.js';

// Each tool's colours: the list it offers, and the setting with the one in use.
const LOOKS = {
  pen: { kind: 'pen', key: 'penColor' },
  text: { kind: 'pen', key: 'textColor' },
  hl: { kind: 'hl', key: 'hlColor' },
};
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
    const penTip = (key) => { const c = chosen(s, key); return c === PEN_COLORS[0] ? '#f2f2f2' : c; };
    const toolBtn = (t, ico, label, color) =>
      `<button class="icon-btn" data-tool="${t}" aria-pressed="${tool === t}" aria-label="${label}">${icon(ico)}${color ? tip(color) : ''}</button>`;
    tools.innerHTML =
      toolBtn('pen', 'pen', 'Pen', penTip('penColor')) +
      toolBtn('hl', 'marker', 'Highlighter', chosen(s, 'hlColor')) +
      toolBtn('eraser', 'eraser', 'Eraser') +
      toolBtn('text', 'text', 'Text', penTip('textColor')) +
      '<span class="sep"></span>' +
      `<button class="icon-btn" data-act="undo" aria-label="Undo" ${ink.canUndo ? '' : 'disabled'}>${icon('undo')}</button>` +
      `<button class="icon-btn" data-act="redo" aria-label="Redo" ${ink.canRedo ? '' : 'disabled'}>${icon('redo')}</button>` +
      `<button class="icon-btn" data-act="more" aria-label="More markings options">${icon('more')}</button>` +
      '<button class="btn small" data-act="done">Done</button>';
    button.classList.toggle('off', ink.hidden);
    button.setAttribute('aria-label', ink.hidden ? 'Markings (hidden)' : 'Markings');
  }

  // Colours (and widths or sizes) of the pen, highlighter or Text tool,
  // under its button. Picking: the colour picker and hex code. Removing: tapping
  // a colour takes it off the list.
  let picking = false;
  let removing = false;
  let anchor = null;

  function showLooks(at) {
    if (!LOOKS[ink.tool]) return;
    anchor = at;
    picking = false;
    removing = false;
    renderLooks();
  }

  function renderLooks() {
    const look = LOOKS[ink.tool];
    if (!look) return;
    const s = getSettings();
    const list = palette(s, look.kind);
    const cur = chosen(s, look.key);
    const own = !list.includes(cur);
    const canRemove = list.length > 1;
    const shown = (c) => esc(look.kind === 'pen' && c === PEN_COLORS[0] && s.nightMode ? PENS.night[0] : c);
    let html = list.map((c) =>
      `<button class="swatch${removing && canRemove ? ' removing' : ''}" role="radio" data-color="${c}" aria-checked="${!removing && c === cur}" aria-label="${removing && canRemove ? 'Remove ' : ''}${colorName(c)}"><i style="background:${shown(c)}"></i></button>`).join('');
    // The colour in use when it isn't on the list, else a rainbow: opens the picker.
    html += `<button class="swatch other${own ? ' own' : ''}" data-act="pick" aria-expanded="${picking}" aria-checked="${!removing && own}" aria-label="${own ? `Other colour, ${cur} in use` : 'Other colour'}"><i${own ? ` style="background:${shown(cur)}"` : ''}></i></button>`;
    if (ink.tool === 'pen') {
      html += '<span class="sep"></span>' +
        PENS.widths.map((w, i) => `<button class="size-btn" role="radio" data-pen-width="${i}" aria-checked="${s.penWidth === i}" aria-label="${WIDTH_NAMES[i]}"><i style="width:${4 + i * 4}px;height:${4 + i * 4}px"></i></button>`).join('');
    } else if (ink.tool === 'text') {
      html += '<span class="sep"></span>' +
        SIZE_NAMES.map((n, i) => `<button class="size-btn text-size" role="radio" data-text-size="${i}" aria-checked="${s.textSize === i}" aria-label="${n} text"><b style="font-size:${13 + i * 5}px">A</b></button>`).join('');
    }
    if (picking) {
      html += '<div class="color-more">' +
        `<input type="color" class="color-well" value="${cur}" aria-label="Pick a colour">` +
        `<label class="hex-field"><span aria-hidden="true">#</span><input type="text" value="${cur.slice(1)}" maxlength="7" inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Hex colour code"></label>` +
        `<button class="btn small" data-act="save" ${own ? '' : 'disabled'}>Save colour</button>` +
        (canRemove || removing ? `<button class="btn small" data-act="remove" aria-pressed="${removing}">${removing ? 'Done' : 'Remove…'}</button>` : '') +
        (removing && !isBuiltIn(list, look.kind) ? '<button class="btn small" data-act="reset">Reset</button>' : '') +
        '</div>';
      if (removing) html += `<p class="color-hint">${canRemove ? 'Tap a colour to take it off the list.' : 'The last colour stays.'}</p>`;
    }
    pop.innerHTML = html;
    pop.classList.toggle('wide', picking);
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2))}px`;
  }

  // A colour picked or typed: in use at once. The picker stays open, so only
  // what shows it is brought up to date.
  function useColor(hex, from) {
    const look = LOOKS[ink.tool];
    if (!look) return;
    updateSettings({ [look.key]: hex });
    render();
    const list = palette(getSettings(), look.kind);
    const own = !list.includes(hex);
    for (const b of pop.querySelectorAll('.swatch[data-color]')) b.setAttribute('aria-checked', String(!removing && b.dataset.color === hex));
    const other = pop.querySelector('.swatch.other');
    other.classList.toggle('own', own);
    other.setAttribute('aria-checked', String(!removing && own));
    other.querySelector('i').style.background = own ? hex : '';
    const save = pop.querySelector('[data-act="save"]');
    if (save) save.disabled = !own;
    const well = pop.querySelector('.color-well');
    if (well && from !== well) well.value = hex;
    const field = pop.querySelector('.hex-field input');
    if (field && from !== field) field.value = hex.slice(1);
  }

  function hideLooks() {
    pop.hidden = true;
    picking = false;
    removing = false;
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

  pop.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    const look = LOOKS[ink.tool];
    if (!b || !look) return;
    const d = b.dataset;
    const s = getSettings();
    const list = palette(s, look.kind);
    const key = listKey(look.kind);
    if (d.act === 'pick') {
      picking = !picking;
      removing = false;
      renderLooks();
      return;
    }
    if (d.act === 'save') {
      updateSettings({ [key]: withColor(list, chosen(s, look.key)) });
      renderLooks();
      return;
    }
    if (d.act === 'remove') {
      removing = !removing;
      renderLooks();
      return;
    }
    if (d.act === 'reset') {
      const ok = await confirmDialog({
        title: `Reset the ${look.kind === 'hl' ? 'highlighter' : 'pen'} colours?`,
        message: 'The built-in colours come back, and the colours you saved are taken off the list. Your markings keep their colours.',
        ok: 'Reset colours',
        danger: true,
      });
      if (ok) {
        updateSettings({ [key]: null });
        removing = false;
        picking = true;
        renderLooks();
      }
      return;
    }
    if (d.color && removing) {
      updateSettings({ [key]: withoutColor(list, d.color) });
      renderLooks();
      return;
    }
    if (d.color) updateSettings({ [look.key]: d.color });
    else if (d.penWidth) updateSettings({ penWidth: +d.penWidth });
    else if (d.textSize) updateSettings({ textSize: +d.textSize });
    else return;
    hideLooks();
    render();
  });

  // The colour picker and the hex code.
  pop.addEventListener('input', (e) => {
    const t = e.target;
    if (t.classList.contains('color-well')) {
      const hex = normalHex(t.value);
      if (hex) useColor(hex, t);
    } else if (t.closest('.hex-field')) {
      const v = t.value.replace(/^#/, '');
      // Three digits might be the start of six, so wait for the field to be left.
      const hex = v.length === 6 ? normalHex(v) : null;
      if (hex) useColor(hex, t);
    }
  });
  pop.addEventListener('change', (e) => {
    const t = e.target;
    const look = LOOKS[ink.tool];
    if (!look) return;
    if (t.classList.contains('color-well')) {
      const hex = normalHex(t.value);
      if (hex) useColor(hex, t);
      return;
    }
    if (!t.closest('.hex-field')) return;
    const hex = normalHex(t.value);
    if (hex) useColor(hex, null);
    else {
      t.value = chosen(getSettings(), look.key).slice(1);
      toast('A hex code is 6 digits and letters A–F, like 1F5FD1.', 2400);
    }
  });
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest('.hex-field')) e.target.blur();
    else if (e.key === 'Escape') hideLooks();
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
