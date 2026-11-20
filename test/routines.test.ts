import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Routines, waitStep } from '../src/brain/routines.js';

describe('routines', () => {
  const r = () => new Routines(undefined, { 'work mode': ['open VS Code', 'open Slack'], standup: ['open Linear'] });

  it('start from many ways of saying it', () => {
    for (const said of ['Work mode.', 'Start work mode', 'start my work routine please', 'Switch to work mode', "let's do work mode"])
      expect(r().match(said)?.name, said).toBe('work mode');
    expect(r().match('Run standup')?.steps).toEqual(['open Linear']);
    expect(r().match('open Slack')).toBeUndefined();
    expect(r().match('start')).toBeUndefined();
  });

  it('are saved, replaced and deleted', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'nova-rt-')), 'routines.json');
    const a = new Routines(file);
    a.save('Morning routine', ['open Gmail', 'what is the date']);
    a.save('morning', ['open Outlook']); // same routine, new steps
    const b = new Routines(file);
    expect(b.list()).toEqual({ morning: ['open Outlook'] });
    expect(b.match('start my morning routine')?.steps).toEqual(['open Outlook']);
    expect(b.delete('the morning routine')).toBe(true);
    expect(b.list()).toEqual({});
    expect(a.save('empty', [' '])).toMatch(/at least one step/);
  });

  it('keep hand edits and survive a broken file', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'nova-rt-')), 'routines.json');
    const a = new Routines(file);
    writeFileSync(file, JSON.stringify({ focus: ['mute', 'open Notepad'] }));
    expect(a.match('focus mode')?.steps).toEqual(['mute', 'open Notepad']);
    writeFileSync(file, '{ oops');
    expect(a.list()).toEqual({ focus: ['mute', 'open Notepad'] });
  });

  it('understand pauses', () => {
    expect(waitStep('wait 3 seconds')).toBe(3000);
    expect(waitStep('Wait 1.5 seconds.')).toBe(1500);
    expect(waitStep('wait for the page')).toBeUndefined();
  });
});
