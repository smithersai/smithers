---
title: Round two issue and pull request lists
status: blocked
area: issues
owner: bb2-lists
updated: 2026-10-27
links: []
---

W12 list and triage findings. Use existing @smthrs/ui lists and controls and @smthrs/effect-tanstack-db queries (docs/libraries.md). Production probes use the supplied read-only probe; no mini runs or deployment.

Implemented independently: unlabeled No commitment matches; filter-independent loading knowledge; URL search and creation/update sorting on both lists; installed-row loading gates; meaningful TODO link titles; stack shape application before missing-item classification; empty-list completion from installed snapshots. Creation dates now travel in issue summaries, persistence version 2. The lander must regenerate the device schema lock.

Production reproduced No commitment's false empty, slow-network false empty, missing search/sort, bare TODO IDs and list date ordering. Read-only probes found VibeLang's signed-in reader now sees issue 1, a visitor's New issue page now has Sign in with GitHub, and the Now bell retains its badge. The history probe returned to a scrolled list. These do not justify additional changes. Watch is the specified run link (TODO-3); commitment changes remain restricted to accepted issues and Maintainers, as the feature document requires.

Deferred nonblocking polish: label projection and visible count names, locale grouping and relative-time language, and the empty-title reason on Create issue. These need shared UI/projection work; no label data or localized copy is invented. The formerly empty test repository now contains issues, so its old empty-list screenshot cannot be recreated there; injected empty-snapshot regressions cover the classification.

Six assertions fail with the previous policy/store implementations restored on Latitude. The focused feature suites pass; post-deploy browser validation remains the lander's responsibility. Run issue-list-feedback, issue-commitment-list, list-search-sort, issue-todo-titles and stack-direct-load. Check cold and slow-network loading, zero-match filters, URL reload, date order, TODO names, and no early Not found. No mini run, deployment, GitHub write or changed-build production E2E is claimed.

Validation receipts: the focused feature run passes 181 tests, with every changed issue/pull/TODO logic file at 100% statements, branches, functions and lines. Typecheck, import rules and lint pass. The existing device migration suites pass 47 tests with registry.ts at 100% in all four metrics. Browser specs await deployment; the Mac mini is unreachable.
