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
 * SECURITY: Missing access config defaults to DENY (allowlist with no users).
 * Use mode: "open" to explicitly allow all users.
 */

import type { AccessConfig } from '../types.js';

/** Default access config when none is specified: deny all (secure by default). */
const DEFAULT_ACCESS: AccessConfig = { mode: 'allowlist', users: [] };

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
 * Missing access config defaults to deny-all (secure by default).
 * Use mode: "open" to explicitly allow all users.
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
  if (!evaluateAccess(userId, username, platformAccess ?? DEFAULT_ACCESS)) return false;
  return evaluateAccess(userId, username, botAccess ?? DEFAULT_ACCESS);
}
