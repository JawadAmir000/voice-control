import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, session, Tray, utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Brain } from '../brain/agent.js';
import type { AgentStatus } from '../brain/host.js';
import { CONFIG_DIR, loadConfig, saveConfig } from '../config.js';
import { Memory } from '../brain/memory.js';
import { Reminders } from '../brain/reminders.js';
import { Routines } from '../brain/routines.js';
import { parseFast } from '../fast/commands.js';
import { ps } from '../win/ps.js';
import { desktopEvents } from '../win/desktop.js';
import { Conversation } from './conversation.js';
import { tryFast } from '../fast/windows.js';
import { openSettings, refreshSettings, registerSettings, type SettingsDeps } from './settings.js';
import type { Config } from '../config.js';
import { downloadModels, haveModels, modelsDir, signInToClaude } from './setup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const APP_DIR = path.join(ROOT, 'app');
const MODELS_DIR = modelsDir(ROOT);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!app.requestSingleInstanceLock()) app.quit();
// Installed: notifications are labelled "Nova" (matches appId in package.json "build").
if (app.isPackaged) app.setAppUserModelId('com.nova.voicecontrol');

const cfg = loadConfig();
const routines = new Routines(path.join(CONFIG_DIR, 'routines.json'));
const memory = new Memory(path.join(CONFIG_DIR, 'memory.json'));
// Reminders and timers: a Windows notification plus Nova saying it out loud.
const reminders = new Reminders(path.join(CONFIG_DIR, 'reminders.json'), (r, message) => {
  log('reminder due:', message);
  if (Notification.isSupported()) new Notification({ title: r.kind === 'timer' ? 'Timer done' : `${cfg.assistantName || 'Nova'} reminder`, body: message, icon: path.join(APP_DIR, 'icon.png') }).show();
  convo.announce(message);
  refreshSettings();
});
let orb: BrowserWindow;
let overlay: BrowserWindow | undefined;
let tray: Tray;
let audio: UtilityProcess | undefined;
let brain: Brain;
let activeHotkey = '';
let quitting = false;

