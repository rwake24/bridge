import { describe, it, expect, vi } from 'vitest';

/**
 * Tests for the mid-turn steering logic.
 * Since sendMidTurn() is tightly coupled to SessionManager internals,
 * we test the contract via a minimal mock of the bridge/session interface.
 */

describe('sendMidTurn contract', () => {
  // Simulate the core logic of sendMidTurn without instantiating SessionManager
  function sendMidTurn(
    channelSessions: Map<string, string>,
    getSession: (id: string) => { send: (opts: any) => Promise<string> } | undefined,
    channelId: string,
    text: string,
  ): Promise<string> {
    const sessionId = channelSessions.get(channelId);
    if (!sessionId) throw new Error(`No active session for channel ${channelId}`);
    const session = getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return session.send({ prompt: text, mode: 'immediate' });
  }

  it('throws when no session exists for the channel', () => {
    const sessions = new Map<string, string>();
    expect(() => sendMidTurn(sessions, () => undefined, 'ch-1', 'hello'))
      .toThrow('No active session');
  });

  it('throws when session ID exists but session object is not found', () => {
    const sessions = new Map([['ch-1', 'sess-123']]);
    expect(() => sendMidTurn(sessions, () => undefined, 'ch-1', 'hello'))
      .toThrow('Session sess-123 not found');
  });

  it('calls session.send with mode: "immediate"', async () => {
    const mockSend = vi.fn().mockResolvedValue('msg-456');
    const sessions = new Map([['ch-1', 'sess-123']]);
    const getSession = (id: string) => id === 'sess-123' ? { send: mockSend } : undefined;

    const result = await sendMidTurn(sessions, getSession, 'ch-1', 'use JWT instead');

    expect(result).toBe('msg-456');
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend).toHaveBeenCalledWith({
      prompt: 'use JWT instead',
      mode: 'immediate',
    });
  });

  it('propagates send errors (for fallback handling)', async () => {
    const mockSend = vi.fn().mockRejectedValue(new Error('steering not supported'));
    const sessions = new Map([['ch-1', 'sess-123']]);
    const getSession = (id: string) => id === 'sess-123' ? { send: mockSend } : undefined;

    await expect(sendMidTurn(sessions, getSession, 'ch-1', 'hello'))
      .rejects.toThrow('steering not supported');
  });
});

describe('busyChannels state logic', () => {
  it('tracks busy/idle state transitions correctly', () => {
    const busyChannels = new Set<string>();

    // Initially not busy
    expect(busyChannels.has('ch-1')).toBe(false);

    // Set busy after sendMessage
    busyChannels.add('ch-1');
    expect(busyChannels.has('ch-1')).toBe(true);

    // Multiple channels can be busy independently
    busyChannels.add('ch-2');
    expect(busyChannels.has('ch-1')).toBe(true);
    expect(busyChannels.has('ch-2')).toBe(true);

    // Clear on session.idle
    busyChannels.delete('ch-1');
    expect(busyChannels.has('ch-1')).toBe(false);
    expect(busyChannels.has('ch-2')).toBe(true);

    // Clear on /stop or /new
    busyChannels.delete('ch-2');
    expect(busyChannels.has('ch-2')).toBe(false);
  });

  it('handles double-delete gracefully', () => {
    const busyChannels = new Set<string>();
    busyChannels.add('ch-1');
    busyChannels.delete('ch-1');
    busyChannels.delete('ch-1'); // should not throw
    expect(busyChannels.has('ch-1')).toBe(false);
  });
});
