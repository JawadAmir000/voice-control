/**
 * Reminders and timers. Saved in %APPDATA%\voice-control\reminders.json, so a reminder set for
 * tomorrow still goes off after a restart (or right away, if it was due while the app was closed).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { sayDuration, sayTime } from '../fast/when.js';

/** "5 minute", "1 hour 30 minute": the length as in "a 5 minute timer". */
const timerLength = (ms: number) => sayDuration(ms).replace(/\b(hour|minute|second)s\b/g, '$1');

export type Reminder = {
  id: string;
  /** What to remind about ("call Ali"); empty for a plain timer. */
  text: string;
  due: string;
  kind: 'reminder' | 'timer';
  /** For timers: the length, to say "your 5 minute timer is done". */
  ms?: number;
};

/** Called when a reminder goes off. `late` = it was due while the app wasn't running. */
export type OnDue = (r: Reminder, message: string, late: boolean) => void;

/** "my mom" → "your mom", so "remind me to call my mom" is read back naturally. */
export function toYou(s: string): string {
  const swap: Record<string, string> = { my: 'your', me: 'you', i: 'you', "i'm": "you're", myself: 'yourself', mine: 'yours' };
  return s.replace(/\bi am\b/gi, 'you are').replace(/\b(i'm|my|me|i|myself|mine)(?![\w'])/gi, (w) => swap[w.toLowerCase()] ?? w);
}

/** What Nova says when it goes off. */
export function dueMessage(r: Reminder, late = false): string {
  if (r.kind === 'timer') return `${r.ms ? `Your ${timerLength(r.ms)} timer` : 'Your timer'} is done${r.text ? `: ${r.text}` : ''}.`;
  const msg = `Reminder: ${toYou(r.text)}.`;
  return late ? `${msg} That was due while I was off.` : msg;
}

export class Reminders {
  private items: Reminder[] = [];
  private ticker?: ReturnType<typeof setInterval>;
  private seq = 0;

  constructor(private file?: string, private onDue: OnDue = () => {}) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) this.items = raw.filter((r) => r && typeof r.due === 'string' && !Number.isNaN(Date.parse(r.due)));
    } catch {
      /* none yet */
    }
  }

  /** Starts checking the clock; anything already overdue goes off now. */
  start() {
    this.check(true);
    this.ticker ??= setInterval(() => this.check(false), 1000);
    (this.ticker as { unref?: () => void }).unref?.();
  }

  stop() {
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  list(): Reminder[] {
    return [...this.items].sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  }

  add(text: string, due: Date, kind: Reminder['kind'] = 'reminder', ms?: number): Reminder {
    const r: Reminder = { id: `${Date.now().toString(36)}${(this.seq++).toString(36)}`, text: text.trim(), due: due.toISOString(), kind, ms };
    this.items.push(r);
    this.save();
    return r;
  }

  /** Cancels reminders whose text matches, "timer" for timers, or "all". Returns what was cancelled. */
  cancel(query: string): Reminder[] {
    const q = query.trim().toLowerCase();
    const all = !q || q === 'all' || q === 'everything' || q === '*';
    const hit = (r: Reminder) =>
      all || (q === 'timer' || q === 'the timer' ? r.kind === 'timer' : !!r.text && (r.text.toLowerCase().includes(q) || q.includes(r.text.toLowerCase())));
    const gone = this.items.filter(hit);
    this.items = this.items.filter((r) => !hit(r));
    if (gone.length) this.save();
    return gone;
  }

  cancelId(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((r) => r.id !== id);
    if (this.items.length === before) return false;
    this.save();
    return true;
  }

  /** "Reminder to call Ali at 5:30 PM." / "5 minute timer, done at 10:45 AM." */
  describe(r: Reminder, now = new Date()): string {
    const when = sayTime(new Date(r.due), now);
    if (r.kind === 'timer') return `${r.ms ? `${timerLength(r.ms)} timer` : 'Timer'}${r.text ? ` (${r.text})` : ''}, done at ${when}`;
    return `Reminder to ${toYou(r.text)} at ${when}`;
  }

  private check(startup: boolean) {
    const now = Date.now();
    const due = this.items.filter((r) => Date.parse(r.due) <= now);
    if (!due.length) return;
    this.items = this.items.filter((r) => Date.parse(r.due) > now);
    this.save();
    for (const r of due) {
      const late = startup && now - Date.parse(r.due) > 60_000;
      // A timer that ran out while the app was closed is no use any more.
      if (late && r.kind === 'timer') continue;
      this.onDue(r, dueMessage(r, late), late);
    }
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.items, null, 2));
    } catch {
      /* best-effort */
    }
  }
}
