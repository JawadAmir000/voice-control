// Text-only mode: type commands instead of speaking. Handy for testing the brain and tools.
//   npm run try                      (interactive)
//   npm run try -- "open notepad"    (one command, then exit)
import readline from 'node:readline/promises';
import { Brain } from './brain/agent.js';
import type { Host } from './brain/host.js';
import { ps } from './win/ps.js';
import { tryFast } from './fast/windows.js';
import { Memory } from './brain/memory.js';
import { Reminders } from './brain/reminders.js';
import { Routines } from './brain/routines.js';
import { CONFIG_DIR, loadConfig } from './config.js';
import path from 'node:path';

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

const cfg = loadConfig();
const reminders = new Reminders(path.join(CONFIG_DIR, 'reminders.json'), (_r, message) => console.log(`⏰ ${message}`));
reminders.start();
const brain = new Brain(host, { model: process.env.VC_MODEL ?? cfg.model, userName: cfg.userName, assistantName: cfg.assistantName, services: { memory: new Memory(path.join(CONFIG_DIR, 'memory.json')), reminders, routines: new Routines(path.join(CONFIG_DIR, 'routines.json')) }, log: (...a) => process.env.VC_DEBUG && console.log('   ·', ...a) });

async function run(cmd: string) {
  const t = Date.now();
  const quick = await tryFast(cmd, reminders);
  if (quick !== undefined) return console.log(`⚡ ${quick || 'Done.'}   (instant, ${Date.now() - t}ms)`);
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
