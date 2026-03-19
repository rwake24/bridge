/**
 * Mattermost API validation helpers.
 * Uses native fetch (Node 18+) — no @mattermost/client dependency.
 */

import type { CheckResult } from './output.js';

export interface MattermostBotInfo {
  id: string;
  username: string;
  email?: string;
  roles?: string;
  isBot?: boolean;
}

export interface MattermostTeamInfo {
  id: string;
  name: string;
  displayName: string;
}

export interface MattermostChannelResult {
  id: string;
  name: string;
  displayName: string;
  teamId: string;
  isNew: boolean;
}

export interface AgentChannelDef {
  name: string;
  displayName: string;
  purpose: string;
  header: string;
}

async function mmFetch(baseUrl: string, endpoint: string, token?: string): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v4${endpoint}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err: any) {
    return { ok: false, status: 0, data: { message: err.message || String(err) } };
  }
}

async function mmPost(baseUrl: string, endpoint: string, token: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v4${endpoint}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err: any) {
    return { ok: false, status: 0, data: { message: err.message || String(err) } };
  }
}

export async function pingServer(baseUrl: string): Promise<CheckResult> {
  const { ok, status, data } = await mmFetch(baseUrl, '/system/ping');
  if (ok && data?.status === 'OK') {
    return { status: 'pass', label: `Mattermost: ${baseUrl}`, detail: 'reachable' };
  }
  if (status === 0) {
    return { status: 'fail', label: `Mattermost: ${baseUrl}`, detail: 'connection failed — check URL' };
  }
  // Distinguish Mattermost auth rejection from CDN/WAF blocking:
  // Mattermost returns JSON; Cloudflare/CDN returns HTML or no JSON body
  if (status === 401 || status === 403) {
    if (data && typeof data === 'object' && ('status_code' in data || 'message' in data || 'id' in data)) {
      // Mattermost JSON error response — server is reachable, just auth-gated
      return { status: 'pass', label: `Mattermost: ${baseUrl}`, detail: 'reachable (ping requires auth on this server)' };
    }
    return {
      status: 'warn',
      label: `Mattermost: ${baseUrl}`,
      detail: `HTTP ${status} — may be blocked by a CDN/firewall. Will verify with bot token.`,
    };
  }
  return { status: 'fail', label: `Mattermost: ${baseUrl}`, detail: `HTTP ${status}` };
}

export async function validateBotToken(baseUrl: string, token: string): Promise<{ result: CheckResult; bot?: MattermostBotInfo }> {
  const { ok, status, data } = await mmFetch(baseUrl, '/users/me', token);
  if (ok && data?.id) {
    const bot: MattermostBotInfo = {
      id: data.id,
      username: data.username,
      email: data.email,
      roles: data.roles,
      isBot: data.is_bot,
    };
    const roleNote = data.roles?.includes('system_admin') ? ', admin' : '';
    return {
      result: { status: 'pass', label: `Bot "${data.username}"`, detail: `token valid${roleNote}` },
      bot,
    };
  }
  if (status === 401) {
    return { result: { status: 'fail', label: 'Bot token', detail: 'invalid or expired token' } };
  }
  if (status === 403) {
    return { result: { status: 'fail', label: 'Bot token', detail: 'token rejected (403) — check that the token has API access permissions' } };
  }
  return { result: { status: 'fail', label: 'Bot token', detail: `HTTP ${status}: ${data?.message || 'unknown error'}` } };
}

export async function checkChannelAccess(baseUrl: string, token: string, channelId: string, configName?: string): Promise<CheckResult> {
  const { ok, status, data } = await mmFetch(baseUrl, `/channels/${channelId}`, token);
  if (ok && data?.id) {
    const isDM = data.type === 'D' || data.type === 'G';
    const name = configName
      || data.display_name
      || (isDM ? 'DM channel' : null)
      || data.name
      || channelId;
    return { status: 'pass', label: `Channel "${name}"`, detail: isDM ? 'DM, accessible' : 'accessible' };
  }
  if (status === 403) {
    const label = configName || channelId;
    return { status: 'warn', label: `Channel "${label}"`, detail: 'bot not a member — add manually in Mattermost' };
  }
  if (status === 404) {
    const label = configName || channelId;
    return { status: 'fail', label: `Channel "${label}"`, detail: 'not found — check the channel ID' };
  }
  return { status: 'fail', label: `Channel ${channelId}`, detail: `HTTP ${status}: ${data?.message || 'unknown'}` };
}

export async function getChannelInfo(baseUrl: string, token: string, channelId: string): Promise<{ name?: string; displayName?: string; teamId?: string } | null> {
  const { ok, data } = await mmFetch(baseUrl, `/channels/${channelId}`, token);
  if (ok && data?.id) {
    return { name: data.name, displayName: data.display_name, teamId: data.team_id };
  }
  return null;
}

