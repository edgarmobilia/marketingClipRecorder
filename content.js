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
    window.addEventListener('mousedown', onSelectMouseDown, true);
    window.addEventListener('keydown', onSelectKeyDown, true);
    if (isTop) flushTimer = setInterval(flush, FLUSH_MS);
  }

  function deactivate() {
    if (!isActive) return [];
    isActive = false;
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('mousedown', onSelectMouseDown, true);
    window.removeEventListener('keydown', onSelectKeyDown, true);
    closeSelectPopup();
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

  // --- Visible <select> dropdowns ---
  // Chrome draws a native <select> popup as a separate OS window outside the
  // page, so tab capture never sees it. While recording, an in-page list that
  // looks and behaves like the native one opens instead; picking an option sets
  // the real <select> and fires input/change, so the page can't tell.

  const POPUP_CSS = `
    :host { all: initial; }
    .list {
      position: fixed; box-sizing: border-box; overflow-y: auto; padding: 3px 0;
      background: #fff; color: #1f1f1f; border: 1px solid #a8a8b3; border-radius: 4px;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
    }
    .opt, .group { padding: 4px 10px; white-space: nowrap; cursor: default; }
    .group { font-weight: 700; color: #1f1f1f; }
    .opt.in-group { padding-left: 22px; }
    .opt.active { background: #1a73e8; color: #fff; }
    .opt.disabled { color: #a0a0a0; }
  `;

  let selectPopup = null; // { host, list, select, items, active }
  let typeahead = { text: '', at: 0 };

  function isNativeDropdown(el) {
    return el instanceof HTMLSelectElement && !el.multiple && el.size <= 1 && !el.disabled;
  }

  function onSelectMouseDown(e) {
    if (!isActive || e.button !== 0) return;
    const path = e.composedPath ? e.composedPath() : [e.target];
    if (selectPopup && path.includes(selectPopup.host)) return;
    const sel = path.find(n => n instanceof HTMLSelectElement);
    // A click anywhere else closes the list, like the native popup
    const wasOpenOn = selectPopup && selectPopup.select;
    closeSelectPopup();
    if (!sel || !isNativeDropdown(sel)) return;
    e.preventDefault(); // stops the native (invisible) popup
    if (wasOpenOn === sel) return; // second click on the same select closes it
    sel.focus({ preventScroll: true });
    openSelectPopup(sel);
  }

  function openSelectPopup(sel) {
    const cs = getComputedStyle(sel);
    const host = document.createElement('div');
    host.setAttribute('data-mcr-select-popup', '');
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = POPUP_CSS;
    const list = document.createElement('div');
    list.className = 'list';
    list.setAttribute('role', 'listbox');
    list.style.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;

    const items = []; // { el, index, disabled }
    const addOption = (opt, inGroup, groupDisabled) => {
      if (opt.hidden) return;
      const el = document.createElement('div');
      const disabled = opt.disabled || groupDisabled;
      el.className = 'opt' + (inGroup ? ' in-group' : '') + (disabled ? ' disabled' : '');
      el.setAttribute('role', 'option');
      el.textContent = opt.label || opt.text || ' ';
      const item = { el, index: opt.index, disabled };
      el.addEventListener('mousemove', () => { if (!disabled) setActive(items.indexOf(item)); });
      el.addEventListener('click', () => { if (!disabled) chooseOption(opt.index); });
      items.push(item);
      list.appendChild(el);
    };
    for (const child of sel.children) {
      if (child instanceof HTMLOptGroupElement) {
        const g = document.createElement('div');
        g.className = 'group';
        g.textContent = child.label;
        list.appendChild(g);
        for (const opt of child.children) if (opt instanceof HTMLOptionElement) addOption(opt, true, child.disabled);
      } else if (child instanceof HTMLOptionElement) {
        addOption(child, false, false);
      }
    }
    // Keep focus on the <select> while clicking in the list
    list.addEventListener('mousedown', e => e.preventDefault());

    root.append(style, list);
    document.documentElement.appendChild(host);
    selectPopup = { host, list, select: sel, items, active: -1 };

    // Below the select, or above when there is clearly more room there
    const r = sel.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 6;
    const above = r.top - 6;
    list.style.minWidth = r.width + 'px';
    list.style.left = '0px';
    list.style.top = '0px';
    const natural = list.scrollHeight + 2;
    const placeAbove = natural > below && above > below;
    const maxH = Math.max(80, Math.min(natural, placeAbove ? above : below, 420));
    list.style.maxHeight = maxH + 'px';
    const h = Math.min(natural, maxH);
    list.style.top = (placeAbove ? r.top - h : r.bottom) + 'px';
    list.style.left = Math.max(4, Math.min(r.left, window.innerWidth - list.offsetWidth - 4)) + 'px';

    setActive(items.findIndex(it => it.index === sel.selectedIndex));
    window.addEventListener('scroll', onPageScroll, true);
    window.addEventListener('resize', closeSelectPopup);
    window.addEventListener('blur', closeSelectPopup);
    sel.addEventListener('blur', closeSelectPopup);
  }

  function setActive(i) {
    const p = selectPopup;
    if (!p) return;
    if (p.active >= 0 && p.items[p.active]) p.items[p.active].el.classList.remove('active');
    p.active = i;
    const it = p.items[i];
    if (!it) return;
    it.el.classList.add('active');
    // Scroll inside the list only, never the page
    const top = it.el.offsetTop, bottom = top + it.el.offsetHeight;
    if (top < p.list.scrollTop) p.list.scrollTop = top;
    else if (bottom > p.list.scrollTop + p.list.clientHeight) p.list.scrollTop = bottom - p.list.clientHeight;
  }

  function chooseOption(index) {
    const sel = selectPopup && selectPopup.select;
    closeSelectPopup();
    if (!sel) return;
    sel.focus({ preventScroll: true });
    if (sel.selectedIndex === index) return;
    sel.selectedIndex = index;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function closeSelectPopup() {
    const p = selectPopup;
    if (!p) return;
    selectPopup = null;
    window.removeEventListener('scroll', onPageScroll, true);
    window.removeEventListener('resize', closeSelectPopup);
    window.removeEventListener('blur', closeSelectPopup);
    p.select.removeEventListener('blur', closeSelectPopup);
    p.host.remove();
  }

  function onPageScroll(e) {
    if (selectPopup && !e.composedPath().includes(selectPopup.host)) closeSelectPopup();
  }

  function nextEnabled(from, step) {
    const items = selectPopup.items;
    for (let i = from + step; i >= 0 && i < items.length; i += step) if (!items[i].disabled) return i;
    return from;
  }

  function onSelectKeyDown(e) {
    if (!isActive) return;
    const p = selectPopup;
    if (!p) {
      // Keys that open the native popup open ours instead
      const sel = e.composedPath ? e.composedPath()[0] : e.target;
      const opens = e.key === ' ' || e.key === 'F4' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'));
      if (opens && isNativeDropdown(sel)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        openSelectPopup(sel);
      }
      return;
    }
    const n = p.items.length;
    const typing = Date.now() - typeahead.at < 800;
    let handled = true;
    if (e.key === 'Escape' || e.key === 'Tab') closeSelectPopup();
    else if (e.key === 'Enter' || (e.key === ' ' && !typing) || (e.altKey && /^Arrow(Up|Down)$/.test(e.key))) {
      if (p.items[p.active]) chooseOption(p.items[p.active].index); else closeSelectPopup();
    }
    else if (e.key === 'ArrowDown') setActive(nextEnabled(p.active, 1));
    else if (e.key === 'ArrowUp') setActive(nextEnabled(Math.max(p.active, 0), -1));
    else if (e.key === 'PageDown') setActive(nextEnabled(Math.min(n - 1, p.active + 9), 1));
    else if (e.key === 'PageUp') setActive(nextEnabled(Math.max(0, p.active - 9), -1));
    else if (e.key === 'Home') setActive(nextEnabled(-1, 1));
    else if (e.key === 'End') setActive(nextEnabled(n, -1));
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      // Type-to-find, like the native list
      const now = Date.now();
      typeahead = { text: (typing ? typeahead.text : '') + e.key.toLowerCase(), at: now };
      const match = i => !p.items[i].disabled && p.items[i].el.textContent.trim().toLowerCase().startsWith(typeahead.text);
      for (let k = 1; k <= n; k++) {
        const i = (Math.max(p.active, 0) + (typeahead.text.length > 1 ? k - 1 : k)) % n;
        if (match(i)) { setActive(i); break; }
      }
    }
    else handled = false;
    if (handled) {
      // The page must not also react to these keys on the <select>
      e.preventDefault();
      e.stopImmediatePropagation();
    }
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
