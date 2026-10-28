'use strict';

// --- Subtitles ---
// One track of timed cues with a single look, drawn above everything else.
// cue: { id, start, end, text, words? }   ms in SOURCE time, like every other
//   edit, so cuts and speed-ups keep them in sync. words: [{ text, start, end }]
//   from a transcription; used to highlight the word being spoken. When the
//   text no longer matches them, word times are spread over the cue instead.
// Depends on globals from overlays.js, editor.js and segments.js.

const SUBTITLE_PRESETS = {
  clean:  { label: 'Clean',  desc: 'White text with a soft outline, no box — classic subtitles' },
  box:    { label: 'Box',    desc: 'Light text on a translucent dark box — readable on any background' },
  social: { label: 'Social', desc: 'Big bold text, the spoken word highlighted — TikTok / Reels style' },
};

const SUBTITLE_STYLE_DEFAULTS = {
  preset: 'box',
  enabled: true,           // drawn on the preview and burned into the export
  y: null,                 // centre of the block, 0–1 of the frame; null = just above the bottom (or safe zone)
  size: 1,                 // multiplier
  fontFamily: null,        // Google Fonts family; null = default face
  fontWeight: null,        // null = preset default
  textColor: null,
  highlightColor: null,    // spoken word (social preset, or any preset with highlight on)
  background: null,        // box colour (box preset)
  uppercase: false,
  highlight: null,         // null = preset default (social: on)
  maxWidth: null,          // wrap width, fraction of the frame width
};

const PRESET_LOOK = {
  clean:  { font: 0.040, weight: 600, text: '#ffffff', bg: null, stroke: 'rgba(0,0,0,0.85)', strokeEm: 0.16, highlight: false, maxWidth: 0.8, hl: '#ffd84d' },
  box:    { font: 0.036, weight: 500, text: '#f4f4f5', bg: 'rgba(17,17,19,0.78)', stroke: null, strokeEm: 0, highlight: false, maxWidth: 0.76, hl: '#ffd84d' },
  social: { font: 0.058, weight: 800, text: '#ffffff', bg: null, stroke: '#000000', strokeEm: 0.2, highlight: true, maxWidth: 0.82, hl: '#ffd84d' },
};

let subtitles = [];
let subtitleStyle = { ...SUBTITLE_STYLE_DEFAULTS };
let nextSubtitleId = 1;
let selectedSubtitleId = null;

// --- Model ---

function normalizeCue(c) {
  c.start = Math.max(0, Math.round(c.start));
  c.end = Math.max(c.start + 100, Math.round(c.end));
  c.text = String(c.text ?? '').trim();
  if (!Array.isArray(c.words) || !c.words.length) delete c.words;
  return c;
}

function sortSubtitles() {
  subtitles.sort((a, b) => a.start - b.start);
}

function makeCue(p) {
  return normalizeCue({ id: `c${nextSubtitleId++}`, start: p.start, end: p.end, text: p.text, words: p.words });
}

// Replaces the whole track, or only the cues inside [from, to] (ms)
function setSubtitles(cues, { from = null, to = null } = {}) {
  pushHistory();
  if (from === null && to === null) subtitles = [];
  else subtitles = subtitles.filter(c => c.end <= (from ?? -Infinity) || c.start >= (to ?? Infinity));
  for (const p of cues) subtitles.push(makeCue(p));
  sortSubtitles();
  projectChanged();
  return subtitles;
}

function updateSubtitle(id, patch) {
  const c = subtitles.find(s => s.id === id);
  if (!c) throw new Error(`No subtitle with id "${id}"`);
  Object.assign(c, stripUndefined(patch), { id });
  normalizeCue(c);
  return c;
}

function removeSubtitle(id) {
  const i = subtitles.findIndex(s => s.id === id);
  if (i < 0) throw new Error(`No subtitle with id "${id}"`);
  subtitles.splice(i, 1);
  if (selectedSubtitleId === id) selectedSubtitleId = null;
}

