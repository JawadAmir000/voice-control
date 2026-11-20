import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseClock, parseDuration, parseWhen, sayDuration, sayTime } from '../src/fast/when.js';
import { Reminders, dueMessage, toYou } from '../src/brain/reminders.js';
import { parseFast, runFast, type FastDeps } from '../src/fast/commands.js';

// Friday 20 Nov 2026, 10:00 local time
const NOW = new Date(2026, 10, 20, 10, 0, 0);
const hm = (d?: Date) => d && `${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

describe('spoken times', () => {
  it('durations', () => {
    expect(parseDuration('20 minutes')).toBe(20 * 60_000);
    expect(parseDuration('five minutes')).toBe(5 * 60_000);
    expect(parseDuration('an hour and a half')).toBe(90 * 60_000);
    expect(parseDuration('1 hour 30 minutes')).toBe(90 * 60_000);
    expect(parseDuration('half an hour')).toBe(30 * 60_000);
    expect(parseDuration('45 seconds')).toBe(45_000);
    expect(parseDuration('a couple of minutes')).toBe(2 * 60_000);
    expect(parseDuration('tuesday')).toBeUndefined();
  });

  it('clock times pick the next time it is that o\'clock', () => {
    expect(hm(parseClock('5 pm', NOW))).toBe('20 17:00');
    expect(hm(parseClock('5:30 p.m.', NOW))).toBe('20 17:30');
    expect(hm(parseClock('5', NOW))).toBe('20 17:00'); // 5 am is past: means 5 pm
    expect(hm(parseClock('9 am', NOW))).toBe('21 09:00'); // already past today
    expect(hm(parseClock('noon', NOW))).toBe('20 12:00');
    expect(hm(parseClock('17:45', NOW))).toBe('20 17:45');
    expect(parseClock('25:00', NOW)).toBeUndefined();
  });

  it('whole phrases', () => {
    expect(hm(parseWhen('in 20 minutes', NOW))).toBe('20 10:20');
    expect(hm(parseWhen('at 5:30 pm', NOW))).toBe('20 17:30');
    expect(hm(parseWhen('tomorrow at 9', NOW))).toBe('21 09:00');
    expect(hm(parseWhen('9 am tomorrow', NOW))).toBe('21 09:00');
    expect(hm(parseWhen('tomorrow', NOW))).toBe('21 09:00');
    expect(hm(parseWhen('2026-11-25T08:15', NOW))).toBe('25 08:15');
    expect(parseWhen('someday', NOW)).toBeUndefined();
  });

  it('says them back', () => {
    expect(sayDuration(90 * 60_000)).toBe('1 hour 30 minutes');
    expect(sayDuration(5 * 60_000)).toBe('5 minutes');
    expect(sayTime(new Date(2026, 10, 20, 17, 30), NOW)).toBe('5:30 PM');
    expect(sayTime(new Date(2026, 10, 21, 9, 0), NOW)).toBe('tomorrow at 9:00 AM');
  });
});

describe('reminder phrases', () => {
  const p = (t: string) => parseFast(t, 'C:\\Users\\me', NOW);
  it('timers', () => {
    expect(p('Set a timer for 5 minutes.')).toEqual({ kind: 'timer', ms: 5 * 60_000 });
    expect(p('Set a 10 minute timer')).toEqual({ kind: 'timer', ms: 10 * 60_000 });
    expect(p('timer for an hour and a half')).toEqual({ kind: 'timer', ms: 90 * 60_000 });
  });

  it('reminders, with the time first or last', () => {
    expect(p('Remind me in 20 minutes to call Ali.')).toMatchObject({ kind: 'remind', text: 'call ali', inMs: 20 * 60_000 });
    expect(p('Remind me to call my mom at 5:30 p.m.')).toMatchObject({ kind: 'remind', text: 'call my mom' });
    expect(hm((p('Remind me to call my mom at 5:30 p.m.') as { due: Date }).due)).toBe('20 17:30');
    expect(p('remind me to look at the oven in 5 minutes')).toMatchObject({ text: 'look at the oven', inMs: 5 * 60_000 });
    expect(p('Set a reminder for tomorrow at 9 to send the report and the invoice')).toMatchObject({ text: 'send the report and the invoice' });
    expect(p('Remind me that I need to stretch in an hour')).toMatchObject({ text: 'stretch' });
  });

  it('listing and cancelling', () => {
    expect(p('What are my reminders?')).toEqual({ kind: 'list-reminders' });
    expect(p('How much time is left on the timer')).toEqual({ kind: 'list-reminders' });
    expect(p('Cancel the timer')).toEqual({ kind: 'cancel-reminders', what: 'timer' });
    expect(p('Clear all my reminders')).toEqual({ kind: 'cancel-reminders', what: 'all' });
  });

  it('leaves vague ones to Claude', () => {
    expect(p('Remind me about the meeting')).toBeUndefined();
    expect(p('Remind me to call Ali sometime next week')).toBeUndefined();
  });
});

describe('reminders', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  it('go off on time, once', async () => {
    const fired: string[] = [];
    const r = new Reminders(undefined, (_r, msg) => fired.push(msg));
    r.start();
    r.add('call my mom', new Date(NOW.getTime() + 60_000));
    r.add('', new Date(NOW.getTime() + 300_000), 'timer', 300_000);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fired).toEqual(['Reminder: call your mom.']);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fired).toEqual(['Reminder: call your mom.', 'Your 5 minute timer is done.']);
    expect(r.list()).toEqual([]);
    r.stop();
  });

  it('survive a restart, and missed ones are said on start-up', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'nova-rem-')), 'reminders.json');
    const a = new Reminders(file);
    a.add('water the plants', new Date(NOW.getTime() + 3_600_000));
    a.add('stand up', new Date(NOW.getTime() - 3_600_000)); // due while "closed"
    a.add('', new Date(NOW.getTime() - 3_600_000), 'timer', 60_000); // stale timer: dropped
    const fired: string[] = [];
    const b = new Reminders(file, (_r, msg) => fired.push(msg));
    b.start();
    expect(fired).toEqual(['Reminder: stand up. That was due while I was off.']);
    expect(b.list().map((x) => x.text)).toEqual(['water the plants']);
    b.stop();
  });

  it('ignore a broken file', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'nova-rem-')), 'reminders.json');
    writeFileSync(file, '{ not json');
    expect(new Reminders(file).list()).toEqual([]);
  });

  it('cancel by text, timer or all', () => {
    const r = new Reminders();
    r.add('call Ali', new Date(NOW.getTime() + 60_000));
    r.add('', new Date(NOW.getTime() + 60_000), 'timer', 60_000);
    expect(r.cancel('timer').map((x) => x.kind)).toEqual(['timer']);
    expect(r.cancel('ali').map((x) => x.text)).toEqual(['call Ali']);
    expect(r.cancel('all')).toEqual([]);
  });

  it('speak naturally', () => {
    expect(toYou("call my mom and tell her I'm late")).toBe("call your mom and tell her you're late");
    expect(dueMessage({ id: '1', text: '', due: '', kind: 'timer', ms: 90_000 })).toBe('Your 1 minute 30 second timer is done.');
  });

  it('work as instant commands', async () => {
    const r = new Reminders();
    const deps = { reminders: r, now: () => NOW } as unknown as FastDeps;
    expect(await runFast(parseFast('set a timer for 10 minutes', '', NOW)!, deps)).toBe('Timer set for 10 minutes.');
    expect(await runFast(parseFast('remind me to call Ali at 5 pm', '', NOW)!, deps)).toBe("Okay, I'll remind you at 5:00 PM.");
    expect(await runFast(parseFast('what are my reminders', '', NOW)!, deps)).toBe('10 minute timer, done at 10:10 AM. Reminder to call ali at 5:00 PM.');
    expect(await runFast(parseFast('cancel the timer', '', NOW)!, deps)).toBe('Cancelled the timer.');
  });
});

describe('review fixes: reminders', () => {
  it('part of day decides am or pm', () => {
    const SEVEN_AM = new Date(2026, 10, 20, 7, 0, 0);
    expect(hm(parseWhen('at 8 tonight', SEVEN_AM))).toBe('20 20:00');
    expect(hm(parseWhen('8 this evening', SEVEN_AM))).toBe('20 20:00');
    expect(hm(parseWhen('at 3 this afternoon', SEVEN_AM))).toBe('20 15:00');
    expect(hm(parseWhen('tomorrow morning at 6', SEVEN_AM))).toBe('21 06:00');
    expect(hm(parseWhen('tomorrow evening at 7', SEVEN_AM))).toBe('21 19:00');
    expect(hm(parseWhen('tomorrow evening', SEVEN_AM))).toBe('21 20:00');
  });

  it('cancelling one reminder by name leaves timers alone', () => {
    const r = new Reminders();
    r.add('call mom', new Date(NOW.getTime() + 60_000));
    r.add('', new Date(NOW.getTime() + 60_000), 'timer', 60_000);
    expect(r.cancel('call mom').map((x) => x.text)).toEqual(['call mom']);
    expect(r.list().map((x) => x.kind)).toEqual(['timer']);
  });

  it('"cancel the reminder" (just one) is left to Claude', () => {
    expect(parseFast('cancel the reminder', '', NOW)).toBeUndefined();
    expect(parseFast('cancel all my reminders', '', NOW)).toEqual({ kind: 'cancel-reminders', what: 'all' });
  });
});
