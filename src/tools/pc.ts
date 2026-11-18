import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as d from '../win/desktop.js';
import { runScript } from '../win/ps.js';
import type { Host } from '../brain/host.js';

type Result = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
const text = (t: string): Result => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): Result => ({ content: [{ type: 'text', text: t }], isError: true });

async function safe(fn: () => Promise<Result>): Promise<Result> {
  try {
    return await fn();
  } catch (e) {
    return fail(`Error: ${(e as Error).message}`);
  }
}

/** All the "hands": tools Claude uses to operate the PC. */
export function pcServer(host: Host) {
  const act = (detail: string) => host.status('acting', detail);

  return createSdkMcpServer({
    name: 'pc',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool('open_app', 'Launch an installed app by name (e.g. "Claude", "Visual Studio Code", "Notepad"), or bring it to the front if already running. Prefer this over clicking.', {
        name: z.string().describe('App name as the user would say it'),
      }, (a) => safe(async () => {
        act(`Opening ${a.name}`);
        const r = await d.openApp(a.name);
        await d.sleep(1500);
        return text(r);
      })),

      tool('list_apps', 'List installed Start-menu apps, optionally filtered.', {
        filter: z.string().optional(),
      }, (a) => safe(async () => {
        act('Looking through your apps');
        const apps = await d.listApps();
        const names = (a.filter ? d.rankApps(apps, a.filter) : apps).map((x) => x.Name);
        return text(names.slice(0, 80).join('\n') || 'No matches');
      })),

      tool('open', 'Open a URL, file, folder or Windows settings page (e.g. "https://claude.ai", "C:\\\\Users", "ms-settings:display") with its default app.', {
        target: z.string(),
      }, (a) => safe(async () => {
        act(`Opening ${a.target}`);
        const r = await d.openTarget(a.target);
        await d.sleep(1200);
        return text(r);
      })),

      tool('list_windows', 'List open windows (title, process, which one is active).', {}, () => safe(async () => {
        act('Checking open windows');
        const w = await d.listWindows();
        return text(w.map((x) => `${x.active ? '* ' : '  '}${x.title}  [${x.process}]`).join('\n') || 'No windows');
      })),

      tool('window', 'Focus, close, minimize or maximize a window found by (part of) its title or process name.', {
        action: z.enum(['focus', 'close', 'minimize', 'maximize']),
        title: z.string(),
      }, (a) => safe(async () => {
        act(`${{ focus: 'Switching to', close: 'Closing', minimize: 'Minimizing', maximize: 'Maximizing' }[a.action]} ${a.title}`);
        const r = await d.windowAction(a.title, a.action);
        await d.sleep(400);
        return text(r);
      })),

      tool('type_text', 'Type text into the focused field of the active window. Use "\\n" for Enter. Make sure the right field is focused first.', {
        text: z.string(),
      }, (a) => safe(async () => {
        if (await d.focusedIsPassword()) return fail('The focused field is a password box. Ask the user to type passwords themselves.');
        act(`Typing "${a.text.length > 40 ? a.text.slice(0, 40) + '…' : a.text}"`);
        await d.typeText(a.text);
        return text('Typed.');
      })),

      tool('press_keys', 'Press a key or shortcut, e.g. "enter", "ctrl+n", "ctrl+shift+t", "alt+f4", "win+d", "volumeup".', {
        keys: z.string(),
        times: z.number().int().min(1).max(50).optional(),
      }, (a) => safe(async () => {
        act(`Pressing ${a.keys}`);
        await d.pressKeys(a.keys, a.times ?? 1);
        await d.sleep(300);
        return text(`Pressed ${a.keys}${a.times && a.times > 1 ? ` ×${a.times}` : ''}.`);
      })),

      tool('read_ui', 'List the clickable elements (buttons, fields, links, tabs, menu items) of the active window with their x,y centre in screenshot coordinates. Cheaper and more precise than a screenshot.', {}, () => safe(async () => {
        act('Reading the window');
        const ui = await d.readUi();
        const lines = ui.elements.map((e) => `${e.type} "${e.name}" @ ${e.x},${e.y}${e.enabled ? '' : ' (disabled)'}`);
        return text(`Window: ${ui.window}\n${lines.join('\n') || '(no accessible elements — use screenshot)'}`);
      })),

      tool('click_element', 'Click an element of the active window by its visible name (from read_ui).', {
        name: z.string(),
        double: z.boolean().optional(),
      }, (a) => safe(async () => {
        const ui = await d.readUi(400);
        const q = a.name.toLowerCase();
        const el = ui.elements.find((e) => e.name?.toLowerCase() === q) ?? ui.elements.find((e) => e.name?.toLowerCase().includes(q));
        if (!el) return fail(`No element named "${a.name}" in "${ui.window}". Try read_ui or screenshot.`);
        act(`Clicking ${el.name}`);
        await d.click(el.x, el.y, 'left', a.double ? 2 : 1);
        await d.sleep(500);
        return text(`Clicked ${el.type} "${el.name}".`);
      })),

      tool('screenshot', 'See the whole screen. Coordinates in this image are what click/scroll/move_mouse use.', {}, () => safe(async () => {
        act('Looking at the screen');
        const s = await d.screenshot();
        return {
          content: [
            { type: 'image', data: s.base64, mimeType: 'image/png' },
            { type: 'text', text: `Screenshot ${s.width}x${s.height}.` },
          ],
        };
      })),

      tool('click', 'Click at x,y (screenshot coordinates).', {
        x: z.number(), y: z.number(),
        button: z.enum(['left', 'right', 'middle']).optional(),
        double: z.boolean().optional(),
      }, (a) => safe(async () => {
        act('Clicking');
        await d.click(a.x, a.y, a.button ?? 'left', a.double ? 2 : 1);
        await d.sleep(500);
        return text('Clicked.');
      })),

      tool('move_mouse', 'Move the mouse to x,y (screenshot coordinates), e.g. to hover.', {
        x: z.number(), y: z.number(),
      }, (a) => safe(async () => {
        await d.moveMouse(a.x, a.y);
        return text('Moved.');
      })),

      tool('scroll', 'Scroll at x,y. Positive amount scrolls up, negative scrolls down (1 = one notch).', {
        x: z.number(), y: z.number(), amount: z.number(),
      }, (a) => safe(async () => {
        act(a.amount > 0 ? 'Scrolling up' : 'Scrolling down');
        await d.scroll(a.x, a.y, a.amount);
        await d.sleep(300);
        return text('Scrolled.');
      })),

      tool('wait', 'Wait for something to load.', {
        seconds: z.number().min(0.1).max(30),
      }, (a) => safe(async () => {
        act('Waiting for it to load');
        await d.sleep(a.seconds * 1000);
        return text('Done waiting.');
      })),

      tool('run_powershell', 'Run a PowerShell script for anything the other tools cannot do (files, system info, settings). Risky scripts need the user\'s spoken approval.', {
        script: z.string(),
        reason: z.string().describe('One short phrase saying what this does, read to the user if approval is needed'),
      }, (a) => safe(async () => {
        act(a.reason);
        const r = await runScript(a.script);
        return { content: [{ type: 'text', text: `exit ${r.code}\n${r.output}` }], isError: r.code !== 0 };
      })),

      tool('ask_user', 'Ask the user a question out loud and wait for their spoken answer. Use when the request is ambiguous, and before sending messages, posting, or buying anything.', {
        question: z.string(),
      }, (a) => safe(async () => {
        const answer = await host.ask(a.question);
        return text(answer ? `User said: ${answer}` : 'No answer.');
      })),
    ],
  });
}
