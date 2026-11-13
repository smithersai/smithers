---
title: Make engine-store lifecycle tests prove recovery and ordering
status: done
area: flows
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4772
---

Strengthen interrupted-plan recovery and copy-back dispatch assertions, clean
sandbox workspaces after each test, replace global spies and timing assertions
with matcher-owned work counts, and remove obsolete stat-memo fixtures.
Uses the existing Effect, engine-store, and real durable-store test services;
no new library.

All 112 focused tests, package typecheck and lint, and API projection checks pass.
Negative controls prove the suites reject interrupted-attempt refusal, early
dispatch, per-path matcher compilation, and missing workspace cleanup. The old
recovery and successful-dispatch assertions accept their corresponding mutants.
The full storage matrix also reproduces the existing disaster-recovery suffix
and parent replay-lock failures on unmodified main.
