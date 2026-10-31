---
title: Deduplicate repository refs across head discovery and sync
status: blocked
area: navigation
owner: codex-refs-dedupe
updated: 2026-10-31
links:
  - ../features/navigation.md
  - ../decisions/0133-refs-cache-identity.md
---

The refs response and local head row now carry the synced refs revision. Head
discovery and Electric use the same key, preserving null and microseconds.
UTC formatting is independent of the SQL session, and older durable results
still decode. Astra and Fable reviewed the change; their findings are fixed.

The regression first counted two HTTP refs reads, then one after the fix, with
the synced row arriving before or after hover. All 308 selected cases passed
across the combined run and targeted reruns after setup-hook deadlines. The five
changed logic files have 100% line, branch, function and statement coverage.
Typecheck and lint pass. An existing rate-limit fixture now expires explicitly
in the past, avoiding a database/reader clock-boundary race.

Blocked: browser validation needs Code Storage configured. Both existing
tree-click cases skipped for that unmet requirement; their assertions are
unchanged. No deployment.
