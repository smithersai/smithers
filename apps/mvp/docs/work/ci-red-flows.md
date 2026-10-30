---
title: Restore flow engine and host CI targets
status: done
area: sdk
owner: codex-ci-flows2
updated: 2026-10-30
links:
  - https://github.com/smithersai/smithers/actions/runs/41088937554
---

Follow-up: inspect W25 GitHub run 41088937554 read-only and reproduce the
Cloudflare, engine, sandbox Bun and sync failures under hosted-runner assumptions.
Keep the prior Latitude receipts below distinct from this hosted verification.

The follow-up's four test targets and all four package checks pass. The sandbox
Node suite also passes at its coverage threshold. Fresh Docker daemons began
with zero images and containers, using Node 26.5.0 and Bun 1.4.1. The sandbox
suites run as the ordinary runner user; namespace root bypasses their real
permission-denial tests and is not valid evidence for them.

Cloudflare's hosted failure was the elapsed-time ratio, while its container
cases passed. The replacement holds eight real PostgreSQL writer locks at a
barrier and retains each alarm's fourteen-transaction, 38-event and zero-wide-lock
bounds. Engine's private annotation guard no longer rebuilds the SDK type graph
inside a coverage worker; the package check still compiles it. Sync retains the
hosted `<0>` seed counterexample and chooses insertion markers absent from the
seed.

The sandbox's duplicate detached-launch regression reproduces the hosted
`pid.tmp` corruption with real processes. A worker-side claim now precedes PID
publication and output opening; PID-only launch receipts and separate startup
stderr expose redelivery. The original hosted duplicating caller is not
identifiable from the old records. These local receipts do not claim that a new
hosted run passed. The final read-only Sol review found no issues. Forcing the
writer locks to serialize makes the barrier fail at its existing 30-second
deadline; the original ratio still passes locally, despite failing twice hosted.

Earlier W25 validation:

Reproduce the assigned engine and host targets using the CI target runner on
Latitude; fix each root cause with a failing regression. Browser durability is
product behavior (ARCH-5). Catalog: `@smthrs/flows`, `@smthrs/engine-store`,
`@smthrs/platform-browser`, `@smthrs/platform-bun`, `@smthrs/platform-node`,
`@smthrs/platform-cloudflare`, and `@smthrs/patterns`.

All ten assigned CI test targets pass through `smthrs ci`: root flows,
browser (Node, Bun and real-browser recovery), Bun (Node and Bun), Node,
Cloudflare, the complete SQLite/Postgres engine-store matrix, and patterns.
The touched flow, engine and targets packages also pass their full suites at
their declared coverage contracts. All nine touched-package typechecks pass.

The browser checks retain crash resume, leader handoff, durable sleep wake,
and two tabs sharing one database. Bun uses real Chromium Web Locks. CI
provisions Chromium/WebKit and the container suite provisions its pinned
egress image. Explicit node-progress flushing preserves ordinary batching
and the hosted clone's fourteen-transaction bound.

The read-only Sol review found one stale workflow-inventory fixture. Its five
SCOPE-3 job expectations were removed, and the full targets suite passes.
Minimal supporting changes use the public `@smthrs/flow` and `@smthrs/engine`
runtime ports and `@smthrs/targets` CI toolchain, with docs and changesets.
