import { describe, expect, it } from 'vitest';
import { classify } from '../src/brain/permissions.js';
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
