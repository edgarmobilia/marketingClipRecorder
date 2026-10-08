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

// Each style has one job. Sizes are a fraction of the output height.
const TEXT_STYLES = {
  title:         { label: 'Title',       font: 0.054, maxWidth: 0.62, desc: 'Opening / closing statement on a solid dark card, left-aligned text; x,y = box centre' },
  caption:       { label: 'Caption',     font: 0.030, maxWidth: 0.62, desc: 'One-line subtitle or step description on a dark card; x,y = box centre' },
  'lower-third': { label: 'Lower third', font: 0.032, maxWidth: 0.42, desc: 'Light card with a thin accent bar, for a step name or label; x,y = left edge, vertical centre' },
  callout:       { label: 'Callout',     font: 0.026, maxWidth: 0.32, desc: 'Small accent tag whose pointer touches x,y (box placed above, or below near the top edge)' },
  highlight:     { label: 'Highlight',   font: 0.024, maxWidth: 0.32, desc: 'Thin accent outline around a w×h box centred on x,y, optional small label above it' },
  text:          { label: 'Plain text',  font: 0.056, maxWidth: 0.7,  desc: 'Text with no box; ink turns near-black or white to read on what is behind it; x,y = text centre' },
};

const TEXT_ANIMATIONS = ['fade', 'slide-up', 'pop', 'typewriter', 'none'];
const SHADOW_PRESETS = ['none', 'soft', 'strong', 'glow'];

// Calm product blue, used sparingly (callout tag, highlight ring, lower-third bar)
const DEFAULT_ACCENT = '#3e63dd';
const LEGACY_ACCENT = '#e03c3c'; // the default before; v1 migration compares against it
const FONT_STACK = 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif';

// Lengths are pixels at 1080p output height; they scale with the video.
// 'accent' as a colour value means "use the overlay's accent".
// *Em keys are internal defaults relative to the font size (not part of the
// API); the matching API fields (radius, padding_x/y, letter_spacing) override them.
// Look: flat opaque fills, medium weights, slightly tight tracking, moderate
// radii, generous padding, a shadow only where a card must lift off the page.
const STYLE_DESIGN = {
  title:         { background: '#111113', textColor: '#ffffff', fontWeight: 600, radiusEm: 0.26, align: 'left',   shadow: 'soft',
                   lineHeight: 1.14, trackingEm: -0.022, padXEm: 0.75, padYEm: 0.55 },
  caption:       { background: '#111113', textColor: '#f4f4f5', fontWeight: 500, radiusEm: 0.34, align: 'center', shadow: 'none',
                   lineHeight: 1.35, trackingEm: -0.006, padXEm: 0.8,  padYEm: 0.5 },
  'lower-third': { background: '#ffffff', textColor: '#111113', fontWeight: 600, radiusEm: 0.3,  align: 'left',   shadow: 'soft',
                   lineHeight: 1.3,  trackingEm: -0.012, padXEm: 0.8,  padYEm: 0.55, bar: true,
                   borderColor: 'rgba(17,17,19,0.10)', borderWidth: 1 },
  callout:       { background: 'accent',  textColor: '#ffffff', fontWeight: 600, radiusEm: 0.3,  align: 'left',   shadow: 'soft',
                   lineHeight: 1.3,  trackingEm: -0.006, padXEm: 0.65, padYEm: 0.42 },
  highlight:     { background: 'accent',  textColor: '#ffffff', fontWeight: 600, radiusEm: 0.3,  align: 'left',   shadow: 'none',
                   lineHeight: 1.3,  trackingEm: -0.004, padXEm: 0.6,  padYEm: 0.38 },
  text:          { background: 'transparent', textColor: 'auto', fontWeight: 600, radiusEm: 0, align: 'center', shadow: 'strong',
                   lineHeight: 1.15, trackingEm: -0.022, padXEm: 0.15, padYEm: 0.15 },
};