/** Get the teams the authenticated bot belongs to. */
export async function getMyTeams(baseUrl: string, token: string): Promise<MattermostTeamInfo[]> {
  const { ok, data } = await mmFetch(baseUrl, '/users/me/teams', token);
  if (!ok || !Array.isArray(data)) return [];
  return data.map((t: any) => ({ id: t.id, name: t.name, displayName: t.display_name }));
}

/** Look up a channel by name within a team. Returns null if not found. */
export async function getChannelByTeamAndName(
  baseUrl: string,
  token: string,
  teamId: string,
  channelName: string,
): Promise<MattermostChannelResult | null> {
  const { ok, data } = await mmFetch(baseUrl, `/teams/${teamId}/channels/name/${encodeURIComponent(channelName)}`, token);
  if (ok && data?.id) {
    return {
      id: data.id,
      name: data.name,
      displayName: data.display_name,
      teamId: data.team_id,
      isNew: false,
    };
  }
  return null;
}

/** Create a public channel in Mattermost, including optional purpose and header. */
export async function createMattermostChannel(
  baseUrl: string,
  token: string,
  opts: {
    teamId: string;
    name: string;
    displayName: string;
    purpose?: string;
    header?: string;
    private?: boolean;
  },
): Promise<{ result: CheckResult; channel?: MattermostChannelResult }> {
  const { ok, status, data } = await mmPost(baseUrl, '/channels', token, {
    team_id: opts.teamId,
    name: opts.name,
    display_name: opts.displayName,
    type: opts.private ? 'P' : 'O',
    purpose: opts.purpose ?? '',
    header: opts.header ?? '',
  });

  if (ok && data?.id) {
    return {
      result: { status: 'pass', label: `Channel "${opts.name}"`, detail: 'created' },
      channel: {
        id: data.id,
        name: data.name,
        displayName: data.display_name,
        teamId: data.team_id,
        isNew: true,
      },
    };
  }

  const errMsg = data?.message || `HTTP ${status}`;
  return {
    result: { status: 'fail', label: `Channel "${opts.name}"`, detail: errMsg },
  };
}

/** Add a user (bot) to a channel by user ID. Returns a pass result even if already a member. */
export async function addBotToChannel(
  baseUrl: string,
  token: string,
  channelId: string,
  userId: string,
): Promise<CheckResult> {
  const { ok, status, data } = await mmPost(baseUrl, `/channels/${channelId}/members`, token, { user_id: userId });
  if (ok) {
    return { status: 'pass', label: `Channel membership`, detail: 'bot added to channel' };
  }
  // 400 with "already_member" or similar — still a success
  if (status === 400 && (data?.id === 'api.channel.add_member.idempotent' || data?.message?.toLowerCase().includes('already'))) {
    return { status: 'pass', label: `Channel membership`, detail: 'already a member' };
  }
  return { status: 'warn', label: `Channel membership`, detail: data?.message || `HTTP ${status}` };
}

/**
 * The standard agent0 channel set.
 * These channels are created by `createAgentChannelStructure` during init.
 */
export const AGENT0_CHANNELS: AgentChannelDef[] = [
  {
    name: 'morning-briefing',
    displayName: 'Morning Briefing',
    purpose: 'Daily briefing — calendar, email highlights, prep links',
    header: 'Daily briefing: calendar summary, email highlights, and preparation links for the day ahead.',
  },
  {
    name: 'email-digest',
    displayName: 'Email Digest',
    purpose: 'Filtered email summaries (TO-me only, skip DL noise)',
    header: 'Filtered email summaries — direct messages only, distribution list noise filtered out.',
  },
  {
    name: 'calendar',
    displayName: 'Calendar',
    purpose: 'Today/tomorrow schedule, meeting alerts',
    header: "Today's and tomorrow's schedule, upcoming meeting alerts and reminders.",
  },
  {
    name: 'account-prep',
    displayName: 'Account Prep',
    purpose: 'Pre-meeting briefings with Obsidian notes + email + Teams context',
    header: 'Pre-meeting briefings combining Obsidian notes, recent emails, and Teams conversation context.',
  },
  {
    name: 'accounts',
    displayName: 'Accounts',
    purpose: 'Account dashboard — pipeline, motions, contacts',
    header: 'Account dashboard: pipeline status, active motions, and key contacts.',
  },
  {
    name: 'tasks',
    displayName: 'Tasks',
    purpose: 'Action items extracted from meetings/emails',
    header: 'Action items and tasks extracted from meetings and emails.',
  },
  {
    name: 'agent0-logs',
    displayName: 'Agent0 Logs',
    purpose: 'Bot status, errors, job runs',
    header: 'Bot status updates, error notifications, and job run logs.',
  },
];
