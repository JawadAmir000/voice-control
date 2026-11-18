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

const close = (word: string, target: string) => word === target || (target.length >= 5 && editDistance(word, target) <= Math.floor(target.length / 4));

const GREETINGS = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'a', 'hay', 'yo', 'ey', 'heyy', 'hei']);

/**
 * Checks whether an utterance starts with the wake phrase (e.g. "hey computer").
 * Returns the rest of the sentence as the command (may be empty: "hey computer" alone).
 * Tolerates small mis-hearings ("hey commuter", "okay computer").
 */
export function matchWake(transcript: string, wakePhrase: string): { woke: boolean; rest: string } {
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
  return { woke: false, rest: '' };
}

export function parseYesNo(text: string): 'yes' | 'no' | 'unknown' {
  const t = norm(text);
  if (!t) return 'unknown';
  if (/\b(no|nope|don't|do not|stop|cancel|never|negative|wait)\b/.test(t)) return 'no';
  if (/\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|confirm|correct|affirmative|please do)\b/.test(t)) return 'yes';
  return 'unknown';
}

export function isStop(text: string): boolean {
  const t = norm(text);
  return /^(hey computer )?(stop|cancel|abort|never mind|nevermind|stop it|stop stop)$/.test(t);
}
