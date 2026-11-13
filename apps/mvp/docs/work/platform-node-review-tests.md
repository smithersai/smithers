---
title: Native host test isolation and cleanup
status: done
area: platform-node
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4994
---

Replace process-wide test patches with context-local Effect services, run
Windows stream assertions on Windows, check graceful shutdown status,
and correct the missing-process comment.
The package's existing import guard enforces the no-mocks rule for these suites.

Validation: the package typecheck, lint, affected suites, import guard, and
generated target index pass. Mutation checks prove that a nonzero graceful exit
and omitted directory removal are detected. The full package run passed 1,527
tests and skipped 14; its one host-home assertion failure also reproduces on
unchanged `main`. The native Windows case is part of the existing Windows test matrix.

Temporary language-server directory cleanup and its regression test are supplied
by commit `6e1397993b2b`, which is retained unchanged.
