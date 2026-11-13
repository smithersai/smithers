---
title: Report a missing sandbox merge base after a failed fetch
status: done
area: sdk
owner: Codex
updated: 2026-11-13
links: ["https://github.com/smithersai/smithers/issues/4693"]
---

`SandboxMerge.apply` rechecks the base after a failed fetch. A confirmed
absence reports `base_not_found`, including repositories without remotes,
with the original fetch failure in `MergeError.cause`. Fetch lock contention,
failed lookups, and failed fetches that obtained the base retain `vcs_failed`.

The implementation uses `@smthrs/jj`'s shared `isGitLockContention` classifier.
Regression cases use real repositories and an injected faulty process service.

Validation:

- The new regression assertions fail against the unchanged implementation.
- All 29 `SandboxMerge.test.ts` cases pass, with 100% statement, branch,
  function and line coverage for `SandboxMerge/apply.ts`.
- Package typecheck, lint and circular checks pass.
- Independent source reviews found no blocking issue.
- The full package suite passes as an unprivileged user: 1,034 tests pass
  and 37 are skipped, with 100% statements, branches, functions and lines.
  Running permission-denied tests as root caused seven failures; the
  unprivileged run passes those cases.
- The package docs generator and its drift check, the site docs generators,
  and the API and LLM projection drift checks pass.
- Aggregate site docs tests still fail on the unchanged flow release pin and
  support-table package count. The flow-backed docs wrappers cannot start
  without the native `smithers-jj-export` helper; their underlying generators
  and checks were run directly.
