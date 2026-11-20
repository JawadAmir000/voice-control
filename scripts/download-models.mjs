// Downloads the free local speech models (voice activity detection, speech recognition, voice).
// Usage: npm run models             (Parakeet TDT 0.6B v2, ~480 MB: the default recognizer)
//        npm run models -- base.en  (also a Whisper model, for "sttModel": "whisper")
import { existsSync, mkdirSync, createWriteStream, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'models');
const whisper = process.argv[2]; // optional Whisper model name
const base = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
mkdirSync(root, { recursive: true });
// Use Windows' own bsdtar; Git's GNU tar misreads "C:" as a remote host.
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

async function download(url, dest) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const tmp = dest + '.part';
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  renameSync(tmp, dest);
}

const vad = path.join(root, 'silero_vad.onnx');
if (!existsSync(vad)) await download(`${base}/silero_vad.onnx`, vad);
else console.log('VAD model already present');

async function fetchModel(name, label, release = base) {
  if (existsSync(path.join(root, name))) return console.log(`${label} already present`);
  const archive = path.join(root, `${name}.tar.bz2`);
  if (!existsSync(archive)) await download(`${release}/${name}.tar.bz2`, archive);
  console.log(`Extracting ${label}...`);
  execFileSync(tar, ['-xjf', archive, '-C', root], { stdio: 'inherit' });
  (await import('node:fs')).rmSync(archive);
}

// Parakeet: far more accurate than Whisper base, and it doesn't invent sentences from noise.
await fetchModel('sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', 'Parakeet');
// Wake-word listener: a small keyword spotter that hears "Hey Nova" by sound, not by spelling.
await fetchModel('sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01', 'Wake-word model', 'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models');
if (whisper) await fetchModel(`sherpa-onnx-whisper-${whisper}`, `Whisper ${whisper}`);
// Natural-sounding local voice for replies (Piper, played inside the app so echo cancellation works).
const voice = process.env.VC_VOICE || 'en_US-lessac-medium';
const vdir = path.join(root, `vits-piper-${voice}`);
if (!existsSync(vdir)) {
  const archive = path.join(root, `voice-${voice}.tar.bz2`);
  if (!existsSync(archive)) await download(`https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-${voice}.tar.bz2`, archive);
  console.log('Extracting voice...');
  execFileSync(tar, ['-xjf', archive, '-C', root], { stdio: 'inherit' });
  (await import('node:fs')).rmSync(archive);
} else console.log(`Voice ${voice} already present`);

console.log('Models ready in', root);
