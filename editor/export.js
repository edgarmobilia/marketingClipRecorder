'use strict';

// --- Export ---
// Frame-exact offline render: every output frame is decoded from the
// recording at its exact source time (WebCodecs, via Mediabunny), drawn with
// the same renderFrame() as the preview and encoded at a fixed 60 fps.
// Nothing depends on how fast this machine can render in real time, so the
// file never drops or repeats frames, cuts are exact and speed-ups show every
// frame they should. Real-time canvas recording remains as a fallback.

const EXPORT_FPS = 60;
const AUDIO_FADE_SEC = 0.008; // tiny fade at every cut so splices don't click

let exportJob = null; // { cancelled } while an export runs

class ExportCancelled extends Error {}

exportBtn.addEventListener('click', exportVideo);
document.getElementById('exportCancelBtn').addEventListener('click', () => {
  if (exportJob) exportJob.cancelled = true;
});

// Zoomed frames magnify every compression artefact, so export with a
// generous bitrate scaled to the canvas size (≈40 Mbps at 1440p60)
function exportBitrate(W, H) {
  return Math.round(Math.min(80_000_000, Math.max(12_000_000, W * H * EXPORT_FPS * 0.18)));
}

function setExportUi(on, msg = '') {
  exportBtn.disabled = on;
  previewBtn.disabled = on;
  exportOverlay.style.display = on ? 'flex' : 'none';
  exportFill.style.width = '0%';
  exportPercent.textContent = msg;
}

function setExportProgress(frac, msg) {
  const pct = Math.min(100, Math.round(frac * 100));
  exportFill.style.width = pct + '%';
  exportPercent.textContent = msg || pct + '%';
}

