'use strict';

// Recorder: captures a whole monitor with MediaRecorder and stores the result
// in IndexedDB ('mcr_db' / 'recordings' / 'last'), where the editor reads it —
// same storage and encoding settings as the extension's offscreen.js.

const COUNTDOWN_SECONDS = 3;

const MIME_TYPES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const MAX_CAPTURE_W = 3840;
const MAX_CAPTURE_H = 2160;
const CAPTURE_FPS = 60;
const BITS_PER_PIXEL = 0.15;
const MIN_BITRATE = 8_000_000;
const MAX_BITRATE = 60_000_000;

const SELFTEST = new URLSearchParams(location.search).has('selftest');
const SELFTEST_NOCURSOR = new URLSearchParams(location.search).has('nocursor');
const SELFTEST_SECONDS = 7;

const $ = (id) => document.getElementById(id);

let sources = [];
let config = null;
let session = null;   // { stream, recorder, chunks, mimeType, timers } — or, cursor-free: { ffmpeg, audioRec, audioChunks, ... }
let nocursor = { ok: false, error: 'comprobando…' };

// --- Setup view ---

async function init() {
  config = await mcrDesktop.getConfig();
  $('optAudio').checked = config.audioCaptureEnabled;
  $('optCountdown').checked = config.countdown;
  $('optAutoExport').checked = config.autoExport;
  $('optHideCursor').checked = config.hideCursor;
  for (const [id, key] of [['optAudio', 'audioCaptureEnabled'], ['optCountdown', 'countdown'],
    ['optAutoExport', 'autoExport'], ['optHideCursor', 'hideCursor']]) {
    $(id).addEventListener('change', () => saveConfig({ [key]: $(id).checked }));
  }
  $('recordBtn').addEventListener('click', toggle);
  $('stopBtn').addEventListener('click', toggle);
  $('closeBtn').addEventListener('click', () => (session ? stopRecording() : window.close()));
  mcrDesktop.onToggle(toggle);

  await refreshSources();
  await checkNoCursor();
  if (SELFTEST) setTimeout(() => startRecording({ countdown: false, ...(SELFTEST_NOCURSOR && { hideCursor: true }) }), 1500);
}

// Cursor-free recording needs ffmpeg with a working screen grabber
async function checkNoCursor() {
  nocursor = await mcrDesktop.nocursorAvailable();
  $('optHideCursor').disabled = !nocursor.ok;
  $('hideCursorNote').textContent = nocursor.ok ? '' : `(${nocursor.error})`;
  $('hideCursorLabel').title = nocursor.ok
    ? `Graba con ffmpeg (${nocursor.encoder}); el editor dibuja su propio cursor`
    : nocursor.error;
}

function saveConfig(patch) {
  Object.assign(config, patch);
  mcrDesktop.setConfig(patch);
}

async function refreshSources() {
  sources = await mcrDesktop.listSources();
  if (!sources.some(s => s.id === config.sourceId)) config.sourceId = sources[0]?.id || null;
  const box = $('sources');
  box.replaceChildren(...sources.map(s => {
    const btn = document.createElement('button');
    btn.className = 'source' + (s.id === config.sourceId ? ' selected' : '');
    const img = document.createElement('img');
    img.src = s.thumbnail;
    const label = document.createElement('span');
    label.textContent = `${s.name} · ${Math.round(s.bounds.width * s.scaleFactor)}×${Math.round(s.bounds.height * s.scaleFactor)}`;
    btn.append(img, label);
    btn.addEventListener('click', () => {
      saveConfig({ sourceId: s.id });
      box.querySelectorAll('.source').forEach(b => b.classList.toggle('selected', b === btn));
    });
    return btn;
  }));
  $('recordBtn').disabled = !sources.length;
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
}

function showView(recording) {
  $('setup').hidden = recording;
  $('pill').hidden = !recording;
}

// --- Recording ---

function captureSize(source) {
  const w = source.bounds.width * source.scaleFactor;
  const h = source.bounds.height * source.scaleFactor;
  const k = Math.min(1, MAX_CAPTURE_W / w, MAX_CAPTURE_H / h);
  const even = v => Math.max(2, Math.round(v / 2) * 2);
  return { width: even(w * k), height: even(h * k) };
}

function bitrateFor(width, height, fps) {
  return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, width * height * fps * BITS_PER_PIXEL)));
}

async function getStream(source, withAudio) {
  const size = captureSize(source);
  const video = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: source.id,
      minWidth: size.width,
      maxWidth: size.width,
      minHeight: size.height,
      maxHeight: size.height,
      maxFrameRate: CAPTURE_FPS,
    },
  };
  if (withAudio) {
    try {
      // System audio (loopback) — Windows only, which is all this app targets
      return await navigator.mediaDevices.getUserMedia({ video, audio: { mandatory: { chromeMediaSource: 'desktop' } } });
    } catch (e) {
      console.warn('[MCR] System audio unavailable, recording video only:', e.message);
    }
  }
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

function toggle() {
  if (session) stopRecording();
  else startRecording();
}

