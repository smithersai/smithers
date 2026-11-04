---
title: Cold issue first render without loading states
status: in-progress
area: app
owner: Codex GPT-6 Astra
updated: 2026-11-04
links:
  - ../decisions/0110-shape-authority.md
  - ../features/issues.md
---

Fix the held-sync issue cold path exposed by d635300980f9, preserve the data gate,
and reproduce the WebKit list placement failure. Tests first on cfbox via nyc-01;
five deploy-smoke groups and issue-tracking proof (a), then the default Astra
review receipt. No landing or push. Private receipts live under the coldissue
operations directory.

The issue fix and separate WebKit list fix pass all nine smoke cases and eight
additional browser cases on cfbox. Failing-before regressions cover skeletons,
pagination, detail recovery, browser Back and transport-independent authority.
The SQL-inclusive suite passed 189 tests; the rebased preflight passed 169 tests
and four typecheck projects. Resource declarations and the build pass. Astra
passed the implementation before its final rebase.

Proof (a) remains failing: browser list search took 8.793 s against 5 s. The
first search box appeared at 7.249 s, app render at 7.188 s, and the HTTP search
answered in 161 ms. The original-commit rerun also failed this budget. Startup
is being profiled separately; no timing budget or loading assertion is weakened.
