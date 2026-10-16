# Marketing Clip Recorder — Windows desktop (prototype)

Records a whole monitor instead of a browser tab, so everything that Chrome's
tab capture misses ends up in the video: native `<select>` popups,
`alert`/`confirm` dialogs, file pickers, popups, new windows and other apps.
When the recording stops, the same clip editor as the extension opens
(`../editor`, unchanged).

```
npm install
npm start
```

- Pick a monitor, press **Grabar** (or `Alt + S`). The countdown and stop
  button live in a small floating pill that is excluded from the capture
  (`setContentProtection`, Windows 10 2004+).
- Clicks, typing and cursor moves are logged with a global hook
  (`uiohook-napi`) in the same format as the extension's `content.js`.
- Exports are saved to `Videos\Marketing Clip Recorder`.
- **Grabar sin el cursor de Windows**: the video comes from ffmpeg's `ddagrab`
  (Desktop Duplication, `draw_mouse=0`) instead of Chromium, so only the
  editor's own cursor appears. Needs `ffmpeg` on the PATH (or `MCR_FFMPEG`);
  picks NVENC, then Media Foundation, then x264. System audio is recorded
  separately and muxed in at the end. With several monitors the DXGI output
  order is assumed to match Electron's display order.

Not yet (next phases): element labels/rects for auto zoom (UI Automation),
recording a single window/region, installer.

`npm run selftest` records 7 s and writes the recording, events and an editor
screenshot to `%MCR_SELFTEST_OUT%`. It opens windows on the primary screen —
don't use the computer while it runs.
