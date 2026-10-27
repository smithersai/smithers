---
title: Code browsing bug bash
status: in-review
area: repo
owner: bb-code
updated: 2026-10-26
links: []
---
Production code browsing and branch findings. Use the catalog entries `@smthrs/repo-view` and `@smthrs/ui` for repository rendering and controls.

Production probes confirmed ignored line fragments, inert branch counts, the missing branches route, reader workspace 403s, missing branch/file handling and expected large-file 413s. The actual branch picker opens correctly, signed in and out. The eight shape 500s did not recur. Nested folder loading completed without errors; precise latency remains unmeasured. The denied workspace's minimal No access copy is truthful.

Each fix has a separate commit and a deployment-capable regression spec. The route uses the existing visible-ref query and public UI primitives; optional preview and workspace results preserve ordinary API errors and all authorization checks. No new dependency, alternate flow runtime or private interface is introduced.

Latitude validation covers changed logic at 100% and runs typecheck, importRules and lint. The Mac mini is unavailable. Production was probed again after implementation; it still serves the old revision, so deployed regression specs remain the lander's check.

Final focused receipts: paths (20 tests), repository/API (60 tests), branch/view (143 tests), and attention detail (10 tests in the combined view check); changed logic is 100% statements, branches, functions and lines. Deployment specs: code-anchors, reader-code, missing-file, branches-list, branch-count, large-file and missing-branch. Browser rendering is outside the unit coverage configuration; those specs must pass after the lander deploys.
