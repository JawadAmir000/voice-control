import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Conversation, type Effects } from '../src/main/conversation.js';
import { isEcho, isGoodbye, stripEcho } from '../src/audio/wake.js';

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

  it('still runs your request when background noise follows it (real log: "(buzzing)")', async () => {
    const w = setup();
    w.c.toggle();
    w.talk('go to the browser and open YouTube and play a song');
    w.talk(''); // Whisper heard only "(buzzing)" before the 1 s wait finished
    await vi.advanceTimersByTimeAsync(800);
    expect(w.sent).toEqual(['go to the browser and open YouTube and play a song']);
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
    expect(w.ttsCmds).toEqual([]); // keeps talking until it knows it's really you (no stutter)
    w.c.onSpeech(false);
    w.c.onText('Stop, open Chrome instead');
    expect(w.ttsCmds).toEqual(['cancel']);
    await vi.advanceTimersByTimeAsync(800);
    expect(w.sent.at(-1)).toBe('Stop, open Chrome instead');
  });

  it('never pauses or interrupts itself on its own voice (speakers → mic)', async () => {
    const w = setup();
    const reply = 'I can run your PC by voice: open apps, websites, folders and settings pages, type text, click through windows, and manage files.';
    w.setReply(() => reply);
    w.talk('Hey computer, what can you do');
    await vi.advanceTimersByTimeAsync(800);
    // Real fragments Whisper produced from the speakers in the user's log:
    for (const f of ['and run your PC by', 'voice open.', 'apps websites', '', 'type', 'text', 'through Windows and', 'manage files', 'two']) w.talk(f);
    expect(w.ttsCmds).toEqual([]);
    expect(w.sent).toEqual(['what can you do']);
  });

  it('does not answer the tail of its own sentence after it stops talking', async () => {
    const w = setup();
    w.setReply(() => 'Just tell me what you would like to do first.');
    w.talk('Hey computer, help');
    await vi.advanceTimersByTimeAsync(800);
    w.c.onSpeech(true); // echo of the last words starts while still speaking…
    await w.endSpeech(); // …voice ends…
    w.c.onSpeech(false);
    w.c.onText('like to do first.'); // …and the transcript arrives afterwards
    await vi.advanceTimersByTimeAsync(1000);
    w.talk('do'); // a late fragment right after
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.sent).toEqual(['help']);
    expect(w.c.mode).toBe('listening');
  });

  it('answers a question you asked while its echo was still playing', async () => {
    const w = setup();
    w.setReply(() => 'Doing well, thanks for asking! Ready to help with anything on your PC.');
    w.talk('Hey computer, how are you');
    await vi.advanceTimersByTimeAsync(800);
    w.c.onSpeech(true);
    await w.endSpeech();
    w.c.onSpeech(false);
    w.c.onText('doing well. Thanks for asking. Ready to help with anything on your PC. Which model are you using?');
    await vi.advanceTimersByTimeAsync(800);
    expect(w.sent).toEqual(['how are you', 'Which model are you using?']);
  });

  it('still hears you right after it finishes talking', async () => {
    const w = setup();
    w.setReply(() => 'Notepad is open.');
    w.talk('Hey computer, open Notepad');
    await vi.advanceTimersByTimeAsync(800);
    await w.endSpeech();
    w.talk('now type my shopping list'); // within the echo window, but clearly you
    await vi.advanceTimersByTimeAsync(800);
    expect(w.sent).toEqual(['open Notepad', 'now type my shopping list']);
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
  it('keeps your words when they are recorded together with its echo (real log)', () => {
    expect(stripEcho(
      'doing well. Thanks for asking. Ready to help with anything on your PC. So what is your brain right now? I need to move which kind of model you are using.',
      'Doing well, thanks for asking! Ready to help with anything on your PC.',
    )).toBe('So what is your brain right now? I need to move which kind of model you are using.');
    expect(stripEcho(
      'Yes, I can hear you loud and clear. I asked what would you like me to do? Yeah, I asked you...',
      'Yes, I can hear you loud and clear. What would you like me to do?',
    )).toBe('I asked what would you like me to do? Yeah, I asked you...');
    // pure echo, fragments, and your own command that happens to share a word
    expect(stripEcho('Notepad is open', 'Done, Notepad is open with your text.')).toBe('');
    expect(stripEcho('and run your PC by', 'I can run your PC by voice: open apps and manage files.')).toBe('');
    expect(stripEcho('do', 'Just tell me what you would like to do first.')).toBe('');
    expect(stripEcho('open Chrome instead', 'Done, Notepad is open with your text.')).toBe('open Chrome instead');
  });

  it('detects its own voice', () => {
    expect(isEcho('Notepad is open', 'Done, Notepad is open with your text.')).toBe(true);
    expect(isEcho('open Chrome instead', 'Done, Notepad is open with your text.')).toBe(false);
  });
});

