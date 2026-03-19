import fs from 'node:fs';
import path from 'node:path';
import { getConfigPath } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('accounts');

export interface Account {
  name: string;
  motions: string[];
  macc?: number;
  renewalDate?: string;
  monthlyPotential?: number;
  currentAcr?: number;
  ae?: string;
  ssp?: string;
  priority?: string;
  serverCount?: number;
  defendedServers?: number;
  notes?: string;
  obsidianPath?: string;
}

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  whale: 1,
  high: 2,
  normal: 3,
  medium: 3,
  low: 4,
};

const PRIORITY_LABELS: Record<string, string> = {
  urgent: '🔴 URGENT',
  whale: '🐋 WHALE',
  high: '🟡 HIGH',
  normal: '🟢 NORMAL',
  medium: '🟢 NORMAL',
  low: '🔵 LOW',
};

/** Internal state */
let _accounts: Account[] = [];
let _loaded = false;

/** Resolve the accounts.json path from the config directory. */
function resolveAccountsPath(configDir?: string): string {
  const dir =
    configDir ??
    (getConfigPath() ? path.dirname(getConfigPath()!) : process.cwd());
  return path.join(dir, 'accounts.json');
}

/**
 * Load accounts from accounts.json in the given config directory (or the
 * directory containing config.json when no explicit path is provided).
 * Silently no-ops when the file does not exist.
 */
export function loadAccounts(configDir?: string): void {
  const filePath = resolveAccountsPath(configDir);

  if (!fs.existsSync(filePath)) {
    log.info(`No accounts.json found at ${filePath} — account features disabled`);
    _accounts = [];
    _loaded = true;
    return;
  }

  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!Array.isArray(raw)) {
      log.warn('accounts.json must be a JSON array — skipping');
      _accounts = [];
    } else {
      _accounts = raw as Account[];
      log.info(`Loaded ${_accounts.length} account(s) from ${filePath}`);
    }
    _loaded = true;
  } catch (err: any) {
    log.warn(`Failed to load accounts.json: ${err.message}`);
    _accounts = [];
    _loaded = true;
  }
}

/** Return all accounts (loads lazily on first call if not yet loaded). */
export function getAccounts(): Account[] {
  if (!_loaded) loadAccounts();
  return _accounts;
}

/** Return true if the accounts feature has data available. */
export function hasAccounts(): boolean {
  return getAccounts().length > 0;
}

/**
 * Fuzzy lookup by account name. Tries exact (case-insensitive), then
 * substring, then token match.
 */
export function findAccount(query: string): Account | null {
  const accounts = getAccounts();
  if (!accounts.length) return null;

  const q = query.toLowerCase().trim();

  // Exact match
  const exact = accounts.find(a => a.name.toLowerCase() === q);
  if (exact) return exact;

  // Substring
  const sub = accounts.filter(a => a.name.toLowerCase().includes(q));
  if (sub.length === 1) return sub[0];
  if (sub.length > 1) {
    // Prefer shortest name (closest match)
    return sub.sort((a, b) => a.name.length - b.name.length)[0];
  }

  // Token match: all words in query appear in account name
  const tokens = q.split(/\s+/).filter(Boolean);
  const tok = accounts.filter(a =>
    tokens.every(t => a.name.toLowerCase().includes(t)),
  );
  if (tok.length > 0) return tok.sort((a, b) => a.name.length - b.name.length)[0];

  return null;
}

/** Filter accounts by motion (case-insensitive substring). */
export function filterByMotion(motion: string): Account[] {
  const q = motion.toLowerCase().trim();
  return getAccounts().filter(a =>
    a.motions.some(m => m.toLowerCase().includes(q)),
  );
}

/** Filter accounts by priority level. */
export function filterByPriority(priority: string): Account[] {
  const q = priority.toLowerCase().trim();
  return getAccounts().filter(a => (a.priority ?? 'normal').toLowerCase() === q);
}

/**
 * Return accounts whose renewal date falls within the next `days` days.
 * Accounts with no renewalDate are excluded.
 */
