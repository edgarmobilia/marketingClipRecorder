'use strict';

// --- Director shots ---
// Explicit framing that overrides the automatic camera for a stretch of time:
// a wide shot (scale 1) to show the whole page, or a close-up on a region.
// shot: { id, start, end, x, y, scale, transition }  (ms, 0–1 page coords, ×, ms)
// The data and camera blending live in editor.js (shots, shotWeight).

function normalizeShot(sh) {
  const durMs = (sourceVideo.duration || Infinity) * 1000;
  const clamp01 = v => Math.min(1, Math.max(0, Number(v)));
  sh.start = Math.max(0, Math.round(Number(sh.start) || 0));
  sh.end = Math.min(durMs, Math.max(sh.start + 200, Math.round(Number(sh.end) || 0)));
  sh.x = Number.isFinite(Number(sh.x)) ? clamp01(sh.x) : 0.5;
  sh.y = Number.isFinite(Number(sh.y)) ? clamp01(sh.y) : 0.5;
  sh.scale = Math.min(4, Math.max(1, Number(sh.scale) || 1));
  sh.transition = Math.min(3000, Math.max(0, Number.isFinite(Number(sh.transition)) ? Number(sh.transition) : 600));
  return sh;
}

function addShot(params) {
  const sh = normalizeShot({ id: `c${nextShotId++}`, ...stripUndefined(params) });
  pushHistory();
  shots.push(sh);
  shots.sort((a, b) => a.start - b.start);
  projectChanged();
  return sh;
}

function updateShot(id, patch) {
  const sh = shots.find(s => s.id === id);
  if (!sh) throw new Error(`No shot with id "${id}"`);
  pushHistory();
  Object.assign(sh, stripUndefined(patch), { id });
  normalizeShot(sh);
  shots.sort((a, b) => a.start - b.start);
  projectChanged();
  return sh;
}

function removeShot(id) {
  const i = shots.findIndex(s => s.id === id);
  if (i < 0) throw new Error(`No shot with id "${id}"`);
  pushHistory();
  shots.splice(i, 1);
  projectChanged();
}

// Shown on the timeline next to cuts so the user sees what the director did
function renderShotMarkers() {
  if (!sourceVideo.duration) return;
  const total = sourceVideo.duration * 1000;
  for (const sh of shots) {
    const band = document.createElement('div');
    band.className = 'segment-band shot';
    band.style.left = (sh.start / total) * 100 + '%';
    band.style.width = ((sh.end - sh.start) / total) * 100 + '%';
    band.title = `Camera shot ${sh.scale === 1 ? 'wide' : sh.scale.toFixed(1) + '×'} · ${fmtTime(sh.start / 1000)} – ${fmtTime(sh.end / 1000)}`;
    band.innerHTML = `<span class="seg-label">🎥 ${sh.scale === 1 ? 'wide' : sh.scale.toFixed(1) + '×'}</span>`;
    band.addEventListener('pointerdown', e => { e.stopPropagation(); seekTo(sh.start / 1000); });
    segmentMarkersEl.appendChild(band);
  }
}
