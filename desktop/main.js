'use strict';

// Marketing Clip Recorder — Windows desktop app (prototype).
//
// The Chrome extension records with tabCapture, which never sees anything
// Chrome draws as a separate OS window: native <select> popups, alert/confirm
// dialogs, file pickers, popups and new windows. This app records the whole
// monitor instead, logs clicks/typing/cursor moves with a global hook, and
// opens the very same editor (../editor) with a small chrome.storage shim.

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const events = require('./events');
const capture = require('./ffmpeg-capture');

const ROOT = path.resolve(__dirname, '..');   // repo root: editor/, icons/, desktop/
const APP_ORIGIN = 'app://local';
const SELFTEST = process.argv.includes('--selftest');
// Selftest never touches the real settings or recordings
if (SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), 'mcr-desktop-selftest'));

const DEFAULT_CONFIG = {
  audioCaptureEnabled: true,
  countdown: true,
  autoExport: false,
  hideCursor: false,   // video from ffmpeg ddagrab, without the system cursor
  sourceId: null,
};

// --- Storage (backs the editor's chrome.storage.session / .sync) ---
// session lives as long as the app; sync is persisted to a JSON file.

const sessionStore = new Map();
let syncStore = null;
const syncFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSync() {
  if (syncStore) return syncStore;
  try { syncStore = new Map(Object.entries(JSON.parse(fs.readFileSync(syncFile(), 'utf8')))); }
  catch (e) { syncStore = new Map(); }
  return syncStore;
}

let syncSaveTimer = null;
function saveSync() {
  clearTimeout(syncSaveTimer);
  syncSaveTimer = setTimeout(() => {
    fs.writeFileSync(syncFile(), JSON.stringify(Object.fromEntries(loadSync()), null, 2));
  }, 200);
}

function storageArea(name) {
  return name === 'sync' ? loadSync() : sessionStore;
}

// Same semantics as chrome.storage: get(null | key | [keys] | {key: default})
function storageGet(store, keys) {
  if (keys == null) return Object.fromEntries(store);
  if (typeof keys === 'string') keys = [keys];
  const out = {};
  if (Array.isArray(keys)) {
    for (const k of keys) if (store.has(k)) out[k] = store.get(k);
  } else {
    for (const [k, def] of Object.entries(keys)) out[k] = store.has(k) ? store.get(k) : def;
  }
  return out;
}

ipcMain.handle('storage', (e, area, op, arg) => {
  const store = storageArea(area);
  if (op === 'get') return storageGet(store, arg);
  if (op === 'set') for (const [k, v] of Object.entries(arg || {})) store.set(k, v);
  if (op === 'remove') for (const k of [].concat(arg)) store.delete(k);
  if (op === 'clear') store.clear();
  if (area === 'sync' && op !== 'get') saveSync();
  return undefined;
});

function getConfig() {
  return { ...DEFAULT_CONFIG, ...loadSync().get('mcrDesktopConfig') };
}

// --- app:// protocol ---
// Recorder and editor share one origin, so they share the IndexedDB where the
// recording is stored (exactly like the extension's pages do).

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

const CAPTURE_URL_PATH = '/__capture/last.mp4';
let lastCaptureFile = null;

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    // Finished cursor-free capture, fetched by the recorder into IndexedDB
    if (pathname === CAPTURE_URL_PATH) {
      if (!lastCaptureFile) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(lastCaptureFile).toString());
    }
    const file = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
    if (!file.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

// --- Windows ---

let controlWin = null;
let editorWin = null;

// Window states for the control window: a picker before recording, a small
// floating pill while recording (hidden from the capture itself)
const SETUP_SIZE = { width: 560, height: 560 };
const PILL_SIZE = { width: 300, height: 56 };

function createControlWindow() {
  controlWin = new BrowserWindow({
    ...SETUP_SIZE,
    resizable: false,
    maximizable: false,
    frame: false,
    title: 'Marketing Clip Recorder',
    icon: path.join(ROOT, 'icons', 'icon128.png'),
    autoHideMenuBar: true,
    backgroundColor: '#15161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The recorder keeps encoding while the window is small/unfocused
      backgroundThrottling: false,
    },
  });
  // WDA_EXCLUDEFROMCAPTURE on Windows 10 2004+: the control window (countdown,
  // stop button) never appears in the recording, even on the recorded screen
  controlWin.setContentProtection(true);
  if (SELFTEST) controlWin.webContents.on('console-message', (e) => console.log(`[control:${e.level}] ${e.message}`));
  controlWin.loadURL(`${APP_ORIGIN}/desktop/recorder/control.html${SELFTEST ? `?selftest=1${process.argv.includes('--nocursor') ? '&nocursor=1' : ''}` : ''}`);
  // Closing the window mid-recording stops and saves instead of losing the clip
  controlWin.on('close', (e) => {
    if (!recording) return;
    e.preventDefault();
    controlWin.webContents.send('toggle-recording');
  });
  controlWin.on('closed', () => { controlWin = null; if (!editorWin) app.quit(); });
}

