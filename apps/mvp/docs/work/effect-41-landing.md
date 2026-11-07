---
title: Effect 4.1 landing validation
status: in-progress
area: conversations
owner: Codex
updated: 2026-11-07
links: []
---

Restore persisted pending conversation acts before exposing the store, so a pre-restore empty snapshot cannot appear settled before resumption. Keep the existing behavioral tests unchanged.

The dependency upgrade remains blocked by regressions reproduced against the previous dependency cohort. Landing validation retains paired baseline and upgrade results for each reported red gate.
