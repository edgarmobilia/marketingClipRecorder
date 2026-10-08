'use strict';

const MSG = {
  START_RECORDING:   'START_RECORDING',
  STOP_RECORDING:    'STOP_RECORDING',
  INIT_RECORDING:    'INIT_RECORDING',
  RECORDER_STARTED:  'RECORDER_STARTED',
  RECORDING_STARTED: 'RECORDING_STARTED',
  RECORDING_STOPPED: 'RECORDING_STOPPED',
  RECORDING_READY:   'RECORDING_READY',
  RECORDING_ERROR:   'RECORDING_ERROR',
  CONFIG_UPDATED:    'CONFIG_UPDATED',
  GET_STATE:         'GET_STATE',
  EVENTS_LOGGED:     'EVENTS_LOGGED',
  CONTENT_READY:     'CONTENT_READY',
};

// Single source of truth for recording options (popup and shortcut both use it)
const DEFAULT_CONFIG = {
  audioCaptureEnabled: true,
  countdown: true,
  autoExport: false,
  hideCursor: false,   // beta: video from the DevTools screencast, which has no system cursor
};

const COUNTDOWN_SECONDS = 3;

// --- State (persisted to session storage to survive SW suspension) ---
let recordingTabId = null;
let isRecording = false;
let recordingStartTime = null;
let recordingConfig = null;

const STATE_KEYS = ['recordingTabId', 'isRecording', 'recordingStartTime', 'recordingConfig'];

async function loadState() {
  const data = await chrome.storage.session.get(STATE_KEYS);
  recordingTabId = data.recordingTabId || null;
  isRecording = data.isRecording || false;
  recordingStartTime = data.recordingStartTime || null;
  recordingConfig = data.recordingConfig || null;
}

async function saveState() {
  await chrome.storage.session.set({ recordingTabId, isRecording, recordingStartTime, recordingConfig });
}

async function clearState() {
  recordingTabId = null;
  isRecording = false;
  recordingStartTime = null;
  recordingConfig = null;
  await chrome.storage.session.remove(STATE_KEYS);
}

async function getStoredConfig() {
  const { mcrConfig } = await chrome.storage.sync.get('mcrConfig');
  return Object.assign({}, DEFAULT_CONFIG, mcrConfig);
}

// --- Event log (clicks, typing, cursor moves) ---
// Stored in numbered chunks so each write stays small no matter how long the
// recording is. Writes are serialized so rapid batches are never lost.

let eventWriteChain = Promise.resolve();

function appendEvents(events) {
  eventWriteChain = eventWriteChain.then(async () => {
    const { mcrEventChunks = 0 } = await chrome.storage.session.get('mcrEventChunks');
    await chrome.storage.session.set({
      [`mcrEvents:${mcrEventChunks}`]: events,
      mcrEventChunks: mcrEventChunks + 1,
    });
  }).catch(err => console.error('[MCR] appendEvents error:', err));
  return eventWriteChain;
}

async function readAllEvents() {
  await eventWriteChain;
  const { mcrEventChunks = 0 } = await chrome.storage.session.get('mcrEventChunks');
  const keys = Array.from({ length: mcrEventChunks }, (_, i) => `mcrEvents:${i}`);
  const data = keys.length ? await chrome.storage.session.get(keys) : {};
  return keys.flatMap(k => data[k] || []);
}

async function resetEvents() {
  await eventWriteChain;
  const { mcrEventChunks = 0 } = await chrome.storage.session.get('mcrEventChunks');
  const keys = Array.from({ length: mcrEventChunks }, (_, i) => `mcrEvents:${i}`);
  await chrome.storage.session.remove([...keys, 'mcrEventChunks', 'mcrVideoStartAt']);
}

// --- Toolbar badge (countdown / REC) ---
// The badge lives outside the tab, so it never shows up in the recording.

let countdownTimers = [];

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

function runBadgeCountdown(seconds) {
  clearCountdown();
  for (let i = 0; i < seconds; i++) {
    countdownTimers.push(setTimeout(() => setBadge(String(seconds - i), '#f0a020'), i * 1000));
  }
  countdownTimers.push(setTimeout(() => setBadge('REC', '#e03c3c'), seconds * 1000));
}

function clearCountdown() {
  countdownTimers.forEach(clearTimeout);
  countdownTimers = [];
}

function flashBadgeError() {
  setBadge('ERR', '#888');
  setTimeout(() => setBadge(''), 2500);
}

// --- Offscreen document ---