function openEditor() {
  if (editorWin && !editorWin.isDestroyed()) {
    editorWin.reload();
    editorWin.show();
    editorWin.focus();
    return;
  }
  editorWin = new BrowserWindow({
    width: 1600,
    height: 960,
    title: 'Clip Editor',
    icon: path.join(ROOT, 'icons', 'icon128.png'),
    autoHideMenuBar: true,
    backgroundColor: '#15161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
    },
  });
  editorWin.maximize();
  editorWin.loadURL(`${APP_ORIGIN}/editor/editor.html`);
  editorWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  editorWin.on('closed', () => { editorWin = null; if (!controlWin) app.quit(); });
  if (SELFTEST) selftestEditor(editorWin);
}

// Exports are saved straight to Videos\Marketing Clip Recorder (no dialog),
// the way the extension drops them in Downloads
function setupDownloads(ses) {
  ses.on('will-download', (e, item) => {
    const dir = path.join(app.getPath('videos'), 'Marketing Clip Recorder');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, item.getFilename());
    item.setSavePath(file);
    item.once('done', (ev, state) => {
      if (state === 'completed') shell.showItemInFolder(file);
    });
  });
}

// --- Capture sources ---

ipcMain.handle('list-sources', async () => {
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } });
  return sources.map((s, i) => {
    const display = displays.find(d => String(d.id) === s.display_id) || displays[i] || displays[0];
    return {
      id: s.id,
      name: displays.length > 1 ? `Pantalla ${i + 1}${display.id === primaryId ? ' (principal)' : ''}` : 'Pantalla completa',
      thumbnail: s.thumbnail.toDataURL(),
      displayId: display.id,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
    };
  });
});

ipcMain.handle('get-config', () => getConfig());
ipcMain.handle('set-config', (e, patch) => {
  loadSync().set('mcrDesktopConfig', { ...getConfig(), ...patch });
  saveSync();
});

// --- Recording lifecycle ---
// The renderer owns MediaRecorder; main owns the input hook and the window.

let recording = null;   // { displayId, startedAt }

function displayById(id) {
  return screen.getAllDisplays().find(d => d.id === id) || screen.getPrimaryDisplay();
}

function setPill(on) {
  if (!controlWin) return;
  if (on) {
    const area = displayById(recording.displayId).workArea;
    controlWin.setAlwaysOnTop(true, 'screen-saver');
    controlWin.setBounds({
      x: Math.round(area.x + (area.width - PILL_SIZE.width) / 2),
      y: area.y + 12,
      ...PILL_SIZE,
    });
  } else {
    controlWin.setAlwaysOnTop(false);
    controlWin.setBounds({ ...controlWin.getBounds(), ...SETUP_SIZE });
    controlWin.center();
  }
}

ipcMain.handle('recording-arm', (e, { displayId }) => {
  recording = { displayId, startedAt: null };
  setPill(true);
  // Hook starts with the countdown; events before the first frame are dropped later
  events.start({
    display: displayById(displayId),
    ignoreRect: () => controlWin && controlWin.getBounds(),
  });
});

ipcMain.on('recorder-started', (e, at) => {
  if (recording) recording.startedAt = at;
  const out = SELFTEST && process.env.MCR_SELFTEST_OUT;
  if (out) fs.writeFileSync(path.join(out, 'started'), String(at));
});

ipcMain.handle('recording-stop-requested', () => {
  events.stop();
});

ipcMain.handle('recording-ready', async (e, { mimeType, ext }) => {
  const log = events.stop();
  const startAt = recording?.startedAt || log[0]?.at || Date.now();
  recording = null;
  setPill(false);

  const toRelative = ev => ({ ...ev, t: ev.at - startAt });
  const config = getConfig();
  sessionStore.set('mcrEditorClicks', log.filter(ev => ev.kind !== 'move').map(toRelative).filter(ev => ev.t >= 0));
  sessionStore.set('mcrEditorMoves', log.filter(ev => ev.kind === 'move').map(toRelative).filter(ev => ev.t >= 0));
  sessionStore.set('mcrEditorMimeType', mimeType);
  sessionStore.set('mcrEditorExt', ext);
  sessionStore.set('mcrEditorAutoExport', !!config.autoExport);
  sessionStore.set('mcrEditorFresh', true);

  if (SELFTEST) {
    const out = process.env.MCR_SELFTEST_OUT;
    if (out) fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(log.map(toRelative), null, 2));
  }
  openEditor();
});

// --- Cursor-free capture (ffmpeg) ---

