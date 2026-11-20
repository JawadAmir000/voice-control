import { describe, expect, it } from 'vitest';
import { classify, describe as describeAction } from '../src/brain/permissions.js';
import { isStop, matchWake, parseYesNo } from '../src/audio/wake.js';
import { parseChord, rankApps, scoreApp } from '../src/win/desktop.js';

const ps = (script: string) => classify('mcp__pc__run_powershell', { script, reason: 'test' }).kind;

describe('safety gate', () => {
  it('lets harmless actions run', () => {
    expect(classify('mcp__pc__open_app', { name: 'notepad' }).kind).toBe('allow');
    expect(classify('mcp__pc__type_text', { text: 'build things for me' }).kind).toBe('allow');
    expect(ps('Get-ChildItem $HOME\\Desktop')).toBe('allow');
    expect(ps('Get-Process | Sort-Object CPU | Select -First 5 2>$null')).toBe('allow');
  });
  it('asks before risky shell commands', () => {
    expect(ps('Remove-Item "$HOME\\Desktop\\test.txt"')).toBe('confirm');
    expect(ps('Stop-Computer -Force')).toBe('confirm');
    expect(ps('shutdown /r /t 0')).toBe('confirm');
    expect(ps('winget install vlc')).toBe('confirm');
    expect(ps('Set-ItemProperty HKCU:\\Software\\X -Name a -Value 1')).toBe('confirm');
    expect(ps('"hi" > notes.txt')).toBe('confirm');
    expect(ps('Stop-Process -Name chrome')).toBe('confirm');
  });
  it('refuses security changes and credential access', () => {
    expect(ps('Set-MpPreference -DisableRealtimeMonitoring $true')).toBe('deny');
    expect(ps('netsh advfirewall set allprofiles state off')).toBe('deny');
    expect(ps('cmdkey /list')).toBe('deny');
  });
  it('asks before clicking send/buy/delete buttons', () => {
    expect(classify('mcp__pc__click_element', { name: 'Send' }).kind).toBe('confirm');
    expect(classify('mcp__pc__click_element', { name: 'Place order' }).kind).toBe('confirm');
    expect(classify('mcp__pc__click_element', { name: 'New session' }).kind).toBe('allow');
  });
  it('refuses typing card numbers', () => {
    expect(classify('mcp__pc__type_text', { text: '4111 1111 1111 1111' }).kind).toBe('deny');
    expect(classify('mcp__pc__type_text', { text: 'order 1234567890123' }).kind).toBe('allow');
  });
  it('refuses Claude Code built-in tools', () => {
    expect(classify('Bash', { command: 'ls' }).kind).toBe('deny');
  });
});

describe('wake word', () => {
  it('extracts the command after the wake phrase', () => {
    expect(matchWake('Hey computer, open Visual Studio Code.', 'hey computer')).toEqual({ woke: true, rest: 'open Visual Studio Code.' });
    expect(matchWake('Okay computer open Claude', 'hey computer')).toEqual({ woke: true, rest: 'open Claude' });
    expect(matchWake('Hey commuter, open notepad', 'hey computer').woke).toBe(true);
    expect(matchWake('Hey computer.', 'hey computer')).toEqual({ woke: true, rest: '' });
  });
  it('ignores normal speech', () => {
    expect(matchWake('my computer is slow today', 'hey computer').woke).toBe(false);
    expect(matchWake('open notepad', 'hey computer').woke).toBe(false);
    expect(matchWake('I bought a new computer', 'hey computer').woke).toBe(false);
  });
  it('understands yes / no / stop', () => {
    expect(parseYesNo('Yes, go ahead.')).toBe('yes');
    expect(parseYesNo('No, don\'t.')).toBe('no');
    expect(parseYesNo('Hmm.')).toBe('unknown');
    expect(isStop('Stop!')).toBe(true);
    expect(isStop('stop the music')).toBe(false);
  });
});

describe('apps and keys', () => {
  const apps = [
    { Name: 'Visual Studio Code', AppID: 'a' },
    { Name: 'Visual Studio 2022', AppID: 'b' },
    { Name: 'Claude', AppID: 'c' },
    { Name: 'Notepad', AppID: 'd' },
  ];
  it('matches spoken app names', () => {
    expect(rankApps(apps, 'claude')[0].Name).toBe('Claude');
    expect(rankApps(apps, 'vs code')[0].Name).toBe('Visual Studio Code');
    expect(rankApps(apps, 'visual studio 2022')[0].Name).toBe('Visual Studio 2022');
    expect(scoreApp('Notepad', 'notepad')).toBe(100);
    expect(rankApps(apps, 'photoshop')).toEqual([]);
  });
  it('parses shortcuts', () => {
    expect(parseChord('ctrl+shift+t')).toEqual([0x11, 0x10, 0x54]);
    expect(parseChord('alt+f4')).toEqual([0x12, 0x73]);
    expect(() => parseChord('hyper+x')).toThrow();
  });
});

