'use strict';

// Must match DEFAULT_CONFIG in background.js
const DEFAULT_CONFIG = {
  audioCaptureEnabled: true,
  countdown: true,
  autoExport: false,
  hideCursor: false,
};

const OPTION_KEYS = Object.keys(DEFAULT_CONFIG);

// --- DOM refs ---
const recordBtn = document.getElementById('recordBtn');
const btnLabel = document.getElementById('btnLabel');
const btnIcon = document.getElementById('btnIcon');
const statusDot = document.getElementById('statusDot');
const timerEl = document.getElementById('timer');
const statusMsg = document.getElementById('statusMsg');
const optionInputs = Object.fromEntries(OPTION_KEYS.map(k => [k, document.getElementById(k)]));

// --- State ---
let isRecording = false;
let timerInterval = null;
let startTime = null;

function readConfig() {
  return Object.fromEntries(OPTION_KEYS.map(k => [k, optionInputs[k].checked]));
}

// --- Init ---
async function init() {
  const { mcrConfig } = await chrome.storage.sync.get('mcrConfig');
  const config = Object.assign({}, DEFAULT_CONFIG, mcrConfig);
  OPTION_KEYS.forEach(k => { optionInputs[k].checked = !!config[k]; });

  // Check recording state from background
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp && resp.isRecording) {
      setRecordingUI(true, resp.startTime);
    }
  });
}

// Options are saved as soon as they change
OPTION_KEYS.forEach(k => optionInputs[k].addEventListener('change', async () => {
  const config = readConfig();
  await chrome.storage.sync.set({ mcrConfig: config });

  // Update in real-time if already recording
  if (isRecording) {
    chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED', config });
  }
}));

// --- Recording UI state ---
function setRecordingUI(recording, recordStartTime = null) {
  isRecording = recording;

  if (recording) {
    recordBtn.classList.add('stop');
    btnIcon.textContent = '⏹';
    btnLabel.textContent = 'Stop';
    statusDot.classList.add('recording');
    timerEl.classList.add('recording');
    startTime = recordStartTime || Date.now();
    timerInterval = setInterval(updateTimer, 500);
    updateTimer();
    setStatus('Recording...', '');
  } else {
    recordBtn.classList.remove('stop');
    btnIcon.textContent = '⏺';
    btnLabel.textContent = 'Record';
    statusDot.classList.remove('recording');
    timerEl.classList.remove('recording');
    clearInterval(timerInterval);
    timerEl.textContent = '00:00';
    startTime = null;
  }
}

function updateTimer() {
  if (!startTime) return;
  const elapsed = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  timerEl.textContent = `${mm}:${ss}`;
}

function setStatus(msg, type = '') {
  statusMsg.textContent = msg;
  statusMsg.className = 'status-msg' + (type ? ` ${type}` : '');
}

// --- Button click ---
recordBtn.addEventListener('click', async () => {
  if (isRecording) {
    recordBtn.disabled = true;
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, (resp) => {
      recordBtn.disabled = false;
      if (chrome.runtime.lastError || (resp && resp.error)) {
        const err = (resp && resp.error) || chrome.runtime.lastError.message;
        setStatus('Error stopping: ' + err, 'error');
        return;
      }
      setRecordingUI(false);
      setStatus('Processing — the editor will open shortly.', 'success');
    });
  } else {
    recordBtn.disabled = true;
    setStatus('Starting...', '');

    const config = readConfig();
    await chrome.storage.sync.set({ mcrConfig: config });

    chrome.runtime.sendMessage({ type: 'START_RECORDING', config }, (resp) => {
      recordBtn.disabled = false;
      if (chrome.runtime.lastError || (resp && resp.error)) {
        const err = (resp && resp.error) || chrome.runtime.lastError.message;
        setStatus('Error: ' + err, 'error');
        return;
      }
      setRecordingUI(true, resp.startTime);
      // Get out of the way — the toolbar badge shows the countdown and REC
      setTimeout(() => window.close(), 400);
    });
  }
});

init();
