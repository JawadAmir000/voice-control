/** What the brain needs from whoever hosts it (the Electron app, or the text-only CLI). */
export type AgentStatus = 'idle' | 'listening' | 'thinking' | 'acting' | 'confirming' | 'error';

export interface Host {
  status(s: AgentStatus, detail?: string): void;
  /** Speak (and show) a short message to the user. */
  say(text: string): void;
  /** Ask the user an open question and wait for the answer. */
  ask(question: string): Promise<string>;
  /** Ask a yes/no question; resolves true only on a clear yes. */
  confirm(question: string): Promise<boolean>;
}
