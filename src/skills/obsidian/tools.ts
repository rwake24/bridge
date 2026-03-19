/**
 * Obsidian vault tool definitions for the Copilot bridge.
 *
 * These tools are injected into the Copilot session as custom bridge tools so
 * the agent can read, write, search, and tag notes in a local Obsidian vault.
 *
 * All tools are auto-approved (no interactive permission prompt) because the
 * vault path is explicitly configured by the admin in config.json.
 */

import path from 'node:path';
import type { ObsidianConfig } from '../../types.js';
import {
  readNote,
  writeNote,
  appendNote,
  searchNotes,
  listNotes,
  buildMeetingNotePath,
  buildAccountNotePath,
  buildAutoTags,
  resolveVaultFolder,
} from './vault.js';

export const OBSIDIAN_TOOL_NAMES = [
  'obsidian_read',
  'obsidian_write',
  'obsidian_append',
  'obsidian_search',
  'obsidian_list',
] as const;

/** Minimal interface for a custom bridge tool definition. */
interface BridgeToolDef {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<Record<string, unknown>>;
}

/**
 * Build the array of Obsidian vault tool definitions for the given config.
 * Returns an empty array when obsidian config is absent.
 */
export function buildObsidianTools(obsidian: ObsidianConfig | undefined): BridgeToolDef[] {
  if (!obsidian) return [];

  const cfg = obsidian;

  return [
    // ── obsidian_read ────────────────────────────────────────────────────────
    {
      name: 'obsidian_read',
      description:
        'Read an Obsidian vault note by its path (relative to the vault root, e.g. "Accounts/Orrick.md") ' +
        'or by providing an account name to look up the canonical account note. ' +
        'Returns the full content including YAML frontmatter.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Path to the note relative to the vault root, e.g. "Accounts/Orrick.md" or ' +
              '"Meetings/2026-03-19 - Orrick - Strategy.md". ' +
              'If omitted, you must provide account_name.',
          },
          account_name: {
            type: 'string',
            description:
              'Account name to look up (resolves to Accounts/<AccountName>.md). ' +
              'Ignored if path is provided.',
          },
        },
      },
      handler: async (args: { path?: string; account_name?: string }) => {
        try {
          const notePath = args.path ?? (args.account_name ? buildAccountNotePath(cfg, args.account_name) : undefined);
          if (!notePath) return { content: 'Provide either path or account_name.' };
          const result = readNote(cfg, notePath);
          return {
            content: result.content,
            path: result.path,
            frontmatter: result.frontmatter,
          };
        } catch (err: any) {
          return { content: `Error reading note: ${err?.message ?? String(err)}` };
        }
      },
    },

    // ── obsidian_write ───────────────────────────────────────────────────────
    {
      name: 'obsidian_write',
      description:
        'Create a new note in the Obsidian vault (or overwrite an existing one). ' +
        'Supports auto-generation of YAML frontmatter tags from account/motion/type fields. ' +
        'Use obsidian_append to add sections to an existing note instead of replacing it.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Destination path relative to vault root (e.g. "Accounts/NewClient.md"). ' +
              'For meetings, prefer using meeting_date + meeting_account + meeting_topic to ' +
              'generate the standard path automatically.',
          },
          meeting_date: {
            type: 'string',
            description: 'ISO date (YYYY-MM-DD) for auto-generating meeting note paths.',
          },
          meeting_account: {
            type: 'string',
            description: 'Account name for auto-generating meeting note paths.',
          },
          meeting_topic: {
            type: 'string',
            description: 'Topic for auto-generating meeting note paths.',
          },
          body: {
            type: 'string',
            description: 'Markdown body text of the note (after frontmatter).',
          },
          frontmatter: {
            type: 'object',
            description:
              'YAML frontmatter fields. Supported keys: account, motion, type, date, participants, tags. ' +
              'Tags are merged with auto-generated tags from account/motion/type.',
            properties: {
              account: { type: 'string' },
              motion: { type: 'string' },
              type: { type: 'string' },
              date: { type: 'string' },
              participants: { type: 'array', items: { type: 'string' } },
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
          overwrite: {
            type: 'boolean',
            description: 'Set true to overwrite an existing note. Defaults to false.',
          },
        },
        required: ['body'],
      },
      handler: async (args: {
        path?: string;
        meeting_date?: string;
        meeting_account?: string;
        meeting_topic?: string;
        body: string;
        frontmatter?: {
          account?: string;
          motion?: string;
          type?: string;
          date?: string;
          participants?: string[];
          tags?: string[];
          [key: string]: unknown;
        };
        overwrite?: boolean;
      }) => {
        try {
          let notePath = args.path;
          if (!notePath) {
            if (args.meeting_date && args.meeting_account && args.meeting_topic) {
              notePath = buildMeetingNotePath(cfg, args.meeting_date, args.meeting_account, args.meeting_topic);
            } else if (args.frontmatter?.account && !args.path) {
              notePath = buildAccountNotePath(cfg, args.frontmatter.account);
            } else {
              return { content: 'Provide path, or meeting_date + meeting_account + meeting_topic.' };
            }
          }

          // Build frontmatter with auto-generated tags
          let fm = args.frontmatter ? { ...args.frontmatter } : undefined;
          if (fm) {
            const autoTags = buildAutoTags({
              account: fm.account,
              motion: fm.motion,
              type: fm.type,
            });
            const existingTags = Array.isArray(fm.tags) ? fm.tags : [];
            const merged = [...new Set([...existingTags, ...autoTags])];
            if (merged.length > 0) fm.tags = merged;
          }

          const resolved = writeNote(cfg, notePath, args.body, {
            frontmatter: fm,
            overwrite: args.overwrite ?? false,
          });
          return { content: `Note written: ${path.relative(path.resolve(cfg.vaultPath), resolved)}` };
        } catch (err: any) {
          return { content: `Error writing note: ${err?.message ?? String(err)}` };
        }
      },
    },

    // ── obsidian_append ──────────────────────────────────────────────────────
    {
      name: 'obsidian_append',
      description:
        'Append a Markdown section to an existing Obsidian vault note. ' +
        'If the note does not exist, it is created. ' +
        'Use this for adding action items, follow-ups, or new sections without replacing the full note.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the note relative to vault root.',
          },
          account_name: {
            type: 'string',
            description: 'Account name to append to (resolves to Accounts/<AccountName>.md). Ignored if path is given.',
          },
          section: {
            type: 'string',
            description: 'Markdown text to append (e.g. "## Action Items\\n- Follow up with Kim").',
          },
        },
        required: ['section'],
      },
      handler: async (args: { path?: string; account_name?: string; section: string }) => {
        try {
          const notePath = args.path ?? (args.account_name ? buildAccountNotePath(cfg, args.account_name) : undefined);
          if (!notePath) return { content: 'Provide either path or account_name.' };
          const resolved = appendNote(cfg, notePath, args.section);
          return { content: `Section appended to: ${path.relative(path.resolve(cfg.vaultPath), resolved)}` };
        } catch (err: any) {
          return { content: `Error appending to note: ${err?.message ?? String(err)}` };
        }
      },
    },

    // ── obsidian_search ──────────────────────────────────────────────────────
    {
      name: 'obsidian_search',
      description:
        'Full-text search across all Markdown notes in the Obsidian vault (or a sub-folder). ' +
        'Returns matching lines with their file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Text to search for (case-insensitive).',
          },
          folder: {
            type: 'string',
            description:
              'Restrict search to a sub-folder (relative to vault root), ' +
              'e.g. "Accounts" or "Meetings". Searches entire vault if omitted.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 50).',
          },
        },
        required: ['query'],
      },
      handler: async (args: { query: string; folder?: string; limit?: number }) => {
        try {
          const results = searchNotes(cfg, args.query, {
            folder: args.folder,
            limit: args.limit,
          });
          if (results.length === 0) {
            return { content: 'No matches found.' };
          }
          const lines = results.map(r => `${r.relativePath}:${r.lineNumber}: ${r.lineContent}`);
          return { content: lines.join('\n'), results };
        } catch (err: any) {
          return { content: `Error searching vault: ${err?.message ?? String(err)}` };
        }
      },
    },

    // ── obsidian_list ────────────────────────────────────────────────────────
    {
      name: 'obsidian_list',
      description:
        'List Markdown notes in a vault folder or filter by frontmatter tag. ' +
        'Results are sorted by modification time (most recent first) unless sort_by is "name".',
      parameters: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description:
              'Sub-folder relative to vault root (e.g. "Accounts", "Meetings", "Daily"). ' +
              'Lists the entire vault if omitted.',
          },
          folder_key: {
            type: 'string',
            enum: ['accountsFolder', 'meetingsFolder', 'motionsFolder', 'dailyFolder', 'knowledgeFolder'],
            description: 'Named folder from config (alternative to providing a literal folder path).',
          },
          tag: {
            type: 'string',
            description: 'Filter to notes whose frontmatter tags include this value (e.g. "account/orrick").',
          },
          sort_by: {
            type: 'string',
            enum: ['modified', 'name'],
            description: 'Sort order: "modified" (default) or "name".',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results (default: 100).',
          },
        },
      },
      handler: async (args: {
        folder?: string;
        folder_key?: string;
        tag?: string;
        sort_by?: 'modified' | 'name';
        limit?: number;
      }) => {
        try {
          let folder = args.folder;
          if (!folder && args.folder_key) {
            const key = args.folder_key as keyof Omit<ObsidianConfig, 'vaultPath'>;
            folder = resolveVaultFolder(cfg, key);
            // Make it relative again for resolveNotePath inside listNotes
            folder = path.relative(path.resolve(cfg.vaultPath), folder);
          }
          const entries = listNotes(cfg, {
            folder,
            tag: args.tag,
            sortBy: args.sort_by,
            limit: args.limit,
          });
          if (entries.length === 0) {
            return { content: 'No notes found.' };
          }
          const lines = entries.map(e => {
            const ts = e.modifiedAt.toISOString().slice(0, 10);
            return `${e.relativePath}  (modified: ${ts})`;
          });
          return { content: lines.join('\n'), entries: entries.map(e => ({ ...e, modifiedAt: e.modifiedAt.toISOString() })) };
        } catch (err: any) {
          return { content: `Error listing notes: ${err?.message ?? String(err)}` };
        }
      },
    },
  ];
}
