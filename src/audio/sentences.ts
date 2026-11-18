/** Splits a reply into sentences so the first one can start playing right away. */
export function sentences(text: string): string[] {
  const parts = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) ?? [];
  const out: string[] = [];
  for (let p of parts.map((x) => x.trim()).filter(Boolean)) {
    // Very long sentences: break at commas so playback starts sooner.
    while (p.length > 180) {
      const cut = p.lastIndexOf(', ', 160);
      if (cut < 40) break;
      out.push(p.slice(0, cut + 1));
      p = p.slice(cut + 2);
    }
    out.push(p);
  }
  return out;
}
