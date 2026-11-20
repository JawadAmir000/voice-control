/**
 * Understands spoken times: "in 20 minutes", "for an hour and a half", "at 5:30 pm",
 * "tomorrow at 9", "at noon", or an ISO date ("2026-11-21T09:00").
 */

const NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, fifty: 50, sixty: 60, ninety: 90,
  'a couple of': 2, 'a couple': 2, 'a few': 3, couple: 2, few: 3,
};
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };
const unitOf = (u: string) => (u.startsWith('h') ? 'h' : u.startsWith('m') ? 'm' : 's');

const NUM = `(\\d+(?:\\.\\d+)?|${Object.keys(NUMBERS).sort((a, b) => b.length - a.length).join('|')})`;
const UNIT = '(seconds?|secs?|minutes?|mins?|hours?|hrs?)';
const PART = new RegExp(`^${NUM}\\s+${UNIT}`);

/** Lower-cases and evens out how times are written ("5:30 p.m." → "5h30 pm"). */
export function normTime(s: string): string {
  return s
    .toLowerCase()
    .replace(/(\d)\s*([ap])\.?\s?m\.?(?=\W|$)/g, '$1 $2m')
    .replace(/\b(\d{1,2}):(\d{2})\b/g, '$1h$2')
    .replace(/[^a-z0-9.' ]+/g, ' ')
    .replace(/\.(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "20 minutes", "an hour and a half", "half an hour", "1 hour 30 minutes" → milliseconds. */
export function parseDuration(s: string): number | undefined {
  let t = normTime(s);
  if (/^half an? hour$/.test(t)) return 30 * 60_000;
  if (/^(a |an )?quarter of an hour$/.test(t)) return 15 * 60_000;
  let total = 0;
  let any = false;
  while (t) {
    const m = t.match(PART);
    if (!m) break;
    const n = NUMBERS[m[1]] ?? Number(m[1]);
    const unit = unitOf(m[2]);
    total += n * UNIT_MS[unit];
    any = true;
    t = t.slice(m[0].length).trim();
    if (/^and a half\b/.test(t) || /^and half\b/.test(t)) {
      total += UNIT_MS[unit] / 2;
      t = t.replace(/^and (a )?half/, '').trim();
    }
    t = t.replace(/^(and|,)\s*/, '');
  }
  return any && !t && total > 0 ? Math.round(total) : undefined;
}

/** "5 pm", "5h30", "17h45", "noon", "9" → the next time it is that o'clock (today, or tomorrow). */
export function parseClock(s: string, now: Date, forceTomorrow = false, part?: 'am' | 'pm'): Date | undefined {
  const t = normTime(s).replace(/ o'?clock$/, '').replace(/^at /, '');
  let h: number, min = 0, ampm: string | undefined;
  if (t === 'noon' || t === 'midday') h = 12;
  else if (t === 'midnight') h = 0;
  else {
    let m = t.match(/^(\d{1,2})(?:h(\d{2})| (\d{2}))?(?: ?(am|pm))?$/);
    if (m) {
      h = Number(m[1]);
      min = Number(m[2] ?? m[3] ?? 0);
      ampm = m[4];
    } else if ((m = t.match(/^(\d{1,2})(\d{2}) ?(am|pm)$/))) {
      // "530 pm"
      h = Number(m[1]);
      min = Number(m[2]);
      ampm = m[3];
    } else return undefined;
    if (h > 23 || min > 59 || (ampm && (h > 12 || h === 0))) return undefined;
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
  }
  // "8 tonight", "6 in the morning": the part of day says am or pm.
  if (!ampm && part && h >= 1 && h <= 12) {
    ampm = part;
    if (part === 'pm' && h < 12) h += 12;
    if (part === 'am' && h === 12) h = 0;
  }
  const at = (dayOffset: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, min, 0, 0);
    return d;
  };
  if (forceTomorrow) return at(1, ampm || h > 12 || h === 0 ? h : h < 7 ? h + 12 : h);
  // No am/pm and a 12-hour number: the next time the clock shows it ("at 5" at 10 am → 5 pm).
  const candidates = ampm || h > 12 || h === 0 ? [at(0, h), at(1, h)] : [at(0, h), at(0, h + 12), at(1, h)];
  return candidates.find((d) => d.getTime() > now.getTime() + 30_000);
}

/** Any of: "in 20 minutes", "20 minutes", "at 5 pm", "tomorrow at 9", "9 am tomorrow", "tomorrow", ISO. */
export function parseWhen(s: string, now = new Date()): Date | undefined {
  const raw = s.trim();
  if (/^\d{4}-\d{2}-\d{2}([t ]\d{2}:\d{2}(:\d{2})?)?$/i.test(raw)) {
    const d = new Date(raw.length === 10 ? `${raw}T09:00` : raw.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const t = normTime(raw);
  const inDur = t.match(/^(?:in|after|for) (.+)$/);
  const dur = parseDuration(inDur ? inDur[1] : t);
  if (dur) return new Date(now.getTime() + dur);
  if (t === 'tomorrow' || t === 'tomorrow morning') return parseClock('9', now, true);
  if (t === 'tomorrow evening' || t === 'tomorrow night') return parseClock('8 pm', now, true);
  if (t === 'tonight' || t === 'this evening') return parseClock('8 pm', now);
  const part = /\b(tonight|evening|afternoon|night)\b/.test(t) ? 'pm' : /\bmorning\b/.test(t) ? 'am' : undefined;
  const bare = t
    .replace(/\b(this |in the )?(morning|evening|afternoon|night)\b/g, ' ')
    .replace(/\btonight\b/g, ' ')
    .replace(/\btoday\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tom = bare.match(/^tomorrow (?:at )?(.+)$/) ?? bare.match(/^(?:at )?(.+?) tomorrow$/);
  if (tom) return parseClock(tom[1], now, true, part);
  const at = bare.match(/^(?:at |by )?(.+)$/);
  return at ? parseClock(at[1], now, false, part) : undefined;
}

/** "20 minutes" / "1 hour 30 minutes" / "45 seconds", for speaking a timer's length. */
export function sayDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const part = (n: number, u: string) => (n ? `${n} ${u}${n === 1 ? '' : 's'}` : '');
  return [part(h, 'hour'), part(m, 'minute'), h ? '' : part(sec, 'second')].filter(Boolean).join(' ') || '0 seconds';
}

/** "5:30 PM" today, "tomorrow at 9:00 AM", or "Saturday at 9:00 AM". */
export function sayTime(d: Date, now = new Date()): string {
  const clock = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  if (diff === 0) return clock;
  if (diff === 1) return `tomorrow at ${clock}`;
  if (diff < 7) return `${d.toLocaleDateString('en-US', { weekday: 'long' })} at ${clock}`;
  return `${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} at ${clock}`;
}