// Overridable design keys → validator. null in an update removes the override.
const DESIGN_KEYS = {
  background:      v => v === 'transparent' || isColor(v),
  gradient:        v => Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every(isColor),
  gradientAngle:   v => Number.isFinite(v),
  textColor:       v => v === 'auto' || isColor(v), // auto: dark or white, whichever reads on the background
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
    animation: style === 'callout' || style === 'highlight' || style === 'text' ? 'fade' : 'slide-up',
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
    if (o.style === 'title' && o.accent && o.accent.toLowerCase() !== LEGACY_ACCENT) {
      Object.assign(o.design, { background: o.accent, borderColor: '#000000', borderWidth: 6, textColor: '#0b0b0f' });
      o.accent = LEGACY_ACCENT;
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

// The default face, loaded so every machine (and every export) sets the same type
for (const w of [500, 600]) ensureFont('Inter', w);

// --- Animation ---

// Short entrances; exits a touch quicker so the next beat isn't delayed
function overlayProgress(o, tMs) {
  const span = o.end - o.start;
  const inDur = Math.min(280, span / 3);
  const outDur = Math.min(200, span / 3);
  const kIn = Math.min(1, Math.max(0, (tMs - o.start) / inDur));
  const kOut = Math.min(1, Math.max(0, (o.end - tMs) / outDur));
  return { k: easeOutCubic(Math.min(kIn, kOut)), kIn, elapsed: tMs - o.start };
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

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
    soft:   { color: 'rgba(0,0,0,0.16)', blur: 0.5, y: 0.1 },
    strong: { color: 'rgba(0,0,0,0.45)', blur: 0.8, y: 0.12 },
    glow:   { color: accent,             blur: 0.8, y: 0 },
  }[preset];
  const k = onText ? (preset === 'glow' ? 0.5 : 0.35) : 1;
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
  c.letterSpacing = `${d.letterSpacing !== undefined ? d.letterSpacing * u : fontPx * (d.trackingEm || 0)}px`;
  c.textBaseline = 'middle';

  const lines = text ? wrapLines(c, text, W * (d.maxWidth ?? st.maxWidth)) : [];
  const lineH = fontPx * (d.lineHeight || 1.25);
  const padX = d.paddingX !== undefined ? d.paddingX * u : fontPx * (d.padXEm ?? 0.7);
  const padY = d.paddingY !== undefined ? d.paddingY * u : fontPx * (d.padYEm ?? 0.45);
  const barW = d.bar ? Math.max(3 * u, fontPx * 0.14) : 0;
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

  // Keep the box on screen, clear of the frame edge
  const m = Math.max(fontPx * 0.4, H * 0.03);
  bx = Math.min(W - boxW - m, Math.max(m, bx));
  by = Math.min(H - boxH - m, Math.max(m, by));
  const cx = bx + boxW / 2, cy = by + boxH / 2;

  // 'auto' ink reads what is already drawn under the text (before any motion)
  let ink = d.textColor || '#fff';
  const fill = boxFill(c, d, bx, by, boxW, boxH);
  let shadowOnText = !fill;
  if (ink === 'auto') {
    const light = backgroundIsLight(c, o, tMs, bx, by, boxW, boxH);
    ink = light ? '#111113' : '#ffffff';
    if (light) shadowOnText = false; // dark ink on a light page needs no shadow
  }

  // Entrance motion: a few pixels, no overshoot. Then the static rotation
  if (o.animation === 'slide-up') {
    c.translate(0, (1 - k) * H * 0.014);
  } else if (o.animation === 'pop') {
    const s = 0.96 + 0.04 * k;
    c.translate(cx, cy); c.scale(s, s); c.translate(-cx, -cy);
  }
  if (d.rotation) {
    c.translate(cx, cy); c.rotate(d.rotation * Math.PI / 180); c.translate(-cx, -cy);
  }

  // Box: fill, border, accent bar, pointer
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
  if (shadowOnText) applyShadow(c, d, fontPx, o.accent, true);
  c.fillStyle = ink;
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

// Average luminance of the canvas under a box, sampled a few times a second per
// overlay (with hysteresis so the ink does not flicker on mid-grey backgrounds)
const inkProbe = document.createElement('canvas');
inkProbe.width = 16;
inkProbe.height = 4;
const inkProbeCtx = inkProbe.getContext('2d', { willReadFrequently: true });
const inkCache = new Map(); // overlay id -> { t, light }

function backgroundIsLight(c, o, tMs, x, y, w, h) {
  const hit = inkCache.get(o.id);
  if (hit && Math.abs(hit.t - tMs) < 250) return hit.light;
  let light = hit ? hit.light : false;
  try {
    inkProbeCtx.clearRect(0, 0, inkProbe.width, inkProbe.height);
    inkProbeCtx.drawImage(c.canvas, x, y, Math.max(1, w), Math.max(1, h), 0, 0, inkProbe.width, inkProbe.height);
    const px = inkProbeCtx.getImageData(0, 0, inkProbe.width, inkProbe.height).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    const lum = sum / (px.length / 4) / 255;
    light = light ? lum > 0.45 : lum > 0.6;
  } catch { /* nothing drawn yet: keep the previous answer */ }
  inkCache.set(o.id, { t: tMs, light });
  return light;
}

function drawPointer(c, bx, by, boxW, boxH, px, py, fontPx) {
  const below = by > py; // box sits under the point
  const baseY = below ? by : by + boxH;
  const half = fontPx * 0.36;
  const baseX = Math.min(bx + boxW - half * 2, Math.max(bx + half * 2, px));
  c.beginPath();
  c.moveTo(baseX - half, baseY);
  c.lineTo(baseX + half, baseY);
  c.lineTo(px, py + (below ? half * 0.6 : -half * 0.6));
  c.closePath();
  c.fill();
  // Target dot
  c.beginPath();
  c.arc(px, py, fontPx * 0.16, 0, Math.PI * 2);
  c.fill();
}

function drawHighlightRing(c, o, view, px, py, zoomK, k) {
  const w = o.w * view.W * zoomK, h = o.h * view.H * zoomK;
  const pad = view.H * 0.006 * zoomK;
  c.save();
  // Crisp ring plus a faint wide halo of the same colour: reads on light and dark UI
  c.strokeStyle = o.accent;
  const g = 0.97 + 0.03 * k; // settles in from 97 % size
  const rx = px - (w / 2 + pad) * g, ry = py - (h / 2 + pad) * g;
  const rw = (w + pad * 2) * g, rh = (h + pad * 2) * g, rr = view.H * 0.008;
  const alpha = c.globalAlpha;
  c.globalAlpha = alpha * 0.18;
  c.lineWidth = Math.max(4, view.H * 0.008);
  roundRect(c, rx, ry, rw, rh, rr);
  c.stroke();
  c.globalAlpha = alpha;
  c.lineWidth = Math.max(2, view.H * 0.0034);
  roundRect(c, rx, ry, rw, rh, rr);
  c.stroke();
  c.restore();
}
