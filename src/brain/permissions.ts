/**
 * Safety gate. Every tool call Claude makes passes through classify():
 *   allow   – runs straight away
 *   confirm – the user must say "yes" first
 *   deny    – never runs
 */
export type Verdict = { kind: 'allow' } | { kind: 'confirm'; reason: string } | { kind: 'deny'; reason: string };

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
      for (const [re, why] of DENY_SHELL) if (re.test(script)) return { kind: 'deny', reason: `Not allowed: ${why}.` };
      for (const [re, why] of CONFIRM_SHELL) if (re.test(script)) return { kind: 'confirm', reason: why };
      return { kind: 'allow' };
    }
    case 'type_text': {
      const text = String(input.text ?? '');
      if (looksLikeCard(text)) return { kind: 'deny', reason: 'That looks like a card number. Please type payment details yourself.' };
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
    case 'open': {
      const t = String(input.target ?? '');
      if (/\.(exe|msi|bat|cmd|ps1|vbs|js|scr)$/i.test(t) && !/^https?:/i.test(t)) return { kind: 'confirm', reason: `run the program ${t}` };
      return { kind: 'allow' };
    }
    default:
      if (toolName.startsWith('mcp__pc__')) return { kind: 'allow' };
      // Claude Code's own built-in tools (Bash, Write, ...) are switched off; refuse anything that slips through.
      return { kind: 'deny', reason: `Tool ${toolName} is not available in voice mode.` };
  }
}

/** Turns a tool call into a short sentence for the confirmation prompt. */
export function describe(toolName: string, input: Record<string, unknown>, reason: string): string {
  const why = typeof input.reason === 'string' && input.reason ? ` (${input.reason})` : '';
  return `I'm about to ${reason}${why}. Should I go ahead?`;
}
