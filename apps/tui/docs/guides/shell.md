---
title: Run shell commands
description: Decide which command output enters the next agent turn.
order: 4
section: Use the TUI
---

Prefix a command with `!` to run it in the working directory and include its output in the next turn's context. Prefix it with `!!` to run it without adding that output to context.

```tui-script shell-context
Use "basic"
Type "!node check.mjs"
Press Enter
Wait for "add is wrong"
Capture "Run a failing check and keep its output for the next turn."
Type "!!pwd"
Press Enter
Wait 500 ms
Capture "Run a local command without adding its output to context."
```

Shell output appears as it arrives. **Esc** cancels the active shell process; chat returns when it settles.

```tui-script cancel-shell
Use "basic"
Type "!sleep 30"
Press Enter
Wait 400 ms
Capture "A shell command is running."
Press Escape
Wait 400 ms
Capture "Cancel the command and return to chat."
```

Commands you enter yourself run directly. Agent-requested shell calls follow the [approval mode](./approvals.md). Shell changes in Git and jj repositories appear in captured diffs, but automatic undo refuses them because a shell diff may include another worker's edits. Outside a repository, shell calls have no automatic file diff.
