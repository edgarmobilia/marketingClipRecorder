'use strict';

// --- Prototype: record a tab without the system cursor ---
// Tab capture (chrome.tabCapture) always composites the mouse cursor into the
// video and no constraint turns it off. Page.startScreencast (DevTools
// protocol, via chrome.debugger) returns the page's rendered frames, which
// should not include the cursor layer. This page measures whether that holds
// and what the frames look like: rate, gaps, resolution, size.
//
// Screencast frames are damage-driven: a still page sends no frames, so the
// stats separate "gaps while idle" from real dropped frames only by eye —
// move the mouse and scroll during the test.

const $ = id => document.getElementById(id);
const MAX_FRAMES = 2400; // memory guard (~40 s at 60 fps)

let target = null;      // { tabId } while attached
let frames = [];        // { data, ts, recvAt, meta }
let stopTimer = null;

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const setStatus = msg => { $('status').textContent = msg; };

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  $('tab').innerHTML = tabs
    // Normal pages, plus this extension's own motion test page
    .filter(t => /^https?:|^file:/.test(t.url || '') || (t.url || '').startsWith(chrome.runtime.getURL('experiments/animated.html')))
    .map(t => `<option value="${t.id}">${escapeHtml(t.title || t.url)}</option>`)
    .join('');
}

// --- Capture ---

async function start() {
  const tabId = Number($('tab').value);
  if (!tabId) return setStatus('Open a normal web page in another tab first.');
  // 'debugger' cannot be an optional permission, so the manifest requires it
  if (!chrome.debugger) return setStatus('Reload the extension: the debugger permission is missing.');

  $('start').disabled = true;
  $('results').classList.add('hidden');
  frames = [];
  target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
    chrome.debugger.onEvent.addListener(onEvent);
    chrome.debugger.onDetach.addListener(onDetach);

    // Ask for the tab's physical pixel size, like the tabCapture recorder does
    const { result } = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: 'JSON.stringify([innerWidth, innerHeight, devicePixelRatio])',
      returnByValue: true,
    });
    const [w, h, dpr] = JSON.parse(result.value);
    const scale = Number($('scale').value) || 1;
    await chrome.debugger.sendCommand(target, 'Page.startScreencast', {
      format: $('format').value,
      quality: Math.min(100, Math.max(30, Number($('quality').value) || 90)),
      maxWidth: Math.round(w * dpr * scale),
      maxHeight: Math.round(h * dpr * scale),
      everyNthFrame: 1,
    });

    // Bring the tab forward: screencast only produces frames for a visible page
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });

    const seconds = Math.min(30, Math.max(2, Number($('seconds').value) || 8));
    setStatus(`Capturing for ${seconds} s — move the mouse over the page…`);
    stopTimer = setTimeout(stop, seconds * 1000);
  } catch (err) {
    setStatus('Could not start: ' + err.message);
    await detach();
    $('start').disabled = false;
  }
}

