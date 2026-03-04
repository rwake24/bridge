# Architecture

## Source layout

```
src/
├── index.ts                    # Main orchestrator, event routing, admin nudge
├── config.ts                   # Config loading and validation
├── logger.ts                   # Structured logging (timestamp + level + tag)
├── types.ts                    # Shared type definitions
├── core/
│   ├── bridge.ts               # CopilotClient wrapper (SDK interface)
│   ├── session-manager.ts      # Session lifecycle, permissions, MCP/skill loading, .env
│   ├── command-handler.ts      # Slash command parsing with fuzzy model matching
│   ├── stream-formatter.ts     # SDK event → chat message formatting
│   └── workspace-manager.ts    # Workspace creation, template rendering, directory sync
├── channels/
│   └── mattermost/
│       ├── adapter.ts          # Mattermost WebSocket + REST adapter
│       └── streaming.ts        # Edit-in-place streaming with throttle
└── state/
    └── store.ts                # SQLite persistence (sessions, prefs, permissions)
```

## Message flow

1. `MattermostAdapter` receives a WebSocket event and normalizes it to `InboundMessage`
2. `index.ts` serializes handling per channel via promise chains (`channelLocks`), checks for slash commands, then forwards to `SessionManager.sendMessage()`
3. `SessionManager` creates or resumes a `CopilotSession` via `CopilotBridge` (SDK wrapper), wiring up permission and user-input handlers
4. SDK session events flow back through `sessionManager.onSessionEvent()` → `handleSessionEvent()` in index.ts
5. `StreamFormatter` converts SDK events to `FormattedEvent`, which are routed to `StreamingHandler` for edit-in-place message updates

## Event serialization

Both inbound messages and session events are serialized per-channel via separate promise chains (`channelLocks` and `eventLocks`). This prevents race conditions on stream auto-start and permission resolution.

## Streaming

`StreamingHandler` manages edit-in-place messages with throttled updates (500ms):

- One stream is created per user message; it persists across tool cycles
- Streams finalize only on `session.idle` (not `turn_end`, which fires between tool cycles)
- In verbose mode, tool calls accumulate in a separate "activity feed" message that updates in place

## Channel adapter pattern

New platforms implement the `ChannelAdapter` interface (defined in `src/types.ts`). The Mattermost adapter is the reference implementation. Required methods:

- `connect()` / `disconnect()` — WebSocket lifecycle
- `sendMessage()` / `editMessage()` / `deleteMessage()` — Message operations
- `addReaction()` / `setTyping()` — UX indicators
- `onMessage` — Callback for inbound messages

## Persistence

SQLite database at `~/.copilot-bridge/state.db` (WAL mode) via `src/state/store.ts`:

- **channel_sessions** — Maps channels to active Copilot session IDs
- **channel_prefs** — Per-channel preferences (model, verbose, agent, etc.)
- **permission_rules** — Stored allow/deny rules from `/remember`

## Logging

Logs are written to stdout/stderr via `console.log`/`console.error`:

```
HH:mm:ss.SSS [LEVEL] [tag] message
```

Use `createLogger(tag)` from `src/logger.ts`. Tags identify the subsystem (e.g., `bridge`, `session`, `mattermost`, `streaming`).

The log *destination* depends on how you launch the bridge:
- **launchd**: Configured via `StandardOutPath`/`StandardErrorPath` in the plist (default: `/tmp/copilot-bridge.log`)
- **Direct**: Logs go to your terminal
- **Redirect**: `npx tsx src/index.ts >> /var/log/copilot-bridge.log 2>&1`
