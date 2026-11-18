import type { AgentStatus, Host } from '../brain/host.js';
import { isGoodbye, isStop, matchWake, parseYesNo, stripEcho } from '../audio/wake.js';
import { greetingFor, isGreeting } from '../brain/greeting.js';

/** How long after the assistant stops talking its voice may still reach the mic. */
const ECHO_TAIL_MS = 1500;
const simple = (t: string) => t.toLowerCase().replace(/[^a-z ]+/g, '').replace(/\s+/g, ' ').trim();
const words = (t: string) => t.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length;

/** Everything the conversation needs from the outside world (Electron, Claude, speech worker). */
export interface Effects {
  status(s: AgentStatus | 'paused', detail?: string): void;
  ui(channel: string, payload?: unknown): void;
  /** Speak text; resolves when it finishes or is cancelled. */
  speak(text: string): Promise<void>;
  tts(cmd: 'pause' | 'resume' | 'cancel'): void;
  mute(on: boolean): void;
  send(text: string): Promise<string>;
  interrupt(): Promise<void>;
  escapeKey(on: boolean): void;
  log(...a: unknown[]): void;
}

export interface ConversationOptions {
  wakeWord: string;
  wakeWordEnabled: boolean;
  /** Keep listening for follow-ups after each reply, no wake word needed. */
  conversation: boolean;
  /** How long to wait for you to say something before going back to sleep. */
  followUpMs: number;
  /** Let you interrupt the assistant while it is speaking. */
  bargeIn: boolean;
  speak: boolean;
  /** Your first name, used in greetings. */
  userName?: string;
  /** After you stop talking, wait this long for you to continue before acting. */
  settleMs: number;
}

/**
 * Voice conversation state machine.
 *
 *   idle       – asleep; waiting for the wake word, hotkey or a click
 *   listening  – awake; whatever you say next is a command (stays awake between replies)
 *   busy       – Claude is working or replying; "stop" cancels, anything else is queued
 *   awaiting   – Claude asked a question / wants a yes or no
 *
 * While the assistant speaks the mic stays on: if you start talking it pauses, and
 * unless what it heard was just its own voice, it stops and listens to you.
 */
export class Conversation {
  mode: 'idle' | 'listening' | 'busy' | 'awaiting' = 'idle';
  /** Awake and keeping the conversation going between replies. */
  active = false;
  paused = false;

  private listenTimer?: ReturnType<typeof setTimeout>;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private buffer = '';
  private queued = '';
  private pendingAnswer?: (text: string) => void;
  private speaking = false;
  private spokenText = '';
  /** When the assistant last stopped speaking (ms). */
  private spokeUntil = 0;
  /** The current utterance began while the assistant was speaking (or just after): it may be its own echo. */
  private suspectEcho = false;
  private bargeText?: string;
  private userTalking = false;
  private stopped = false;

  constructor(private fx: Effects, public opts: ConversationOptions) {}

  // ---------------------------------------------------------------- status / modes

  private status(s: AgentStatus | 'paused', d?: string) {
    this.fx.status(s, d);
  }

  private setMode(m: Conversation['mode']) {
    if (m !== this.mode) this.fx.log(`→ ${m}${m === 'listening' && this.active ? ' (conversation)' : ''}`);
    this.mode = m;
    clearTimeout(this.listenTimer);
    if (m === 'listening') {
      this.status('listening', this.active ? 'Just talk — say “that’s all” when you’re done' : '');
      if (!this.userTalking && !this.buffer) this.armListenTimer();
    } else if (m === 'idle') {
      this.active = false;
      this.buffer = '';
      clearTimeout(this.settleTimer);
      this.status(this.paused ? 'paused' : 'idle');
    }
    this.fx.escapeKey(m === 'busy' || m === 'awaiting');
  }

  /** Go back to sleep if you don't say anything for a while. Paused while you talk. */
  private armListenTimer() {
    clearTimeout(this.listenTimer);
    this.listenTimer = setTimeout(() => {
      if (this.mode === 'listening' && !this.userTalking && !this.buffer) {
        this.fx.log('no speech for a while, going to sleep');
        this.setMode('idle');
      }
    }, this.opts.followUpMs);
  }

  // ---------------------------------------------------------------- speaking

