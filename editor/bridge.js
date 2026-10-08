'use strict';

// --- Claude bridge ---
// Connects the editor to the local MCP server (mcp/server.js) over a
// localhost WebSocket so Claude can inspect frames and edit the project.
// The server sends { id, method, params }; we answer { id, result } or { id, error }.

const BRIDGE_URL = 'ws://127.0.0.1:47821/editor';
const RETRY_MS = 3000;

const claudeStatusEl = document.getElementById('claudeStatus');
let bridgeSocket = null;

function startClaudeBridge() {
  connectBridge();
}

function setClaudeStatus(state, text) {
  claudeStatusEl.className = 'claude-status' + (state ? ' ' + state : '');
  claudeStatusEl.textContent = text;
}

function connectBridge() {
  let ws;
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch (e) {
    setTimeout(connectBridge, RETRY_MS);
    return;
  }
  bridgeSocket = ws;

  ws.addEventListener('open', () => {
    setClaudeStatus('online', 'Claude: connected');
    ws.send(JSON.stringify({ type: 'hello', app: 'mcr-editor', version: 1 }));
  });

  ws.addEventListener('message', async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (!msg || msg.id === undefined || !msg.method) return;

    setClaudeStatus('busy', `Claude: ${msg.method.replace(/_/g, ' ')}…`);
    try {
      const handler = BRIDGE_METHODS[msg.method];
      if (!handler) throw new Error(`Unknown method "${msg.method}"`);
      if (!editorReady) throw new Error('The editor is still loading the recording; try again in a moment.');
      if (exportBtn.disabled && !['get_project', 'get_status'].includes(msg.method)) {
        throw new Error('An export is in progress; wait for it to finish.');
      }
      const result = await handler(msg.params || {});
      ws.send(JSON.stringify({ id: msg.id, result }));
    } catch (err) {
      ws.send(JSON.stringify({ id: msg.id, error: { message: err.message || String(err) } }));
    } finally {
      if (ws.readyState === WebSocket.OPEN) setClaudeStatus('online', 'Claude: connected');
    }
  });

  ws.addEventListener('close', () => {
    if (bridgeSocket === ws) bridgeSocket = null;
    setClaudeStatus('', 'Claude: offline');
    setTimeout(connectBridge, RETRY_MS);
  });
  // 'error' is always followed by 'close', which handles the retry
}

// --- Serialization (editor units → API units: seconds, 0–1 coordinates) ---

const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

function serializeEvent(c, i) {
  const vw = c.vw || 1, vh = c.vh || 1;
  return {
    index: i,
    kind: c.kind,
    t_sec: round(c.t / 1000),
    x: round(c.nx), y: round(c.ny),
    label: c.label || null,
    role: c.role || null,
    page: c.page || null,
    element_rect: c.rect
      ? { x: round(c.rect.x / vw), y: round(c.rect.y / vh), w: round(c.rect.w / vw), h: round(c.rect.h / vh) }
      : null,
    enabled: c.enabled,
    ...(c.kind === 'click' && { click_effect: c.effect !== false }),
    zoom: {
      level: round(zoomLevelOf(c), 2),   // effective level actually used
      auto: cameraOptions.autoZoom && c.zoomAuto !== false && !!c.rect,
      in_ms: c.zoomInDuration,
      hold_ms: c.holdDuration,
      out_ms: c.zoomOutDuration,
      offset_ms: c.zoomOffset || 0,
    },
  };
}

function serializeText(o) {
  return {
    id: o.id,
    text: o.text,
    start_sec: round(o.start / 1000),
    end_sec: round(o.end / 1000),
    style: o.style,
    x: round(o.x), y: round(o.y),
    ...(o.style === 'highlight' && { w: round(o.w), h: round(o.h) }),
    anchor: o.anchor,
    animation: o.animation,
    size: o.size,
    accent: o.accent,
    // Only the overrides; everything else comes from the style preset
    design: Object.fromEntries(Object.entries(o.design).map(([k, v]) => [DESIGN_API_NAMES[k], v])),
  };
}

