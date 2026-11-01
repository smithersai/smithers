---
title: Stop processes left by the retired agent organization
status: todo
area: infra
owner: Lead coordinates; awaiting Will decision; Codex curates tracker
updated: 2026-10-24 08:04 PDT
links: [mac-mini-disk-cleanup.md, mac-mini-test-farm.md, ../rulings.md]
---

## What

Stop leftover retired-org processes after Will confirms the scope.

## Why

The lead reports drain scripts, web servers and a sandbox VM still running since the organization stopped on October 20, holding 32 GB of swap and preventing further folder cleanup.

## Current state

The lead asks at 07:54 PDT whether to stop these processes. No new answer or shutdown receipt appears. HOST-9 says the old agents remain stopped unless Will asks to restart them. Preserve unpublished work and current test jobs.

## Next step

Confirm the process inventory and current ownership, then stop the approved obsolete processes and record released resources without restarting the old organization.

## Open questions for Will

Stop the old organization's leftover processes?

Evidence: lead assistant replies at 2026-10-24 14:54:36 and 15:03:39 UTC, extracted as text by script across both requested transcript files for 13:03–15:03 UTC. Automated task notifications are excluded as user rulings; no user-typed ruling appears in this window. Rulings and queue answers govern older sources. Reboot-wiped briefs are not pending work. Operational results are lead-reported; this refresh runs only the maintainer-site build.
