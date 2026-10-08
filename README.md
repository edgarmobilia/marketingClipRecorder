# Marketing Clip Recorder

A Chrome extension for recording browser tabs with automatic smooth zoom effects on every click — perfect for creating polished product demos and marketing videos without any post-production effort.

---

## Preview

> **Popup — start/stop recording**

<img width="359" height="249" alt="image" src="https://github.com/user-attachments/assets/2f74ef6c-7a75-4a18-95f4-0208fb25d1a7" />


> **Clip Editor — timeline & zoom controls**

<img width="1916" height="990" alt="image" src="https://github.com/user-attachments/assets/3a031412-361c-4eb2-864f-39ac2b1124e3" />


---

## Features

- **One-click tab recording** — captures the active tab's video and audio via Chrome's `tabCapture` API.
- **Hands-free shortcut** — `Alt + S` starts and stops recording from any tab, no popup needed (rebind it at `chrome://extensions/shortcuts`).
- **3-2-1 countdown** — shown on the toolbar badge, so it never ends up in the video.
- **Automatic click & typing detection** — every click and every text field you type in is logged with its exact position, aligned to the first recorded frame. Works across page navigations and inside iframes.
- **Automatic camera** — the editor zooms on each event, joins nearby events into one continuous shot (no bouncing in and out), and smoothly pans to follow the cursor while zoomed.
- **Cursor & click effects in post** — nothing is drawn on the page while recording. In the editor pick a cursor
  (arrow, cartoon glove, dot, or your own image/SVG) and a click effect (ripple, pulse, burst) with any colour and
  size, or turn them off — globally or per click.
- **Built-in clip editor** — interactive timeline with per-click zoom settings (intensity, ease-in duration, hold time, ease-out duration, and time offset).
- **Global defaults** — set zoom parameters once and apply them to all clicks at once; they're remembered for next time.
- **Video export** — renders the final clip frame by frame at 60 fps (WebCodecs, faster than real time, no dropped frames) with all zoom effects baked in and downloads it as MP4.
- **Auto-export** — optional: the finished clip downloads as soon as the editor opens, with zero clicks.

---

## How it works

```
Recording tab  →  tabCapture stream  →  Offscreen document (MediaRecorder)
                                                  ↓
                              content.js logs click events (x, y, timestamp)
                                                  ↓
                              Editor tab opens when recording finishes
                                                  ↓
                    Canvas renders video + zoom animations frame by frame
                                                  ↓
                                      Exported video file downloaded
```

---

## Installation

This extension is not published on the Chrome Web Store. Install it as an unpacked extension:

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project folder.
5. The extension icon will appear in your toolbar.

---

## Usage

1. Navigate to the browser tab you want to record.
2. Press `Alt + S` (or click the extension icon → **Record**). The badge counts down 3-2-1, then shows **REC**.
3. Interact with the page naturally — click, type, navigate between pages.
4. Press `Alt + S` again to stop.
5. The **Clip Editor** opens automatically in a new tab. With **Export automatically** enabled, the video downloads on its own.
6. Optionally fine-tune: disable events, adjust per-event zoom, toggle **Follow** cursor, or change **Merge** (how close two events must be to share one zoom).
7. Use **Preview** (or `Space`) to play back the result, then **Export video** to download the final file.

---

## Floating texts

Open the **Texts** tab and pick a style: *Title*, *Caption*, *Lower third*, *Callout* (small tag pointing at
something), *Highlight* (thin outline around an element) or *Plain text*. The defaults aim for an editorial product-
video look — flat neutral cards, medium weights, the accent colour used sparingly, short fade/slide motion — and
*Plain text* switches between dark and white ink to read on whatever is behind it. Choose colours from the swatches and an
animation with one click; sizes, timing, font, border and shadow are under **More options**. A text can be **fixed on
screen** or **follow the zoom**. Drag a selected text on the preview to place it, drag its bar on the timeline to
retime it. `Ctrl + Z` undoes any edit. Edits are saved automatically and survive reopening the editor.

The **Zooms** tab works the same way: one-click zoom style (*Subtle*, *Normal*, *Punchy*), a switch per event, and all
the numbers tucked under **Advanced**.

The **Cursor** tab draws the pointer and the click marks over the video: *None*, *Arrow*, *Glove*, *Dot* or *Custom*
(upload a PNG/SVG), plus a click effect and its colour. Each click's effect can be switched off in the Zooms tab.
Note that Chrome burns the real system cursor into tab recordings whenever the mouse moves, and no Chrome API can turn
that off; keep the drawn cursor at least as large as the real one so it covers it.

The **Cuts** tab removes or fast-forwards boring stretches (waiting, loading): **Cut here**, **Speed up here**
(2–16×, with a small ⏩ badge in the video), or **Speed up idle parts automatically**, which finds stretches with no
clicks, typing or cursor movement. Drag a band or its edges on the timeline to adjust it; the final length is shown
next to the time. Zooms and texts stay in sync.