function setSubtitleStyle(patch) {
  if (patch.preset !== undefined && !SUBTITLE_PRESETS[patch.preset]) {
    throw new Error(`preset must be one of ${Object.keys(SUBTITLE_PRESETS).join(', ')}`);
  }
  for (const k of ['textColor', 'highlightColor', 'background']) {
    if (patch[k] != null && !(k === 'background' && patch[k] === 'transparent') && !isColor(patch[k])) {
      throw new Error(`Invalid colour for ${k}: ${JSON.stringify(patch[k])}`);
    }
  }
  if (patch.fontFamily != null && !DESIGN_KEYS.fontFamily(patch.fontFamily)) throw new Error('Invalid font_family');
  pushHistory();
  Object.assign(subtitleStyle, stripUndefined(patch));
  projectChanged();
  return subtitleStyle;
}

// --- Words and timing ---

const splitWords = text => text.split(/\s+/).filter(Boolean);

// Word times for a cue: the transcription's when it still matches the text,
// otherwise spread over the cue in proportion to each word's length
function cueWords(c) {
  const tokens = splitWords(c.text);
  if (c.words && c.words.length === tokens.length) {
    return tokens.map((t, i) => ({ text: t, start: c.words[i].start, end: c.words[i].end }));
  }
  const total = tokens.reduce((n, t) => n + t.length + 1, 0) || 1;
  let acc = 0;
  return tokens.map(t => {
    const start = c.start + (c.end - c.start) * acc / total;
    acc += t.length + 1;
    return { text: t, start, end: c.start + (c.end - c.start) * acc / total };
  });
}

function activeCue(tMs) {
  for (const c of subtitles) if (tMs >= c.start && tMs < c.end) return c;
  return null;
}

// --- Rendering ---

function subtitleLook() {
  const s = subtitleStyle;
  const p = PRESET_LOOK[s.preset] || PRESET_LOOK.box;
  return {
    font: p.font,
    weight: s.fontWeight || p.weight,
    text: s.textColor || p.text,
    bg: s.background === 'transparent' ? null : (s.background || p.bg),
    stroke: p.stroke,
    strokeEm: p.strokeEm,
    highlight: s.highlight ?? p.highlight,
    hl: s.highlightColor || p.hl,
    maxWidth: s.maxWidth || p.maxWidth,
  };
}

// Greedy wrap that keeps word indices (for the highlight); at most 2 lines
// look right, longer cues still wrap rather than overflow
function wrapWords(c, words, maxW, space) {
  const lines = [];
  let line = [], w = 0;
  for (let i = 0; i < words.length; i++) {
    const ww = c.measureText(words[i].text).width;
    if (line.length && w + space + ww > maxW) {
      lines.push({ idx: line, w });
      line = []; w = 0;
    }
    w += (line.length ? space : 0) + ww;
    line.push(i);
  }
  if (line.length) lines.push({ idx: line, w });
  return lines;
}

