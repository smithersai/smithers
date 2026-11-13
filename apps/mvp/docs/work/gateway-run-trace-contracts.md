---
title: Gateway run trace and wire contract checks
status: done
area: gateway
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4927
---

Library catalog: workspace gateway (`@smthrs/gateway`). The recorded journal
replay now uses its own run identity and checks terminal frame closure. Fixed
wire vectors cover every optional summary, nested approval and child tree
field; the previous client keeps an independent field list. The unused roster
host fixture is removed, and the bridge names its current product coding host.

Monitor requests now log and trace as `runtime-bridge.monitor`. Faulty Control
services exercise the real HTTP routes and verify sanitized responses, operation
labels and completed spans for commands, observations and monitors.

The original focused suite passed `106` tests. Stronger assertions failed on
the original replay and monitor label. Removing the formerly uncovered wire
fields passed the old golden tests and failed the new ones; removing the monitor
span also failed its regression test. The gateway suite passes `973` tests
across `39` files at `100%` statement, branch, function and line coverage.
The package typecheck and lint pass.

Astra found no issues. Fable confirmed the fixes and identified adjacent stale
consumer and span documentation; those passages and the generated API page are
updated in the same change.

The docs sync and published-package docs checks pass. Fable's follow-up found no
remaining issues. The broader site API test for the flows quickstart's release
pin fails identically on unchanged `main`; it is outside this gateway change.
