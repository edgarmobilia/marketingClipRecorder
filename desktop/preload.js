'use strict';

// Bridges the pages to the main process:
// - `chrome.storage.session` / `.sync`: the only extension API the editor
//   uses, backed by main so every window sees the same values
// - `mcrDesktop`: recorder controls for desktop/recorder/control.html

const { contextBridge, ipcRenderer } = require('electron');

const area = (name) => ({
  get: (keys) => ipcRenderer.invoke('storage', name, 'get', keys ?? null),
  set: (items) => ipcRenderer.invoke('storage', name, 'set', items),
  remove: (keys) => ipcRenderer.invoke('storage', name, 'remove', keys),
  clear: () => ipcRenderer.invoke('storage', name, 'clear'),
});

// Chromium already defines window.chrome, so exposeInMainWorld('chrome')
// refuses to bind; add .storage to the existing object instead
contextBridge.executeInMainWorld({
  func: (storage) => {
    window.chrome = window.chrome || {};
    window.chrome.storage = storage;
  },
  args: [{ session: area('session'), sync: area('sync') }],
});

contextBridge.exposeInMainWorld('mcrDesktop', {
  listSources: () => ipcRenderer.invoke('list-sources'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  arm: (displayId) => ipcRenderer.invoke('recording-arm', { displayId }),
  started: (at) => ipcRenderer.send('recorder-started', at),
  stopRequested: () => ipcRenderer.invoke('recording-stop-requested'),
  ready: (mimeType, ext) => ipcRenderer.invoke('recording-ready', { mimeType, ext }),
  failed: () => ipcRenderer.invoke('recording-failed'),
  nocursorAvailable: () => ipcRenderer.invoke('nocursor-available'),
  captureStart: (displayId, bitrate) => ipcRenderer.invoke('capture-start', { displayId, bitrate }),
  captureStop: (audio, audioExt, audioStartAt) => ipcRenderer.invoke('capture-stop', { audio, audioExt, audioStartAt }),
  selftestSave: (bytes, ext) => ipcRenderer.invoke('selftest-save', bytes, ext),
  onToggle: (fn) => ipcRenderer.on('toggle-recording', () => fn()),
});
