'use strict';

const MSG = {
  INIT_RECORDING:   'INIT_RECORDING',
  STOP_RECORDING:   'STOP_RECORDING',
  RECORDER_STARTED: 'RECORDER_STARTED',
  RECORDING_READY:  'RECORDING_READY',
  RECORDING_ERROR:  'RECORDING_ERROR',
};

let mediaRecorder = null;
let recordedChunks = [];
let stream = null;
let requestDataInterval = null;
let startDelayTimer = null;
let currentMimeType = 'video/webm';

const MIME_TYPES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function getSupportedMimeType() {
  return MIME_TYPES.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
}

function getExtension(mimeType) {
  return mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
}

// --- IndexedDB ---

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('mcr_db', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('recordings');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveToIndexedDB(blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recordings', 'readwrite');
    tx.objectStore('recordings').put(blob, 'last');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// --- Recording ---

// --- Quality ---
// Capture at the tab's physical pixel size (CSS size × devicePixelRatio) so
// text stays sharp on scaled displays and when the editor zooms in, capped at 4K.
const MAX_CAPTURE_W = 3840;
const MAX_CAPTURE_H = 2160;
const CAPTURE_FPS = 60;
// Screen content needs far more than MediaRecorder's ~2.5 Mbps default to keep
// text crisp during scrolling; scale with pixel count, within sane bounds
const BITS_PER_PIXEL = 0.15;
const MIN_BITRATE = 8_000_000;
const MAX_BITRATE = 60_000_000;

function captureSize(viewport) {
  if (!viewport) return { width: 1920, height: 1080 };
  const dpr = Math.max(1, viewport.dpr || 1);
  const k = Math.min(1, MAX_CAPTURE_W / (viewport.width * dpr), MAX_CAPTURE_H / (viewport.height * dpr));
  // Encoders want even dimensions
  const even = v => Math.max(2, Math.round(v / 2) * 2);
  return { width: even(viewport.width * dpr * k), height: even(viewport.height * dpr * k) };
}

function bitrateFor(width, height, fps) {
  return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, width * height * fps * BITS_PER_PIXEL)));
}

async function startRecording(streamId, config, delayMs = 0, viewport = null) {
  try {
    const size = captureSize(viewport);
    const constraints = {
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxWidth: size.width,
          maxHeight: size.height,
          maxFrameRate: CAPTURE_FPS,
        },
      },
    };
    if (config.audioCaptureEnabled) {
      constraints.audio = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } };
    }

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    currentMimeType = getSupportedMimeType();
    recordedChunks = [];

    const settings = stream.getVideoTracks()[0].getSettings();
    const width = settings.width || size.width;
    const height = settings.height || size.height;
    const videoBitsPerSecond = bitrateFor(width, height, CAPTURE_FPS);
    console.log(`[MCR Offscreen] Capturing ${width}x${height} @ ${settings.frameRate || CAPTURE_FPS}fps, ` +
      `${(videoBitsPerSecond / 1e6).toFixed(1)} Mbps, ${currentMimeType}`);

    mediaRecorder = new MediaRecorder(stream, {
      mimeType: currentMimeType,
      videoBitsPerSecond,
      audioBitsPerSecond: 192_000,
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordedChunks, { type: currentMimeType });
      await saveToIndexedDB(blob);
      chrome.runtime.sendMessage({
        type: MSG.RECORDING_READY,
        mimeType: currentMimeType,
        ext: getExtension(currentMimeType),
      });
      cleanup();
    };

    mediaRecorder.onerror = (e) => {
      console.error('[MCR Offscreen] MediaRecorder error:', e);
      cleanup();
    };

    // Reports the real start so click timestamps can be aligned to the video
    mediaRecorder.onstart = () => {
      chrome.runtime.sendMessage({ type: MSG.RECORDER_STARTED, at: Date.now() });
    };

    // Stream is acquired up front; recording itself waits out the countdown
    await new Promise(r => { startDelayTimer = setTimeout(r, delayMs); });
    startDelayTimer = null;
    if (!mediaRecorder) return; // stopped during countdown

    mediaRecorder.start();
    requestDataInterval = setInterval(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.requestData();
    }, 5000);

  } catch (err) {
    console.error('[MCR Offscreen] startRecording failed:', err);
    cleanup();
    chrome.runtime.sendMessage({ type: MSG.RECORDING_ERROR, error: err.message });
  }
}

function stopRecording() {
  clearTimeout(startDelayTimer);
  startDelayTimer = null;
  clearInterval(requestDataInterval);
  requestDataInterval = null;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    cleanup();
  }
}

function cleanup() {
  clearInterval(requestDataInterval);
  requestDataInterval = null;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  mediaRecorder = null;
  recordedChunks = [];
}

// --- Messages ---

chrome.runtime.onMessage.addListener((message) => {
  // Popup and other pages broadcast STOP_RECORDING too; only obey the
  // background so it can collect the last events before the recorder stops
  if (message.target !== 'offscreen') return;
  if (message.type === MSG.INIT_RECORDING) {
    startRecording(message.streamId, message.config, message.delayMs, message.viewport);
  } else if (message.type === MSG.STOP_RECORDING) {
    stopRecording();
  }
});
