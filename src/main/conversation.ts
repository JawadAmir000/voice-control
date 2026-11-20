import type { AgentStatus, Host } from '../brain/host.js';
import { findWake, isGoodbye, isStop, lastSentence, matchWake, nameVariants, parseYesNo, stripEcho, wakePhrases } from '../audio/wake.js';
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
  /** The assistant's own name ("Nova"): she introduces herself with it. */
  assistantName?: string;
  /** A short "Hello" on its own wakes it (default on). */
  greetToWake?: boolean;
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
  /** Everything said recently: late echoes of an earlier sentence must still be recognised. */
  private spokenHistory: { text: string; at: number }[] = [];
  /** When the assistant last stopped speaking (ms). */
  private spokeUntil = 0;
  /**
   * One flag per recorded utterance, in order: did it begin while the assistant was speaking
   * (or just after)? Transcripts can arrive seconds later, so the flag travels with the clip.
   */
  private suspectQueue: boolean[] = [];
  private bargeText?: string;
  private userTalking = false;
  private stopped = false;
  /** Wake phrase the listener just heard ("hello nova"), until its clip's transcript arrives. */
  private keyword?: string;

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
    this.spokenHistory.push({ text, at: Date.now() });
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

  /** What the assistant said in the last minute (for spotting its own echo). */
  private recentlySpoken(): string {
    const since = Date.now() - 60_000;
    this.spokenHistory = this.spokenHistory.filter((h) => h.at >= since || h === this.spokenHistory.at(-1));
    return this.spokenHistory.map((h) => h.text).join(' ');
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
      this.suspectQueue.push(this.speaking || Date.now() - this.spokeUntil < ECHO_TAIL_MS);
      if (this.suspectQueue.length > 20) this.suspectQueue.shift();
    } else if (this.mode === 'listening' && !this.buffer) {
      this.armListenTimer();
    }
  }

  /**
   * The wake-word listener heard "Hey Nova" (by sound, before any transcript). Wakes at once.
   * The clip's transcript follows with only what came after the wake phrase.
   */
  onKeyword(phrase: string) {
    if (this.mode !== 'idle' || this.paused || !this.opts.wakeWordEnabled) return;
    if (this.speaking || Date.now() - this.spokeUntil < ECHO_TAIL_MS) return; // its own voice saying its name
    this.fx.log('woken by wake word:', phrase);
    this.wake();
    this.keyword = phrase;
  }

  /**
   * A finished utterance from the recognizer ('' if it was only noise).
   * afterWake: the wake-word listener already woke us and this is only the part after "Hey Nova".
   */
  onText(text: string, afterWake = false) {
    const keyword = this.keyword;
    this.keyword = undefined;
    // A clip that began while it was talking may be its own voice saying "I'm Nova": that one
    // still goes through the echo check below.
    if (afterWake && !(this.suspectQueue[0] ?? this.speaking)) {
      this.suspectQueue.shift();
      if (!text) {
        // Just the wake phrase. "Hello Nova" still gets the introduction; "Hey Nova" only wakes.
        if (keyword && this.mode === 'listening' && !this.buffer && this.greets(keyword) && !/^hey\b/.test(keyword)) void this.run(keyword);
        return this.nothingNew();
      }
      this.fx.ui('heard', text);
      return this.route(text);
    }
    const suspect = this.suspectQueue.length ? this.suspectQueue.shift()! : this.speaking;
    if (suspect) {
      const yours = text ? stripEcho(text, this.recentlySpoken()) : '';
      if (!yours) {
        this.fx.log('ignored own voice:', text || '(noise)');
        return this.nothingNew();
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
    if (!text) return this.nothingNew();
    this.fx.ui('heard', text);
    this.route(text);
  }

  /**
   * A sound turned out to be noise or echo. Any voice activity cancelled the pending
   * "you've finished talking" timer, so restart it — otherwise a half-collected command
   * would wait forever (a "(buzzing)" right after you spoke used to swallow your request).
   */
  private nothingNew() {
    if (this.mode !== 'listening') return;
    if (this.buffer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.flush(), this.opts.settleMs);
    } else {
      this.armListenTimer();
    }
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
        // The wake phrase may be anywhere: with a video playing, your words get glued to its speech.
        const w = findWake(text, this.opts.wakeWord);
        const tail = lastSentence(text); // where your words usually land in a mixed clip
        if (!w.woke) {
          // A short greeting ("Hello.", "Hi there", "Good morning") also wakes it and gets the
          // introduction: on its own, or as the last sentence of a clip. Other speech doesn't.
          if (this.opts.greetToWake === false) return;
          const greeting = this.greets(text) && words(text) <= 4 ? text : tail && this.greets(tail) && words(tail) <= 3 ? tail : '';
          if (greeting) {
            this.fx.log('woken by greeting:', greeting);
            this.wake(false);
            void this.run(greeting);
          }
          return;
        }
        this.wake(false);
        if (w.rest) this.listen(w.rest);
        else {
          // "Hello computer" → introduce yourself. The bare wake phrase ("hey computer") just wakes it.
          const said = tail || text;
          const bare = wakePhrases(this.opts.wakeWord).some((p) => simple(p) === simple(said));
          if (this.greets(said) && !bare) void this.run(said);
        }
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

  /** Is this just a greeting ("Hello Nova", "Hi there")? */
  private greets(text: string) {
    return isGreeting(text, nameVariants(this.opts.assistantName ?? ''));
  }

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
    const reply = this.greets(text) ? greetingFor(this.opts.userName ?? '', new Date(), Math.random(), this.opts.assistantName ?? '') : await this.fx.send(text);
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
