/**
 * First-run setup for the installed app: download the speech models, and sign in to Claude.
 * (In a development checkout you do these with `npm run models` and `npm run login`.)
 */
import { app, utilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { CONFIG_DIR } from '../config.js';

/** Where the speech models live: next to the code when developing, in %APPDATA% when installed. */
export function modelsDir(root: string): string {
  if (process.env.VC_MODELS_DIR) return process.env.VC_MODELS_DIR;
  const local = path.join(root, 'models');
  return app.isPackaged && !existsSync(path.join(local, 'silero_vad.onnx')) ? path.join(CONFIG_DIR, 'models') : local;
}

/** Are the models the app needs by default present? */
export function haveModels(dir: string): boolean {
  return ['silero_vad.onnx', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', 'vits-piper-en_US-lessac-medium'].every((f) => existsSync(path.join(dir, f)));
}

/**
 * Downloads the models (about 550 MB) with scripts/download-models.mjs.
 * onProgress gets short human messages ("Downloading speech models… 40%").
 */
export function downloadModels(root: string, dir: string, onProgress: (msg: string) => void, log: (...a: unknown[]) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = utilityProcess.fork(path.join(root, 'scripts', 'download-models.mjs'), [], {
      serviceName: 'Nova model download',
      env: { ...process.env, VC_MODELS_DIR: dir },
      stdio: 'pipe',
    });
    // Parakeet is most of the download, so weight the overall percentage towards it.
    const weight: Record<string, [number, number]> = { 'silero_vad.onnx': [0, 1], parakeet: [1, 86], kws: [87, 2], voice: [89, 11] };
    const part = (file: string) => (file.includes('parakeet') ? 'parakeet' : file.includes('kws') ? 'kws' : file.startsWith('voice') ? 'voice' : 'silero_vad.onnx');
    let buf = '';
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const m = line.match(/^progress (\S+) (\d+)$/);
        if (m) {
          const [start, size] = weight[part(m[1])];
          onProgress(`Downloading speech models (one time, about 550 MB)… ${Math.min(99, Math.round(start + (size * Number(m[2])) / 100))}%`);
        } else if (/^Extracting/.test(line)) {
          onProgress('Unpacking speech models…');
          log('[models]', line);
        } else if (line.trim()) log('[models]', line);
      }
    });
    proc.stderr?.on('data', (d: Buffer) => log('[models]', d.toString().trim()));
    proc.on('exit', (code) => resolve(code === 0 && haveModels(dir)));
  });
}

/** Opens a console window that signs in to Claude with your subscription (claude auth login). */
export function signInToClaude(log: (...a: unknown[]) => void) {
  try {
    const require = createRequire(import.meta.url);
    const exe = path.join(path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/package.json')), 'claude.exe');
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // use the subscription login
    delete env.ELECTRON_RUN_AS_NODE;
    spawn('cmd.exe', ['/c', 'start', '"Sign in to Claude"', 'cmd.exe', '/k', `"${exe}" auth login --claudeai`], { env, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  } catch (e) {
    log('could not start Claude sign-in', e);
  }
}
