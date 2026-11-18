/** Wake-word and yes/no detection on transcribed text. Pure functions, unit-tested. */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** Ways Whisper tends to mishear short assistant names. */
const NAME_ALIASES: Record<string, string[]> = {
  nova: ['noah', 'novah', 'novia', 'nava', 'nover', 'nowa', 'novo', 'knova'],
  computer: ['commuter', 'computers'],
};

const close = (word: string, target: string) =>
  word === target ||
  (NAME_ALIASES[target] ?? []).includes(word) ||
  (target.length >= 5 && editDistance(word, target) <= Math.floor(target.length / 4));

/** "Nova" → ["nova", "noah", …]: the name plus how Whisper tends to mishear it. */
export const nameVariants = (name: string) => (name ? [name.toLowerCase(), ...(NAME_ALIASES[name.toLowerCase()] ?? [])] : []);

/** "hey nova, hey computer" → ["hey nova", "hey computer"] */
export const wakePhrases = (setting: string) => setting.split(',').map((p) => p.trim()).filter(Boolean);

const STRONG_GREETINGS = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'hay', 'yo', 'hiya', 'heyy']);
const GREETINGS = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'a', 'hay', 'yo', 'ey', 'heyy', 'hei']);

/**
 * Checks whether an utterance starts with the wake phrase (e.g. "hey computer").
 * Returns the rest of the sentence as the command (may be empty: "hey computer" alone).
 * Tolerates small mis-hearings ("hey commuter", "okay computer").
 */
export function matchWake(transcript: string, wakePhrase: string): { woke: boolean; rest: string } {
  const list = wakePhrases(wakePhrase);
  if (list.length > 1) {
    for (const p of list) { const m = matchWake(transcript, p); if (m.woke) return m; }
    return { woke: false, rest: '' };
  }
  const words = norm(transcript).split(' ').filter(Boolean);
  const wake = norm(wakePhrase).split(' ').filter(Boolean);
  const name = wake[wake.length - 1]; // "computer"
  const lead = wake.slice(0, -1); // ["hey"]
  // Look for the name within the first 3 words.
  for (let i = 0; i < Math.min(3, words.length); i++) {
    if (!close(words[i], name)) continue;
    const before = words.slice(0, i);
    const ok = before.length === 0 ? lead.length === 0 || i === 0 : before.every((w) => GREETINGS.has(w) || lead.some((l) => close(w, l)));
    if (!ok) continue;
    // Keep original casing for the command part.
    const original = transcript.trim().split(/\s+/);
    const rest = original.slice(i + 1).join(' ').replace(/^[,.!?;:\s]+/, '').trim();
    return { woke: true, rest };
  }
  // Right after a clear greeting, short names get a looser, sound-alike match, including a name
  // Whisper split in two: "Hello, no bad" / "Hello Noba" → "Hello Nova".
  if (name.length <= 6) {
    for (let i = 1; i < Math.min(3, words.length); i++) {
      if (!words.slice(0, i).every((w) => STRONG_GREETINGS.has(w) || lead.some((l) => close(w, l)))) break;
      const original = transcript.trim().split(/\s+/);
      const restFrom = (k: number) => original.slice(k).join(' ').replace(/^[,.!?;:\s]+/, '').trim();
      if (soundsLike(words[i], name)) return { woke: true, rest: restFrom(i + 1) };
      if (i + 1 < words.length && soundsLike(words[i] + words[i + 1], name)) return { woke: true, rest: restFrom(i + 2) };
    }
  }
  return { woke: false, rest: '' };
}

/** Same first letter, similar length, at most 2 letters different ("nobad" ≈ "nova"). */
function soundsLike(heard: string, name: string): boolean {
  return heard[0] === name[0] && heard.length >= name.length - 1 && heard.length <= name.length + 2 && editDistance(heard, name) <= 2;
}

/**
 * Finds the wake phrase anywhere in a clip, for when background audio (a video) is glued to
 * what you said: "...the position. Hey computer, open Notepad" → { woke, rest: "open Notepad" }.
 * Mid-sentence it needs the full phrase (greeting + name), so a stray "computer" doesn't count.
 */
