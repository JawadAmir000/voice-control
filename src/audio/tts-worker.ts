// Runs in its own Electron utility process: turns reply text into natural speech with a
// local Piper voice (free, offline). The audio is played inside the app window, so the
// browser's echo cancellation removes it from the microphone (Windows speech can't be).
//
// sherpa-onnx v2 dropped the espeak pronunciation engine Piper needs, so this process uses
// the 1.x library ("sherpa-tts" alias). Its loader wrongly picks the top-level v2 native
// addon; we hand it its own nested v1 addon through the require cache.
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sentences } from './sentences.js';

const require = createRequire(import.meta.url);
const nm = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules');
const v1Addon = path.join(nm, 'sherpa-tts', 'node_modules', 'sherpa-onnx-win-x64', 'sherpa-onnx.node');
const v2Key = path.join(nm, 'sherpa-onnx-win-x64', 'sherpa-onnx.node');

type Msg = { type: 'init'; modelsDir: string; voice: string; speed: number } | { type: 'speak'; id: number; text: string } | { type: 'cancel'; id: number };
const port = (process as unknown as { parentPort: { on(e: 'message', cb: (e: { data: Msg }) => void): void; postMessage(m: unknown): void } }).parentPort;
const send = (m: unknown) => port.postMessage(m);

let tts: any;
let speed = 1;
let cancelled = -1;
const jobs: { id: number; text: string }[] = [];
let working = false;

function init(modelsDir: string, voice: string, s: number) {
  const dir = path.join(modelsDir, `vits-piper-${voice}`);
  const model = path.join(dir, `${voice}.onnx`);
  if (!existsSync(model)) throw new Error(`Voice model missing (${model}). Run "npm run models".`);
  const native = require(v1Addon);
  require.cache[v2Key] = { id: v2Key, filename: v2Key, loaded: true, exports: native } as any;
  const sherpa = require(path.join(nm, 'sherpa-tts'));
  tts = new sherpa.OfflineTts({
    model: { vits: { model, tokens: path.join(dir, 'tokens.txt'), dataDir: path.join(dir, 'espeak-ng-data') }, numThreads: 2, provider: 'cpu', debug: 0 },
    maxNumSentences: 1,
  });
  speed = s;
}

async function pump() {
  if (working) return;
  working = true;
  while (jobs.length) {
    const { id, text } = jobs.shift()!;
    const parts = sentences(text);
    try {
    for (let i = 0; i < parts.length; i++) {
      if (cancelled >= id) break;
      const t = Date.now();
      // Electron forbids "external" buffers, so ask for a normal copy of the samples.
      const audio = tts.generate({ text: parts[i], sid: 0, speed, enableExternalBuffer: false });
      if (cancelled >= id) break;
      send({ type: 'chunk', id, samples: audio.samples, sampleRate: audio.sampleRate, last: i === parts.length - 1, ms: Date.now() - t });
      await new Promise((r) => setImmediate(r)); // let cancel messages in between sentences
    }
    } catch (e) {
      // Never leave the assistant silent: tell main, which speaks this reply with Windows speech.
      send({ type: 'failed', id, message: (e as Error).message });
      continue;
    }
    if (parts.length === 0) send({ type: 'chunk', id, samples: new Float32Array(0), sampleRate: 22050, last: true, ms: 0 });
  }
  working = false;
}

port.on('message', ({ data }) => {
  try {
    if (data.type === 'init') {
      init(data.modelsDir, data.voice, data.speed);
      send({ type: 'ready' });
    } else if (data.type === 'speak') {
      jobs.push({ id: data.id, text: data.text });
      void pump();
    } else if (data.type === 'cancel') {
      cancelled = Math.max(cancelled, data.id);
      for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].id <= data.id) jobs.splice(i, 1);
    }
  } catch (e) {
    send({ type: 'error', message: (e as Error).message });
  }
});
