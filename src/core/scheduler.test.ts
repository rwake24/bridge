import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JOB_PROMPTS, loadConfigJobs, describeCron, formatInTimezone, listAllJobs } from './scheduler.js';

// ---------------------------------------------------------------------------
// JOB_PROMPTS
// ---------------------------------------------------------------------------

describe('JOB_PROMPTS', () => {
  const EXPECTED_IDS = [
    'morning-briefing',
    'email-scan',
    'meeting-prep',
    'evening-recap',
    'weekly-pipeline',
  ];

  it('contains all five built-in job ids', () => {
    for (const id of EXPECTED_IDS) {
      expect(JOB_PROMPTS).toHaveProperty(id);
    }
  });

  it('each prompt is a non-empty string', () => {
    for (const id of EXPECTED_IDS) {
      const prompt = JOB_PROMPTS[id];
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(20);
    }
  });

  it('morning-briefing prompt covers calendar, emails, tasks, meeting prep', () => {
    const p = JOB_PROMPTS['morning-briefing'].toLowerCase();
    expect(p).toContain('calendar');
    expect(p).toContain('email');
    expect(p).toContain('task');
    expect(p).toContain('meeting');
  });

  it('email-scan prompt mentions WorkIQ and urgent', () => {
    const p = JOB_PROMPTS['email-scan'].toLowerCase();
    expect(p).toContain('workiq');
    expect(p).toContain('urgent');
  });

  it('meeting-prep prompt mentions account, obsidian, and workiq', () => {
    const p = JOB_PROMPTS['meeting-prep'].toLowerCase();
    expect(p).toContain('account');
    expect(p).toContain('obsidian');
    expect(p).toContain('workiq');
  });

  it('evening-recap prompt covers accomplished, open items, tomorrow', () => {
    const p = JOB_PROMPTS['evening-recap'].toLowerCase();
    expect(p).toMatch(/accomplished|today/);
    expect(p).toContain('tomorrow');
  });

  it('weekly-pipeline prompt covers accounts and renewals', () => {
    const p = JOB_PROMPTS['weekly-pipeline'].toLowerCase();
    expect(p).toContain('account');
    expect(p).toContain('renewal');
  });
});

// ---------------------------------------------------------------------------
// describeCron
// ---------------------------------------------------------------------------

describe('describeCron', () => {
  it('describes morning-briefing schedule', () => {
    const desc = describeCron('30 7 * * 1-5');
    expect(typeof desc).toBe('string');
    expect(desc.length).toBeGreaterThan(5);
  });

  it('returns the raw expression for invalid cron', () => {
    const bad = 'not-a-cron';
    expect(describeCron(bad)).toBe(bad);
  });
});

// ---------------------------------------------------------------------------
// formatInTimezone
// ---------------------------------------------------------------------------

describe('formatInTimezone', () => {
  it('formats an ISO timestamp without throwing', () => {
    const result = formatInTimezone('2026-03-19T07:30:00.000Z', 'America/Chicago');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(5);
  });

  it('normalizes SQLite-style datetime (space separator, no Z)', () => {
    const result = formatInTimezone('2026-03-19 07:30:00', 'America/Chicago');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// loadConfigJobs — unknown job id is skipped
// ---------------------------------------------------------------------------

describe('loadConfigJobs', () => {
  it('skips jobs with unknown ids without throwing', () => {
    expect(() =>
      loadConfigJobs([
        {
          id: 'totally-unknown-job',
          cron: '0 9 * * 1-5',
          channelId: 'ch-test',
          botName: 'copilot',
          enabled: true,
          timezone: 'UTC',
        },
      ])
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// listAllJobs — returns an array without throwing
// ---------------------------------------------------------------------------

describe('listAllJobs', () => {
  it('returns an array without throwing', () => {
    const result = listAllJobs();
    expect(Array.isArray(result)).toBe(true);
  });

  it('every returned task has channelId, id, and enabled fields', () => {
    const result = listAllJobs();
    for (const task of result) {
      expect(typeof task.id).toBe('string');
      expect(typeof task.channelId).toBe('string');
      expect(typeof task.enabled).toBe('boolean');
    }
  });
});
