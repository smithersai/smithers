---
title: Pull request list on a cold device
status: done
area: app
owner: Codex pulls-spinner
updated: 2026-10-26
links: [../decisions/0112-shape-demand.md]
---

The list must show unknown counts while its device collections hydrate, then rows or confirmed empty counts, without a spinner (ARCH-5). Library catalog: `@smthrs/effect-tanstack-db`, `@smthrs/effect-electric`, `@smthrs/ui`.

The sync receipt can hydrate before the authority-gated items and pulls used by the list query. Detail shapes (commits, reviews, checks) are not list dependencies and stay gated. An injected ShapeSource holds items while the real store receives its sync receipt; the regression fails on the old loading/unknown props.

Validation: Latitude regression failed before the fix (loading true, unknown false), then 29 focused tests passed with 100% coverage on view.ts. Typecheck, importRules and lint passed. The mini shape-demand run passed 3 tests and skipped 2 requiring Code Storage, including the pull-detail case; that e2e behavior remains unproved locally. No production run.
