#!/usr/bin/env node
// MCP server for the Marketing Clip Recorder editor.
//
// Claude Code talks to this process over stdio (MCP). The editor tab
// (chrome-extension://…/editor/editor.html) connects to it over a WebSocket
// on 127.0.0.1, and every tool call is forwarded to the editor, which applies
// the change live and answers with data or a rendered frame.
//
// Env:
//   MCR_BRIDGE_PORT   WebSocket port (default 47821; must match editor/bridge.js)
//   MCR_EXTENSION_ID  if set, only this extension id may connect

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import * as z from 'zod';

const PORT = Number(process.env.MCR_BRIDGE_PORT) || 47821;
const EXTENSION_ID = process.env.MCR_EXTENSION_ID || null;
const CALL_TIMEOUT_MS = 90_000;
const LISTEN_RETRY_MS = 5_000;

// stdout carries the MCP protocol — all logging goes to stderr
const log = (...args) => console.error('[mcr-mcp]', ...args);

// --- WebSocket bridge to the editor ---

let editor = null;          // the currently connected editor socket
let nextCallId = 1;
const pending = new Map();  // id -> { resolve, reject, timer }

function isAllowedOrigin(origin) {
  if (!origin || !origin.startsWith('chrome-extension://')) return false;
  return !EXTENSION_ID || origin === `chrome-extension://${EXTENSION_ID}`;
}

function startBridge() {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: PORT,
    path: '/editor',
    // Web pages can also open localhost sockets; only accept the extension
    verifyClient: ({ origin }) => isAllowedOrigin(origin),
  });

  wss.on('listening', () => log(`bridge listening on ws://127.0.0.1:${PORT}/editor`));

  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`port ${PORT} busy (another Claude session?), retrying in ${LISTEN_RETRY_MS / 1000}s`);
      setTimeout(startBridge, LISTEN_RETRY_MS);
    } else {
      log('bridge error:', err.message);
    }
  });

  wss.on('connection', (ws) => {
    // Newest editor tab wins
    if (editor && editor !== ws) editor.close(4000, 'Replaced by a newer editor tab');
    editor = ws;
    log('editor connected');

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const call = pending.get(msg.id);
      if (!call) return;
      pending.delete(msg.id);
      clearTimeout(call.timer);
      if (msg.error) call.reject(new Error(msg.error.message || 'Editor error'));
      else call.resolve(msg.result);
    });

    ws.on('close', () => {
      if (editor === ws) editor = null;
      log('editor disconnected');
    });
  });
}

function callEditor(method, params = {}) {
  if (!editor || editor.readyState !== editor.OPEN) {
    return Promise.reject(new Error(
      'No clip editor is connected. Record a clip (or reopen the editor tab) in Chrome with the ' +
      'Marketing Clip Recorder extension; the editor connects automatically and shows "Claude: connected".'));
  }
  const id = nextCallId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Editor did not answer "${method}" within ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    editor.send(JSON.stringify({ id, method, params }));
  });
}

// --- Tool result helpers ---

const asText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

function asImage(result, caption) {
  const { image, mime, ...meta } = result;
  return {
    content: [
      { type: 'image', data: image, mimeType: mime || 'image/jpeg' },
      { type: 'text', text: caption ? `${caption}\n${JSON.stringify(meta)}` : JSON.stringify(meta) },
    ],
  };
}

