/**
 * Safety gate. Every tool call Claude makes passes through classify():
 *   allow   – runs straight away
 *   confirm – the user must say "yes" first
 *   deny    – never runs
 */
/** `spoken` on a deny is a plain-words message for the user; without it the refusal is silent (only Claude is told). */
export type Verdict = { kind: 'allow' } | { kind: 'confirm'; reason: string } | { kind: 'deny'; reason: string; spoken?: string };

/** Connector actions that change or send something on your behalf: these need a spoken "yes". */
const RISKY_CONNECTOR_ACTION = /(^|_)(send|forward|reply|delete|trash|remove|spam|share|invite|publish|post|purchase|buy|pay|transfer|upload|apply|submit|cancel|unsubscribe)(_|$)/i;

/** "mcp__claude_ai_Gmail__send_message" → { service: "Gmail", action: "send message" } */
export function describeConnectorTool(toolName: string): { service: string; action: string } {
  const parts = toolName.split('__');
  const service = (parts[1] ?? '').replace(/^claude_ai_/i, '').replace(/[_-]+/g, ' ').trim() || 'that app';
  const action = (parts.slice(2).join(' ') || 'do that').replace(/[_-]+/g, ' ').trim();
  return { service, action };
}

const DENY_SHELL: [RegExp, string][] = [
  [/Set-MpPreference|Add-MpPreference.*Exclusion|DisableRealtimeMonitoring/i, 'changing Windows Defender'],
  [/netsh\s+(adv)?firewall|Set-NetFirewallProfile|Disable-NetFirewall/i, 'changing the firewall'],
  [/\bbcdedit\b|\bdiskpart\b|Format-Volume|\bformat\s+[a-z]:/i, 'disk / boot configuration'],
  [/Set-ExecutionPolicy|Disable-WindowsOptionalFeature.*Defender|\bUAC\b|EnableLUA/i, 'security settings'],
  [/Get-Credential|ConvertFrom-SecureString|\bcmdkey\b|vaultcmd|Login Data|Cookies/i, 'reading saved passwords or credentials'],
];

const CONFIRM_SHELL: [RegExp, string][] = [
  [/\b(Remove-Item|rm|rmdir|rd|del|erase|Clear-Content|Clear-RecycleBin)\b/i, 'delete files'],
  [/\b(Move-Item|mv|move|Rename-Item|ren)\b/i, 'move or rename files'],
  [/\b(Copy-Item|cp|copy|xcopy|robocopy)\b.*\s-?(Force|\/MIR|\/PURGE)/i, 'overwrite files'],
  [/Set-Content|Out-File|Add-Content|(?<![0-9])>{1,2}\s*(?!\$null|&)[^\s|]/i, 'write to a file'],
  [/Stop-Computer|Restart-Computer|\bshutdown\b|logoff|Lock-Computer|rundll32.*LockWorkStation/i, 'shut down, restart or sign out'],
  [/Stop-Process|\btaskkill\b|\bkill\b/i, 'force-close programs'],
  [/\b(winget|choco|scoop|msiexec|npm\s+i(nstall)?\s+-g|pip\s+install)\b|Install-|Uninstall-/i, 'install or uninstall software'],
  [/HKLM:|HKCU:|\breg(\.exe)?\s+(add|delete|import)|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty/i, 'change the registry / system settings'],
  [/Set-Service|Stop-Service|New-Service|sc\.exe|Register-ScheduledTask|schtasks/i, 'change services or scheduled tasks'],
  [/Send-MailMessage|Invoke-(WebRequest|RestMethod)\s.*-Method\s+(Post|Put|Delete)/i, 'send data over the internet'],
  [/Invoke-WebRequest|\bcurl\b|\bwget\b|Start-BitsTransfer|DownloadFile/i, 'download something from the internet'],
  [/\bgit\s+(push|reset\s+--hard|clean)/i, 'change a git repository'],
];

const RISKY_BUTTON = /\b(send|submit|post|publish|buy|purchase|pay|checkout|place order|order now|delete|remove|uninstall|erase|format|transfer|confirm payment|sign out|log ?out)\b/i;

