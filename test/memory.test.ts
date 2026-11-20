import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Memory } from '../src/brain/memory.js';
import { classify } from '../src/brain/permissions.js';
import { systemPrompt } from '../src/brain/prompt.js';

const tmpFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'nova-mem-')), 'memory.json');

describe('memory', () => {
  it('keeps facts across restarts', () => {
    const file = tmpFile();
    new Memory(file).add('Their manager is Sara Khan');
    const again = new Memory(file);
    expect(again.list().map((f) => f.text)).toEqual(['Their manager is Sara Khan']);
    expect(again.promptSection()).toContain('- Their manager is Sara Khan');
  });

  it('does not store the same fact twice', () => {
    const m = new Memory();
    m.add('Prefers Chrome');
    m.add('prefers chrome');
    expect(m.list()).toHaveLength(1);
  });

  it('forgets by description, or everything', () => {
    const m = new Memory();
    m.add('Their manager is Sara Khan');
    m.add('Project folder is D:\\Work\\Nova');
    expect(m.forget('manager')).toEqual(['Their manager is Sara Khan']);
    expect(m.forget('the dentist')).toEqual([]);
    expect(m.list()).toHaveLength(1);
    m.forget('everything');
    expect(m.list()).toEqual([]);
    expect(m.promptSection()).toBe('');
  });

  it('keeps edits made to the file by hand', () => {
    const file = tmpFile();
    const m = new Memory(file);
    m.add('Likes dark mode');
    writeFileSync(file, JSON.stringify([{ text: 'Likes light mode', at: '2026-01-01T00:00:00Z' }]));
    m.add('Works at Acme');
    expect(JSON.parse(readFileSync(file, 'utf8')).map((f: { text: string }) => f.text)).toEqual(['Likes light mode', 'Works at Acme']);
  });

  it('is part of the instructions Claude gets', () => {
    const m = new Memory();
    m.add('Their wife is called Ayesha');
    expect(systemPrompt('Jawad', 'Nova', m.promptSection())).toContain('Their wife is called Ayesha');
  });

  it('never stores secrets', () => {
    expect(classify('mcp__pc__remember', { fact: 'Their Gmail password is hunter2' }).kind).toBe('deny');
    expect(classify('mcp__pc__remember', { fact: 'Card 4111 1111 1111 1111' }).kind).toBe('deny');
    expect(classify('mcp__pc__remember', { fact: 'Their manager is Sara' }).kind).toBe('allow');
  });
});
