# Voice Control: "Hey Computer"

Control your Windows PC by talking to it. Say **"Hey Computer, open Visual Studio Code"**, or press **Ctrl+Alt+V** and say what you want. Claude (on your own subscription) works out the steps and does them with the keyboard, mouse and apps.

- **Speech recognition is local and free.** It uses Silero VAD + Whisper through sherpa-onnx, so your audio never leaves the PC.
- **The brain is Claude.** It uses the Claude Agent SDK, signed in with your Claude subscription (no API key). Every command counts toward your subscription's usage limits.
- **Replies are spoken** with the built-in Windows voices.

## Setup (once)

PowerShell on this PC blocks `npm`'s script wrapper, so use `npm.cmd`:

```bash
npm.cmd install
```

```bash
npm.cmd run models
```

```bash
npm.cmd run login
```

`models` downloads about 200 MB of speech models into `models/`. `login` opens a browser to sign in with your Claude account. Check it with `npm.cmd run login-status`.

## Run

```bash
npm.cmd run dev
```

A mic icon appears in the tray and a floating orb appears in the bottom-right corner.

| Orb colour | Meaning |
|---|---|
| grey | idle, waiting for "Hey Computer" |
| blue, pulsing | listening for your command |
| purple, spinning | Claude is thinking |
| green, spinning | doing things on your PC |
| orange | waiting for your yes / no |

**Ways to talk to it**
- Say **"Hey Computer, …"** with the command in one breath, or say "Hey Computer", wait for the chime, then give the command.
- Press **Ctrl+Alt+V**, click the orb, or click the tray icon, then speak.
- Type into the orb's text box.

**It's a conversation.** Wake it once, then just keep talking. No wake word or click is needed for follow-ups, and Claude remembers context: "open Notepad", then "now type my shopping list", then "save it on the desktop".
- It waits until you've really finished speaking, so short pauses mid-sentence don't cut you off.
- Talk over it while it's speaking and it goes quiet and listens to you.
- Ask for something new while it's working and it does that next.
- It goes back to sleep after 25 seconds of silence, or when you say "that's all", "bye" or "stop listening". The **LIVE** badge on the card shows the conversation is open.

**Stop a task:** say "stop", press **Esc**, or press the hotkey again.

If it keeps interrupting itself (loud speakers, no headphones), turn off **Let me interrupt while it speaks** in the tray menu.

Try typed commands without the voice UI: `npm.cmd run try -- "open notepad and type hello"`.

## Safety

Every action Claude takes goes through [src/brain/permissions.ts](src/brain/permissions.ts):
- **Runs immediately:** opening apps, typing, clicking, screenshots, reading the screen.
- **Asks you first (say yes or no):** deleting, moving or overwriting files; shutdown or restart; installing software; registry or service changes; downloads; killing programs; clicking buttons like Send, Buy, Pay or Delete. Claude is also told to read back any message before sending it.
- **Always refused:** typing card numbers, typing into password fields, changing Defender or the firewall, reading saved credentials.

## Settings

Tray menu → **Settings file…** opens `%APPDATA%\voice-control\config.json`:

```json
{
  "wakeWord": "hey computer",
  "hotkey": "Control+Alt+V",
  "model": "sonnet",
  "whisper": "base.en",
  "wakeWordEnabled": true,
  "conversation": true,
  "followUpSeconds": 25,
  "bargeIn": true,
  "endOfSpeechMs": 700,
  "speak": true,
  "voice": "",
  "autostart": false
}
```

- `followUpSeconds`: how long it keeps listening after you go quiet. `endOfSpeechMs`: raise it (for example to 1200) if it still acts before you finish a sentence.
- `model`: `sonnet` is fast. `opus` is smarter but slower and uses more of your limits.
- `whisper`: for better accuracy run `npm.cmd run models -- small.en`, then set `"small.en"`.
- `voice`: part of a Windows voice name, for example `"Aria"`.
- Restart the app after editing.

## How it works

```
mic → orb window (AudioWorklet, 16 kHz) → speech worker (VAD → Whisper) → text
text → wake-word check → Claude Agent SDK session → pc tools → PowerShell helper (Win32 / UI Automation)
```

| Path | What |
|---|---|
| [src/main/index.ts](src/main/index.ts) | Electron app: tray, orb, hotkey, voice state machine |
| [src/audio/worker.ts](src/audio/worker.ts) | Local speech recognition (separate process) |
| [src/audio/wake.ts](src/audio/wake.ts) | Wake-word / yes-no / stop matching |
| [src/brain/agent.ts](src/brain/agent.ts) | Long-lived Claude session |
| [src/brain/prompt.ts](src/brain/prompt.ts) | Instructions Claude follows |
| [src/tools/pc.ts](src/tools/pc.ts) | Tools Claude can use: open_app, window, type_text, press_keys, read_ui, click_element, screenshot, click, scroll, run_powershell, ask_user… |
| [app/helper.ps1](app/helper.ps1) | Win32 keyboard, mouse, windows, screenshots, UI Automation |

Tests: `npm.cmd test`.

## Limits

- A simple command takes about 5–20 seconds; tasks that click through apps take longer.
- Electron apps such as Claude, VS Code and Chrome expose few UI-Automation elements, so inside them Claude relies on keyboard shortcuts and screenshots, which is slower.
- It cannot control the lock screen or admin (UAC) prompts.
- While idle it transcribes any speech it hears to look for the wake word. That stays local, but it uses some CPU in a noisy room. Use **Pause wake word** in the tray to rely on the hotkey only.
- This is for personal use with your own Claude login.