async function ensureOffscreenDocument() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Recording tab audio and video via tabCapture stream',
    });
  } catch (e) {
    if (!e.message || !e.message.includes('single')) throw e;
  }
}

async function closeOffscreenDocument() {
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) { /* already closed */ }
}

// --- Helpers ---

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch (e) {
    // Page was loaded before the extension — inject into every frame now
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  }
}

// Tab's CSS size and pixel ratio, so the capture can match its physical resolution
async function getViewport(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio }),
    });
    return result;
  } catch (e) {
    console.warn('[MCR] Could not read viewport size:', e.message);
    return null;
  }
}

async function sendToContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    console.warn('[MCR] Could not reach content script in tab', tabId, e.message);
    return null;
  }
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
}

// --- Cursor-free video (beta) ---
// Tab capture always burns the system cursor into the pixels. The DevTools
// screencast (chrome.debugger → Page.startScreencast) sends the page's own
// rendered frames, without the cursor. Frames go to the offscreen recorder
// over a port; tab capture still provides the audio. Chrome shows its
// "is debugging this browser" bar while this runs.

let screencastTarget = null;   // { tabId } while attached
let screencastPort = null;     // port from the offscreen document

const SCREENCAST_OPTIONS = { format: 'jpeg', quality: 88, maxWidth: 3840, maxHeight: 2160, everyNthFrame: 1 };

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'screencast') return;
  screencastPort = port;
  port.onDisconnect.addListener(() => { if (screencastPort === port) screencastPort = null; });
});

async function attachScreencast(tabId) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    throw new Error(`Cannot hide the cursor: ${e.message} (close DevTools on that tab and try again).`);
  }
  screencastTarget = target;
  // Page events let us restart the screencast after navigations
  await chrome.debugger.sendCommand(target, 'Page.enable');
}

async function startScreencastFrames() {
  if (!screencastTarget) return;
  try {
    await chrome.debugger.sendCommand(screencastTarget, 'Page.startScreencast', SCREENCAST_OPTIONS);
  } catch (e) {
    console.warn('[MCR] startScreencast failed:', e.message);
  }
}

async function detachScreencast() {
  const target = screencastTarget;
  screencastTarget = null;
  if (!target) return;
  try { await chrome.debugger.sendCommand(target, 'Page.stopScreencast'); } catch (e) { /* tab gone */ }
  try { await chrome.debugger.detach(target); } catch (e) { /* already detached */ }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!screencastTarget || source.tabId !== screencastTarget.tabId) return;
  if (method === 'Page.screencastFrame') {
    // Chrome sends the next frame only after this one is acknowledged
    chrome.debugger.sendCommand(screencastTarget, 'Page.screencastFrameAck', { sessionId: params.sessionId })
      .catch(() => {});
    screencastPort?.postMessage({ data: params.data, ts: params.metadata.timestamp });
  } else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
    // A new document in the tab: make sure frames keep coming
    startScreencastFrames();
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!screencastTarget || source.tabId !== screencastTarget.tabId) return;
  // e.g. the user pressed "Cancel" on the debugging bar: the video freezes on
  // the last frame, the recording itself (audio, events) carries on
  console.warn('[MCR] Screencast detached:', reason);
  screencastTarget = null;
});

// --- Start recording ---

async function startRecording(config) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error('No active tab found.');
    if (!tab.url || /^(chrome|chrome-extension|edge|about):/.test(tab.url)) {
      throw new Error('Cannot record browser system pages.');
    }

    await ensureOffscreenDocument();
    await ensureContentScript(tab.id);
    await resetEvents();

    // Attach before measuring: the debugging bar it shows shrinks the page
    if (config.hideCursor) {
      await attachScreencast(tab.id);
      await new Promise(r => setTimeout(r, 400));
    }

    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });

    const delayMs = config.countdown ? COUNTDOWN_SECONDS * 1000 : 0;

    recordingTabId = tab.id;
    isRecording = true;
    recordingStartTime = Date.now() + delayMs;
    recordingConfig = config;
    await saveState();

    if (delayMs) runBadgeCountdown(COUNTDOWN_SECONDS);
    else setBadge('REC', '#e03c3c');

    const viewport = await getViewport(tab.id);
    await sendToOffscreen({ type: MSG.INIT_RECORDING, streamId, config, delayMs, viewport });
    // The recorder has connected its port by now; frames start during the countdown
    if (config.hideCursor) await startScreencastFrames();

    await sendToContentScript(tab.id, {
      type: MSG.RECORDING_STARTED,
      config,
      startTime: recordingStartTime,
    });

    return { ok: true, startTime: recordingStartTime };
  } catch (err) {
    console.error('[MCR] startRecording error:', err);
    clearCountdown();
    setBadge('');
    await detachScreencast();
    await closeOffscreenDocument();
    await clearState();
    return { error: err.message };
  }
}