function downloadBlob(blob, fileExt) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `clip-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${fileExt}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportVideo() {
  if (!videoBlob || exportJob) return;
  const job = exportJob = { cancelled: false };
  const resumeAt = sourceVideo.currentTime;
  sourceVideo.pause();
  stopPlaybackLoop();
  setExportUi(true, 'Preparing...');

  try {
    let result;
    try {
      result = await exportOffline(job);
    } catch (err) {
      if (err instanceof ExportCancelled) throw err;
      console.warn('[MCR export] Offline render failed, recording in real time instead:', err);
      setExportUi(true, 'Recording in real time (do not switch tabs)...');
      result = await exportRealtime(job);
    }
    downloadBlob(result.blob, result.ext);
  } catch (err) {
    if (!(err instanceof ExportCancelled)) {
      console.error('[MCR export] Error:', err);
      alert('Export error: ' + err.message);
    }
  } finally {
    exportJob = null;
    setExportUi(false);
    seekTo(resumeAt);
  }
}

async function exportOffline(job) {
  if (typeof VideoEncoder === 'undefined') throw new Error('WebCodecs is not available');
  const MB = await import('./lib/mediabunny.min.mjs');
  const input = new MB.Input({ source: new MB.BlobSource(videoBlob), formats: MB.ALL_FORMATS });
  let output = null;
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('The recording has no video track');
    const audioTrack = await input.getPrimaryAudioTrack();

    const W = previewCanvas.width, H = previewCanvas.height;
    const videoQuality = new MB.Quality({ bitrate: exportBitrate(W, H) });
    // H.264 plays everywhere; the others only if this machine can't encode it at this size
    const videoCodec = await MB.getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'],
      { width: W, height: H, quality: videoQuality });
    if (!videoCodec) throw new Error(`No video encoder for ${W}x${H}`);
    const audioCodec = audioTrack && await MB.getFirstEncodableAudioCodec(['aac', 'opus'],
      { numberOfChannels: audioTrack.numberOfChannels, sampleRate: audioTrack.sampleRate });

    output = new MB.Output({
      format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new MB.BufferTarget(),
    });
    const videoSource = new MB.CanvasSource(previewCanvas, {
      codec: videoCodec,
      quality: videoQuality,
      keyFrameInterval: 2,
    });
    output.addVideoTrack(videoSource, { frameRate: EXPORT_FPS });
    let audioSource = null;
    if (audioCodec) {
      audioSource = new MB.AudioBufferSource({ codec: audioCodec, quality: new MB.Quality({ bitrate: 192_000 }) });
      output.addAudioTrack(audioSource);
    }
    await output.start();
    console.log(`[MCR export] Offline ${W}x${H}@${EXPORT_FPS} ${videoCodec}` +
      (audioCodec ? ` + ${audioCodec}` : ' (no audio)'));

    // Tracks are fed side by side so the muxer can interleave them; if one
    // fails, the other stops at its next step
    let failed = false;
    const run = { get cancelled() { return job.cancelled || failed; } };
    const fail = err => { failed = true; throw err; };
    await Promise.all([
      renderVideoFrames(MB, videoTrack, videoSource, run).catch(fail),
      audioSource && renderAudio(MB, audioTrack, audioSource, run).catch(fail),
    ]);

    setExportProgress(1, 'Finishing file...');
    await output.finalize();
    return { blob: new Blob([output.target.buffer], { type: 'video/mp4' }), ext: 'mp4' };
  } catch (err) {
    if (output && output.state !== 'finalized') await output.cancel().catch(() => {});
    throw err;
  } finally {
    input.dispose();
  }
}

async function renderVideoFrames(MB, videoTrack, videoSource, job) {
  const frameCount = Math.max(1, Math.round(outputDurationMs() / 1000 * EXPORT_FPS));
  const durSec = sourceVideo.duration;
  const srcTimes = new Float64Array(frameCount);
  for (let n = 0; n < frameCount; n++) {
    srcTimes[n] = Math.min(durSec, fromOutputMs(n * 1000 / EXPORT_FPS) / 1000);
  }

  // Yields one decoded frame per timestamp, decoding each packet only once
  const sink = new MB.VideoSampleSink(videoTrack);
  let shown = null; // last real frame, reused if a timestamp precedes the first one
  let n = 0;
  try {
    for await (const sample of sink.samplesAtTimestamps(srcTimes)) {
      if (job.cancelled) throw new ExportCancelled();
      if (sample) {
        if (shown) shown.close();
        shown = sample;
      }
      if (shown) renderFrame(srcTimes[n], { source: shown });
      await videoSource.add(n / EXPORT_FPS, 1 / EXPORT_FPS);
      n++;
      if (n % 10 === 0) setExportProgress(n / frameCount * 0.98);
    }
  } finally {
    if (shown) shown.close();
  }
}

// Audio follows the cuts: 1× stretches are copied, cuts are dropped and
// speed-ups / slow motion are silent (pitch-shifted audio sounds broken)
async function renderAudio(MB, audioTrack, audioSource, job) {
  const sr = audioTrack.sampleRate;
  const channels = audioTrack.numberOfChannels;
  const fade = Math.round(sr * AUDIO_FADE_SEC);
  const totalOut = Math.round(outputDurationMs() / 1000 * sr);
  let written = 0; // output samples so far

  const silenceUntil = async (pos) => {
    while (written < pos) {
      const len = Math.min(pos - written, sr);
      await audioSource.add(new AudioBuffer({ length: len, numberOfChannels: channels, sampleRate: sr }));
      written += len;
    }
  };
  const segmentAt = ms => segments.find(sg => ms >= sg.start && ms < sg.end);
  const nextSegmentStart = ms => {
    const sg = segments.find(s => s.start > ms);
    return sg ? sg.start : Infinity;
  };

  const sink = new MB.AudioBufferSink(audioTrack);
  for await (const { buffer, timestamp } of sink.buffers()) {
    if (job.cancelled) throw new ExportCancelled();
    const bufStartMs = timestamp * 1000;
    const bufEndMs = bufStartMs + buffer.duration * 1000;
    let a = Math.max(0, bufStartMs);
    while (a < bufEndMs) {
      const sg = segmentAt(a);
      const b = Math.min(bufEndMs, sg ? sg.end : nextSegmentStart(a));
      if (!sg) {
        // Copy this 1× stretch to where it lands in the output
        const outPos = Math.round(toOutputMs(a) / 1000 * sr);
        await silenceUntil(outPos);
        const i0 = Math.round((a - bufStartMs) / 1000 * sr) + (written - outPos);
        const i1 = Math.min(buffer.length, Math.round((b - bufStartMs) / 1000 * sr));
        if (i1 > i0) {
          const piece = new AudioBuffer({ length: i1 - i0, numberOfChannels: channels, sampleRate: sr });
          const fadeIn = segments.some(s => s.end === a);
          const fadeOut = segments.some(s => s.start === b);
          for (let c = 0; c < channels; c++) {
            const data = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)).slice(i0, i1);
            const len = data.length;
            for (let i = 0; i < Math.min(fade, len); i++) {
              if (fadeIn) data[i] *= i / fade;
              if (fadeOut) data[len - 1 - i] *= i / fade;
            }
            piece.copyToChannel(data, c);
          }
          await audioSource.add(piece);
          written += piece.length;
        }
      }
      a = b;
    }
  }
  // Pad to the video's length (trailing cut / speed-up, or audio that ends early)
  await silenceUntil(totalOut);
}

// --- Fallback: record the canvas in real time (MediaRecorder) ---
// MP4 (H.264) is accepted by every social/marketing tool; fall back to
// high-bitrate VP9 WebM on Chrome builds that can't record MP4
const EXPORT_MIME_TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp9',
];

async function exportRealtime(job) {
  // Positioning at the start (after a cut that begins at 0, if any)
  seekTo(firstPlayableSec());
  // Give enough time to ensure UI is ready and the frame is painted
  await new Promise(r => setTimeout(r, 600));

  ensureAudioCapture();
  const stream = previewCanvas.captureStream(EXPORT_FPS);
  audioExportDestination.stream.getAudioTracks().forEach(track => stream.addTrack(track));

  const exportMime = EXPORT_MIME_TYPES.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
  const exportExt = exportMime.startsWith('video/mp4') ? 'mp4' : 'webm';
  const mediaRecorder = new MediaRecorder(stream, {
    mimeType: exportMime,
    videoBitsPerSecond: exportBitrate(previewCanvas.width, previewCanvas.height),
    audioBitsPerSecond: 192_000,
  });

  const recordedChunks = [];
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };
  const stopped = new Promise(resolve => { mediaRecorder.onstop = resolve; });

  // Keep chunks small to handle memory easily
  mediaRecorder.start(100);
  sourceVideo.play();
  isPlaying = true;
  playPauseBtn.textContent = '⏸';
  startPlaybackLoop();

  const duration = sourceVideo.duration || 1;
  const outTotal = outputDurationMs() || 1;
  await new Promise(resolve => {
    const progressInterval = setInterval(() => {
      // Stop when the video finishes or the user cancels
      if (job.cancelled || sourceVideo.ended || sourceVideo.currentTime >= duration) {
        clearInterval(progressInterval);
        resolve();
      } else {
        setExportProgress(toOutputMs(sourceVideo.currentTime * 1000) / outTotal);
      }
    }, 200);
  });

  sourceVideo.pause();
  stopPlaybackLoop();
  playPauseBtn.textContent = '▶';
  setExportProgress(1, 'Processing file...');
  if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  await stopped;
  if (job.cancelled) throw new ExportCancelled();
  return { blob: new Blob(recordedChunks, { type: exportMime.split(';')[0] }), ext: exportExt };
}
