---
title: Run inspection bug bash round two
status: in-progress
area: runs
owner: Codex bb2-runs
updated: 2026-10-26
links: [../features/runs.md]
---

Production reproduces failed-run selection, inconsistent skipped labels, hidden
failure reasons, raw result presentation, and run table copy. Use catalog entries
Render UI (`@smthrs/ui`) and Show what a flow step logged (`@smthrs/engine-store`).
W11 already closes stopped-run timers. Fresh contexts cannot read another device's
local watch/set journal. No deployment or mini execution in this batch.
