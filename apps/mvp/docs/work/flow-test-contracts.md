---
title: Flow fixture identity and behavioral test contracts
status: done
area: flow
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/4639
---

The test runtime now refuses an execution id owned by another flow, matching
both production engines. The public execution regression checks the typed
conflict and subsequent replay of the owning flow.

Suspension tests require suspended parent and child results before reading
their causes. Bug fault tests check complete classifications and registration;
duplicate registration verifies the exact human-task code table. The
stub-only unsafe cancellation assertion and duplicate graph source-text
checks are removed.

Uses the library catalog's `@smthrs/flow` authoring and runtime port entry.
Production behavior and public APIs are unchanged.

Validation on Node `26.5.0`: 1,079 tests passed, two existing expected failures,
and 100% statements, branches, functions, and lines. Package typecheck and lint
passed. The execution identity regression fails with the original fixture and
passes with the fix. Mutation checks show the previous suspension assertions
accept completed results while the strengthened assertions refuse them;
removing either targeted fault registration also fails its assertion.
Astra and Fable reviews found no substantive issues.
