'use strict';

// --- Cursor & click effects (post-production) ---
// Nothing is burned in while recording: the recorder only logs cursor
// positions and clicks. Here they are drawn on top of the video — any cursor
// (arrow, cartoon glove, dot, custom image/SVG) and any click effect — and can
// be changed or removed at any time.

const CURSOR_STYLES = ['none', 'arrow', 'hand', 'dot', 'custom'];
const CLICK_EFFECTS = ['none', 'ripple', 'pulse', 'burst'];

const CURSOR_DEFAULTS = {
  cursor: 'arrow',
  cursorSize: 44,          // px at 1080p
  cursorColor: '#111114',  // dot fill / arrow body
  customImage: null,       // data: URL or SVG markup
  hotspotX: 0,             // 0–1 of the image: where the "tip" is
  hotspotY: 0,
  clickEffect: 'none',     // opt in per project: ripple / pulse / burst
  effectColor: '#e03c3c',
  effectSize: 70,          // px at 1080p
  pressAnimation: true,    // cursor squashes briefly on each click
};

let cursorFx = { ...CURSOR_DEFAULTS };

// --- Built-in artwork (SVG, drawn as images so they stay crisp at any size) ---
// hotspot = fraction of the viewBox where the pointer's tip is

const BUILTIN_CURSORS = {
  arrow: {
    hotspot: [0.16, 0.08],
    svg: (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <path d="M16 8 L16 78 L34 61 L46 89 L59 83 L47 56 L72 56 Z"
        fill="${color}" stroke="#fff" stroke-width="6" stroke-linejoin="round"/></svg>`,
  },
  hand: {
    // Cartoon white glove, index finger pointing up-left
    hotspot: [0.29, 0.05],
    svg: () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <g stroke="#111" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" fill="#fff">
        <ellipse cx="22" cy="60" rx="11" ry="15" transform="rotate(-25 22 60)"/>
        <path d="M24 44 Q24 38 32 38 L72 42 Q86 44 86 58 L84 70 Q82 84 66 86 L40 86 Q24 84 22 68 Z"/>
        <circle cx="47" cy="44" r="9"/>
        <circle cx="61" cy="46" r="9"/>
        <circle cx="74" cy="50" r="9"/>
        <path d="M20 13 Q20 3 29 3 Q38 3 38 13 L38 54 Q38 60 29 60 Q20 60 20 54 Z"/>
        <path d="M44 66 L66 64 M44 73 L66 71" fill="none" stroke-width="3"/>
        <path d="M34 82 L80 79 Q87 79 87 85 L87 92 Q87 98 81 98 L36 99 Q30 99 30 93 L30 88 Q30 82 34 82 Z"/>
        <path d="M31 90 L86 87" fill="none" stroke-width="3"/>
      </g></svg>`,
  },
};

const cursorImageCache = new Map(); // key -> HTMLImageElement (loaded)

function svgToDataUrl(svg) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// Loads an image once; returns it when ready, null while loading
function getCursorImage(key, src) {
  const cached = cursorImageCache.get(key);
  if (cached) return cached.complete && cached.naturalWidth ? cached : null;
  const img = new Image();
  img.onload = () => rerender();
  img.onerror = () => console.warn('[MCR] Cursor image failed to load');
  img.src = src;
  cursorImageCache.set(key, img);
  return null;
}

function currentCursorArt() {
  const fx = cursorFx;
  if (fx.cursor === 'arrow' || fx.cursor === 'hand') {
    const art = BUILTIN_CURSORS[fx.cursor];
    const color = fx.cursor === 'arrow' ? fx.cursorColor : '';
    return {
      img: getCursorImage(`${fx.cursor}|${color}`, svgToDataUrl(art.svg(color))),
      hotspot: art.hotspot,
    };
  }
  if (fx.cursor === 'custom' && fx.customImage) {
    const src = fx.customImage.trim().startsWith('<') ? svgToDataUrl(fx.customImage) : fx.customImage;
    return { img: getCursorImage(`custom|${src.length}|${src.slice(-64)}`, src), hotspot: [fx.hotspotX, fx.hotspotY] };
  }
  return null;
}

// --- Validation (shared by the UI and the Claude bridge) ---

function normalizeCursorFx(patch) {
  const fx = { ...cursorFx, ...stripUndefined(patch) };
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  if (!CURSOR_STYLES.includes(fx.cursor)) throw new Error(`cursor must be one of ${CURSOR_STYLES.join(', ')}`);
  if (!CLICK_EFFECTS.includes(fx.clickEffect)) throw new Error(`click_effect must be one of ${CLICK_EFFECTS.join(', ')}`);
  if (!isColor(fx.cursorColor)) throw new Error(`Invalid cursor_color: ${JSON.stringify(fx.cursorColor)}`);
  if (!isColor(fx.effectColor)) throw new Error(`Invalid effect_color: ${JSON.stringify(fx.effectColor)}`);
  if (fx.customImage != null) {
    const s = String(fx.customImage).trim();
    const ok = /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(s) || (/^<svg[\s>]/i.test(s) && s.length < 200_000);
    if (!ok) throw new Error('custom image must be SVG markup (<svg …>) or a data:image/… URL');
    fx.customImage = s;
  }
  if (fx.cursor === 'custom' && !fx.customImage) throw new Error('cursor "custom" needs a custom image');
  fx.cursorSize = num(fx.cursorSize, 8, 300, CURSOR_DEFAULTS.cursorSize);
  fx.effectSize = num(fx.effectSize, 10, 400, CURSOR_DEFAULTS.effectSize);
  fx.hotspotX = num(fx.hotspotX, 0, 1, 0);
  fx.hotspotY = num(fx.hotspotY, 0, 1, 0);
  fx.pressAnimation = !!fx.pressAnimation;
  return fx;
}

function setCursorFx(patch) {
  const next = normalizeCursorFx(patch);
  pushHistory();
  cursorFx = next;
  projectChanged();
  return cursorFx;
}

// --- Position over time ---
// Cursor samples arrive ~20 Hz; averaging a short window removes jitter.
// Without samples (old recordings) the cursor glides between clicks.

function cursorPosAt(tMs) {
  if (moves.length) {
    let x = 0, y = 0;
    const OFFS = [-80, -40, 0, 40, 80];
    for (const o of OFFS) { const p = cursorAt(tMs + o); x += p.nx; y += p.ny; }
    return { nx: x / OFFS.length, ny: y / OFFS.length };
  }
  const pts = clicks.filter(c => c.kind === 'click').sort((a, b) => a.t - b.t);
  if (!pts.length) return null;
  if (tMs <= pts[0].t) return { nx: pts[0].nx, ny: pts[0].ny };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (tMs <= b.t) {
      const k = easings.inOut(Math.min(1, Math.max(0, (tMs - a.t) / Math.min(800, b.t - a.t || 1))));
      return { nx: a.nx + (b.nx - a.nx) * k, ny: a.ny + (b.ny - a.ny) * k };
    }
  }
  const last = pts[pts.length - 1];
  return { nx: last.nx, ny: last.ny };
}

