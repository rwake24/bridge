import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logger.js';
import {
  getWorkspaceOverride,
  listWorkspaceOverrides,
} from '../state/store.js';
import { isBotAdminAny } from '../config.js';

const log = createLogger('workspace');

export const WORKSPACES_DIR = path.join(os.homedir(), '.copilot-bridge', 'workspaces');

export function ensureWorkspacesDir(): void {
  if (!fs.existsSync(WORKSPACES_DIR)) {
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
  }
}

/** Validate bot name to prevent path traversal. */
function validateBotName(name: string): void {
  if (!name || name !== path.basename(name) || name.startsWith('.')) {
    throw new Error(`Invalid bot name: ${name}`);
  }
}

export function getWorkspacePath(botName: string): string {
  validateBotName(botName);
  const override = getWorkspaceOverride(botName);
  if (override) {
    return override.workingDirectory;
  }
  return path.join(WORKSPACES_DIR, botName);
}

export function getWorkspaceAllowPaths(botName: string): string[] {
  const override = getWorkspaceOverride(botName);
  return override?.allowPaths ?? [];
}

export function initWorkspace(botName: string): string {
  const workspacePath = getWorkspacePath(botName);
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  const agentsFile = path.join(workspacePath, 'AGENTS.md');
  if (!fs.existsSync(agentsFile)) {
    const allowPaths = getWorkspaceAllowPaths(botName);
    const admin = isBotAdminAny(botName);
    fs.writeFileSync(agentsFile, generateAgentsTemplate(botName, workspacePath, allowPaths, admin), 'utf-8');
  }

  log.info(`Initialized workspace for "${botName}" at ${workspacePath}`);
  return workspacePath;
}

export function listWorkspaces(): Array<{ botName: string; path: string; isOverride: boolean; allowPaths: string[] }> {
  const results = new Map<string, { botName: string; path: string; isOverride: boolean; allowPaths: string[] }>();

  // Scan filesystem
  if (fs.existsSync(WORKSPACES_DIR)) {
    for (const entry of fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        results.set(entry.name, {
          botName: entry.name,
          path: path.join(WORKSPACES_DIR, entry.name),
          isOverride: false,
          allowPaths: [],
        });
      }
    }
  }

  // Merge SQLite overrides
  for (const override of listWorkspaceOverrides()) {
    results.set(override.botName, {
      botName: override.botName,
      path: override.workingDirectory,
      isOverride: true,
      allowPaths: override.allowPaths,
    });
  }

  return Array.from(results.values());
}

export type WorkspaceEvent = { type: 'created' | 'removed'; botName: string; path: string };
type WorkspaceEventHandler = (event: WorkspaceEvent) => void;

export class WorkspaceWatcher {
  private watcher: fs.FSWatcher | null = null;
  private handlers: WorkspaceEventHandler[] = [];
  private knownDirs: Set<string>;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private log = createLogger('workspace-watcher');

  constructor() {
    this.knownDirs = this.scanDirs();
  }

  /** Start watching the workspaces directory. */
  start(): void {
    ensureWorkspacesDir();
    if (this.watcher) return;

    this.log.info(`Watching ${WORKSPACES_DIR} for workspace changes`);
    this.watcher = fs.watch(WORKSPACES_DIR, { persistent: false }, () => {
      // Debounce — filesystem events fire multiple times
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.checkForChanges(), 500);
    });

    this.watcher.on('error', (err) => {
      this.log.error('Watcher error:', err);
    });
  }

  /** Stop watching. */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Register an event handler. */
  onEvent(handler: WorkspaceEventHandler): void {
    this.handlers.push(handler);
  }

  private scanDirs(): Set<string> {
    const dirs = new Set<string>();
    if (!fs.existsSync(WORKSPACES_DIR)) return dirs;
    try {
      for (const entry of fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          dirs.add(entry.name);
        }
      }
    } catch { /* permission errors */ }
    return dirs;
  }

  private checkForChanges(): void {
    const currentDirs = this.scanDirs();

    // Detect new directories
    for (const dir of currentDirs) {
      if (!this.knownDirs.has(dir)) {
        this.log.info(`New workspace detected: ${dir}`);
        const wsPath = path.join(WORKSPACES_DIR, dir);
        this.emit({ type: 'created', botName: dir, path: wsPath });
      }
    }

    // Detect removed directories
    for (const dir of this.knownDirs) {
      if (!currentDirs.has(dir)) {
        this.log.info(`Workspace removed: ${dir}`);
        const wsPath = path.join(WORKSPACES_DIR, dir);
        this.emit({ type: 'removed', botName: dir, path: wsPath });
      }
    }

    this.knownDirs = currentDirs;
  }

  private emit(event: WorkspaceEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        this.log.error('Event handler error:', err);
      }
    }
  }
}

export function generateAgentsTemplate(
  botName: string,
  workspacePath: string,
  allowPaths: string[],
  isAdmin = false,
): string {
  const adminSection = isAdmin
    ? `
## Admin Capabilities
You are an **admin agent** with workspace management powers:
- **Create workspaces**: \`mkdir ${WORKSPACES_DIR}/<name>\` — the bridge auto-detects new directories and initializes them
- **Write AGENTS.md**: After creating a workspace, write an \`AGENTS.md\` file to give the new agent context and instructions
- **List workspaces**: \`ls ${WORKSPACES_DIR}\` to see all agent workspaces
- **Config edits**: You may need to edit \`config.json\` to add bot tokens or channel mappings
  - **ALWAYS** create a backup first: \`cp config.json config.json.bak.$(date +%s)\`
  - The bridge must be restarted for token changes to take effect
`
    : '';

  return `# Agent Workspace

You are operating through **copilot-bridge**, a messaging bridge to GitHub Copilot CLI.

## How You Communicate
- You receive messages from a chat platform (Mattermost/Slack)
- Your responses are streamed back to the same channel
- Slash commands (e.g., /new, /model) are intercepted by the bridge — you won't see them
- The user may be on mobile; keep responses concise when possible

## Your Workspace
- Working directory: \`${workspacePath}\`
- You can read/write files within this workspace without permission prompts
- Access outside this workspace requires explicit permission or configuration
${allowPaths.length > 0 ? `\n## Additional Folders\n${allowPaths.map(p => `- \`${p}\``).join('\n')}\n` : ''}${adminSection}
## Constraints
- File system access is sandboxed to this workspace${allowPaths.length > 0 ? ' + additional folders listed above' : ''}
- Shell commands are subject to permission rules
- MCP servers are shared across all agents in this bridge instance
${isAdmin ? '- If you need to edit config.json, ALWAYS create a backup first: `cp config.json config.json.bak.$(date +%s)`\n' : ''}`;
}
