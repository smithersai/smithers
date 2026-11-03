---
title: Fleet spec recovers an interrupted run without overloading the stack
status: done
area: testing
owner: Codex GPT-6.1 Sol
updated: 2026-11-02
links: [../features/fleet.md]
---

An interrupted fleet spec skipped its final cleanup, leaving 64 independent lanes,
maxOpen 500 and live TODOs. Reset the scratch repository before starting its runner,
bound lanes by runner capacity, and use the minimum 51 runs that exercise the
newest-50 boundary. Preserve the fleet's desktop, phone, state and machine assertions.

Use the existing scratch-reset and stack-write helpers; no new library is needed.
The library catalog's repository chores entry supplies the landing flow.

Validation: the new safety guards first failed for missing setup recovery and a
53-run burst. The landing gate requires all four app typechecks and the fleet
safety, scratch-reset and runner helper tests (partial Vitest coverage disabled).
The mini farm was full, so validation uses the authorized cfbox fallback. No
production E2E run or deployment is part of this test-only change.
