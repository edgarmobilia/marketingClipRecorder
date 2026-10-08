'use strict';

// --- Text overlays: editing UI (sidebar panel, timeline track, canvas drag) ---
// Depends on globals from overlays.js and editor.js.

let selectedTextId = null;
let activeTab = 'events';

const textListEl = document.getElementById('textList');
const textCountEl = document.getElementById('textCount');
const textMarkersEl = document.getElementById('textMarkers');

// --- CRUD (shared by the UI and the Claude bridge) ---

function addText(params = {}) {
  pushHistory();
  const nowMs = Math.round((sourceVideo.currentTime || 0) * 1000);
  const durMs = (sourceVideo.duration || 0) * 1000;
  const start = params.start ?? nowMs;
  const o = createOverlay({ ...params, start, end: params.end ?? Math.min(durMs || start + 2500, start + 2500) });
  overlays.push(o);
  selectedTextId = o.id;
  projectChanged();
  return o;
}

function updateText(id, patch) {
  const o = overlays.find(t => t.id === id);
  if (!o) throw new Error(`No text with id "${id}"`);
  pushHistory();
  const { design, resetDesign, ...rest } = stripUndefined(patch);
  Object.assign(o, rest, { id });
  if (resetDesign) o.design = {};
  if (design) o.design = mergeDesign(o.design, design);
  normalizeOverlay(o);
  projectChanged();
  return o;
}

// Same patch applied to several texts in one undo step (e.g. restyle everything)
function updateTexts(ids, patch) {
  const targets = ids ? overlays.filter(t => ids.includes(t.id)) : overlays;
  if (ids && targets.length !== ids.length) {
    const missing = ids.filter(id => !overlays.some(t => t.id === id));
    throw new Error(`No text with id ${missing.map(m => `"${m}"`).join(', ')}`);
  }
  pushHistory();
  const { design, resetDesign, ...rest } = stripUndefined(patch);
  for (const o of targets) {
    Object.assign(o, rest, { id: o.id });
    if (resetDesign) o.design = {};
    if (design) o.design = mergeDesign(o.design, design);
    normalizeOverlay(o);
  }
  projectChanged();
  return targets;
}

function removeText(id) {
  const i = overlays.findIndex(t => t.id === id);
  if (i < 0) throw new Error(`No text with id "${id}"`);
  pushHistory();
  overlays.splice(i, 1);
  if (selectedTextId === id) selectedTextId = null;
  projectChanged();
}

// --- Sidebar tabs ---