Every visual property of a text is data, not code: background / gradient, text colour, border, corner radius,
padding, any Google Fonts family, weight, size, italic, uppercase, letter spacing, alignment, shadow, opacity,
rotation and letter outline.

---

## Edit with Claude (MCP)

The `mcp/` folder contains an [MCP](https://modelcontextprotocol.io) server that lets Claude Code look at the clip
and edit it live in the editor: review frames, disable noisy clicks, tune zooms, and write the texts. Every recorded
click carries the label of the element that was clicked (e.g. *"Save changes"*), so Claude knows what happens in the
video without you describing it.

```
Claude Code ──stdio──► mcp/server.js ◄──WebSocket 127.0.0.1:47821──► editor tab (applies changes live)
```

**Setup (once):**

1. `cd mcp && npm install`
2. Start Claude Code in this project folder. The project's `.mcp.json` registers the `clip-editor` server — approve it
   when asked. (Or register it manually: `claude mcp add clip-editor -- node mcp/server.js`.)
3. Record a clip. The editor shows **Claude: connected** in the toolbar.

Then ask things like *"review the clip and add step-by-step callouts"* or *"remove the accidental clicks and make the
zooms slower"* — or just run **`/mcp__clip-editor__polish`** and let Claude direct the whole edit.

Claude is meant to be the editor, not just a remote control: the server ships a **director guide** (pacing, when to
zoom and when not, text length, consistent look) as MCP instructions, `analyze_video` lets it see the actual pixels
(scene changes, frozen stretches), and `apply_edits` applies a whole plan as one undo step, after which it checks
rendered frames and fixes what looks off.

**Camera engine:** zoom level sized to the clicked element, perceptually smooth (log-scale) zooms, motion styles
(*smooth*, *snappy*, *calm*), automatic pull-back on long pans, motion blur, director **shots** (wide shot or
close-up on any region for any stretch), and an optional inset **frame** on a colour/gradient background.

**Several Claude sessions:** each session starts its own `mcp/server.js`, but only one can own the bridge port. The
first one does; later ones detect it and relay their calls through it, so every session can edit the open clip (and
if the owner exits, another takes over). If the port is held by something else, tools say so explicitly;
`get_status` shows the role (`owner` / `proxy` / `blocked`) and whether the editor is connected.

Tools: `get_status`, `get_project`, `get_frame`, `get_contact_sheet`, `seek`, `update_events`, `set_camera`, `add_text`,
`update_text`, `update_texts` (restyle many at once), `remove_text`, `find_idle`, `add_segment`, `update_segment`,
`remove_segment` (cut / speed up stretches), `add_shot`, `update_shot`, `remove_shot`, `analyze_video`,
`apply_edits`, `set_cursor` (any cursor — Claude can even draw one as SVG — and click
effect), `undo`, `export_video`. Claude can change any
look — colours, fonts, borders, gradients… — live, without touching the editor's code.

The bridge only listens on `127.0.0.1` and only accepts connections from `chrome-extension://` origins; set
`MCR_EXTENSION_ID` to restrict it to this extension's id. `npm test` in `mcp/` runs a smoke test of the bridge.

---

## Project structure

```
├── manifest.json          # Extension manifest (MV3)
├── background.js          # Service worker — orchestrates recording flow
├── .mcp.json              # Registers the clip-editor MCP server for Claude Code
├── content.js             # Injected into recorded tab — tracks clicks, typing, cursor and element labels
├── offscreen.js           # Offscreen document — runs MediaRecorder
├── offscreen.html
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.js
│   └── popup.css
├── editor/
│   ├── editor.html        # Clip editor page
│   ├── editor.js          # Canvas renderer + automatic camera
│   ├── overlays.js        # Floating text styles + rendering
│   ├── texts.js           # Texts panel, timeline track, drag to place
│   ├── segments.js        # Cuts & speed-ups: model, playback, idle detection, timeline bands
│   ├── cursor.js          # Cursor + click effects drawn in post (arrow, glove, dot, custom)
│   ├── shots.js           # Director camera shots (wide / close-up overrides)
│   ├── analysis.js        # Pixel analysis: scene changes, frozen stretches, activity
│   ├── export.js          # Frame-exact offline export (WebCodecs) + real-time fallback
│   ├── lib/               # Vendored mediabunny (MPL-2.0): demux / encode / MP4 mux
│   ├── bridge.js          # WebSocket client for the Claude MCP server
│   └── editor.css
├── mcp/
│   ├── server.js          # MCP server (stdio) + WebSocket bridge to the editor
│   └── test-bridge.mjs    # Smoke test
└── icons/
```

---

## Requirements

- Google Chrome (or any Chromium-based browser that supports Manifest V3 and `tabCapture`).
- No external dependencies — everything runs locally in the browser.

---

## License

MIT License — Copyright (c) 2026 Edgar Milá

Free to use, modify, distribute, and use commercially. See [LICENSE](LICENSE) for details.