  /** Speaks; resolves with what you said if you interrupted it. */
  private async say(text: string): Promise<string | undefined> {
    this.fx.ui('reply', text);
    if (!this.opts.speak || !text) return undefined;
    this.speaking = true;
    this.spokenText = text;
    this.bargeText = undefined;
    if (!this.opts.bargeIn) this.fx.mute(true);
    try {
      await this.fx.speak(text);
    } finally {
      this.speaking = false;
      this.spokeUntil = Date.now();
      if (!this.opts.bargeIn) setTimeout(() => this.fx.mute(false), ECHO_TAIL_MS); // let the room go quiet first
    }
    const b = this.bargeText;
    this.bargeText = undefined;
    return b;
  }

  // ---------------------------------------------------------------- input from the speech worker

  /** Voice activity started/stopped (before transcription). */
  onSpeech(on: boolean) {
    this.userTalking = on;
    if (on) {
      clearTimeout(this.listenTimer);
      clearTimeout(this.settleTimer);
      // Speakers feed the assistant's voice back into the mic. Anything that starts while it
      // talks (or right after) is checked against what it said before being trusted.
      this.suspectEcho = this.speaking || Date.now() - this.spokeUntil < ECHO_TAIL_MS;
    } else if (this.mode === 'listening' && !this.buffer) {
      this.armListenTimer();
    }
  }

  /** A finished utterance from Whisper ('' if it was only noise). */
  onText(text: string) {
    if (this.suspectEcho) {
      this.suspectEcho = false;
      const yours = text ? stripEcho(text, this.spokenText) : '';
      if (!yours) {
        this.fx.log('ignored own voice:', text || '(noise)');
        if (this.mode === 'listening' && !this.buffer) this.armListenTimer();
        return;
      }
      if (yours !== text) this.fx.log('removed own voice, kept:', yours);
      text = yours;
      if (this.speaking) {
        // Real interruption? Needs a stop word or a few words that aren't its own.
        if (!isStop(text) && words(text) < 3) {
          this.fx.log('too short to be an interruption, ignoring:', text);
          return;
        }
        this.fx.log('interrupted by user:', text);
        this.bargeText = text;
        this.fx.tts('cancel'); // say() resolves and its caller handles bargeText
        return;
      }
    }
    if (!text) {
      if (this.mode === 'listening' && !this.buffer) this.armListenTimer();
      return;
    }
    this.fx.ui('heard', text);
    this.route(text);
  }

  private route(text: string) {
    switch (this.mode) {
      case 'awaiting':
        this.pendingAnswer?.(text);
        return;
      case 'busy': {
        const w = matchWake(text, this.opts.wakeWord);
        const t = w.woke ? w.rest : text;
        if (isStop(t) || isStop(text)) return void this.stop();
        if (!t) return;
        this.queued = this.queued ? `${this.queued} ${t}` : t;
        this.fx.log('queued for after this task:', t);
        this.fx.ui('queued', this.queued);
        return;
      }
      case 'listening':
        return this.listen(text);
      case 'idle': {
        if (this.paused || !this.opts.wakeWordEnabled) return;
        const w = matchWake(text, this.opts.wakeWord);
        if (!w.woke) return;
        this.wake(false);
        if (w.rest) this.listen(w.rest);
        // "Hello computer" → introduce yourself. The bare wake phrase ("hey computer") just wakes it.
        else if (isGreeting(text) && simple(text) !== simple(this.opts.wakeWord)) void this.run(text);
      }
    }
  }

