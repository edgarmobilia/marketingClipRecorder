'use strict';

// --- State ---
let videoBlob = null;
let clicks = [];       // [{ kind, t, x, y, vw, vh, nx, ny, zoomLevel, zoomInDuration, holdDuration, zoomOutDuration, zoomOffset, enabled }]
let moves = [];        // cursor samples [{ t, nx, ny }], sorted by t
let mimeType = 'video/webm';
let ext = 'webm';
let selectedClickIdx = null;
let isPlaying = false;
let rafId = null;
let isDragging = false;
let dragInfo = null; // { idx, type, initialValue, initialT }
let autoExportPending = false;
let editorReady = false;   // video metadata loaded, safe to render / answer the MCP bridge

// Default zoom settings (used as initial values per click, remembered across sessions)
let defaults = {
  zoomLevel: 1.8,
  zoomInDuration: 500,
  holdDuration: 1200,
  zoomOutDuration: 600,
  zoomOffset: 0,
};

// Automatic camera behaviour
let cameraOptions = {
  followCursor: true,  // pan with the cursor while zoomed in
  mergeGap: 1200,      // ms — zooms closer than this are joined instead of bouncing out/in
  motion: 'smooth',    // key of MOTION_PRESETS
  autoZoom: true,      // zoom level from the clicked element's size
  zoomIntensity: 1,    // multiplier on auto zoom
  motionBlur: true,
  // Inset frame on a background (off = full-bleed recording)
  frame: { enabled: false, padding: 0.06, radius: 18, background: ['#1e293b', '#0f172a'], shadow: true },
};

const ZOOM_KEYS = ['zoomLevel', 'zoomInDuration', 'holdDuration', 'zoomOutDuration', 'zoomOffset'];

function pickZoom(src) {
  return Object.fromEntries(ZOOM_KEYS.map(k => [k, src[k]]));
}

// --- DOM refs ---
const previewCanvas = document.getElementById('previewCanvas');
const ctx = previewCanvas.getContext('2d');
const sourceVideo = document.getElementById('sourceVideo');
const canvasOverlay = document.getElementById('canvasOverlay');
const loadingMsg = document.getElementById('loadingMsg');
const clickListEl = document.getElementById('clickList');
const clickCountEl = document.getElementById('clickCount');
const sidebarHint = document.getElementById('sidebarHint');
const timelinePlayed = document.getElementById('timelinePlayed');
const clickMarkersEl = document.getElementById('clickMarkers');
const currentTimeEl = document.getElementById('currentTime');
const totalTimeEl = document.getElementById('totalTime');
const previewBtn = document.getElementById('previewBtn');
const exportBtn = document.getElementById('exportBtn');
const playPauseBtn = document.getElementById('playPauseBtn');
const rewindBtn = document.getElementById('rewindBtn');
const exportOverlay = document.getElementById('exportOverlay');
const exportFill = document.getElementById('exportFill');
const exportPercent = document.getElementById('exportPercent');
const timeline = document.getElementById('timeline');

// --- Audio capture for export ---
let audioCtx = null;
let audioExportDestination = null;

function ensureAudioCapture() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  const sourceNode = audioCtx.createMediaElementSource(sourceVideo);
  audioExportDestination = audioCtx.createMediaStreamDestination();
  sourceNode.connect(audioCtx.destination);
  sourceNode.connect(audioExportDestination);
}

// --- Easing functions ---
const easings = {
  in:     t => t * t * t,
  out:    t => 1 - Math.pow(1 - t, 3),
  inOut:  t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  linear: t => t,
};

// --- Zoom envelope of a single click ---
function zoomTimes(click) {
  const peak = click.t + (click.zoomOffset || 0);
  return {
    start:   peak - click.zoomInDuration,
    peak,
    holdEnd: peak + click.holdDuration,
    end:     peak + click.holdDuration + click.zoomOutDuration,
  };
}

// Auto zoom: frame the clicked element so it fills a comfortable share of
// the screen (small buttons get closer, big forms stay wider). Falls back to
// the event's own level when there is no element box or it was set by hand.
const AUTO_ZOOM_MIN = 1.25;
const AUTO_ZOOM_MAX = 2.6;

function zoomLevelOf(c) {
  if (!cameraOptions.autoZoom || c.zoomAuto === false || !c.rect || !c.vw) return c.zoomLevel;
  const rw = Math.max(0.02, c.rect.w / c.vw);
  const rh = Math.max(0.02, c.rect.h / c.vh);
  // Element (plus breathing room) ≈ 38 % of the width or 42 % of the height
  const fit = Math.min(0.38 / rw, 0.42 / rh) * (cameraOptions.zoomIntensity || 1);
  return Math.min(AUTO_ZOOM_MAX, Math.max(AUTO_ZOOM_MIN, fit));
}

// Scale is interpolated in log space so 1×→2× feels as fast as 2×→4×
function logLerp(a, b, k) {
  return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * k);
}

function envelopeScale(tMs, click, lvl) {
  const { start, peak, holdEnd, end } = zoomTimes(click);
  if (tMs <= start || tMs >= end) return 1;
  if (tMs <= peak)    return logLerp(1, lvl, easings.inOut((tMs - start) / click.zoomInDuration));
  if (tMs <= holdEnd) return lvl;
  return logLerp(lvl, 1, easings.inOut((tMs - holdEnd) / click.zoomOutDuration));
}

// --- Automatic camera ---
// The whole camera path (scale + focus point) is simulated once at a fixed
// rate and cached, so preview, seeking and export always show the same shot.

const CAMERA_FPS = 60;

