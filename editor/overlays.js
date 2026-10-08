'use strict';

// --- Floating text overlays ---
// Each overlay: {
//   id, text, start, end,          // ms on the video timeline
//   style,                          // key of TEXT_STYLES — a preset of layout + default design
//   x, y,                           // 0–1 anchor point (meaning depends on style, see TEXT_STYLES)
//   w, h,                           // 0–1 box size, only used by 'highlight'
//   anchor,                         // 'screen' = fixed on the frame, 'video' = stuck to the page (moves with zoom)
//   animation,                      // key of TEXT_ANIMATIONS
//   size,                           // font size multiplier on top of everything else (1 = as designed)
//   accent,                         // colour of callout bubble / lower-third bar / highlight ring
//   design: { … },                  // optional overrides of the style's look, see DESIGN_KEYS
// }
//
// Every visual property lives in `design`, so any look (colours, borders,
// fonts, gradients, shadows…) is data — never a code change.

const TEXT_STYLES = {
  title:         { label: 'Title',       font: 0.065, maxWidth: 0.8,  desc: 'Big centred heading; x,y = box centre' },
  caption:       { label: 'Caption',     font: 0.036, maxWidth: 0.75, desc: 'Subtitle pill; x,y = box centre' },
  'lower-third': { label: 'Lower third', font: 0.040, maxWidth: 0.5,  desc: 'Card with accent bar on the left; x,y = left edge, vertical centre' },
  callout:       { label: 'Callout',     font: 0.032, maxWidth: 0.4,  desc: 'Bubble whose pointer touches x,y (box placed above, or below near the top edge)' },
  highlight:     { label: 'Highlight',   font: 0.028, maxWidth: 0.4,  desc: 'Glowing outline around a w×h box centred on x,y, optional label above it' },
  text:          { label: 'Plain text',  font: 0.066, maxWidth: 0.85, desc: 'Text with no box (shadow for legibility); x,y = text centre' },
};

const TEXT_ANIMATIONS = ['fade', 'slide-up', 'pop', 'typewriter', 'none'];
const SHADOW_PRESETS = ['none', 'soft', 'strong', 'glow'];

const DEFAULT_ACCENT = '#e03c3c';
const FONT_STACK = 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif';

// Lengths are pixels at 1080p output height; they scale with the video.
// 'accent' as a colour value means "use the overlay's accent".
const STYLE_DESIGN = {
  title:         { background: 'rgba(17,17,20,0.85)', textColor: '#ffffff', fontWeight: 800, radiusEm: 0.4,  align: 'center', shadow: 'soft' },
  caption:       { background: 'rgba(0,0,0,0.72)',    textColor: '#ffffff', fontWeight: 600, radius: 'pill', align: 'center', shadow: 'soft' },
  'lower-third': { background: '#ffffff',             textColor: '#15151a', fontWeight: 700, radiusEm: 0.25, align: 'left',   shadow: 'soft', bar: true },
  callout:       { background: 'accent',              textColor: '#ffffff', fontWeight: 700, radiusEm: 0.45, align: 'center', shadow: 'soft' },
  highlight:     { background: 'accent',              textColor: '#ffffff', fontWeight: 700, radiusEm: 0.45, align: 'center', shadow: 'soft' },
  text:          { background: 'transparent',         textColor: '#ffffff', fontWeight: 800, radiusEm: 0,    align: 'center', shadow: 'strong', paddingEm: 0.15 },
};

