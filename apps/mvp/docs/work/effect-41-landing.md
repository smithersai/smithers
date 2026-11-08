---
title: Effect 4.1 landing validation
status: done
area: mvp
owner: claude-e41land
updated: 2026-11-07
links: []
---

Restored persisted pending conversation acts before exposing the store, so a pre-restore empty snapshot cannot appear settled before resumption. All 20 unchanged conversations tests pass.

Preserved the reviewed sandbox database-route call forms after upgrade formatting. Both unchanged database-route tests pass. No tests or coverage thresholds changed.

The upgrade lands with no red only on the upgrade; [the repair note](effect-41-fixes.md) lists each repair and the paired validation against `main`.
