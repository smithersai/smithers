---
title: Package bug bash round 3 agent fixes
status: done
area: sdk
owner: bb3-agent
updated: 2026-10-27
links: []
---

Fix agentcore-4 and agentmisc-3, agentmisc-4, agentmisc-5. Catalog entries: @smthrs/plugin, @smthrs/triggers, @smthrs/fs. Reproduce first, retain regressions, validate on Latitude.

## Results

- agentcore-4: standalone plugin example imports Effect; its unchanged snippet runs in a fresh Node module.
- agentmisc-3: invalid cron search dates report invalid_options at from or at.
- agentmisc-4: invalid interval endpoints report invalid_options before searching, including a zero limit.
- agentmisc-5: malformed argv reports parse_failed with its argument path; quantitative bounds still report resource_limit.

Each regression failed on unchanged main on Latitude. No mocks or faulty runtime workarounds were introduced. Public function signatures and error-code unions stay unchanged. Each package has a patch changeset.

Latitude compiler and lint pass for plugin, triggers and fs. Plugin: 267 passing tests, one existing artifact test skipped, 100% coverage. Triggers: 377 passing tests per SQLite/Postgres backend, merged 100% coverage. Fs: 196 passing tests, 100% coverage. Agent and SDK importRules pass. Site projections were generated from the colocated docs. Mac mini runs were skipped as requested.

The root pnpm docs:sync and pnpm docs:check entrypoints were attempted on Latitude. Site generation succeeded, but neither durable CLI invocation returned a receipt during its bound (over eight minutes for write, 76 seconds for check); only those two owned processes were stopped. This is an outstanding validation blocker, not a passing full docs check.

The owning docs modules pass directly on Latitude: API projection check, redirect-map check, and all 51 published package tarballs. This verifies content separately from the interrupted durable CLI entrypoints.
