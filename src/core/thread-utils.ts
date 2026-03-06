/**
 * Thread-aware reply utilities.
 *
 * Detects dynamic thread-request triggers (🧵 or "reply in thread") in message text,
 * strips them before forwarding, and resolves the thread root for a message.
 */

const THREAD_TRIGGER_RE = /(?:^|\s)(?:🧵|:thread:)(?:\s|$)/gi;
const THREAD_PHRASE_RE = /^\s*reply in thread\b\s*|\s*\breply in thread\s*$/gi;

/** Detect and strip dynamic thread-request triggers from message text. */
export function extractThreadRequest(text: string): { text: string; threadRequested: boolean } {
  const hasEmoji = THREAD_TRIGGER_RE.test(text);
  THREAD_TRIGGER_RE.lastIndex = 0;
  const hasPhrase = THREAD_PHRASE_RE.test(text);
  THREAD_PHRASE_RE.lastIndex = 0;

  const threadRequested = hasEmoji || hasPhrase;
  if (!threadRequested) return { text, threadRequested: false };

  let stripped = text;
  if (hasEmoji) stripped = stripped.replace(THREAD_TRIGGER_RE, ' ');
  THREAD_TRIGGER_RE.lastIndex = 0;
  if (hasPhrase) stripped = stripped.replace(THREAD_PHRASE_RE, ' ');
  THREAD_PHRASE_RE.lastIndex = 0;

  return { text: stripped.trim(), threadRequested: true };
}

/**
 * Resolve the thread root for a message.
 * Priority: user is already in a thread > dynamic trigger > channel config threadedReplies.
 */
export function resolveThreadRoot(
  msg: { threadRootId?: string; postId: string },
  threadRequested: boolean,
  channelConfig: { threadedReplies: boolean },
): string | undefined {
  if (msg.threadRootId) return msg.threadRootId;
  if (threadRequested || channelConfig.threadedReplies) return msg.postId;
  return undefined;
}
