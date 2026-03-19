import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadAccounts,
  getAccounts,
  hasAccounts,
  findAccount,
  filterByMotion,
  filterByPriority,
  getUpcomingRenewals,
  formatPipelineView,
  formatAccountDetail,
  formatRenewalAlerts,
  _resetAccounts,
  type Account,
} from './accounts.js';

// Sample account data for tests
const SAMPLE_ACCOUNTS: Account[] = [
  {
    name: 'Orrick',
    motions: ['SQL PAYG'],
    monthlyPotential: 21500,
    renewalDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    priority: 'urgent',
    serverCount: 340,
    defendedServers: 0,
    ae: 'Jane Smith',
    ssp: 'Bob Lee',
    notes: 'Renewal risk',
  },
  {
    name: 'McKinsey',
    motions: ['SA Reclass'],
    monthlyPotential: 72600,
    renewalDate: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    priority: 'whale',
    serverCount: 1200,
    defendedServers: 400,
  },
  {
    name: 'HDR',
    motions: ['Defender'],
    monthlyPotential: 25500,
    priority: 'high',
    serverCount: 1699,
    defendedServers: 0,
  },
  {
    name: 'Reed Smith',
    motions: ['Defender', 'SQL PAYG'],
    monthlyPotential: 12000,
    priority: 'normal',
    serverCount: 210,
    defendedServers: 80,
  },
];

describe('loadAccounts', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetAccounts();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-test-'));
  });

  afterEach(() => {
    _resetAccounts();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads accounts from a valid JSON file', () => {
    fs.writeFileSync(path.join(tmpDir, 'accounts.json'), JSON.stringify(SAMPLE_ACCOUNTS));
    loadAccounts(tmpDir);
    expect(getAccounts()).toHaveLength(4);
    expect(getAccounts()[0].name).toBe('Orrick');
  });

  it('is a no-op when accounts.json is absent', () => {
    loadAccounts(tmpDir);
    expect(getAccounts()).toHaveLength(0);
    expect(hasAccounts()).toBe(false);
  });

  it('handles malformed JSON gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, 'accounts.json'), 'not-json{');
    loadAccounts(tmpDir);
    expect(getAccounts()).toHaveLength(0);
  });

  it('handles non-array JSON gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, 'accounts.json'), '{"name":"Orrick"}');
    loadAccounts(tmpDir);
    expect(getAccounts()).toHaveLength(0);
  });
});

describe('findAccount', () => {
  beforeEach(() => {
    _resetAccounts();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-test-'));
    fs.writeFileSync(path.join(tmpDir, 'accounts.json'), JSON.stringify(SAMPLE_ACCOUNTS));
    loadAccounts(tmpDir);
  });

  afterEach(() => {
    _resetAccounts();
  });

  it('finds by exact name (case-insensitive)', () => {
    expect(findAccount('orrick')?.name).toBe('Orrick');
    expect(findAccount('ORRICK')?.name).toBe('Orrick');
  });

  it('finds by substring', () => {
    expect(findAccount('orr')?.name).toBe('Orrick');
  });

  it('finds multi-word name by partial', () => {
    expect(findAccount('reed')?.name).toBe('Reed Smith');
  });

  it('returns null for no match', () => {
    expect(findAccount('nonexistent')).toBeNull();
  });
});

describe('filterByMotion', () => {
  beforeEach(() => {
    _resetAccounts();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-test-'));
    fs.writeFileSync(path.join(tmpDir, 'accounts.json'), JSON.stringify(SAMPLE_ACCOUNTS));
    loadAccounts(tmpDir);
  });

  afterEach(() => {
    _resetAccounts();
  });

  it('filters by motion substring', () => {
    const results = filterByMotion('Defender');
    expect(results.map(a => a.name)).toEqual(expect.arrayContaining(['HDR', 'Reed Smith']));
    expect(results.every(a => a.motions.some(m => m.toLowerCase().includes('defender')))).toBe(true);
  });

  it('returns empty array when no match', () => {
    expect(filterByMotion('NoSuchMotion')).toHaveLength(0);
  });
});

