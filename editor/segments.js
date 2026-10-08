'use strict';

// --- Cuts & speed-ups ---
// A segment is a stretch of the *source* recording that is either removed
// (speed 0) or played faster (speed > 1). Zooms and texts keep using source
// time, so they stay in sync automatically; only playback/export skip or
// fast-forward through segments.
//
// segment: { id, start, end, speed }   // ms in source time

const SPEED_CHOICES = [0, 0.5, 2, 4, 8, 16]; // 0 = cut, 0.5 = slow motion
const MIN_SEGMENT_MS = 200;
const DEFAULT_SEGMENT_MS = 3000;

let segments = [];
let nextSegmentId = 1;
let selectedSegmentId = null;

const segmentListEl = document.getElementById('segmentList');
const segmentCountEl = document.getElementById('segmentCount');
const segmentMarkersEl = document.getElementById('segmentMarkers');
const finalTimeEl = document.getElementById('finalTime');

function speedLabel(speed) {
  return speed === 0 ? 'Cut' : `${speed}×`;
}

// --- Model ---

function normalizeSegment(sg) {
  const durMs = (sourceVideo.duration || Infinity) * 1000;
  sg.start = Math.max(0, Math.round(Number(sg.start) || 0));
  sg.end = Math.min(durMs, Math.round(Number(sg.end) || 0));
  if (sg.end - sg.start < MIN_SEGMENT_MS) sg.end = Math.min(durMs, sg.start + MIN_SEGMENT_MS);
  const sp = Number(sg.speed);
  // 0 = cut, 0.25–0.9 = slow motion, 1.25–16 = fast-forward (1× would be a no-op)
  if (sp === 0) sg.speed = 0;
  else if (sp > 0 && sp < 1) sg.speed = Math.max(0.25, Math.min(0.9, sp));
  else sg.speed = Math.min(16, Math.max(1.25, sp || 4));
  return sg;
}

// Segments may not overlap: a new/moved one is clipped against the others
function clipAgainstOthers(sg) {
  for (const other of segments) {
    if (other.id === sg.id) continue;
    if (sg.start < other.end && sg.end > other.start) {
      if (sg.start >= other.start && sg.end <= other.end) {
        throw new Error(`That range is already inside ${speedLabel(other.speed)} segment ${other.id}`);
      }
      if (sg.start < other.start) sg.end = Math.min(sg.end, other.start);
      else sg.start = Math.max(sg.start, other.end);
    }
  }
  if (sg.end - sg.start < MIN_SEGMENT_MS) throw new Error('Segment would be too short after avoiding overlaps');
}

function sortSegments() {
  segments.sort((a, b) => a.start - b.start);
}

function addSegment({ start, end, speed }) {
  const sg = normalizeSegment({ id: `s${nextSegmentId++}`, start, end, speed });
  clipAgainstOthers(sg);
  pushHistory();
  segments.push(sg);
  sortSegments();
  selectedSegmentId = sg.id;
  projectChanged();
  return sg;
}

function updateSegment(id, patch) {
  const sg = segments.find(s => s.id === id);
  if (!sg) throw new Error(`No segment with id "${id}"`);
  const next = normalizeSegment({ ...sg, ...stripUndefined(patch), id });
  clipAgainstOthers(next);
  pushHistory();
  Object.assign(sg, next);
  sortSegments();
  projectChanged();
  return sg;
}

function removeSegment(id) {
  const i = segments.findIndex(s => s.id === id);
  if (i < 0) throw new Error(`No segment with id "${id}"`);
  pushHistory();
  segments.splice(i, 1);
  if (selectedSegmentId === id) selectedSegmentId = null;
  projectChanged();
}

// Length of the exported video, in ms
function outputDurationMs() {
  const total = (sourceVideo.duration || 0) * 1000;
  return segments.reduce((acc, sg) => {
    const len = sg.end - sg.start;
    return acc - len + (sg.speed === 0 ? 0 : len / sg.speed);
  }, total);
}

