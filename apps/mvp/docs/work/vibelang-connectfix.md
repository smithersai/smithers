---
title: VibeLang issue and wiki read hangs
status: done
area: vibelang
owner: Codex vl-connectfix
updated: 2026-11-10
links: [../../../vibelang/wiki/decisions/0030-read-deadlines-and-object-health.md]
---

Reproduce production-shaped account storage across the Connect GitHub cutover and rollback; bound public reads through the durable engine, expose object startup/version, and fail journal decode errors with safe telemetry. This lane implements and tests in one session; no workers or deployment.

Implemented and verified: production-shaped cutover/rollback recovery, bounded reads and startup waits, per-instance health, and shared safe journal-decode diagnostics. No deployment; the lead runs the production smoke after landing.
