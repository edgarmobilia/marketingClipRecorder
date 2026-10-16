'use strict';

// Cursor-free capture: ffmpeg's ddagrab (Windows Desktop Duplication API)
// with draw_mouse=0 records the monitor without the system cursor, so the
// editor's own cursor is the only one in the video. Chromium's desktop
// capture always burns the cursor in, hence the separate process.
//
// ffmpeg comes from MCR_FFMPEG or the PATH (winget install Gyan.FFmpeg).
// Video only: system audio is recorded by the renderer and muxed in at the end.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FPS = 60;
const STOP_TIMEOUT_MS = 15_000;

const ffmpegBin = () => process.env.MCR_FFMPEG || 'ffmpeg';

let availability = null;   // cached { ok, encoder, error }

// Encoders in order of preference. NVENC takes the GPU frames as they are;
// the others need them copied to system memory first.
const ENCODERS = [
  { name: 'h264_nvenc', filter: '', args: (b) => ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '19', '-b:v', b, '-maxrate', b] },
  { name: 'h264_mf', filter: ',hwdownload,format=bgra,format=nv12', args: (b) => ['-c:v', 'h264_mf', '-b:v', b] },
  { name: 'libx264', filter: ',hwdownload,format=bgra,format=yuv420p', args: () => ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18'] },
];

const grab = (outputIdx, fps) => `ddagrab=output_idx=${outputIdx}:framerate=${fps}:draw_mouse=0`;

// Finds a working ffmpeg + encoder by encoding a few frames (once per run)
function probe() {
  if (availability) return availability;
  const version = spawnSync(ffmpegBin(), ['-hide_banner', '-version'], { windowsHide: true });
  if (version.error || version.status !== 0) {
    return (availability = { ok: false, error: 'ffmpeg no está instalado (winget install Gyan.FFmpeg)' });
  }
  for (const enc of ENCODERS) {
    const r = spawnSync(ffmpegBin(), [
      '-hide_banner', '-loglevel', 'error',
      '-filter_complex', grab(0, 30) + enc.filter,
      '-frames:v', '3', ...enc.args('8M'), '-f', 'null', '-',
    ], { windowsHide: true, timeout: 15_000 });
    if (r.status === 0) return (availability = { ok: true, encoder: enc.name });
  }
  return (availability = { ok: false, error: 'ffmpeg no puede capturar la pantalla (ddagrab)' });
}

let current = null;   // { proc, file, startAt, exited }

// Starts recording; resolves with the wall-clock time of the first frame
function start({ outputIdx = 0, bitrate = 20_000_000 }) {
  const info = probe();
  if (!info.ok) return Promise.reject(new Error(info.error));
  const enc = ENCODERS.find(e => e.name === info.encoder);
  const file = path.join(os.tmpdir(), `mcr-capture-${Date.now()}.mp4`);
  const b = String(bitrate);

  const proc = spawn(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-filter_complex', grab(outputIdx, FPS) + enc.filter,
    ...enc.args(b),
    '-progress', 'pipe:1', '-stats_period', '0.25', '-nostats',
    file,
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  const cap = { proc, file, startAt: null, stderr: '' };
  cap.exited = new Promise(resolve => proc.on('exit', resolve));
  current = cap;
  proc.stderr.on('data', d => { cap.stderr = (cap.stderr + d).slice(-2000); });

  return new Promise((resolve, reject) => {
    // Each progress report gives the encoded duration; now − duration is when
    // the first frame was grabbed. Report latency only ever adds, so the
    // smallest estimate is the most accurate one.
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (!m || m[1] === '0') continue;
        const est = Date.now() - Number(m[1]) / 1000;
        const first = cap.startAt == null;
        cap.startAt = first ? est : Math.min(cap.startAt, est);
        if (first) resolve(cap.startAt);
      }
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (cap.startAt == null) reject(new Error(`ffmpeg terminó (${code}): ${cap.stderr.trim() || 'sin salida'}`));
    });
  });
}

// Current best estimate of when the first frame was grabbed
const startedAt = () => current?.startAt ?? null;

// Stops recording ('q' lets ffmpeg finish the MP4 properly) and returns the file
async function stop() {
  const cap = current;
  if (!cap) return null;
  current = null;
  try { cap.proc.stdin.write('q'); } catch (e) { /* already gone */ }
  const timer = setTimeout(() => cap.proc.kill(), STOP_TIMEOUT_MS);
  await cap.exited;
  clearTimeout(timer);
  if (!fs.existsSync(cap.file)) throw new Error(`ffmpeg no generó vídeo: ${cap.stderr.trim()}`);
  return { file: cap.file, startAt: cap.startAt };
}

// Adds the separately recorded audio, shifted so both start in sync
function mux(videoFile, audioFile, offsetMs) {
  const out = videoFile.replace(/\.mp4$/, '-av.mp4');
  // Positive offset: audio started after the first video frame
  const audioInput = offsetMs >= 0
    ? ['-itsoffset', (offsetMs / 1000).toFixed(3), '-i', audioFile]
    : ['-ss', (-offsetMs / 1000).toFixed(3), '-i', audioFile];
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoFile, ...audioInput,
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      out,
    ], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', reject);
    proc.on('exit', code => (code === 0 ? resolve(out) : reject(new Error(`mux: ${err.trim()}`))));
  });
}

module.exports = { probe, start, stop, startedAt, mux };
