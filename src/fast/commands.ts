/**
 * Instant commands: simple, common requests ("volume up", "open Chrome", "what time is it")
 * are recognised and done locally in well under a second, without asking Claude.
 * Anything not matched exactly (or that fails) goes to Claude as usual.
 */
import os from 'node:os';
import path from 'node:path';
import type { Reminders } from '../brain/reminders.js';
import { normTime, parseDuration, parseWhen, sayDuration, sayTime } from './when.js';

export type FastAction =
  | { kind: 'open'; name: string }
  | { kind: 'url'; url: string; label: string }
  | { kind: 'folder'; path: string; label: string }
  | { kind: 'keys'; keys: string; times: number; reply: string }
  | { kind: 'close'; name: string }
  | { kind: 'time' }
  | { kind: 'date' }
  | { kind: 'timer'; ms: number }
  | { kind: 'remind'; text: string; due: Date; inMs?: number }
  | { kind: 'list-reminders' }
  | { kind: 'cancel-reminders'; what: 'timer' | 'all' };

/** "remind me to call Ali in 20 minutes", "set a timer for 5 minutes", "cancel the timer"… */
function parseReminder(text: string, now: Date): FastAction | undefined {
  let t = strip(normTime(text)).replace(/^(?:set|create|add|make)(?: me)? (?:a |an )?reminder\b ?/, 'remind me ');

  const timer = t.match(/^(?:set |start |put on )?(?:a |an )?(?:timer|countdown)(?: for| of)? (.+)$/) ?? t.match(/^(?:set |start )?(?:a |an )?(.+?) timer$/);
  const ms = timer && parseDuration(timer[1]);
  if (ms) return { kind: 'timer', ms };
  if (/^(?:what are|list|show|read|tell me) (?:me )?(?:my |all |all my )?(?:reminders|timers|reminders and timers)$|^(?:do i have )?any (?:reminders|timers)$|^how (?:much time is|long is) left(?: on (?:the|my) timer)?$/.test(t))
    return { kind: 'list-reminders' };
  // "Cancel the timer" / "clear all my reminders". A single "cancel the reminder" is ambiguous
  // when there are several, so Claude asks which one.
  const cancel = t.match(/^(?:cancel|stop|delete|remove|clear|turn off) (?:the |my |all |all my |all the )?(timer|timers|reminders)$/);
  if (cancel) return { kind: 'cancel-reminders', what: cancel[1].startsWith('timer') ? 'timer' : 'all' };

  const body = t.match(/^remind me (.+)$/)?.[1];
  if (!body) return undefined;
  const clean = (s: string) => s.replace(/^(?:to|about|that)\s+/, '').replace(/^(?:i need to|i have to|i should|i must)\s+/, '').trim();
  const when = (s: string) => parseWhen(s, now) ?? parseWhen(s.replace(/^for /, ''), now);
  // When first: "remind me in 10 minutes to stretch", "remind me at 5 pm to call Ali"
  const first = body.match(/^(.+?) (?:to|about|that) (.+)$/);
  if (first) {
    const due = when(first[1]);
    if (due && clean(first[2])) return { kind: 'remind', text: clean(first[2]), due, inMs: inMs(first[1]) };
  }
  // When last: "remind me to call Ali at 5 pm", "remind me to look at the oven in 5 minutes"
  const last = body.match(/^(.+) ((?:in|after|at|by) .+|tomorrow(?: at .+)?|.+ tomorrow|tonight)$/);
  if (last) {
    const due = when(last[2]);
    if (due && clean(last[1])) return { kind: 'remind', text: clean(last[1]), due, inMs: inMs(last[2]) };
  }
  return undefined;
}

const inMs = (s: string) => (/^(?:in|after) /.test(s) ? parseDuration(s.replace(/^(?:in|after) /, '')) : undefined);

const norm = (s: string) =>
  s.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9.' ]+/g, ' ').replace(/\.(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();

