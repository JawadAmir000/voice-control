// Runs in an Electron utility process so speech recognition never blocks the UI.
// Receives 16 kHz mono Float32 audio, finds speech with Silero VAD, transcribes each
// utterance with Parakeet or Whisper (all local, free, offline) and posts the text back.
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { parseVocab, wakeKeywords } from './kws.js';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');
import { isRepetitive } from './clean.js';

type Msg = { type: 'init'; modelsDir: string; stt: string; whisper: string; name?: string } | { type: 'audio'; samples: Float32Array } | { type: 'mute'; on: boolean } | { type: 'reset' };

const port = (process as unknown as { parentPort: { on(e: 'message', cb: (e: { data: Msg }) => void): void; postMessage(m: unknown): void } }).parentPort;
const send = (m: unknown) => port.postMessage(m);

let vad: any;
let recognizer: any;
let muted = false;
let wasSpeaking = false;

const PARAKEET = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8';

function need(...files: string[]) {
  for (const f of files) if (!existsSync(f)) throw new Error(`Missing model file ${f}. Run "npm run models".`);
}

/** Parakeet, unless Whisper is asked for or Parakeet hasn't been downloaded yet. */
function modelConfig(modelsDir: string, stt: string, whisper: string): { name: string; config: object } {
  const pk = path.join(modelsDir, PARAKEET);
  if (stt !== 'whisper' && existsSync(pk)) {
    const f = (n: string) => path.join(pk, n);
    need(f('encoder.int8.onnx'), f('decoder.int8.onnx'), f('joiner.int8.onnx'), f('tokens.txt'));
    return {
      name: 'parakeet-tdt-0.6b-v2',
      config: {
        transducer: { encoder: f('encoder.int8.onnx'), decoder: f('decoder.int8.onnx'), joiner: f('joiner.int8.onnx') },
        tokens: f('tokens.txt'),
        modelType: 'nemo_transducer',
      },
    };
  }
  const dir = path.join(modelsDir, `sherpa-onnx-whisper-${whisper}`);
  const enc = path.join(dir, `${whisper}-encoder.int8.onnx`);
  const dec = path.join(dir, `${whisper}-decoder.int8.onnx`);
  const tokens = path.join(dir, `${whisper}-tokens.txt`);
  need(enc, dec, tokens);
  return {
    name: `whisper-${whisper}${stt === 'whisper' ? '' : ' (Parakeet not downloaded, run "npm run models")'}`,
    config: { whisper: { encoder: enc, decoder: dec, language: whisper.endsWith('.en') ? '' : 'en', task: 'transcribe', tailPaddings: -1 }, tokens },
  };
}

/** Loads the models; returns the recognizer's name for the log. */
function init(modelsDir: string, stt: string, whisper: string): string {
  const vadModel = path.join(modelsDir, 'silero_vad.onnx');
  need(vadModel);
  const model = modelConfig(modelsDir, stt, whisper);
  vad = new sherpa.Vad(
    {
      // 0.6 rather than 0.5, so fans, clicks and distant chatter don't reach the recognizer.
      sileroVad: { model: vadModel, threshold: 0.6, minSpeechDuration: 0.25, minSilenceDuration: 0.7, maxSpeechDuration: 15, windowSize: 512 },
      sampleRate: 16000,
      numThreads: 1,
      debug: false,
    },
    60,
  );
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { ...model.config, numThreads: 4, provider: 'cpu', debug: 0 },
  });
  return model.name;
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
  if (HALLUCINATIONS.test(raw) || isRepetitive(raw)) return { text: '', raw: raw.slice(0, 80), db };
  // Drop sound labels like "(buzzing)", "[music]", "*cough*" (even if cut off), then require real words.
  const words = raw.replace(/[([*♪][^)\]*♪]*([)\]*♪]|$)/g, ' ').replace(/[^a-zA-Z' ]+/g, ' ').trim();
  return { text: /[a-zA-Z]{2,}/.test(words) ? raw : '', raw, db };
}

// ---------------------------------------------------------------- wake-word spotter
// A small keyword-spotting model listens for "Hey Nova" by sound, alongside the VAD. When it
// fires, the app wakes at once; the clip it was in is transcribed from after the wake phrase,
// so only the command reaches the recognizer.

const KWS = 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01';
const KWS_FILE = 'epoch-12-avg-2-chunk-16-left-64.int8.onnx';
const WAKE_LATENCY = 0.35; // seconds; 0.3–0.4 cut cleanly on recordings, 0.2 left "a notepad"
let spotter: any;
let kwsStream: any;
/** Samples fed to the VAD and spotter since start: the clock for the positions below. */
let fed = 0;
let vadBase = 0; // `fed` when the VAD was last reset (its segment starts count from there)
/** Where the last wake phrase ended, waiting for the clip that contains it. */
let wakeEnd: number | undefined;

function initSpotter(modelsDir: string, name: string): boolean {
  const dir = path.join(modelsDir, KWS);
  if (!name || !existsSync(dir)) return false;
  const f = (n: string) => path.join(dir, n);
  const keywords = wakeKeywords(name, parseVocab(readFileSync(f('tokens.txt'), 'utf8')));
  if (!keywords.length) return false;
  const file = path.join(os.tmpdir(), 'voice-control-keywords.txt');
  writeFileSync(file, keywords.join('\n') + '\n');
  spotter = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: f(`encoder-${KWS_FILE}`), decoder: f(`decoder-${KWS_FILE}`), joiner: f(`joiner-${KWS_FILE}`) },
      tokens: f('tokens.txt'),
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    // Tested on recordings: catches "Hey Nova" / "Hello Nova", ignores "supernovas", "hand over", "hey, no way".
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: 1.5,
    keywordsThreshold: 0.2,
    keywordsFile: file,
  });
  restartSpotter();
  return true;
}

