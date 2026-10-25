---
title: Run page renders without waiting for remote work
status: blocked
area: runs
owner: Codex GPT-6.1 Sol
updated: 2026-10-25
links: [../features/runs.md, ../features/actions.md]
---

Measure the run route stages before changing its blocking reads. Keep the five-second browser budget. Library catalog entries: local state and sync (`@smthrs/effect-tanstack-db`, `@smthrs/effect-electric`), UI (`@smthrs/ui`), observability (Effect records through the existing relay). This fixes the existing run infrastructure; it adds no feature or library.

The old route awaits root inspection, child inspection/journal pagination and
subscription setup before the screen commits. Held-service regressions failed
at the unchanged five-second budget. The fixed route returns independently,
hydrates a persisted header on a direct link, and publishes each known inspection
without discarding cached siblings/tails. Replay and overlapping-read regressions
are retained. Astra reviewed and verified all three review fixes.

Local real nested-run samples: route entry 55.196 ms before, 16.314 ms after;
parent/child ready at 23/53 ms before, 53/121 ms after. The after frame boundary
precedes inspection. These are local harness samples, not production/browser
claims; [the method and content-free records](evidence/ci-runpage-slow/method.md)
explain the different load and the real React route regression.

The final focused gate passed under the Mac mini's full-suite lock:
15 files, 191 tests; the six changed TypeScript modules have 100% statements
(608/608), branches (304/304), functions (162/162) and lines (489/489).
React screens are outside the existing coverage configuration; their real DOM
commit and live rendering are exercised by the route regression. The real-run
measurement/timing tests also passed. All four typecheck projects have zero
errors and importRules passed. Astra's final review found no blockers; a Fable
review could not run because that reviewer is unavailable in this environment.

The full app gate ran under the same lock: 340 files passed, six failed, four
skipped; 4,464 tests passed, six failed, three expected failures and ten skipped.
Every failure was a 30-second database-reset `beforeEach` timeout in unchanged
tests. All six files reran under the lock with one worker: 269 tests passed.
That partial rerun's coverage command exited red because other files supply
some of those modules' coverage; it is behavioral evidence, not a full gate pass.
The original full gate had 100% statements/functions/lines and 99.97% branches,
with only four missing no-navigation timing branches in `store.ts`. The added
real pre-navigation subscription regression and final focused gate cover those
branches. No clean single-invocation full app gate is claimed.

Commands (Node 26.5.0; the full and rerun suites used the shared lock):

```sh
pnpm --dir apps/mvp test --maxWorkers=2
pnpm --dir apps/mvp test src/features/runs src/features/flows-ui/tab.test.ts tests/RunPage.loading.test.ts --maxWorkers=1 --coverage.include=src/features/runs/store.ts --coverage.include=src/features/runs/timing.ts --coverage.include=src/features/runs/actions.ts --coverage.include=src/features/runs/runs.ts --coverage.include=src/features/runs/schema.ts --coverage.include=src/features/runs/contract.ts
pnpm --dir apps/mvp test worker/ModelEndpoint.test.ts worker/flows/Todo.test.ts worker/personal/PersonalModels.test.ts worker/flows/Checks.test.ts src/features/code-intel/code-intel.test.ts worker/github/RepoRoles.test.ts --maxWorkers=1 --coverage.include=worker/ModelEndpoint.ts --coverage.include=worker/flows/Todo.ts --coverage.include=worker/personal/Models.ts --coverage.include=worker/flows/Checks.ts --coverage.include=src/features/code-intel/store.ts --coverage.include=worker/github/RepoRoles.ts
pnpm --dir apps/mvp typecheck
pnpm --dir apps/mvp exec smithers-build test '//apps/mvp:importRules'
```

Receipts: `/tmp/ci-runpage-full-final.log`,
`/tmp/ci-runpage-focused-locked.log`, `/tmp/ci-runpage-timeout-reruns.log`,
`/tmp/ci-runpage-typecheck-complete-final.log`,
`/tmp/ci-runpage-import-rules-complete.log`. The lock was released after each run.

`BASE_URL=https://localhost:1443 pnpm --dir apps/mvp e2e ci.spec.ts --workers=1`
passed the fixture test and skipped the real-push journey: this environment lacks
`E2E_REPO_FLOWS_REPOSITORY`, `E2E_GITHUB_TOKEN` and
`E2E_GITHUB_WEBHOOK_SECRET`, and supplies no farm command. The brief forbids
modifying the shared farm. No real farm/prod CI, deployment, push or production
timing claim. ci.spec itself is unchanged.
