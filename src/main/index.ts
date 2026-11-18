import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, session, shell, Tray, utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Brain } from '../brain/agent.js';
import type { AgentStatus, Host } from '../brain/host.js';
import { isStop, matchWake, parseYesNo } from '../audio/wake.js';
import { CONFIG_FILE, loadConfig, saveConfig } from '../config.js';
import { ps } from '../win/ps.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const APP_DIR = path.join(ROOT, 'app');
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!app.requestSingleInstanceLock()) app.quit();

const cfg = loadConfig();
let orb: BrowserWindow;
let tray: Tray;
let audio: UtilityProcess | undefined;
let brain: Brain;
let paused = false;
let activeHotkey = '';

/**
 * Voice state machine
 *   idle       – waiting for the wake word (or hotkey)
 *   listening  – the next thing said is a command
 *   busy       – Claude is working; only "stop" is listened for
 *   awaiting   – Claude asked a question / wants a yes or no
 */
type Mode = 'idle' | 'listening' | 'busy' | 'awaiting';
let mode: Mode = 'idle';
let listenTimer: NodeJS.Timeout | undefined;
let pendingAnswer: ((text: string) => void) | undefined;
let speakingDone: (() => void) | undefined;

function ui(channel: string, payload?: unknown) {
  if (orb && !orb.isDestroyed()) orb.webContents.send(channel, payload);
}

function setStatus(s: AgentStatus | 'paused', detail = '') {
  ui('status', { status: s, detail });
  tray?.setToolTip(`Voice Control – ${s}${detail ? ': ' + detail : ''}`);
}

function setMode(m: Mode) {
  mode = m;
  clearTimeout(listenTimer);
  if (m === 'listening') {
    setStatus('listening');
    // Give up if nothing is said for a while.
    listenTimer = setTimeout(() => { if (mode === 'listening') setMode('idle'); }, 9000);
  } else if (m === 'idle') {
    setStatus(paused ? 'paused' : 'idle');
  }
  if (m === 'busy') globalShortcut.register('Escape', () => void stopTask());
  else globalShortcut.unregister('Escape');
}

/** Speaks text (mic muted meanwhile so it doesn't hear itself). */
function say(text: string): Promise<void> {
  log('say:', text);
  ui('reply', text);
  if (!cfg.speak || !text) return Promise.resolve();
  audio?.postMessage({ type: 'mute', on: true });
  return new Promise((resolve) => {
    const done = () => { speakingDone = undefined; audio?.postMessage({ type: 'mute', on: false }); resolve(); };
    speakingDone = done;
    ui('speak', { text, voice: cfg.voice });
    setTimeout(() => speakingDone === done && done(), 4000 + text.length * 120); // safety net
  });
}

/** Waits for the user's next utterance (spoken, or typed / button in the orb). */
async function waitForAnswer(question: string, timeoutMs: number): Promise<string> {
  const prev = mode;
  await say(question);
  setMode('awaiting');
  setStatus('confirming', question);
  return new Promise((resolve) => {
    const t = setTimeout(() => finish(''), timeoutMs);
    function finish(text: string) {
      clearTimeout(t);
      pendingAnswer = undefined;
      setMode(prev === 'awaiting' ? 'busy' : prev);
      if (mode === 'busy') setStatus('thinking');
      resolve(text);
    }
    pendingAnswer = finish;
  });
}

const host: Host = {
  status: (s, detail) => { if (mode !== 'awaiting') setStatus(s, detail); },
  say: (t) => void say(t),
  ask: (q) => waitForAnswer(q, 30_000),
  confirm: async (q) => {
    ui('confirm', q);
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await waitForAnswer(attempt ? 'Please say yes or no.' : q, 20_000);
      const yn = parseYesNo(answer);
      if (yn !== 'unknown') { ui('confirm', null); return yn === 'yes'; }
    }
    ui('confirm', null);
    void say('No clear answer, so I did not do it.');
    return false;
  },
};

async function runCommand(text: string) {
  text = text.trim();
  if (!text) return;
  if (brain.isBusy) { log('busy, ignoring:', text); return; }
  log('command:', text);
  ui('transcript', text);
  setMode('busy');
  const t = Date.now();
  const reply = await brain.send(text);
  log(`done in ${((Date.now() - t) / 1000).toFixed(1)}s:`, reply);
  setMode('idle');
  await say(reply);
  setStatus(paused ? 'paused' : 'idle');
}

async function stopTask() {
  if (mode !== 'busy' && mode !== 'awaiting') return;
  log('stop requested');
  pendingAnswer?.('no');
  await brain.interrupt();
  ui('reply', 'Stopped.');
}

/** Handles each transcribed utterance from the speech worker. */
function onHeard(text: string) {
  if (!text) return;
  log(`heard [${mode}]:`, text);
  ui('heard', text);
  switch (mode) {
    case 'awaiting':
      pendingAnswer?.(text);
      return;
    case 'busy':
      if (isStop(text) || isStop(matchWake(text, cfg.wakeWord).rest)) void stopTask();
      return;
    case 'listening': {
      const w = matchWake(text, cfg.wakeWord);
      void runCommand(w.woke ? w.rest || '' : text);
      if (w.woke && !w.rest) setMode('listening');
      return;
    }
    case 'idle': {
      if (paused || !cfg.wakeWordEnabled) return;
      const w = matchWake(text, cfg.wakeWord);
      if (!w.woke) return;
      if (w.rest) void runCommand(w.rest);
      else { ui('chime'); setMode('listening'); }
    }
  }
}

