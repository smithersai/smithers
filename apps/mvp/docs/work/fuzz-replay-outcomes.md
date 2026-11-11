---
title: Report current fuzz replay failures
status: done
area: sdk
owner: codex
updated: 2026-11-10
links: [https://github.com/smithersai/smithers/issues/4473]
---

A replay passes only when the property passes. Changed failures retain their current signature and are confirmed
against it; diagnostics show the original signature. Token and saved-fixture replays that hit the execution step
limit raise an execution error. Search discards and flaky confirmation remain unchanged.

Five regression tests fail on the original implementation. On Node 26.5.0, all 100 package tests pass with 100%
statement, branch, function and line coverage; typecheck, lint and circular-import checks pass. Astra and Fable
reviews report no remaining findings. Documentation generation and all 52 published-package tarball checks pass.

The docs flow entry point could not load without the native execution helper in the validation environment;
its exact check modules were run directly. An additional target-index comparison reports existing drift in
unchanged flow and testing declarations; this change adds no target declaration or compiler/test file.