// --- Rendering (video space: follows zoom and pan) ---

const EFFECT_MS = 550;
const PRESS_MS = 180;

function drawCursorLayer(c, tMs, view) {
  const u = view.vh / 1080 * view.s; // design px → canvas px, scaled with the zoom
  const toCanvas = (nx, ny) => [view.tx + nx * view.vw * view.s, view.ty + ny * view.vh * view.s];

  // Click effects first, so the cursor sits on top of them
  if (cursorFx.clickEffect !== 'none') {
    for (const ck of clicks) {
      if (ck.kind !== 'click' || ck.effect === false) continue;
      const dt = tMs - ck.t;
      if (dt < 0 || dt > EFFECT_MS) continue;
      const [x, y] = toCanvas(ck.nx, ck.ny);
      drawClickEffect(c, cursorFx.clickEffect, x, y, dt / EFFECT_MS, cursorFx.effectSize * u, cursorFx.effectColor);
    }
  }

  if (cursorFx.cursor === 'none') return;
  const pos = cursorPosAt(tMs);
  if (!pos) return;
  const [x, y] = toCanvas(pos.nx, pos.ny);

  // Squash on press
  let press = 1;
  if (cursorFx.pressAnimation) {
    for (const ck of clicks) {
      const dt = tMs - ck.t;
      if (ck.kind === 'click' && dt >= 0 && dt < PRESS_MS) press = Math.min(press, 0.82 + 0.18 * Math.abs(dt / PRESS_MS * 2 - 1));
    }
  }
  const size = cursorFx.cursorSize * u * press;

  c.save();
  if (cursorFx.cursor === 'dot') {
    c.shadowColor = 'rgba(0,0,0,0.35)';
    c.shadowBlur = size * 0.3;
    c.fillStyle = cursorFx.cursorColor;
    c.globalAlpha = 0.85;
    c.beginPath();
    c.arc(x, y, size * 0.32, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 1;
    c.lineWidth = Math.max(1.5, size * 0.06);
    c.strokeStyle = '#fff';
    c.stroke();
  } else {
    const art = currentCursorArt();
    if (art && art.img) {
      const ar = art.img.naturalHeight / art.img.naturalWidth || 1;
      const w = size, h = size * ar;
      c.shadowColor = 'rgba(0,0,0,0.3)';
      c.shadowBlur = size * 0.15;
      c.shadowOffsetY = size * 0.05;
      c.drawImage(art.img, x - art.hotspot[0] * w, y - art.hotspot[1] * h, w, h);
    }
  }
  c.restore();
}

function drawClickEffect(c, kind, x, y, p, size, color) {
  const ease = 1 - Math.pow(1 - p, 3);
  c.save();
  c.strokeStyle = color;
  c.fillStyle = color;
  if (kind === 'ripple') {
    const r = size * 0.5 * (0.2 + 0.8 * ease);
    c.globalAlpha = 0.35 * (1 - p);
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    c.globalAlpha = 0.9 * (1 - p);
    c.lineWidth = Math.max(1.5, size * 0.04);
    c.stroke();
  } else if (kind === 'pulse') {
    c.lineWidth = Math.max(1.5, size * 0.035);
    for (const lag of [0, 0.25]) {
      const q = Math.max(0, (p - lag) / (1 - lag));
      if (q <= 0) continue;
      c.globalAlpha = 0.9 * (1 - q);
      c.beginPath(); c.arc(x, y, size * 0.55 * (1 - Math.pow(1 - q, 3)), 0, Math.PI * 2); c.stroke();
    }
  } else if (kind === 'burst') {
    c.lineCap = 'round';
    c.lineWidth = Math.max(2, size * 0.05);
    c.globalAlpha = 1 - p;
    const r0 = size * (0.18 + 0.25 * ease), r1 = size * (0.3 + 0.32 * ease);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
      c.beginPath();
      c.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
      c.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
      c.stroke();
    }
  }
  c.restore();
}

