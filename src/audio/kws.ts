/**
 * Wake-word phrases for the keyword spotter. It listens for sounds, not spelling, so "Hey Nova"
 * is caught even when the speech recognizer would write "Hanova" or "And over".
 * Pure functions, unit-tested.
 */

/** Greetings that can come before the name. */
const GREETINGS = ['hey', 'hi', 'hello', 'okay'];

/** Reads tokens.txt ("▁HE 49" per line) into the set of word pieces. */
export function parseVocab(tokensTxt: string): Set<string> {
  return new Set(tokensTxt.split(/\r?\n/).map((l) => l.split(' ')[0]).filter(Boolean));
}

/** Splits one word into the model's pieces, longest match first: "nova" → ["▁NO", "V", "A"]. */
export function tokenize(word: string, vocab: Set<string>): string[] | undefined {
  const w = '▁' + word.toUpperCase().replace(/[^A-Z']/g, '');
  const out: string[] = [];
  let i = 0;
  while (i < w.length) {
    let j = w.length;
    while (j > i && !vocab.has(w.slice(i, j))) j--;
    if (j === i) return undefined; // a letter the model doesn't know
    out.push(w.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * keywords.txt lines for "<greeting> <name>": "▁HE Y ▁NO V A @hey_nova", one per greeting.
 * The phrase after @ is what the spotter reports back.
 */
export function wakeKeywords(name: string, vocab: Set<string>): string[] {
  const lines: string[] = [];
  for (const g of GREETINGS) {
    const parts = [g, name.toLowerCase()].map((w) => tokenize(w, vocab));
    if (parts.some((p) => !p)) continue;
    lines.push(`${parts.flat().join(' ')} @${g}_${name.toLowerCase()}`);
  }
  return lines;
}
