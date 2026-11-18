import { query, type Query, type SDKUserMessage, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os';
import { pcServer } from '../tools/pc.js';
import { classify, describe } from './permissions.js';
import { systemPrompt } from './prompt.js';
import type { Host } from './host.js';

export type BrainOptions = { model?: string; log?: (...a: unknown[]) => void };

/** A simple async queue that feeds user messages into one long-lived Claude session. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter?: (v: IteratorResult<SDKUserMessage>) => void;
  private closed = false;
  push(text: string) {
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w({ value: msg, done: false }); }
    else this.items.push(msg);
  }
  close() { this.closed = true; this.waiter?.({ value: undefined, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => (this.waiter = r));
      },
    };
  }
}

/** The "brain": a Claude Agent SDK session that runs on the user's Claude subscription login. */
export class Brain {
  private inbox = new Inbox();
  private q?: Query;
  private busy = false;
  private onDone?: (reply: string) => void;
  private log: (...a: unknown[]) => void;

  constructor(private host: Host, private opts: BrainOptions = {}) {
    this.log = opts.log ?? (() => {});
  }

  get isBusy() { return this.busy; }

  start() {
    const env = { ...process.env };
    // Make sure the subscription login is used, not a stray API key.
    delete env.ANTHROPIC_API_KEY;
    delete env.ELECTRON_RUN_AS_NODE;

    const canUseTool: CanUseTool = async (toolName, input) => {
      const v = classify(toolName, input);
      this.log('tool', toolName, JSON.stringify(input).slice(0, 200), '→', v.kind);
      if (v.kind === 'allow') return { behavior: 'allow', updatedInput: input };
      if (v.kind === 'deny') {
        this.host.say(v.reason);
        return { behavior: 'deny', message: v.reason };
      }
      this.host.status('confirming', v.reason);
      const ok = await this.host.confirm(describe(toolName, input, v.reason));
      this.host.status(ok ? 'acting' : 'thinking');
      return ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user said no. Do not try this again unless they ask.' };
    };

    this.q = query({
      prompt: this.inbox,
      options: {
        model: this.opts.model ?? 'sonnet',
        systemPrompt: systemPrompt(),
        tools: [], // no built-in Claude Code tools; only our pc tools
        mcpServers: { pc: pcServer(this.host) },
        allowedTools: [],
        canUseTool,
        permissionMode: 'default',
        settingSources: [],
        persistSession: false,
        cwd: os.homedir(),
        env,
        stderr: (d) => this.log('[claude]', d.trim()),
      },
    });
    void this.loop();
  }

  private async loop() {
    let lastText = '';
    try {
      for await (const m of this.q!) {
        if (m.type === 'system' && m.subtype === 'init') {
          this.log('session ready, model', m.model, 'auth', (m as { apiKeySource?: string }).apiKeySource);
        } else if (m.type === 'assistant') {
          for (const block of m.message.content) {
            if (block.type === 'text' && block.text.trim()) lastText = block.text.trim();
            if (block.type === 'tool_use') this.host.status('acting', block.name.replace('mcp__pc__', ''));
          }
        } else if (m.type === 'result') {
          const reply = m.subtype === 'success' ? (m.result || lastText) : `Sorry, that failed: ${m.subtype}`;
          lastText = '';
          this.finish(reply.trim());
        }
      }
    } catch (e) {
      this.log('session error', e);
      this.host.status('error', (e as Error).message);
      this.finish(`Sorry, my connection to Claude broke: ${(e as Error).message}`);
      // Restart a fresh session so the next command works.
      this.inbox = new Inbox();
      this.q = undefined; // the next send() starts a fresh session
    }
  }

  private finish(reply: string) {
    this.busy = false;
    const cb = this.onDone;
    this.onDone = undefined;
    cb?.(reply);
  }

  /** Sends a spoken command; resolves with Claude's final (short) reply. */
  send(text: string): Promise<string> {
    if (!this.q) this.start();
    this.busy = true;
    this.host.status('thinking', text);
    return new Promise((resolve) => {
      this.onDone = resolve;
      this.inbox.push(text);
    });
  }

  /** Stops whatever Claude is doing right now. */
  async interrupt() {
    if (!this.busy) return;
    this.log('interrupt');
    await this.q?.interrupt().catch(() => {});
  }

  stop() {
    this.inbox.close();
    this.q?.close?.();
  }
}