export function findWake(transcript: string, wakePhrase: string): { woke: boolean; rest: string } {
  const start = matchWake(transcript, wakePhrase);
  if (start.woke) return start;
  const list = wakePhrases(wakePhrase);
  if (list.length > 1) {
    for (const p of list) { const m = findWake(transcript, p); if (m.woke) return m; }
    return { woke: false, rest: '' };
  }
  const tokens = transcript.trim().split(/\s+/);
  const w = tokens.map((t) => norm(t));
  const wake = norm(wakePhrase).split(' ').filter(Boolean);
  const name = wake[wake.length - 1];
  const lead = wake.slice(0, -1);
  for (let i = 1; i < w.length; i++) {
    if (!close(w[i], name)) continue;
    const prev = w[i - 1];
    // Mid-sentence only a real greeting counts ("a nova" is ordinary English, "hey nova" isn't).
    if (!(STRONG_GREETINGS.has(prev) || lead.some((l) => close(prev, l)))) continue;
    const rest = tokens.slice(i + 1).join(' ').replace(/^[,.!?;:\s]+/, '').trim();
    return { woke: true, rest };
  }
  return { woke: false, rest: '' };
}

/** The last sentence of a clip ("…video talk. Hello."), where your own words usually land. */
export function lastSentence(transcript: string): string {
  const parts = transcript.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

export function parseYesNo(text: string): 'yes' | 'no' | 'unknown' {
  const t = norm(text);
  if (!t) return 'unknown';
  if (/\b(no|nope|don't|do not|stop|cancel|never|negative|wait)\b/.test(t)) return 'no';
  if (/\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|confirm|correct|affirmative|please do)\b/.test(t)) return 'yes';
  return 'unknown';
}

/** "That's all", "bye", "stop listening"… ends a conversation. */
export function isGoodbye(text: string): boolean {
  const t = norm(text).replace(/^(hey computer )?(ok |okay |alright )?/, '');
  return /^((thanks?|thank you)( so much)? )?(that's all|that is all|that's it|bye|bye bye|goodbye|good bye|stop listening|go to sleep|we're done|i'm done|nothing else|no thanks?|no thank you|that will be all)( for now)?( thanks?| thank you)?$/.test(t)
    || /^(thanks?|thank you)( so much)?( bye| goodbye)$/.test(t);
}

/**
 * True when a transcript is just the assistant's own voice picked up by the mic
 * (most of its words appear in what is being spoken).
 */
export function isEcho(heard: string, spoken: string): boolean {
  const h = norm(heard).split(' ').filter((w) => w.length > 1);
  if (h.length === 0) return true;
  const s = new Set(norm(spoken).split(' '));
  const hits = h.filter((w) => s.has(w)).length;
  return hits / h.length >= 0.5;
}

/**
 * Removes the assistant's own voice from a transcript and returns what's left ('' if it was all echo).
 * Speakers often record the end of a reply and the user's next words in one clip, e.g.
 * "Ready to help with anything on your PC. So which model are you using?" →
 * "So which model are you using?". The echo is the leading run of words that follows the
 * spoken reply in order (small mis-hearings allowed).
 */
export function stripEcho(heard: string, spoken: string): string {
  const spokenWords = norm(spoken).split(' ').filter(Boolean);
  const spokenSet = new Set(spokenWords);
  const tokens = heard.trim().split(/\s+/).filter(Boolean);
  const w = tokens.map((t) => norm(t));

  // Find the longest in-order run starting at the first or second heard word.
  let cut = 0;
  for (let start = 0; start < Math.min(2, w.length); start++) {
    for (let from = 0; from < spokenWords.length; from++) {
      if (spokenWords[from] !== w[start]) continue;
      let p = from + 1, matched = 1, end = start + 1, misses = 0;
      for (let i = start + 1; i < w.length && misses < 2; i++) {
        if (!w[i]) continue;
        const k = spokenWords.slice(p, p + 4).indexOf(w[i]);
        if (k >= 0) { p += k + 1; matched++; end = i + 1; misses = 0; } else misses++;
      }
      if (matched >= 2 && end > cut) cut = end;
    }
  }
  const rest = tokens.slice(cut);
  const restWords = rest.map((t) => norm(t)).filter((x) => x.length > 1);
  // Nothing left, or only scattered words from the reply ("do", "voice open") → all echo.
  if (restWords.length === 0 || restWords.every((x) => spokenSet.has(x))) return '';
  return rest.join(' ').replace(/^[,.!?;:\s]+/, '');
}

export function isStop(text: string): boolean {
  const t = norm(text);
  return /^(hey computer )?(stop|cancel|abort|never mind|nevermind|stop it|stop stop)$/.test(t);
}
