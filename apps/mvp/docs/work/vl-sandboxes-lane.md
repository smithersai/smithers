---
title: VibeLang sandbox minutes (brick 6)
status: blocked
area: vibelang
owner: Codex vl-sandboxes
updated: 2026-11-08
links: [../../../vibelang/wiki/decisions/0024-sandboxes.md, ../../../vibelang/wiki/designs/sandboxes/NOTES.md]
---

Implement VL-25 in apps/vibelang on the public Factory, shared durable flows, browser and Worker. Read the kept designer artifacts and decisions 0019/0024 for current UX, role gate and allowance policy. Catalog entries used: @smthrs/flow for durable sandbox actions; @smthrs/harness for the existing QuickJS agent runtime; @smthrs/platform-cloudflare for Cloudflare Container sessions. BranchSandboxes.ts and AgentSandbox.ts in apps/mvp are proven prior art.

Validation and departures are recorded in `/home/lane/vl/vl-sandboxes.REPORT.md`; the report distinguishes measured checks and coverage from configured thresholds. No deployment was performed.
