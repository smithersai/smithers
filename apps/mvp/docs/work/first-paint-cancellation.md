---
title: First-paint request cancellation
status: done
area: app
owner: Codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5326
  - ../features/issues.md#first-paint
---

A cancelled first-paint request must interrupt its read until the bounded
background handler has accepted ownership. Cleanup must not delay cancellation.
Keep the existing response deadline and background read limit.

Regression coverage includes cancellation before the deadline, cancellation
during background registration, slow cleanup, and cancellation after handoff.

The first-paint and reader suites pass 119 tests, including real Postgres reads,
with 100% line, statement, branch and function coverage of
`worker/github/FirstPaint.ts`. The four cancellation regressions fail with the
previous implementation; all 33 first-paint unit tests pass with the fix.
Package typechecks and changed-source lint pass.
