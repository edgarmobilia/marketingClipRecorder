'use strict';

// --- Image overlays ---
// Pictures placed on the video: a logo, a screenshot, a product photo, a
// sticker (overlay), or a full-frame cutaway / title card (fullscreen).
//
// image: {
//   id, asset,                 // asset = key of imageAssets (the picture itself)
//   start, end,                // ms on the source timeline
//   mode,                      // 'overlay' | 'fullscreen'
//   fit,                       // fullscreen only: 'cover' (fill, crop) | 'contain' (whole picture on `background`)
//   background,                // fullscreen + contain: colour behind the picture
//   x, y, w,                   // overlay only: centre (0–1) and width (0–1 of the frame, or of the page if anchor 'video')
//   anchor,                    // 'screen' | 'video' (glued to the page, follows zoom)
//   animation,                 // IMAGE_ANIMATIONS
//   kenBurns,                  // slow push-in while shown (fullscreen photos)
//   radius, shadow, borderWidth, borderColor, opacity, rotation,
// }
//
// The pixels live outside the project snapshot (undo copies it 50 times):
// each asset is stored once in IndexedDB as "img:<id>" and kept decoded here.

const IMAGE_ANIMATIONS = ['fade', 'slide-up', 'pop', 'zoom', 'none'];
const IMAGE_SHADOWS = ['none', 'soft', 'strong'];
const IMAGE_MAX_BYTES = 25e6;

let images = [];
let nextImageId = 1;
let nextAssetId = 1;
let selectedImageId = null;

const imageAssets = new Map(); // asset id -> { blob, name, width, height, el (decoded HTMLImageElement) }
const assetLoads = new Map();  // asset id -> Promise (loading from IndexedDB)

// --- Assets ---

function decodeImage(blob) {
  return new Promise((resolve, reject) => {
    const el = new Image();
    const url = URL.createObjectURL(blob);
    el.onload = () => {
      el.decode().catch(() => {}).then(() => resolve(el));
    };
    el.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The file is not an image this browser can read')); };
    el.src = url;
  });
}

async function addImageAsset(blob, name = '') {
  if (!blob.type.startsWith('image/')) throw new Error(`"${name || 'That file'}" is not an image`);
  if (blob.size > IMAGE_MAX_BYTES) throw new Error(`The image is ${Math.round(blob.size / 1e6)} MB; the limit is ${IMAGE_MAX_BYTES / 1e6} MB`);
  const el = await decodeImage(blob);
  // SVGs without a size report 0×0; give them a sensible box
  const width = el.naturalWidth || 1000, height = el.naturalHeight || 1000;
  const id = `a${nextAssetId++}`;
  imageAssets.set(id, { blob, name, width, height, el });
  await idbPut(`img:${id}`, { blob, name, width, height });
  return id;
}

function loadImageAsset(id) {
  if (imageAssets.has(id)) return Promise.resolve(imageAssets.get(id));
  if (assetLoads.has(id)) return assetLoads.get(id);
  const p = idbGet(`img:${id}`).then(async (rec) => {
    if (!rec) throw new Error(`Image asset ${id} is missing`);
    const el = await decodeImage(rec.blob);
    const a = { ...rec, el };
    imageAssets.set(id, a);
    return a;
  }).catch((err) => { console.warn('[MCR images]', err.message); return null; })
    .finally(() => assetLoads.delete(id));
  assetLoads.set(id, p);
  return p;
}

// Resolves when every picture the project uses is decoded (before a seek-and-render or an export)
async function imagesReady() {
  const missing = [...new Set(images.map(im => im.asset))].filter(id => !imageAssets.has(id));
  if (!missing.length) return;
  await Promise.all(missing.map(loadImageAsset));
  if (typeof rerender === 'function') rerender();
}

// A new recording / opened video starts without the old pictures
async function clearImageAssets() {
  imageAssets.clear();
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('recordings', 'readwrite');
    const store = tx.objectStore('recordings');
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const k of req.result) if (typeof k === 'string' && k.startsWith('img:')) store.delete(k);
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function assetAspect(im) {
  const a = imageAssets.get(im.asset);
  return a ? a.height / a.width : 1;
}

// --- Model ---