// Source time → time in the exported video, in ms
function toOutputMs(srcMs) {
  let out = srcMs;
  for (const sg of segments) {
    if (srcMs <= sg.start) break;
    const covered = Math.min(srcMs, sg.end) - sg.start;
    out -= covered - (sg.speed === 0 ? 0 : covered / sg.speed);
  }
  return out;
}

// Time in the exported video → source time, in ms (inverse of toOutputMs)
function fromOutputMs(outMs) {
  let acc = 0;      // output time used up to prevEnd
  let prevEnd = 0;  // source time where the current 1× stretch begins
  for (const sg of segments) {
    const plain = sg.start - prevEnd;
    if (outMs < acc + plain) return prevEnd + (outMs - acc);
    acc += plain;
    if (sg.speed > 0) {
      const len = (sg.end - sg.start) / sg.speed;
      if (outMs < acc + len) return sg.start + (outMs - acc) * sg.speed;
      acc += len;
    }
    prevEnd = sg.end;
  }
  return prevEnd + (outMs - acc);
}

// --- Idle detection ---
// Stretches with no clicks/typing and an (almost) still cursor are usually
// waiting time: loading, rendering, thinking. Margins keep a little context.

function findIdleRanges({ minMs = 4000, marginMs = 600 } = {}) {
  const durMs = (sourceVideo.duration || 0) * 1000;
  const busy = [];
  for (const c of clicks) busy.push([c.t - 800, c.t + 1200]);
  // Cursor travel above ~1 % of the frame counts as activity
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i];
    if (Math.hypot(b.nx - a.nx, b.ny - a.ny) > 0.01) busy.push([a.t - 300, b.t + 300]);
  }
  busy.sort((p, q) => p[0] - q[0]);

  const ranges = [];
  let cursor = 0;
  for (const [s, e] of busy) {
    if (s > cursor) ranges.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < durMs) ranges.push([cursor, durMs]);

  return ranges
    .map(([s, e]) => [Math.max(0, s + marginMs), Math.min(durMs, e - marginMs)])
    .filter(([s, e]) => e - s >= minMs)
    .filter(([s, e]) => !segments.some(sg => s < sg.end && e > sg.start))
    .map(([s, e]) => ({ start: Math.round(s), end: Math.round(e) }));
}

// --- Playback hook (called every frame while playing / exporting) ---

let speedBadgeUntil = 0;

function applySegmentsAt(timeSec) {
  const tMs = timeSec * 1000;
  const sg = segments.find(s => tMs >= s.start && tMs < s.end);
  if (sg && sg.speed === 0) {
    sourceVideo.currentTime = sg.end / 1000;
    if (sourceVideo.playbackRate !== 1) sourceVideo.playbackRate = 1;
    return;
  }
  const rate = sg ? sg.speed : 1;
  if (sourceVideo.playbackRate !== rate) sourceVideo.playbackRate = rate;
}

// Where playback/export should begin: after any cut that starts the video
function firstPlayableSec() {
  let t = 0;
  for (const sg of segments) {
    if (sg.speed === 0 && sg.start <= t + 1 && sg.end > t) t = sg.end;
  }
  return t / 1000;
}

function resetPlaybackRate() {
  if (sourceVideo.playbackRate !== 1) sourceVideo.playbackRate = 1;
}

// Small "⏩ 8×" badge drawn into the frame while a speed-up plays
function drawSpeedBadge(c, timeSec, view) {
  const tMs = timeSec * 1000;
  // Slow motion is a stylistic choice, not a skip — no badge for it
  const sg = segments.find(s => s.speed > 1 && tMs >= s.start && tMs < s.end);
  if (!sg) return;
  const { W, U } = view;
  const fs = U * 0.03;
  c.save();
  c.font = `700 ${fs}px ${FONT_STACK}`;
  c.textBaseline = 'middle';
  const label = `⏩ ${sg.speed}×`;
  const w = c.measureText(label).width + fs * 1.2, h = fs * 1.8;
  const x = W - w - fs, y = fs;
  c.fillStyle = 'rgba(0,0,0,0.6)';
  roundRect(c, x, y, w, h, h / 2);
  c.fill();
  c.fillStyle = '#fff';
  c.fillText(label, x + fs * 0.6, y + h / 2);
  c.restore();
}