// Overridable design keys → validator. null in an update removes the override.
const DESIGN_KEYS = {
  background:      v => v === 'transparent' || isColor(v),
  gradient:        v => Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every(isColor),
  gradientAngle:   v => Number.isFinite(v),
  textColor:       isColor,
  borderColor:     isColor,
  borderWidth:     v => Number.isFinite(v) && v >= 0 && v <= 60,
  radius:          v => v === 'pill' || (Number.isFinite(v) && v >= 0 && v <= 400),
  paddingX:        v => Number.isFinite(v) && v >= 0 && v <= 400,
  paddingY:        v => Number.isFinite(v) && v >= 0 && v <= 400,
  fontFamily:      v => typeof v === 'string' && /^[\w \-]{1,60}$/.test(v),
  fontWeight:      v => Number.isFinite(v) && v >= 100 && v <= 900,
  fontSize:        v => Number.isFinite(v) && v >= 8 && v <= 400,
  italic:          v => typeof v === 'boolean',
  uppercase:       v => typeof v === 'boolean',
  letterSpacing:   v => Number.isFinite(v) && v >= -20 && v <= 60,
  lineHeight:      v => Number.isFinite(v) && v >= 0.8 && v <= 3,
  align:           v => ['left', 'center', 'right'].includes(v),
  maxWidth:        v => Number.isFinite(v) && v >= 0.05 && v <= 1,
  shadow:          v => SHADOW_PRESETS.includes(v),
  shadowColor:     isColor,
  opacity:         v => Number.isFinite(v) && v >= 0 && v <= 1,
  rotation:        v => Number.isFinite(v) && v >= -180 && v <= 180,
  textStrokeColor: isColor,
  textStrokeWidth: v => Number.isFinite(v) && v >= 0 && v <= 40,
  bar:             v => typeof v === 'boolean',   // lower-third style accent bar on the left
};

let overlays = [];
let nextOverlayId = 1;

// --- Colour validation (anything the canvas understands: #hex, rgb(), hsl(), names) ---

const colorProbe = document.createElement('canvas').getContext('2d');
function isColor(v) {
  if (typeof v !== 'string' || !v || v.length > 60) return false;
  colorProbe.fillStyle = '#010203';
  colorProbe.fillStyle = v;
  if (colorProbe.fillStyle !== '#010203') return true;
  colorProbe.fillStyle = '#040506';
  colorProbe.fillStyle = v;
  return colorProbe.fillStyle !== '#040506';
}

// --- Model ---

function createOverlay(params = {}) {
  const style = TEXT_STYLES[params.style] ? params.style : 'caption';
  const o = {
    id: `t${nextOverlayId++}`,
    text: 'New text',
    start: 0,
    end: 2500,
    style,
    x: style === 'lower-third' ? 0.06 : 0.5,
    y: style === 'title' || style === 'text' ? 0.45 : style === 'lower-third' ? 0.82 : 0.88,
    w: 0.15,
    h: 0.08,
    anchor: style === 'callout' || style === 'highlight' ? 'video' : 'screen',
    animation: style === 'title' || style === 'highlight' || style === 'text' ? 'pop' : 'slide-up',
    size: 1,
    accent: DEFAULT_ACCENT,
    design: {},
    v: 2,
  };
  return normalizeOverlay(Object.assign(o, stripUndefined(params), { id: o.id, style, v: 2 }));
}

function normalizeOverlay(o) {
  const clamp01 = v => Math.min(1, Math.max(0, Number(v) || 0));

  // v1 projects encoded a coloured title card as "title with a non-default accent"
  if (!o.v) {
    o.design = o.design || {};
    if (o.style === 'title' && o.accent && o.accent.toLowerCase() !== DEFAULT_ACCENT) {
      Object.assign(o.design, { background: o.accent, borderColor: '#000000', borderWidth: 6, textColor: '#0b0b0f' });
      o.accent = DEFAULT_ACCENT;
    }
    o.v = 2;
  }

  o.text = String(o.text ?? '');
  o.start = Math.max(0, Math.round(Number(o.start) || 0));
  o.end = Math.max(o.start + 100, Math.round(Number(o.end) || 0));
  if (!TEXT_STYLES[o.style]) o.style = 'caption';
  if (!TEXT_ANIMATIONS.includes(o.animation)) o.animation = 'fade';
  if (o.anchor !== 'video') o.anchor = 'screen';
  o.x = clamp01(o.x); o.y = clamp01(o.y);
  o.w = clamp01(o.w); o.h = clamp01(o.h);
  o.size = Math.min(4, Math.max(0.3, Number(o.size) || 1));
  o.accent = isColor(o.accent) ? o.accent : DEFAULT_ACCENT;
  o.design = normalizeDesign(o.design);
  if (o.design.fontFamily) ensureFont(o.design.fontFamily, o.design.fontWeight, o.design.italic);
  return o;
}

function normalizeDesign(d) {
  const out = {};
  for (const [k, valid] of Object.entries(DESIGN_KEYS)) {
    if (d && d[k] !== undefined && d[k] !== null && valid(d[k])) out[k] = d[k];
  }
  return out;
}

