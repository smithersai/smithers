---
title: Keep repository denials effective for feed writers
status: done
area: repository-access
owner: codex
updated: 2026-11-02
links: [../features/notifications.md]
---

Finding 2. Run folds, missing-run settlement and repository events check every recipient's recorded repository denial after taking their feed locks. No assumed Member or deployment role overrides the denial. A failed initial read (-infinity) remains distinct from a denial; a subsequently restored role admits delivery.

Library catalog: existing `@smthrs/notifications` audience and routing, Effect SQL and the existing FeedLocks seam. Authorization is core infrastructure, not a new feature plugin.

Baseline main: `recorded denial prevents later branch reports recreating a watcher's private notice` failed with an unexpected notification; `recorded denial prevents repository events recreating a deployment Member's notice` failed with `expected 1 to be +0`.

Validation: Latitude Notifications.test.ts: 40 passed, 0 failed, 0 skipped.
