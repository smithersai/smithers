---
title: Branch Publish and Update eval and coverage salvage
status: done
area: branches
owner: codex-bp-salvage
updated: 2026-10-25
links:
  - ../features/branch-publish.md
---

Restore the interrupted builder's Publish and Update agent cases and complete
behavioral coverage of the first-party flows and the branch HTTP clients.
The restored catalog check still failed for `app/bug/report` and `app/bug/list`;
both now have calibrated cases. Publish consent, requested arguments, unasked
GitHub navigation and unreadable HTTP refusal bodies have negative checks.

Latitude: 121 tests pass across `flowCases.test.ts`, `publishSteps.test.ts` and
`branch.test.ts`; `plugins/branches/src/{publish,update}.ts` and the branch
`api.ts` reach 100% statements, branches, functions and lines. importRules and
the app and eval typechecks pass. Full `pnpm typecheck` stops on two errors
already present at base `2049112845f2`: missing `RepoRoles.CANT_ACT` in
`worker/github/Api.ts` and the `BranchRoles` import in its test harness. All four
files involved in those errors match the base exactly. No live-model eval or
production e2e result is claimed by this coverage-only change.

Uses the library catalog's durable workflow entry (`@smthrs/flow`) and existing
agent eval suite (`@smthrs/evals`). No dependency or public API changes.