function normalizeImage(im) {
  const clamp = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);
  im.start = Math.max(0, Math.round(Number(im.start) || 0));
  im.end = Math.max(im.start + 100, Math.round(Number(im.end) || 0));
  im.mode = im.mode === 'fullscreen' ? 'fullscreen' : 'overlay';
  im.fit = im.fit === 'contain' ? 'contain' : 'cover';
  im.background = isColor(im.background) ? im.background : '#0b0b0f';
  im.x = clamp(im.x, -0.5, 1.5, 0.5);
  im.y = clamp(im.y, -0.5, 1.5, 0.5);
  im.w = clamp(im.w, 0.02, 2, 0.3);
  im.anchor = im.anchor === 'video' ? 'video' : 'screen';
  if (!IMAGE_ANIMATIONS.includes(im.animation)) im.animation = 'fade';
  im.kenBurns = !!im.kenBurns;
  im.radius = clamp(im.radius, 0, 400, 0);
  if (!IMAGE_SHADOWS.includes(im.shadow)) im.shadow = 'none';
  im.borderWidth = clamp(im.borderWidth, 0, 60, 0);
  im.borderColor = isColor(im.borderColor) ? im.borderColor : '#ffffff';
  im.opacity = clamp(im.opacity, 0, 1, 1);
  im.rotation = clamp(im.rotation, -180, 180, 0);
  return im;
}

async function addImage(params = {}) {
  if (!params.asset || !imageAssets.has(params.asset)) {
    if (params.asset) await loadImageAsset(params.asset);
    if (!imageAssets.has(params.asset)) throw new Error(`No image asset "${params.asset}"`);
  }
  const nowMs = Math.round((sourceVideo.currentTime || 0) * 1000);
  const durMs = (sourceVideo.duration || 0) * 1000;
  const start = params.start ?? nowMs;
  pushHistory();
  const im = normalizeImage({
    end: Math.min(durMs || start + 3000, start + 3000),
    ...stripUndefined(params),
    start,
    id: `i${nextImageId++}`,
  });
  images.push(im);
  selectedImageId = im.id;
  projectChanged();
  return im;
}

async function updateImage(id, patch) {
  const im = images.find(i => i.id === id);
  if (!im) throw new Error(`No image with id "${id}"`);
  if (patch.asset && !imageAssets.has(patch.asset)) await loadImageAsset(patch.asset);
  if (patch.asset && !imageAssets.has(patch.asset)) throw new Error(`No image asset "${patch.asset}"`);
  pushHistory();
  Object.assign(im, stripUndefined(patch), { id });
  normalizeImage(im);
  projectChanged();
  return im;
}

function removeImage(id) {
  const i = images.findIndex(im => im.id === id);
  if (i < 0) throw new Error(`No image with id "${id}"`);
  pushHistory();
  images.splice(i, 1);
  if (selectedImageId === id) selectedImageId = null;
  projectChanged();
}

// Position and size are per output format, like texts
const IMAGE_LAYOUT_FIELDS = ['x', 'y', 'w', 'anchor', 'fit'];

function swapImageLayouts(from, to) {
  for (const im of images) {
    im.layouts = im.layouts || {};
    im.layouts[from] = Object.fromEntries(IMAGE_LAYOUT_FIELDS.map(k => [k, im[k]]));
    const l = im.layouts[to];
    if (l) for (const k of IMAGE_LAYOUT_FIELDS) if (l[k] !== undefined) im[k] = l[k];
    normalizeImage(im);
  }
}

// --- Rendering ---

// Where an overlay image sits on the canvas (centre, size), before animation
function imageRect(im, view) {
  const a = imageAssets.get(im.asset);
  if (!a) return null;
  if (im.mode === 'fullscreen') {
    const { W, H } = view;
    const k = im.fit === 'cover' ? Math.max(W / a.width, H / a.height) : Math.min(W / a.width, H / a.height);
    return { cx: W / 2, cy: H / 2, w: a.width * k, h: a.height * k };
  }
  const video = im.anchor === 'video';
  const w = video ? im.w * view.vw * view.s : im.w * view.W;
  const cx = video ? view.tx + im.x * view.vw * view.s : im.x * view.W;
  const cy = video ? view.ty + im.y * view.vh * view.s : im.y * view.H;
  return { cx, cy, w, h: w * a.height / a.width };
}

function drawImages(c, tMs, view) {
  for (const im of images) {
    if (tMs < im.start || tMs > im.end) continue;
    drawImageOverlay(c, im, tMs, view);
  }
}

