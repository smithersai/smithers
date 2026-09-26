---
title: Approve consequential calls
description: Choose whether agent edits, commands, and network calls may run.
order: 10
section: Use the TUI
---

The default approval mode is `all`: agent edits, commands, and network calls run without asking. Start with `--approve ask` to decide on consequential calls, or `--approve deny` to refuse them. The flag overrides `SMITHERS_TUI_APPROVE`.

```bash
bun run tui --approve ask
```

## Allow an edit

```tui-script approve-edit
Use "approval"
Type "Fix the addition function."
Press Enter
Wait for "y allow"
Capture "The edit waits for approval."
Expect file "math.js" contains "a - b"
Press y
Wait for answer "Edit request settled."
Expect file "math.js" contains "a + b"
Capture "Allow the call once and inspect its result."
```

The row offers **y** to allow once and **n** to deny. Where it offers **a all bash** or **a all edits**, **a** grants that category for the session.

Approval shortcuts arm only when the editor is empty and at least 400 ms have passed since both the row appeared and the last editor change. Otherwise `y`, `n`, and `a` are ordinary text. **Esc** stops the waiting turn. Chat and independent work remain available.

## Deny a call

```tui-script deny-edit
Use "approval"
Type "Fix the addition function."
Press Enter
Wait for "y allow"
Press n
Wait 500 ms
Press Escape
Expect file "math.js" contains "a - b"
Press Ctrl+O
Capture "A denied call leaves the file unchanged."
```

Print mode cannot use `ask`, because there is no interactive approval row. Use `all` or `deny`. A restored shell monitor asks again before running a command. Flow runs also have their own planning/approval boundary; see [run a flow](../automation/flows.md).