// Motion character: spring stiffness/damping and how freely the cursor roams
const MOTION_PRESETS = {
  smooth: { omega: 5.5, zeta: 1.0,  deadzone: 0.24, label: 'Smooth' },
  snappy: { omega: 10,  zeta: 0.72, deadzone: 0.18, label: 'Snappy' },
  calm:   { omega: 3.6, zeta: 1.0,  deadzone: 0.34, label: 'Calm' },
};

let cameraPath = null;         // { scale, cx, cy } as Float32Arrays indexed by frame

// Director shots: explicit framing that overrides the automatic camera.
// shot: { id, start, end, x, y, scale, transition }   (ms, 0–1, ×, ms)
let shots = [];
let nextShotId = 1;

function invalidateCamera() {
  cameraPath = null;
}

function cursorAt(tMs) {
  if (!moves.length) return null;
  let lo = 0, hi = moves.length - 1;
  if (tMs <= moves[0].t) return moves[0];
  if (tMs >= moves[hi].t) return moves[hi];
  // Binary search for the samples around tMs, then interpolate
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (moves[mid].t <= tMs) lo = mid; else hi = mid;
  }
  const a = moves[lo], b = moves[hi];
  const k = (tMs - a.t) / ((b.t - a.t) || 1);
  return { nx: a.nx + (b.nx - a.nx) * k, ny: a.ny + (b.ny - a.ny) * k };
}

// Weight (0–1) of a shot at time t, eased over its transition
function shotWeight(sh, tMs) {
  const tr = Math.max(1, sh.transition ?? 600);
  if (tMs <= sh.start - tr || tMs >= sh.end + tr) return 0;
  if (tMs < sh.start) return easings.inOut((tMs - (sh.start - tr)) / tr);
  if (tMs > sh.end) return easings.inOut(1 - (tMs - sh.end) / tr);
  return 1;
}

function buildCameraPath() {
  const durationMs = (sourceVideo.duration || 0) * 1000;
  const steps = Math.max(1, Math.ceil(durationMs / 1000 * CAMERA_FPS) + 1);
  const scale = new Float32Array(steps);
  const cxArr = new Float32Array(steps);
  const cyArr = new Float32Array(steps);
  const motion = MOTION_PRESETS[cameraOptions.motion] || MOTION_PRESETS.smooth;

  const active = clicks.filter(c => c.enabled)
    .map(c => ({ c, lvl: zoomLevelOf(c), ...zoomTimes(c) }))
    .sort((a, b) => a.start - b.start);

  // Bridges keep the zoom up between events that are close together
  const bridges = [];
  for (let i = 0; i + 1 < active.length; i++) {
    const a = active[i], b = active[i + 1];
    if (b.start - a.end < cameraOptions.mergeGap && b.peak > a.peak) bridges.push({ a, b });
  }

  const dt = 1 / CAMERA_FPS;
  const lp = 1 - Math.exp(-dt * 6); // low-pass for the travel dip
  let x = 0.5, y = 0.5, vx = 0, vy = 0;
  let anchorX = 0.5, anchorY = 0.5;
  let focusIdx = -1;
  let prevScale = 1;
  let dip = 1;

  for (let i = 0; i < steps; i++) {
    const tMs = i * dt * 1000;

    // 1. Zoom level from the events
    let s = 1;
    for (const a of active) s = Math.max(s, envelopeScale(tMs, a.c, a.lvl));
    for (const { a, b } of bridges) {
      if (tMs > a.peak && tMs < b.peak) {
        s = Math.max(s, logLerp(a.lvl, b.lvl, easings.inOut((tMs - a.peak) / (b.peak - a.peak))));
      }
    }

    // 2. Focus target: the event the camera is currently heading to
    while (focusIdx + 1 < active.length && active[focusIdx + 1].start <= tMs) {
      focusIdx++;
      anchorX = active[focusIdx].c.nx;
      anchorY = active[focusIdx].c.ny;
    }

    // 3. Soft cursor follow: only pan once the cursor leaves the dead zone
    if (cameraOptions.followCursor && s > 1.01) {
      const cur = cursorAt(tMs);
      if (cur) {
        const zone = motion.deadzone / s;
        const dx = cur.nx - anchorX, dy = cur.ny - anchorY;
        if (Math.abs(dx) > zone) anchorX = cur.nx - Math.sign(dx) * zone;
        if (Math.abs(dy) > zone) anchorY = cur.ny - Math.sign(dy) * zone;
      }
    }

    // 4. Director shots override both (blended over their transitions)
    let targetX = anchorX, targetY = anchorY;
    for (const sh of shots) {
      const w = shotWeight(sh, tMs);
      if (w <= 0) continue;
      s = logLerp(s, Math.max(1, sh.scale), w);
      targetX += (sh.x - targetX) * w;
      targetY += (sh.y - targetY) * w;
    }

    // 5. Spring the focus point toward the target (snap while fully zoomed out)
    if (prevScale <= 1.01) {
      x = targetX; y = targetY; vx = 0; vy = 0;
    } else {
      const w = motion.omega, z = motion.zeta;
      vx += (w * w * (targetX - x) - 2 * z * w * vx) * dt;
      vy += (w * w * (targetY - y) - 2 * z * w * vy) * dt;
      x += vx * dt;
      y += vy * dt;
    }

    // 6. Long trips while zoomed in pull back a little mid-way (orientation)
    const travel = Math.hypot(targetX - x, targetY - y) * s; // in "screens"
    const wantDip = 1 + 0.9 * Math.max(0, travel - 0.3);
    dip += (wantDip - dip) * lp;
    const sOut = Math.max(1, s / dip);

    scale[i] = sOut;
    cxArr[i] = x;
    cyArr[i] = y;
    prevScale = sOut;
  }

  cameraPath = { scale, cx: cxArr, cy: cyArr };
}

