# Telegram Agent Bridge (Post-MVP / Future)

## Summary

Build a Telegram bot bridge (inspired by [Takopi](https://github.com/banteg/takopi)) directly into Smithers, implemented in Zig. This enables mobile access to your coding agents — send tasks from your phone via Telegram, watch progress stream back live, and review results when you're back at the keyboard. This is our mobile story instead of building a native mobile app.

## Context

### Takopi Reference

[Takopi](https://banteg.xyz/posts/takopi/) by banteg is a Python CLI that bridges coding agents (Codex, Claude Code, OpenCode) to Telegram. Key concepts:

- **Telegram as universal interface** — send messages from any device, anywhere
- **Agent routing** — prefix messages with agent name to choose backend (e.g., `/codex refactor auth`)
- **Multi-project support** — register repos with `init`, target tasks at specific projects
- **Branch isolation** — work on feature branches using worktrees without disrupting main checkout
- **Live streaming** — real-time progress updates as the agent works
- **Voice notes** — dictate tasks via Telegram voice messages, auto-transcribed
- **File transfer** — upload files to repos or retrieve files/directories via the bot
- **Parallel execution** — multiple agent sessions with per-session queues
- **Three workflow modes**:
  - **Assistant**: Continuous chat, `/new` starts fresh
  - **Workspace**: Forum topics bound to specific repos/branches
  - **Handoff**: Independent tasks with terminal resume commands

### Why Build in Zig (Not Python)

- Smithers already uses Zig as its build system
- Single binary, no Python/pip dependency chain
- Can be bundled inside the `.app` or distributed standalone
- Low memory footprint for a background daemon
- Zig's HTTP and JSON libraries are mature enough for Telegram Bot API

### Why Build It In (Not Shell Out to Takopi)

- Tighter integration with Smithers workspace state
- Can trigger scheduled automations (issue 007)
- Can show Telegram messages in Smithers UI and vice versa
- Single process, no Python runtime needed
- Can use Smithers' existing Codex connection instead of spawning a separate agent CLI

## Requirements

### Core

1. Register a Telegram bot via @BotFather, configure token in Smithers settings
2. Long-poll or webhook the Telegram Bot API for incoming messages
3. Route incoming messages to Codex (or configured agent backend)
4. Stream agent responses back to the Telegram chat in real-time
5. Support text messages, voice notes (transcribe via Whisper or similar), and file uploads

### Multi-Project

1. Register projects: `/init ~/projects/myapp`
2. Target a project: `/myapp fix the login bug`
3. Default project for unqualified messages

### Branch Isolation

1. Use jj workspaces or git worktrees so Telegram-triggered agents don't interfere with local work
2. Each Telegram task gets its own branch/workspace
3. On completion, user can merge from Smithers or Telegram (`/merge`, `/diff`)

### Session Management

1. Continuous conversation mode by default (context carries forward)
2. `/new` starts a fresh session
3. `/status` shows running agents
4. `/cancel` stops a running agent

### Integration with Smithers

1. Telegram messages appear in a dedicated Smithers tab (optional)
2. Background agent results (issue 007) can notify via Telegram
3. Scheduled automation results (issue 007) can notify via Telegram
4. User can "hand off" a Telegram conversation to Smithers desktop (and vice versa)

## Implementation Notes

### Zig Components

- `telegram_bot.zig` — Telegram Bot API client (getUpdates, sendMessage, sendDocument, etc.)
- `message_router.zig` — Parse commands, route to correct project/agent
- `agent_runner.zig` — Spawn and manage Codex sessions, stream output
- `transcriber.zig` — Voice note transcription (call Whisper API or local whisper.cpp)
- `config.zig` — Read/write `~/.smithers/telegram.toml`

### Config

```toml
# ~/.smithers/telegram.toml
bot_token = "123456:ABC-DEF..."
allowed_users = [12345678]       # Telegram user IDs authorized to use the bot

[defaults]
agent = "codex"
project = "~/projects/myapp"

[[projects]]
name = "myapp"
path = "~/projects/myapp"
branch_prefix = "tg/"
```

### Architecture

```
Telegram ←→ [Zig Bot Daemon] ←→ [Codex / Agent Backend]
                    ↕
            [Smithers App] (optional UI integration)
```

The bot daemon can run:
- **Embedded** in Smithers (started/stopped with the app)
- **Standalone** as a system daemon (runs even when Smithers is closed)

## Post-MVP Status

This is explicitly **post-MVP**. It's listed here to document the vision and architecture. Prerequisites:

- Issue 007 (Background & Scheduled Agents) — shared infrastructure for running agents
- Stable Codex integration
- Zig build system maturity

## References

- [Takopi by banteg](https://github.com/banteg/takopi)
- [Takopi blog post](https://banteg.xyz/posts/takopi/)
- [Takopi docs](https://takopi.banteg.xyz/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
