---
title: Review diffs and undo
description: Inspect the evidence behind a change and reverse a captured edit.
order: 7
section: Use the TUI
---

Open **Summary** with **Ctrl+S** or `/summary`. Each chronological row retains its cell, flow calls, output, errors, and captured file changes.

## Inspect a change

```tui-script review-diff
Use "edit"
Type "Fix the addition function."
Press Enter
Wait for answer "Fixed math.js."
Expect file "math.js" contains "a + b"
Press Ctrl+S
Press j
Press l
Capture "Expand a recorded edit in Summary."
Press d
Capture "Toggle the selected turn's diff."
Press v
Wait for "a + b"
Capture "Switch between split and unified diffs."
```

Use **j/k** or **Up/Down** to choose a row. **l/Right** expands it; **h/Left** collapses it. **Enter** or **Space** toggles details. **d** toggles the diff; **v** switches split/unified rendering when space permits. **Esc** or **i** focuses the composer without stopping background work.

Edits, writes, patches, moves, and deletions retain changes. Diffs use syntax highlighting, line numbers, and contextual hunks. Creation/deletion uses `/dev/null`; deleted files retain their mode. Binary, oversized, or expensive diffs show a label instead of incomplete hunks.

## Undo a captured edit

```tui-script undo-edit
Use "edit"
Type "Fix the addition function."
Press Enter
Wait for answer "Fixed math.js."
Press Ctrl+S
Press u
Wait for "Undo math.js?"
Capture "Confirm undo for the selected captured edit."
Press Enter
Wait 400 ms
Expect file "math.js" contains "a - b"
Capture "The original file is restored and the undo is recorded."
```

**u** is available in Summary and worker tabs. Undo is all-or-nothing and is added to the session so the next agent turn knows what happened.

Undo refuses files changed since capture, unsupported or large/binary changes, active work, and shell changes that may include another worker's edits. Resolve the cause before retrying; it does not overwrite a newer edit.