function getCamera(timeSec) {
  if (!cameraPath) buildCameraPath();
  const i = Math.min(cameraPath.scale.length - 1, Math.max(0, Math.round(timeSec * CAMERA_FPS)));
  return { scale: cameraPath.scale[i], cx: cameraPath.cx[i], cy: cameraPath.cy[i] };
}

// --- Canvas rendering ---
let lastView = null; // camera transform of the last rendered frame (for canvas dragging)

// Inset "marketing frame": the recording sits on a background with padding,
// rounded corners and a shadow. Returns the inner box in canvas pixels.
function frameBox(W, H) {
  const f = cameraOptions.frame;
  if (!f || !f.enabled) return { ox: 0, oy: 0, k: 1 };
  const k = 1 - 2 * Math.min(0.2, Math.max(0, f.padding ?? 0.06));
  return { ox: (W - W * k) / 2, oy: (H - H * k) / 2, k };
}

function cameraView(timeSec) {
  const W = previewCanvas.width;
  const H = previewCanvas.height;
  const { ox, oy, k } = frameBox(W, H);
  const { scale: s, cx, cy } = getCamera(timeSec);
  let tx = 0, ty = 0, sc = 1;
  if (s > 1.001) {
    // Put the focus point at the centre, clamped so the scaled video always
    // covers the whole (inner) frame
    sc = s;
    tx = Math.max(W - W * s, Math.min(0, W / 2 - cx * W * s));
    ty = Math.max(H - H * s, Math.min(0, H / 2 - cy * H * s));
  }
  // Compose with the inset: one transform for video, cursor and 'video' texts
  return { W, H, s: sc * k, tx: ox + tx * k, ty: oy + ty * k };
}

function drawFrameBackground(W, H) {
  const f = cameraOptions.frame;
  if (Array.isArray(f.background) && f.background.length >= 2) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    f.background.forEach((col, i) => g.addColorStop(i / (f.background.length - 1), col));
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = f.background || '#0f172a';
  }
  ctx.fillRect(0, 0, W, H);
}

function drawVideoLayer(view) {
  const { W, H, s, tx, ty } = view;
  ctx.save();
  ctx.translate(tx, ty);
  ctx.scale(s, s);
  ctx.drawImage(sourceVideo, 0, 0, W, H);
  ctx.restore();
}

// raw = the untouched recording (no zoom, no texts, no frame)
function renderFrame(timeSec, { raw = false } = {}) {
  const W = previewCanvas.width, H = previewCanvas.height;
  const view = raw ? { W, H, s: 1, tx: 0, ty: 0 } : cameraView(timeSec);
  const framed = !raw && cameraOptions.frame && cameraOptions.frame.enabled;

  ctx.clearRect(0, 0, W, H);
  ctx.save();
  if (framed) {
    const { ox, oy, k } = frameBox(W, H);
    const r = (cameraOptions.frame.radius ?? 18) * H / 1080;
    drawFrameBackground(W, H);
    if (cameraOptions.frame.shadow !== false) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = H * 0.04;
      ctx.shadowOffsetY = H * 0.012;
      ctx.fillStyle = '#000';
      roundRect(ctx, ox, oy, W * k, H * k, r);
      ctx.fill();
      ctx.restore();
    }
    roundRect(ctx, ox, oy, W * k, H * k, r);
    ctx.clip();
  }

  // Motion blur: average a few sub-frame camera positions when moving fast
  const prev = !raw && cameraOptions.motionBlur !== false ? cameraView(Math.max(0, timeSec - 1 / CAMERA_FPS)) : null;
  const speed = prev ? Math.abs(prev.tx - view.tx) + Math.abs(prev.ty - view.ty) + Math.abs(prev.s - view.s) * W * 0.5 : 0;
  if (speed > W * 0.004) {
    const N = 4;
    for (let i = 0; i < N; i++) {
      const k = i / (N - 1);
      ctx.globalAlpha = 1 / (i + 1); // running average, newest last
      drawVideoLayer({
        W, H,
        s: prev.s + (view.s - prev.s) * k,
        tx: prev.tx + (view.tx - prev.tx) * k,
        ty: prev.ty + (view.ty - prev.ty) * k,
      });
    }
    ctx.globalAlpha = 1;
  } else {
    drawVideoLayer(view);
  }

  if (!raw) drawCursorLayer(ctx, timeSec * 1000, view);
  ctx.restore();

  if (!raw) {
    drawOverlays(ctx, timeSec * 1000, view);
    drawSpeedBadge(ctx, timeSec, view);
  }
  lastView = view;
}

function rerender() {
  if (sourceVideo.paused && sourceVideo.readyState >= 2) renderFrame(sourceVideo.currentTime);
}

// --- Video playback loop ---
function startPlaybackLoop() {
  function loop() {
    if (sourceVideo.paused || sourceVideo.ended) {
      isPlaying = false;
      playPauseBtn.textContent = '▶';
      rafId = null;
      if (!sourceVideo.ended) return;
    }
    // Skip cuts / fast-forward speed-ups before drawing this frame
    if (!sourceVideo.ended) applySegmentsAt(sourceVideo.currentTime);
    renderFrame(sourceVideo.currentTime);
    updateTimeDisplay(sourceVideo.currentTime);
    updateTimelineProgress(sourceVideo.currentTime);
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);
}

