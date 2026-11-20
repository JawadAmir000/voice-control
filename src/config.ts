import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Config = {
  /** Your first name: the assistant greets you with it. */
  userName: string;
  /** The assistant's name. Say "Hello Nova" / "Hey Nova" to wake her. */
  assistantName: string;
  /** Phrases that wake the assistant, comma-separated (any greeting works in front of the name). */
  wakeWord: string;
  /** Electron accelerator for push-to-talk. */
  hotkey: string;
  /** Claude model alias: "sonnet" (fast), "opus" (smartest), "haiku" (fastest). */
  model: string;
  /** Speech recognizer: "parakeet" (accurate, default) or "whisper". */
  sttModel: 'parakeet' | 'whisper';
  /** Whisper model downloaded by `npm run models -- <name>`; used when sttModel is "whisper" or Parakeet is missing. */
  whisper: string;
  /** Listen for the wake word at all (hotkey always works). */
  wakeWordEnabled: boolean;
  /** Keep listening after each reply so you can just keep talking (no wake word or click). */
  conversation: boolean;
  /** Seconds of silence before it goes back to sleep. */
  followUpSeconds: number;
  /** Talking while it speaks interrupts it. Turn off if it keeps interrupting itself on loud speakers. */
  bargeIn: boolean;
  /** Pause (ms) after you stop talking before it acts, so short pauses mid-sentence don't cut you off. */
  endOfSpeechMs: number;
  /** Read replies aloud. */
  speak: boolean;
  /** Name of a Windows voice to use, or "" for the default. */
  voice: string;
  /** Local Piper voice for replies (played in-app, so the mic doesn't hear it); "" = Windows speech. */
  ttsVoice: string;
  /** Speaking speed for the Piper voice (1 = normal, 1.1 = a bit faster). */
  ttsSpeed: number;
  /** Glow around the screen edges + status pill + click ripples while the AI works. */
  screenGlow: boolean;
  /** Start with Windows. */
  autostart: boolean;
};

export const DEFAULTS: Config = {
  userName: '',
  assistantName: 'Nova',
  wakeWord: 'hey nova, hey computer',
  // Ctrl+Alt+Space is taken by the Claude desktop app's Quick Entry.
  hotkey: 'Control+Alt+V',
  model: 'sonnet',
  sttModel: 'parakeet',
  whisper: 'base.en',
  wakeWordEnabled: true,
  conversation: true,
  followUpSeconds: 25,
  bargeIn: true,
  endOfSpeechMs: 1000,
  speak: true,
  voice: '',
  ttsVoice: 'en_US-lessac-medium',
  ttsSpeed: 1,
  screenGlow: true,
  autostart: false,
};

export const CONFIG_DIR = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'voice-control');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function loadConfig(): Config {
  let saved: Partial<Config> = {};
  try {
    saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    /* first run */
  }
  const cfg = { ...DEFAULTS, ...saved };
  if (cfg.hotkey === 'Control+Alt+Space') cfg.hotkey = DEFAULTS.hotkey; // old default, clashes with Claude
  if (cfg.wakeWord === 'hey computer') cfg.wakeWord = DEFAULTS.wakeWord; // old default: add the assistant's name
  saveConfig(cfg); // write defaults so the user can find and edit the file
  return cfg;
}

export function saveConfig(cfg: Config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
