import { describe, expect, it } from 'vitest';
import { searchSql, sizeText } from '../src/win/files.js';

const HOME = 'C:\\Users\\me';
const NOW = new Date('2026-11-20T10:00:00Z');

describe('file search', () => {
  it('builds a Windows Search query', () => {
    const sql = searchSql({ name: 'budget 2026', extension: '.XLSX', days: 2 }, HOME, NOW);
    expect(sql).toContain("SCOPE='file:C:/Users/me'");
    expect(sql).toContain("System.FileName LIKE '%budget%'");
    expect(sql).toContain("System.FileName LIKE '%2026%'");
    expect(sql).toContain("System.FileExtension = '.xlsx'");
    expect(sql).toContain("System.DateModified >= '2026-11-18 10:00:00'");
    expect(sql).toMatch(/ORDER BY System.DateModified DESC$/);
  });

  it('cannot be broken out of with quotes or wildcards', () => {
    const sql = searchSql({ name: "x' OR 1=1 -- %_" }, HOME, NOW);
    expect(sql).toContain("LIKE '%x''%'");
    expect(sql).not.toMatch(/'%%'|'%_%'/);
  });

  it('can search inside documents and by kind', () => {
    const sql = searchSql({ name: 'invoice', kind: 'document', contents: true }, HOME, NOW);
    expect(sql).toContain(`(System.FileName LIKE '%invoice%' OR CONTAINS(*, '"invoice*"'))`);
    expect(sql).toContain("System.Kind = 'document'");
  });

  it('says sizes', () => {
    expect(sizeText(0)).toBe('');
    expect(sizeText(512)).toBe('512 B');
    expect(sizeText(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
});
