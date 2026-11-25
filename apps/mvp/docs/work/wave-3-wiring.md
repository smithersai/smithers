---
title: Wave 3 entry point wiring
status: done
area: worker
owner: codex
updated: 2026-11-24
links:
  - ../decisions/0171-one-core-four-clients-and-workflows-dir.md
  - ../features/ci.md
---

Mount the Wave 2 CLI, plan and artifact entry points and connect repository workflow lookup.

The review follow-up binds the node replication bearer to `SMITHERS_HUB_ORIGIN`, rejects a file at the preferred workflow directory before legacy lookup, and limits scoped help to the delegate command audience. Hosted lookup uses the catalog’s `@smthrs/integrations` GitHub Contents client.