function drawImageOverlay(c, im, tMs, view) {
  const a = imageAssets.get(im.asset);
  if (!a) { loadImageAsset(im.asset).then(a2 => a2 && rerender()); return; }
  const r = imageRect(im, view);
  const { W, H, U } = view;
  const u = U / 1080;
  const full = im.mode === 'fullscreen';

  // Cutaways come in a little slower than stickers
  const span = im.end - im.start;
  const inDur = Math.min(full ? 400 : 300, span / 3), outDur = Math.min(full ? 350 : 220, span / 3);
  const kIn = Math.min(1, Math.max(0, (tMs - im.start) / inDur));
  const kOut = Math.min(1, Math.max(0, (im.end - tMs) / outDur));
  const k = im.animation === 'none' ? 1 : easeOutCubic(Math.min(kIn, kOut));
  if (k <= 0) return;

  c.save();
  c.globalAlpha = k * im.opacity;

  let scale = 1, dy = 0;
  if (im.animation === 'slide-up') dy = (1 - k) * U * 0.02;
  else if (im.animation === 'pop') scale = 0.94 + 0.06 * k;
  else if (im.animation === 'zoom') scale = 1.08 - 0.08 * k;
  if (im.kenBurns) scale *= 1 + 0.06 * Math.min(1, Math.max(0, (tMs - im.start) / span));

  if (full) {
    // Clip to the frame: a 'cover' picture is larger than the canvas
    c.beginPath();
    c.rect(0, 0, W, H);
    c.clip();
    if (im.fit === 'contain') {
      c.fillStyle = im.background;
      c.fillRect(0, 0, W, H);
    }
  }

  c.translate(r.cx, r.cy + dy);
  if (im.rotation) c.rotate(im.rotation * Math.PI / 180);
  c.scale(scale, scale);
  const x = -r.w / 2, y = -r.h / 2;
  const radius = im.radius * u * (im.anchor === 'video' && !full ? view.s : 1);

  if (!full && im.shadow !== 'none') {
    const strong = im.shadow === 'strong';
    c.save();
    c.shadowColor = strong ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.22)';
    c.shadowBlur = U * (strong ? 0.045 : 0.03);
    c.shadowOffsetY = U * (strong ? 0.014 : 0.008);
    c.fillStyle = '#000';
    roundRect(c, x, y, r.w, r.h, radius);
    c.fill();
    c.restore();
  }

  c.save();
  if (radius > 0) { roundRect(c, x, y, r.w, r.h, radius); c.clip(); }
  c.drawImage(a.el, x, y, r.w, r.h);
  c.restore();

  if (im.borderWidth > 0) {
    c.strokeStyle = im.borderColor;
    c.lineWidth = im.borderWidth * u;
    roundRect(c, x, y, r.w, r.h, radius);
    c.stroke();
  }
  c.restore();
}

// --- Sidebar panel ---

const imageListEl = document.getElementById('imageList');
const imageCountEl = document.getElementById('imageCount');
const imageFileInput = document.getElementById('imageFileInput');

async function addImageFromFile(file, extra = {}) {
  try {
    const asset = await addImageAsset(file, file.name);
    const a = imageAssets.get(asset);
    // A wide picture starts as a modest overlay; keep tall ones from filling the frame
    const w = Math.min(0.35, 0.5 * (previewCanvas.height / previewCanvas.width) * (a.width / a.height));
    await addImage({ asset, w: Math.max(0.12, w), ...extra });
    switchTab('images');
  } catch (err) {
    alert(err.message);
  }
}

function setupImagesPanel() {
  document.getElementById('addImageBtn').addEventListener('click', () => imageFileInput.click());
  imageFileInput.addEventListener('change', () => {
    const f = imageFileInput.files[0];
    imageFileInput.value = '';
    if (f) addImageFromFile(f);
  });
  setupImageCanvasDrag();
}

function selectImage(id, seek = true) {
  selectedImageId = id;
  const im = images.find(i => i.id === id);
  if (im && seek) seekTo(Math.min(im.end, im.start + 450) / 1000);
  renderImageList();
  renderTextMarkers();
  previewCanvas.classList.toggle('placing', activeTab === 'images' && !!selectedImageId);
}

