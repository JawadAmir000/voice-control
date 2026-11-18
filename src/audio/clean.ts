/**
 * Whisper sometimes gets stuck repeating a phrase on background audio
 * ("doing something for you doing something for you …"). Such text is never a real command.
 */
export function isRepetitive(text: string): boolean {
  const w = text.toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);
  if (w.length < 12) return false;
  const counts = new Map<string, number>();
  for (let i = 0; i + 3 <= w.length; i++) {
    const g = w.slice(i, i + 3).join(' ');
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const top = Math.max(...counts.values());
  return top >= 5 && (top * 3) / w.length > 0.4;
}