/** "please", "can you", "for me", "now"… around the actual command. */
function strip(t: string): string {
  let prev = '';
  while (prev !== t) {
    prev = t;
    t = t
      .replace(/^(please|ok|okay|alright|so|now|and|hey|nova|computer|can you|could you|would you|will you|i want you to|i'd like you to|go ahead and|just)\s+/, '')
      .replace(/\s+(please|for me|now|right now|thanks|thank you|quickly)$/, '');
  }
  return t.trim();
}

/** Web-only names: "open gmail" means the website, not an app with a similar name. */
const SITES: Record<string, string> = {
  google: 'https://www.google.com',
  gmail: 'https://mail.google.com',
  'google mail': 'https://mail.google.com',
  youtube: 'https://www.youtube.com',
  github: 'https://github.com',
  linkedin: 'https://www.linkedin.com',
  netflix: 'https://www.netflix.com',
  'google drive': 'https://drive.google.com',
  'google maps': 'https://maps.google.com',
  'google calendar': 'https://calendar.google.com',
  amazon: 'https://www.amazon.com',
  reddit: 'https://www.reddit.com',
  wikipedia: 'https://www.wikipedia.org',
  chatgpt: 'https://chatgpt.com',
};

const FOLDERS: Record<string, string> = {
  downloads: 'Downloads', documents: 'Documents', 'my documents': 'Documents', desktop: 'Desktop',
  pictures: 'Pictures', photos: 'Pictures', music: 'Music', videos: 'Videos',
};

const label = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Works out whether a request is one of the instant commands. Exported for tests. */
export function parseFast(text: string, home = os.homedir(), now = new Date()): FastAction | undefined {
  const reminder = parseReminder(text, now);
  if (reminder) return reminder;
  const t = strip(norm(text));
  if (!t || /\b(and|then|also|after that)\b/.test(t)) return undefined; // multi-step: Claude's job

  // ---- volume & media
  const louder = t.match(/^(?:turn (?:the )?(?:volume|sound|it) up|(?:the )?volume up|increase (?:the )?volume|louder|make it louder)( a lot| a little| a bit)?$/);
  if (louder) return { kind: 'keys', keys: 'volumeup', times: louder[1] === ' a lot' ? 10 : louder[1] ? 2 : 5, reply: 'Turned it up.' };
  const quieter = t.match(/^(?:turn (?:the )?(?:volume|sound|it) down|(?:the )?volume down|decrease (?:the )?volume|lower (?:the )?volume|quieter|make it quieter)( a lot| a little| a bit)?$/);
  if (quieter) return { kind: 'keys', keys: 'volumedown', times: quieter[1] === ' a lot' ? 10 : quieter[1] ? 2 : 5, reply: 'Turned it down.' };
  // The mute key toggles, and we can't see the current state: just press it, don't claim a result.
  if (/^(?:mute|unmute)(?: (?:the )?(?:sound|audio|volume|pc|computer|speakers))?$/.test(t)) return { kind: 'keys', keys: 'volumemute', times: 1, reply: '' };
  if (/^(?:pause|play|resume|unpause)(?: (?:the|my) )?(?: ?(?:music|song|video|media|it))?$/.test(t)) return { kind: 'keys', keys: 'playpause', times: 1, reply: '' };
  if (/^(?:next|skip)(?: (?:this|the))?(?: (?:song|track|video))?$|^(?:play )?(?:the )?next (?:song|track|video)$/.test(t)) return { kind: 'keys', keys: 'nexttrack', times: 1, reply: '' };
  if (/^(?:play )?(?:the )?previous(?: (?:song|track|video))?$|^go back(?: a| one)? (?:song|track)$/.test(t)) return { kind: 'keys', keys: 'prevtrack', times: 1, reply: '' };

  // ---- windows & screen
  if (/^(?:show (?:the |my )?desktop|go to (?:the )?desktop)$/.test(t)) return { kind: 'keys', keys: 'win+d', times: 1, reply: '' };
  if (/^minimi[sz]e (?:everything|all(?: (?:the )?windows)?|all apps)$/.test(t)) return { kind: 'keys', keys: 'win+m', times: 1, reply: '' };
  if (/^(?:take a screenshot|screenshot|capture (?:the )?screen)$/.test(t)) return { kind: 'keys', keys: 'win+printscreen', times: 1, reply: 'Screenshot saved in your Pictures folder.' };
  // "Lock the computer" is left to Claude, which asks first: a misheard phrase shouldn't lock you out mid-work.

  // ---- time & date
  if (/^(?:what(?:'s| is) the time|what time is it|tell me the time|time)(?: now| right now)?$/.test(t)) return { kind: 'time' };
  if (/^(?:what(?:'s| is) (?:the date|today's date)|what day is (?:it|today)|what(?:'s| is) today)(?: today)?$/.test(t)) return { kind: 'date' };

  // ---- open / close
  const open = t.match(/^(?:open|launch|start|run|bring up|pull up|go to)\s+(?:up\s+)?(?:the |my )?(.+?)(?: app| application| website| site| folder| window)?$/);
  if (open) {
    const name = open[1].trim();
    if (!name || name.split(' ').length > 4 || /^(it|this|that|a|an|new)\b/.test(name)) return undefined;
    if (SITES[name]) return { kind: 'url', url: SITES[name], label: label(name) };
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|org|net|io|ai|dev|co|uk|pk|edu|gov|app)$/.test(name)) return { kind: 'url', url: `https://${name}`, label: name };
    if (FOLDERS[name]) return { kind: 'folder', path: path.join(home, FOLDERS[name]), label: FOLDERS[name] };
    return { kind: 'open', name };
  }
  const close = t.match(/^(?:close|quit|exit)\s+(?:the |my )?(.+?)(?: app| application| window)?$/);
  if (close) {
    const name = close[1].trim();
    if (!name || name.split(' ').length > 4 || /^(it|this|that|everything|all)\b/.test(name)) return undefined;
    // "close the tab" means Ctrl+W, not "close the window whose title contains 'tab'".
    if (/\b(tabs?|windows?|pages?|files?|documents?|dialog|popup|pop up|menu|sidebar|panel)$/.test(name)) return undefined;
    return { kind: 'close', name };
  }
  return undefined;
}

/** What the instant commands need from Windows (injected so tests can fake it). */
export interface FastDeps {
  bestApp(query: string): Promise<{ name: string; score: number } | undefined>;
  openApp(query: string): Promise<string>;
  openTarget(target: string): Promise<string>;
  pressKeys(keys: string, times: number): Promise<void>;
  closeWindow(query: string): Promise<boolean>;
  reminders?: Pick<Reminders, 'add' | 'list' | 'cancel' | 'describe'>;
  now?: () => Date;
}

/** Below this score "open X" is too unsure to guess; Claude works it out instead. */
const SURE = 60;

/**
 * Does the action. Resolves with the spoken reply ('' = just do it, say nothing),
 * or undefined when it can't do it reliably and Claude should take over.
 */
export async function runFast(a: FastAction, deps: FastDeps): Promise<string | undefined> {
  const now = deps.now?.() ?? new Date();
  switch (a.kind) {
    case 'keys':
      await deps.pressKeys(a.keys, a.times);
      return a.reply;
    case 'time':
      return `It's ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`;
    case 'date':
      return `It's ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`;
    case 'url':
      await deps.openTarget(a.url);
      return `${a.label}'s open.`;
    case 'folder':
      await deps.openTarget(a.path);
      return `Here's your ${a.label} folder.`;
    case 'open': {
      const best = await deps.bestApp(a.name);
      if (!best || best.score < SURE) return undefined;
      await deps.openApp(a.name);
      return `${best.name}'s open.`;
    }
    case 'close':
      return (await deps.closeWindow(a.name)) ? 'Closed.' : undefined;
    case 'timer':
      if (!deps.reminders) return undefined;
      deps.reminders.add('', new Date(now.getTime() + a.ms), 'timer', a.ms);
      return `Timer set for ${sayDuration(a.ms)}.`;
    case 'remind':
      if (!deps.reminders) return undefined;
      deps.reminders.add(a.text, a.due);
      return `Okay, I'll remind you ${a.inMs ? `in ${sayDuration(a.inMs)}` : `at ${sayTime(a.due, now)}`}.`;
    case 'list-reminders': {
      if (!deps.reminders) return undefined;
      const all = deps.reminders.list();
      if (!all.length) return "You don't have any reminders or timers.";
      const said = all.slice(0, 3).map((r) => deps.reminders!.describe(r, now));
      return `${all.length > 3 ? `You have ${all.length}. The next ones: ` : ''}${said.join('. ')}.`;
    }
    case 'cancel-reminders': {
      if (!deps.reminders) return undefined;
      const gone = deps.reminders.cancel(a.what);
      if (!gone.length) return a.what === 'timer' ? "There's no timer running." : "You don't have any reminders.";
      return a.what === 'timer' ? `Cancelled ${gone.length > 1 ? 'your timers' : 'the timer'}.` : `Cleared ${gone.length} reminder${gone.length > 1 ? 's' : ''}.`;
    }
  }
}