describe('personal greeting', () => {
  beforeEach(() => vi.useFakeTimers());
  it('"Hello computer" gets an instant introduction by name, without asking Claude', async () => {
    const w = setup({ userName: 'Jawad' });
    w.talk('Hello computer');
    await vi.advanceTimersByTimeAsync(10);
    expect(w.sent).toEqual([]);
    expect(w.spoken[0]).toMatch(/Jawad! I'm your personal AI assistant/);
    await w.endSpeech();
    expect(w.c.mode).toBe('listening');
  });
  it('a bare "Hey computer" only wakes it', async () => {
    const w = setup({ userName: 'Jawad' });
    w.talk('Hey computer');
    await vi.advanceTimersByTimeAsync(10);
    expect(w.spoken).toEqual([]);
    expect(w.c.mode).toBe('listening');
  });
  it('"hello" in the middle of a conversation also greets', async () => {
    const w = setup({ userName: 'Jawad' });
    w.c.toggle();
    w.talk('hello');
    await vi.advanceTimersByTimeAsync(1100);
    expect(w.spoken[0]).toMatch(/Jawad/);
    expect(w.sent).toEqual([]);
  });
});

describe('late echoes (slow transcription, real log)', () => {
  beforeEach(() => vi.useFakeTimers());
  it('ignores the echo of an EARLIER reply that arrives while it speaks the next one', async () => {
    const w = setup();
    const replies = [
      "I couldn't find a clear match on YouTube. Both times I asked, the microphone picked up my own voice instead of yours, so please tell me the artist.",
      "Jawad, the mic keeps hearing my own voice instead of yours, so I can't get the song name.",
    ];
    let n = 0;
    w.setReply(() => replies[n++]);
    w.talk('Hey computer, play Hudulaya on YouTube');
    await vi.advanceTimersByTimeAsync(1100);
    w.c.onSpeech(true); w.c.onSpeech(false); // echo of reply 1 recorded…
    await w.endSpeech();
    w.talk('try again please'); // you
    await vi.advanceTimersByTimeAsync(1100); // reply 2 is now playing
    w.c.onText('Both times I asked, the microphone picked up my own voice instead of yours, so please tell me the artist.'); // …transcribed late
    expect(w.ttsCmds).toEqual([]); // not taken as an interruption
    expect(w.sent).toEqual(['play Hudulaya on YouTube', 'try again please']);
  });
});

import { sentences } from '../src/audio/sentences.js';
describe('voice sentence splitting', () => {
  it('splits into sentences and breaks very long ones at commas', () => {
    expect(sentences("Hi, Jawad! I'm your assistant. How can I help?")).toEqual(['Hi, Jawad!', "I'm your assistant.", 'How can I help?']);
    const long = sentences('I can open programs and sites, draft and type text, find and tidy your files, run whole tasks on your PC, check your email, organize your downloads folder, and much more for you today');
    expect(long.length).toBeGreaterThan(1);
    expect(long.every((p) => p.length <= 180)).toBe(true);
    expect(sentences('')).toEqual([]);
  });
});

describe('greeting wakes it', () => {
  beforeEach(() => vi.useFakeTimers());
  it('a plain "Hello." (no wake word) wakes it and introduces itself (real log)', async () => {
    const w = setup({ userName: 'Jawad' });
    w.talk('Hello.');
    await vi.advanceTimersByTimeAsync(10);
    expect(w.spoken[0]).toMatch(/Jawad! I'm your personal AI assistant/);
    await w.endSpeech();
    expect(w.c.mode).toBe('listening'); // and keeps listening for your request
  });
  it('background speech still does not wake it', async () => {
    const w = setup({ userName: 'Jawad' });
    w.talk('In other words, they need to be secured to');
    w.talk('hello and welcome back to the channel everyone');
    await vi.advanceTimersByTimeAsync(2000);
    expect(w.spoken).toEqual([]);
    expect(w.c.mode).toBe('idle');
  });
});

describe('waking while a video plays', () => {
  beforeEach(() => vi.useFakeTimers());
  const video = 'I have to try my certain things. I have to try my certain things. We have to be fine, fine and fine.';
  it('finds "Hey computer" after video speech and runs the command', async () => {
    const w = setup();
    w.talk(`${video} Hey computer, open Notepad.`);
    await vi.advanceTimersByTimeAsync(1100);
    expect(w.sent).toEqual(['open Notepad.']);
  });
  it('a "Hello" at the end of a video clip wakes it and greets', async () => {
    const w = setup({ userName: 'Jawad' });
    w.talk(`${video} Hello.`);
    await vi.advanceTimersByTimeAsync(10);
    expect(w.spoken[0]).toMatch(/Jawad! I'm your personal AI assistant/);
  });
  it('video speech alone, or "computer" mid-sentence, does not wake it', async () => {
    const w = setup({ userName: 'Jawad' });
    w.talk(video);
    w.talk('My computer is slow. I bought a new computer yesterday and it is great.');
    w.talk('Hello everyone and welcome back to the channel. Today we will talk about AI.');
    await vi.advanceTimersByTimeAsync(2000);
    expect(w.spoken).toEqual([]);
    expect(w.sent).toEqual([]);
    expect(w.c.mode).toBe('idle');
  });
});

describe('Nova', () => {
  beforeEach(() => vi.useFakeTimers());
  const nova = { userName: 'Jawad', assistantName: 'Nova', wakeWord: 'hey nova, hey computer' };
  it('"Hello Nova" wakes her and she introduces herself by name', async () => {
    const w = setup(nova);
    w.talk('Hello Nova.');
    await vi.advanceTimersByTimeAsync(10);
    expect(w.spoken[0]).toMatch(/Jawad! I'm Nova, your personal AI assistant\./);
    expect(w.sent).toEqual([]);
  });
  it('understands common mishearings ("Hello Noah") and the old wake word', async () => {
    const a = setup(nova);
    a.talk('Hello Noah');
    await vi.advanceTimersByTimeAsync(10);
    expect(a.spoken[0]).toMatch(/I'm Nova/);
    const b = setup(nova);
    b.talk('Hey computer, open Notepad');
    await vi.advanceTimersByTimeAsync(1100);
    expect(b.sent).toEqual(['open Notepad']);
  });
  it('"Hey Nova, open YouTube" runs the command; a bare "Hey Nova" just wakes her', async () => {
    const w = setup(nova);
    w.talk('Hey Nova, open YouTube');
    await vi.advanceTimersByTimeAsync(1100);
    expect(w.sent).toEqual(['open YouTube']);
    const q = setup(nova);
    q.talk('Hey Nova');
    await vi.advanceTimersByTimeAsync(10);
    expect(q.spoken).toEqual([]);
    expect(q.c.mode).toBe('listening');
  });
  it('the name in normal speech does not wake her', async () => {
    const w = setup(nova);
    w.talk('We watched a documentary about a nova in space last night.');
    await vi.advanceTimersByTimeAsync(1100);
    expect(w.spoken).toEqual([]);
    expect(w.c.mode).toBe('idle');
  });
});

describe('Nova mishearings (real log)', () => {
  beforeEach(() => vi.useFakeTimers());
  const nova = { userName: 'Jawad', assistantName: 'Nova', wakeWord: 'hey nova, hey computer' };
  it('"Hello, no bad" (Whisper splitting "Nova") wakes her', async () => {
    const w = setup(nova);
    w.talk('Hello, no bad');
    await vi.advanceTimersByTimeAsync(10);
    expect(w.c.mode).not.toBe('idle');
  });
  it('"Hey Noba, open Chrome" runs the command', async () => {
    const w = setup(nova);
    w.talk('Hey Noba, open Chrome');
    await vi.advanceTimersByTimeAsync(1100);
    expect(w.sent).toEqual(['open Chrome']);
  });
  it('ordinary replies like "Hello, no thanks" or "Hi, nobody is home" do not', async () => {
    const w = setup(nova);
    w.talk('Hello, no thanks.');
    w.talk('Hi, nobody is home right now.');
    w.talk('No bad news today.');
    await vi.advanceTimersByTimeAsync(1100);
    expect(w.sent).toEqual([]);
    expect(w.c.mode).toBe('idle');
  });
});

import { matchWake as wakeMatch } from '../src/audio/wake.js';
describe('greeting glued to the name (Parakeet, real log)', () => {
  const W = 'hey nova, hey computer';
  it('wakes on "Hanova." and friends', () => {
    for (const t of ['Hanova.', 'Heynova.', 'Hinova!', 'Ehnova.', 'Henova', 'Heynoah.', 'Hellonova.'])
      expect(wakeMatch(t, W).woke, t).toBe(true);
  });
  it('keeps the command', () => {
    expect(wakeMatch('Hanova, open Notepad.', W)).toEqual({ woke: true, rest: 'open Notepad.' });
  });
  it('ignores ordinary words', () => {
    for (const t of ['Another one.', 'Enough of that.', 'Announce it.', 'Anomaly detected.', 'Honestly no.', 'Hello there.', 'Have a nice day.'])
      expect(wakeMatch(t, W).woke, t).toBe(false);
  });
});

describe('whole-clip mishearings of "Hey Nova" (Parakeet, real log)', () => {
  const W = 'hey nova, hey computer';
  it('wakes on "And over." alone', () => {
    for (const t of ['And over.', 'An over.', 'Hand over!', 'Hanover.', 'And Nova.'])
      expect(wakeMatch(t, W).woke, t).toBe(true);
  });
  it('not inside a real sentence', () => {
    for (const t of ['Hand over the file.', 'And over there.', 'Game over.', 'Over.'])
      expect(wakeMatch(t, W).woke, t).toBe(false);
  });
});

describe('sound-alike names after a greeting (Parakeet, real log)', () => {
  const W = 'hey nova, hey computer';
  it('"Hi Lopa, can you hear me?" wakes Nova', () => {
    expect(wakeMatch('Hi Lopa, can you hear me?', W)).toEqual({ woke: true, rest: 'can you hear me?' });
    for (const t of ['Hey Noba.', 'Hello Mova.', 'Hey Lova.', 'Hi Nopa.'])
      expect(wakeMatch(t, W).woke, t).toBe(true);
  });
  it('other names after a greeting do not', () => {
    for (const t of ['Hi Laura.', 'Hey Mom.', 'Hello Lisa.', 'Hi Bob.', 'Hey Sarah, come here.', 'Hi Mark.'])
      expect(wakeMatch(t, W).woke, t).toBe(false);
  });
});

import { parseVocab, tokenize, wakeKeywords } from '../src/audio/kws.js';
describe('wake-word listener', () => {
  const nova = { wakeWord: 'hey nova, hey computer', assistantName: 'Nova', userName: 'Jawad' };
  /** The listener fires mid-clip; the clip's transcript then holds only what came after. */
  const spotted = (s: ReturnType<typeof setup>, phrase: string, after: string) => {
    s.c.onSpeech(true); s.c.onKeyword(phrase); s.c.onSpeech(false); s.c.onText(after, true);
  };
  it('"Hey Nova, open Notepad" runs just the command', async () => {
    const s = setup(nova);
    spotted(s, 'hey nova', 'open Notepad.');
    expect(s.c.mode).toBe('listening');
    await vi.advanceTimersByTimeAsync(800);
    expect(s.sent).toEqual(['open Notepad.']);
  });
  it('"Hey Nova" alone wakes and waits for the command', async () => {
    const s = setup(nova);
    spotted(s, 'hey nova', '');
    expect(s.c.mode).toBe('listening');
    s.talk('What time is it?');
    await vi.advanceTimersByTimeAsync(800);
    expect(s.sent).toEqual(['What time is it?']);
  });
  it('"Hello Nova" alone still gets the introduction (no Claude call)', async () => {
    const s = setup(nova);
    spotted(s, 'hello nova', '');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.sent).toEqual([]);
    expect(s.spoken[0]).toMatch(/I'm Nova/);
  });
  it('its own voice saying its name does not wake it or leak in as a command', async () => {
    const s = setup(nova);
    s.c.wake();
    s.talk('open Notepad');
    await vi.advanceTimersByTimeAsync(800); // now speaking "Done: open Notepad"
    s.c.onSpeech(true); s.c.onKeyword('hi nova'); s.c.onSpeech(false);
    s.c.onText('Done: open Notepad', true);
    await s.endSpeech();
    expect(s.sent).toEqual(['open Notepad']);
  });
  it('ignored while paused', () => {
    const s = setup(nova);
    s.c.setPaused(true);
    s.c.onKeyword('hey nova');
    expect(s.c.mode).toBe('idle');
  });
  it('builds keyword lines from the model vocabulary', () => {
    const vocab = parseVocab('▁HE 1\nY 2\n▁NO 3\nV 4\nA 5\n▁HI 6\nLL 7\nO 8\n▁OKAY 9\n');
    expect(tokenize('Nova', vocab)).toEqual(['▁NO', 'V', 'A']);
    expect(wakeKeywords('Nova', vocab)).toEqual(['▁HE Y ▁NO V A @hey_nova', '▁HI ▁NO V A @hi_nova', '▁HE LL O ▁NO V A @hello_nova', '▁OKAY ▁NO V A @okay_nova']);
    expect(tokenize('Zed', vocab)).toBeUndefined();
  });
});