// API (snake_case) ↔ overlay design keys
const DESIGN_API_NAMES = {
  background: 'background',
  gradient: 'background_gradient',
  gradientAngle: 'gradient_angle',
  textColor: 'text_color',
  borderColor: 'border_color',
  borderWidth: 'border_width',
  radius: 'radius',
  paddingX: 'padding_x',
  paddingY: 'padding_y',
  fontFamily: 'font_family',
  fontWeight: 'font_weight',
  fontSize: 'font_size',
  italic: 'italic',
  uppercase: 'uppercase',
  letterSpacing: 'letter_spacing',
  lineHeight: 'line_height',
  align: 'align',
  maxWidth: 'max_width',
  shadow: 'shadow',
  shadowColor: 'shadow_color',
  opacity: 'opacity',
  rotation: 'rotation',
  textStrokeColor: 'text_stroke_color',
  textStrokeWidth: 'text_stroke_width',
  bar: 'accent_bar',
};

function serializeCamera() {
  return {
    follow_cursor: cameraOptions.followCursor,
    merge_gap_ms: cameraOptions.mergeGap,
    motion: cameraOptions.motion,
    auto_zoom: cameraOptions.autoZoom,
    zoom_intensity: cameraOptions.zoomIntensity,
    motion_blur: cameraOptions.motionBlur,
    frame: { ...cameraOptions.frame },
  };
}

function serializeShot(sh) {
  return {
    id: sh.id,
    start_sec: round(sh.start / 1000), end_sec: round(sh.end / 1000),
    x: round(sh.x), y: round(sh.y), scale: round(sh.scale, 2), transition_ms: sh.transition,
  };
}

function shotParams(p) {
  return stripUndefined({
    start: p.start_sec !== undefined ? p.start_sec * 1000 : undefined,
    end: p.end_sec !== undefined ? p.end_sec * 1000 : undefined,
    x: p.x, y: p.y, scale: p.scale, transition: p.transition_ms,
  });
}

function serializeCursor() {
  const fx = cursorFx;
  return {
    cursor: fx.cursor,
    cursor_size: fx.cursorSize,
    cursor_color: fx.cursorColor,
    has_custom_image: !!fx.customImage,
    hotspot_x: fx.hotspotX,
    hotspot_y: fx.hotspotY,
    click_effect: fx.clickEffect,
    effect_color: fx.effectColor,
    effect_size: fx.effectSize,
    press_animation: fx.pressAnimation,
  };
}

function serializeSegment(sg) {
  return {
    id: sg.id,
    start_sec: round(sg.start / 1000),
    end_sec: round(sg.end / 1000),
    speed: sg.speed,
    kind: sg.speed === 0 ? 'cut' : 'speed-up',
  };
}

// API text params → overlay fields. Design values that fail validation are
// reported instead of silently ignored.
function textParams(p) {
  const design = {};
  const rejected = [];
  for (const [key, apiName] of Object.entries(DESIGN_API_NAMES)) {
    if (p[apiName] === undefined) continue;
    const v = p[apiName];
    if (v === null || DESIGN_KEYS[key](v)) design[key] = v;
    else rejected.push(`${apiName}=${JSON.stringify(v)}`);
  }
  if (rejected.length) throw new Error(`Invalid design value(s): ${rejected.join(', ')}`);
  if (p.accent !== undefined && !isColor(p.accent)) throw new Error(`Invalid accent colour: ${JSON.stringify(p.accent)}`);

  return stripUndefined({
    text: p.text,
    start: p.start_sec !== undefined ? p.start_sec * 1000 : undefined,
    end: p.end_sec !== undefined ? p.end_sec * 1000 : undefined,
    style: p.style,
    x: p.x, y: p.y, w: p.w, h: p.h,
    anchor: p.anchor,
    animation: p.animation,
    size: p.size,
    accent: p.accent,
    design: Object.keys(design).length ? design : undefined,
    resetDesign: p.reset_design || undefined,
  });
}

// --- Frame capture ---

