import { describe, expect, it } from 'vitest';
import { DEFAULTS, cleanSettings } from '../src/config.js';

describe('settings from the Settings window', () => {
  const cur = { ...DEFAULTS, userName: 'Jawad' };

  it('keeps valid changes', () => {
    const next = cleanSettings({ userName: ' Ali ', bargeIn: false, followUpSeconds: 40, model: 'opus' }, cur);
    expect(next).toMatchObject({ userName: 'Ali', bargeIn: false, followUpSeconds: 40, model: 'opus' });
  });

  it('ignores unknown keys and wrong types', () => {
    const next = cleanSettings({ evil: 1, speak: 'yes', followUpSeconds: 'lots', sttModel: 'other', model: 'gpt' }, cur);
    expect(next).toEqual(cur);
  });

  it('keeps numbers in range and names non-empty', () => {
    const next = cleanSettings({ followUpSeconds: 9999, endOfSpeechMs: 10, ttsSpeed: 5, assistantName: '  ', hotkey: '' }, cur);
    expect(next).toMatchObject({ followUpSeconds: 300, endOfSpeechMs: 300, ttsSpeed: 2, assistantName: 'Nova', hotkey: DEFAULTS.hotkey });
  });
});
