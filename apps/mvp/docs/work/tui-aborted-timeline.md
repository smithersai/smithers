---
title: Aborted turn timeline endpoint
status: done
area: tui
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5207
---

Record a terminal failure after an aborted agent event so the timeline displays
`Failed` in the danger tone. Keep repeated completion idempotent and earlier
positions free of later outcomes. Uses the existing activity and trace fold;
no new libraries.

Both abort regressions fail with the original status guard. With terminal-record
deduplication, all 12 activity tests pass, including transcript completion,
session restore, historical inspection, and repeated terminal outcomes.
The package's typecheck and lint pass.

The full package suite passed 2,729 tests, skipped one, and failed four.
Comparing the failing files with the original guard reproduced the same three
runtime and flow-integration failures; the CLI help timeout passed on both
repeats. The fix introduced no new failures in that comparison.