function seekExact(timeSec) {
  stopPlaybackLoop();
  if (!sourceVideo.paused) sourceVideo.pause();
  isPlaying = false;
  playPauseBtn.textContent = '▶';
  const t = Math.max(0, Math.min(timeSec, sourceVideo.duration || 0));
  return new Promise((resolve) => {
    if (Math.abs(sourceVideo.currentTime - t) < 0.001 && sourceVideo.readyState >= 2) return resolve();
    const timer = setTimeout(resolve, 3000);
    sourceVideo.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
    sourceVideo.currentTime = t;
  });
}

async function renderAt(timeSec, rendered) {
  await fontsReady();
  await seekExact(timeSec);
  renderFrame(sourceVideo.currentTime, { raw: !rendered });
  updateTimeDisplay(sourceVideo.currentTime);
  updateTimelineProgress(sourceVideo.currentTime);
}

function canvasToJpeg(canvas, quality = 0.85) {
  return canvas.toDataURL('image/jpeg', quality).split(',')[1];
}

function scaledCopy(maxWidth) {
  const k = Math.min(1, maxWidth / previewCanvas.width);
  const c = document.createElement('canvas');
  c.width = Math.round(previewCanvas.width * k);
  c.height = Math.round(previewCanvas.height * k);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(previewCanvas, 0, 0, c.width, c.height);
  return c;
}

// --- Methods ---

