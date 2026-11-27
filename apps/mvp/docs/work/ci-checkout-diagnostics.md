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

On a signed-in hosted run, the durable checkout completed, the readiness command exited 0 and the parent run reached done. The first two failures recorded neither an exit code nor a checkout stage.

A later hosted parity job returned 72. The old script used that code for three commands. Two local Docker checkouts of that exact revision through the production Git proxy implementation succeeded. Distinguish repository initialization, remote setup, fetch, and working copy checkout in the durable receipt.