  private listen(text: string) {
    const w = matchWake(text, this.opts.wakeWord);
    const t = (w.woke ? w.rest : text).trim();
    if (!t) return void this.armListenTimer();
    if (!this.buffer && isGoodbye(t)) {
      this.setMode('idle');
      void this.say('Okay, talk to you later.');
      return;
    }
    // Collect what you say; act once you've really finished (no new speech for settleMs).
    this.buffer = this.buffer ? `${this.buffer} ${t}` : t;
    this.fx.ui('transcript-live', this.buffer);
    clearTimeout(this.listenTimer);
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.flush(), this.opts.settleMs);
  }

  private flush() {
    if (this.userTalking) return; // still talking; the next transcript restarts the timer
    const t = this.buffer.trim();
    this.buffer = '';
    if (t) void this.run(t);
  }

  // ---------------------------------------------------------------- commands

  /** Pause/resume the wake word (hotkey and clicks still work). */
  setPaused(p: boolean) {
    this.paused = p;
    if (this.mode === 'idle') this.setMode('idle');
  }

  /** Wake up (wake word, hotkey or click). */
  wake(chime = true) {
    this.active = this.opts.conversation;
    if (chime) this.fx.ui('chime');
    this.setMode('listening');
  }

  /** Hotkey / orb click: wake up, or go to sleep, or stop the current task. */
  toggle() {
    if (this.mode === 'busy' || this.mode === 'awaiting') return void this.stop();
    if (this.mode === 'listening') return this.setMode('idle');
    this.wake();
  }

  /** Runs a command typed into the orb. */
  typed(text: string) {
    if (this.pendingAnswer) return this.pendingAnswer(text);
    void this.run(text);
  }

  confirmAnswer(yes: boolean) {
    this.pendingAnswer?.(yes ? 'yes' : 'no');
  }

  async run(text: string): Promise<void> {
    text = text.trim();
    if (!text) return;
    if (this.mode === 'busy' || this.mode === 'awaiting') {
      this.queued = this.queued ? `${this.queued} ${text}` : text;
      return;
    }
    this.fx.log('command:', text);
    this.fx.ui('transcript', text);
    this.stopped = false;
    this.setMode('busy');
    this.status('thinking', text);
    const t = Date.now();
    // Greetings get an instant personal introduction; everything else goes to Claude.
    const reply = isGreeting(text) ? greetingFor(this.opts.userName ?? '') : await this.fx.send(text);
    this.fx.log(`done in ${((Date.now() - t) / 1000).toFixed(1)}s:`, reply);
    const interrupted = this.stopped ? undefined : await this.say(reply);
    this.stopped = false;

    if (this.queued) {
      const q = this.queued;
      this.queued = '';
      this.mode = 'idle';
      return this.run(q);
    }
    if (interrupted) {
      // You talked over the reply: treat it as your next request.
      this.active = this.active || this.opts.conversation;
      this.setMode('listening');
      return this.listen(interrupted);
    }
    if (this.active) this.setMode('listening');
    else this.setMode('idle');
  }

  async stop() {
    if (this.mode !== 'busy' && this.mode !== 'awaiting' && !this.speaking) return;
    this.fx.log('stop requested');
    this.stopped = true;
    this.queued = '';
    this.pendingAnswer?.('no');
    if (this.speaking) this.fx.tts('cancel');
    await this.fx.interrupt();
    this.fx.ui('reply', 'Stopped.');
  }

  // ---------------------------------------------------------------- questions from Claude

  private async waitForAnswer(question: string, timeoutMs: number): Promise<string> {
    const prev = this.mode;
    const early = await this.say(question);
    if (early) return early;
    this.mode = 'awaiting';
    this.fx.escapeKey(true);
    this.status('confirming', question);
    return new Promise((resolve) => {
      let timer = setTimeout(() => finish(''), timeoutMs);
      const finish = (text: string) => {
        clearTimeout(timer);
        this.pendingAnswer = undefined;
        this.mode = prev === 'awaiting' ? 'busy' : prev;
        if (this.mode === 'busy') this.status('thinking');
        resolve(text);
      };
      this.pendingAnswer = finish;
      // Don't time out while you're in the middle of answering.
      const tick = setInterval(() => {
        if (!this.pendingAnswer) return clearInterval(tick);
        if (this.userTalking) { clearTimeout(timer); timer = setTimeout(() => finish(''), timeoutMs); }
      }, 500);
    });
  }

  /** The Host interface the Claude brain uses. */
  readonly host: Host = {
    status: (s, detail) => { if (this.mode !== 'awaiting') this.status(s, detail); },
    say: (t) => { void this.say(t).then((b) => b && this.route(b)); },
    ask: (q) => this.waitForAnswer(q, 30_000),
    confirm: async (q) => {
      this.fx.ui('confirm', q);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const answer = await this.waitForAnswer(attempt ? 'Please say yes or no.' : q, 20_000);
          const yn = parseYesNo(answer);
          if (yn !== 'unknown') return yn === 'yes';
        }
        void this.say('No clear answer, so I did not do it.');
        return false;
      } finally {
        this.fx.ui('confirm', null);
      }
    },
  };
}
