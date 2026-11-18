// Text-only mode: type commands instead of speaking. Handy for testing the brain and tools.
//   npm run try                      (interactive)
//   npm run try -- "open notepad"    (one command, then exit)
import readline from 'node:readline/promises';
import { Brain } from './brain/agent.js';
import type { Host } from './brain/host.js';
import { ps } from './win/ps.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const once = process.argv.slice(2).join(' ').trim();

const host: Host = {
  status: (s, detail) => console.log(`  [${s}]${detail ? ' ' + detail : ''}`),
  say: (t) => console.log(`🗣  ${t}`),
  ask: async (q) => (once ? '' : (await rl.question(`❓ ${q}\n> `)).trim()),
  confirm: async (q) => {
    if (once) { console.log(`❓ ${q} → (no answer in one-shot mode, declining)`); return false; }
    return /^(y|yes|ok|sure|go)/i.test((await rl.question(`❓ ${q} [y/N] `)).trim());
  },
};

const brain = new Brain(host, { model: process.env.VC_MODEL, log: (...a) => process.env.VC_DEBUG && console.log('   ·', ...a) });

async function run(cmd: string) {
  const t = Date.now();
  const reply = await brain.send(cmd);
  console.log(`🗣  ${reply}   (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}

if (once) {
  await run(once);
} else {
  console.log('Type a command (Ctrl+C to quit).');
  for (;;) {
    const cmd = (await rl.question('> ')).trim();
    if (cmd) await run(cmd);
  }
}
brain.stop();
ps.stop();
rl.close();
process.exit(0);
