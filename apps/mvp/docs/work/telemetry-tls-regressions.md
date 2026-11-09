---
title: Browser telemetry contract and TLS guard regressions
status: in-progress
area: observability
owner: codex
updated: 2026-11-09
links: []
---

Reproduce the browser telemetry emitter check and the TLS policy checks, identify their first bad commits, and correct their causes while retaining strict assertions.

The telemetry baseline reproduced 20 server-only auth names in the browser contract (introduced by `2258390b79c8`) and a dropped `electric.shape.request` span. Keep the browser emitter scan unchanged, remove server-only names, explicitly reject those records at the real relay, and retain the SDK’s real shape spans and progress fields.