// --- Stop recording ---

async function stopRecording() {
  try {
    const tabId = recordingTabId;
    clearCountdown();
    setBadge('');

    // Content script hands back whatever events it had not flushed yet
    if (tabId) {
      const resp = await sendToContentScript(tabId, { type: MSG.RECORDING_STOPPED });
      if (resp?.events?.length) appendEvents(resp.events);
    }
    await detachScreencast();
    await sendToOffscreen({ type: MSG.STOP_RECORDING });
    await clearState();
    return { ok: true };
  } catch (err) {
    console.error('[MCR] stopRecording error:', err);
    await detachScreencast();
    await clearState();
    return { error: err.message };
  }
}

async function toggleRecording() {
  await loadState();
  const resp = isRecording ? await stopRecording() : await startRecording(await getStoredConfig());
  if (resp.error) flashBadgeError();
  return resp;
}

// --- Open editor after recording is ready ---

async function openEditor(mimeType, ext) {
  const events = await readAllEvents();
  const { mcrVideoStartAt } = await chrome.storage.session.get('mcrVideoStartAt');
  const config = await getStoredConfig();

  // Timestamps are absolute (Date.now()); make them relative to the first
  // recorded video frame so zooms line up exactly with the footage
  const videoStartAt = mcrVideoStartAt || events[0]?.at || Date.now();
  const toRelative = e => ({ ...e, t: e.at - videoStartAt });

  await chrome.storage.session.set({
    mcrEditorClicks: events.filter(e => e.kind !== 'move').map(toRelative).filter(e => e.t >= 0),
    mcrEditorMoves: events.filter(e => e.kind === 'move').map(toRelative).filter(e => e.t >= 0),
    mcrEditorMimeType: mimeType,
    mcrEditorExt: ext,
    mcrEditorAutoExport: !!config.autoExport,
    // New recording: the editor discards the previous project's edits
    mcrEditorFresh: true,
  });
  await resetEvents();

  await chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });

  // Close offscreen doc after editor is opened
  setTimeout(() => closeOffscreenDocument(), 1000);
}

// --- Keyboard shortcut (works from any tab, no popup needed) ---

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-recording') toggleRecording();
});

// --- Message listener ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type } = message;

  if (type === MSG.GET_STATE) {
    loadState().then(() => sendResponse({ isRecording, startTime: recordingStartTime }));
    return true;
  }

  if (type === MSG.START_RECORDING) {
    loadState().then(async () => {
      if (isRecording) { sendResponse({ error: 'A recording is already in progress.' }); return; }
      const config = Object.assign({}, DEFAULT_CONFIG, message.config);
      sendResponse(await startRecording(config));
    });
    return true;
  }

  if (type === MSG.STOP_RECORDING) {
    loadState().then(async () => sendResponse(await stopRecording()));
    return true;
  }

  if (type === MSG.RECORDER_STARTED) {
    chrome.storage.session.set({ mcrVideoStartAt: message.at });
    return false;
  }

  if (type === MSG.RECORDING_READY) {
    openEditor(message.mimeType, message.ext);
    return false;
  }

  if (type === MSG.RECORDING_ERROR) {
    console.error('[MCR] Recording failed in offscreen:', message.error);
    clearCountdown();
    flashBadgeError();
    detachScreencast().then(closeOffscreenDocument).then(() => clearState());
    return false;
  }

  if (type === MSG.EVENTS_LOGGED) {
    loadState().then(() => {
      if (isRecording && sender.tab && sender.tab.id === recordingTabId && message.events?.length) {
        appendEvents(message.events);
      }
    });
    return false;
  }

  if (type === MSG.CONTENT_READY) {
    // A page (re)loaded — resume capture if it's the recording tab
    loadState().then(() => {
      const active = isRecording && sender.tab && sender.tab.id === recordingTabId;
      sendResponse(active
        ? { active: true, config: recordingConfig, startTime: recordingStartTime }
        : { active: false });
    });
    return true;
  }

  if (type === MSG.CONFIG_UPDATED) {
    loadState().then(() => {
      if (isRecording && recordingTabId) {
        recordingConfig = Object.assign({}, recordingConfig, message.config);
        saveState();
        sendToContentScript(recordingTabId, { type: MSG.CONFIG_UPDATED, config: message.config });
      }
    });
    return false;
  }
});