async function startRecording(overrides = {}) {
  if (session) return;
  showError('');
  const source = sources.find(s => s.id === config.sourceId) || sources[0];
  if (!source) { showError('No hay pantallas disponibles.'); return; }
  const opts = { ...config, ...overrides };

  const s = session = { chunks: [], timers: [], ffmpeg: !!opts.hideCursor && nocursor.ok };
  try {
    await mcrDesktop.arm(source.displayId);
    showView(true);
    setPill('wait', opts.countdown ? String(COUNTDOWN_SECONDS) : '…');
    if (session.ffmpeg) return await startCursorless(source, opts);

    const stream = await getStream(source, opts.audioCaptureEnabled);
    const mimeType = MIME_TYPES.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
    const settings = stream.getVideoTracks()[0].getSettings();
    const videoBitsPerSecond = bitrateFor(settings.width, settings.height, CAPTURE_FPS);
    console.log(`[MCR] Capturing ${settings.width}x${settings.height} @ ${settings.frameRate}fps, ` +
      `${(videoBitsPerSecond / 1e6).toFixed(1)} Mbps, ${mimeType}`);

    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond, audioBitsPerSecond: 192_000 });
    Object.assign(session, { stream, recorder, mimeType });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) session.chunks.push(e.data); };
    recorder.onstart = () => {
      mcrDesktop.started(Date.now());
      startClock();
    };
    recorder.onstop = () => finish(session);
    recorder.onerror = (e) => fail(e.error?.message || 'Error del grabador');

    if (!await countdown(opts)) return;
    recorder.start(5000);
    if (SELFTEST) setTimeout(stopRecording, SELFTEST_SECONDS * 1000);
  } catch (err) {
    // Cancelled during start-up (e.g. ffmpeg stopped before its first frame): not an error
    if (session === s) fail(err.message);
  }
}

// Countdown runs in the pill, which is excluded from the capture.
// Returns false when the recording was stopped meanwhile.
async function countdown(opts) {
  const s = session;
  if (!opts.countdown) return true;
  for (let i = COUNTDOWN_SECONDS; i > 0; i--) {
    setPill('wait', String(i));
    await new Promise(r => s.timers.push(setTimeout(r, 1000)));
    if (session !== s) return false;
  }
  return true;
}

// --- Cursor-free recording ---
// ffmpeg (main process) grabs the video without the system cursor; system
// audio is recorded here and muxed in when the recording stops.

async function startCursorless(source, opts) {
  const s = session;
  if (opts.audioCaptureEnabled) {
    try {
      const stream = await getStream(source, true);
      stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t); });
      if (stream.getAudioTracks().length) {
        s.stream = stream;
        s.audioChunks = [];
        s.audioRec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 192_000 });
        s.audioRec.ondataavailable = (e) => { if (e.data && e.data.size > 0) s.audioChunks.push(e.data); };
        s.audioRec.onstart = () => { s.audioStartAt = Date.now(); };
      }
    } catch (e) {
      console.warn('[MCR] System audio unavailable, recording video only:', e.message);
    }
  }
  if (!await countdown(opts)) return;

  // Audio first, so it covers the first video frame; the mux trims the lead-in
  s.audioRec?.start(1000);
  const { width, height } = captureSize(source);
  await mcrDesktop.captureStart(source.displayId, bitrateFor(width, height, CAPTURE_FPS));
  if (session !== s) return;
  s.capturing = true;
  console.log(`[MCR] Capturing ${width}x${height} without cursor (ffmpeg ${nocursor.encoder})`);
  startClock();
  if (SELFTEST) setTimeout(stopRecording, SELFTEST_SECONDS * 1000);
}

async function finishCursorless(s) {
  try {
    let audio = null;
    if (s.audioRec && s.audioRec.state !== 'inactive') {
      await new Promise(r => { s.audioRec.onstop = r; s.audioRec.stop(); });
      audio = new Uint8Array(await new Blob(s.audioChunks, { type: 'audio/webm' }).arrayBuffer());
    }
    const url = await mcrDesktop.captureStop(audio, 'webm', audio ? s.audioStartAt : null);
    const blob = new Blob([await (await fetch(url)).blob()], { type: 'video/mp4' });
    await idbPut('last', blob);
    if (SELFTEST) await mcrDesktop.selftestSave(new Uint8Array(await blob.arrayBuffer()), 'mp4');
    cleanup();
    showView(false);
    await mcrDesktop.ready('video/mp4', 'mp4');
  } catch (err) {
    fail(err.message);
  }
}

function startClock() {
  const t0 = performance.now();
  const tick = () => {
    const s = Math.floor((performance.now() - t0) / 1000);
    setPill('live', `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
  };
  tick();
  session.timers.push(setInterval(tick, 500));
}

function setPill(state, text) {
  $('recDot').classList.toggle('live', state === 'live');
  $('pillText').textContent = text;
}

function stopRecording() {
  const s = session;
  if (!s || s.saving) return;   // a second Alt+S while saving must not drop the clip
  mcrDesktop.stopRequested();
  if (s.ffmpeg && s.capturing) {
    s.saving = true;
    setPill('wait', 'Guardando…');
    finishCursorless(s);
  } else if (s.recorder && s.recorder.state !== 'inactive') {
    s.saving = true;
    setPill('wait', 'Guardando…');
    s.recorder.stop();
  } else {
    // Stopped during the countdown: nothing recorded
    cleanup();
    mcrDesktop.failed();
    showView(false);
  }
}

async function finish(s) {
  try {
    const blob = new Blob(s.chunks, { type: s.mimeType });
    const ext = s.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
    await idbPut('last', blob);
    if (SELFTEST) await mcrDesktop.selftestSave(new Uint8Array(await blob.arrayBuffer()), ext);
    cleanup();
    showView(false);
    await mcrDesktop.ready(s.mimeType, ext);
  } catch (err) {
    fail(err.message);
  }
}

function fail(msg) {
  console.error('[MCR] Recording failed:', msg);
  cleanup();
  mcrDesktop.failed();
  showView(false);
  showError(`No se pudo grabar: ${msg}`);
}

function cleanup() {
  if (!session) return;
  session.timers.forEach(t => { clearTimeout(t); clearInterval(t); });
  session.stream?.getTracks().forEach(t => t.stop());
  session = null;
}

// --- IndexedDB (shared with the editor through the app:// origin) ---

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('mcr_db', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('recordings');
    req.onsuccess = e => resolve(e.target.result);
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

init();
