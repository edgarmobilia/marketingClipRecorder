'use strict';

// Wrapped so a second injection (scripting.executeScript on a page that
// already has the script) is a no-op instead of a redeclaration error
(() => {
  if (window.__mcrContentLoaded) return;
  window.__mcrContentLoaded = true;

  const MSG = {
    RECORDING_STARTED: 'RECORDING_STARTED',
    RECORDING_STOPPED: 'RECORDING_STOPPED',
    CONFIG_UPDATED:    'CONFIG_UPDATED',
    EVENTS_LOGGED:     'EVENTS_LOGGED',
    CONTENT_READY:     'CONTENT_READY',
  };

  const FRAME_MSG_KEY = '__mcrFrameEvent';

  const MOVE_SAMPLE_MS = 50;    // cursor sampled at ~20 Hz
  const FLUSH_MS       = 500;   // batch sent to background twice per second
  const TYPE_EVERY_MS  = 1500;  // one "typing" focus event per field per 1.5 s

  const isTop = window.top === window;

  let isActive = false;
  let config = null;
  let buffer = [];
  let flushTimer = null;
  let lastMoveAt = 0;
  let lastTypeAt = new WeakMap();

  // --- Activate / deactivate ---

  function activate(cfg) {
    if (isActive) return;
    config = cfg || {};
    isActive = true;
    buffer = [];
    lastTypeAt = new WeakMap();
    // Capture phase on window runs before any page handler can call
    // stopPropagation(), and pointerdown fires even when 'click' is swallowed
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('keydown', onKeyDown, true);
    if (isTop) flushTimer = setInterval(flush, FLUSH_MS);
  }

  function deactivate() {
    if (!isActive) return [];
    isActive = false;
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('keydown', onKeyDown, true);
    clearInterval(flushTimer);
    flushTimer = null;
    const pending = buffer;
    buffer = [];
    return pending;
  }

  // --- Event capture ---

  function onPointerDown(e) {
    if (!isActive || !e.isPrimary || e.button !== 0) return;
    emit({ kind: 'click', at: Date.now(), x: e.clientX, y: e.clientY, ...describeTarget(e) });
  }

  function onPointerMove(e) {
    if (!isActive || !e.isPrimary) return;
    const now = Date.now();
    if (now - lastMoveAt < MOVE_SAMPLE_MS) return;
    lastMoveAt = now;
    emit({ kind: 'move', at: now, x: e.clientX, y: e.clientY });
  }

  function onKeyDown(e) {
    if (!isActive || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = editableTarget(e);
    if (!el) return;
    const now = Date.now();
    if (now - (lastTypeAt.get(el) || 0) < TYPE_EVERY_MS) return;
    lastTypeAt.set(el, now);

    // Focus point: start of the field (where the text appears), kept on screen
    const r = el.getBoundingClientRect();
    const x = Math.min(window.innerWidth,  Math.max(0, r.left + Math.min(r.width / 2, 160)));
    const y = Math.min(window.innerHeight, Math.max(0, r.top + Math.min(r.height / 2, 40)));
    emit({ kind: 'type', at: now, x, y, ...describeElement(el) });
  }

  // --- What was interacted with ---
  // A short human-readable description (never field values) so the editor —
  // and an assistant working through the MCP bridge — knows what each click did.

  const INTERACTIVE = 'a, button, input, select, textarea, summary, label, [role="button"], [role="link"], ' +
    '[role="tab"], [role="menuitem"], [role="checkbox"], [role="option"], [onclick], [contenteditable="true"]';

  function describeTarget(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    const leaf = path.find(n => n instanceof Element);
    if (!leaf) return {};
    const el = leaf.closest(INTERACTIVE) || leaf;
    return describeElement(el);
  }

  function describeElement(el) {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag);
    let label = el.getAttribute('aria-label');
    if (!label && el.labels && el.labels.length) label = el.labels[0].innerText;
    if (!label && /^(input|textarea|select)$/.test(tag)) {
      label = el.getAttribute('placeholder') || el.getAttribute('name') ||
        (['button', 'submit', 'reset'].includes(el.type) ? el.value : '');
    }
    if (!label) label = el.innerText || el.getAttribute('title') || el.getAttribute('alt');
    const r = el.getBoundingClientRect();
    return {
      label: clean(label),
      role,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    };
  }

  function editableTarget(e) {
    const el = e.composedPath ? e.composedPath()[0] : e.target;
    if (!(el instanceof Element)) return null;
    if (el.isContentEditable) return el;
    if (el.tagName === 'TEXTAREA') return el;
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(type) ? el : null;
    }
    return null;
  }

  // --- Routing: subframes forward to their parent, top frame batches ---

  function emit(evt) {
    if (isTop) {
      const page = evt.kind === 'move' ? undefined : document.title.slice(0, 80);
      buffer.push({ ...evt, vw: window.innerWidth, vh: window.innerHeight, ...(page && { page }) });
    } else {
      window.parent.postMessage({ [FRAME_MSG_KEY]: evt }, '*');
    }
  }

  // Events from a child frame arrive in that frame's coordinates; offset them
  // by the iframe's position in this document before passing them on
  window.addEventListener('message', (e) => {
    const evt = e.data && e.data[FRAME_MSG_KEY];
    if (!evt || !isActive) return;
    const frame = Array.from(document.querySelectorAll('iframe, frame'))
      .find(f => f.contentWindow === e.source);
    if (!frame) return;
    const r = frame.getBoundingClientRect();
    const ox = r.left + frame.clientLeft, oy = r.top + frame.clientTop;
    const rect = evt.rect && { ...evt.rect, x: evt.rect.x + ox, y: evt.rect.y + oy };
    emit({ ...evt, x: evt.x + ox, y: evt.y + oy, ...(rect && { rect }) });
  });

  function flush() {
    if (!buffer.length) return;
    const events = buffer;
    buffer = [];
    chrome.runtime.sendMessage({ type: MSG.EVENTS_LOGGED, events }).catch(() => {});
  }

  // --- Messages ---

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'PING') {
      if (isTop) sendResponse({ ok: true });
      return;
    }
    if (message.type === MSG.RECORDING_STARTED) {
      activate(message.config);
    } else if (message.type === MSG.RECORDING_STOPPED) {
      const events = deactivate();
      // Only the top frame answers, handing back its unsent batch
      if (isTop) sendResponse({ events });
    }
  });

  // --- Resume after navigation ---
  // A fresh page load in the recording tab asks the background whether it
  // should be capturing events.

  chrome.runtime.sendMessage({ type: MSG.CONTENT_READY }).then((resp) => {
    if (resp && resp.active) activate(resp.config);
  }).catch(() => {});

  // Don't lose the last half second of events when the page unloads
  window.addEventListener('pagehide', () => { if (isActive && isTop) flush(); });
})();
