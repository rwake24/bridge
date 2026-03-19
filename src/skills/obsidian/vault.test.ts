import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ObsidianConfig } from '../../types.js';
import {
  parseNoteFrontmatter,
  buildNoteFrontmatter,
  readNote,
  writeNote,
  appendNote,
  searchNotes,
  listNotes,
  buildMeetingNotePath,
  buildAccountNotePath,
  buildAutoTags,
} from './vault.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeTmpVault(): { dir: string; cfg: ObsidianConfig } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-vault-test-'));
  const cfg: ObsidianConfig = { vaultPath: dir };
  return { dir, cfg };
}

function cleanupTmpVault(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── parseNoteFrontmatter ──────────────────────────────────────────────────────

describe('parseNoteFrontmatter', () => {
  it('returns empty frontmatter when there is no YAML block', () => {
    const { frontmatter, body } = parseNoteFrontmatter('# Hello\n\nWorld');
    expect(frontmatter).toEqual({});
    expect(body).toBe('# Hello\n\nWorld');
  });

  it('parses simple key-value pairs', () => {
    const content = '---\naccount: Orrick\ntype: meeting\n---\n# Body';
    const { frontmatter, body } = parseNoteFrontmatter(content);
    expect(frontmatter.account).toBe('Orrick');
    expect(frontmatter.type).toBe('meeting');
    expect(body).toBe('# Body');
  });

  it('parses inline YAML arrays', () => {
    const content = '---\ntags: [account/orrick, type/meeting]\n---\n';
    const { frontmatter } = parseNoteFrontmatter(content);
    expect(frontmatter.tags).toEqual(['account/orrick', 'type/meeting']);
  });

  it('strips surrounding quotes from values', () => {
    const content = '---\naccount: "Reed Smith"\n---\n';
    const { frontmatter } = parseNoteFrontmatter(content);
    expect(frontmatter.account).toBe('Reed Smith');
  });

  it('ignores YAML comment lines', () => {
    const content = '---\n# this is a comment\naccount: Acme\n---\n';
    const { frontmatter } = parseNoteFrontmatter(content);
    expect(frontmatter.account).toBe('Acme');
    expect(frontmatter['# this is a comment']).toBeUndefined();
  });

  it('handles CRLF line endings', () => {
    const content = '---\r\naccount: Acme\r\n---\r\n# Body';
    const { frontmatter, body } = parseNoteFrontmatter(content);
    expect(frontmatter.account).toBe('Acme');
    expect(body).toBe('# Body');
  });
});

// ── buildNoteFrontmatter ──────────────────────────────────────────────────────

describe('buildNoteFrontmatter', () => {
  it('produces a valid YAML block with simple fields', () => {
    const result = buildNoteFrontmatter({ account: 'Orrick', type: 'meeting' });
    expect(result).toContain('---\n');
    expect(result).toContain('account: Orrick');
    expect(result).toContain('type: meeting');
    expect(result).toMatch(/---\n$/);
  });

  it('serializes array fields as inline YAML', () => {
    const result = buildNoteFrontmatter({ tags: ['account/orrick', 'type/meeting'] });
    expect(result).toContain('tags: ["account/orrick", "type/meeting"]');
  });

  it('skips undefined and null values', () => {
    const result = buildNoteFrontmatter({ account: 'Orrick', motion: undefined });
    expect(result).not.toContain('motion');
  });
});

// ── readNote / writeNote ──────────────────────────────────────────────────────

describe('readNote / writeNote', () => {
  let dir: string;
  let cfg: ObsidianConfig;

  beforeEach(() => {
    ({ dir, cfg } = makeTmpVault());
  });

  afterEach(() => {
    cleanupTmpVault(dir);
  });

  it('writes and reads a note', () => {
    writeNote(cfg, 'Accounts/Orrick.md', '# Orrick\n\nLaw firm.', {
      frontmatter: { account: 'Orrick', type: 'account' },
    });
    const result = readNote(cfg, 'Accounts/Orrick.md');
    expect(result.frontmatter.account).toBe('Orrick');
    expect(result.body).toContain('# Orrick');
  });

  it('creates parent directories automatically', () => {
    writeNote(cfg, 'Deep/Nested/Dir/note.md', 'content');
    expect(fs.existsSync(path.join(dir, 'Deep/Nested/Dir/note.md'))).toBe(true);
  });

  it('throws when overwriting an existing note without overwrite flag', () => {
    writeNote(cfg, 'test.md', 'original');
    expect(() => writeNote(cfg, 'test.md', 'new')).toThrow(/already exists/);
  });

  it('overwrites when overwrite: true', () => {
    writeNote(cfg, 'test.md', 'original');
    writeNote(cfg, 'test.md', 'updated', { overwrite: true });
    const result = readNote(cfg, 'test.md');
    expect(result.body).toBe('updated');
  });

  it('throws when reading a non-existent note', () => {
    expect(() => readNote(cfg, 'missing.md')).toThrow(/not found/);
  });

  it('rejects paths that escape the vault', () => {
    expect(() => readNote(cfg, '../outside.md')).toThrow(/escapes the vault/);
  });
});

// ── appendNote ────────────────────────────────────────────────────────────────

describe('appendNote', () => {
  let dir: string;
  let cfg: ObsidianConfig;

  beforeEach(() => {
    ({ dir, cfg } = makeTmpVault());
  });

  afterEach(() => {
    cleanupTmpVault(dir);
  });

  it('creates a new note when the file does not exist', () => {
    appendNote(cfg, 'new.md', '## Section\n- Item');
    const result = readNote(cfg, 'new.md');
    expect(result.content).toContain('## Section');
  });

  it('appends a section to an existing note', () => {
    writeNote(cfg, 'existing.md', '# Note\n\nOriginal content.');
    appendNote(cfg, 'existing.md', '## Follow-Up\n- Call client');
    const result = readNote(cfg, 'existing.md');
    expect(result.content).toContain('Original content.');
    expect(result.content).toContain('## Follow-Up');
  });

  it('does not add extra blank lines when note already ends with two newlines', () => {
    writeNote(cfg, 'test.md', 'content\n\n');
    appendNote(cfg, 'test.md', '## New');
    const raw = fs.readFileSync(path.join(dir, 'test.md'), 'utf-8');
    // Should have at most two consecutive newlines between content and new section
    expect(raw).not.toMatch(/\n{3,}/);
  });
});

// ── searchNotes ───────────────────────────────────────────────────────────────

describe('searchNotes', () => {
  let dir: string;
  let cfg: ObsidianConfig;

  beforeEach(() => {
    ({ dir, cfg } = makeTmpVault());
    fs.mkdirSync(path.join(dir, 'Accounts'));
    fs.mkdirSync(path.join(dir, 'Meetings'));
    fs.writeFileSync(path.join(dir, 'Accounts', 'Orrick.md'), '# Orrick\n\nLaw firm specializing in litigation.');
    fs.writeFileSync(path.join(dir, 'Accounts', 'McKinsey.md'), '# McKinsey\n\nConsulting firm.');
    fs.writeFileSync(path.join(dir, 'Meetings', '2026-03-19 - Orrick - Strategy.md'), '## Notes\n\nDiscussed SA Reclass motion.');
  });

  afterEach(() => {
    cleanupTmpVault(dir);
  });

  it('finds matches across all files', () => {
    const results = searchNotes(cfg, 'firm');
    expect(results.length).toBe(2);
  });

  it('is case-insensitive', () => {
    const results = searchNotes(cfg, 'ORRICK');
    expect(results.length).toBeGreaterThan(0);
  });

  it('restricts search to a folder', () => {
    const results = searchNotes(cfg, 'Orrick', { folder: 'Meetings' });
    expect(results.every(r => r.relativePath.startsWith('Meetings'))).toBe(true);
  });

  it('returns empty array when nothing matches', () => {
    const results = searchNotes(cfg, 'xyzzy-no-match');
    expect(results).toEqual([]);
  });

  it('respects the limit parameter', () => {
    // Write 10 notes all containing the keyword
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(dir, `note-${i}.md`), 'keyword appears here');
    }
    const results = searchNotes(cfg, 'keyword', { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('skips hidden directories', () => {
    fs.mkdirSync(path.join(dir, '.obsidian'));
    fs.writeFileSync(path.join(dir, '.obsidian', 'config.md'), 'hidden keyword');
    const results = searchNotes(cfg, 'hidden keyword');
    expect(results.length).toBe(0);
  });

  it('returns empty array for non-existent folder', () => {
    const results = searchNotes(cfg, 'anything', { folder: 'NonExistent' });
    expect(results).toEqual([]);
  });
});

// ── listNotes ─────────────────────────────────────────────────────────────────

describe('listNotes', () => {
  let dir: string;
  let cfg: ObsidianConfig;

  beforeEach(() => {
    ({ dir, cfg } = makeTmpVault());
    fs.mkdirSync(path.join(dir, 'Accounts'));
    fs.writeFileSync(
      path.join(dir, 'Accounts', 'Orrick.md'),
      '---\ntags: [account/orrick, type/account]\n---\n# Orrick',
    );
    fs.writeFileSync(
      path.join(dir, 'Accounts', 'McKinsey.md'),
      '---\ntags: [account/mckinsey, type/account]\n---\n# McKinsey',
    );
    fs.writeFileSync(path.join(dir, 'root.md'), '# Root note');
  });

  afterEach(() => {
    cleanupTmpVault(dir);
  });

  it('lists all notes when no folder is specified', () => {
    const entries = listNotes(cfg);
    expect(entries.length).toBe(3);
  });

  it('lists notes in a sub-folder', () => {
    const entries = listNotes(cfg, { folder: 'Accounts' });
    expect(entries.length).toBe(2);
    expect(entries.every(e => e.relativePath.startsWith('Accounts'))).toBe(true);
  });

  it('filters by tag', () => {
    const entries = listNotes(cfg, { folder: 'Accounts', tag: 'account/orrick' });
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe('Orrick');
  });

  it('filters by tag with leading # stripped', () => {
    const entries = listNotes(cfg, { tag: '#account/orrick' });
    expect(entries.length).toBe(1);
  });

  it('returns empty for unknown tag', () => {
    const entries = listNotes(cfg, { tag: 'account/nobody' });
    expect(entries).toEqual([]);
  });

  it('sorts by name when sortBy is "name"', () => {
    const entries = listNotes(cfg, { folder: 'Accounts', sortBy: 'name' });
    expect(entries[0].name).toBe('McKinsey');
    expect(entries[1].name).toBe('Orrick');
  });

  it('returns empty array for non-existent folder', () => {
    const entries = listNotes(cfg, { folder: 'NonExistent' });
    expect(entries).toEqual([]);
  });

  it('respects the limit parameter', () => {
    const entries = listNotes(cfg, { limit: 1 });
    expect(entries.length).toBe(1);
  });
});

// ── Path helpers ──────────────────────────────────────────────────────────────

describe('buildMeetingNotePath', () => {
  const cfg: ObsidianConfig = { vaultPath: '/vault' };

  it('generates the standard meeting path', () => {
    const p = buildMeetingNotePath(cfg, '2026-03-19', 'Orrick', 'Strategy');
    expect(p).toBe('Meetings/2026-03-19 - Orrick - Strategy.md');
  });

  it('uses custom meetingsFolder from config', () => {
    const p = buildMeetingNotePath({ ...cfg, meetingsFolder: 'Notes' }, '2026-03-19', 'Orrick', 'Strategy');
    expect(p).toBe('Notes/2026-03-19 - Orrick - Strategy.md');
  });

  it('sanitizes characters that are invalid in filenames', () => {
    const p = buildMeetingNotePath(cfg, '2026-03-19', 'A/B', 'Topic: One');
    expect(p).not.toContain('/A/B');
    expect(p).not.toContain(':');
  });
});

describe('buildAccountNotePath', () => {
  const cfg: ObsidianConfig = { vaultPath: '/vault' };

  it('generates the standard account path', () => {
    expect(buildAccountNotePath(cfg, 'Orrick')).toBe('Accounts/Orrick.md');
  });

  it('uses custom accountsFolder from config', () => {
    expect(buildAccountNotePath({ ...cfg, accountsFolder: 'Clients' }, 'Orrick')).toBe('Clients/Orrick.md');
  });
});

// ── buildAutoTags ─────────────────────────────────────────────────────────────

describe('buildAutoTags', () => {
  it('generates all three tag types when all fields are set', () => {
    const tags = buildAutoTags({ account: 'Reed Smith', motion: 'SA Reclass', type: 'meeting' });
    expect(tags).toContain('account/reed-smith');
    expect(tags).toContain('motion/sa-reclass');
    expect(tags).toContain('type/meeting');
  });

  it('lowercases and hyphenates spaces', () => {
    const tags = buildAutoTags({ account: 'Big Client Inc' });
    expect(tags).toContain('account/big-client-inc');
  });

  it('returns empty array for empty input', () => {
    expect(buildAutoTags({})).toEqual([]);
  });
});
