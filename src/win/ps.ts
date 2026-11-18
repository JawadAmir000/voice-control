import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'helper.ps1');
const END = '<<<VC-END>>>';

/** Safely embeds any string in a one-line PowerShell command. */
export function psStr(s: string): string {
  const b64 = Buffer.from(s, 'utf8').toString('base64');
  return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
}

type Job = { cmd: string; resolve: (v: unknown) => void; reject: (e: Error) => void };

/** A long-lived PowerShell process with helper.ps1 loaded, so each call is fast. */
class PowerShellHost {
  private proc?: ChildProcessWithoutNullStreams;
  private queue: Job[] = [];
  private current?: Job;
  private buffer = '';
  private errBuffer = '';

  private start() {
    const p = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
      windowsHide: true,
    });
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d: string) => this.onData(d));
    p.stderr.on('data', (d: string) => (this.errBuffer += d));
    p.on('exit', () => {
      this.proc = undefined;
      this.current?.reject(new Error('PowerShell helper exited: ' + this.errBuffer.slice(-500)));
      this.current = undefined;
      this.pump();
    });
    p.stdin.write(`. '${HELPER.replace(/'/g, "''")}'; [Console]::Out.WriteLine('${END}')\n`);
    this.proc = p;
    // The load line produces an END marker; swallow it as a no-op job.
    this.current = { cmd: '', resolve: () => {}, reject: () => {} };
  }

  private onData(d: string) {
    this.buffer += d;
    let idx: number;
    while ((idx = this.buffer.indexOf(END)) >= 0) {
      const out = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + END.length).replace(/^\r?\n/, '');
      const job = this.current;
      this.current = undefined;
      if (job) {
        const last = out.split(/\r?\n/).filter(Boolean).pop() ?? '';
        try {
          const val = last ? JSON.parse(last) : null;
          if (val && typeof val === 'object' && 'vcError' in val) job.reject(new Error(String(val.vcError)));
          else job.resolve(val);
        } catch {
          job.resolve(out);
        }
      }
      this.pump();
    }
  }

  private pump() {
    if (this.current || this.queue.length === 0) return;
    if (!this.proc) this.start();
    if (this.current) return; // still loading the helper
    const job = this.queue.shift()!;
    this.current = job;
    this.errBuffer = '';
    this.proc!.stdin.write(
      `try { ${job.cmd} } catch { Out-Json @{ vcError = $_.Exception.Message } }; [Console]::Out.WriteLine('${END}')\n`,
    );
  }

  run<T = unknown>(cmd: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ cmd, resolve: resolve as (v: unknown) => void, reject });
      this.pump();
    });
  }

  stop() {
    this.proc?.kill();
  }
}

export const ps = new PowerShellHost();

/** Runs a standalone PowerShell script (for the general-purpose run_powershell tool). */
export function runScript(script: string, timeoutMs = 60_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const encoded = Buffer.from(
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'\n${script}`,
      'utf16le',
    ).toString('base64');
    const p = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
    });
    let output = '';
    p.stdout.on('data', (d) => (output += d));
    p.stderr.on('data', (d) => (output += d));
    const timer = setTimeout(() => {
      output += `\n[stopped after ${timeoutMs / 1000}s]`;
      p.kill();
    }, timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.length > 8000 ? output.slice(0, 8000) + '\n[output truncated]' : output });
    });
  });
}