function hotkey() {
  if (mode === 'busy' || mode === 'awaiting') return void stopTask();
  if (mode === 'listening') return setMode('idle');
  ui('chime');
  setMode('listening');
}

function startAudio() {
  audio = utilityProcess.fork(path.join(here, '..', 'audio', 'worker.js'), [], { serviceName: 'Voice Control speech' });
  audio.on('message', (m: { type: string; text?: string; on?: boolean; message?: string; ms?: number; seconds?: number }) => {
    if (m.type === 'ready') { log('speech models loaded'); ui('mic-ready'); }
    else if (m.type === 'speech') ui('vad', m.on);
    else if (m.type === 'text') { log(`stt ${m.seconds?.toFixed(1)}s audio → ${m.ms}ms`); onHeard(m.text ?? ''); }
    else if (m.type === 'error') { log('speech error:', m.message); ui('reply', `Speech error: ${m.message}`); }
  });
  audio.on('exit', (code) => { log('speech worker exited', code); if (quitting || code === 0) return; setTimeout(startAudio, 2000); });
  audio.postMessage({ type: 'init', modelsDir: path.join(ROOT, 'models'), whisper: cfg.whisper });
}

function createOrb() {
  const { workArea } = screen.getPrimaryDisplay();
  const w = 500, h = 300;
  orb = new BrowserWindow({
    width: w, height: h,
    x: workArea.x + workArea.width - w - 4, y: workArea.y + workArea.height - h - 4,
    title: 'Voice Control',
    frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    hasShadow: false, show: false, focusable: true,
    webPreferences: { preload: path.join(APP_DIR, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  orb.setAlwaysOnTop(true, 'floating');
  // Transparent areas pass clicks through; the page turns this off while the mouse is over the orb or card.
  orb.setIgnoreMouseEvents(true, { forward: true });
  orb.loadFile(path.join(APP_DIR, 'orb.html'));
  orb.once('ready-to-show', () => orb.showInactive());
  orb.webContents.on('did-finish-load', () => ui('config', { hotkey: activeHotkey, wakeWord: cfg.wakeWord }));
  orb.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') log('[orb console]', e.message, e.sourceId?.split('/').pop(), e.lineNumber); });
  orb.webContents.on('render-process-gone', (_e, d) => { log('[orb] renderer gone:', d.reason); setTimeout(() => orb.reload(), 1000); });
}

function updateTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Talk now (${activeHotkey || 'no hotkey'})`, click: hotkey },
    { label: paused ? 'Resume wake word' : 'Pause wake word', click: () => { paused = !paused; setMode('idle'); updateTrayMenu(); } },
    { label: orb.isVisible() ? 'Hide orb' : 'Show orb', click: () => { orb.isVisible() ? orb.hide() : orb.showInactive(); updateTrayMenu(); } },
    { type: 'separator' },
    { label: 'Speak replies', type: 'checkbox', checked: cfg.speak, click: (i) => { cfg.speak = i.checked; saveConfig(cfg); } },
    { label: 'Start with Windows', type: 'checkbox', checked: cfg.autostart, click: (i) => { cfg.autostart = i.checked; saveConfig(cfg); applyAutostart(); } },
    { label: 'Settings file…', click: () => shell.openPath(CONFIG_FILE) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function applyAutostart() {
  app.setLoginItemSettings({ openAtLogin: cfg.autostart, path: process.execPath, args: [ROOT] });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');

  createOrb();
  tray = new Tray(nativeImage.createFromPath(path.join(APP_DIR, 'icon.png')));
  tray.on('click', hotkey);
  updateTrayMenu();
  applyAutostart();

  for (const key of [cfg.hotkey, 'Control+Alt+V', 'Control+Alt+J', 'Control+Shift+F12']) {
    if (globalShortcut.register(key, hotkey)) { activeHotkey = key; break; }
    log(`Hotkey ${key} is in use by another app, trying the next one`);
  }
  updateTrayMenu();

  ipcMain.on('audio', (_e, samples: Float32Array) => audio?.postMessage({ type: 'audio', samples }));
  ipcMain.on('speak-done', () => speakingDone?.());
  // Give focus back to the user's app so Claude doesn't type into the orb.
  ipcMain.on('typed', (_e, text: string) => { orb.blur(); if (pendingAnswer) pendingAnswer(text); else void runCommand(text); });
  ipcMain.on('confirm-answer', (_e, yes: boolean) => { orb.blur(); pendingAnswer?.(yes ? 'yes' : 'no'); });
  ipcMain.on('orb-click', () => { orb.blur(); hotkey(); });
  ipcMain.on('stop', () => void stopTask());
  ipcMain.on('log', (_e, ...a) => log('[orb]', ...a));
  ipcMain.on('interactive', (_e, on: boolean) => orb.setIgnoreMouseEvents(!on, { forward: true }));
  ui('config', { hotkey: activeHotkey, wakeWord: cfg.wakeWord });

  brain = new Brain(host, { model: cfg.model, log });
  brain.start();
  startAudio();
  setMode('idle');
  log(`Ready. Say "${cfg.wakeWord}" or press ${activeHotkey}.`);
});

app.on('window-all-closed', () => { /* keep running in the tray */ });
let quitting = false;
app.on('will-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  brain?.stop();
  audio?.kill();
  ps.stop();
});
