---
title: Verify app and plugin tests for the M3 gate
status: blocked
area: testing
owner: Codex / m3-vitest
updated: 2026-11-25
links:
  - ../decisions/0173-byoa-only-mcp-attach-and-jev-config.md
---

Verify the app tests against the BYOA chat attachment and model-seat contracts.
Check cron registration and dispatch against Postgres and verify the plugin
quickstart example with the VibeLang test runner.

The three Vitest shards selected all 774 files. All 15 failing files within
this track passed their combined rerun. The TLS audit still rejects the direct
`ignoreHTTPSErrors` option in `apps/mvp/e2e/attach.ts`, a path reserved for the
e2e track. The push remains gated on that audit.

The fixtures use the existing attachment mount, durable flow engine, model
seats and Effect SQL test stack. The sandbox uses the release packer's
workspace metadata and locally packs the private app-core runtime package.
