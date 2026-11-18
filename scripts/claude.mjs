// Runs the Claude Code binary bundled with the Agent SDK, e.g. to sign in once:
//   npm run login   → claude auth login --claudeai
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const exe = path.join(path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/package.json')), 'claude.exe');
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY; // use the subscription login
const r = spawnSync(exe, process.argv.slice(2), { stdio: 'inherit', env });
process.exit(r.status ?? 1);
