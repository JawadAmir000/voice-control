import { readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ps, psStr } from './ps.js';

/** Lets the UI show what the AI does: 'click' { x, y } in physical screen pixels, 'keys' true/false while it types. */
export const desktopEvents = new EventEmitter();

// ---------- coordinates ----------
// Claude works in the pixel space of the (downscaled) screenshot it was shown.
// We convert those to real screen pixels here.
const MAX_SHOT_WIDTH = 1366;
type Screen = { x: number; y: number; width: number; height: number };
let screen: Screen | undefined;

async function getScreen(): Promise<Screen> {
  if (!screen) screen = await ps.run<Screen>('VC-Screen');
  return screen;
}
async function scale(): Promise<number> {
  const s = await getScreen();
  return Math.min(1, MAX_SHOT_WIDTH / s.width);
}
export async function toPhysical(x: number, y: number) {
  const s = await getScreen();
  const k = await scale();
  return { x: Math.round(s.x + x / k), y: Math.round(s.y + y / k) };
}
export async function toImage(x: number, y: number) {
  const s = await getScreen();
  const k = await scale();
  return { x: Math.round((x - s.x) * k), y: Math.round((y - s.y) * k) };
}

// ---------- screen ----------
export async function screenshot(): Promise<{ base64: string; width: number; height: number }> {
  screen = undefined; // monitors may have changed
  const file = path.join(os.tmpdir(), `vc-shot-${Date.now()}.png`);
  const info = await ps.run<{ width: number; height: number }>(`VC-Screenshot ${psStr(file)} ${await scale()}`);
  const buf = await readFile(file);
  unlink(file).catch(() => {});
  return { base64: buf.toString('base64'), width: info.width, height: info.height };
}

export type UiElement = { name: string; type: string; x: number; y: number; enabled: boolean };
export async function readUi(max = 150): Promise<{ window: string; elements: UiElement[] }> {
  const res = await ps.run<{ window: string; elements: UiElement[] | UiElement | null }>(`VC-ReadUi ${max}`);
  const elements = res.elements == null ? [] : Array.isArray(res.elements) ? res.elements : [res.elements];
  for (const e of elements) Object.assign(e, await toImage(e.x, e.y));
  return { window: res.window, elements };
}

export async function focusedIsPassword(): Promise<boolean> {
  const r = await ps.run<{ password: boolean }>('VC-FocusedIsPassword');
  return !!r?.password;
}

// ---------- windows ----------
export type WindowInfo = { handle: number; title: string; process: string; active: boolean };
export async function listWindows(): Promise<WindowInfo[]> {
  const r = await ps.run<WindowInfo[] | WindowInfo | null>('VC-Windows');
  const list = r == null ? [] : Array.isArray(r) ? r : [r];
  // Hide our own overlay window from the list.
  return list.filter((w) => !/^Voice Control/.test(w.title));
}

export async function findWindow(query: string): Promise<WindowInfo | undefined> {
  const q = query.toLowerCase();
  const wins = await listWindows();
  return (
    wins.find((w) => w.title.toLowerCase() === q) ??
    wins.find((w) => w.title.toLowerCase().includes(q)) ??
    wins.find((w) => (w.process ?? '').toLowerCase().includes(q))
  );
}

export async function windowAction(query: string, action: 'focus' | 'close' | 'minimize' | 'maximize'): Promise<string> {
  const w = await findWindow(query);
  if (!w) return `No open window matches "${query}".`;
  const fn = { focus: 'Focus', close: 'Close', minimize: 'Minimize', maximize: 'Maximize' }[action];
  const ok = await ps.run<boolean | null>(`Out-Json ([VC]::${fn}(${w.handle}))`);
  if (action === 'focus' && ok === false) return `Tried to focus "${w.title}" but Windows kept another window in front.`;
  return `${action} → "${w.title}"`;
}

// ---------- apps ----------
type StartApp = { Name: string; AppID: string };
let appCache: StartApp[] | undefined;

const ALIASES: Record<string, string> = {
  'vs code': 'visual studio code',
  vscode: 'visual studio code',
  code: 'visual studio code',
  chrome: 'google chrome',
  edge: 'microsoft edge',
  browser: 'microsoft edge',
  word: 'word',
  excel: 'excel',
  terminal: 'terminal',
  cmd: 'command prompt',
  explorer: 'file explorer',
  files: 'file explorer',
  settings: 'settings',
  calculator: 'calculator',
};

