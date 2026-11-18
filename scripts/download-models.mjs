// Downloads the free local speech models (voice activity detection + Whisper).
// Usage: npm run models            (Whisper base.en, ~200 MB)
//        npm run models -- small.en (more accurate, slower)
import { existsSync, mkdirSync, createWriteStream, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'models');
const whisper = process.argv[2] || 'base.en';
const base = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
mkdirSync(root, { recursive: true });

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

const dir = path.join(root, `sherpa-onnx-whisper-${whisper}`);
if (!existsSync(dir)) {
  const archive = path.join(root, `whisper-${whisper}.tar.bz2`);
  if (!existsSync(archive)) await download(`${base}/sherpa-onnx-whisper-${whisper}.tar.bz2`, archive);
  console.log('Extracting...');
  // Use Windows' own bsdtar; Git's GNU tar misreads "C:" as a remote host.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xjf', archive, '-C', root], { stdio: 'inherit' });
  (await import('node:fs')).rmSync(archive);
} else console.log(`Whisper ${whisper} already present`);
console.log('Models ready in', root);
