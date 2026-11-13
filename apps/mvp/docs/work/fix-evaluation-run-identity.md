---
title: Evaluation run identity safety
status: done
area: cli
owner: codex-fix-evaluation-929603
updated: 2026-10-21
links: []
---

Reject existing run identities before importing suites; roundtrip identities ending in .json.

Both regressions failed before the fix and passed afterward on Latitude.
The five evaluation test files passed 56/57 tests; the remaining shipped-suite
discovery failure also existed before changes (the suites are absent at main@origin).
The package declares no importRules target; invoking it reports unknown_label.
No new libraries: library catalog entry “Run an eval suite against a committed
baseline” uses the existing @smthrs/evals and @smthrs/scorers composition.