function onEvent(source, method, params) {
  if (!target || source.tabId !== target.tabId || method !== 'Page.screencastFrame') return;
  // Chrome sends the next frame only after the previous one is acknowledged
  chrome.debugger.sendCommand(target, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  if (frames.length < MAX_FRAMES) {
    frames.push({ data: params.data, ts: params.metadata.timestamp, recvAt: performance.now(), meta: params.metadata });
  }
  setStatus(`Capturing… ${frames.length} frames`);
}

function onDetach(source, reason) {
  if (!target || source.tabId !== target.tabId) return;
  // e.g. the user clicked "Cancel" on the debugging bar, or closed the tab
  clearTimeout(stopTimer);
  target = null;
  finish(`Detached by Chrome (${reason}).`);
}

async function stop() {
  if (!target) return;
  try { await chrome.debugger.sendCommand(target, 'Page.stopScreencast'); } catch { /* tab gone */ }
  await detach();
  // Come back here to show the results
  const me = await chrome.tabs.getCurrent();
  if (me) {
    await chrome.tabs.update(me.id, { active: true });
    await chrome.windows.update(me.windowId, { focused: true });
  }
  finish('Done.');
}

async function detach() {
  chrome.debugger.onEvent.removeListener(onEvent);
  chrome.debugger.onDetach.removeListener(onDetach);
  if (target) {
    const t = target;
    target = null;
    try { await chrome.debugger.detach(t); } catch { /* already detached */ }
  }
}

// --- Results ---

const mime = () => ($('format').value === 'png' ? 'image/png' : 'image/jpeg');
const frameUrl = f => `data:${mime()};base64,${f.data}`;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function finish(msg) {
  $('start').disabled = false;
  if (!frames.length) {
    setStatus(msg + ' No frames arrived — was the tab visible?');
    return;
  }
  setStatus(msg);

  const first = await loadImage(frameUrl(frames[0]));
  const span = frames[frames.length - 1].ts - frames[0].ts;
  const gaps = frames.slice(1).map((f, i) => (f.ts - frames[i].ts) * 1000);
  const sorted = [...gaps].sort((a, b) => a - b);
  const pct = p => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
  const bytes = frames.reduce((n, f) => n + f.data.length * 0.75, 0);
  const m = frames[0].meta;

  const rows = [
    ['Frames', frames.length + (frames.length >= MAX_FRAMES ? ' (capped)' : '')],
    ['Span', `${span.toFixed(2)} s`],
    ['Average rate', `${span > 0 ? ((frames.length - 1) / span).toFixed(1) : '—'} fps`],
    ['Gap median / p90 / max', `${pct(0.5).toFixed(0)} / ${pct(0.9).toFixed(0)} / ${(sorted.at(-1) || 0).toFixed(0)} ms`],
    ['Gaps > 100 ms', gaps.filter(g => g > 100).length],
    ['Image size', `${first.naturalWidth} × ${first.naturalHeight} px`],
    ['Page (CSS px)', `${m.deviceWidth} × ${m.deviceHeight}, scale ${m.pageScaleFactor}`],
    ['Data', `${(bytes / 1e6).toFixed(1)} MB (${(bytes / Math.max(span, 0.001) / 1e6).toFixed(1)} MB/s)`],
  ];
  $('stats').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${escapeHtml(v)}</td></tr>`).join('');

  // Evenly spaced sample at full size: look for the cursor in these
  const n = Math.min(12, frames.length);
  const picks = Array.from({ length: n }, (_, i) => frames[Math.round(i * (frames.length - 1) / Math.max(1, n - 1))]);
  $('strip').innerHTML = picks.map(f =>
    `<figure><a href="${frameUrl(f)}" target="_blank"><img src="${frameUrl(f)}"></a>` +
    `<figcaption>${(f.ts - frames[0].ts).toFixed(2)} s</figcaption></figure>`).join('');

  $('video').classList.add('hidden');
  $('download').classList.add('hidden');
  $('results').classList.remove('hidden');
}

// Replays the frames at their own timestamps into a canvas and records it,
// holding each frame until the next one (what a real recorder would do)
async function rebuild() {
  if (!frames.length) return;
  $('rebuild').disabled = true;
  setStatus('Decoding frames…');
  const images = [];
  for (const f of frames) images.push(await loadImage(frameUrl(f)));

  const canvas = document.createElement('canvas');
  canvas.width = images[0].naturalWidth;
  canvas.height = images[0].naturalHeight;
  const g = canvas.getContext('2d');
  g.drawImage(images[0], 0, 0);

  const stream = canvas.captureStream(60);
  const type = ['video/webm;codecs=vp9', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 20_000_000 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(r => { rec.onstop = r; });
  rec.start(250);

  setStatus('Rebuilding in real time…');
  const t0 = performance.now();
  const base = frames[0].ts;
  let i = 0;
  await new Promise((resolve) => {
    const tick = () => {
      const now = (performance.now() - t0) / 1000;
      while (i + 1 < frames.length && frames[i + 1].ts - base <= now) i++;
      g.drawImage(images[i], 0, 0, canvas.width, canvas.height);
      if (i + 1 < frames.length) requestAnimationFrame(tick);
      else setTimeout(resolve, 300);
    };
    requestAnimationFrame(tick);
  });
  rec.stop();
  await done;

  const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
  $('video').src = url;
  $('video').classList.remove('hidden');
  $('download').href = url;
  $('download').classList.remove('hidden');
  $('rebuild').disabled = false;
  setStatus('Rebuilt. Play it and look for the cursor.');
}

$('openTest').addEventListener('click', async () => {
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('experiments/animated.html'), active: false });
  await listTabs();
  $('tab').value = String(tab.id);
});
$('refresh').addEventListener('click', listTabs);
$('start').addEventListener('click', start);
$('rebuild').addEventListener('click', rebuild);
listTabs();
