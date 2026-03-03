# copilot-bridge

Bridge GitHub Copilot CLI to messaging platforms. Send messages from Mattermost (or other platforms) and get responses from Copilot sessions running on your machine.

## How It Works

```
Mattermost Channel → copilot-bridge → @github/copilot-sdk → Copilot CLI
     ↑                                                          ↓
     └──────────── streaming response (edit-in-place) ←─────────┘
```

Each configured channel maps to a Copilot session with a specific working directory, model, and optionally a custom agent. Messages are forwarded to the session, and responses stream back in real-time via edit-in-place message updates.

## Setup

1. **Prerequisites**: GitHub Copilot CLI installed and authenticated (`copilot --version`)
2. **Install dependencies**: `npm install`
3. **Configure**: Copy `config.sample.json` to `config.json` and edit:
   - Set your Mattermost server URL and bot token
   - Map channels to working directories
4. **Run**: `npm run dev` (development) or `npm start` (production)

## Configuration

See `config.sample.json` for the full format. Key fields per channel:

| Field | Description |
|-------|-------------|
| `id` | Mattermost channel ID |
| `workingDirectory` | Local path for Copilot to work in |
| `model` | AI model (e.g., `claude-sonnet-4.6`) |
| `agent` | Custom agent name (optional) |
| `triggerMode` | `mention` (default) or `all` |
| `threadedReplies` | Use threaded replies (default: true) |
| `verbose` | Show tool calls (default: false) |

## Chat Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a fresh session |
| `/model <name>` | Switch AI model |
| `/agent <name>` | Switch custom agent |
| `/verbose` | Toggle tool call visibility |
| `/status` | Show session info |
| `/approve` / `/deny` | Handle permission requests |
| `/autopilot` | Toggle auto-approve mode |
| `/help` | Show all commands |

## Permissions

When Copilot needs to run a command or edit a file, the bridge surfaces the request in chat. You can:
- Reply `/approve` or `/deny`
- React with 👍 or 👎
- Reply "yes" or "no" naturally
- Use `/autopilot` to auto-approve everything
- Permissions for specific commands (e.g., `ls`, `grep`) are remembered individually per channel

## Architecture

The bridge uses a pluggable channel adapter pattern:

- **Core**: Session management, command handling, permission system
- **Adapters**: Platform-specific (Mattermost, future: Slack, Discord)
- **Streaming**: Edit-in-place message updates with throttling
- **State**: SQLite persistence for sessions, preferences, and permission rules

## Development

```bash
npm run dev      # Start with hot reload
npm run build    # Compile TypeScript
npm run test     # Run tests
```
