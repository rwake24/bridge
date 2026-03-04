# copilot-bridge

Bridge GitHub Copilot CLI to messaging platforms. Send messages from Mattermost (or other platforms) and get responses from Copilot sessions running on your machine.

> [!WARNING]
> This is all experimental.

## How It Works

```
Mattermost Channel → copilot-bridge → @github/copilot-sdk → Copilot CLI
     ↑                                                          ↓
     └──────────── streaming response (edit-in-place) ←─────────┘
```

Each configured channel maps to a Copilot session with a specific working directory, model, and optionally a custom agent. Messages are forwarded to the session, and responses stream back in real-time via edit-in-place message updates.

## Features

- **Multi-bot support** — Run multiple bot identities on the same platform (e.g., `@copilot` for code, `@bob` for notes)
- **Streaming responses** — Edit-in-place message updates with throttling
- **MCP server integration** — Auto-loads MCP servers from `~/.copilot/mcp-config.json` and installed plugins
- **Skills support** — Discovers skills from `~/.copilot/skills/`, `.github/skills/`, and `.agents/skills/`
- **Fuzzy model matching** — `/model opus` resolves to `claude-opus-4.6` (mobile-friendly)
- **Reasoning effort control** — `/reasoning high` for supported models
- **Interactive permissions** — Approve/deny tool use via chat, reactions, or `/autopilot`
- **Sub-agent visibility** — See when Copilot delegates to sub-agents
- **Persistent preferences** — Model, agent, verbose, permissions saved per-channel in SQLite

## Setup

1. **Prerequisites**: Node.js 20+, GitHub Copilot CLI installed and authenticated (`gh copilot --version`)
2. **Install dependencies**: `npm install`
3. **Configure**: Copy `config.sample.json` to `~/.copilot-bridge/config.json` and edit:
   - Set your Mattermost server URL and bot token(s)
   - Map channels to working directories
   - Config is also found in `./config.json` (cwd) or via `COPILOT_BRIDGE_CONFIG` env var
4. **Run**: `npx tsx src/index.ts`

### Running as a Service (macOS)

A launchd plist is provided for running on login:

```bash
cp scripts/com.copilot-bridge.plist ~/Library/LaunchAgents/
# Edit the plist to match your paths if needed
launchctl load ~/Library/LaunchAgents/com.copilot-bridge.plist
```

Update and restart: `./scripts/deploy.sh`

## Configuration

See `config.sample.json` for the full format. Key fields:

### Platforms

```json
{
  "platforms": {
    "mattermost": {
      "url": "https://chat.example.com",
      "bots": {
        "copilot": { "token": "BOT_TOKEN_1" },
        "bob": { "token": "BOT_TOKEN_2", "agent": "bob-agent" }
      }
    }
  }
}
```

### Channels

| Field | Description |
|-------|-------------|
| `id` | Mattermost channel ID |
| `platform` | Platform name (e.g., `mattermost`) |
| `bot` | Bot identity to use for this channel |
| `workingDirectory` | Local path for Copilot to work in |
| `model` | AI model (e.g., `claude-sonnet-4.6`) |
| `agent` | Custom agent name (optional) |
| `triggerMode` | `mention` (default) or `all` |
| `threadedReplies` | Use threaded replies (default: true) |

### Permissions

Config-level rules use CLI-compatible syntax:

```json
{
  "permissions": {
    "allow": ["read", "shell(ls)", "shell(cat)", "vault-search", "context7"],
    "deny": ["shell(rm)", "shell(git push)"],
    "allowUrls": ["docs.github.com", "stackoverflow.com"]
  }
}
```

- `"vault-search"` — allows all tools from that MCP server
- `"vault-search(search)"` — allows only the `search` tool
- `"shell(ls)"` — allows the `ls` command
- `/remember` in chat persists per-channel rules in SQLite (MCP rules save at server level)

## Chat Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a fresh session |
| `/model <name>` | Switch AI model (fuzzy match supported) |
| `/models` | List available models |
| `/agent <name>` | Switch custom agent (empty to deselect) |
| `/reasoning <level>` | Set reasoning effort (`low`/`medium`/`high`/`xhigh`) |
| `/verbose` | Toggle tool call visibility |
| `/status` | Show session info |
| `/approve` / `/deny` | Handle permission requests |
| `/remember` | Approve + persist the permission rule |
| `/autopilot` | Toggle auto-approve mode |
| `/help` | Show all commands |

## Architecture

```
src/
├── index.ts                    # Main orchestrator, event routing
├── config.ts                   # Config loading and validation
├── logger.ts                   # Structured logging (timestamp + level)
├── types.ts                    # Shared type definitions
├── core/
│   ├── bridge.ts               # CopilotClient wrapper
│   ├── session-manager.ts      # Session lifecycle, permissions, MCP/skill loading
│   ├── command-handler.ts      # Slash command parsing with fuzzy model matching
│   └── stream-formatter.ts     # SDK event → chat message formatting
├── channels/
│   └── mattermost/
│       ├── adapter.ts          # Mattermost WebSocket + REST adapter
│       └── streaming.ts        # Edit-in-place streaming with throttle
└── state/
    └── store.ts                # SQLite persistence (sessions, prefs, permissions)
```

The bridge uses a pluggable channel adapter pattern. Adding a new platform (Slack, Discord) means implementing the `ChannelAdapter` interface.

## Logging

Logs go to `/tmp/copilot-bridge.log` with structured format:

```
HH:mm:ss.SSS [LEVEL] [tag] message
```

## License

MIT
