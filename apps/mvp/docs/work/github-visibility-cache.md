---
title: GitHub visibility diagnostics and cache
status: done
area: github
owner: Codex visibility-cache
updated: 2026-10-26
links: []
---

Diagnose anonymous metadata refusals and keep definite visibility answers for 60 seconds per isolate. Uses the library catalog's GitHub entry, `@smthrs/integrations`, through Effect HttpClient. No shared request I/O.

Latitude: typecheck, importRules and full app lint (including worker.request-owned-io) passed. Fourteen focused suites passed 390 tests with 100% statements, branches, functions and lines on Api.ts and Visibility.ts. GitHubShapes.workerd.test.ts passed all eight shapes for visitors and Members. The existing row assertions now wait for Electric to deliver their seeded rows.
