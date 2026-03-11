/**
 * User-level access control for bot interactions.
 * Determines whether a user is allowed to interact with a bot based on access config.
 *
 * Two levels are supported:
 *   1. Platform-level — applies to all bots on a platform (takes precedence)
 *   2. Bot-level — per-bot override
 *
 * If the platform denies a user, the bot-level config cannot override that.
 *
 * SECURITY: When neither level is configured, access defaults to DENY.
 * If only one level is configured, that level decides alone.
 * Use mode: "open" to explicitly allow all users at a given level.
 */

import type { AccessConfig } from '../types.js';

/** Evaluate a single AccessConfig against a userId/username pair. */
function evaluateAccess(userId: string, username: string, access: AccessConfig): boolean {
  if (access.mode === 'open') return true;
  if (!access.users || access.users.length === 0) {
    return access.mode === 'blocklist';
  }
  const normalized = access.users.map(u => u.toLowerCase());
  const matched = normalized.includes(userId.toLowerCase()) || normalized.includes(username.toLowerCase());
  return access.mode === 'allowlist' ? matched : !matched;
}

/**
 * Check whether a user is allowed to interact with a bot.
 * Returns true if the user is permitted, false if denied.
 *
 * Matching is case-insensitive and checks both userId and username against the config entries.
 *
 * Resolution logic:
 *   - Neither configured → deny (secure by default)
 *   - Only platform configured → platform decides
 *   - Only bot configured → bot decides
 *   - Both configured → both must allow (platform checked first)
 *
 * @param botAccess - Bot-level access config
 * @param platformAccess - Platform-level access config (checked first, takes precedence)
 */
export function checkUserAccess(
  userId: string,
  username: string,
  botAccess: AccessConfig | undefined,
  platformAccess?: AccessConfig,
): boolean {
  const hasPlatform = !!platformAccess;
  const hasBot = !!botAccess;

  // Neither configured → deny (secure by default)
  if (!hasPlatform && !hasBot) return false;

  // Platform configured → must pass platform gate
  if (hasPlatform && !evaluateAccess(userId, username, platformAccess)) return false;

  // Bot configured → must pass bot gate
  if (hasBot && !evaluateAccess(userId, username, botAccess)) return false;

  return true;
}