// --- Cuts panel ---

function setupSegmentsPanel() {
  document.getElementById('cutHereBtn').addEventListener('click', () => addAtPlayhead(0));
  document.getElementById('speedHereBtn').addEventListener('click', () => addAtPlayhead(8));
  document.getElementById('autoIdleBtn').addEventListener('click', () => {
    const found = findIdleRanges();
    if (!found.length) { flashSegmentsHint('No idle stretches found (≥ 4 s without clicks or cursor movement).'); return; }
    pushHistory();
    for (const r of found) segments.push(normalizeSegment({ id: `s${nextSegmentId++}`, ...r, speed: 8 }));
    sortSegments();
    projectChanged();
    flashSegmentsHint(`Sped up ${found.length} idle stretch${found.length > 1 ? 'es' : ''} 8×.`);
  });
}

function addAtPlayhead(speed) {
  const now = (sourceVideo.currentTime || 0) * 1000;
  try {
    addSegment({ start: now, end: now + DEFAULT_SEGMENT_MS, speed });
    switchTab('cuts');
  } catch (err) {
    flashSegmentsHint(err.message);
  }
}

function flashSegmentsHint(msg) {
  const el = document.getElementById('segmentsHint');
  el.textContent = msg;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2500);
}

function renderSegmentList() {
  segmentCountEl.textContent = segments.length;
  const out = outputDurationMs() / 1000;
  finalTimeEl.textContent = segments.length ? `→ ${fmtTime(out)} final` : '';
  document.getElementById('segmentsSummary').textContent = segments.length
    ? `Final video: ${fmtTime(out)} (from ${fmtTime(sourceVideo.duration || 0)})`
    : 'Remove or speed up the boring parts — waits, loading, typing.';

  segmentListEl.innerHTML = '';
  for (const sg of segments) {
    const selected = sg.id === selectedSegmentId;
    const item = document.createElement('div');
    item.className = 'event-row' + (selected ? ' active' : '');
    const len = (sg.end - sg.start) / 1000;
    const slow = sg.speed > 0 && sg.speed < 1;
    const saved = sg.speed === 0 ? len : len - len / sg.speed;
    item.innerHTML = `
      <div class="event-head">
        <span class="event-icon">${sg.speed === 0 ? '✂' : slow ? '🐢' : '⏩'}</span>
        <div class="event-main">
          <div class="event-title">${sg.speed === 0 ? 'Cut' : slow ? `Slow motion ${sg.speed}×` : `Speed up ${sg.speed}×`} · ${fmtTime(sg.start / 1000)} – ${fmtTime(sg.end / 1000)}</div>
          <div class="event-sub">${len.toFixed(1)} s → ${slow ? `adds ${(-saved).toFixed(1)}` : `saves ${saved.toFixed(1)}`} s</div>
        </div>
      </div>
      ${selected ? `
      <div class="event-body">
        <div class="chips">${SPEED_CHOICES.map(sp =>
          `<button class="chip seg-speed ${sp === sg.speed ? 'active' : ''}" data-v="${sp}">${speedLabel(sp)}</button>`).join('')}</div>
        <div class="text-row">
          <label>From</label><input type="number" class="seg-start" step="0.1" min="0" value="${(sg.start / 1000).toFixed(1)}">
          <label>to</label><input type="number" class="seg-end" step="0.1" min="0" value="${(sg.end / 1000).toFixed(1)}">
          <label>s</label>
        </div>
        <div class="text-actions">
          <span class="text-hint">Drag the band or its edges on the timeline</span>
          <button class="btn btn-sm btn-danger seg-delete">Delete</button>
        </div>
      </div>` : ''}
    `;
    item.querySelector('.event-head').addEventListener('click', () => {
      selectedSegmentId = selected ? null : sg.id;
      if (!selected) seekTo(Math.max(0, sg.start - 500) / 1000);
      renderSegmentList();
      renderSegmentMarkers();
    });
    if (selected) {
      const guard = fn => { try { fn(); } catch (err) { flashSegmentsHint(err.message); renderSegmentList(); } };
      item.querySelectorAll('.seg-speed').forEach(b => b.addEventListener('click', () =>
        guard(() => updateSegment(sg.id, { speed: Number(b.dataset.v) }))));
      item.querySelector('.seg-start').addEventListener('change', e => guard(() => updateSegment(sg.id, { start: parseFloat(e.target.value) * 1000 })));
      item.querySelector('.seg-end').addEventListener('change', e => guard(() => updateSegment(sg.id, { end: parseFloat(e.target.value) * 1000 })));
      item.querySelector('.seg-delete').addEventListener('click', () => removeSegment(sg.id));
    }
    segmentListEl.appendChild(item);
  }
}

