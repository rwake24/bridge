import { createHash } from 'node:crypto';
import { createLogger } from '../logger.js';

const log = createLogger('loop-detector');

/** Number of identical tool calls within the window before flagging a loop. */
export const MAX_IDENTICAL_CALLS = 5;

/** Only count calls within this time window (ms). */
export const WINDOW_MS = 60_000;

/** Maximum tool call entries to keep per channel. */
export const MAX_HISTORY = 50;

/**
 * Multiplier applied to MAX_IDENTICAL_CALLS. When the count reaches this
 * threshold, the loop is considered critical and the session should be destroyed.
 */
export const CRITICAL_MULTIPLIER = 2;

interface ToolCall {
  argsHash: string;
  timestamp: number;
}

export interface LoopDetectionResult {
  isLoop: boolean;
  count: number;
  /** True when count >= MAX_IDENTICAL_CALLS * CRITICAL_MULTIPLIER */
  isCritical: boolean;
}

/**
 * Tracks recent tool calls per channel and detects when the same tool is
 * called with identical arguments repeatedly -- a sign the agent is stuck.
 */
export class LoopDetector {
  private history = new Map<string, ToolCall[]>();

  /**
   * Record a tool call and check for loops.
   *
   * @returns Detection result indicating whether a loop (or critical loop) was found.
   */
  recordToolCall(channelId: string, toolName: string, args: unknown): LoopDetectionResult {
    const hash = this.hashCall(toolName, args);
    const now = Date.now();

    let calls = this.history.get(channelId);
    if (!calls) {
      calls = [];
      this.history.set(channelId, calls);
    }

    calls.push({ argsHash: hash, timestamp: now });
    this.cleanup(channelId);

    // Re-read after cleanup (cleanup may replace the array)
    const current = this.history.get(channelId) ?? [];
    const count = current.filter(c => c.argsHash === hash).length;
    const isLoop = count >= MAX_IDENTICAL_CALLS;
    const isCritical = count >= MAX_IDENTICAL_CALLS * CRITICAL_MULTIPLIER;

    if (isLoop) {
      log.warn(
        `Loop detected on channel ${channelId.slice(0, 8)}...: ` +
        `tool="${toolName}" called ${count} times` +
        (isCritical ? ' (CRITICAL)' : ''),
      );
    }

    return { isLoop, count, isCritical };
  }

  /** Clear all history for a channel (e.g., on /new or session change). */
  reset(channelId: string): void {
    this.history.delete(channelId);
  }

  /** Remove entries outside the time window and cap to MAX_HISTORY. */
  private cleanup(channelId: string): void {
    const calls = this.history.get(channelId);
    if (!calls) return;

    const cutoff = Date.now() - WINDOW_MS;
    const filtered = calls.filter(c => c.timestamp >= cutoff);

    // Cap total entries to prevent unbounded growth
    if (filtered.length > MAX_HISTORY) {
      filtered.splice(0, filtered.length - MAX_HISTORY);
    }

    if (filtered.length === 0) {
      this.history.delete(channelId);
    } else {
      this.history.set(channelId, filtered);
    }
  }

  /** Produce a deterministic hash for a tool name + arguments pair. */
  private hashCall(toolName: string, args: unknown): string {
    const payload = toolName + '\0' + stableStringify(args);
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }
}

/**
 * Canonical JSON.stringify with sorted object keys so equivalent objects hash
 * identically regardless of property insertion order, while preserving
 * proper JSON quoting and escaping for all values.
 */
function stableStringify(value: unknown): string {
  const json = JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        sorted[key] = obj[key];
      }
      return sorted;
    }
    return val;
  });
  return json === undefined ? 'undefined' : json;
}