function renderImageList() {
  if (!imageListEl) return;
  imageCountEl.textContent = images.length;
  imageListEl.innerHTML = '';
  if (!images.length) {
    imageListEl.innerHTML = '<div class="sidebar-hint">No images yet. Add a logo, screenshot or photo — or drop an image file on the editor, or ask Claude to place them.</div>';
    return;
  }
  for (const im of [...images].sort((a, b) => a.start - b.start)) {
    const a = imageAssets.get(im.asset);
    const selected = im.id === selectedImageId;
    const item = document.createElement('div');
    item.className = 'event-row text-item' + (selected ? ' active' : '');
    item.innerHTML = `
      <div class="event-head">
        <span class="image-thumb">${a ? '' : '🖼'}</span>
        <div class="event-main">
          <div class="event-title">${escapeHtml(a ? a.name || 'Image' : 'Loading…')}</div>
          <div class="event-sub">${im.mode === 'fullscreen' ? 'Full screen' : 'Overlay'} · ${fmtTime(im.start / 1000)} – ${fmtTime(im.end / 1000)}</div>
        </div>
      </div>
      ${selected ? imageEditorHtml(im) : ''}`;
    if (a) {
      const thumb = item.querySelector('.image-thumb');
      const t = a.el.cloneNode();
      thumb.appendChild(t);
    }
    item.querySelector('.event-head').addEventListener('click', () => {
      if (selected) { selectedImageId = null; renderImageList(); renderTextMarkers(); }
      else selectImage(im.id);
    });
    if (selected) bindImageEditor(item, im);
    imageListEl.appendChild(item);
  }
}

function imageEditorHtml(im) {
  const chip = (cls, val, label, on) => `<button class="chip ${cls} ${on ? 'active' : ''}" data-v="${val}">${label}</button>`;
  const full = im.mode === 'fullscreen';
  return `
    <div class="text-fields">
      <div class="field-label">Layout</div>
      <div class="chips">
        ${chip('i-mode', 'overlay', 'Overlay', !full)}
        ${chip('i-mode', 'fullscreen', 'Full screen', full)}
      </div>
      ${full ? `
        <div class="chips">
          ${chip('i-fit', 'cover', 'Fill', im.fit === 'cover')}
          ${chip('i-fit', 'contain', 'Whole picture', im.fit === 'contain')}
        </div>
        <label class="switch-row">
          <span>Slow push-in</span>
          <span class="switch"><input type="checkbox" class="i-kb" ${im.kenBurns ? 'checked' : ''}><span></span></span>
        </label>` : `
        <div class="click-setting-row">
          <label>Size</label>
          <input type="range" class="i-size" min="0.04" max="1" step="0.01" value="${Math.min(1, im.w)}">
          <span class="val">${Math.round(im.w * 100)}%</span>
        </div>
        <div class="click-setting-row">
          <label>Corners</label>
          <input type="range" class="i-radius" min="0" max="80" step="1" value="${im.radius}">
          <span class="val">${im.radius}</span>
        </div>
        <label class="switch-row">
          <span>Shadow</span>
          <span class="switch"><input type="checkbox" class="i-shadow" ${im.shadow !== 'none' ? 'checked' : ''}><span></span></span>
        </label>
        <label class="switch-row">
          <span>Follow the zoom</span>
          <span class="switch"><input type="checkbox" class="i-anchor" ${im.anchor === 'video' ? 'checked' : ''}><span></span></span>
        </label>`}

      <div class="field-label">Animation</div>
      <div class="chips">${IMAGE_ANIMATIONS.map(an => chip('i-anim', an, an[0].toUpperCase() + an.slice(1), an === im.animation)).join('')}</div>

      <div class="text-row">
        <label>From</label><input type="number" class="i-start" step="0.1" min="0" value="${(im.start / 1000).toFixed(1)}">
        <label>to</label><input type="number" class="i-end" step="0.1" min="0" value="${(im.end / 1000).toFixed(1)}">
        <label>s</label>
      </div>

      <div class="text-actions">
        <span class="text-hint">${full ? '' : 'Drag on the preview to place it'}</span>
        <button class="btn btn-sm btn-danger i-delete">Delete</button>
      </div>
    </div>`;
}