// --- Timeline bands ---

function renderSegmentMarkers() {
  segmentMarkersEl.innerHTML = '';
  if (!sourceVideo.duration) return;
  const total = sourceVideo.duration * 1000;
  for (const sg of segments) {
    const band = document.createElement('div');
    band.className = 'segment-band ' + (sg.speed === 0 ? 'cut' : 'speed') + (sg.id === selectedSegmentId ? ' active' : '');
    band.style.left = (sg.start / total) * 100 + '%';
    band.style.width = ((sg.end - sg.start) / total) * 100 + '%';
    band.title = `${speedLabel(sg.speed)} ${fmtTime(sg.start / 1000)} – ${fmtTime(sg.end / 1000)}`;
    band.innerHTML = `<span class="seg-label">${speedLabel(sg.speed)}</span><i class="seg-edge l"></i><i class="seg-edge r"></i>`;
    band.addEventListener('pointerdown', e => startSegmentDrag(e, sg,
      e.target.classList.contains('l') ? 'start' : e.target.classList.contains('r') ? 'end' : 'move'));
    segmentMarkersEl.appendChild(band);
  }
  renderShotMarkers();
}

function startSegmentDrag(e, sg, mode) {
  e.stopPropagation();
  e.preventDefault();
  pushHistory();
  selectedSegmentId = sg.id;
  switchTab('cuts');
  renderSegmentList();

  const startX = e.clientX;
  const orig = { start: sg.start, end: sg.end };
  const total = sourceVideo.duration * 1000;
  const width = timeline.getBoundingClientRect().width;
  let moved = false;

  const onMove = (ev) => {
    moved = true;
    const dt = ((ev.clientX - startX) / width) * total;
    const next = { ...sg };
    if (mode === 'move') {
      const len = orig.end - orig.start;
      next.start = Math.max(0, Math.min(total - len, orig.start + dt));
      next.end = next.start + len;
    } else if (mode === 'start') {
      next.start = Math.min(orig.end - MIN_SEGMENT_MS, Math.max(0, orig.start + dt));
    } else {
      next.end = Math.max(orig.start + MIN_SEGMENT_MS, Math.min(total, orig.end + dt));
    }
    // Stop at neighbours instead of overlapping them
    const blocked = segments.some(o => o.id !== sg.id && next.start < o.end && next.end > o.start);
    if (blocked) return;
    sg.start = Math.round(next.start);
    sg.end = Math.round(next.end);
    renderSegmentMarkers();
    if (sourceVideo.paused) seekTo((mode === 'end' ? sg.end : sg.start) / 1000);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (!moved) undoStack.pop();
    projectChanged();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}