function stopPlaybackLoop() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

// --- Time helpers ---
function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function updateTimeDisplay(t) {
  currentTimeEl.textContent = fmtTime(t);
}

function updateTimelineProgress(t) {
  const pct = sourceVideo.duration ? (t / sourceVideo.duration) * 100 : 0;
  timelinePlayed.style.width = pct + '%';
}

// --- Load data from chrome.storage ---
async function loadData() {
  const data = await chrome.storage.session.get([
    'mcrEditorClicks', 'mcrEditorMoves', 'mcrEditorMimeType', 'mcrEditorExt', 'mcrEditorAutoExport', 'mcrEditorFresh',
  ]);
  const stored = await chrome.storage.sync.get(['mcrEditorDefaults', 'mcrCameraOptions']);
  Object.assign(defaults, stored.mcrEditorDefaults);
  const storedCam = stored.mcrCameraOptions || {};
  Object.assign(cameraOptions, storedCam, { frame: { ...cameraOptions.frame, ...storedCam.frame } });

  mimeType = data.mcrEditorMimeType || 'video/webm';
  ext = data.mcrEditorExt || 'webm';
  // One-shot: reloading the editor must not export again
  autoExportPending = !!data.mcrEditorAutoExport;
  chrome.storage.session.remove('mcrEditorAutoExport');

  const norm = (v, max) => Math.min(1, Math.max(0, v / (max || 1)));

  clicks = (data.mcrEditorClicks || []).map(c => ({
    ...c,
    kind: c.kind || 'click',
    // Normalize coordinates to 0-1 range
    nx: norm(c.x, c.vw),
    ny: norm(c.y, c.vh),
    ...pickZoom(defaults),
    enabled: true,
  }));

  moves = (data.mcrEditorMoves || [])
    .map(m => ({ t: m.t, nx: norm(m.x, m.vw), ny: norm(m.y, m.vh) }))
    .sort((a, b) => a.t - b.t);

  // Reopening the editor for the same recording restores all edits
  // (zoom tweaks, texts); a new recording starts from its fresh event log
  if (data.mcrEditorFresh) {
    chrome.storage.session.remove('mcrEditorFresh');
    await idbPut('project', null);
  } else {
    const saved = await idbGet('project');
    if (saved) applySnapshot(saved);
  }

  return loadVideoFromIndexedDB();
}

// --- Project state: snapshot / persistence / undo ---

function snapshot() {
  return JSON.parse(JSON.stringify({ clicks, overlays, cameraOptions, nextOverlayId, segments, nextSegmentId, cursorFx, shots, nextShotId }));
}

function applySnapshot(snap) {
  clicks = snap.clicks || clicks;
  overlays = (snap.overlays || []).map(normalizeOverlay);
  nextOverlayId = snap.nextOverlayId || overlays.length + 1;
  const frame = { ...cameraOptions.frame, ...(snap.cameraOptions && snap.cameraOptions.frame) };
  Object.assign(cameraOptions, snap.cameraOptions, { frame });
  segments = snap.segments || [];
  shots = snap.shots || [];
  nextShotId = snap.nextShotId || shots.length + 1;
  cursorFx = { ...CURSOR_DEFAULTS, ...snap.cursorFx };
  nextSegmentId = snap.nextSegmentId || segments.length + 1;
}

let saveTimer = null;
function saveProject() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => idbPut('project', snapshot()).catch(console.error), 400);
}

const undoStack = [];
const HISTORY_LIMIT = 50;

// Call before any edit that should be undoable
function pushHistory() {
  undoStack.push(snapshot());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
}

function undo() {
  const snap = undoStack.pop();
  if (!snap) return false;
  applySnapshot(snap);
  projectChanged();
  return true;
}

// Single place to refresh everything after the project changes
function projectChanged() {
  invalidateCamera();
  syncCameraControls();
  renderClickList();
  renderClickMarkers();
  renderTextList();
  renderTextMarkers();
  renderSegmentList();
  renderSegmentMarkers();
  renderCursorPanel();
  rerender();
  saveProject();
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('recordings', 'readonly').objectStore('recordings').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recordings', 'readwrite');
    tx.objectStore('recordings').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('mcr_db', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('recordings');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadVideoFromIndexedDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recordings', 'readonly');
    const req = tx.objectStore('recordings').get('last');
    req.onsuccess = () => {
      if (req.result) resolve(req.result);
      else reject(new Error('No recording found.'));
    };
    req.onerror = () => reject(req.error);
  });
}

// MediaRecorder WebM files have no duration in their header (Infinity);
// seeking far past the end makes Chrome compute the real one
function ensureFiniteDuration() {
  if (Number.isFinite(sourceVideo.duration)) return Promise.resolve();
  return new Promise((resolve) => {
    sourceVideo.addEventListener('durationchange', function onChange() {
      if (!Number.isFinite(sourceVideo.duration)) return;
      sourceVideo.removeEventListener('durationchange', onChange);
      resolve();
    });
    sourceVideo.currentTime = 1e101;
  });
}