// --- Cursor panel ---

const CURSOR_LABELS = { none: 'None', arrow: 'Arrow', hand: 'Glove', dot: 'Dot', custom: 'Custom' };
const EFFECT_LABELS = { none: 'None', ripple: 'Ripple', pulse: 'Pulse', burst: 'Burst' };
const EFFECT_SWATCHES = ['#e03c3c', '#f59e0b', '#facc15', '#10b981', '#3b82f6', '#a855f7', '#ffffff', '#111114'];

function setupCursorPanel() {
  const fileInput = document.getElementById('cursorUpload');
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > 2_000_000) { alert('Image too large (max 2 MB)'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try { setCursorFx({ cursor: 'custom', customImage: reader.result, hotspotX: 0, hotspotY: 0 }); }
      catch (err) { alert(err.message); }
    };
    reader.readAsDataURL(file);
  });
}

function renderCursorPanel() {
  const el = document.getElementById('cursorPanel');
  const fx = cursorFx;
  const chip = (cls, v, label, on) => `<button class="chip ${cls} ${on ? 'active' : ''}" data-v="${v}">${label}</button>`;
  const clickCount = clicks.filter(c => c.kind === 'click').length;
  const shown = clicks.filter(c => c.kind === 'click' && c.effect !== false).length;

  el.innerHTML = `
    <div class="field-label">Cursor</div>
    <div class="chips">${CURSOR_STYLES.map(s => chip('cx-style', s, CURSOR_LABELS[s], s === fx.cursor)).join('')}</div>
    <div class="chips">
      <button class="chip cx-upload">⬆ Upload image…</button>
      ${fx.customImage ? '<button class="chip cx-clear">Remove custom</button>' : ''}
    </div>
    ${fx.cursor !== 'none' ? `
    <div class="click-setting-row">
      <label>Size</label>
      <input type="range" class="cx-size" min="16" max="140" step="1" value="${fx.cursorSize}">
      <span class="val">${Math.round(fx.cursorSize)}px</span>
    </div>
    <label class="switch-row">
      <span>Press animation</span>
      <span class="switch"><input type="checkbox" class="cx-press" ${fx.pressAnimation ? 'checked' : ''}><span></span></span>
    </label>` : ''}

    <div class="field-label">Click effect</div>
    <div class="chips">${CLICK_EFFECTS.map(s => chip('cx-effect', s, EFFECT_LABELS[s], s === fx.clickEffect)).join('')}</div>
    ${fx.clickEffect !== 'none' ? `
    <div class="swatches">
      ${EFFECT_SWATCHES.map(col => `<button class="swatch cx-color ${col.toLowerCase() === fx.effectColor.toLowerCase() ? 'active' : ''}" data-v="${col}" style="background:${col}"></button>`).join('')}
      <label class="swatch custom" title="Custom colour"><input type="color" class="cx-color-custom" value="${/^#[0-9a-f]{6}$/i.test(fx.effectColor) ? fx.effectColor : '#e03c3c'}"></label>
    </div>
    <div class="click-setting-row">
      <label>Size</label>
      <input type="range" class="cx-esize" min="20" max="220" step="2" value="${fx.effectSize}">
      <span class="val">${Math.round(fx.effectSize)}px</span>
    </div>
    <div class="text-hint">Shown on ${shown} of ${clickCount} clicks — switch it per click in the Zooms tab.</div>` : ''}
  `;

  const $ = s => el.querySelector(s);
  const $$ = s => el.querySelectorAll(s);
  const safe = patch => { try { setCursorFx(patch); } catch (err) { alert(err.message); } };

  $$('.cx-style').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.v === 'custom' && !cursorFx.customImage) { document.getElementById('cursorUpload').click(); return; }
    safe({ cursor: b.dataset.v });
  }));
  $('.cx-upload').addEventListener('click', () => document.getElementById('cursorUpload').click());
  $('.cx-clear')?.addEventListener('click', () => safe({ customImage: null, cursor: cursorFx.cursor === 'custom' ? 'arrow' : cursorFx.cursor }));
  $$('.cx-effect').forEach(b => b.addEventListener('click', () => safe({ clickEffect: b.dataset.v })));
  $$('.cx-color').forEach(b => b.addEventListener('click', () => safe({ effectColor: b.dataset.v })));
  $('.cx-color-custom')?.addEventListener('change', e => safe({ effectColor: e.target.value }));
  $('.cx-press')?.addEventListener('change', e => safe({ pressAnimation: e.target.checked }));

  // Sliders: live while dragging, one undo step per drag
  const liveSlider = (sel, key) => {
    const s = $(sel);
    if (!s) return;
    s.addEventListener('pointerdown', pushHistory);
    s.addEventListener('input', () => {
      cursorFx[key] = Number(s.value);
      s.nextElementSibling.textContent = s.value + 'px';
      rerender();
    });
    s.addEventListener('change', saveProject);
  };
  liveSlider('.cx-size', 'cursorSize');
  liveSlider('.cx-esize', 'effectSize');
}