function ui(channel: string, payload?: unknown) {
  if (orb && !orb.isDestroyed()) orb.webContents.send(channel, payload);
}
function fx(channel: string, payload?: unknown) {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- speech output
// Replies are spoken by a local Piper voice (voice process) and played inside the orb window,
// so echo cancellation keeps the assistant's voice out of the mic. If the voice model is
// missing, it falls back to Windows speech (which the mic will hear on speakers).
let voiceProc: UtilityProcess | undefined;
let voiceReady = false;
let speakId = 0;
let speakingDone: (() => void) | undefined;
let speakSafety: NodeJS.Timeout | undefined;
let speakText = '';

function armSpeakSafety() {
  clearTimeout(speakSafety);
  const done = speakingDone;
  speakSafety = setTimeout(() => { if (speakingDone === done) done?.(); }, 6000 + speakText.length * 120);
}

function startVoice() {
  voiceProc = utilityProcess.fork(path.join(here, '..', 'audio', 'tts-worker.js'), [], { serviceName: 'Voice Control voice' });
  voiceProc.on('message', (m: { type: string; id?: number; samples?: Float32Array; sampleRate?: number; last?: boolean; ms?: number; message?: string }) => {
    if (m.type === 'ready') { voiceReady = true; log(`voice ready (${cfg.ttsVoice})`); }
    else if (m.type === 'chunk') {
      if (m.id !== speakId) return; // cancelled
      ui('tts-chunk', { id: m.id, samples: m.samples, sampleRate: m.sampleRate, last: m.last });
    } else if (m.type === 'failed') {
      log('voice failed, using Windows speech for this reply:', m.message);
      if (m.id === speakId) ui('speak', { text: speakText, voice: cfg.voice });
    } else if (m.type === 'error') { log('voice error, using Windows speech:', m.message); voiceReady = false; }
  });
  voiceProc.on('exit', (code) => { voiceReady = false; log('voice process exited', code); if (!quitting && code !== 0) setTimeout(startVoice, 2000); });
  voiceProc.postMessage({ type: 'init', modelsDir: MODELS_DIR, voice: cfg.ttsVoice, speed: cfg.ttsSpeed });
}

function speak(text: string): Promise<void> {
  log('say:', text);
  speakText = text;
  return new Promise((resolve) => {
    const done = () => { clearTimeout(speakSafety); speakingDone = undefined; resolve(); };
    speakingDone = done;
    const id = ++speakId;
    if (voiceReady && cfg.ttsVoice) {
      ui('tts-start', { id });
      voiceProc!.postMessage({ type: 'speak', id, text });
    } else {
      ui('speak', { text, voice: cfg.voice }); // Windows speech fallback
    }
    armSpeakSafety();
  });
}

function tts(cmd: 'pause' | 'resume' | 'cancel') {
  ui('tts', cmd);
  if (cmd === 'pause') clearTimeout(speakSafety);
  if (cmd === 'resume') armSpeakSafety();
  if (cmd === 'cancel') {
    voiceProc?.postMessage({ type: 'cancel', id: speakId });
    speakId++; // drop any chunks still on their way
    setTimeout(() => speakingDone?.(), 300); // in case the player never reports back
  }
}

// ---------------------------------------------------------------- conversation

// Esc stops the AI while it works. While the AI presses keys itself, Esc is released:
// otherwise its own Esc (closing a dialog) would stop it, and never reach the dialog.
let escapeWanted = false;
let aiPressingKeys = false;
function syncEscape() {
  const on = escapeWanted && !aiPressingKeys;
  if (on && !globalShortcut.isRegistered('Escape')) globalShortcut.register('Escape', () => void convo.stop());
  else if (!on && globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape');
}
desktopEvents.on('keys', (pressing: boolean) => {
  aiPressingKeys = pressing;
  syncEscape();
});

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
    routine: (text) => routines.match(text),
    canFast: (text) => cfg.fastCommands && parseFast(text) !== undefined,
    fast: (text) => (cfg.fastCommands ? tryFast(text, reminders) : Promise.resolve(undefined)),
    interrupt: () => brain.interrupt(),
    escapeKey: (on) => {
      escapeWanted = on;
      syncEscape();
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
    userName: cfg.userName,
    assistantName: cfg.assistantName,
  },
);

function startAudio() {
  audio = utilityProcess.fork(path.join(here, '..', 'audio', 'worker.js'), [], { serviceName: 'Voice Control speech' });
  audio.on('message', (m: { type: string; text?: string; raw?: string; db?: number; on?: boolean; message?: string; ms?: number; seconds?: number; model?: string; phrase?: string; afterWake?: number }) => {
    if (m.type === 'ready') { log('speech models loaded:', m.model); ui('mic-ready'); }
    else if (m.type === 'speech') { ui('vad', m.on); convo.onSpeech(!!m.on); }
    else if (m.type === 'wake') { log('wake word heard:', m.phrase); convo.onKeyword(m.phrase ?? ''); }
    else if (m.type === 'text') {
      const cut = m.afterWake !== undefined ? ` (after wake word at ${m.afterWake.toFixed(1)}s)` : '';
      log(`stt ${m.seconds?.toFixed(1)}s audio, ${m.db} dB → ${m.ms}ms [${convo.mode}]${cut}:`, m.text || `(noise${m.raw ? `: "${m.raw}"` : ''})`);
      convo.onText(m.text ?? '', m.afterWake !== undefined);
    }
    else if (m.type === 'error') { log('speech error:', m.message); ui('reply', `Speech error: ${m.message}`); }
  });
  audio.on('exit', (code) => { log('speech worker exited', code); if (quitting || code === 0) return; setTimeout(startAudio, 2000); });
  audio.postMessage({ type: 'init', modelsDir: MODELS_DIR, stt: cfg.sttModel, whisper: cfg.whisper, name: cfg.wakeWordEnabled ? cfg.assistantName : '' });
}

// ---------------------------------------------------------------- window & tray

function createOrb() {
  const { workArea } = screen.getPrimaryDisplay();
  // A slim vertical dock in the middle of the right screen edge.
  const w = 240, h = 580;
  orb = new BrowserWindow({
    width: w, height: h,
    x: workArea.x + workArea.width - w - 2, y: workArea.y + Math.round((workArea.height - h) / 2),
    title: 'Voice Control',
    frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    hasShadow: false, show: false, focusable: true,
    webPreferences: { preload: path.join(APP_DIR, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  orb.setAlwaysOnTop(true, 'floating');
  orb.setContentProtection(true); // keep it out of the AI's own screenshots
  // Transparent areas pass clicks through; the page turns this off while the mouse is over the orb or card.
  orb.setIgnoreMouseEvents(true, { forward: true });
  orb.loadFile(path.join(APP_DIR, 'orb.html'));
  orb.once('ready-to-show', () => orb.showInactive());
  orb.webContents.on('did-finish-load', () => ui('config', { hotkey: activeHotkey, wakeWord: cfg.wakeWord, assistantName: cfg.assistantName }));
  orb.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') log('[orb console]', e.message, e.sourceId?.split('/').pop(), e.lineNumber); });
  orb.webContents.on('render-process-gone', (_e, d) => { log('[orb] renderer gone:', d.reason); setTimeout(() => orb.reload(), 1000); });
}

function createOverlay() {
  const d = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    ...d.bounds,
    title: 'Voice Control Overlay',
    frame: false, transparent: true, resizable: false, movable: false, alwaysOnTop: true, skipTaskbar: true,
    hasShadow: false, show: false, focusable: false, fullscreenable: false,
    webPreferences: { preload: path.join(APP_DIR, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.setContentProtection(true); // keep it out of the AI's own screenshots
  overlay.loadFile(path.join(APP_DIR, 'overlay.html'));
  overlay.once('ready-to-show', () => overlay?.showInactive());
  overlay.webContents.on('did-finish-load', () => fx('config', { assistantName: cfg.assistantName || 'AI Assistant' }));
  overlay.webContents.on('render-process-gone', () => setTimeout(() => overlay?.reload(), 1000));
}

/** Physical screen pixels (from the PowerShell helper) → overlay CSS pixels. */
function toOverlay(p: { x: number; y: number }) {
  const dip = screen.screenToDipPoint(p);
  const b = overlay!.getBounds();
  return { x: dip.x - b.x, y: dip.y - b.y };
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
    { label: 'Screen glow while AI works', type: 'checkbox', checked: cfg.screenGlow, click: (i) => { cfg.screenGlow = i.checked; saveConfig(cfg); setOverlay(i.checked); } },
    { label: 'Speak replies', type: 'checkbox', checked: cfg.speak, click: (i) => toggle('speak', i.checked) },
    { label: 'Start with Windows', type: 'checkbox', checked: cfg.autostart, click: (i) => { cfg.autostart = i.checked; saveConfig(cfg); applyAutostart(); } },
    { label: 'Settings, memory & routines…', click: () => openSettings(settingsDeps) },
    { label: 'Sign in to Claude…', click: () => signInToClaude(log) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

// ---------------------------------------------------------------- live settings

/** Registers the push-to-talk hotkey, falling back to alternatives if it's taken. */
function registerHotkey(): string[] {
  const notes: string[] = [];
  if (activeHotkey) globalShortcut.unregister(activeHotkey);
  activeHotkey = '';
  for (const key of [cfg.hotkey, 'Control+Alt+V', 'Control+Alt+J', 'Control+Shift+F12']) {
    let ok = false;
    try { ok = globalShortcut.register(key, () => convo.toggle()); } catch { /* not a valid accelerator */ }
    if (ok) { activeHotkey = key; break; }
    log(`Hotkey ${key} is in use by another app (or invalid), trying the next one`);
    if (key === cfg.hotkey) notes.push(`The hotkey ${key} isn't available, so I'm using another one.`);
  }
  if (activeHotkey && activeHotkey !== cfg.hotkey) notes.push(`Push-to-talk is ${activeHotkey}.`);
  return notes;
}

function makeBrain() {
  return new Brain(convo.host, { model: cfg.model, userName: cfg.userName, assistantName: cfg.assistantName, services: { memory, reminders, routines }, log });
}

/** Starts a fresh Claude session with the new settings, once the current task (if any) is done. */
let brainRestartTimer: NodeJS.Timeout | undefined;
function restartBrain() {
  clearTimeout(brainRestartTimer); // several saves during one task still mean one restart
  if (convo.mode === 'busy' || convo.mode === 'awaiting') return void (brainRestartTimer = setTimeout(restartBrain, 1000));
  brainRestartTimer = undefined;
  log('restarting Claude session with new settings');
  brain.stop();
  brain = makeBrain();
  brain.start();
}

/** True once the speech worker may run (models present; after a first-run download). */
let speechStarted = false;

function restartAudio() {
  if (!speechStarted) return; // startSpeech() will start it with the new settings
  const old = audio;
  audio = undefined;
  old?.removeAllListeners('exit');
  old?.kill();
  startAudio();
}

function restartVoice() {
  if (!speechStarted) return;
  const old = voiceProc;
  voiceProc = undefined;
  voiceReady = false;
  old?.removeAllListeners('exit');
  old?.kill();
  if (cfg.ttsVoice) startVoice();
}

function setOverlay(on: boolean) {
  if (on && !overlay) createOverlay();
  if (!on) { overlay?.destroy(); overlay = undefined; }
}

/** Applies changed settings to the running app. Returns notes for the Settings window. */
function applySettings(prev: Config, next: Config): string[] {
  const changed = (...keys: (keyof Config)[]) => keys.some((k) => prev[k] !== next[k]);
  const notes: string[] = [];
  Object.assign(convo.opts, {
    wakeWord: next.wakeWord, wakeWordEnabled: next.wakeWordEnabled, conversation: next.conversation,
    followUpMs: next.followUpSeconds * 1000, bargeIn: next.bargeIn, speak: next.speak, settleMs: next.endOfSpeechMs,
    userName: next.userName, assistantName: next.assistantName,
  });
  if (changed('hotkey')) notes.push(...registerHotkey());
  if (changed('screenGlow')) setOverlay(next.screenGlow);
  if (changed('autostart')) applyAutostart();
  if (changed('model', 'userName', 'assistantName')) restartBrain();
  if (changed('sttModel', 'whisper', 'assistantName', 'wakeWordEnabled')) restartAudio();
  if (changed('ttsVoice', 'ttsSpeed')) restartVoice();
  ui('config', { hotkey: activeHotkey, wakeWord: next.wakeWord, assistantName: next.assistantName });
  fx('config', { assistantName: next.assistantName || 'AI Assistant' });
  updateTrayMenu();
  return notes;
}

const settingsDeps: SettingsDeps = { cfg, appDir: APP_DIR, memory, routines, reminders, apply: applySettings, log };

function applyAutostart() {
  app.setLoginItemSettings({ openAtLogin: cfg.autostart, path: process.execPath, args: app.isPackaged ? [] : [ROOT] });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');

  createOrb();
  if (cfg.screenGlow) createOverlay();
  desktopEvents.on('click', (p) => { if (overlay) fx('click', toOverlay(p)); }); // a soft ripple, no text
  tray = new Tray(nativeImage.createFromPath(path.join(APP_DIR, 'icon.png')));
  tray.on('click', () => convo.toggle());

  registerHotkey();
  registerSettings(settingsDeps);
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
  ipcMain.on('visual', (_e, st: string) => fx('state', st));
  ipcMain.on('level', (_e, v: number) => fx('level', v));
  ipcMain.on('open-settings', () => openSettings(settingsDeps));
  ipcMain.on('orb-menu', () => buildMenu().popup({ window: orb }));
  ipcMain.on('interactive',(_e, on: boolean) => orb.setIgnoreMouseEvents(!on, { forward: true }));
  ui('config', { hotkey: activeHotkey, wakeWord: cfg.wakeWord, assistantName: cfg.assistantName });

  brain = makeBrain();
  reminders.start();
  brain.start();
  void startSpeech();
  convo.setPaused(false); // shows the idle status
  if (process.argv.includes('--settings')) openSettings(settingsDeps);
  log(`Ready. Say "Hello ${cfg.assistantName || 'computer'}" or press ${activeHotkey}. Conversation mode ${cfg.conversation ? 'on' : 'off'}, interrupting ${cfg.bargeIn ? 'on' : 'off'}.`);
});

/** Starts listening and the voice; on an installed copy's first run, downloads the models first. */
async function startSpeech() {
  if (!haveModels(MODELS_DIR) && app.isPackaged) {
    log('speech models missing, downloading to', MODELS_DIR);
    const ok = await downloadModels(ROOT, MODELS_DIR, (msg) => { ui('reply', msg); ui('status', { status: 'thinking', detail: msg }); }, log);
    ui('reply', ok ? 'Speech models ready. Say "Hey Nova", or press ' + activeHotkey + '.' : "Couldn't download the speech models. Check your internet connection and restart Nova. You can still type to me.");
    convo.setPaused(convo.paused); // back to the normal status
    if (!ok) return;
  }
  speechStarted = true;
  startAudio();
  if (cfg.ttsVoice) startVoice();
}

// Starting Nova again while it's already running opens Settings.
app.on('second-instance', () => openSettings(settingsDeps));
app.on('window-all-closed', () => { /* keep running in the tray */ });
app.on('will-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  brain?.stop();
  reminders.stop();
  audio?.kill();
  voiceProc?.kill();
  ps.stop();
});
