// Runs in an Electron utility process so speech recognition never blocks the UI.
// Receives 16 kHz mono Float32 audio, finds speech with Silero VAD, transcribes each
// utterance with Whisper (all local, free, offline) and posts the text back.
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

type Msg = { type: 'init'; modelsDir: string; whisper: string } | { type: 'audio'; samples: Float32Array } | { type: 'mute'; on: boolean } | { type: 'reset' };

const port = (process as unknown as { parentPort: { on(e: 'message', cb: (e: { data: Msg }) => void): void; postMessage(m: unknown): void } }).parentPort;
const send = (m: unknown) => port.postMessage(m);

let vad: any;
let recognizer: any;
let muted = false;
let wasSpeaking = false;

function init(modelsDir: string, whisper: string) {
  const vadModel = path.join(modelsDir, 'silero_vad.onnx');
  const dir = path.join(modelsDir, `sherpa-onnx-whisper-${whisper}`);
  const enc = path.join(dir, `${whisper}-encoder.int8.onnx`);
  const dec = path.join(dir, `${whisper}-decoder.int8.onnx`);
  const tokens = path.join(dir, `${whisper}-tokens.txt`);
  for (const f of [vadModel, enc, dec, tokens]) {
    if (!existsSync(f)) throw new Error(`Missing model file ${f}. Run "npm run models".`);
  }
  vad = new sherpa.Vad(
    {
      sileroVad: { model: vadModel, threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.7, maxSpeechDuration: 25, windowSize: 512 },
      sampleRate: 16000,
      numThreads: 1,
      debug: false,
    },
    60,
  );
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: { encoder: enc, decoder: dec, language: whisper.endsWith('.en') ? '' : 'en', task: 'transcribe', tailPaddings: -1 },
      tokens,
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
  });
}

// Whisper "hears" these in silence or noise.
const HALLUCINATIONS = /^(\[.*\]|\(.*\)|\*.*|♪.*|thank you\.?|thanks for watching!?|you|bye\.?|\.+|okay\.?)$/i;

/** Returns the cleaned text ('' for noise) plus Whisper's raw output and the loudness, for the log. */
function transcribe(samples: Float32Array): { text: string; raw: string; db: number } {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const db = Math.round(20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9));
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate: 16000 });
  recognizer.decode(stream);
  const raw = String(recognizer.getResult(stream).text ?? '').trim();
  if (HALLUCINATIONS.test(raw)) return { text: '', raw, db };
  // Drop sound labels like "(buzzing)", "[music]", "*cough*" (even if cut off), then require real words.
  const words = raw.replace(/[([*♪][^)\]*♪]*([)\]*♪]|$)/g, ' ').replace(/[^a-zA-Z' ]+/g, ' ').trim();
  return { text: /[a-zA-Z]{2,}/.test(words) ? raw : '', raw, db };
}

let buffer = new Float32Array(0);
function onAudio(chunk: Float32Array) {
  if (muted) return;
  // Feed the VAD in exact 512-sample windows.
  const merged = new Float32Array(buffer.length + chunk.length);
  merged.set(buffer);
  merged.set(chunk, buffer.length);
  let off = 0;
  while (merged.length - off >= 512) {
    vad.acceptWaveform(merged.subarray(off, off + 512));
    off += 512;
  }
  buffer = merged.slice(off);

  const speaking = vad.isDetected();
  if (speaking !== wasSpeaking) {
    wasSpeaking = speaking;
    send({ type: 'speech', on: speaking });
  }
  while (!vad.isEmpty()) {
    const seg = vad.front(false);
    vad.pop();
    const samples: Float32Array = seg.samples;
    const t = Date.now();
    const { text, raw, db } = transcribe(samples);
    send({ type: 'text', text, raw, db, seconds: samples.length / 16000, ms: Date.now() - t });
  }
}

port.on('message', ({ data }) => {
  try {
    if (data.type === 'init') {
      init(data.modelsDir, data.whisper);
      send({ type: 'ready' });
    } else if (data.type === 'audio') {
      if (vad) onAudio(data.samples instanceof Float32Array ? data.samples : new Float32Array(data.samples));
    } else if (data.type === 'mute') {
      muted = data.on;
      if (muted && vad) { vad.reset(); buffer = new Float32Array(0); wasSpeaking = false; }
    } else if (data.type === 'reset') {
      vad?.reset();
      buffer = new Float32Array(0);
    }
  } catch (e) {
    send({ type: 'error', message: (e as Error).message });
  }
});
