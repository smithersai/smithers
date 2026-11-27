---
title: Diagnose hosted job checkout failures
status: in-progress
area: runs
owner: codex-hosted-runs
updated: 2026-11-27
links: [../features/ci.md]
---

Two production landing-check jobs stopped at checkout before a user step ran. Preserve bounded checkout failure details in the durable job receipt and verify the hosted checkout path.

The historical receipt lost its checkout stage. The library catalog’s existing `@smthrs/sandbox` CiJob and `@smthrs/flow` actions own the typed result, journal and retry policy.
