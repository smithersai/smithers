---
title: Machine write refusal diagnostics and fast e2e failure
status: done
area: github
owner: codex
updated: 2026-11-03
links:
  - ../features/machine-tokens.md
  - ../observability.md
---

The production spec stops polling when a write leaves pending and asserts done
with status and failure in its message. Every worker refusal settlement logs
its check and available GitHub status without changing API failures or storage.
Library catalog: @smthrs/observability (the host's structured Effect logger) and
@smthrs/integrations (the existing GitHub client).

Validation in an isolated cfbox pg container, 4 vCPUs:
- Parent implementation plus regression tests: 2 failed, 46 passed. Only the
  allow-list and permission-403 log assertions failed, both with empty records.
- Fixed implementation with identical tests: 48 passed.
- pnpm typecheck: app, worker, infrastructure and evals passed.
- Production e2e was not run for this diagnostic change.

The API's not_allowed remains unchanged: the structured cause distinguishes
permission failures without another published failure value or a migration.
Handoff includes a read-only Astra receipt; no landing or push is requested.
