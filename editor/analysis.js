'use strict';

// --- Video analysis (for Claude's editing decisions) ---
// Samples the recording at low resolution on a separate <video> element (the
// editor's playhead is untouched) and measures how much each sample differs
// from the previous one. From that: scene changes (page loads, navigation,
// modals) and static stretches (nothing on screen moves — real dead time,
// unlike "the cursor is still", which can hide a loading animation).

const ANALYSIS_W = 96;
const ANALYSIS_H = 54;
const SCENE_CHANGE_DIFF = 0.12;  // mean abs luma difference (0–1) that counts as a cut/page change
const STATIC_DIFF = 0.004;       // below this the screen is considered unchanged

let analysisCache = null;        // { fps, samples: [{ t, diff }] }

async function analyzeVideo({ fps = 2 } = {}) {
  fps = Math.min(8, Math.max(0.5, fps));
  if (analysisCache && analysisCache.fps === fps) return analysisCache;

  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = sourceVideo.src;
  await new Promise((res, rej) => {
    v.addEventListener('loadeddata', res, { once: true });
    v.addEventListener('error', () => rej(new Error('Could not load the video for analysis')), { once: true });
  });

  const c = document.createElement('canvas');
  c.width = ANALYSIS_W; c.height = ANALYSIS_H;
  const g = c.getContext('2d', { willReadFrequently: true });
  const dur = sourceVideo.duration;
  const samples = [];
  let prev = null;

  for (let t = 0; t <= dur; t += 1 / fps) {
    await new Promise((res) => {
      const timer = setTimeout(res, 2000);
      v.addEventListener('seeked', () => { clearTimeout(timer); res(); }, { once: true });
      v.currentTime = Math.min(t, dur - 0.01);
    });
    g.drawImage(v, 0, 0, ANALYSIS_W, ANALYSIS_H);
    const px = g.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H).data;
    const luma = new Float32Array(ANALYSIS_W * ANALYSIS_H);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      luma[j] = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
    }
    let diff = 0;
    if (prev) {
      for (let j = 0; j < luma.length; j++) diff += Math.abs(luma[j] - prev[j]);
      diff /= luma.length;
    }
    samples.push({ t: Math.round(t * 1000), diff });
    prev = luma;
  }
  v.removeAttribute('src');
  v.load();

  analysisCache = { fps, samples };
  return analysisCache;
}

function summarizeAnalysis(a, { minStaticSec = 2 } = {}) {
  const step = 1000 / a.fps;
  const sceneChanges = a.samples.filter(s => s.diff >= SCENE_CHANGE_DIFF).map(s => s.t);

  const staticRanges = [];
  let runStart = null;
  for (let i = 1; i <= a.samples.length; i++) {
    const s = a.samples[i];
    const still = s && s.diff < STATIC_DIFF;
    if (still && runStart === null) runStart = a.samples[i - 1].t;
    if (!still && runStart !== null) {
      const end = a.samples[i - 1].t;
      if (end - runStart >= minStaticSec * 1000) staticRanges.push({ start: runStart, end });
      runStart = null;
    }
  }

  // Per-second activity 0–1 (how much the picture changes), handy for pacing
  const perSecond = [];
  const dur = Math.ceil((sourceVideo.duration || 0));
  for (let sec = 0; sec < dur; sec++) {
    const inSec = a.samples.filter(s => s.t >= sec * 1000 && s.t < (sec + 1) * 1000);
    const m = inSec.length ? Math.max(...inSec.map(s => s.diff)) : 0;
    perSecond.push(Math.round(Math.min(1, m / SCENE_CHANGE_DIFF) * 100) / 100);
  }

  return { stepMs: step, sceneChanges, staticRanges, perSecond };
}

// How much the screen changes within [start, end] (0 = frozen) — null if not analysed yet
function screenChangeIn(startMs, endMs) {
  if (!analysisCache) return null;
  const inside = analysisCache.samples.filter(s => s.t > startMs && s.t <= endMs);
  if (!inside.length) return 0;
  return Math.max(...inside.map(s => s.diff));
}