// Merge a design patch; null values drop the override (back to the style default)
function mergeDesign(current, patch) {
  const merged = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  return normalizeDesign(merged);
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// Effective look of an overlay: style defaults + its overrides
function resolveDesign(o) {
  const d = { ...STYLE_DESIGN[o.style], ...o.design };
  const accentify = v => (v === 'accent' ? o.accent : v);
  d.background = accentify(d.background);
  return d;
}

// --- Web fonts ---
// Any Google Fonts family works by name; it is fetched on first use and the
// frame re-renders once it arrives. Unknown names fall back to the system stack.

const fontLoads = new Map(); // "family|weight|italic" -> Promise

function ensureFont(family, weight = 700, italic = false) {
  if (!family) return Promise.resolve();
  const key = `${family}|${weight}|${italic}`;
  if (fontLoads.has(key)) return fontLoads.get(key);
  const p = loadGoogleFont(family, weight, italic)
    .then(() => { if (typeof rerender === 'function') rerender(); })
    .catch(err => console.warn(`[MCR] Font "${family}" not loaded:`, err.message));
  fontLoads.set(key, p);
  return p;
}

async function loadGoogleFont(family, weight, italic) {
  const fam = encodeURIComponent(family).replace(/%20/g, '+');
  const url = `https://fonts.googleapis.com/css2?family=${fam}:ital,wght@${italic ? 1 : 0},${weight || 400}&display=swap`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Fonts HTTP ${res.status}`);
  const css = await res.text();
  const faces = [];
  for (const block of css.match(/@font-face\s*{[^}]+}/g) || []) {
    const src = block.match(/url\(([^)]+)\)/)?.[1];
    if (!src) continue;
    const range = block.match(/unicode-range:\s*([^;]+);/)?.[1];
    const face = new FontFace(family, `url(${src})`, {
      weight: String(weight || 400),
      style: italic ? 'italic' : 'normal',
      ...(range && { unicodeRange: range }),
    });
    document.fonts.add(face);
    faces.push(face.load());
  }
  if (!faces.length) throw new Error('family not found');
  await Promise.all(faces);
}

// Resolves when every font requested so far has loaded (or failed)
function fontsReady() {
  return Promise.all(fontLoads.values());
}

// --- Animation ---

function overlayProgress(o, tMs) {
  const span = o.end - o.start;
  const inDur = Math.min(350, span / 3);
  const kIn = Math.min(1, Math.max(0, (tMs - o.start) / inDur));
  const kOut = Math.min(1, Math.max(0, (o.end - tMs) / inDur));
  return { k: easeOutCubic(Math.min(kIn, kOut)), kIn, elapsed: tMs - o.start };
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeOutBack(t) { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }

// --- Text layout ---

function wrapLines(c, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (line && c.measureText(test).width > maxW) { out.push(line); line = w; }
      else line = test;
    }
    out.push(line);
  }
  return out;
}

function roundRect(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// onText: the shadow sits directly on the letters (no box), so keep it tight
function applyShadow(c, d, fontPx, accent, onText = false) {
  const preset = d.shadow || 'none';
  if (preset === 'none') { c.shadowColor = 'transparent'; return; }
  const P = {
    soft:   { color: 'rgba(0,0,0,0.35)', blur: 0.6, y: 0.12 },
    strong: { color: 'rgba(0,0,0,0.65)', blur: 0.9, y: 0.18 },
    glow:   { color: accent,             blur: 1.0, y: 0 },
  }[preset];
  const k = onText ? (preset === 'glow' ? 0.5 : 0.25) : 1;
  c.shadowColor = d.shadowColor || P.color;
  c.shadowBlur = fontPx * P.blur * k;
  c.shadowOffsetX = 0;
  c.shadowOffsetY = fontPx * P.y * k;
}

function boxFill(c, d, bx, by, boxW, boxH) {
  if (d.gradient) {
    const a = ((d.gradientAngle ?? 90) - 90) * Math.PI / 180; // 90° = left → right, like CSS
    const cx = bx + boxW / 2, cy = by + boxH / 2;
    const r = (Math.abs(boxW * Math.cos(a)) + Math.abs(boxH * Math.sin(a))) / 2;
    const g = c.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    d.gradient.forEach((col, i) => g.addColorStop(i / (d.gradient.length - 1), col));
    return g;
  }
  return d.background === 'transparent' ? null : d.background;
}

// --- Rendering ---
// view = { W, H, s, tx, ty }: the camera transform used for the video, so
// 'video'-anchored overlays stay glued to the page while zooming.

function toCanvasPoint(o, view) {
  if (o.anchor === 'video') {
    return { px: view.tx + o.x * view.W * view.s, py: view.ty + o.y * view.H * view.s, k: view.s };
  }
  return { px: o.x * view.W, py: o.y * view.H, k: 1 };
}

function drawOverlays(c, tMs, view) {
  for (const o of overlays) {
    if (tMs < o.start || tMs > o.end) continue;
    drawOverlay(c, o, tMs, view);
  }
}

function drawOverlay(c, o, tMs, view) {
  const { W, H } = view;
  const st = TEXT_STYLES[o.style];
  const d = resolveDesign(o);
  const u = H / 1080; // design px → canvas px
  const { k, kIn, elapsed } = overlayProgress(o, tMs);
  if (k <= 0) return;

  const fontPx = (d.fontSize ? d.fontSize * u : H * st.font) * o.size;
  const { px, py, k: zoomK } = toCanvasPoint(o, view);

  // Typewriter reveals characters during the intro instead of fading
  let text = d.uppercase ? o.text.toUpperCase() : o.text;
  if (o.animation === 'typewriter') {
    // ~35 ms per character, but always finished by the first half of the span
    const dur = Math.min(Math.max(400, text.length * 35), (o.end - o.start) * 0.5);
    text = text.slice(0, Math.ceil(text.length * Math.min(1, elapsed / dur)));
  }

  c.save();
  const animAlpha = o.animation === 'none' ? 1 : (o.animation === 'typewriter' ? Math.min(1, k * 3) : k);
  c.globalAlpha = animAlpha * (d.opacity ?? 1);
  const family = d.fontFamily ? `"${d.fontFamily}", ${FONT_STACK}` : FONT_STACK;
  c.font = `${d.italic ? 'italic ' : ''}${d.fontWeight || 700} ${fontPx}px ${family}`;
  c.letterSpacing = `${(d.letterSpacing || 0) * u}px`;
  c.textBaseline = 'middle';

  const lines = text ? wrapLines(c, text, W * (d.maxWidth ?? st.maxWidth)) : [];
  const lineH = fontPx * (d.lineHeight || 1.25);
  const padEm = d.paddingEm ?? null;
  const padX = d.paddingX !== undefined ? d.paddingX * u : fontPx * (padEm ?? 0.7);
  const padY = d.paddingY !== undefined ? d.paddingY * u : fontPx * (padEm ?? 0.45);
  const barW = d.bar ? fontPx * 0.22 : 0;
  const textW = lines.reduce((m, l) => Math.max(m, c.measureText(l).width), 0);
  const boxW = textW + padX * 2 + barW;
  const boxH = lines.length * lineH + padY * 2;

  // Box top-left per style
  let bx, by;
  if (o.style === 'highlight') {
    drawHighlightRing(c, o, view, px, py, zoomK, k);
    if (!lines.length) { c.restore(); return; }
    const ringH = o.h * H * zoomK;
    bx = px - boxW / 2;
    by = py - ringH / 2 - boxH - fontPx * 0.5;
    if (by < fontPx * 0.5) by = py + ringH / 2 + fontPx * 0.5;
  } else if (o.style === 'callout') {
    const gap = fontPx * 1.1;
    bx = px - boxW / 2;
    by = py - gap - boxH;
    if (by < fontPx * 0.5) by = py + gap;
  } else if (o.style === 'lower-third') {
    bx = px;
    by = py - boxH / 2;
  } else {
    bx = px - boxW / 2;
    by = py - boxH / 2;
  }
  if (!lines.length) { c.restore(); return; }

  // Keep the box on screen
  const m = fontPx * 0.4;
  bx = Math.min(W - boxW - m, Math.max(m, bx));
  by = Math.min(H - boxH - m, Math.max(m, by));
  const cx = bx + boxW / 2, cy = by + boxH / 2;

  // Entrance motion, then the static rotation
  if (o.animation === 'slide-up') {
    c.translate(0, (1 - k) * fontPx * 1.2);
  } else if (o.animation === 'pop') {
    const s = 0.8 + 0.2 * easeOutBack(Math.min(kIn, 1));
    c.translate(cx, cy); c.scale(s, s); c.translate(-cx, -cy);
  }
  if (d.rotation) {
    c.translate(cx, cy); c.rotate(d.rotation * Math.PI / 180); c.translate(-cx, -cy);
  }

  // Box: fill, border, accent bar, pointer
  const fill = boxFill(c, d, bx, by, boxW, boxH);
  const radius = d.radius === 'pill' ? boxH / 2
    : d.radius !== undefined ? d.radius * u
    : fontPx * (d.radiusEm ?? 0.4);
  const hasBorder = d.borderWidth > 0 && d.borderColor;

  if (fill) {
    applyShadow(c, d, fontPx, o.accent);
    c.fillStyle = fill;
    roundRect(c, bx, by, boxW, boxH, radius);
    c.fill();
    if (o.style === 'callout') drawPointer(c, bx, by, boxW, boxH, px, py, fontPx);
    c.shadowColor = 'transparent';
  }
  if (d.bar) {
    c.fillStyle = o.accent;
    c.save();
    roundRect(c, bx, by, boxW, boxH, radius);
    c.clip();
    c.fillRect(bx, by, barW, boxH);
    c.restore();
  }
  if (hasBorder) {
    c.strokeStyle = d.borderColor;
    c.lineWidth = d.borderWidth * u;
    c.lineJoin = 'round';
    roundRect(c, bx, by, boxW, boxH, radius);
    c.stroke();
  }

  // Text (gets the shadow itself when there is no box behind it)
  if (!fill) applyShadow(c, d, fontPx, o.accent, true);
  c.fillStyle = d.textColor || '#fff';
  c.textAlign = 'left';
  const innerL = bx + barW + padX, innerR = bx + boxW - padX;
  lines.forEach((line, i) => {
    const lw = c.measureText(line).width;
    const x = d.align === 'left' ? innerL : d.align === 'right' ? innerR - lw : innerL + (innerR - innerL - lw) / 2;
    const y = by + padY + lineH * (i + 0.5);
    if (d.textStrokeWidth > 0 && d.textStrokeColor) {
      c.save();
      c.shadowColor = 'transparent';
      c.strokeStyle = d.textStrokeColor;
      c.lineWidth = d.textStrokeWidth * u * 2; // half is hidden under the fill
      c.lineJoin = 'round';
      c.strokeText(line, x, y);
      c.restore();
    }
    c.fillText(line, x, y);
  });

  c.restore();
}

function drawPointer(c, bx, by, boxW, boxH, px, py, fontPx) {
  const below = by > py; // box sits under the point
  const baseY = below ? by : by + boxH;
  const half = fontPx * 0.45;
  const baseX = Math.min(bx + boxW - half * 2, Math.max(bx + half * 2, px));
  c.beginPath();
  c.moveTo(baseX - half, baseY);
  c.lineTo(baseX + half, baseY);
  c.lineTo(px, py + (below ? half * 0.6 : -half * 0.6));
  c.closePath();
  c.fill();
  // Target dot
  c.beginPath();
  c.arc(px, py, fontPx * 0.22, 0, Math.PI * 2);
  c.fill();
}

function drawHighlightRing(c, o, view, px, py, zoomK, k) {
  const w = o.w * view.W * zoomK, h = o.h * view.H * zoomK;
  const pad = view.H * 0.006 * zoomK;
  c.save();
  c.lineWidth = Math.max(2, view.H * 0.004);
  c.strokeStyle = o.accent;
  c.shadowColor = o.accent;
  c.shadowBlur = view.H * 0.02 * k;
  // Grow in from 85 % size
  const g = 0.85 + 0.15 * k;
  roundRect(c, px - (w / 2 + pad) * g, py - (h / 2 + pad) * g, (w + pad * 2) * g, (h + pad * 2) * g, view.H * 0.01);
  c.stroke();
  c.restore();
}