ipcMain.handle('nocursor-available', () => capture.probe());

ipcMain.handle('capture-start', async (e, { displayId, bitrate }) => {
  // ddagrab numbers monitors like Windows does; with one monitor it is always 0
  const outputIdx = Math.max(0, screen.getAllDisplays().findIndex(d => d.id === displayId));
  const at = await capture.start({ outputIdx, bitrate });
  if (recording) recording.startedAt = at;
  return at;
});

// Stops ffmpeg, adds the audio the renderer recorded, and hands back a URL
ipcMain.handle('capture-stop', async (e, { audio, audioExt, audioStartAt }) => {
  const cap = await capture.stop();
  if (!cap) throw new Error('No había captura en marcha');
  let file = cap.file;
  if (audio && audioStartAt) {
    const audioFile = cap.file.replace(/\.mp4$/, `.${audioExt || 'webm'}`);
    fs.writeFileSync(audioFile, Buffer.from(audio));
    try {
      file = await capture.mux(cap.file, audioFile, audioStartAt - cap.startAt);
    } catch (err) {
      console.warn('[MCR] Audio could not be added, keeping video only:', err.message);
    }
  }
  if (recording) recording.startedAt = cap.startAt;
  lastCaptureFile = file;
  return `${APP_ORIGIN}${CAPTURE_URL_PATH}?t=${Date.now()}`;
});

ipcMain.handle('recording-failed', () => {
  capture.stop().catch(() => {});
  events.stop();
  recording = null;
  setPill(false);
});

// Test hook: the renderer hands over the raw recording so it can be inspected
ipcMain.handle('selftest-save', (e, bytes, ext) => {
  const out = process.env.MCR_SELFTEST_OUT;
  if (out) fs.writeFileSync(path.join(out, `recording.${ext}`), Buffer.from(bytes));
});

// Selftest target: a plain window with a native <select>, which the test
// script clicks open — the popup it shows is what tab capture never saw
function selftestTarget() {
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({ x: area.x + 80, y: area.y + 120, width: 480, height: 360, autoHideMenuBar: true, title: 'MCR selftest' });
  win.setAlwaysOnTop(true);
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadURL('data:text/html,' + encodeURIComponent(
    '<body style="font:16px Segoe UI;padding:24px;background:#fff">' +
    '<select id=s style="font-size:18px;width:300px">' +
    ['Opción uno', 'Opción dos', 'Opción tres', 'Opción cuatro', 'Opción cinco'].map(o => `<option>${o}</option>`).join('') +
    '</select><p><input placeholder="Escribe aquí" style="font-size:18px"></p></body>'));
  win.webContents.once('did-finish-load', async () => {
    const rect = await win.webContents.executeJavaScript(
      'JSON.parse(JSON.stringify({ select: s.getBoundingClientRect(), input: document.querySelector("input").getBoundingClientRect() }))');
    const content = win.getContentBounds();
    const sf = screen.getPrimaryDisplay().scaleFactor;
    const toScreen = r => ({ x: Math.round((content.x + r.x + r.width / 2) * sf), y: Math.round((content.y + r.y + r.height / 2) * sf) });
    const out = process.env.MCR_SELFTEST_OUT;
    if (out) fs.writeFileSync(path.join(out, 'target.json'), JSON.stringify({
      select: toScreen(rect.select), input: toScreen(rect.input), scaleFactor: sf,
    }));
  });
}

function selftestEditor(win) {
  const out = process.env.MCR_SELFTEST_OUT;
  const logs = [];
  win.webContents.on('console-message', (e) => logs.push(`[${e.level}] ${e.message}`));
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      if (out) {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(out, 'editor.png'), img.toPNG());
        const state = await win.webContents.executeJavaScript(
          `({ clicks: typeof clicks !== 'undefined' ? clicks.length : null,
              moves: typeof moves !== 'undefined' ? moves.length : null,
              duration: document.querySelector('video')?.duration ?? null,
              size: [document.querySelector('video')?.videoWidth, document.querySelector('video')?.videoHeight] })`
        ).catch(err => ({ error: err.message }));
        fs.writeFileSync(path.join(out, 'editor.json'), JSON.stringify({ state, logs }, null, 2));
      }
      app.quit();
    }, 4000);
  });
}

// --- Global shortcut: Alt+S toggles recording, as in the extension ---

function registerShortcut() {
  const ok = globalShortcut.register('Alt+S', () => controlWin?.webContents.send('toggle-recording'));
  if (!ok) console.warn('[MCR] Alt+S is taken by another app');
}

app.whenReady().then(() => {
  registerAppProtocol();
  setupDownloads(require('electron').session.defaultSession);
  if (SELFTEST) selftestTarget();
  createControlWindow();
  registerShortcut();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  events.stop();
});

app.on('window-all-closed', () => app.quit());
