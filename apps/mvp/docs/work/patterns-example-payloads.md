---
title: Pattern example payloads
status: done
area: sdk
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4711
---

Correct the release example and Supervisor guide to supply the declared `{ input }` payload.
Import the example's `Node` from `@smthrs/plan/Node` and remove its obsolete
`@smthrs/core` dependency. Describe the real flow interpreter in the coverage configuration.

Extend the existing release example suite to verify that every declared action and compensation
receives the release input. No public API or runtime semantics change.

Validation:

- The payload regression fails with the original unwrapped input: one failed, four passed.
  Restoring the wrapper passes all five example tests.
- The rebased package suite passes all 847 tests with 100% statement, branch, function and line coverage.
- Package typechecking and lint pass.
- `pnpm docs:sync` and `pnpm docs:check` pass, including all 52 published-package tarballs.
  Regeneration produces no additional tracked changes.
- Astra and Fable correctness reviews pass; the suggested import ordering is applied.
