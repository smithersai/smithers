---
title: Flow invocation scopes and root imports
status: done
area: sdk
owner: Codex
updated: 2026-11-13
links: ["https://github.com/smithersai/smithers/issues/4620"]
---

Normalize an explicitly undefined parent scope to the existing unscoped
invocation key before schema admission. Enforce SDK-5 across flow sources and
tests and consume sibling packages through their public roots.

Validation: the unchanged implementation failed four new invocation-key
regressions. The fixed flow suite passed 1,097 tests with two existing expected
failures; capability passed 1,142 tests. Both packages earned 100% statement,
branch, function and line coverage and passed typechecks, lint and cycle checks.
The root-import check passed over 179 source files and rejected a reintroduced
deep import. Astra and Fable reviews found no confirmed issues.

The standard docs and index commands encountered an existing CLI startup
failure importing `typescript/unstable/ast`. The owning docs generators and
drift checks passed, as did all 52 published package tarballs. The build CLI
regenerated the target index without a tracked change. All 23 invocation
identity tests passed again after rebasing.
