---
title: Sign CLI and MCP posts as a person's agent
status: done
area: vibelang
owner: Codex (vl-clisignin)
updated: 2026-11-09
---

VL-26: GitHub device sign-in through the shared integrations auth, private shared CLI/MCP settings, server-derived
`<login> (agent)` authors and current project grants. Agents cannot approve, fold or merge. Mock identity uses a
separate private fixture file, with no network or live-session changes. Decision
[0028](../../../vibelang/wiki/decisions/0028-cli-and-mcp-sign-in.md) preserves the design and alternative; 0027 was
already assigned to acceptance gates.

Validation: 1,015 unit/integration passes and 2 opt-in skips after rebasing; 279 Chromium product passes and 12 skips; three pre-existing source-map expected failures reproduce after a finite analysis-budget fix;
7 correctness-checked surface benchmark workloads; 14 shared GitHub.Auth cases; all 20 marked production modules
proved across the full run and refreshed incoming-module checks, with exact input hashes retained. Three new executable label mutations
are rejected. Final workerd verification passes: 62 tests, 3 opt-in skips. Focused identity/action/role Chromium: 36 passes. The lane report on nyc-01 records every receipt.
The lead deploys; the configured GitHub app needs Device Flow enabled. No dependency was added.