import { greetingFor, isGreeting } from '../src/brain/greeting.js';

describe('greeting', () => {
  it('recognises plain greetings, not commands', () => {
    for (const t of ['Hello', 'Hi there!', 'Hello computer', 'Good morning', 'Hey, how are you?', 'Hello, how are you doing today?', 'Assalamualaikum']) expect(isGreeting(t)).toBe(true);
    for (const t of ['Hello, open Chrome', 'hi can you open notepad', 'open the hello world file', 'How are you processing everything?']) expect(isGreeting(t)).toBe(false);
  });
  it('introduces itself by name with the time of day', () => {
    const g = greetingFor('Jawad', new Date(2026, 10, 17, 21, 0), 0);
    expect(g).toMatch(/^Good evening, Jawad! I'm your personal AI assistant\. I can .+\. .+\?$/);
    expect(greetingFor('Jawad', new Date(2026, 10, 17, 9, 0), 0)).toMatch(/^Good morning, Jawad!/);
    expect(greetingFor('', new Date(2026, 10, 17, 14, 0), 0)).toMatch(/^Good afternoon! I'm/);
  });
});

import { isRepetitive } from '../src/audio/clean.js';
describe('whisper repetition loops', () => {
  it('drops looping hallucinations but keeps normal speech', () => {
    expect(isRepetitive('If you spend 15 minutes a day doing something for you doing something for you doing something for you doing something for you doing something for you doing something')).toBe(true);
    expect(isRepetitive('So I want to learn about yourself, who are you and how are you doing this stuff like what is the brain behind you which kind of model you are using.')).toBe(false);
    expect(isRepetitive('open notepad')).toBe(false);
  });
});

describe('connected accounts (Gmail etc.)', () => {
  it('reading, searching and drafting run; sending or deleting needs a yes', () => {
    expect(classify('mcp__claude_ai_Gmail__search_threads', { query: 'Himadri' }).kind).toBe('allow');
    expect(classify('mcp__claude_ai_Gmail__get_thread', { id: '1' }).kind).toBe('allow');
    expect(classify('mcp__claude_ai_Gmail__create_draft', { to: 'a@b.c' }).kind).toBe('allow');
    expect(classify('mcp__claude_ai_Gmail__send_message', { to: 'a@b.c' }).kind).toBe('confirm');
    expect(classify('mcp__claude_ai_Gmail__reply', {}).kind).toBe('confirm');
    expect(classify('mcp__claude_ai_Gmail__trash_thread', {}).kind).toBe('confirm');
  });
  it('asks in plain words, naming the recipient', () => {
    const v = classify('mcp__claude_ai_Gmail__send_message', { to: 'xylon@example.com' });
    expect(v.kind === 'confirm' && describeAction('mcp__claude_ai_Gmail__send_message', { to: 'xylon@example.com' }, v.reason))
      .toBe("I'm about to send message in Gmail to xylon@example.com. Should I go ahead?");
  });
  it('never speaks technical refusals; plain ones only', () => {
    const v = classify('Bash', { command: 'ls' });
    expect(v.kind === 'deny' && v.spoken).toBeFalsy();
    const card = classify('mcp__pc__type_text', { text: '4111 1111 1111 1111' });
    expect(card.kind === 'deny' && card.spoken).toMatch(/card number/);
    expect(JSON.stringify(card)).not.toMatch(/mcp__/);
  });
});

import { LOST_CONNECTION, replyFor } from '../src/brain/agent.js';
describe('task end replies are never technical', () => {
  it('speaks the result on success', () => {
    expect(replyFor('success', ' Notepad is open. ', '', false)).toBe('Notepad is open.');
    expect(replyFor('success', '', 'Done.', false)).toBe('Done.');
  });
  it('says "Stopped." when the user stopped it (real log: error_during_execution)', () => {
    expect(replyFor('error_during_execution', undefined, '', true)).toBe('Stopped.');
  });
  it('hides error codes', () => {
    for (const s of ['error_during_execution', 'error_max_turns', 'error_max_budget_usd']) {
      const r = replyFor(s, undefined, 'half-done text', false);
      expect(r).not.toMatch(/error|_/i);
      expect(r).toMatch(/couldn't finish/);
    }
    expect(LOST_CONNECTION).not.toMatch(/claude|error|connect(ion)? to/i);
  });
});
