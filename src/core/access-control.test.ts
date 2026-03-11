import { describe, it, expect } from 'vitest';
import { checkUserAccess } from './access-control.js';
import type { AccessConfig } from '../types.js';

describe('checkUserAccess', () => {
  const OPEN: AccessConfig = { mode: 'open' };

  // --- Secure by default ---
  it('denies all users when access is undefined (secure default)', () => {
    expect(checkUserAccess('U123', 'alice', undefined)).toBe(false);
  });

  it('allows all users in open mode', () => {
    expect(checkUserAccess('U123', 'alice', OPEN, OPEN)).toBe(true);
  });

  // --- Allowlist (bot-level, with open platform) ---
  it('allows listed user by username', () => {
    const access: AccessConfig = { mode: 'allowlist', users: ['alice', 'bob'] };
    expect(checkUserAccess('U123', 'alice', access, OPEN)).toBe(true);
  });

  it('allows listed user by userId', () => {
    const access: AccessConfig = { mode: 'allowlist', users: ['U123'] };
    expect(checkUserAccess('U123', 'unknown', access, OPEN)).toBe(true);
  });

  it('denies unlisted user in allowlist mode', () => {
    const access: AccessConfig = { mode: 'allowlist', users: ['alice'] };
    expect(checkUserAccess('U999', 'eve', access, OPEN)).toBe(false);
  });

  it('is case-insensitive for allowlist', () => {
    const access: AccessConfig = { mode: 'allowlist', users: ['Alice'] };
    expect(checkUserAccess('U123', 'alice', access, OPEN)).toBe(true);
    expect(checkUserAccess('U123', 'ALICE', access, OPEN)).toBe(true);
  });

  it('denies all users when allowlist has no users', () => {
    const access: AccessConfig = { mode: 'allowlist', users: [] };
    expect(checkUserAccess('U123', 'alice', access, OPEN)).toBe(false);
  });

  it('denies all users when allowlist users is undefined', () => {
    const access: AccessConfig = { mode: 'allowlist' };
    expect(checkUserAccess('U123', 'alice', access, OPEN)).toBe(false);
  });

  // --- Blocklist (bot-level, with open platform) ---
  it('blocks listed user in blocklist mode', () => {
    const access: AccessConfig = { mode: 'blocklist', users: ['spambot'] };
    expect(checkUserAccess('U999', 'spambot', access, OPEN)).toBe(false);
  });

  it('allows unlisted user in blocklist mode', () => {
    const access: AccessConfig = { mode: 'blocklist', users: ['spambot'] };
    expect(checkUserAccess('U123', 'alice', access, OPEN)).toBe(true);
  });

  it('blocks by userId in blocklist mode', () => {
    const access: AccessConfig = { mode: 'blocklist', users: ['U999'] };
    expect(checkUserAccess('U999', 'unknown', access, OPEN)).toBe(false);
  });

  it('is case-insensitive for blocklist', () => {
    const access: AccessConfig = { mode: 'blocklist', users: ['SpamBot'] };
    expect(checkUserAccess('U999', 'spambot', access, OPEN)).toBe(false);
  });

  it('allows all users when blocklist has no users', () => {
    const access: AccessConfig = { mode: 'blocklist', users: [] };
    expect(checkUserAccess('U123', 'alice', access, OPEN)).toBe(true);
  });

  it('allows all users when blocklist users is undefined', () => {
    const access: AccessConfig = { mode: 'blocklist' };
    expect(checkUserAccess('U123', 'alice', access, OPEN)).toBe(true);
  });

  // --- Edge cases ---
  it('matches Slack UID in allowlist', () => {
    const access: AccessConfig = { mode: 'allowlist', users: ['U12345ABC'] };
    expect(checkUserAccess('U12345ABC', 'U12345ABC', access, OPEN)).toBe(true);
  });

  it('matches Mattermost username in allowlist', () => {
    const access: AccessConfig = { mode: 'allowlist', users: ['chris'] };
    expect(checkUserAccess('abc123', 'chris', access, OPEN)).toBe(true);
  });

  it('does not match partial username', () => {
    const access: AccessConfig = { mode: 'allowlist', users: ['chris'] };
    expect(checkUserAccess('U123', 'christopher', access, OPEN)).toBe(false);
  });

  // --- Platform-level access (takes precedence) ---
  it('platform allowlist denies user even if bot allows', () => {
    const platformAccess: AccessConfig = { mode: 'allowlist', users: ['admin'] };
    const botAccess: AccessConfig = { mode: 'open' };
    expect(checkUserAccess('U123', 'alice', botAccess, platformAccess)).toBe(false);
  });

  it('platform allowlist allows user, then bot allowlist is checked', () => {
    const platformAccess: AccessConfig = { mode: 'allowlist', users: ['alice'] };
    const botAccess: AccessConfig = { mode: 'allowlist', users: ['alice'] };
    expect(checkUserAccess('U123', 'alice', botAccess, platformAccess)).toBe(true);
  });

  it('platform allows but bot denies', () => {
    const platformAccess: AccessConfig = { mode: 'allowlist', users: ['alice'] };
    const botAccess: AccessConfig = { mode: 'allowlist', users: ['bob'] };
    expect(checkUserAccess('U123', 'alice', botAccess, platformAccess)).toBe(false);
  });

  it('platform blocklist blocks user regardless of bot config', () => {
    const platformAccess: AccessConfig = { mode: 'blocklist', users: ['spambot'] };
    const botAccess: AccessConfig = { mode: 'open' };
    expect(checkUserAccess('U999', 'spambot', botAccess, platformAccess)).toBe(false);
  });

  it('platform open + bot allowlist = bot decides', () => {
    const platformAccess: AccessConfig = { mode: 'open' };
    const botAccess: AccessConfig = { mode: 'allowlist', users: ['alice'] };
    expect(checkUserAccess('U123', 'alice', botAccess, platformAccess)).toBe(true);
    expect(checkUserAccess('U999', 'eve', botAccess, platformAccess)).toBe(false);
  });

  it('undefined platform + bot allowlist = bot decides', () => {
    const botAccess: AccessConfig = { mode: 'allowlist', users: ['alice'] };
    expect(checkUserAccess('U123', 'alice', botAccess, undefined)).toBe(true);
    expect(checkUserAccess('U999', 'eve', botAccess, undefined)).toBe(false);
  });

  it('open platform + bot allowlist = bot decides', () => {
    const platformAccess: AccessConfig = { mode: 'open' };
    const botAccess: AccessConfig = { mode: 'allowlist', users: ['alice'] };
    expect(checkUserAccess('U123', 'alice', botAccess, platformAccess)).toBe(true);
    expect(checkUserAccess('U999', 'eve', botAccess, platformAccess)).toBe(false);
  });

  it('platform allowlist + undefined bot = platform decides', () => {
    const platformAccess: AccessConfig = { mode: 'allowlist', users: ['alice'] };
    expect(checkUserAccess('U123', 'alice', undefined, platformAccess)).toBe(true);
    expect(checkUserAccess('U999', 'eve', undefined, platformAccess)).toBe(false);
  });

  it('platform allowlist + open bot = platform decides', () => {
    const platformAccess: AccessConfig = { mode: 'allowlist', users: ['alice'] };
    const botAccess: AccessConfig = { mode: 'open' };
    expect(checkUserAccess('U123', 'alice', botAccess, platformAccess)).toBe(true);
    expect(checkUserAccess('U999', 'eve', botAccess, platformAccess)).toBe(false);
  });

  it('both undefined = deny all (secure default)', () => {
    expect(checkUserAccess('U123', 'anyone', undefined, undefined)).toBe(false);
  });
});
