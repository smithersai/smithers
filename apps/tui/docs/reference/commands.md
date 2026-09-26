---
title: Command reference
description: Every built-in slash command and its guide.
order: 20
section: Reference
---

Type `/` to browse commands. Up/Down choose, Tab completes, Enter invokes, and Esc dismisses. Commands with required arguments leave the composer ready for those arguments.

```tui-script command-reference
Use "basic"
Type "/"
Capture "Browse the command menu."
Press Escape
Press Ctrl+C
Type "/hotkeys"
Press Enter
Capture "Print the complete contextual key list into the transcript."
```

| Command | Action | Details |
| --- | --- | --- |
| `/model [query]` | Pick a model. | [Guide](../guides/models.md) |
| `/theme` | Pick a theme. | [Guide](../guides/appearance.md) |
| `/thinking [level]` | Set the reasoning effort. | [Guide](../guides/models.md) |
| `/new` | Start a new session. | [Guide](../guides/sessions.md) |
| `/resume` | Resume a session. | [Guide](../guides/sessions.md) |
| `/fork` | Fork from an earlier message. | [Guide](../guides/sessions.md) |
| `/session` | Show the session file and tokens. | [Guide](../guides/sessions.md) |
| `/compact` | Drop the oldest context. | [Guide](../guides/sessions.md) |
| `/name <name>` | Name this session. | [Guide](../guides/sessions.md) |
| `/copy` | Copy the last answer. | [Guide](../guides/chat.md) |
| `/summary` | Review this conversation. | [Guide](../guides/review-changes.md) |
| `/tabs` | Review background work. | [Guide](../guides/background-work.md) |
| `/chat` | Return to chat. | [Guide](../guides/appearance.md) |
| `/filter` | Show or hide workers and kinds of rows. | [Guide](../guides/appearance.md) |
| `/grep [text]` | Show only rows containing text. | [Guide](../guides/appearance.md) |
| `/ui [id]` | Open a custom view. | [Guide](../automation/views.md) |
| `/smithers` | Flows and runs. | [Guide](../automation/flows.md) |
| `/flows` | Run a flow. | [Guide](../automation/flows.md) |
| `/flow <name> [json\|key=value]` | Run a flow. | [Guide](../automation/flows.md) |
| `/agent [name] [prompt]` | Run a custom agent. | [Guide](../automation/agents.md) |
| `/retry <id>` | Retry a stopped worker or flow. | [Guide](../guides/background-work.md) |
| `/stop <id>` | Stop a worker or flow. | [Guide](../guides/background-work.md) |
| `/hotkeys` | Show the keys. | [Guide](./keys.md) |
| `/quit` | Quit. | [Guide](./cli.md) |
| `/exit` | Alias for `/quit`. | [Guide](./cli.md) |

Repository flows also appear in the command menu. `/model`, `/thinking`, `/flow`, and `/agent` complete arguments. Prefix a shell command with `!` to add its output to context, or `!!` to keep it out; see [shell commands](../guides/shell.md).
