import { describe, expect, it } from 'vitest';
import { parseFast, runFast, type FastDeps } from '../src/fast/commands.js';

const p = (t: string) => parseFast(t, 'C:\\Users\\me');

describe('instant commands: recognising them', () => {
  it('volume and media', () => {
    expect(p('Volume up.')).toMatchObject({ kind: 'keys', keys: 'volumeup', times: 5 });
    expect(p('Turn the volume up a lot please')).toMatchObject({ keys: 'volumeup', times: 10 });
    expect(p('Make it quieter.')).toMatchObject({ keys: 'volumedown' });
    expect(p('Mute')).toMatchObject({ keys: 'volumemute' });
    expect(p('Pause the music.')).toMatchObject({ keys: 'playpause' });
    expect(p('Next song')).toMatchObject({ keys: 'nexttrack' });
    expect(p('Skip')).toMatchObject({ keys: 'nexttrack' });
    expect(p('Previous track')).toMatchObject({ keys: 'prevtrack' });
  });

  it('screen, lock, time and date', () => {
    expect(p('Show desktop')).toMatchObject({ keys: 'win+d' });
    expect(p('Minimize everything')).toMatchObject({ keys: 'win+m' });
    expect(p('Lock my computer.')).toBeUndefined(); // Claude asks first
    expect(p("What's the time?")).toEqual({ kind: 'time' });
    expect(p('What time is it now')).toEqual({ kind: 'time' });
    expect(p('What day is it today?')).toEqual({ kind: 'date' });
  });

  it('opening apps, websites and folders', () => {
    expect(p('Open Notepad.')).toEqual({ kind: 'open', name: 'notepad' });
    expect(p('Can you open Visual Studio Code for me?')).toEqual({ kind: 'open', name: 'visual studio code' });
    expect(p('Open YouTube')).toMatchObject({ kind: 'url', url: 'https://www.youtube.com' });
    expect(p('go to github.com')).toMatchObject({ kind: 'url', url: 'https://github.com' });
    expect(p('Open my downloads folder')).toMatchObject({ kind: 'folder', path: 'C:\\Users\\me\\Downloads' });
    expect(p('Close Notepad')).toEqual({ kind: 'close', name: 'notepad' });
  });

  it('leaves anything more complicated to Claude', () => {
    expect(p('Open Notepad and type hello')).toBeUndefined();
    expect(p('Open a new tab')).toBeUndefined();
    expect(p('Open it')).toBeUndefined();
    expect(p('Close this')).toBeUndefined();
    expect(p('Close the tab')).toBeUndefined();
    expect(p('Close this window')).toBeUndefined();
    expect(p('Play some jazz on Spotify')).toBeUndefined();
    expect(p('Open the report I was working on yesterday afternoon')).toBeUndefined();
    expect(p('Write an email to Sarah')).toBeUndefined();
    expect(p('Lock')).toBeUndefined();
  });
});

function fakeDeps(over: Partial<FastDeps> = {}) {
  const calls: string[] = [];
  const deps: FastDeps = {
    bestApp: async (q) => (q === 'notepad' ? { name: 'Notepad', score: 100 } : { name: 'Something Else', score: 30 }),
    openApp: async (q) => { calls.push(`app:${q}`); return 'ok'; },
    openTarget: async (t) => { calls.push(`open:${t}`); return 'ok'; },
    pressKeys: async (k, n) => { calls.push(`keys:${k}x${n}`); },
    closeWindow: async (q) => { calls.push(`close:${q}`); return q === 'notepad'; },
    now: () => new Date(2026, 10, 20, 15, 5),
    ...over,
  };
  return { deps, calls };
}

describe('instant commands: doing them', () => {
  it('presses keys and opens things', async () => {
    const { deps, calls } = fakeDeps();
    expect(await runFast(p('volume up')!, deps)).toBe('Turned it up.');
    expect(await runFast(p('open notepad')!, deps)).toBe("Notepad's open.");
    expect(await runFast(p('open youtube')!, deps)).toBe("Youtube's open.");
    expect(calls).toEqual(['keys:volumeupx5', 'app:notepad', 'open:https://www.youtube.com']);
  });

  it('says the time and date', async () => {
    const { deps } = fakeDeps();
    expect(await runFast({ kind: 'time' }, deps)).toBe("It's 3:05 PM.");
    expect(await runFast({ kind: 'date' }, deps)).toBe("It's Friday, November 20, 2026.");
  });

  it('hands over to Claude when it is not sure', async () => {
    const { deps, calls } = fakeDeps();
    expect(await runFast(p('open my project')!, deps)).toBeUndefined(); // weak app match
    expect(await runFast(p('close spotify')!, deps)).toBeUndefined(); // no such window
    expect(calls).toEqual(['close:spotify']);
  });
});