describe('filterByPriority', () => {
  beforeEach(() => {
    _resetAccounts();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-test-'));
    fs.writeFileSync(path.join(tmpDir, 'accounts.json'), JSON.stringify(SAMPLE_ACCOUNTS));
    loadAccounts(tmpDir);
  });

  afterEach(() => {
    _resetAccounts();
  });

  it('filters by exact priority', () => {
    expect(filterByPriority('urgent').map(a => a.name)).toEqual(['Orrick']);
    expect(filterByPriority('whale').map(a => a.name)).toEqual(['McKinsey']);
    expect(filterByPriority('high').map(a => a.name)).toEqual(['HDR']);
  });

  it('returns empty array for unknown priority', () => {
    expect(filterByPriority('legendary')).toHaveLength(0);
  });
});

describe('getUpcomingRenewals', () => {
  beforeEach(() => {
    _resetAccounts();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-test-'));
    fs.writeFileSync(path.join(tmpDir, 'accounts.json'), JSON.stringify(SAMPLE_ACCOUNTS));
    loadAccounts(tmpDir);
  });

  afterEach(() => {
    _resetAccounts();
  });

  it('returns accounts renewing within window', () => {
    // Orrick renews in ~20 days, McKinsey in ~120 days
    const in30 = getUpcomingRenewals(30);
    expect(in30.map(a => a.name)).toContain('Orrick');
    expect(in30.map(a => a.name)).not.toContain('McKinsey');
  });

  it('returns both accounts when window is large enough', () => {
    const in180 = getUpcomingRenewals(180);
    expect(in180.map(a => a.name)).toContain('Orrick');
    expect(in180.map(a => a.name)).toContain('McKinsey');
  });

  it('excludes accounts without renewal date', () => {
    const results = getUpcomingRenewals(365);
    expect(results.map(a => a.name)).not.toContain('HDR');
  });
});

describe('formatPipelineView', () => {
  afterEach(() => {
    _resetAccounts();
  });

  it('returns no-data message when no accounts loaded', () => {
    _resetAccounts();
    expect(formatPipelineView()).toContain('No account data loaded');
  });

  it('includes header with count and motions', () => {
    _resetAccounts();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-test-'));
    fs.writeFileSync(path.join(tmpDir, 'accounts.json'), JSON.stringify(SAMPLE_ACCOUNTS));
    loadAccounts(tmpDir);
    const view = formatPipelineView();
    expect(view).toContain('Pipeline Overview');
    expect(view).toContain('4 Accounts');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('groups accounts by priority with correct emoji labels', () => {
    _resetAccounts();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-test-'));
    fs.writeFileSync(path.join(tmpDir, 'accounts.json'), JSON.stringify(SAMPLE_ACCOUNTS));
    loadAccounts(tmpDir);
    const view = formatPipelineView();
    expect(view).toContain('🔴 URGENT');
    expect(view).toContain('🐋 WHALE');
    expect(view).toContain('🟡 HIGH');
    expect(view).toContain('🟢 NORMAL');
    expect(view).toContain('Orrick');
    expect(view).toContain('McKinsey');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('formatAccountDetail', () => {
  it('includes name, motions, monthly potential, and renewal', () => {
    const a: Account = {
      name: 'Orrick',
      motions: ['SQL PAYG'],
      monthlyPotential: 21500,
      renewalDate: '2025-05-31',
      priority: 'urgent',
      serverCount: 340,
      defendedServers: 0,
      ae: 'Jane',
      ssp: 'Bob',
      notes: 'Test note',
    };
    const detail = formatAccountDetail(a);
    expect(detail).toContain('Orrick');
    expect(detail).toContain('SQL PAYG');
    expect(detail).toContain('$21.5K');
    expect(detail).toContain('🔴 URGENT');
    expect(detail).toContain('AE: Jane');
    expect(detail).toContain('SSP: Bob');
    expect(detail).toContain('340');
    expect(detail).toContain('Test note');
  });
});

describe('formatRenewalAlerts', () => {
  afterEach(() => {
    _resetAccounts();
  });

  it('returns no-renewal message when none found', () => {
    _resetAccounts();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-test-'));
    const noRenewalAccounts: Account[] = [{ name: 'Acme', motions: [] }];
    fs.writeFileSync(path.join(tmpDir, 'accounts.json'), JSON.stringify(noRenewalAccounts));
    loadAccounts(tmpDir);
    expect(formatRenewalAlerts(30)).toContain('No renewals');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists accounts with upcoming renewals', () => {
    _resetAccounts();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-test-'));
    fs.writeFileSync(path.join(tmpDir, 'accounts.json'), JSON.stringify(SAMPLE_ACCOUNTS));
    loadAccounts(tmpDir);
    const alert = formatRenewalAlerts(30);
    expect(alert).toContain('Orrick');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