// --- Setup video + canvas ---
function setupVideo(blob) {
  videoBlob = blob;
  const url = URL.createObjectURL(blob);
  sourceVideo.src = url;

  sourceVideo.addEventListener('loadedmetadata', async () => {
    await ensureFiniteDuration();

    // Set canvas to video resolution
    previewCanvas.width = sourceVideo.videoWidth;
    previewCanvas.height = sourceVideo.videoHeight;
    // Resizing the canvas resets its state; zoomed frames need the best resampling
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    console.log(`[MCR editor] Source ${sourceVideo.videoWidth}x${sourceVideo.videoHeight}`);

    totalTimeEl.textContent = fmtTime(sourceVideo.duration);
    canvasOverlay.classList.add('hidden');

    // Drop events that fall outside the footage
    const durMs = sourceVideo.duration * 1000;
    clicks = clicks.filter(c => c.t <= durMs);
    invalidateCamera();

    // Draw first frame
    sourceVideo.currentTime = 0;
    sourceVideo.addEventListener('seeked', () => {
      renderFrame(0);
      if (autoExportPending) {
        autoExportPending = false;
        exportVideo();
      }
    }, { once: true });

    renderClickList();
    renderClickMarkers();
    renderTextList();
    renderTextMarkers();
    renderSegmentList();
    renderSegmentMarkers();
    renderCursorPanel();
    editorReady = true;
  }, { once: true });

  sourceVideo.addEventListener('pause', resetPlaybackRate);
  sourceVideo.addEventListener('ended', () => {
    isPlaying = false;
    playPauseBtn.textContent = '▶';
    stopPlaybackLoop();
  });
}