function drawSubtitles(c, tMs, view) {
  if (subtitleStyle.enabled === false || !subtitles.length) return;
  const cue = activeCue(tMs);
  if (!cue || !cue.text) return;
  const { W, H, U } = view;
  const L = subtitleLook();
  const fontPx = U * L.font * (subtitleStyle.size || 1);
  const family = subtitleStyle.fontFamily ? `"${subtitleStyle.fontFamily}", ${FONT_STACK}` : FONT_STACK;
  if (subtitleStyle.fontFamily) ensureFont(subtitleStyle.fontFamily, L.weight);

  const words = cueWords(cue).map(w => ({ ...w, text: subtitleStyle.uppercase ? w.text.toUpperCase() : w.text }));
  // Quick fade so cue changes don't flash
  const k = Math.min(1, (tMs - cue.start) / 90, (cue.end - tMs) / 90);

  c.save();
  c.globalAlpha = Math.max(0, k);
  c.font = `${L.weight} ${fontPx}px ${family}`;
  c.letterSpacing = `${-fontPx * 0.01}px`;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  const space = c.measureText(' ').width;
  const lines = wrapWords(c, words, W * L.maxWidth, space);
  const lineH = fontPx * 1.28;
  const padX = L.bg ? fontPx * 0.55 : 0, padY = L.bg ? fontPx * 0.28 : 0;
  const blockH = lines.length * lineH;

  // Default: just above the bottom edge, or above the app UI in 9:16 — also
  // when an opened video is already vertical and kept in its own format
  const vertical = !safeZone() && H / W >= 1.7 && SAFE_ZONES['9:16'];
  const sz = vertical
    ? { x: W * vertical.left, y: H * vertical.top, w: W * (1 - vertical.left - vertical.right), h: H * (1 - vertical.top - vertical.bottom) }
    : view.safe || { x: 0, y: 0, w: W, h: H };
  const margin = Math.max(fontPx * 0.6, U * 0.04);
  let cy = subtitleStyle.y != null ? subtitleStyle.y * H : sz.y + sz.h - margin - blockH / 2 - padY;
  cy = Math.max(sz.y + blockH / 2 + padY, Math.min(sz.y + sz.h - blockH / 2 - padY, cy));
  const cx = sz.x + sz.w / 2;
  const top = cy - blockH / 2;

  // One box per line hugs the text, like broadcast subtitles
  // (one path, so where two lines' boxes overlap the fill is not darker)
  if (L.bg) {
    c.fillStyle = L.bg;
    c.beginPath();
    lines.forEach((ln, i) => {
      c.roundRect(cx - ln.w / 2 - padX, top + i * lineH - padY, ln.w + padX * 2, lineH + padY * 2, fontPx * 0.22);
    });
    c.fill('nonzero');
  }

  const strokeW = L.stroke ? fontPx * L.strokeEm : 0;
  if (!L.bg && !L.stroke) {
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = fontPx * 0.25;
  }
  lines.forEach((ln, i) => {
    let x = cx - ln.w / 2;
    const y = top + lineH * (i + 0.5);
    for (const wi of ln.idx) {
      const w = words[wi];
      const ww = c.measureText(w.text).width;
      if (strokeW) {
        c.save();
        c.strokeStyle = L.stroke;
        c.lineWidth = strokeW * 2;   // half is hidden under the fill
        c.lineJoin = 'round';
        c.strokeText(w.text, x, y);
        c.restore();
      }
      const spoken = L.highlight && tMs >= w.start && tMs < w.end;
      c.fillStyle = spoken ? L.hl : L.text;
      c.fillText(w.text, x, y);
      x += ww + space;
    }
  });
  c.restore();
}

// --- SRT (output time: what the exported video shows) ---

function srtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms % 1000, 3)}`;
}

function subtitlesToSrt() {
  const out = [];
  for (const c of subtitles) {
    const a = toOutputMs(c.start), b = toOutputMs(c.end);
    if (b - a < 50 || !c.text) continue;  // entirely inside a cut
    out.push(`${out.length + 1}\n${srtTime(a)} --> ${srtTime(b)}\n${c.text}\n`);
  }
  return out.join('\n');
}

// SRT / VTT → cues (source time = the file's times; meant for the untouched video)
function parseSubtitleFile(text) {
  const toMs = t => {
    const m = t.trim().match(/(?:(\d+):)?(\d+):(\d+)[,.](\d+)/);
    return m ? ((+m[1] || 0) * 3600 + +m[2] * 60 + +m[3]) * 1000 + +m[4].padEnd(3, '0').slice(0, 3) : NaN;
  };
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const at = lines.findIndex(l => l.includes('-->'));
    if (at < 0) continue;
    const [a, b] = lines[at].split('-->');
    const start = toMs(a), end = toMs(b);
    const body = lines.slice(at + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && body) cues.push({ start, end, text: body });
  }
  return cues;
}

function downloadSrt(label = '') {
  const srt = subtitlesToSrt();
  if (!srt) return false;
  downloadBlob(new Blob([srt], { type: 'application/x-subrip' }), 'srt', label);
  return true;
}

// --- Panel ---

const subtitleListEl = document.getElementById('subtitleList');
const subtitleCountEl = document.getElementById('subtitleCount');
const subtitleMarkersEl = document.getElementById('subtitleMarkers');

function setupSubtitlesPanel() {
  document.getElementById('subAddBtn').addEventListener('click', () => {
    const now = Math.round((sourceVideo.currentTime || 0) * 1000);
    pushHistory();
    const c = makeCue({ start: now, end: now + 2000, text: 'Subtitle' });
    subtitles.push(c);
    sortSubtitles();
    selectedSubtitleId = c.id;
    projectChanged();
  });
  const fileInput = document.getElementById('subFileInput');
  document.getElementById('subImportBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    const cues = parseSubtitleFile(await f.text());
    if (!cues.length) { alert('No subtitles found in that file (SRT or VTT).'); return; }
    setSubtitles(cues);
  });
  document.getElementById('subDownloadBtn').addEventListener('click', () => {
    if (!downloadSrt()) alert('There are no subtitles to download yet.');
  });
  document.getElementById('subClearBtn').addEventListener('click', () => {
    if (subtitles.length && confirm(`Delete all ${subtitles.length} subtitles?`)) setSubtitles([]);
  });
}

function renderSubtitlePanel() {
  subtitleCountEl.textContent = subtitles.length;
  const s = subtitleStyle;
  const styleEl = document.getElementById('subStyle');
  styleEl.innerHTML = `
    <div class="field-label">Look</div>
    <div class="chips">${Object.entries(SUBTITLE_PRESETS).map(([k, v]) =>
      `<button class="chip sub-preset ${k === s.preset ? 'active' : ''}" data-v="${k}" title="${escapeHtml(v.desc)}">${v.label}</button>`).join('')}</div>
    <div class="click-setting-row">
      <label>Size</label>
      <input type="range" class="sub-size" min="0.5" max="2" step="0.05" value="${s.size}">
      <span class="val">${Math.round(s.size * 100)}%</span>
    </div>
    <label class="switch-row">
      <span>Highlight the spoken word</span>
      <span class="switch"><input type="checkbox" class="sub-hl" ${subtitleLook().highlight ? 'checked' : ''}><span></span></span>
    </label>
    <label class="switch-row">
      <span>Show and burn into the video</span>
      <span class="switch"><input type="checkbox" class="sub-on" ${s.enabled !== false ? 'checked' : ''}><span></span></span>
    </label>`;
  styleEl.querySelectorAll('.sub-preset').forEach(b => b.addEventListener('click', () => setSubtitleStyle({ preset: b.dataset.v, highlight: null })));
  const size = styleEl.querySelector('.sub-size');
  size.addEventListener('pointerdown', pushHistory);
  size.addEventListener('input', () => {
    s.size = parseFloat(size.value);
    size.nextElementSibling.textContent = Math.round(s.size * 100) + '%';
    rerender(); saveProject();
  });
  styleEl.querySelector('.sub-hl').addEventListener('change', e => setSubtitleStyle({ highlight: e.target.checked }));
  styleEl.querySelector('.sub-on').addEventListener('change', e => setSubtitleStyle({ enabled: e.target.checked }));

  subtitleListEl.innerHTML = '';
  if (!subtitles.length) {
    subtitleListEl.innerHTML = '<div class="sidebar-hint">No subtitles yet. Ask Claude to transcribe the video ' +
      '(or to write them from what happens on screen), import an .srt file, or add them one by one.</div>';
    return;
  }
  for (const c of subtitles) {
    const selected = c.id === selectedSubtitleId;
    const item = document.createElement('div');
    item.className = 'event-row' + (selected ? ' active' : '');
    item.innerHTML = `
      <div class="event-head">
        <div class="event-main">
          <div class="event-title">${escapeHtml(c.text) || '<em>empty</em>'}</div>
          <div class="event-sub">${fmtTime(c.start / 1000)} – ${fmtTime(c.end / 1000)}</div>
        </div>
      </div>
      ${selected ? `
      <div class="text-fields">
        <textarea class="sub-text" rows="2">${escapeHtml(c.text)}</textarea>
        <div class="text-row">
          <label>From</label><input type="number" class="sub-start" step="0.1" min="0" value="${(c.start / 1000).toFixed(2)}">
          <label>to</label><input type="number" class="sub-end" step="0.1" min="0" value="${(c.end / 1000).toFixed(2)}">
          <label>s</label>
        </div>
        <div class="text-actions">
          <span class="text-hint"></span>
          <button class="btn btn-sm btn-danger sub-delete">Delete</button>
        </div>
      </div>` : ''}`;
    item.querySelector('.event-head').addEventListener('click', () => {
      selectedSubtitleId = selected ? null : c.id;
      if (!selected) seekTo((c.start + 50) / 1000);
      renderSubtitlePanel();
      renderSubtitleMarkers();
    });
    if (selected) {
      const ta = item.querySelector('.sub-text');
      ta.addEventListener('focus', pushHistory);
      ta.addEventListener('input', () => {
        c.text = ta.value;
        item.querySelector('.event-title').textContent = c.text;
        rerender(); renderSubtitleMarkers(); saveProject();
      });
      const edit = patch => { pushHistory(); updateSubtitle(c.id, patch); sortSubtitles(); projectChanged(); };
      item.querySelector('.sub-start').addEventListener('change', e => edit({ start: parseFloat(e.target.value) * 1000 }));
      item.querySelector('.sub-end').addEventListener('change', e => edit({ end: parseFloat(e.target.value) * 1000 }));
      item.querySelector('.sub-delete').addEventListener('click', () => { pushHistory(); removeSubtitle(c.id); projectChanged(); });
    }
    subtitleListEl.appendChild(item);
  }
}

function renderSubtitleMarkers() {
  subtitleMarkersEl.innerHTML = '';
  if (!sourceVideo.duration) return;
  const total = sourceVideo.duration * 1000;
  for (const c of subtitles) {
    const bar = document.createElement('div');
    bar.className = 'subtitle-bar' + (c.id === selectedSubtitleId ? ' active' : '');
    bar.style.left = (c.start / total) * 100 + '%';
    bar.style.width = Math.max(0.2, ((c.end - c.start) / total) * 100) + '%';
    bar.title = c.text;
    bar.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedSubtitleId = c.id;
      switchTab('subtitles');
      seekTo((c.start + 50) / 1000);
      renderSubtitlePanel();
      renderSubtitleMarkers();
    });
    subtitleMarkersEl.appendChild(bar);
  }
}

// --- Audio for transcription ---
// The soundtrack as 16 kHz mono PCM (what speech models expect). Decoded once.

let audioPcmCache = null; // { blob, pcm: Float32Array }

async function audioPcm16k() {
  if (audioPcmCache && audioPcmCache.blob === videoBlob) return audioPcmCache.pcm;
  const SR = 16000;
  const data = await videoBlob.arrayBuffer();
  let decoded;
  try {
    // decodeAudioData resamples to the context's rate
    decoded = await new OfflineAudioContext(1, 1, SR).decodeAudioData(data);
  } catch {
    throw new Error('The video has no audio track (or its audio cannot be decoded).');
  }
  const pcm = new Float32Array(decoded.length);
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const d = decoded.getChannelData(ch);
    for (let i = 0; i < d.length; i++) pcm[i] += d[i] / decoded.numberOfChannels;
  }
  audioPcmCache = { blob: videoBlob, pcm };
  return pcm;
}

// Base64 of 16-bit PCM between two times (seconds)
async function audioPcmBase64(startSec = 0, endSec = Infinity) {
  const SR = 16000;
  const pcm = await audioPcm16k();
  const a = Math.max(0, Math.floor(startSec * SR));
  const b = Math.min(pcm.length, Math.ceil(Math.min(endSec, pcm.length / SR) * SR));
  const i16 = new Int16Array(Math.max(0, b - a));
  let peak = 0;
  for (let i = 0; i < i16.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[a + i]));
    peak = Math.max(peak, Math.abs(v));
    i16[i] = v * 32767;
  }
  const bytes = new Uint8Array(i16.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { sampleRate: SR, startSec: a / SR, endSec: b / SR, peak, data: btoa(bin) };
}
