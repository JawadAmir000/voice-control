import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Conversation, type Effects } from '../src/main/conversation.js';
import { isEcho, isGoodbye } from '../src/audio/wake.js';

/** Fake world: records what the conversation does; speech ends when we say so. */
function setup(overrides: Partial<ConstructorParameters<typeof Conversation>[1]> = {}) {
  const sent: string[] = [];
  const spoken: string[] = [];
  const ttsCmds: string[] = [];
  let finishSpeech: (() => void) | undefined;
  let reply = (t: string) => `Done: ${t}`;
  const fx: Effects = {
    status: () => {},
    ui: () => {},
    speak: (t) => { spoken.push(t); return new Promise((r) => (finishSpeech = r)); },
    tts: (c) => { ttsCmds.push(c); if (c === 'cancel') finishSpeech?.(); },
    mute: () => {},
    send: async (t) => { sent.push(t); return reply(t); },
    interrupt: async () => {},
    escapeKey: () => {},
    log: () => {},
  };
  const c = new Conversation(fx, {
    wakeWord: 'hey computer', wakeWordEnabled: true, conversation: true,
    followUpMs: 25_000, bargeIn: true, speak: true, settleMs: 700, ...overrides,
  });
  /** You say something: VAD on, VAD off, then Whisper's transcript. */
  const talk = (text: string) => { c.onSpeech(true); c.onSpeech(false); c.onText(text); };
  const endSpeech = async () => { finishSpeech?.(); finishSpeech = undefined; await vi.advanceTimersByTimeAsync(0); };
  return { c, sent, spoken, ttsCmds, talk, endSpeech, setReply: (f: typeof reply) => (reply = f) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('conversation mode', () => {
  it('keeps listening after a reply, so follow-ups need no wake word', async () => {
    const w = setup();
    w.talk('Hey computer, open Notepad');
    await vi.advanceTimersByTimeAsync(800);
    expect(w.sent).toEqual(['open Notepad']);
    await w.endSpeech();
    expect(w.c.mode).toBe('listening');

    w.talk('now type hello');
    await vi.advanceTimersByTimeAsync(800);
    expect(w.sent).toEqual(['open Notepad', 'now type hello']);
  });

  it('waits for you to finish when you pause mid-sentence', async () => {
    const w = setup();
    w.c.toggle(); // hotkey
    w.talk('open Claude and');
    await vi.advanceTimersByTimeAsync(400);
    w.c.onSpeech(true); // you carry on talking
    await vi.advanceTimersByTimeAsync(3000);
    expect(w.sent).toEqual([]);
    w.c.onSpeech(false);
    w.c.onText('start a new session');
    await vi.advanceTimersByTimeAsync(800);
    expect(w.sent).toEqual(['open Claude and start a new session']);
  });

  it('does not time out while you are still talking', async () => {
    const w = setup();
    w.c.toggle();
    w.c.onSpeech(true);
    await vi.advanceTimersByTimeAsync(60_000); // a very long sentence
    expect(w.c.mode).toBe('listening');
    w.c.onSpeech(false);
    w.c.onText('write down build things for me');
    await vi.advanceTimersByTimeAsync(800);
    expect(w.sent).toEqual(['write down build things for me']);
  });

  it('goes back to sleep after a silence, and on "that\'s all"', async () => {
    const w = setup();
    w.c.toggle();
    await vi.advanceTimersByTimeAsync(26_000);
    expect(w.c.mode).toBe('idle');

    w.c.toggle();
    w.talk("Thanks, that's all");
    expect(w.c.mode).toBe('idle');
    expect(w.sent).toEqual([]);
  });

  it('ignores normal speech while asleep', async () => {
    const w = setup();
    w.talk('I bought a new computer yesterday');
    await vi.advanceTimersByTimeAsync(2000);
    expect(w.sent).toEqual([]);
    expect(w.c.mode).toBe('idle');
  });

  it('with conversation mode off, sleeps after each reply', async () => {
    const w = setup({ conversation: false });
    w.talk('Hey computer, open Notepad');
    await vi.advanceTimersByTimeAsync(800);
    await w.endSpeech();
    expect(w.c.mode).toBe('idle');
  });
});

describe('interrupting the assistant', () => {
  it('stops speaking when you talk over it, and handles what you said', async () => {
    const w = setup();
    w.setReply(() => 'Here is a very long answer about many different things you did not ask for');
    w.talk('Hey computer, what is on my screen');
    await vi.advanceTimersByTimeAsync(800);
    expect(w.spoken.length).toBe(1);

    w.c.onSpeech(true);
    expect(w.ttsCmds).toEqual(['pause']); // goes quiet immediately
    w.c.onSpeech(false);
    w.c.onText('Stop, open Chrome instead');
    expect(w.ttsCmds).toEqual(['pause', 'cancel']);
    await vi.advanceTimersByTimeAsync(800);
    expect(w.sent.at(-1)).toBe('Stop, open Chrome instead');
  });

  it('resumes if it only heard its own voice', async () => {
    const w = setup();
    w.setReply(() => 'Notepad is open with your text');
    w.talk('Hey computer, open Notepad');
    await vi.advanceTimersByTimeAsync(800);
    w.c.onSpeech(true);
    w.c.onSpeech(false);
    w.c.onText('Notepad is open');
    expect(w.ttsCmds).toEqual(['pause', 'resume']);
    expect(w.sent).toEqual(['open Notepad']);
  });

  it('"stop" while it is working cancels the task', async () => {
    const w = setup();
    let release!: (v: string) => void;
    const c = w.c as unknown as { fx: Effects };
    const interrupt = vi.fn(async () => release('Stopped'));
    c.fx.send = () => new Promise((r) => (release = r));
    c.fx.interrupt = interrupt;
    w.talk('Hey computer, clean up my desktop');
    await vi.advanceTimersByTimeAsync(800);
    expect(w.c.mode).toBe('busy');
    w.talk('stop');
    await vi.advanceTimersByTimeAsync(10);
    expect(interrupt).toHaveBeenCalled();
    expect(w.c.mode).toBe('listening'); // still in the conversation
  });

  it('queues a new request said while it is working', async () => {
    const w = setup();
    let release!: (v: string) => void;
    (w.c as unknown as { fx: Effects }).fx.send = (t) => { w.sent.push(t); return new Promise((r) => (release = r)); };
    w.talk('Hey computer, open Notepad');
    await vi.advanceTimersByTimeAsync(800);
    w.talk('and then open Chrome');
    release('Done');
    await vi.advanceTimersByTimeAsync(10);
    await w.endSpeech();
    expect(w.sent).toEqual(['open Notepad', 'and then open Chrome']);
  });
});

describe('phrases', () => {
  it('detects goodbyes', () => {
    for (const t of ["That's all.", 'Thanks, bye!', 'stop listening', 'Okay, thank you, that is all', 'Go to sleep']) expect(isGoodbye(t)).toBe(true);
    for (const t of ['open the bye folder', 'say goodbye to Sam in Slack', 'thanks for opening Chrome, now type hi']) expect(isGoodbye(t)).toBe(false);
  });
  it('detects its own voice', () => {
    expect(isEcho('Notepad is open', 'Done, Notepad is open with your text.')).toBe(true);
    expect(isEcho('open Chrome instead', 'Done, Notepad is open with your text.')).toBe(false);
  });
});