const BRIDGE_METHODS = {
  async get_project() {
    return {
      recording: {
        duration_sec: round(sourceVideo.duration),
        width: previewCanvas.width,
        height: previewCanvas.height,
        current_time_sec: round(sourceVideo.currentTime),
        cursor_samples: moves.length,
        output_duration_sec: round(outputDurationMs() / 1000),
      },
      segments: segments.map(serializeSegment),
      cursor: serializeCursor(),
      camera: serializeCamera(),
      shots: shots.map(serializeShot),
      events: clicks.map(serializeEvent),
      texts: [...overlays].sort((a, b) => a.start - b.start).map(serializeText),
      text_styles: Object.fromEntries(Object.entries(TEXT_STYLES).map(([k, v]) => [k, {
        description: v.desc,
        default_design: Object.fromEntries(Object.entries(STYLE_DESIGN[k])
          .filter(([dk]) => DESIGN_API_NAMES[dk])
          .map(([dk, dv]) => [DESIGN_API_NAMES[dk], dv])),
      }])),
      text_animations: TEXT_ANIMATIONS,
    };
  },

  async get_frame({ time_sec = sourceVideo.currentTime, rendered = true, max_width = 1280 }) {
    await renderAt(time_sec, rendered);
    return { time_sec: round(sourceVideo.currentTime), mime: 'image/jpeg', image: canvasToJpeg(scaledCopy(max_width)) };
  },

  async get_contact_sheet({ times, count = 12, columns = 4, rendered = true, thumb_width = 480 }) {
    const dur = sourceVideo.duration;
    if (!Array.isArray(times) || !times.length) {
      const n = Math.max(1, Math.min(48, count));
      times = Array.from({ length: n }, (_, i) => (dur * (i + 0.5)) / n);
    }
    times = times.slice(0, 48);
    const cols = Math.max(1, Math.min(columns, times.length));
    const rows = Math.ceil(times.length / cols);
    const tw = Math.min(thumb_width, previewCanvas.width);
    const th = Math.round(tw * previewCanvas.height / previewCanvas.width);
    const labelH = 22;

    const sheet = document.createElement('canvas');
    sheet.width = cols * tw;
    sheet.height = rows * (th + labelH);
    const g = sheet.getContext('2d');
    g.fillStyle = '#111';
    g.fillRect(0, 0, sheet.width, sheet.height);
    g.font = '600 14px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.imageSmoothingQuality = 'high';

    for (let i = 0; i < times.length; i++) {
      await renderAt(times[i], rendered);
      const x = (i % cols) * tw, y = Math.floor(i / cols) * (th + labelH);
      g.drawImage(previewCanvas, x, y + labelH, tw, th);
      g.fillStyle = '#ddd';
      g.fillText(`#${i + 1}  ${fmtTime(times[i])}  (${round(times[i], 2)}s)`, x + 8, y + labelH / 2);
    }
    return { times_sec: times.map(t => round(t, 2)), mime: 'image/jpeg', image: canvasToJpeg(sheet, 0.8) };
  },

  async seek({ time_sec }) {
    await renderAt(time_sec, true);
    return { time_sec: round(sourceVideo.currentTime) };
  },

  async update_events({ updates = [] }) {
    pushHistory();
    for (const u of updates) {
      const c = clicks[u.index];
      if (!c) throw new Error(`No event with index ${u.index}`);
      if (u.enabled !== undefined) c.enabled = !!u.enabled;
      if (u.click_effect !== undefined) c.effect = !!u.click_effect;
      if (u.zoom_level !== undefined) { c.zoomLevel = Math.min(4, Math.max(1.05, u.zoom_level)); c.zoomAuto = false; }
      if (u.zoom_auto !== undefined) { if (u.zoom_auto) delete c.zoomAuto; else c.zoomAuto = false; }
      if (u.zoom_in_ms !== undefined) c.zoomInDuration = Math.max(50, Math.round(u.zoom_in_ms));
      if (u.hold_ms !== undefined) c.holdDuration = Math.max(0, Math.round(u.hold_ms));
      if (u.zoom_out_ms !== undefined) c.zoomOutDuration = Math.max(50, Math.round(u.zoom_out_ms));
      if (u.offset_ms !== undefined) c.zoomOffset = Math.round(u.offset_ms);
      if (u.t_sec !== undefined) c.t = Math.max(0, Math.round(u.t_sec * 1000));
      if (u.x !== undefined) c.nx = Math.min(1, Math.max(0, u.x));
      if (u.y !== undefined) c.ny = Math.min(1, Math.max(0, u.y));
    }
    projectChanged();
    return { events: updates.map(u => serializeEvent(clicks[u.index], u.index)) };
  },

  async set_camera(p) {
    if (p.motion !== undefined && !MOTION_PRESETS[p.motion]) throw new Error(`motion must be one of ${Object.keys(MOTION_PRESETS).join(', ')}`);
    const f = p.frame || {};
    if (f.background !== undefined) {
      const bg = f.background;
      const ok = Array.isArray(bg) ? bg.length >= 2 && bg.length <= 4 && bg.every(isColor) : isColor(bg);
      if (!ok) throw new Error(`Invalid frame background: ${JSON.stringify(bg)}`);
    }
    pushHistory();
    if (p.follow_cursor !== undefined) cameraOptions.followCursor = !!p.follow_cursor;
    if (p.merge_gap_ms !== undefined) cameraOptions.mergeGap = Math.max(0, p.merge_gap_ms);
    if (p.motion !== undefined) cameraOptions.motion = p.motion;
    if (p.auto_zoom !== undefined) cameraOptions.autoZoom = !!p.auto_zoom;
    if (p.zoom_intensity !== undefined) cameraOptions.zoomIntensity = Math.min(2, Math.max(0.5, p.zoom_intensity));
    if (p.motion_blur !== undefined) cameraOptions.motionBlur = !!p.motion_blur;
    const fr = cameraOptions.frame;
    if (f.enabled !== undefined) fr.enabled = !!f.enabled;
    if (f.padding !== undefined) fr.padding = Math.min(0.2, Math.max(0, f.padding));
    if (f.radius !== undefined) fr.radius = Math.min(120, Math.max(0, f.radius));
    if (f.background !== undefined) fr.background = f.background;
    if (f.shadow !== undefined) fr.shadow = !!f.shadow;
    projectChanged();
    return serializeCamera();
  },

  async add_shot(p) {
    const sh = addShot(shotParams(p));
    await renderAt((sh.start + sh.end) / 2000, true);
    return serializeShot(sh);
  },

  async update_shot(p) {
    return serializeShot(updateShot(p.id, shotParams(p)));
  },

  async remove_shot({ id }) {
    removeShot(id);
    return { removed: id };
  },

  async analyze_video({ fps = 2, min_static_sec = 2 }) {
    setClaudeStatus('busy', 'Claude: analysing video…');
    const a = await analyzeVideo({ fps });
    const sum = summarizeAnalysis(a, { minStaticSec: min_static_sec });
    return {
      sample_every_sec: round(sum.stepMs / 1000, 2),
      scene_changes_sec: sum.sceneChanges.map(t => round(t / 1000, 2)),
      static_ranges: sum.staticRanges.map(r => ({ start_sec: round(r.start / 1000), end_sec: round(r.end / 1000), length_sec: round((r.end - r.start) / 1000) })),
      activity_per_second: sum.perSecond,
      note: 'scene_changes = page loads / navigation / modals (good moments to zoom out or show a wide shot). ' +
        'static_ranges = the picture does not change at all (safe to cut or speed up). activity 0–1 per second.',
    };
  },

  // Several edits as ONE undo step. ops: [{ method, params }]
  async apply_edits({ ops = [] }) {
    const before = undoStack.length;
    const results = [];
    for (const [i, op] of ops.entries()) {
      if (!op || op.method === 'apply_edits' || !BRIDGE_METHODS[op.method]) {
        results.push({ i, method: op && op.method, error: `Unknown or disallowed method "${op && op.method}"` });
        continue;
      }
      try {
        results.push({ i, method: op.method, result: await BRIDGE_METHODS[op.method](op.params || {}) });
      } catch (err) {
        results.push({ i, method: op.method, error: err.message });
      }
    }
    // Collapse the snapshots pushed by the individual edits into the first one
    if (undoStack.length > before + 1) undoStack.splice(before + 1);
    return { results, failed: results.filter(r => r.error).length };
  },

  async add_text(params) {
    const o = addText(textParams(params));
    switchTab('texts');
    await renderAt(Math.min(o.end, o.start + 500) / 1000, true);
    return serializeText(o);
  },

  async update_text(params) {
    const o = updateText(params.id, textParams(params));
    return serializeText(o);
  },

  async update_texts({ ids, ...params }) {
    const changed = updateTexts(ids, textParams(params));
    return { texts: changed.map(serializeText) };
  },

  async remove_text({ id }) {
    removeText(id);
    return { removed: id };
  },

  async add_segment({ start_sec, end_sec, speed }) {
    const sg = addSegment({ start: start_sec * 1000, end: end_sec * 1000, speed });
    switchTab('cuts');
    return { segment: serializeSegment(sg), output_duration_sec: round(outputDurationMs() / 1000) };
  },

  async update_segment({ id, start_sec, end_sec, speed }) {
    const sg = updateSegment(id, {
      start: start_sec !== undefined ? start_sec * 1000 : undefined,
      end: end_sec !== undefined ? end_sec * 1000 : undefined,
      speed,
    });
    return { segment: serializeSegment(sg), output_duration_sec: round(outputDurationMs() / 1000) };
  },

  async remove_segment({ id }) {
    removeSegment(id);
    return { removed: id, output_duration_sec: round(outputDurationMs() / 1000) };
  },

  async find_idle({ min_sec = 4, margin_sec = 0.6 }) {
    const found = findIdleRanges({ minMs: min_sec * 1000, marginMs: margin_sec * 1000 });
    return {
      idle: found.map(r => {
        const change = screenChangeIn(r.start, r.end);
        return {
          start_sec: round(r.start / 1000), end_sec: round(r.end / 1000), length_sec: round((r.end - r.start) / 1000),
          screen_change: change === null ? 'unknown (run analyze_video)' : round(change, 4),
        };
      }),
      note: 'No clicks/typing and a still cursor. screen_change ≈ 0 → frozen (cut it); > 0.004 → something moves ' +
        '(loading, animation: prefer speeding up). Check frames when unsure.',
    };
  },

  async set_cursor(p) {
    setCursorFx(stripUndefined({
      cursor: p.cursor,
      cursorSize: p.cursor_size,
      cursorColor: p.cursor_color,
      customImage: p.custom_image,
      hotspotX: p.hotspot_x,
      hotspotY: p.hotspot_y,
      clickEffect: p.click_effect,
      effectColor: p.effect_color,
      effectSize: p.effect_size,
      pressAnimation: p.press_animation,
    }));
    switchTab('cursor');
    return serializeCursor();
  },

  async undo() {
    return { undone: undo() };
  },

  async export_video() {
    exportVideo();
    return { started: true, duration_sec: round(sourceVideo.duration) };
  },
};
