---
title: Save, resume, and fork
description: Return to work without discarding the original conversation.
order: 8
section: Use the TUI
---

Sessions save messages, model events, worker requests, custom views, and flow run references. Give useful sessions a name so they are easy to find.

## Name and inspect

```tui-script session-details
Use "basic"
Type "Explain the addition function."
Press Enter
Wait for answer "Ready."
Type "/name Addition review"
Press Enter
Type "/session"
Press Enter
Wait for "exchanges"
Capture "Name the session and inspect its file, log, and token counts."
```

`/session` shows the session path, log path, exchange count, input/output tokens, and cached tokens. Naming changes the picker label; it does not create another conversation.

## Resume saved work

Use `bun run tui -c` for the latest session in this directory, `bun run tui -r` for the picker, or `/resume` inside the TUI. **Ctrl+K**, then `session:`, searches the same saved sessions.

```tui-script resume-session
Use "basic"
Type "Explain the addition function."
Press Enter
Wait for answer "Ready."
Type "/name Addition review"
Press Enter
Restart
Wait for answer "Ready."
Capture "Restart the real TUI with -c and restore the saved conversation."
Type "/new"
Press Enter
Wait for "New session started"
Type "/resume"
Press Enter
Wait for "Addition review"
Capture "Choose a named session from the resume picker."
Press Enter
Wait for answer "Ready."
Capture "Continue the original conversation."
```

Running and waiting workers relaunch from recorded work; parked workers resume at their provider reset. Flow runs retain their durable run IDs; unfinished runs appear interrupted and can be retried. A restored request is not a completion receipt.

## Fork a conversation

```tui-script fork-session
Use "basic"
Type "Explain the addition function."
Press Enter
Wait for answer "Ready."
Type "/fork"
Press Enter
Wait for "Explain the addition"
Capture "Choose the message where the conversation should branch."
Press Enter
Capture "Start a new session with the selected message in the editor."
```

`/fork` copies the conversation before the chosen message, then puts that message back in the composer. The original session remains in `/resume`. It does not restore files; use [captured edit undo](./review-changes.md) or [browser checkpoints](./playground.md) for those operations.

## Compact context

`/compact` drops the oldest eligible conversation entries from future model context and records the compaction in the session. It does not erase the visible transcript or undo files. If nothing is eligible, it reports `Nothing to compact`.

```tui-script compact-context
Use "basic"
Type "Explain the addition function."
Press Enter
Wait for answer "Ready."
Type "/compact"
Press Enter
Capture "Compact context, or report that nothing needs dropping."
```

`/new`, `/resume`, and `/fork` require active work and undo to settle or stop. A parked input form does not block them.

## Storage and recovery

The default is `~/.smithers/tui/sessions/<cwd>--<hash>/`. `SMITHERS_TUI_SESSION_DIR` overrides the root. Sessions are owner-only JSONL. An incomplete last line is dropped on recovery; earlier corruption renames the file to `.damaged` and excludes it from the picker.

Long directory names are shortened to fit the filesystem limit; the hash still identifies the complete working directory. Existing session folders remain readable.

Credential-shaped text in prompts, output, and calls is redacted. File patches retain their exact bytes so undo can apply them. Treat the session directory as private project data.