function eventLabel(click, i) {
  return `${click.kind === 'type' ? 'Typing' : 'Click'} #${i + 1}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// --- Zoom style presets (one click for the whole video) ---
const ZOOM_PRESETS = {
  subtle: { label: 'Subtle', intensity: 0.8, zoomLevel: 1.4, zoomInDuration: 650, holdDuration: 1000, zoomOutDuration: 750, zoomOffset: 0 },
  normal: { label: 'Normal', intensity: 1,   zoomLevel: 1.8, zoomInDuration: 500, holdDuration: 1200, zoomOutDuration: 600, zoomOffset: 0 },
  punchy: { label: 'Punchy', intensity: 1.3, zoomLevel: 2.4, zoomInDuration: 350, holdDuration: 1300, zoomOutDuration: 450, zoomOffset: 0 },
};

function currentZoomPreset() {
  const list = clicks.length ? clicks : [defaults];
  return Object.keys(ZOOM_PRESETS).find(key =>
    Math.abs((cameraOptions.zoomIntensity || 1) - ZOOM_PRESETS[key].intensity) < 1e-6 &&
    list.every(c => ZOOM_KEYS.every(k => Math.abs((c[k] || 0) - ZOOM_PRESETS[key][k]) < 1e-6))) || null;
}

function renderZoomPresets() {
  const el = document.getElementById('zoomPresets');
  const active = currentZoomPreset();
  el.innerHTML = Object.entries(ZOOM_PRESETS)
    .map(([key, p]) => `<button class="chip ${key === active ? 'active' : ''}" data-preset="${key}">${p.label}</button>`)
    .join('');
  el.querySelectorAll('.chip').forEach(btn => btn.addEventListener('click', () => {
    const preset = ZOOM_PRESETS[btn.dataset.preset];
    pushHistory();
    Object.assign(defaults, pickZoom(preset));
    chrome.storage.sync.set({ mcrEditorDefaults: defaults });
    clicks.forEach(c => { Object.assign(c, pickZoom(preset)); delete c.zoomAuto; });
    cameraOptions.zoomIntensity = preset.intensity;
    syncDefaultSliders();
    projectChanged();
  }));
}

// --- Event list UI ---
function renderClickList() {
  clickCountEl.textContent = clicks.length;
  sidebarHint.style.display = clicks.length === 0 ? '' : 'none';
  clickListEl.innerHTML = '';
  renderZoomPresets();

  clicks.forEach((click, i) => {
    const selected = i === selectedClickIdx;
    const item = document.createElement('div');
    item.className = 'event-row' + (selected ? ' active' : '') + (!click.enabled ? ' off' : '');

    const what = click.label || (click.kind === 'type' ? 'Text field' : 'Click');
    item.innerHTML = `
      <div class="event-head">
        <span class="event-icon">${click.kind === 'type' ? '⌨' : '↖'}</span>
        <div class="event-main">
          <div class="event-title" title="${escapeHtml(what)}">${escapeHtml(what)}</div>
          <div class="event-sub">${click.kind === 'type' ? 'Typing' : 'Click'} · ${fmtTime(click.t / 1000)}</div>
        </div>
        <label class="switch" title="Zoom on this event">
          <input type="checkbox" class="click-toggle" ${click.enabled ? 'checked' : ''}><span></span>
        </label>
      </div>
      ${selected ? `
      <div class="event-body">
        ${click.kind === 'click' ? `
        <label class="switch-row">
          <span>Click effect</span>
          <span class="switch"><input type="checkbox" class="p-effect" ${click.effect !== false ? 'checked' : ''}><span></span></span>
        </label>` : ''}
        ${click.enabled ? `
        <div class="click-setting-row">
          <label>Zoom</label>
          <input type="range" class="p-zoom" min="1.1" max="3" step="0.1" value="${zoomLevelOf(click).toFixed(1)}">
          <span class="val">${zoomLevelOf(click).toFixed(1)}×${click.zoomAuto !== false && cameraOptions.autoZoom && click.rect ? ' auto' : ''}</span>
        </div>
        <details class="more">
          <summary>Timing</summary>
          <div class="click-setting-row">
            <label>Ease in</label>
            <input type="range" class="p-in" min="100" max="3000" step="50" value="${Math.round(click.zoomInDuration)}">
            <span class="val">${Math.round(click.zoomInDuration)}ms</span>
          </div>
          <div class="click-setting-row">
            <label>Hold</label>
            <input type="range" class="p-hold" min="0" max="4000" step="100" value="${click.holdDuration}">
            <span class="val">${click.holdDuration}ms</span>
          </div>
          <div class="click-setting-row">
            <label>Ease out</label>
            <input type="range" class="p-out" min="100" max="3000" step="50" value="${Math.round(click.zoomOutDuration)}">
            <span class="val">${Math.round(click.zoomOutDuration)}ms</span>
          </div>
          <div class="click-setting-row">
            <label>Offset</label>
            <input type="range" class="p-offset" min="-500" max="500" step="10" value="${Math.round(click.zoomOffset || 0)}">
            <span class="val">${Math.round(click.zoomOffset || 0)}ms</span>
          </div>
        </details>` : ''}
      </div>` : ''}
    `;

    item.querySelector('.click-toggle').addEventListener('change', (e) => {
      e.stopPropagation();
      pushHistory();
      clicks[i].enabled = e.target.checked;
      projectChanged();
    });

    item.querySelector('.p-effect')?.addEventListener('change', (e) => {
      pushHistory();
      clicks[i].effect = e.target.checked;
      projectChanged();
    });

    if (selected && click.enabled) {
      // Moving the slider takes this event off auto zoom
      bindSlider(item.querySelector('.p-zoom'),   v => { clicks[i].zoomLevel = parseFloat(v); clicks[i].zoomAuto = false; }, '×', 1);
      bindSlider(item.querySelector('.p-in'),     v => { clicks[i].zoomInDuration = Math.round(v); }, 'ms');
      bindSlider(item.querySelector('.p-hold'),   v => { clicks[i].holdDuration = Math.round(v); }, 'ms');
      bindSlider(item.querySelector('.p-out'),    v => { clicks[i].zoomOutDuration = Math.round(v); }, 'ms');
      bindSlider(item.querySelector('.p-offset'), v => { clicks[i].zoomOffset = Math.round(v); }, 'ms');
    }

    // Click the row to jump there
    item.querySelector('.event-head').addEventListener('click', (e) => {
      if (e.target.closest('.switch')) return;
      selectedClickIdx = selected ? null : i;
      seekTo(clicks[i].t / 1000);
      renderClickList();
      renderClickMarkers();
    });

    clickListEl.appendChild(item);
  });
}

function bindSlider(input, setter, unit, decimals = 0) {
  input.addEventListener('pointerdown', pushHistory);
  input.addEventListener('change', saveProject);
  input.addEventListener('input', () => {
    setter(input.value);
    invalidateCamera();
    const span = input.nextElementSibling;
    span.textContent = decimals > 0
      ? parseFloat(input.value).toFixed(decimals) + unit
      : input.value + unit;
    if (!sourceVideo.paused) return;
    renderFrame(sourceVideo.currentTime);
  });
}

// --- Click markers on timeline ---
function renderClickMarkers() {
  clickMarkersEl.innerHTML = '';
  if (!sourceVideo.duration) return;

  const totalTime = sourceVideo.duration * 1000;

  clicks.forEach((click, i) => {
    const isSelected = i === selectedClickIdx;

    // Timing calculations
    const { start: zoomStart, end: zoomEnd } = zoomTimes(click);

    // Percentages
    const startPct = (zoomStart / totalTime) * 100;
    const endPct   = (zoomEnd / totalTime) * 100;
    const clickPct = (click.t / totalTime) * 100;

    // 1. Zoom range background
    const range = document.createElement('div');
    range.className = 'click-range' + (isSelected ? ' active' : '') + (!click.enabled ? ' disabled' : '');
    range.style.left = startPct + '%';
    range.style.width = Math.max(0.5, endPct - startPct) + '%';
    range.style.cursor = 'grab';
    range.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      selectedClickIdx = i;
      startDrag(e, i, 'range');
    });
    range.addEventListener('click', (e) => e.stopPropagation());
    clickMarkersEl.appendChild(range);

    // 2. Start/End dots
    if (click.enabled) {
      const dotStart = document.createElement('div');
      dotStart.className = 'click-dot' + (isSelected ? ' active' : '');
      dotStart.style.left = startPct + '%';
      dotStart.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        selectedClickIdx = i;
        startDrag(e, i, 'start');
      });
      clickMarkersEl.appendChild(dotStart);

      const dotEnd = document.createElement('div');
      dotEnd.className = 'click-dot' + (isSelected ? ' active' : '');
      dotEnd.style.left = endPct + '%';
      dotEnd.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        selectedClickIdx = i;
        startDrag(e, i, 'end');
      });
      clickMarkersEl.appendChild(dotEnd);
    }

    // 3. Click marker (The peak/event)
    const marker = document.createElement('div');
    marker.className = 'click-marker'
      + (isSelected ? ' active' : '')
      + (!click.enabled ? ' disabled' : '');
    marker.style.left = clickPct + '%';
    marker.title = `${eventLabel(click, i)} — ${fmtTime(click.t / 1000)}`;

    marker.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      selectedClickIdx = i;
      startDrag(e, i, 'click');
    });

    marker.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!isDragging) {
        selectedClickIdx = i;
        seekTo(click.t / 1000);
        renderClickList();
        renderClickMarkers();
      }
    });

    clickMarkersEl.appendChild(marker);
  });
}

// --- DRAG logic ---
function startDrag(e, idx, type) {
  pushHistory();
  isDragging = true;
  const click = clicks[idx];
  const clickTime = click.t;
  const zoomPeak = clickTime + (click.zoomOffset || 0);

  let initialVal = 0;
  if (type === 'click') initialVal = clickTime;
  else if (type === 'start') initialVal = click.zoomInDuration;
  else if (type === 'end') initialVal = click.zoomOutDuration;
  else if (type === 'range') initialVal = click.zoomOffset || 0;

  dragInfo = {
    idx,
    type,
    initialVal,
    initialX: e.clientX,
    zoomPeak, // Pre-calculated peak during start for start/end drags
    holdEnd: zoomPeak + click.holdDuration, // For end dot drag
  };

  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragStop);
  document.body.style.cursor = 'ew-resize';
  renderClickList();
  renderClickMarkers();
}

function onDragMove(e) {
  if (!isDragging || !dragInfo) return;
  const { idx, type, initialVal, initialX, zoomPeak, holdEnd } = dragInfo;
  const click = clicks[idx];
  const totalDuration = sourceVideo.duration * 1000;
  const timelineRect = timeline.getBoundingClientRect();

  const dx = e.clientX - initialX;
  const dt = (dx / timelineRect.width) * totalDuration;

  if (type === 'click') {
    click.t = Math.round(Math.max(0, Math.min(totalDuration, initialVal + dt)));
  } else if (type === 'start') {
    const newT = (zoomPeak - initialVal) + dt;
    click.zoomInDuration = Math.round(Math.max(50, zoomPeak - newT));
  } else if (type === 'end') {
    const newT = (holdEnd + initialVal) + dt;
    click.zoomOutDuration = Math.round(Math.max(50, newT - holdEnd));
  } else if (type === 'range') {
    click.zoomOffset = Math.round(initialVal + dt);
  }
  invalidateCamera();

  // Live preview
  if (sourceVideo.paused) {
    if (type === 'click') sourceVideo.currentTime = click.t / 1000;
    else if (type === 'range' || type === 'start') sourceVideo.currentTime = (click.t + click.zoomOffset) / 1000;
    else {
      // For end drag, show the end of the zoom out
      sourceVideo.currentTime = (click.t + click.zoomOffset + click.holdDuration + click.zoomOutDuration) / 1000;
    }
    renderFrame(sourceVideo.currentTime);
  }

  renderClickList();
  renderClickMarkers();
}

function onDragStop() {
  isDragging = false;
  dragInfo = null;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragStop);
  document.body.style.cursor = '';
  renderClickList();
  renderClickMarkers();
  saveProject();
}

// --- Seek ---
function seekTo(timeSec) {
  stopPlaybackLoop();
  isPlaying = false;
  playPauseBtn.textContent = '▶';
  sourceVideo.currentTime = Math.max(0, Math.min(timeSec, sourceVideo.duration || 0));
  sourceVideo.addEventListener('seeked', () => {
    renderFrame(sourceVideo.currentTime);
    updateTimeDisplay(sourceVideo.currentTime);
    updateTimelineProgress(sourceVideo.currentTime);
  }, { once: true });
}

// --- Playback controls ---
function togglePlay() {
  if (sourceVideo.paused) {
    applySegmentsAt(sourceVideo.currentTime);
    sourceVideo.play();
    isPlaying = true;
    playPauseBtn.textContent = '⏸';
    startPlaybackLoop();
  } else {
    sourceVideo.pause();
    isPlaying = false;
    playPauseBtn.textContent = '▶';
    stopPlaybackLoop();
    renderFrame(sourceVideo.currentTime);
  }
}

playPauseBtn.addEventListener('click', togglePlay);

// Space toggles playback (ignored while a slider/checkbox has focus)
const isTypingTarget = el => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';

document.addEventListener('keydown', (e) => {
  if (exportBtn.disabled || isTypingTarget(e.target)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  } else if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  }
});

rewindBtn.addEventListener('click', () => seekTo(0));

timeline.addEventListener('click', (e) => {
  if (e.target.closest('.text-bar') || e.target.closest('.segment-band')) return;
  const rect = timeline.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  seekTo(pct * (sourceVideo.duration || 0));
});

// --- Preview button ---
previewBtn.addEventListener('click', () => {
  seekTo(firstPlayableSec());
  setTimeout(() => {
    sourceVideo.play();
    isPlaying = true;
    playPauseBtn.textContent = '⏸';
    startPlaybackLoop();
  }, 100);
});

// --- Global defaults + camera options ---
function setupDefaultSliders() {
  const map = [
    ['defaultZoom', 'defaultZoomVal', 'zoomLevel', '×', 1],
    ['defaultZoomIn', 'defaultZoomInVal', 'zoomInDuration', 'ms', 0],
    ['defaultHold', 'defaultHoldVal', 'holdDuration', 'ms', 0],
    ['defaultZoomOut', 'defaultZoomOutVal', 'zoomOutDuration', 'ms', 0],
    ['defaultOffset', 'defaultOffsetVal', 'zoomOffset', 'ms', 0],
  ];
  const fmt = (v, unit, dec) => (dec > 0 ? parseFloat(v).toFixed(dec) : Math.round(v)) + unit;

  syncDefaultSliders();
  map.forEach(([id, valId, key, unit, dec]) => {
    const slider = document.getElementById(id);
    const valEl = document.getElementById(valId);
    slider.addEventListener('input', () => {
      defaults[key] = parseFloat(slider.value);
      valEl.textContent = fmt(slider.value, unit, dec);
      chrome.storage.sync.set({ mcrEditorDefaults: defaults });
    });
  });

  document.getElementById('applyDefaultsBtn').addEventListener('click', () => {
    pushHistory();
    clicks.forEach(c => Object.assign(c, pickZoom(defaults)));
    projectChanged();
  });

  // Camera options apply live — no "apply" step needed
  const followEl = document.getElementById('followCursor');
  const mergeEl = document.getElementById('mergeGap');
  syncCameraControls();

  const onCameraChange = () => {
    cameraOptions.followCursor = followEl.checked;
    cameraOptions.mergeGap = parseFloat(mergeEl.value);
    syncCameraControls();
    chrome.storage.sync.set({ mcrCameraOptions: cameraOptions });
    invalidateCamera();
    rerender();
    saveProject();
  };
  followEl.addEventListener('change', onCameraChange);
  mergeEl.addEventListener('pointerdown', pushHistory);
  mergeEl.addEventListener('input', onCameraChange);
}

const DEFAULT_SLIDERS = [
  ['defaultZoom', 'defaultZoomVal', 'zoomLevel', '×', 1],
  ['defaultZoomIn', 'defaultZoomInVal', 'zoomInDuration', 'ms', 0],
  ['defaultHold', 'defaultHoldVal', 'holdDuration', 'ms', 0],
  ['defaultZoomOut', 'defaultZoomOutVal', 'zoomOutDuration', 'ms', 0],
  ['defaultOffset', 'defaultOffsetVal', 'zoomOffset', 'ms', 0],
];

function syncDefaultSliders() {
  for (const [id, valId, key, unit, dec] of DEFAULT_SLIDERS) {
    document.getElementById(id).value = defaults[key];
    document.getElementById(valId).textContent = (dec > 0 ? defaults[key].toFixed(dec) : Math.round(defaults[key])) + unit;
  }
}

function syncCameraControls() {
  document.getElementById('followCursor').checked = cameraOptions.followCursor;
  document.getElementById('mergeGap').value = cameraOptions.mergeGap;
  document.getElementById('mergeGapVal').textContent = Math.round(cameraOptions.mergeGap) + 'ms';
}

// --- Export ---
exportBtn.addEventListener('click', exportVideo);

// --- Export (MediaRecorder) ---
// MP4 (H.264) is accepted by every social/marketing tool; fall back to
// high-bitrate VP9 WebM on Chrome builds that can't record MP4
const EXPORT_MIME_TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp9',
];

async function exportVideo() {
  if (!videoBlob) return;

  exportBtn.disabled = true;
  previewBtn.disabled = true;
  exportOverlay.style.display = 'flex';
  exportFill.style.width = '0%';
  exportPercent.textContent = 'Recording (do not switch tabs)...';

  try {
    // Positioning at the start (after a cut that begins at 0, if any)
    seekTo(firstPlayableSec());
    // Give enough time to ensure UI is ready and the frame is painted
    await new Promise(r => setTimeout(r, 600));

    // Capture the stream at 60 FPS for buttery smooth Marketing videos
    ensureAudioCapture();
    const stream = previewCanvas.captureStream(60);
    audioExportDestination.stream.getAudioTracks().forEach(track => stream.addTrack(track));

    const exportMime = EXPORT_MIME_TYPES.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
    const exportExt = exportMime.startsWith('video/mp4') ? 'mp4' : 'webm';
    // Zoomed frames magnify every compression artefact, so export with a
    // generous bitrate scaled to the canvas size (≈40 Mbps at 1440p60)
    const videoBitsPerSecond = Math.round(Math.min(80_000_000, Math.max(12_000_000,
      previewCanvas.width * previewCanvas.height * 60 * 0.18)));
    const mediaRecorder = new MediaRecorder(stream, {
      mimeType: exportMime,
      videoBitsPerSecond,
      audioBitsPerSecond: 192_000,
    });

    const recordedChunks = [];
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: exportMime.split(';')[0] });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clip-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${exportExt}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      exportOverlay.style.display = 'none';
      exportBtn.disabled = false;
      previewBtn.disabled = false;

      // Keep UI clean
      stopPlaybackLoop();
      playPauseBtn.textContent = '▶';
    };

    // Keep chunks small to handle memory easily
    mediaRecorder.start(100);

    // Run the video in real-time
    if (sourceVideo.paused) {
      sourceVideo.play();
      isPlaying = true;
      playPauseBtn.textContent = '⏸';
      startPlaybackLoop();
    }

    // Progress bar monitor
    const duration = sourceVideo.duration || 1;
    const outTotal = outputDurationMs() || 1;
    const progressInterval = setInterval(() => {
      const pct = Math.min(100, Math.round((toOutputMs(sourceVideo.currentTime * 1000) / outTotal) * 100));
      exportFill.style.width = pct + '%';

      // Stop the recording when the video naturally finishes
      if (sourceVideo.ended || sourceVideo.currentTime >= duration) {
        clearInterval(progressInterval);
        exportFill.style.width = '100%';
        exportPercent.textContent = 'Processing file...';
        if (mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
      } else {
        exportPercent.textContent = pct + '%';
      }
    }, 200);

  } catch (err) {
    console.error('[MCR export] Error:', err);
    exportOverlay.style.display = 'none';
    exportBtn.disabled = false;
    previewBtn.disabled = false;
    alert('Export error: ' + err.message);
  }
}

// --- Init ---
// Waits for overlays.js / texts.js / bridge.js, which load after this file
document.addEventListener('DOMContentLoaded', () => loadData()
  .then(blob => {
    setupDefaultSliders();
    setupSidebarTabs();
    setupTextPanel();
    setupSegmentsPanel();
    setupCursorPanel();
    setupVideo(blob);
    startClaudeBridge();
  })
  .catch(err => {
    loadingMsg.textContent = 'Error: ' + err.message;
  }));
