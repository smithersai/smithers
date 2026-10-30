---
title: Restore flow engine and host CI targets
status: done
area: sdk
owner: codex-ci-flows
updated: 2026-10-29
links: []
---

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
