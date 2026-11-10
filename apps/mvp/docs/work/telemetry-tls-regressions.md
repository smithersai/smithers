---
title: Browser telemetry contract and TLS guard regressions
status: done
area: observability
owner: codex
updated: 2026-11-09
links: []
---

Reproduce the browser telemetry emitter check and the TLS policy checks, identify their first bad commits, and correct their causes while retaining strict assertions.

The telemetry baseline reproduced 20 server-only auth names in the browser contract (introduced by `2258390b79c8`) and a dropped `electric.shape.request` span. Keep the browser emitter scan unchanged, remove server-only names, explicitly reject those records at the real relay, and retain the SDK’s real shape spans and progress fields.

Both TLS source assertions pass on the parent of `4d209c7cc589` and fail at that commit: explicit verification was mistaken for an override and the new connection boundary lacked the environment guard. Later additions repeated the missing guard, deleted the original issue-filer path, and let a web fixture choose its own TLS option. Forward the project option, guard every entry point, and keep the empty-offender assertions.

Validation: 137 tests across the telemetry, export privacy, TLS source, CLI and real TLS Postgres suites pass, with no skipped cases. All four app typecheck projects pass. Playwright collects the 15 affected web-page tests without a hook-fixture error. The original baseline had both TLS assertions and the telemetry emitter assertion failing; the real engine case also demonstrated the dropped Electric span.

The Neon-derived verify-full path also rejects an issuer absent from the process root store, independently of the environment opt-out guard and the pinned-CA checks.
