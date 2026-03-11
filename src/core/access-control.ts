/**
 * User-level access control for bot interactions.
 * Determines whether a user is allowed to interact with a bot based on access config.
 *
 * Two levels are supported:
 *   1. Platform-level — applies to all bots on a platform (takes precedence)
 *   2. Bot-level — per-bot override
 *
 * If the platform denies a user, the bot-level config cannot override that.
 */

import type { AccessConfig } from '../types.js';

/** Evaluate a single AccessConfig against a userId/username pair. */
function evaluateAccess(userId: string, username: string, access: AccessConfig | undefined): boolean {
  if (!access || access.mode === 'open') return true;
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
 * When access is undefined or mode is "open", all users are permitted.
 *
 * @param platformAccess - Platform-level access config (checked first, takes precedence)
 * @param botAccess - Bot-level access config (checked second)
 */
export function checkUserAccess(
  userId: string,
  username: string,
  botAccess: AccessConfig | undefined,
  platformAccess?: AccessConfig,
): boolean {
  // Platform takes precedence — if it denies, stop.
  if (!evaluateAccess(userId, username, platformAccess)) return false;
  return evaluateAccess(userId, username, botAccess);
}