function setupSidebarTabs() {
  document.querySelectorAll('.sidebar-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.sidebar-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `panel-${tab}`));
  previewCanvas.classList.toggle('placing', tab === 'texts' && !!selectedTextId);
}

// --- Text panel ---
// Friendly by default: chips and swatches; every number lives under "More".

const SWATCHES = ['#ffffff', '#111113', '#3e63dd', '#e03c3c', '#f59e0b', '#10b981', '#7dd3fc', '#a855f7'];
const FONT_CHOICES = ['', 'Inter', 'Poppins', 'Montserrat', 'Bebas Neue', 'Space Grotesk', 'Playfair Display', 'Caveat'];
const ANIM_LABELS = { fade: 'Fade', 'slide-up': 'Slide', pop: 'Pop', typewriter: 'Type', none: 'None' };
const NEW_TEXT = { title: 'Your title', caption: 'Caption text', 'lower-third': 'Step 1 · Do this',
  callout: 'Click here', highlight: 'Look here', text: 'Big text' };

// Callouts and highlights are coloured by their accent; the rest by the box background
const usesAccent = o => o.style === 'callout' || o.style === 'highlight';

function boxColorOf(o) {
  if (usesAccent(o)) return o.accent;
  return resolveDesign(o).background;
}

// Black or white, whichever reads better on the given colour
function contrastText(col) {
  colorProbe.fillStyle = '#000';
  colorProbe.fillStyle = col;
  const v = colorProbe.fillStyle;
  let r, g, b;
  if (v.startsWith('#')) { r = parseInt(v.slice(1, 3), 16); g = parseInt(v.slice(3, 5), 16); b = parseInt(v.slice(5, 7), 16); }
  else [r, g, b] = (v.match(/[\d.]+/g) || [0, 0, 0]).map(Number);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#0b0b0f' : '#ffffff';
}

function setupTextPanel() {
  const chips = document.getElementById('addTextChips');
  chips.innerHTML = Object.entries(TEXT_STYLES)
    .map(([k, v]) => `<button class="chip" data-style="${k}">+ ${v.label}</button>`).join('');
  chips.querySelectorAll('.chip').forEach(btn => btn.addEventListener('click', () => {
    const style = btn.dataset.style;
    // Pointing styles start where the last click happened, if there is one nearby
    const nowMs = (sourceVideo.currentTime || 0) * 1000;
    const near = clicks.filter(c => Math.abs(c.t - nowMs) < 3000).sort((a, b) => Math.abs(a.t - nowMs) - Math.abs(b.t - nowMs))[0];
    const extra = {};
    if ((style === 'callout' || style === 'highlight') && near) {
      if (style === 'highlight' && near.rect) {
        Object.assign(extra, {
          x: (near.rect.x + near.rect.w / 2) / near.vw, y: (near.rect.y + near.rect.h / 2) / near.vh,
          w: near.rect.w / near.vw, h: near.rect.h / near.vh,
        });
      } else Object.assign(extra, { x: near.nx, y: near.ny });
    }
    addText({ style, text: NEW_TEXT[style], ...extra });
    switchTab('texts');
  }));
  setupCanvasDrag();
}

function selectText(id, seek = true) {
  selectedTextId = id;
  const o = overlays.find(t => t.id === id);
  if (o && seek) seekTo(Math.min(o.end, o.start + 400) / 1000);
  renderTextList();
  renderTextMarkers();
  previewCanvas.classList.toggle('placing', activeTab === 'texts' && !!selectedTextId);
}

function renderTextList() {
  textCountEl.textContent = overlays.length;
  textListEl.innerHTML = '';
  if (!overlays.length) {
    textListEl.innerHTML = '<div class="sidebar-hint">No texts yet. Pick a style above, or ask Claude to write them for you.</div>';
    return;
  }

  const sorted = [...overlays].sort((a, b) => a.start - b.start);
  for (const o of sorted) {
    const item = document.createElement('div');
    const selected = o.id === selectedTextId;
    item.className = 'event-row text-item' + (selected ? ' active' : '');
    const d = resolveDesign(o);
    const box = boxColorOf(o);
    const swatchBg = box === 'transparent' ? 'transparent' : box;

    item.innerHTML = `
      <div class="event-head">
        <span class="text-dot" style="background:${escapeHtml(swatchBg)};color:${escapeHtml(d.textColor || '#fff')}">T</span>
        <div class="event-main">
          <div class="event-title">${escapeHtml(o.text) || '<em>empty</em>'}</div>
          <div class="event-sub">${escapeHtml(TEXT_STYLES[o.style].label)} · ${fmtTime(o.start / 1000)} – ${fmtTime(o.end / 1000)}</div>
        </div>
      </div>
      ${selected ? textEditorHtml(o, d, box) : ''}
    `;

    item.querySelector('.event-head').addEventListener('click', () => {
      if (selected) { selectedTextId = null; renderTextList(); renderTextMarkers(); }
      else selectText(o.id);
    });
    if (selected) bindTextEditor(item, o);
    textListEl.appendChild(item);
  }
}

function textEditorHtml(o, d, box) {
  const chip = (cls, val, label, on) => `<button class="chip ${cls} ${on ? 'active' : ''}" data-v="${escapeHtml(val)}">${label}</button>`;
  const sw = (cls, col, on) => `<button class="swatch ${cls} ${on ? 'active' : ''}" data-v="${col}" style="background:${col}" title="${col}"></button>`;
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const fontOpts = FONT_CHOICES.map(f =>
    `<option value="${f}" ${(d.fontFamily || '') === f ? 'selected' : ''}>${f || 'Default font'}</option>`).join('');

  return `
    <div class="text-fields">
      <textarea class="t-text" rows="2" placeholder="Write something…">${escapeHtml(o.text)}</textarea>

      <div class="field-label">Style</div>
      <div class="chips">${Object.entries(TEXT_STYLES).map(([k, v]) => chip('t-style', k, v.label, k === o.style)).join('')}</div>

      <div class="field-label">Colour</div>
      <div class="swatches">
        ${usesAccent(o) ? '' : `<button class="swatch t-box none ${box === 'transparent' ? 'active' : ''}" data-v="transparent" title="No box"></button>`}
        ${SWATCHES.map(c => sw('t-box', c, same(c, box))).join('')}
        <label class="swatch custom" title="Custom colour"><input type="color" class="t-box-custom" value="${/^#[0-9a-f]{6}$/i.test(box) ? box : '#7dd3fc'}"></label>
      </div>

      <div class="field-label">Text colour</div>
      <div class="swatches">
        ${['#ffffff', '#0b0b0f'].map(c => sw('t-ink', c, same(c, d.textColor))).join('')}
        <label class="swatch custom" title="Custom colour"><input type="color" class="t-ink-custom" value="${/^#[0-9a-f]{6}$/i.test(d.textColor || '') ? d.textColor : '#ffffff'}"></label>
      </div>

      <div class="field-label">Animation</div>
      <div class="chips">${TEXT_ANIMATIONS.map(a => chip('t-anim', a, ANIM_LABELS[a], a === o.animation)).join('')}</div>

      <div class="click-setting-row">
        <label>Size</label>
        <input type="range" class="t-size" min="0.5" max="2.5" step="0.05" value="${o.size}">
        <span class="val">${Math.round(o.size * 100)}%</span>
      </div>
      <label class="switch-row">
        <span>Follow the zoom</span>
        <span class="switch"><input type="checkbox" class="t-anchor" ${o.anchor === 'video' ? 'checked' : ''}><span></span></span>
      </label>

      <details class="more">
        <summary>More options</summary>
        <div class="text-row">
          <label>From</label><input type="number" class="t-start" step="0.1" min="0" value="${(o.start / 1000).toFixed(1)}">
          <label>to</label><input type="number" class="t-end" step="0.1" min="0" value="${(o.end / 1000).toFixed(1)}">
          <label>s</label>
        </div>
        <div class="text-row"><select class="t-font">${fontOpts}</select></div>
        <label class="switch-row">
          <span>Border</span>
          <span class="switch"><input type="checkbox" class="t-border" ${d.borderWidth > 0 ? 'checked' : ''}><span></span></span>
        </label>
        <label class="switch-row">
          <span>UPPERCASE</span>
          <span class="switch"><input type="checkbox" class="t-upper" ${d.uppercase ? 'checked' : ''}><span></span></span>
        </label>
        <label class="switch-row">
          <span>Shadow</span>
          <span class="switch"><input type="checkbox" class="t-shadow" ${d.shadow && d.shadow !== 'none' ? 'checked' : ''}><span></span></span>
        </label>
        <button class="btn btn-sm t-reset">Reset look</button>
      </details>

      <div class="text-actions">
        <span class="text-hint">Drag on the preview to place it</span>
        <button class="btn btn-sm btn-danger t-delete">Delete</button>
      </div>
    </div>`;
}

function bindTextEditor(item, o) {
  const $ = sel => item.querySelector(sel);
  const $$ = sel => item.querySelectorAll(sel);

  // Live typing: no list re-render (keeps focus); one undo step per focus
  const text = $('.t-text');
  text.addEventListener('focus', pushHistory);
  text.addEventListener('input', () => {
    o.text = text.value;
    item.querySelector('.event-title').textContent = o.text;
    rerender(); renderTextMarkers(); saveProject();
  });

  const size = $('.t-size');
  size.addEventListener('pointerdown', pushHistory);
  size.addEventListener('input', () => {
    o.size = parseFloat(size.value);
    size.nextElementSibling.textContent = Math.round(o.size * 100) + '%';
    rerender(); saveProject();
  });

  $$('.t-style').forEach(b => b.addEventListener('click', () => updateText(o.id, { style: b.dataset.v })));
  $$('.t-anim').forEach(b => b.addEventListener('click', () => updateText(o.id, { animation: b.dataset.v })));

  // Picking a box colour also picks a readable text colour, unless one was chosen
  const setBox = (col) => {
    const patch = usesAccent(o) ? { accent: col } : { design: { background: col, gradient: null } };
    if (col !== 'transparent' && !o.design.textColor) {
      patch.design = { ...(patch.design || {}), textColor: contrastText(col) };
    }
    updateText(o.id, patch);
  };
  $$('.t-box').forEach(b => b.addEventListener('click', () => setBox(b.dataset.v)));
  $('.t-box-custom').addEventListener('change', e => setBox(e.target.value));

  const setInk = col => updateText(o.id, { design: { textColor: col } });
  $$('.t-ink').forEach(b => b.addEventListener('click', () => setInk(b.dataset.v)));
  $('.t-ink-custom').addEventListener('change', e => setInk(e.target.value));

  $('.t-anchor').addEventListener('change', e => {
    // Keep the text where it is on screen when switching anchors
    const v = lastView || { W: 1, H: 1, s: 1, tx: 0, ty: 0 };
    const sx = o.anchor === 'video' ? (v.tx + o.x * v.W * v.s) / v.W : o.x;
    const sy = o.anchor === 'video' ? (v.ty + o.y * v.H * v.s) / v.H : o.y;
    const to = e.target.checked ? 'video' : 'screen';
    const x = to === 'video' ? (sx * v.W - v.tx) / (v.s * v.W) : sx;
    const y = to === 'video' ? (sy * v.H - v.ty) / (v.s * v.H) : sy;
    updateText(o.id, { anchor: to, x, y });
  });

  $('.t-start').addEventListener('change', e => updateText(o.id, { start: parseFloat(e.target.value) * 1000 }));
  $('.t-end').addEventListener('change', e => updateText(o.id, { end: parseFloat(e.target.value) * 1000 }));
  $('.t-font').addEventListener('change', e => updateText(o.id, { design: { fontFamily: e.target.value || null } }));
  $('.t-border').addEventListener('change', e => updateText(o.id, {
    // 0, not null: some styles have a hairline border by default
    design: e.target.checked ? { borderWidth: 2, borderColor: o.design.borderColor || 'rgba(17,17,19,0.18)' } : { borderWidth: 0 },
  }));
  $('.t-upper').addEventListener('change', e => updateText(o.id, { design: { uppercase: e.target.checked || null } }));
  $('.t-shadow').addEventListener('change', e => updateText(o.id, { design: { shadow: e.target.checked ? 'soft' : 'none' } }));
  $('.t-reset').addEventListener('click', () => updateText(o.id, { resetDesign: true }));
  $('.t-delete').addEventListener('click', () => removeText(o.id));
}

// --- Timeline track ---

function renderTextMarkers() {
  textMarkersEl.innerHTML = '';
  if (!sourceVideo.duration) return;
  const total = sourceVideo.duration * 1000;

  // Overlapping texts go on separate lanes (greedy, max 3) so none is hidden
  const laneEnds = [];
  const lanes = new Map();
  for (const o of [...overlays].sort((a, b) => a.start - b.start)) {
    let lane = laneEnds.findIndex(end => end <= o.start);
    if (lane < 0) lane = laneEnds.length < 3 ? laneEnds.length : laneEnds.indexOf(Math.min(...laneEnds));
    laneEnds[lane] = o.end;
    lanes.set(o.id, lane);
  }
  const laneCount = Math.max(1, laneEnds.length);

  for (const o of overlays) {
    const bar = document.createElement('div');
    bar.className = 'text-bar' + (o.id === selectedTextId ? ' active' : '') + (laneCount > 1 ? ' compact' : '');
    bar.style.left = (o.start / total) * 100 + '%';
    bar.style.width = Math.max(0.4, ((o.end - o.start) / total) * 100) + '%';
    bar.style.top = (lanes.get(o.id) / laneCount) * 100 + '%';
    bar.style.height = `calc(${100 / laneCount}% - 1px)`;
    bar.title = o.text;
    bar.textContent = o.text;
    bar.addEventListener('pointerdown', (e) => startTextBarDrag(e, o));
    textMarkersEl.appendChild(bar);
  }
}

function startTextBarDrag(e, o) {
  e.stopPropagation();
  e.preventDefault();
  pushHistory();
  switchTab('texts');
  selectText(o.id, false);

  const startX = e.clientX;
  const origStart = o.start, len = o.end - o.start;
  const total = sourceVideo.duration * 1000;
  const width = timeline.getBoundingClientRect().width;
  let moved = false;

  const onMove = (ev) => {
    moved = true;
    const dt = ((ev.clientX - startX) / width) * total;
    o.start = Math.round(Math.max(0, Math.min(total - len, origStart + dt)));
    o.end = o.start + len;
    renderTextMarkers();
    if (sourceVideo.paused) seekTo((o.start + Math.min(400, len / 2)) / 1000);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (!moved) { undoStack.pop(); seekTo((o.start + Math.min(400, len / 2)) / 1000); }
    renderTextList();
    saveProject();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// --- Drag the selected text on the preview ---

function setupCanvasDrag() {
  previewCanvas.addEventListener('pointerdown', (e) => {
    if (activeTab !== 'texts' || !selectedTextId || !lastView) return;
    const o = overlays.find(t => t.id === selectedTextId);
    if (!o) return;
    e.preventDefault();
    pushHistory();
    previewCanvas.setPointerCapture(e.pointerId);

    const place = (ev) => {
      const r = previewCanvas.getBoundingClientRect();
      const cx = ((ev.clientX - r.left) / r.width) * lastView.W;
      const cy = ((ev.clientY - r.top) / r.height) * lastView.H;
      if (o.anchor === 'video') {
        o.x = (cx - lastView.tx) / (lastView.s * lastView.W);
        o.y = (cy - lastView.ty) / (lastView.s * lastView.H);
      } else {
        o.x = cx / lastView.W;
        o.y = cy / lastView.H;
      }
      normalizeOverlay(o);
      rerender();
    };
    place(e);

    const onMove = ev => place(ev);
    const onUp = () => {
      previewCanvas.removeEventListener('pointermove', onMove);
      previewCanvas.removeEventListener('pointerup', onUp);
      saveProject();
    };
    previewCanvas.addEventListener('pointermove', onMove);
    previewCanvas.addEventListener('pointerup', onUp);
  });
}
