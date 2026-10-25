---
title: Production CI repository run visibility
status: done
area: app
owner: Codex GPT-6.1 Sol (prod-ci-runview)
updated: 2026-10-24 PDT
links: [../features/actions.md, ci-parity-run-view.md]
---

Production evidence shows an empty Runs page, not a mismatched href. Dispatch records the event repository, but the actions shape and device collection use the deployment repository. Reproduce against real Postgres, Electric and a device, then scope the collection and authorized shape to the route repository. Keep the visible/watchable CI e2e assertion unchanged.

Library catalog: existing `@smthrs/effect-electric` and `@smthrs/effect-tanstack-db` entries for sync and device state; existing GitHub repository role service for admission.

The regression reproduced `[]` for the second repository's list, then `not_found` for its run page once the list scope was corrected. The fix passes the route repository into a distinct persisted Electric collection and shape, and resolves inspection/follow/Stop access on `RepoRuns.admit`'s recorded repository. Dispatch and migration 0053 already store the correct row. The production locator and visible/watchable assertions stay intact.

Checks: frozen install, importRules and all four typecheck projects pass. Focused API/store/page checks: 4 files, 120 tests passed. Final receipts follow below. Astra review: no findings. Fable review could not start: the account rotator had no eligible authenticated account; no account settings or pool assignments were changed. No production e2e, deployment or push.


Final validation (Node 26.5.0): all 166 tests in `worker/RemoteRuns.test.ts`, `worker/github/{Api,PullsApi}.test.ts`, `src/features/runs/{remote,store,page}.test.ts`, and `src/device/schemas.test.ts` passed. The second-repository device regression passed twice, including its SQLite reload. `pnpm exec smithers-build test '//apps/mvp:importRules'` and `pnpm --filter @smthrs/mvp typecheck` passed.

Coverage measured `src/features/runs/store.ts`, `worker/RemoteRuns.ts` and `worker/github/Api.ts` at the unchanged 100% thresholds. The expanded run added the existing `worker/github/Triage.test.ts` route checks (`-t '^(?!triage/Run).*'`): 187 passed, two first-setup hooks timed out. Both passed with `--maxWorkers=1 -t '^(GET /api/remote-runs/<runId>|the webhook)'` (5/5 checks), without changing the timeouts. The existing `worker/Notifications.test.ts -t 'distinct pushes in the same second'` check also passed (1/1), exercising the API's last uncovered notification line. Coverage JSON receipts from those three runs were merged with `istanbul-lib-coverage` and asserted at 100%: 687/687 lines, 839/839 statements, 165/165 functions, 613/613 branches. Individual filtered runs cannot meet whole-file coverage alone; the combined receipt is the coverage claim, not a full-app gate. No production code or threshold was excluded or changed to make a check pass.

The optional full app suite ran only under the Mac mini's full-suite lock and was interrupted after about 15 minutes to finish the requested focused checks. No full-suite completion is claimed. Focused and isolated coverage runs also held the lock, which was released after each. Local receipts: `/tmp/prod-ci-runview-{validated,coverage,retry,notification}.log`, their coverage directories and `/tmp/prod-ci-runview-coverage-merged.json`. No public SDK API changed; package docs generation and a changeset are not required.
