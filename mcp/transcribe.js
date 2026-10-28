// Local speech-to-text for subtitles (Whisper via transformers.js, on the CPU).
//
// Claude cannot hear audio, so the soundtrack is transcribed here, on this
// machine: nothing is uploaded. The model is downloaded once from Hugging Face
// (≈ 80 MB "base", ≈ 250 MB "small") into transformers.js' cache, then works
// offline. @huggingface/transformers is an optional dependency: without it
// every other tool still works and transcribe says how to install it.

const MODELS = {
  tiny: 'onnx-community/whisper-tiny_timestamped',
  base: 'onnx-community/whisper-base_timestamped',
  small: 'onnx-community/whisper-small_timestamped',
};

const pipes = new Map(); // model -> Promise<pipeline>

async function loadPipeline(model) {
  if (!pipes.has(model)) {
    const p = (async () => {
      let tf;
      try {
        tf = await import('@huggingface/transformers');
      } catch {
        throw new Error('Transcription needs @huggingface/transformers: run `npm install` in the mcp/ folder, then restart Claude Code.');
      }
      // The packaged app may live in a read-only folder: keep models per user
      if (process.env.MCR_MODEL_CACHE) tf.env.cacheDir = process.env.MCR_MODEL_CACHE;
      return tf.pipeline('automatic-speech-recognition', MODELS[model], { dtype: 'q8' });
    })();
    pipes.set(model, p);
    p.catch(() => pipes.delete(model));
  }
  return pipes.get(model);
}

// pcm: Float32Array, 16 kHz mono. Returns words [{ text, start, end }] in seconds
// relative to the start of pcm, and the full text.
export async function transcribePcm(pcm, { model = 'small', language = null } = {}) {
  if (!MODELS[model]) throw new Error(`model must be one of ${Object.keys(MODELS).join(', ')}`);
  const asr = await loadPipeline(model);
  const out = await asr(pcm, {
    return_timestamps: 'word',
    chunk_length_s: 30,
    task: 'transcribe',
    ...(language && { language }),
  });
  // Long audio is decoded in overlapping 30 s windows; where they meet, words
  // can come out twice, or as zero-length ghosts. Time only moves forward,
  // so drop any that go back or take no time at all
  // The last word's end can come out past the audio, or absurdly long
  const durSec = pcm.length / 16000;
  const words = [];
  for (const c of out.chunks || []) {
    const start = c.timestamp[0];
    const w = { text: c.text.trim(), start, end: Math.min(c.timestamp[1] ?? start + 0.3, start + 2.5, durSec) };
    const prev = words[words.length - 1];
    if (!w.text || w.end - w.start < 0.02 || (prev && w.start < prev.end - 0.05)) continue;
    words.push(w);
  }
  return { text: words.map(w => w.text).join(' '), words };
}

// Words → subtitle cues: a new cue at a pause, after a sentence, or when the
// line would get too long or stay on screen too long. maxChars ≈ two short
// lines; subtitles read best at 1–6 s each.
export function wordsToCues(words, { maxChars = 42, maxSec = 5.5, pauseSec = 0.6 } = {}) {
  const cues = [];
  let cur = null;
  const flush = () => { if (cur) cues.push(cur); cur = null; };
  for (const w of words) {
    if (cur) {
      const len = cur.text.length + 1 + w.text.length;
      const last = cur.words[cur.words.length - 1];
      const sentenceEnd = /[.?!…]$/.test(last.text);
      const clauseEnd = /[,;:]$/.test(last.text);
      // A word that closes the sentence may overflow a little: better than
      // leaving it alone on the next cue ("…la sala de" / "comunicación.")
      const tooLong = len > maxChars && !(/[.?!…]$/.test(w.text) && len <= maxChars * 1.35);
      if (w.start - last.end > pauseSec || tooLong || w.end - cur.start > maxSec ||
          (sentenceEnd && cur.text.length >= 12) || (clauseEnd && cur.text.length >= maxChars * 0.6)) {
        flush();
      }
    }
    if (!cur) cur = { start: w.start, end: w.end, text: w.text, words: [w] };
    else {
      cur.text += ' ' + w.text;
      cur.end = w.end;
      cur.words.push(w);
    }
  }
  flush();
  // Hold each cue a moment after the last word, never into the next one
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    cues[i].end = Math.min(cues[i].end + 0.35, next ? next.start : Infinity);
    if (cues[i].end - cues[i].start < 0.7) cues[i].end = Math.min(cues[i].start + 0.7, next ? next.start : Infinity);
  }
  return cues;
}

// 16-bit PCM → WAV file bytes (for clients whose model can listen)
export function pcm16ToWav(pcm16Bytes, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm16Bytes.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm16Bytes.length, 40);
  return Buffer.concat([header, pcm16Bytes]);
}

export function pcm16ToFloat32(bytes) {
  if (bytes.byteOffset % 2) bytes = new Uint8Array(bytes); // Int16Array needs an aligned offset
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
  return Float32Array.from(i16, v => v / 32768);
}