async function run(fn) {
  try {
    return await fn();
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
}

// --- MCP server ---

// --- Director playbook: how Claude should edit, sent as server instructions ---

const DIRECTOR_GUIDE = `
You are the editor/director of short product-demo clips (marketing). The user records; you decide and improve.
Prefer making good decisions yourself over asking the user to tweak sliders — then summarise what you changed.

WORKFLOW
1. get_project (events with element labels, texts, cuts, camera, cursor) and analyze_video (scene changes, frozen stretches).
2. get_contact_sheet of the whole clip (rendered=false) to understand the story; get_frame on key moments.
3. Plan the cut: what is the one message? Which steps matter? What is waiting time?
4. Apply with apply_edits (many changes, ONE undo step). Then verify with get_contact_sheet / get_frame (rendered=true)
   and fix what looks off. Never claim something looks good without having looked at a rendered frame.
5. Tell the user in a few lines what you did and why; offer 1–2 optional alternatives. Export only when asked.

PACING (most important)
- Dead time kills demos. Frozen stretches (analyze_video static_ranges) > 1.5 s: cut. Loading/animations: speed up 4–8×.
- Aim for a tight final length (often 20–60 s). Keep ~0.3–0.6 s of context around actions.
- Typing long text: speed up 2–4× after the first word or two.

ZOOM & CAMERA (taste)
- Auto zoom (element-sized) is on by default and usually right; only override zoom_level when a frame proves it wrong.
- Not every click deserves a zoom: disable zooms on navigation clicks, repeated/accidental clicks, and clicks
  that open a new page (zoom out instead — use a wide shot, scale 1). Keep zooms on the 3–6 key actions.
- Close actions in the same area should share one zoom (merge_gap_ms 1200–2500).
- motion: "smooth" for most marketing, "snappy" for energetic/social clips, "calm" for enterprise/tutorials.
- Use director shots (add_shot) for intent: wide shot after a scene change, close-up on a result (chart, success
  message) that has no click on it. 1.6–2.2× close-ups read best; avoid > 2.8×.
- frame.enabled with a brand-coloured gradient background gives the polished "product video" look; padding 0.04–0.08.

TEXT
- Short: titles ≤ 6 words, callouts ≤ 4 words, captions ≤ 10. One message on screen at a time (max 2 elements).
- Opening title (1.5–2.5 s), then step callouts pointing at the element (anchor "video", use the event's
  element_rect / x,y), and a closing title/CTA. Match the language of the recorded UI unless told otherwise.
- Keep a consistent look: same font, palette and corner radius for all texts (update_texts). Ensure contrast.
- Timing: appear ~0.3 s before the action, stay ≥ 1.2 s, never overlap the element they point at.

CURSOR
- The real cursor is not in the recording; set_cursor draws it. Arrow + subtle ripple is a safe default; the glove
  ("hand") suits playful brands. Turn off click effects on clicks you un-zoomed if they distract.

Everything is data: never edit the editor's source code to change a look. If something cannot be expressed with the
tools, say what is missing.
`.trim();

const server = new McpServer({ name: 'clip-editor', version: '1.1.0' }, { instructions: DIRECTOR_GUIDE });

const STYLE_HELP =
  'Styles are layout presets with a default look: "title" (big centred heading, x/y = box centre), ' +
  '"caption" (subtitle pill, x/y = centre), "lower-third" (card with accent bar, x = left edge, y = vertical centre), ' +
  '"callout" (bubble whose pointer touches x/y — use anchor "video" and an event\'s x/y or element_rect centre), ' +
  '"highlight" (glowing outline of a w×h box centred on x/y, optional label; use an event\'s element_rect), ' +
  '"text" (no box, just text with a shadow). ' +
  'anchor "screen" = fixed on the output frame; "video" = glued to the recorded page so it follows zoom/pan. ' +
  'Coordinates are 0–1 fractions of the frame (screen) or of the recorded page (video). ' +
  'LOOK: every visual property can be overridden with the design fields (background, background_gradient, ' +
  'text_color, border_color/border_width, radius, padding, font_family — any Google Fonts name —, font_weight, ' +
  'font_size, italic, uppercase, letter_spacing, line_height, align, max_width, shadow, opacity, rotation, ' +
  'text_stroke_*, accent_bar). Lengths are pixels at 1080p and scale with the video. Colours are any CSS colour. ' +
  'Pass null to a design field to restore the style default, or reset_design=true to clear all overrides. ' +
  'Changes apply live — never edit the editor source code to change how a text looks; if a look truly cannot be ' +
  'expressed with these fields, tell the user what is missing instead.';

const color = z.string().describe('Any CSS colour: "#7dd3fc", "rgb(…)", "hsl(…)", "white"…');
const nullable = (schema) => schema.nullable();

const designFields = {
  background: nullable(z.string()).describe('Box fill colour, or "transparent" for no box'),
  background_gradient: nullable(z.array(color).min(2).max(4)).describe('Gradient fill (overrides background)'),
  gradient_angle: nullable(z.number()).describe('Degrees, CSS convention: 90 = left→right (default), 180 = top→bottom'),
  text_color: nullable(color),
  border_color: nullable(color),
  border_width: nullable(z.number().min(0).max(60)).describe('px at 1080p; 0 = no border'),
  radius: nullable(z.union([z.number().min(0).max(400), z.literal('pill')])).describe('Corner radius px at 1080p, or "pill"'),
  padding_x: nullable(z.number().min(0).max(400)).describe('px at 1080p'),
  padding_y: nullable(z.number().min(0).max(400)).describe('px at 1080p'),
  font_family: nullable(z.string()).describe('Google Fonts family name, e.g. "Poppins", "Montserrat", "Bebas Neue"'),
  font_weight: nullable(z.number().int().min(100).max(900)),
  font_size: nullable(z.number().min(8).max(400)).describe('px at 1080p (overrides the style size; `size` still multiplies it)'),
  italic: nullable(z.boolean()),
  uppercase: nullable(z.boolean()),
  letter_spacing: nullable(z.number().min(-20).max(60)).describe('px at 1080p'),
  line_height: nullable(z.number().min(0.8).max(3)).describe('Multiple of font size'),
  align: nullable(z.enum(['left', 'center', 'right'])),
  max_width: nullable(z.number().min(0.05).max(1)).describe('Wrap width as a fraction of frame width'),
  shadow: nullable(z.enum(['none', 'soft', 'strong', 'glow'])),
  shadow_color: nullable(color),
  opacity: nullable(z.number().min(0).max(1)),
  rotation: nullable(z.number().min(-180).max(180)).describe('Degrees'),
  text_stroke_color: nullable(color).describe('Outline around the letters'),
  text_stroke_width: nullable(z.number().min(0).max(40)).describe('px at 1080p'),
  accent_bar: nullable(z.boolean()).describe('Accent bar on the left (lower-third default)'),
  reset_design: z.boolean().describe('Clear all design overrides before applying the others'),
};

const textFields = {
  text: z.string().describe('Text to show; use \\n for line breaks'),
  start_sec: z.number().min(0).describe('When the text appears (seconds)'),
  end_sec: z.number().min(0).describe('When the text disappears (seconds)'),
  style: z.enum(['title', 'caption', 'lower-third', 'callout', 'highlight', 'text']),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1).describe('highlight only: box width'),
  h: z.number().min(0).max(1).describe('highlight only: box height'),
  anchor: z.enum(['screen', 'video']),
  animation: z.enum(['fade', 'slide-up', 'pop', 'typewriter', 'none']),
  size: z.number().min(0.3).max(4).describe('Overall size multiplier, 1 = as designed'),
  accent: color.describe('Colour of the callout bubble, highlight ring and lower-third bar'),
  ...designFields,
};
const optionalTextFields = Object.fromEntries(Object.entries(textFields).map(([k, v]) => [k, v.optional()]));

