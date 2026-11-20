import * as d from '../win/desktop.js';
import { parseFast, runFast, type FastDeps } from './commands.js';
import type { Reminders } from '../brain/reminders.js';

const deps: FastDeps = {
  bestApp: d.bestApp,
  openApp: d.openApp,
  openTarget: d.openTarget,
  pressKeys: d.pressKeys,
  closeWindow: async (q) => !(await d.windowAction(q, 'close')).startsWith('No open window'),
};

/** Tries `text` as an instant command. Resolves with the reply, or undefined to hand it to Claude. */
export async function tryFast(text: string, reminders?: Reminders): Promise<string | undefined> {
  const action = parseFast(text);
  if (!action) return undefined;
  try {
    return await runFast(action, { ...deps, reminders });
  } catch {
    return undefined; // let Claude try it its own way
  }
}
