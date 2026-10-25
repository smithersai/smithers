---
title: Refresh repository VibeLang highlighting
status: in-progress
area: repo
owner: grammar
updated: 2026-10-25
links: []
---

Refresh the vendored grammar from smithersai/vibelang main; pin its source hash
and exercise error inheritance, schema aliases and TypeScript module escapes
through the existing @smthrs/repo-view highlighter (docs/libraries.md repository views entry).

Source: smithersai/vibelang commit `3ad97368713b9a1fab1fa408388a017687aa7431`.
The package is private; no changeset is required. The upstream repository no
longer contains ThirdPartyNotices.txt; retain the existing MIT notice.

Latitude: repo-view `pnpm test` passed 168 tests at its configured 100% lines
and functions; apps/mvp `pnpm typecheck` passed. Both the source-hash test and
the scope regression fail with the old grammar. Main-thread and worker rendering
pass with the refreshed grammar. The deployment-capable browser spec reads pinned
public VibeLang examples; deployment validation remains pending landing.