server.registerTool('get_project', {
  title: 'Get clip project',
  description:
    'Returns the clip being edited: duration and resolution, every recorded event (clicks and typing) with its ' +
    'time, position, the label/role of the element that was clicked, page title, element_rect, and its zoom settings; ' +
    'the camera options; and all text overlays. Call this first.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, () => run(async () => asText(await callEditor('get_project'))));

server.registerTool('get_frame', {
  title: 'Get video frame',
  description:
    'Renders one frame of the clip and returns it as an image so you can see it. rendered=true shows the final ' +
    'output (zoom + texts); rendered=false shows the untouched recording. Also moves the editor playhead there.',
  inputSchema: {
    time_sec: z.number().min(0).describe('Time in seconds'),
    rendered: z.boolean().optional().describe('Default true'),
    max_width: z.number().int().min(160).max(3840).optional().describe('Default 1280'),
  },
  annotations: { readOnlyHint: true },
}, (args) => run(async () => asImage(await callEditor('get_frame', args), `Frame at ${args.time_sec}s`)));

server.registerTool('get_contact_sheet', {
  title: 'Get contact sheet',
  description:
    'Returns a grid of thumbnails (one image) to review the whole clip at a glance. Pass explicit times, or count ' +
    'for evenly spaced frames. Each cell is labelled with its time.',
  inputSchema: {
    times: z.array(z.number().min(0)).max(48).optional().describe('Seconds; overrides count'),
    count: z.number().int().min(1).max(48).optional().describe('Default 12'),
    columns: z.number().int().min(1).max(8).optional().describe('Default 4'),
    rendered: z.boolean().optional().describe('Default true'),
    thumb_width: z.number().int().min(120).max(960).optional().describe('Default 480'),
  },
  annotations: { readOnlyHint: true },
}, (args) => run(async () => asImage(await callEditor('get_contact_sheet', args))));

server.registerTool('seek', {
  title: 'Move playhead',
  description: 'Moves the editor playhead so the user sees that moment in the preview.',
  inputSchema: { time_sec: z.number().min(0) },
}, (args) => run(async () => asText(await callEditor('seek', args))));

server.registerTool('update_events', {
  title: 'Update zoom events',
  description:
    'Edits recorded events by index (from get_project): enable/disable the zoom for an event, change zoom level ' +
    '(1.05–4), timings, shift its time, or move its focus point. Disable noisy events (accidental or repeated ' +
    'clicks) rather than leaving them. Undoable.',
  inputSchema: {
    updates: z.array(z.object({
      index: z.number().int().min(0),
      enabled: z.boolean().optional().describe('Zoom on this event'),
      zoom_auto: z.boolean().optional().describe('true = size the zoom from the element again'),
      click_effect: z.boolean().optional().describe('Show the click effect on this click'),
      zoom_level: z.number().optional().describe('Fixed level (turns auto zoom off for this event)'),
      zoom_in_ms: z.number().optional(),
      hold_ms: z.number().optional(),
      zoom_out_ms: z.number().optional(),
      offset_ms: z.number().optional().describe('Shift the zoom peak relative to the event'),
      t_sec: z.number().optional().describe('Move the event itself'),
      x: z.number().min(0).max(1).optional().describe('Focus point'),
      y: z.number().min(0).max(1).optional(),
    })).min(1),
  },
}, (args) => run(async () => asText(await callEditor('update_events', args))));

server.registerTool('set_camera', {
  title: 'Set camera & framing',
  description:
    'Global camera behaviour. motion: "smooth" | "snappy" (quick, slight overshoot) | "calm" (slow, loose follow). ' +
    'auto_zoom: zoom level chosen from each clicked element\'s size (recommended); zoom_intensity scales it ' +
    '(0.5–2, 1 = default). follow_cursor: pan with the cursor while zoomed. merge_gap_ms: nearby zooms stay ' +
    'zoomed in between. motion_blur on fast camera moves. frame: inset the recording on a background ' +
    '(enabled, padding 0–0.2 of the height, radius px@1080, background colour or 2–4 colour gradient, shadow). ' +
    'Long pans while zoomed in automatically pull back mid-way for orientation. Undoable.',
  inputSchema: {
    motion: z.enum(['smooth', 'snappy', 'calm']).optional(),
    auto_zoom: z.boolean().optional(),
    zoom_intensity: z.number().min(0.5).max(2).optional(),
    follow_cursor: z.boolean().optional(),
    merge_gap_ms: z.number().min(0).max(10000).optional(),
    motion_blur: z.boolean().optional(),
    frame: z.object({
      enabled: z.boolean().optional(),
      padding: z.number().min(0).max(0.2).optional(),
      radius: z.number().min(0).max(120).optional(),
      background: z.union([z.string(), z.array(z.string()).min(2).max(4)]).optional(),
      shadow: z.boolean().optional(),
    }).optional(),
  },
}, (args) => run(async () => asText(await callEditor('set_camera', args))));

const SHOT_HELP =
  'A shot overrides the automatic camera between start_sec and end_sec (source time), blending in/out over ' +
  'transition_ms. scale 1 = wide shot (whole page); 1.5–2.5 = close-up centred on x,y (0–1 of the recorded page). ' +
  'Use for intent the clicks don\'t express: show a result, re-establish context after a page change.';

server.registerTool('add_shot', {
  title: 'Add camera shot',
  description: `Adds a director shot. Undoable. ${SHOT_HELP}`,
  inputSchema: {
    start_sec: z.number().min(0),
    end_sec: z.number().min(0),
    scale: z.number().min(1).max(4),
    x: z.number().min(0).max(1).optional().describe('Default 0.5'),
    y: z.number().min(0).max(1).optional().describe('Default 0.5'),
    transition_ms: z.number().min(0).max(3000).optional().describe('Default 600'),
  },
}, (args) => run(async () => asText(await callEditor('add_shot', args))));

server.registerTool('update_shot', {
  title: 'Update camera shot',
  description: `Changes a shot by id. ${SHOT_HELP}`,
  inputSchema: {
    id: z.string(),
    start_sec: z.number().min(0).optional(),
    end_sec: z.number().min(0).optional(),
    scale: z.number().min(1).max(4).optional(),
    x: z.number().min(0).max(1).optional(),
    y: z.number().min(0).max(1).optional(),
    transition_ms: z.number().min(0).max(3000).optional(),
  },
}, (args) => run(async () => asText(await callEditor('update_shot', args))));

server.registerTool('remove_shot', {
  title: 'Remove camera shot',
  description: 'Deletes a shot by id. Undoable.',
  inputSchema: { id: z.string() },
}, (args) => run(async () => asText(await callEditor('remove_shot', args))));

server.registerTool('analyze_video', {
  title: 'Analyse the recording',
  description:
    'Looks at the actual pixels: scene_changes_sec (page loads, navigation, modals), static_ranges (the picture ' +
    'is frozen — safe to cut), and activity_per_second (0–1). Takes a few seconds for long clips; cached after.',
  inputSchema: {
    fps: z.number().min(0.5).max(8).optional().describe('Samples per second (default 2)'),
    min_static_sec: z.number().min(0.5).optional().describe('Shortest frozen stretch to report (default 2)'),
  },
  annotations: { readOnlyHint: true },
}, (args) => run(async () => asText(await callEditor('analyze_video', args))));

server.registerTool('apply_edits', {
  title: 'Apply many edits at once',
  description:
    'Runs several editor operations in order as ONE undo step. ops: [{ method, params }] where method is any ' +
    'editing tool name (update_events, set_camera, add_text, update_text, update_texts, remove_text, add_segment, ' +
    'update_segment, remove_segment, add_shot, update_shot, remove_shot, set_cursor) and params its arguments. ' +
    'Returns each result or error; failed ops do not stop the rest.',
  inputSchema: {
    ops: z.array(z.object({ method: z.string(), params: z.record(z.string(), z.any()).optional() })).min(1).max(200),
  },
}, (args) => run(async () => asText(await callEditor('apply_edits', args))));

server.registerTool('add_text', {
  title: 'Add text overlay',
  description: `Adds a floating text overlay and returns it with its id. ${STYLE_HELP}`,
  inputSchema: {
    ...optionalTextFields,
    text: textFields.text,
    start_sec: textFields.start_sec,
    end_sec: textFields.end_sec,
  },
}, (args) => run(async () => asText(await callEditor('add_text', args))));

server.registerTool('update_text', {
  title: 'Update text overlay',
  description: `Changes any field of an existing text overlay by id. ${STYLE_HELP}`,
  inputSchema: { id: z.string(), ...optionalTextFields },
}, (args) => run(async () => asText(await callEditor('update_text', args))));

server.registerTool('update_texts', {
  title: 'Update several text overlays',
  description:
    'Applies the same changes to several texts in one undo step — e.g. a consistent brand look ' +
    '(font, colours, border) for every text. Omit ids to change all texts. ' + STYLE_HELP,
  inputSchema: {
    ids: z.array(z.string()).optional().describe('Text ids; omit for all texts'),
    ...Object.fromEntries(Object.entries(optionalTextFields).filter(([k]) => !['text', 'start_sec', 'end_sec'].includes(k))),
  },
}, (args) => run(async () => asText(await callEditor('update_texts', args))));

server.registerTool('remove_text', {
  title: 'Remove text overlay',
  description: 'Deletes a text overlay by id. Undoable.',
  inputSchema: { id: z.string() },
  annotations: { destructiveHint: true },
}, (args) => run(async () => asText(await callEditor('remove_text', args))));

const SEGMENT_HELP =
  'Segments are in SOURCE time (the recording, as get_project/get_frame use it). speed 0 removes the stretch; ' +
  'speed 2–16 fast-forwards it (a small "⏩ N×" badge is shown while it plays). Zooms and texts stay in sync ' +
  'automatically. Segments cannot overlap. get_project reports output_duration_sec (final length).';

server.registerTool('find_idle', {
  title: 'Find idle stretches',
  description:
    'Lists stretches with no clicks/typing and a still cursor — usually waiting/loading. Candidates only: ' +
    'look at a contact sheet of each before cutting, the screen may still be changing (then speed it up instead).',
  inputSchema: {
    min_sec: z.number().min(0.5).optional().describe('Shortest stretch to report (default 4)'),
    margin_sec: z.number().min(0).optional().describe('Context kept on each side (default 0.6)'),
  },
  annotations: { readOnlyHint: true },
}, (args) => run(async () => asText(await callEditor('find_idle', args))));

server.registerTool('add_segment', {
  title: 'Cut or speed up a stretch',
  description: `Removes (speed 0) or fast-forwards (speed 2–16) part of the clip. Undoable. ${SEGMENT_HELP}`,
  inputSchema: {
    start_sec: z.number().min(0),
    end_sec: z.number().min(0),
    speed: z.number().min(0).max(16).describe('0 = cut, otherwise playback speed (e.g. 4, 8)'),
  },
}, (args) => run(async () => asText(await callEditor('add_segment', args))));

server.registerTool('update_segment', {
  title: 'Update a cut / speed-up',
  description: `Changes the range or speed of a segment by id. ${SEGMENT_HELP}`,
  inputSchema: {
    id: z.string(),
    start_sec: z.number().min(0).optional(),
    end_sec: z.number().min(0).optional(),
    speed: z.number().min(0).max(16).optional(),
  },
}, (args) => run(async () => asText(await callEditor('update_segment', args))));

server.registerTool('remove_segment', {
  title: 'Remove a cut / speed-up',
  description: 'Deletes a segment by id, restoring that stretch at normal speed. Undoable.',
  inputSchema: { id: z.string() },
}, (args) => run(async () => asText(await callEditor('remove_segment', args))));

server.registerTool('set_cursor', {
  title: 'Set cursor & click effect',
  description:
    'The cursor and click marks are drawn in post-production (nothing was burned in while recording), so they ' +
    'can be changed or removed at any time. cursor: "none", "arrow", "hand" (cartoon white glove), "dot", or ' +
    '"custom" with custom_image — SVG markup you write yourself (e.g. a branded pointer, a cartoon hand) or a ' +
    'data:image URL; set hotspot_x/hotspot_y (0–1 of the image) to the pointer tip. click_effect: "none", ' +
    '"ripple", "pulse", "burst". Sizes are px at 1080p and follow the zoom. Per-click on/off: update_events ' +
    'click_effect. Undoable. Use get_frame to check the result.',
  inputSchema: {
    cursor: z.enum(['none', 'arrow', 'hand', 'dot', 'custom']).optional(),
    cursor_size: z.number().min(8).max(300).optional(),
    cursor_color: z.string().optional().describe('Arrow body / dot fill'),
    custom_image: z.string().nullable().optional().describe('<svg …> markup or data:image/… URL; null removes it'),
    hotspot_x: z.number().min(0).max(1).optional(),
    hotspot_y: z.number().min(0).max(1).optional(),
    click_effect: z.enum(['none', 'ripple', 'pulse', 'burst']).optional(),
    effect_color: z.string().optional(),
    effect_size: z.number().min(10).max(400).optional(),
    press_animation: z.boolean().optional().describe('Cursor squashes briefly on each click'),
  },
}, (args) => run(async () => asText(await callEditor('set_cursor', args))));

server.registerTool('undo', {
  title: 'Undo',
  description: 'Reverts the last edit (yours or the user\'s) in the editor.',
  inputSchema: {},
}, () => run(async () => asText(await callEditor('undo'))));

server.registerTool('export_video', {
  title: 'Export video',
  description:
    'Starts rendering the final MP4/WebM in the editor (real time — takes as long as the clip). The file is ' +
    'downloaded by Chrome when done. The editor tab must stay visible. Only do this when the user asks.',
  inputSchema: {},
}, () => run(async () => asText(await callEditor('export_video'))));

// --- Prompts (slash commands in Claude Code) ---

server.registerPrompt('polish', {
  title: 'Polish the clip',
  description: 'Review the open clip and turn it into a finished marketing video',
  argsSchema: {
    goal: z.string().optional().describe('What the video is for / the message (optional)'),
    style: z.string().optional().describe('Brand or style notes: colours, tone, length (optional)'),
  },
}, ({ goal, style }) => ({
  messages: [{
    role: 'user',
    content: {
      type: 'text',
      text:
        'Polish the clip that is open in the Clip Editor into a finished marketing video, following your director ' +
        'guide: analyse it, tighten the pacing (cut/speed up dead time), keep zooms only on the key actions, add ' +
        'a short opening title, step callouts and a closing line, set a consistent look, frame and cursor, then ' +
        'verify with rendered frames and fix what looks off. Do not export.' +
        (goal ? `\nGoal / message: ${goal}` : '') +
        (style ? `\nStyle notes: ${style}` : '') +
        '\nFinish with a short summary of what you changed.',
    },
  }],
}));

// --- Start ---

startBridge();
await server.connect(new StdioServerTransport());
log('MCP server ready');