export async function listApps(): Promise<StartApp[]> {
  if (!appCache) {
    const r = await ps.run<StartApp[]>('Out-Json @(Get-StartApps | Select-Object Name, AppID)');
    appCache = Array.isArray(r) ? r : [];
  }
  return appCache;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Scores how well an installed app name matches what the user said. Exported for tests. */
export function scoreApp(name: string, query: string): number {
  const n = norm(name);
  const q = norm(ALIASES[norm(query)] ?? query);
  if (!q) return 0;
  if (n === q) return 100;
  if (n.startsWith(q + ' ') || n.startsWith(q)) return 80 - Math.min(20, n.length - q.length);
  if (n.includes(q)) return 60 - Math.min(20, n.length - q.length);
  const words = q.split(' ');
  const hit = words.filter((w) => n.split(' ').includes(w)).length;
  return hit ? (30 * hit) / words.length : 0;
}

export function rankApps(apps: StartApp[], query: string): StartApp[] {
  return apps
    .map((a) => ({ a, s: scoreApp(a.Name, query) }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s)
    .map((x) => x.a);
}

export async function openApp(query: string): Promise<string> {
  // Already open? Just bring it to the front.
  const existing = await findWindow(query);
  const ranked = rankApps(await listApps(), query);
  const best = ranked[0];
  if (!best) {
    if (existing) return windowAction(query, 'focus');
    return `No installed app matches "${query}". Try list_apps to see names.`;
  }
  await ps.run(`Start-Process ('shell:AppsFolder\\' + ${psStr(best.AppID)}); Out-Json 'ok'`);
  const others = ranked.slice(1, 5).map((a) => a.Name);
  return `Launched "${best.Name}".` + (others.length ? ` Other matches: ${others.join(', ')}.` : '');
}

export async function openTarget(target: string): Promise<string> {
  await ps.run(`Start-Process ${psStr(target)}; Out-Json 'ok'`);
  return `Opened ${target}`;
}

// ---------- keyboard & mouse ----------
const VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, windows: 0x5b, meta: 0x5b, cmd: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20, backspace: 0x08,
  delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, printscreen: 0x2c, capslock: 0x14, menu: 0x5d,
  volumeup: 0xaf, volumedown: 0xae, volumemute: 0xad, playpause: 0xb3, nexttrack: 0xb0, prevtrack: 0xb1,
  ',': 0xbc, '.': 0xbe, '/': 0xbf, ';': 0xba, "'": 0xde, '[': 0xdb, ']': 0xdd, '-': 0xbd, '=': 0xbb, '`': 0xc0, '\\': 0xdc,
};

/** "ctrl+shift+t" → virtual key codes. Exported for tests. */
export function parseChord(chord: string): number[] {
  return chord
    .toLowerCase()
    .split('+')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      if (VK[k] !== undefined) return VK[k];
      if (/^f([1-9]|1[0-9]|2[0-4])$/.test(k)) return 0x6f + Number(k.slice(1));
      if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
      throw new Error(`Unknown key "${k}"`);
    });
}

/** Tells the app the AI is sending keys ('keys' true/false), so its own Esc isn't taken as "stop". */
async function sendingKeys(fn: () => Promise<void>) {
  desktopEvents.emit('keys', true);
  try {
    await fn();
  } finally {
    desktopEvents.emit('keys', false);
  }
}

export async function pressKeys(chord: string, times = 1) {
  const codes = parseChord(chord);
  await sendingKeys(async () => {
    for (let i = 0; i < times; i++) await ps.run(`[VC]::Chord([uint16[]]@(${codes.join(',')})); Out-Json 'ok'`);
  });
}

export async function typeText(text: string) {
  await sendingKeys(() => ps.run(`[VC]::TypeText(${psStr(text)}); Out-Json 'ok'`).then(() => {}));
}

export async function click(x: number, y: number, button = 'left', clicks = 1) {
  const p = await toPhysical(x, y);
  desktopEvents.emit('click', p);
  await ps.run(`[VC]::MouseButton(${p.x}, ${p.y}, ${psStr(button)}, ${clicks}); Out-Json 'ok'`);
}

export async function moveMouse(x: number, y: number) {
  const p = await toPhysical(x, y);
  await ps.run(`[VC]::Move(${p.x}, ${p.y}); Out-Json 'ok'`);
}

export async function scroll(x: number, y: number, amount: number) {
  const p = await toPhysical(x, y);
  await ps.run(`[VC]::Scroll(${p.x}, ${p.y}, ${Math.round(amount)}); Out-Json 'ok'`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
