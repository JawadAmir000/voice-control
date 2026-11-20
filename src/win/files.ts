/**
 * Clipboard and file search.
 * Search uses the Windows Search index (fast, covers your whole user folder); if the index
 * isn't available it falls back to scanning your main folders.
 */
import os from 'node:os';
import { ps, psStr, runScript } from './ps.js';

const MAX_CLIP = 20_000;

export async function getClipboard(): Promise<string> {
  const t = await ps.run<string | null>('Out-Json (Get-Clipboard -Raw)');
  const s = typeof t === 'string' ? t : '';
  return s.length > MAX_CLIP ? `${s.slice(0, MAX_CLIP)}\n[clipboard truncated: ${s.length} characters in total]` : s;
}

export async function setClipboard(text: string): Promise<void> {
  await ps.run(`Set-Clipboard -Value ${psStr(text)}; Out-Json 'ok'`);
}

export type FileKind = 'document' | 'picture' | 'music' | 'video' | 'folder' | 'program' | 'any';
export type FileQuery = {
  /** Words in the file name ("budget 2026"); may be empty when kind/extension/days narrow it down. */
  name?: string;
  kind?: FileKind;
  /** ".pdf", "xlsx"… */
  extension?: string;
  /** Only things changed in the last N days. */
  days?: number;
  /** Also match words inside documents, not just the name. */
  contents?: boolean;
  max?: number;
};
export type FoundFile = { path: string; modified: string; size: number };

/** Escapes a value for a Windows Search SQL string, dropping LIKE wildcards. */
const sqlStr = (s: string) => s.replace(/['%_[\]]/g, (c) => (c === "'" ? "''" : ' ')).trim();

/** Builds the Windows Search query. Exported for tests. */
export function searchSql(q: FileQuery, home = os.homedir(), now = new Date()): string {
  const where = [`SCOPE='file:${home.replace(/\\/g, '/')}'`];
  for (const w of (q.name ?? '').split(/\s+/).map(sqlStr).filter(Boolean)) {
    where.push(q.contents ? `(System.FileName LIKE '%${w}%' OR CONTAINS(*, '"${w.replace(/"/g, '')}*"'))` : `System.FileName LIKE '%${w}%'`);
  }
  if (q.kind && q.kind !== 'any') where.push(`System.Kind = '${q.kind}'`);
  if (q.extension) where.push(`System.FileExtension = '.${sqlStr(q.extension.replace(/^\./, '').toLowerCase())}'`);
  if (q.days) {
    const since = new Date(now.getTime() - q.days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
    where.push(`System.DateModified >= '${since}'`);
  }
  // Skip app data, caches and hidden clutter.
  where.push(`NOT System.ItemPathDisplay LIKE '%\\AppData\\%'`, `NOT System.ItemPathDisplay LIKE '%\\node_modules\\%'`, `NOT System.ItemPathDisplay LIKE '%\\.git\\%'`);
  return `SELECT TOP ${Math.min(50, q.max ?? 20)} System.ItemPathDisplay, System.DateModified, System.Size FROM SystemIndex WHERE ${where.join(' AND ')} ORDER BY System.DateModified DESC`;
}

const KIND_EXT: Record<string, string[]> = {
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'rtf', 'odt'],
  picture: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'svg'],
  music: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'],
  video: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv'],
  program: ['exe', 'msi', 'lnk'],
};

/** Finds files and folders on this PC, newest first. */
export async function findFiles(q: FileQuery): Promise<{ files: FoundFile[]; via: 'index' | 'scan' }> {
  const indexed = await runScript(`
$c = New-Object -ComObject ADODB.Connection
$r = New-Object -ComObject ADODB.Recordset
$c.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
$r.Open(${psStr(searchSql(q))}, $c)
$out = @()
while (-not $r.EOF) {
  $d = $r.Fields.Item('System.DateModified').Value
  $out += @{ path = $r.Fields.Item('System.ItemPathDisplay').Value; modified = $(if ($d) { ([datetime]$d).ToString('s') } else { '' }); size = [int64]($r.Fields.Item('System.Size').Value) }
  $r.MoveNext()
}
$r.Close(); $c.Close()
[Console]::Out.WriteLine((ConvertTo-Json @($out) -Compress))`, 20_000);
  if (indexed.code === 0) {
    try {
      const files = JSON.parse(indexed.output.trim().split(/\r?\n/).pop() || '[]') as FoundFile[];
      // Nothing found may just mean your folders aren't indexed (Windows indexes only some by default).
      if (files.length) return { files, via: 'index' };
    } catch {
      /* fall through to a scan */
    }
  }
  return { files: await scan(q), via: 'scan' };
}

/** Slower fallback: walks Desktop, Documents, Downloads, Pictures, Music and Videos. */
async function scan(q: FileQuery): Promise<FoundFile[]> {
  const words = (q.name ?? '').split(/\s+/).filter(Boolean);
  const exts = q.extension ? [q.extension.replace(/^\./, '').toLowerCase()] : q.kind && KIND_EXT[q.kind] ? KIND_EXT[q.kind] : [];
  const since = q.days ? new Date(Date.now() - q.days * 86_400_000).toISOString() : '';
  const r = await runScript(`
$words = ConvertFrom-Json ${psStr(JSON.stringify(words))}
$exts = ConvertFrom-Json ${psStr(JSON.stringify(exts))}
$since = ${psStr(since)}
$dirs = 'Desktop','Documents','Downloads','Pictures','Music','Videos' | ForEach-Object { Join-Path $env:USERPROFILE $_ } | Where-Object { Test-Path $_ }
$items = Get-ChildItem -LiteralPath $dirs -Recurse -Depth 6 -Force -ErrorAction SilentlyContinue ${q.kind === 'folder' ? '-Directory' : ''} |
  Where-Object {
    $n = $_.Name
    (@($words | Where-Object { $n -notlike "*$_*" }).Count -eq 0) -and
    ($exts.Count -eq 0 -or $exts -contains $_.Extension.TrimStart('.').ToLower()) -and
    (-not $since -or $_.LastWriteTime -ge [datetime]$since) -and
    ($_.FullName -notmatch '\\\\(node_modules|\\.git)\\\\')
  } | Sort-Object LastWriteTime -Descending | Select-Object -First ${Math.min(50, q.max ?? 20)}
$out = @($items | ForEach-Object { @{ path = $_.FullName; modified = $_.LastWriteTime.ToString('s'); size = $(if ($_.PSIsContainer) { 0 } else { $_.Length }) } })
[Console]::Out.WriteLine((ConvertTo-Json @($out) -Compress))`, 45_000);
  try {
    return JSON.parse(r.output.trim().split(/\r?\n/).pop() || '[]') as FoundFile[];
  } catch {
    return [];
  }
}

/** "2.4 MB" */
export function sizeText(bytes: number): string {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