function restartSpotter() {
  if (!spotter) return;
  kwsStream = spotter.createStream();
}

function spot(window: Float32Array) {
  kwsStream.acceptWaveform({ samples: window, sampleRate: 16000 });
  while (spotter.isReady(kwsStream)) {
    spotter.decode(kwsStream);
    const r = spotter.getResult(kwsStream);
    if (!r.keyword) continue;
    // The spotter's own timestamps drift after a reset, so measure from when it fired: it
    // reacts about a third of a second after the wake phrase ends (measured on recordings).
    wakeEnd = fed - Math.round(WAKE_LATENCY * 16000);
    send({ type: 'wake', phrase: String(r.keyword).replace(/_/g, ' ') });
    spotter.reset(kwsStream);
  }
}

/** Cut at the wake phrase if this clip contains it: "Hey Nova, open Notepad" → "open Notepad". */
function afterWake(samples: Float32Array, start: number): { samples: Float32Array; cut: number } | undefined {
  if (wakeEnd === undefined) return undefined;
  const end = start + samples.length;
  if (wakeEnd > end + 8000) return undefined; // belongs to a later clip
  const at = wakeEnd - start;
  wakeEnd = undefined;
  if (at < 0) return undefined; // the wake phrase came before this clip
  return { samples: samples.subarray(Math.min(at, samples.length)), cut: at / 16000 };
}

// ---------------------------------------------------------------- audio in

function resetVad() {
  vad.reset();
  vadBase = fed;
  wakeEnd = undefined;
  restartSpotter();
}

let buffer = new Float32Array(0);
function onAudio(chunk: Float32Array) {
  if (muted) return;
  // Feed the VAD (and spotter) in exact 512-sample windows.
  const merged = new Float32Array(buffer.length + chunk.length);
  merged.set(buffer);
  merged.set(chunk, buffer.length);
  let off = 0;
  while (merged.length - off >= 512) {
    const window = merged.subarray(off, off + 512);
    vad.acceptWaveform(window);
    fed += 512;
    if (spotter) spot(window);
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
    const all: Float32Array = seg.samples;
    const woke = afterWake(all, vadBase + Number(seg.start));
    const samples = woke ? woke.samples : all;
    const t = Date.now();
    // Under a third of a second after the wake phrase is just its tail: no command.
    const { text, raw, db } = samples.length >= 0.3 * 16000 ? transcribe(samples) : { text: '', raw: '', db: 0 };
    send({ type: 'text', text, raw, db, seconds: all.length / 16000, ms: Date.now() - t, afterWake: woke ? woke.cut : undefined });
  }
}

port.on('message', ({ data }) => {
  try {
    if (data.type === 'init') {
      const model = init(data.modelsDir, data.stt, data.whisper);
      let spotting = false;
      try {
        spotting = initSpotter(data.modelsDir, data.name ?? '');
      } catch (e) {
        send({ type: 'error', message: `wake-word listener off: ${(e as Error).message}` });
      }
      send({ type: 'ready', model: spotting ? `${model} + wake-word listener` : model });
    } else if (data.type === 'audio') {
      if (vad) onAudio(data.samples instanceof Float32Array ? data.samples : new Float32Array(data.samples));
    } else if (data.type === 'mute') {
      muted = data.on;
      if (muted && vad) { resetVad(); buffer = new Float32Array(0); wasSpeaking = false; }
    } else if (data.type === 'reset') {
      if (vad) resetVad();
      buffer = new Float32Array(0);
    }
  } catch (e) {
    send({ type: 'error', message: (e as Error).message });
  }
});
