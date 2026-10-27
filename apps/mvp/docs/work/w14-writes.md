---
title: Writes survive immediate reload
status: in-progress
area: admission
owner: w14-writes
updated: 2026-10-27
links:
  - ../decisions/0002-local-first.md
  - ../decisions/0009-notifications-and-live-work.md
---

Trace immediate reload through input, local recovery, outbox admission and server receipts. Keep command identities stable and expose honest recovery without depending on network readiness. Coordinate shared TODO files with w13-toasts. Libraries: platform-browser PendingSnapshot, effect-tanstack-db Outbox and Collection, observability.
