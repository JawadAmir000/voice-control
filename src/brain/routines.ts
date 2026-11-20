/**
 * Routines: one phrase runs a list of commands. "Start work mode" → open VS Code, open Slack,
 * open GitHub. Saved in %APPDATA%\voice-control\routines.json; Claude can create them when you
 * say "when I say standup, open Linear and my notes".
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type RoutineMap = Record<string, string[]>;

const norm = (s: string) => s.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** "Work mode" / "my work routine" → "work" (what's left once the filler is gone). */
const core = (s: string) => norm(s).replace(/^(my|the) /, '').replace(/ (mode|routine)$/, '').trim();

export class Routines {
  private map: RoutineMap = {};

  constructor(private file?: string, initial: RoutineMap = {}) {
    this.map = { ...initial };
    this.load();
  }

  private load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        this.map = {};
        for (const [k, v] of Object.entries(raw)) {
          if (Array.isArray(v)) this.map[k] = v.filter((x): x is string => typeof x === 'string' && !!x.trim());
        }
      }
    } catch {
      /* none yet, or half-edited */
    }
  }

  list(): RoutineMap {
    this.load();
    return { ...this.map };
  }

  save(name: string, steps: string[]): string {
    this.load();
    name = name.trim();
    steps = steps.map((s) => s.trim()).filter(Boolean);
    if (!name || !steps.length) return 'A routine needs a name and at least one step.';
    // Replace one with the same name, whatever words were around it.
    for (const k of Object.keys(this.map)) if (core(k) === core(name)) delete this.map[k];
    this.map[name] = steps;
    this.write();
    return `Saved routine "${name}": ${steps.join(' → ')}`;
  }

  delete(name: string): boolean {
    this.load();
    const key = Object.keys(this.map).find((k) => core(k) === core(name));
    if (!key) return false;
    delete this.map[key];
    this.write();
    return true;
  }

  /** "Start work mode", "work mode", "run my morning routine" → that routine. */
  match(text: string): { name: string; steps: string[] } | undefined {
    const t = norm(text)
      .replace(/^(please|ok|okay|hey|nova|computer|can you|could you)\s+/, '')
      .replace(/\s+(please|now|for me)$/, '')
      .replace(/^(start|run|begin|do|activate|launch|go|switch to|enter|turn on|let's do|time for|it's)\s+/, '');
    const said = core(t);
    if (!said) return undefined;
    for (const [name, steps] of Object.entries(this.list())) {
      if (core(name) === said) return { name, steps };
    }
    return undefined;
  }

  ensureFile() {
    if (this.file && !existsSync(this.file)) this.write();
  }

  private write() {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.map, null, 2));
    } catch {
      /* best-effort */
    }
  }
}

/** "wait 3 seconds" inside a routine: a pause between steps. Returns ms, or undefined. */
export function waitStep(step: string): number | undefined {
  const m = step.toLowerCase().trim().replace(/[.!]$/, '').match(/^(?:wait|pause)(?: for)? (\d+(?:\.\d+)?) ?(seconds?|secs?|s)$/);
  return m ? Math.min(60, Number(m[1])) * 1000 : undefined;
}
