/**
 * Obsidian vault filesystem operations.
 *
 * All operations are pure filesystem — no Obsidian API is required.
 * Notes are stored as Markdown files with optional YAML frontmatter.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ObsidianConfig } from '../../types.js';

// ─── Frontmatter ────────────────────────────────────────────────────────────

export interface NoteFrontmatter {
  account?: string;
  motion?: string;
  type?: string;
  date?: string;
  participants?: string[];
  tags?: string[];
  [key: string]: unknown;
}

/**
 * Parse YAML frontmatter from a Markdown note.
 * Returns `{ frontmatter, body }` where body is the content after the
 * closing `---` delimiter (or the full content if no frontmatter exists).
 */
export function parseNoteFrontmatter(content: string): { frontmatter: NoteFrontmatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const yamlBlock = match[1];
  const body = match[2] ?? '';
  const frontmatter: NoteFrontmatter = {};

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    // Inline array: [a, b, c]
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1);
      frontmatter[key] = inner
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      // Strip surrounding quotes
      frontmatter[key] = rawValue.replace(/^["']|["']$/g, '');
    }
  }

  return { frontmatter, body };
}

/**
 * Serialize a frontmatter object back to a YAML block (including delimiters).
 */
export function buildNoteFrontmatter(fm: NoteFrontmatter): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      // Escape backslashes first, then double-quotes, to produce valid YAML quoted strings.
      const items = value
        .map(v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
        .join(', ');
      lines.push(`${key}: [${items}]`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

// ─── Path helpers ────────────────────────────────────────────────────────────

/**
 * Resolve and validate that a note path stays inside the vault root.
 * Throws if the resolved path escapes the vault.
 */
function resolveNotePath(vaultPath: string, notePath: string): string {
  // Normalize vault root (no trailing separator)
  const vaultRoot = path.resolve(vaultPath);
  // Resolve the note path relative to the vault root
  const resolved = path.isAbsolute(notePath)
    ? path.resolve(notePath)
    : path.resolve(vaultRoot, notePath);

  if (!resolved.startsWith(vaultRoot + path.sep) && resolved !== vaultRoot) {
    throw new Error(`Note path "${notePath}" escapes the vault boundary`);
  }
  return resolved;
}

/** Ensure the directory containing a file exists. */
function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/** Default folder names for each config key. */
const FOLDER_DEFAULTS: Record<string, string> = {
  accountsFolder: 'Accounts',
  meetingsFolder: 'Meetings',
  motionsFolder: 'Motions',
  dailyFolder: 'Daily',
  knowledgeFolder: 'Knowledge',
};

/** Return the configured folder name for a given config key, falling back to the built-in default. */
function folderName(cfg: ObsidianConfig, key: keyof Omit<ObsidianConfig, 'vaultPath'>): string {
  return (cfg[key] as string | undefined) ?? FOLDER_DEFAULTS[key] ?? key;
}

// ─── Operations ──────────────────────────────────────────────────────────────

export interface ReadNoteResult {
  path: string;
  content: string;
  frontmatter: NoteFrontmatter;
  body: string;
}

/**
 * Read a note by its path within the vault.
 * `notePath` may be relative (e.g. "Accounts/Orrick.md") or absolute.
 */
export function readNote(cfg: ObsidianConfig, notePath: string): ReadNoteResult {
  const resolved = resolveNotePath(cfg.vaultPath, notePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Note not found: ${notePath}`);
  }
  const content = fs.readFileSync(resolved, 'utf-8');
  const { frontmatter, body } = parseNoteFrontmatter(content);
  return { path: resolved, content, frontmatter, body };
}

export interface WriteNoteOptions {
  frontmatter?: NoteFrontmatter;
  overwrite?: boolean;
}

/**
 * Write (create or overwrite) a note.
 * If `options.overwrite` is false (default) and the file exists, throws.
 */
export function writeNote(
  cfg: ObsidianConfig,
  notePath: string,
  body: string,
  options: WriteNoteOptions = {},
): string {
  const resolved = resolveNotePath(cfg.vaultPath, notePath);
  if (!options.overwrite && fs.existsSync(resolved)) {
    throw new Error(`Note already exists: ${notePath}. Use overwrite: true to replace it.`);
  }
  ensureDir(resolved);
  const fm = options.frontmatter ? buildNoteFrontmatter(options.frontmatter) : '';
  fs.writeFileSync(resolved, fm + body, 'utf-8');
  return resolved;
}

/**
 * Append a section to an existing note (or create it if it doesn't exist).
 * The section is appended with a blank line separator.
 */
export function appendNote(cfg: ObsidianConfig, notePath: string, section: string): string {
  const resolved = resolveNotePath(cfg.vaultPath, notePath);
  ensureDir(resolved);
  if (fs.existsSync(resolved)) {
    const existing = fs.readFileSync(resolved, 'utf-8');
    let separator: string;
    if (existing.endsWith('\n\n')) {
      separator = '';
    } else if (existing.endsWith('\n')) {
      separator = '\n';
    } else {
      separator = '\n\n';
    }
    fs.writeFileSync(resolved, existing + separator + section + '\n', 'utf-8');
  } else {
    fs.writeFileSync(resolved, section + '\n', 'utf-8');
  }
  return resolved;
}

export interface SearchResult {
  path: string;
  relativePath: string;
  lineNumber: number;
  lineContent: string;
}

/**
 * Full-text search across the vault (or a sub-folder).
 * Returns up to `limit` matching lines (default: 50).
 */
export function searchNotes(
  cfg: ObsidianConfig,
  query: string,
  options: { folder?: string; limit?: number } = {},
): SearchResult[] {
  const vaultRoot = path.resolve(cfg.vaultPath);
  const searchRoot = options.folder
    ? resolveNotePath(cfg.vaultPath, options.folder)
    : vaultRoot;

  if (!fs.existsSync(searchRoot)) return [];

  const limit = options.limit ?? 50;
  const results: SearchResult[] = [];
  const lowerQuery = query.toLowerCase();

  function walk(dir: string): void {
    if (results.length >= limit) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= limit) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden directories (e.g. .obsidian, .trash)
        if (!entry.name.startsWith('.')) walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && results.length < limit; i++) {
          if (lines[i].toLowerCase().includes(lowerQuery)) {
            results.push({
              path: fullPath,
              relativePath: path.relative(vaultRoot, fullPath),
              lineNumber: i + 1,
              lineContent: lines[i].trim(),
            });
          }
        }
      }
    }
  }

  walk(searchRoot);
  return results;
}

export interface NoteEntry {
  path: string;
  relativePath: string;
  name: string;
  modifiedAt: Date;
}

/**
 * List notes in a vault folder, optionally filtered by a frontmatter tag.
 * Results are sorted by modification time (most recent first) unless `sortBy` is 'name'.
 */
export function listNotes(
  cfg: ObsidianConfig,
  options: { folder?: string; tag?: string; sortBy?: 'modified' | 'name'; limit?: number } = {},
): NoteEntry[] {
  const vaultRoot = path.resolve(cfg.vaultPath);
  const listRoot = options.folder
    ? resolveNotePath(cfg.vaultPath, options.folder)
    : vaultRoot;

  if (!fs.existsSync(listRoot)) return [];

  const limit = options.limit ?? 100;
  const entries: NoteEntry[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (options.tag) {
          // Filter by tag: check frontmatter tags array
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const { frontmatter } = parseNoteFrontmatter(content);
            const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
            const normalizedTag = options.tag.replace(/^#/, '');
            if (!tags.some(t => String(t).replace(/^#/, '') === normalizedTag)) continue;
          } catch {
            continue;
          }
        }
        const stat = fs.statSync(fullPath);
        entries.push({
          path: fullPath,
          relativePath: path.relative(vaultRoot, fullPath),
          name: path.basename(fullPath, '.md'),
          modifiedAt: stat.mtime,
        });
      }
    }
  }

  walk(listRoot);

  if (options.sortBy === 'name') {
    entries.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    entries.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  }

  return entries.slice(0, limit);
}

// ─── Convenience helpers ─────────────────────────────────────────────────────

/** Resolve the full folder path for a named folder in the vault. */
export function resolveVaultFolder(cfg: ObsidianConfig, folderKey: keyof Omit<ObsidianConfig, 'vaultPath'>): string {
  return path.join(path.resolve(cfg.vaultPath), folderName(cfg, folderKey));
}

/**
 * Build a standard meeting note path, e.g. "Meetings/2026-03-19 - Acme - Kick-off.md".
 */
export function buildMeetingNotePath(cfg: ObsidianConfig, date: string, account: string, topic: string): string {
  const folder = folderName(cfg, 'meetingsFolder');
  const safeName = `${date} - ${account} - ${topic}`.replace(/[/\\:*?"<>|]/g, '_');
  return `${folder}/${safeName}.md`;
}

/**
 * Build a standard account note path, e.g. "Accounts/Orrick.md".
 */
export function buildAccountNotePath(cfg: ObsidianConfig, account: string): string {
  const folder = folderName(cfg, 'accountsFolder');
  const safeName = account.replace(/[/\\:*?"<>|]/g, '_');
  return `${folder}/${safeName}.md`;
}

/**
 * Auto-generate frontmatter tags from common fields.
 * Follows the naming conventions from the issue (account/name, motion/type, type/kind).
 */
export function buildAutoTags(fm: { account?: string; motion?: string; type?: string }): string[] {
  const tags: string[] = [];
  if (fm.account) {
    tags.push(`account/${fm.account.toLowerCase().replace(/\s+/g, '-')}`);
  }
  if (fm.motion) {
    tags.push(`motion/${fm.motion.toLowerCase().replace(/\s+/g, '-')}`);
  }
  if (fm.type) {
    tags.push(`type/${fm.type.toLowerCase().replace(/\s+/g, '-')}`);
  }
  return tags;
}
