/**
 * The Settings window: change settings without editing JSON, and see / edit what Nova
 * remembers, your routines and your reminders. Most changes apply straight away.
 */
import { BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { CONFIG_FILE, DEFAULTS, cleanSettings, saveConfig, type Config } from '../config.js';
import type { Memory } from '../brain/memory.js';
import type { Reminders } from '../brain/reminders.js';
import type { Routines } from '../brain/routines.js';

export interface SettingsDeps {
  cfg: Config;
  appDir: string;
  memory: Memory;
  routines: Routines;
  reminders: Reminders;
  /** Applies changed settings to the running app; returns notes to show ("Hotkey in use…"). */
  apply(prev: Config, next: Config): string[];
  log(...a: unknown[]): void;
}

let win: BrowserWindow | undefined;

export function openSettings(deps: SettingsDeps) {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 780, height: 680, minWidth: 560, minHeight: 480,
    title: `${deps.cfg.assistantName || 'Nova'} settings`,
    icon: path.join(deps.appDir, 'icon.png'),
    backgroundColor: '#0e0f1a',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(deps.appDir, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  // It only ever shows our own page: no navigating away, no pop-up windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(deps.appDir, 'settings.html'));
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => (win = undefined));
}

/** Tells an open Settings window that memory / routines / reminders changed (e.g. by voice). */
export function refreshSettings() {
  if (win && !win.isDestroyed()) win.webContents.send('settings-changed');
}

export function registerSettings(deps: SettingsDeps) {
  const { cfg, memory, routines, reminders } = deps;
  // Only the Settings window may read or change settings, memory, routines and reminders.
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!win || win.isDestroyed() || e.sender !== win.webContents) throw new Error('not allowed');
      return fn(...args);
    });
  const snapshot = () => ({
    config: cfg,
    defaults: DEFAULTS,
    memory: memory.list(),
    routines: routines.list(),
    reminders: reminders.list().map((r) => ({ id: r.id, kind: r.kind, text: reminders.describe(r) })),
  });

  handle('settings-get', () => snapshot());
  handle('settings-save', (input: unknown) => {
    const prev = { ...cfg };
    const next = cleanSettings(input, cfg);
    Object.assign(cfg, next);
    saveConfig(cfg);
    let notes: string[] = [];
    try {
      notes = deps.apply(prev, cfg);
    } catch (e) {
      deps.log('applying settings failed', e);
      notes = ['Saved. Some changes will apply after a restart.'];
    }
    return { ...snapshot(), notes };
  });
  handle('memory-add', (text: string) => { memory.add(String(text ?? '')); return snapshot(); });
  handle('memory-forget', (text: string) => { memory.remove(String(text ?? '')); return snapshot(); });
  handle('routine-save', (name: string, steps: string[]) => {
    routines.save(String(name ?? ''), Array.isArray(steps) ? steps.map(String) : []);
    return snapshot();
  });
  handle('routine-delete', (name: string) => { routines.delete(String(name ?? '')); return snapshot(); });
  handle('reminder-cancel', (id: string) => { reminders.cancelId(String(id ?? '')); return snapshot(); });
  handle('open-config-file', () => shell.openPath(CONFIG_FILE));
}