export function getUpcomingRenewals(days: number): Account[] {
  const now = Date.now();
  const cutoff = now + days * 24 * 60 * 60 * 1000;
  return getAccounts().filter(a => {
    if (!a.renewalDate) return false;
    const ts = Date.parse(a.renewalDate);
    if (isNaN(ts)) return false;
    return ts >= now && ts <= cutoff;
  });
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/** Format a dollar amount as "$21.5K" or "$1.2M". */
function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n}`;
}

/** Format renewal date as "MM/DD" with optional warning emoji. */
function fmtRenewal(dateStr: string, warnDays = 90): string {
  const ts = Date.parse(dateStr);
  if (isNaN(ts)) return dateStr;
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const soon = ts - Date.now() <= warnDays * 24 * 60 * 60 * 1000;
  return `${mm}/${dd}${soon ? ' ⚠️' : ''}`;
}

/** Format a single account as one summary line for the pipeline view. */
function fmtAccountLine(a: Account): string {
  const parts: string[] = [a.name];

  if (a.motions.length > 0) parts.push(a.motions.join(' + '));
  if (a.serverCount !== undefined) {
    const defended = a.defendedServers !== undefined ? ` (${a.defendedServers} protected)` : '';
    parts.push(`${a.serverCount.toLocaleString()} servers${defended}`);
  }
  if (a.monthlyPotential !== undefined) parts.push(`${fmtMoney(a.monthlyPotential)}/mo`);
  if (a.renewalDate) parts.push(`Renewal ${fmtRenewal(a.renewalDate)}`);

  return `  ${parts.join(' — ')}`;
}

/** Format a grouped list of accounts under a priority heading. */
function fmtPriorityGroup(label: string, accounts: Account[]): string[] {
  const lines: string[] = [`**${label}**`];
  for (const a of accounts) lines.push(fmtAccountLine(a));
  return lines;
}

/**
 * Build the full pipeline dashboard string.
 */
export function formatPipelineView(): string {
  const accounts = getAccounts();
  if (!accounts.length) {
    return '📊 No account data loaded. Add accounts.json to your config directory.';
  }

  const motionSet = new Set<string>();
  for (const a of accounts) a.motions.forEach(m => motionSet.add(m));
  const header = `📊 **Pipeline Overview** — ${accounts.length} Account${accounts.length !== 1 ? 's' : ''}, ${motionSet.size} Motion${motionSet.size !== 1 ? 's' : ''}`;

  // Group by priority
  const groups = new Map<string, Account[]>();
  for (const a of accounts) {
    const key = (a.priority ?? 'normal').toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }

  // Sort groups by priority order
  const sortedKeys = [...groups.keys()].sort(
    (a, b) => (PRIORITY_ORDER[a] ?? 99) - (PRIORITY_ORDER[b] ?? 99),
  );

  const lines: string[] = [header, ''];
  for (const key of sortedKeys) {
    const label = PRIORITY_LABELS[key] ?? key.toUpperCase();
    lines.push(...fmtPriorityGroup(label, groups.get(key)!), '');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Build a detailed account view string.
 */
export function formatAccountDetail(a: Account): string {
  const lines: string[] = [];

  const priority = (a.priority ?? 'normal').toLowerCase();
  const priorityLabel = PRIORITY_LABELS[priority] ?? priority.toUpperCase();
  lines.push(`📋 **${a.name}** — ${priorityLabel}`);

  if (a.motions.length > 0) lines.push(`• Motions: ${a.motions.join(', ')}`);

  if (a.monthlyPotential !== undefined)
    lines.push(`• Monthly Potential: ${fmtMoney(a.monthlyPotential)}/mo`);
  if (a.currentAcr !== undefined)
    lines.push(`• Current ACR: ${fmtMoney(a.currentAcr)}/mo`);
  if (a.macc !== undefined)
    lines.push(`• MACC: ${fmtMoney(a.macc)}`);

  if (a.renewalDate) {
    const ts = Date.parse(a.renewalDate);
    const daysLeft = isNaN(ts)
      ? null
      : Math.ceil((ts - Date.now()) / (24 * 60 * 60 * 1000));
    const suffix =
      daysLeft !== null
        ? ` (${daysLeft > 0 ? `${daysLeft}d away` : 'past due'})`
        : '';
    lines.push(`• Renewal: ${fmtRenewal(a.renewalDate)}${suffix}`);
  }

  const assignees = [a.ae && `AE: ${a.ae}`, a.ssp && `SSP: ${a.ssp}`]
    .filter(Boolean)
    .join(' | ');
  if (assignees) lines.push(`• ${assignees}`);

  if (a.serverCount !== undefined) {
    const defended =
      a.defendedServers !== undefined
        ? `, ${a.defendedServers} protected`
        : '';
    lines.push(`• Servers: ${a.serverCount.toLocaleString()} total${defended}`);
  }

  if (a.notes) lines.push(`• Notes: ${a.notes}`);
  if (a.obsidianPath) lines.push(`• Obsidian: \`${a.obsidianPath}\``);

  return lines.join('\n');
}

/**
 * Build a renewal alert summary for the next N days.
 */
export function formatRenewalAlerts(days: number): string {
  const upcoming = getUpcomingRenewals(days);
  if (!upcoming.length) {
    return `📅 No renewals in the next ${days} days.`;
  }

  // Sort by renewal date
  const sorted = [...upcoming].sort(
    (a, b) => Date.parse(a.renewalDate!) - Date.parse(b.renewalDate!),
  );

  const lines = [`📅 **Renewals in the next ${days} days** — ${sorted.length} account(s)`, ''];
  for (const a of sorted) {
    lines.push(fmtAccountLine(a));
  }
  return lines.join('\n');
}

/** Reset internal state (for tests). */
export function _resetAccounts(): void {
  _accounts = [];
  _loaded = false;
}
