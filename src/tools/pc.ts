import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as d from '../win/desktop.js';
import * as f from '../win/files.js';
import { runScript } from '../win/ps.js';
import type { Host } from '../brain/host.js';
import type { Memory } from '../brain/memory.js';
import type { Reminders } from '../brain/reminders.js';
import type { Routines } from '../brain/routines.js';
import { parseWhen, sayTime } from '../fast/when.js';

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

/** Optional extras the app provides on top of the basic PC tools. */
export interface Services {
  memory?: Memory;
  reminders?: Reminders;
  routines?: Routines;
}

/** All the "hands": tools Claude uses to operate the PC. */
export function pcServer(host: Host, services: Services = {}) {
  const act = (detail: string) => host.status('acting', detail);
  const { memory, reminders, routines } = services;

  const memoryTools = memory ? [
    tool('remember', 'Save a lasting fact or preference about the user so you still know it in future conversations (e.g. "Their manager is Sara Khan", "Prefers Chrome over Edge", "Project folder is D:\\\\Work\\\\Nova"). Use when they say "remember…" or share something clearly worth keeping. One short fact per call. Never store passwords, card numbers or other secrets.', {
      fact: z.string().describe('The fact, written about the user in third person, short and self-contained'),
    }, (a) => safe(async () => text(memory.add(a.fact)))),

    tool('forget', 'Forget remembered facts that match a description, or "*" for everything (only when the user clearly asks to forget everything).', {
      about: z.string(),
    }, (a) => safe(async () => {
      const gone = memory.forget(a.about);
      return text(gone.length ? `Forgot: ${gone.join(' | ')}` : 'Nothing matched; nothing forgotten.');
    })),

    tool('list_memories', 'List everything you remember about the user.', {}, () => safe(async () => {
      const all = memory.list();
      return text(all.length ? all.map((f) => `- ${f.text} (saved ${f.at.slice(0, 10)})`).join('\n') : 'Nothing remembered yet.');
    })),
  ] : [];

  const reminderTools = reminders ? [
    tool('set_reminder', 'Set a reminder or timer. When it is due, the user is told out loud and with a Windows notification, even after a restart. For when, use plain words like "in 20 minutes", "at 5:30 pm", "tomorrow at 9", or an ISO local time like "2026-11-21T09:00".', {
      about: z.string().describe('What to remind them about, from their point of view ("call my mom"); empty for a plain timer'),
      when: z.string(),
      timer: z.boolean().optional().describe('true for a countdown timer'),
    }, (a) => safe(async () => {
      const now = new Date();
      const due = parseWhen(a.when, now);
      if (!due) return fail(`Could not understand the time "${a.when}". Try "in 20 minutes", "at 5:30 pm", "tomorrow at 9" or an ISO time.`);
      if (due.getTime() <= now.getTime()) return fail('That time has already passed.');
      const r = reminders.add(a.about, due, a.timer ? 'timer' : 'reminder', a.timer ? due.getTime() - now.getTime() : undefined);
      return text(`Set: ${reminders.describe(r, now)}. (Now is ${sayTime(now, now)}.)`);
    })),

    tool('list_reminders', 'List the reminders and timers that are set.', {}, () => safe(async () => {
      const all = reminders.list();
      return text(all.length ? all.map((r) => reminders.describe(r)).join('\n') : 'None set.');
    })),

    tool('cancel_reminder', 'Cancel reminders whose text matches, "timer" for timers, or "all".', {
      about: z.string(),
    }, (a) => safe(async () => {
      const gone = reminders.cancel(a.about);
      return text(gone.length ? `Cancelled: ${gone.map((r) => reminders.describe(r)).join('; ')}` : 'Nothing matched.');
    })),
  ] : [];

  const routineTools = routines ? [
    tool('save_routine', 'Save a routine: a phrase that runs several commands in order, e.g. name "work mode", steps ["open Visual Studio Code", "open Slack", "open github.com"]. Use when the user says "when I say X, do Y" or asks for a routine/mode. Each step is one short command, worded as the user would say it. "wait 3 seconds" is a valid step. Saving with an existing name replaces it.', {
      name: z.string().describe('What the user will say, without "start" (e.g. "work mode", "standup")'),
      steps: z.array(z.string()).min(1),
    }, (a) => safe(async () => text(routines.save(a.name, a.steps)))),

    tool('delete_routine', 'Delete a saved routine by name.', {
      name: z.string(),
    }, (a) => safe(async () => text(routines.delete(a.name) ? `Deleted "${a.name}".` : `No routine called "${a.name}".`))),

    tool('list_routines', 'List saved routines and their steps.', {}, () => safe(async () => {
      const all = Object.entries(routines.list());
      return text(all.length ? all.map(([n, st]) => `${n}: ${st.join(' → ')}`).join('\n') : 'No routines saved.');
    })),
  ] : [];

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

      tool('get_clipboard', 'Read the text the user has copied (the clipboard). Use only when they refer to it: "what I copied", "the clipboard", "summarise this" right after copying.', {}, () => safe(async () => {
        act('Reading what you copied');
        const t = await f.getClipboard();
        return text(t ? `Clipboard:\n${t}` : 'The clipboard has no text.');
      })),

      tool('set_clipboard', 'Put text on the clipboard so the user can paste it (e.g. "copy that summary").', {
        text: z.string(),
      }, (a) => safe(async () => {
        await f.setClipboard(a.text);
        return text('Copied to the clipboard.');
      })),

      tool('find_files', 'Find files or folders on this PC by name, type and age, newest first. Much faster than browsing in Explorer. E.g. "the PDF I downloaded yesterday" → extension "pdf", days 2; "my budget spreadsheet" → name "budget", extension "xlsx".', {
        name: z.string().optional().describe('Words in the file name'),
        kind: z.enum(['document', 'picture', 'music', 'video', 'folder', 'program', 'any']).optional(),
        extension: z.string().optional().describe('e.g. "pdf", "docx"'),
        days: z.number().positive().optional().describe('Only changed in the last N days'),
        contents: z.boolean().optional().describe('Also match words inside documents'),
      }, (a) => safe(async () => {
        act('Looking for your files');
        const { files } = await f.findFiles(a);
        if (!files.length) return text('No matching files.');
        return text(files.map((x) => `${x.path}  (${x.modified.replace('T', ' ').slice(0, 16)}${x.size ? `, ${f.sizeText(x.size)}` : ''})`).join('\n'));
      })),

      ...memoryTools,
      ...reminderTools,
      ...routineTools,
    ],
  });
}
