'use strict';

// Global input log while recording: clicks, typing and cursor moves anywhere
// on the recorded monitor — inside the browser, a native dialog, a <select>
// popup or another app. Same event shape as the extension's content.js
// ({ kind, at, x, y, vw, vh }), with x/y relative to the recorded monitor in
// DIPs, so the editor needs no changes.
//
// Positions always come from screen.getCursorScreenPoint() (DIPs, like the
// display bounds) instead of the hook's own coordinates, which are physical
// pixels on scaled displays.

const { screen } = require('electron');

const MOVE_SAMPLE_MS = 50;    // cursor sampled at ~20 Hz, as in content.js
const TYPE_EVERY_MS  = 1500;  // one "typing" focus event per field per 1.5 s
const TYPE_AT_CLICK_MS = 30_000; // typing is placed on the last click if it was this recent

let hook = null;
let hookError = null;
try {
  hook = require('uiohook-napi');
} catch (e) {
  hookError = e;
  console.warn('[MCR] uiohook-napi unavailable, recording cursor moves only:', e.message);
}

// Keys that are not text entry (navigation, function, modifiers)
const NON_TYPING = new Set();
if (hook) {
  const K = hook.UiohookKey;
  for (const name of [
    'Escape', 'Tab', 'Enter', 'NumpadEnter', 'CapsLock', 'Shift', 'ShiftRight', 'Ctrl', 'CtrlRight', 'Alt', 'AltRight', 'Meta', 'MetaRight',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Insert',
    'PrintScreen', 'ScrollLock', 'NumLock',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  ]) {
    if (K[name] != null) NON_TYPING.add(K[name]);
  }
}

let log = [];
let active = null;   // { display, ignoreRect, moveTimer, lastMove, lastClick, lastTypeAt }

function inside(p, r) {
  return r && p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

// Cursor position relative to the recorded monitor, or null when it is on
// another monitor. Clicks and typing on our own control pill are not part of
// the demo (skipPill); moves over it still are, or the drawn cursor would
// freeze while the real one heads for the stop button.
function cursorOnDisplay(skipPill = true) {
  const p = screen.getCursorScreenPoint();
  const { bounds } = active.display;
  if (!inside(p, bounds) || (skipPill && inside(p, active.ignoreRect()))) return null;
  return { x: p.x - bounds.x, y: p.y - bounds.y };
}

function emit(evt) {
  const { width, height } = active.display.bounds;
  log.push({ ...evt, vw: width, vh: height });
}

function onMouseDown(e) {
  if (!active || e.button !== 1) return;   // 1 = left button
  const p = cursorOnDisplay();
  if (!p) return;
  const at = Date.now();
  active.lastClick = { ...p, at };
  emit({ kind: 'click', at, ...p });
}

function onKeyDown(e) {
  if (!active || e.ctrlKey || e.altKey || e.metaKey || NON_TYPING.has(e.keycode)) return;
  const at = Date.now();
  if (at - active.lastTypeAt < TYPE_EVERY_MS) return;
  // The field being typed in is almost always the one clicked last
  const c = active.lastClick;
  const p = c && at - c.at < TYPE_AT_CLICK_MS ? { x: c.x, y: c.y } : cursorOnDisplay();
  if (!p) return;
  active.lastTypeAt = at;
  emit({ kind: 'type', at, ...p });
}

function sampleMove() {
  const p = cursorOnDisplay(false);
  if (!p) return;
  const last = active.lastMove;
  if (last && last.x === p.x && last.y === p.y) return;
  active.lastMove = p;
  emit({ kind: 'move', at: Date.now(), ...p });
}

function start({ display, ignoreRect }) {
  stop();
  log = [];
  active = { display, ignoreRect, lastMove: null, lastClick: null, lastTypeAt: 0 };
  active.moveTimer = setInterval(sampleMove, MOVE_SAMPLE_MS);
  if (hook) {
    hook.uIOhook.on('mousedown', onMouseDown);
    hook.uIOhook.on('keydown', onKeyDown);
    hook.uIOhook.start();
  }
}

// Stops logging and returns everything logged since start()
function stop() {
  if (active) {
    clearInterval(active.moveTimer);
    if (hook) {
      hook.uIOhook.off('mousedown', onMouseDown);
      hook.uIOhook.off('keydown', onKeyDown);
      try { hook.uIOhook.stop(); } catch (e) { /* not running */ }
    }
    active = null;
  }
  return log;
}

module.exports = { start, stop, hookAvailable: () => !!hook, hookError: () => hookError };
