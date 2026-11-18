import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, session, shell, Tray, utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Brain } from '../brain/agent.js';
import type { AgentStatus } from '../brain/host.js';
import { CONFIG_FILE, loadConfig, saveConfig } from '../config.js';
import { ps } from '../win/ps.js';
import { Conversation } from './conversation.js';

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
let activeHotkey = '';
let quitting = false;

function ui(channel: string, payload?: unknown) {
  if (orb && !orb.isDestroyed()) orb.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- speech output
// The orb window speaks with Windows voices; we wait for it to report the end.
let speakingDone: (() => void) | undefined;
let speakSafety: NodeJS.Timeout | undefined;
let speakText = '';

function armSpeakSafety() {
  clearTimeout(speakSafety);
  const done = speakingDone;
  speakSafety = setTimeout(() => { if (speakingDone === done) done?.(); }, 4000 + speakText.length * 120);
}

function speak(text: string): Promise<void> {
  log('say:', text);
  speakText = text;
  return new Promise((resolve) => {
    const done = () => { clearTimeout(speakSafety); speakingDone = undefined; resolve(); };
    speakingDone = done;
    ui('speak', { text, voice: cfg.voice });
    armSpeakSafety();
  });
}

function tts(cmd: 'pause' | 'resume' | 'cancel') {
  ui('tts', cmd);
  if (cmd === 'pause') clearTimeout(speakSafety);
  if (cmd === 'resume') armSpeakSafety();
  if (cmd === 'cancel') setTimeout(() => speakingDone?.(), 300); // in case the voice never reports back
}

// ---------------------------------------------------------------- conversation

const convo = new Conversation(
  {
    status: (s: AgentStatus | 'paused', detail = '') => {
      ui('status', { status: s, detail, conversation: convo?.active });
      tray?.setToolTip(`Voice Control – ${s}${detail ? ': ' + detail : ''}`);
    },
    ui,
    speak,
    tts,
    mute: (on) => audio?.postMessage({ type: 'mute', on }),
    send: (text) => brain.send(text),
    interrupt: () => brain.interrupt(),
    escapeKey: (on) => {
      if (on) globalShortcut.register('Escape', () => void convo.stop());
      else globalShortcut.unregister('Escape');
    },
    log,
  },
  {
    wakeWord: cfg.wakeWord,
    wakeWordEnabled: cfg.wakeWordEnabled,
    conversation: cfg.conversation,
    followUpMs: cfg.followUpSeconds * 1000,
    bargeIn: cfg.bargeIn,
    speak: cfg.speak,
    settleMs: cfg.endOfSpeechMs,
  },
);

function startAudio() {
  audio = utilityProcess.fork(path.join(here, '..', 'audio', 'worker.js'), [], { serviceName: 'Voice Control speech' });
  audio.on('message', (m: { type: string; text?: string; on?: boolean; message?: string; ms?: number; seconds?: number }) => {
    if (m.type === 'ready') { log('speech models loaded'); ui('mic-ready'); }
    else if (m.type === 'speech') { ui('vad', m.on); convo.onSpeech(!!m.on); }
    else if (m.type === 'text') {
      log(`stt ${m.seconds?.toFixed(1)}s audio → ${m.ms}ms [${convo.mode}]:`, m.text || '(noise)');
      convo.onText(m.text ?? '');
    }
    else if (m.type === 'error') { log('speech error:', m.message); ui('reply', `Speech error: ${m.message}`); }
  });
  audio.on('exit', (code) => { log('speech worker exited', code); if (quitting || code === 0) return; setTimeout(startAudio, 2000); });
  audio.postMessage({ type: 'init', modelsDir: path.join(ROOT, 'models'), whisper: cfg.whisper });
}

// ---------------------------------------------------------------- window & tray

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

function toggle(key: 'conversation' | 'bargeIn' | 'speak', on: boolean) {
  cfg[key] = on;
  convo.opts[key] = on;
  saveConfig(cfg);
}

function updateTrayMenu() {
  tray.setContextMenu(buildMenu());
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: `Talk now (${activeHotkey || 'no hotkey'})`, click: () => convo.toggle() },
    { label: convo.paused ? 'Resume wake word' : 'Pause wake word', click: () => { convo.setPaused(!convo.paused); updateTrayMenu(); } },
    { label: orb.isVisible() ? 'Hide orb' : 'Show orb', click: () => { orb.isVisible() ? orb.hide() : orb.showInactive(); updateTrayMenu(); } },
    { type: 'separator' },
    { label: 'Conversation mode (keep listening after replies)', type: 'checkbox', checked: cfg.conversation, click: (i) => toggle('conversation', i.checked) },
    { label: 'Let me interrupt while it speaks', type: 'checkbox', checked: cfg.bargeIn, click: (i) => toggle('bargeIn', i.checked) },
    { label: 'Speak replies', type: 'checkbox', checked: cfg.speak, click: (i) => toggle('speak', i.checked) },
    { label: 'Start with Windows', type: 'checkbox', checked: cfg.autostart, click: (i) => { cfg.autostart = i.checked; saveConfig(cfg); applyAutostart(); } },
    { label: 'Settings file…', click: () => shell.openPath(CONFIG_FILE) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function applyAutostart() {
  app.setLoginItemSettings({ openAtLogin: cfg.autostart, path: process.execPath, args: [ROOT] });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');

  createOrb();
  tray = new Tray(nativeImage.createFromPath(path.join(APP_DIR, 'icon.png')));
  tray.on('click', () => convo.toggle());

  for (const key of [cfg.hotkey, 'Control+Alt+V', 'Control+Alt+J', 'Control+Shift+F12']) {
    if (globalShortcut.register(key, () => convo.toggle())) { activeHotkey = key; break; }
    log(`Hotkey ${key} is in use by another app, trying the next one`);
  }
  updateTrayMenu();
  applyAutostart();

  ipcMain.on('audio', (_e, samples: Float32Array) => audio?.postMessage({ type: 'audio', samples }));
  ipcMain.on('speak-done', () => speakingDone?.());
  // Give focus back to the user's app so Claude doesn't type into the orb.
  ipcMain.on('typed', (_e, text: string) => { orb.blur(); convo.typed(text); });
  ipcMain.on('confirm-answer', (_e, yes: boolean) => { orb.blur(); convo.confirmAnswer(yes); });
  ipcMain.on('orb-click', () => { orb.blur(); convo.toggle(); });
  ipcMain.on('stop', () => void convo.stop());
  ipcMain.on('log', (_e, ...a) => log('[orb]', ...a));
  ipcMain.on('quit', () => app.quit());
  ipcMain.on('orb-menu', () => buildMenu().popup({ window: orb }));
  ipcMain.on('interactive',(_e, on: boolean) => orb.setIgnoreMouseEvents(!on, { forward: true }));
  ui('config', { hotkey: activeHotkey, wakeWord: cfg.wakeWord });

  brain = new Brain(convo.host, { model: cfg.model, log });
  brain.start();
  startAudio();
  convo.setPaused(false); // shows the idle status
  log(`Ready. Say "${cfg.wakeWord}" or press ${activeHotkey}. Conversation mode ${cfg.conversation ? 'on' : 'off'}, interrupting ${cfg.bargeIn ? 'on' : 'off'}.`);
});

app.on('window-all-closed', () => { /* keep running in the tray */ });
app.on('will-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  brain?.stop();
  audio?.kill();
  ps.stop();
});
