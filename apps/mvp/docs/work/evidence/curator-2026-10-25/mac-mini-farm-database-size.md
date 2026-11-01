---
title: Reduce Mac mini test-farm database growth
status: todo
area: infra
owner: Lead coordinates; awaiting Will decision; Codex curates tracker
updated: 2026-10-24 08:04 PDT
links: [mac-mini-test-farm.md, mac-mini-disk-cleanup.md, ../rulings.md]
---

## What

Compact or rebuild the farm's oversized Postgres test database, after Will chooses the action.

## Why

The lead reports 125 GB of test data caused disk exhaustion. Workspace cleanup restored headroom but did not address that source.

## Current state

At 07:54 PDT the lead offers compaction or rebuilding from scratch and describes the database as test-only. No action or approval is reported. The completed disk cleanup recovered 134 GiB free; this follow-up remains separate.

## Next step

After Will decides, preserve anything required, perform the chosen operation, verify the real farm and record disk usage plus a plan to bound future growth.

## Open questions for Will

Compact the farm database, or rebuild it from scratch?

Evidence: lead assistant replies at 2026-10-24 14:54:36 and 15:03:39 UTC, extracted as text by script across both requested transcript files for 13:03–15:03 UTC. Automated task notifications are excluded as user rulings; no user-typed ruling appears in this window. Rulings and queue answers govern older sources. Reboot-wiped briefs are not pending work. Operational results are lead-reported; this refresh runs only the maintainer-site build.