function bindImageEditor(item, im) {
  const $ = sel => item.querySelector(sel);
  const $$ = sel => item.querySelectorAll(sel);
  const live = (sel, key, fmt) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('pointerdown', pushHistory);
    el.addEventListener('input', () => {
      im[key] = parseFloat(el.value);
      el.nextElementSibling.textContent = fmt(im[key]);
      rerender(); saveProject();
    });
  };
  live('.i-size', 'w', v => Math.round(v * 100) + '%');
  live('.i-radius', 'radius', v => String(v));

  $$('.i-mode').forEach(b => b.addEventListener('click', () => updateImage(im.id, { mode: b.dataset.v })));
  $$('.i-fit').forEach(b => b.addEventListener('click', () => updateImage(im.id, { fit: b.dataset.v })));
  $$('.i-anim').forEach(b => b.addEventListener('click', () => updateImage(im.id, { animation: b.dataset.v })));
  $('.i-kb')?.addEventListener('change', e => updateImage(im.id, { kenBurns: e.target.checked }));
  $('.i-shadow')?.addEventListener('change', e => updateImage(im.id, { shadow: e.target.checked ? 'soft' : 'none' }));
  $('.i-anchor')?.addEventListener('change', (e) => {
    // Keep the picture where it is on screen when switching anchors
    const v = lastView || { W: 1, H: 1, vw: 1, vh: 1, s: 1, tx: 0, ty: 0 };
    const toVideo = e.target.checked;
    const r = imageRect(im, v) || { cx: im.x * v.W, cy: im.y * v.H, w: im.w * v.W };
    updateImage(im.id, toVideo
      ? { anchor: 'video', x: (r.cx - v.tx) / (v.s * v.vw), y: (r.cy - v.ty) / (v.s * v.vh), w: r.w / (v.s * v.vw) }
      : { anchor: 'screen', x: r.cx / v.W, y: r.cy / v.H, w: r.w / v.W });
  });
  $('.i-start').addEventListener('change', e => updateImage(im.id, { start: parseFloat(e.target.value) * 1000 }));
  $('.i-end').addEventListener('change', e => updateImage(im.id, { end: parseFloat(e.target.value) * 1000 }));
  $('.i-delete').addEventListener('click', () => removeImage(im.id));
}

function startImageBarDrag(e, im) {
  e.stopPropagation();
  e.preventDefault();
  pushHistory();
  switchTab('images');
  selectImage(im.id, false);

  const startX = e.clientX;
  const origStart = im.start, len = im.end - im.start;
  const total = sourceVideo.duration * 1000;
  const width = timeline.getBoundingClientRect().width;
  let moved = false;

  const onMove = (ev) => {
    moved = true;
    const dt = ((ev.clientX - startX) / width) * total;
    im.start = Math.round(Math.max(0, Math.min(total - len, origStart + dt)));
    im.end = im.start + len;
    renderTextMarkers();
    if (sourceVideo.paused) seekTo((im.start + Math.min(450, len / 2)) / 1000);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (!moved) { undoStack.pop(); seekTo((im.start + Math.min(450, len / 2)) / 1000); }
    renderImageList();
    saveProject();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// Drag the selected overlay image on the preview (moves its centre)
function setupImageCanvasDrag() {
  previewCanvas.addEventListener('pointerdown', (e) => {
    if (activeTab !== 'images' || !selectedImageId || !lastView) return;
    const im = images.find(i => i.id === selectedImageId);
    if (!im || im.mode === 'fullscreen') return;
    e.preventDefault();
    pushHistory();
    previewCanvas.setPointerCapture(e.pointerId);
    const v = lastView;
    const toCanvas = (ev) => {
      const r = previewCanvas.getBoundingClientRect();
      return { cx: ((ev.clientX - r.left) / r.width) * v.W, cy: ((ev.clientY - r.top) / r.height) * v.H };
    };
    // Grab offset, so the picture doesn't jump its centre to the pointer
    const p0 = toCanvas(e);
    const r0 = imageRect(im, v);
    const off = r0 ? { x: r0.cx - p0.cx, y: r0.cy - p0.cy } : { x: 0, y: 0 };

    const onMove = (ev) => {
      const p = toCanvas(ev);
      const cx = p.cx + off.x, cy = p.cy + off.y;
      if (im.anchor === 'video') {
        im.x = (cx - v.tx) / (v.s * v.vw);
        im.y = (cy - v.ty) / (v.s * v.vh);
      } else {
        im.x = cx / v.W;
        im.y = cy / v.H;
      }
      normalizeImage(im);
      rerender();
    };
    const onUp = () => {
      previewCanvas.removeEventListener('pointermove', onMove);
      previewCanvas.removeEventListener('pointerup', onUp);
      saveProject();
    };
    previewCanvas.addEventListener('pointermove', onMove);
    previewCanvas.addEventListener('pointerup', onUp);
  });
}