const MAX_FACT = 300;
/** Remembered "facts" that are really orders to Claude: possible injected instructions. */
const INSTRUCTION_LIKE = /\b(ignore|disregard|override|always|never|must|should|don'?t (ask|tell|confirm)|without (asking|confirm\w*|telling)|instructions?|system prompt|prompt|forward|send|email (everything|all)|transfer|pay|download|run|execute|install|delete|password|https?:\/\/|www\.)/i;

/** Luhn check, to spot card numbers being typed. */
function looksLikeCard(text: string): boolean {
  for (const m of text.match(/\b(?:\d[ -]?){13,19}\b/g) ?? []) {
    const d = m.replace(/\D/g, '');
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = Number(d[d.length - 1 - i]);
      if (i % 2) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

export function classify(toolName: string, input: Record<string, unknown>): Verdict {
  const name = toolName.replace(/^mcp__pc__/, '');
  switch (name) {
    case 'run_powershell': {
      const script = String(input.script ?? '');
      for (const [re, why] of DENY_SHELL) if (re.test(script)) return { kind: 'deny', reason: `Not allowed: ${why}.`, spoken: `Sorry, I'm not allowed to do that: ${why}.` };
      for (const [re, why] of CONFIRM_SHELL) if (re.test(script)) return { kind: 'confirm', reason: why };
      return { kind: 'allow' };
    }
    case 'type_text': {
      const text = String(input.text ?? '');
      if (looksLikeCard(text)) return { kind: 'deny', reason: 'That looks like a card number. Ask the user to type payment details themselves.', spoken: 'That looks like a card number, so please type payment details yourself.' };
      return { kind: 'allow' };
    }
    case 'click_element': {
      const el = String(input.name ?? '');
      if (RISKY_BUTTON.test(el)) return { kind: 'confirm', reason: `click "${el}"` };
      return { kind: 'allow' };
    }
    case 'window': {
      return { kind: 'allow' };
    }
    case 'remember': {
      const fact = String(input.fact ?? '');
      if (looksLikeCard(fact) || /\b(password|passcode|pin( code)?|cvv|security code|secret|api key|token)\b/i.test(fact))
        return { kind: 'deny', reason: 'Never store passwords, card numbers or other secrets in memory.', spoken: "I'd rather not keep passwords or card details, so I didn't save that." };
      if (fact.length > MAX_FACT) return { kind: 'deny', reason: `Facts must be short (under ${MAX_FACT} characters). Save one short fact.` };
      // Memory goes into every future session, so a "fact" that reads like an instruction could have
      // been planted by a web page, email or document Claude read. The user hears it and decides.
      if (INSTRUCTION_LIKE.test(fact)) return { kind: 'confirm', reason: `remember "${fact}" for future conversations` };
      return { kind: 'allow' };
    }
    case 'forget': {
      const about = String(input.about ?? '').trim().toLowerCase();
      if (['*', 'all', 'everything'].includes(about)) return { kind: 'confirm', reason: 'forget everything I remember about you' };
      return { kind: 'allow' };
    }
    case 'save_routine': {
      // Routines run later from a single phrase: the user approves exactly what was saved.
      const steps = Array.isArray(input.steps) ? input.steps.map(String) : [];
      return { kind: 'confirm', reason: `save a routine "${String(input.name ?? '')}" that does: ${steps.join(', then ')}` };
    }
    case 'cancel_reminder': {
      const about = String(input.about ?? '').trim().toLowerCase();
      if (['*', 'all', 'everything', ''].includes(about)) return { kind: 'confirm', reason: 'cancel all your reminders and timers' };
      return { kind: 'allow' };
    }
    case 'open': {
      const t = String(input.target ?? '');
      if (/\.(exe|msi|bat|cmd|ps1|vbs|js|scr)$/i.test(t) && !/^https?:/i.test(t)) return { kind: 'confirm', reason: `run the program ${t}` };
      return { kind: 'allow' };
    }
    default: {
      if (toolName.startsWith('mcp__pc__')) return { kind: 'allow' };
      if (toolName.startsWith('mcp__')) {
        // Your connected accounts (Gmail, etc.): reading, searching and drafting are fine;
        // anything that sends, deletes or acts on your behalf needs a yes.
        const { service, action } = describeConnectorTool(toolName);
        if (RISKY_CONNECTOR_ACTION.test(toolName.split('__').slice(2).join('_'))) return { kind: 'confirm', reason: `${action} in ${service}` };
        return { kind: 'allow' };
      }
      // Claude Code's own built-in tools (Bash, Write, ...) are switched off; refuse quietly if one slips through.
      return { kind: 'deny', reason: `Tool ${toolName} is not available here; use the pc tools instead.` };
    }
  }
}

/** Turns a tool call into a short sentence for the confirmation prompt. */
export function describe(toolName: string, input: Record<string, unknown>, reason: string): string {
  const why = typeof input.reason === 'string' && input.reason ? ` (${input.reason})` : '';
  // For emails and messages, say who it goes to ("send message in Gmail to xylon@…").
  const toRaw = input.to ?? input.recipient ?? input.recipients;
  const to = Array.isArray(toRaw) ? toRaw.join(', ') : typeof toRaw === 'string' ? toRaw : '';
  return `I'm about to ${reason}${to ? ` to ${to}` : ''}${why}. Should I go ahead?`;
}
