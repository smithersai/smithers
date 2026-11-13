---
title: Make cancellation and parent lookup tests enforce their contracts
status: done
area: flows
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4778
---

Strengthen `RunDriverEdges` to require cancellation past an unreadable parked
row and a definitive child-drive exit after a parent lookup fails. Use the
existing Effect services, test clock, and real durable stores; no new library.

Negative controls prove both old cases accept their broken guards while the
strengthened cases reject them. All 76 focused tests pass on SQLite and
PostgreSQL, with package typecheck and lint passing. The storage matrix reports
100% coverage but remains red for the existing disaster-recovery migration
suffix and parent replay-lock failures. The migration failure also reproduces
on unmodified `main`.
