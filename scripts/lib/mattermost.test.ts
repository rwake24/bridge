import { describe, it, expect } from 'vitest';
import { pingServer, validateBotToken, checkChannelAccess, getMyTeams, getChannelByTeamAndName, createMattermostChannel, addBotToChannel, AGENT0_CHANNELS } from './mattermost.js';

describe('mattermost validation', () => {
  describe('pingServer', () => {
    it('fails for unreachable server', async () => {
      const result = await pingServer('http://localhost:19999');
      expect(result.status).toBe('fail');
      expect(result.label).toContain('localhost:19999');
    });

    it('fails for invalid URL', async () => {
      const result = await pingServer('not-a-url');
      expect(result.status).toBe('fail');
    });
  });

  describe('validateBotToken', () => {
    it('fails for unreachable server', async () => {
      const { result } = await validateBotToken('http://localhost:19999', 'fake-token');
      expect(result.status).toBe('fail');
    });
  });

  describe('checkChannelAccess', () => {
    it('fails for unreachable server', async () => {
      const result = await checkChannelAccess('http://localhost:19999', 'fake-token', 'channel-id');
      expect(result.status).toBe('fail');
    });
  });

  describe('getMyTeams', () => {
    it('returns empty array for unreachable server', async () => {
      const teams = await getMyTeams('http://localhost:19999', 'fake-token');
      expect(teams).toEqual([]);
    });
  });

  describe('getChannelByTeamAndName', () => {
    it('returns null for unreachable server', async () => {
      const result = await getChannelByTeamAndName('http://localhost:19999', 'fake-token', 'team-id', 'channel-name');
      expect(result).toBeNull();
    });
  });

  describe('createMattermostChannel', () => {
    it('returns fail result for unreachable server', async () => {
      const { result } = await createMattermostChannel('http://localhost:19999', 'fake-token', {
        teamId: 'team-id',
        name: 'test-channel',
        displayName: 'Test Channel',
      });
      expect(result.status).toBe('fail');
    });
  });

  describe('addBotToChannel', () => {
    it('returns warn result for unreachable server', async () => {
      const result = await addBotToChannel('http://localhost:19999', 'fake-token', 'channel-id', 'user-id');
      expect(result.status).toBe('warn');
    });
  });

  describe('AGENT0_CHANNELS', () => {
    it('defines all 7 required channels', () => {
      const names = AGENT0_CHANNELS.map(c => c.name);
      expect(names).toContain('morning-briefing');
      expect(names).toContain('email-digest');
      expect(names).toContain('calendar');
      expect(names).toContain('account-prep');
      expect(names).toContain('accounts');
      expect(names).toContain('tasks');
      expect(names).toContain('bridge-logs');
      expect(AGENT0_CHANNELS).toHaveLength(7);
    });

    it('each channel has name, displayName, purpose, and header', () => {
      for (const ch of AGENT0_CHANNELS) {
        expect(ch.name).toBeTruthy();
        expect(ch.displayName).toBeTruthy();
        expect(ch.purpose).toBeTruthy();
        expect(ch.header).toBeTruthy();
      }
    });

    it('channel names are URL-safe lowercase with hyphens', () => {
      for (const ch of AGENT0_CHANNELS) {
        expect(ch.name).toMatch(/^[a-z0-9-]+$/);
      }
    });
  });
});
