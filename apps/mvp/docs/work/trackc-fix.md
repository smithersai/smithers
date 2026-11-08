---
title: Finish session recovery and visitor adoption
status: done
area: auth
owner: Codex (trackc17)
updated: 2026-10-22
links: [local-first-correctness.md, ../decisions/0023-device-ownership-and-queued-authority.md]
---

Restore C1 and C2 from the session builder, repair their test layers and Effect boundaries, and validate each commit independently for the lander.
Libraries: the catalog entries `@smthrs/flow`, `@smthrs/platform-browser`, and `@smthrs/effect-tanstack-db` supply durable refresh, activation and owner-scoped delivery.

## Repairs

C1 restores the durable `auth/refresh` flow and provides the real `FlowRegistry.layer` to auth and telemetry tests. The rejected test-host hunk retains main's run channel and adds the session channel.

C2 adopts visitor data in place without granting authority over another owner's or unstamped queued writes. Identity requests run as a scoped stream inside `BrowserRuntime.run`, with engine telemetry provided to that stream. Adoption follows the HTTP request's existing Effect deadline through its abort signal; no page timer or nested Effect runtime remains. The two sleep violations now await observable state. The original patch's unrelated boot connectivity/history and attention focus assertions are retained.

A focused send-fault regression reproduced a test race: `sentQuestions` proves launch, so Retry could precede completion of a fault that awaited ChatApi. The fault matrix now also waits for the real `Outbox.attempts` retry receipt before Retry (duplicate succeeds and needs no failure receipt). The assertions, deadlines, lint rules and coverage thresholds are unchanged. Astra reviewed the implementation and this repair; both findings were resolved. A Fable review was unavailable in this session (no tool or local Claude executable).

## Original stack validation — 2026-10-22

Node 26.5.0; `pnpm install --frozen-lockfile` passed. No push, deploy, merge or rule exception.

At C1 alone and at the tip:

- `pnpm --filter ./apps/mvp exec tsc --noEmit -p .` passed.
- `pnpm smthrs test //apps/mvp:importRules` passed. This target is a NodeTest; the lint verb rejects it.

C1: `pnpm --filter ./apps/mvp exec vitest run src/device src/features/auth src/flows/registry.test.ts src/telemetry.test.ts` ran 100 tests: 98 passed, two telemetry cases failed under load. The isolated telemetry rerun passed four, with the tab case still red; untouched main also fails that case (its contract drops `timeline.summary.unconfigured`, which C2 includes). `pnpm --filter ./apps/mvp exec vitest run src/features/auth --maxWorkers=1` subsequently passed all 24 assertions. Focused runs retain the app-wide coverage gate and therefore exit nonzero for insufficient whole-app coverage.

The full requested tip selection was:

```sh
pnpm --filter ./apps/mvp exec vitest run src/device src/features/auth src/boot.test.ts src/features/attention/attention.test.ts src/features/chat/chat.test.ts src/flows/engine.test.ts src/flows/registry.test.ts src/telemetry.test.ts src/test/e2e.test.ts --maxWorkers=2
```

It ran all 193 tests: 148 passed, 45 failed. The same selection on untouched main `7f16c873853d`, with `--maxWorkers=1`, ran 181 tests: 158 passed, 23 failed (chat, attention, telemetry, test/e2e). Main was checked in a temporary jj workspace using the installed dependencies; its tracked source was unchanged. The higher-load tip run also logged expired engine leases. Read-only `pg_stat_activity` showed shared Postgres WAL-write waits around 15 seconds; no database settings were changed.

All tip failures absent from the main failure set were rerun, without increasing a timeout:

- `vitest run src/features/auth src/flows/engine.test.ts --maxWorkers=1`: 30/30 assertions passed.
- `vitest run src/device/identity.test.ts src/device/migrations.test.ts src/device/schemas.test.ts`: 50/50 passed, including the TestClock adoption deadline regression. Main: 47/47 passed; both commands fail the unchanged app-wide coverage gate (tip 5.86% lines; main 5.78%).
- `vitest run src/features/chat/chat.test.ts -t <14 names absent from main's failures> --maxWorkers=1`: 13 passed, invalid_response red. Its repeated isolated red led to the receipt repair above; `vitest run src/features/chat/chat.test.ts -t 'a send that fails as' --maxWorkers=1` then passed all five cases. The 14-case selection is retained at `/tmp/trackc-unmatched-chat-cases.txt`.
- `vitest run src/features/attention/attention.test.ts src/telemetry.test.ts --maxWorkers=1`: 11 passed, one attention Retry case red. `vitest run src/features/attention/attention.test.ts -t 'Retry on a failed run' --maxWorkers=1` then passed that case. All five telemetry assertions passed.
- `vitest run src/boot.test.ts -t 'the repository layer' --maxWorkers=1`: passed. The restored connectivity/history test also passed in the full run.
- `pnpm --filter ./packages/smithers/flows/platform-browser exec vitest run test/BrowserRuntime.test.ts`: 16/16 passed. Main: 15/15 passed; both hit exactly the same package-wide coverage failure (36.4% lines, 100% threshold).

These focused runs do not establish a green full-suite or 100% whole-app coverage result. The broad run's baseline failures remain visible; no threshold was lowered or code excluded.

`pnpm --filter ./apps/mvp exec playwright test e2e/sign-in.spec.ts --list` collected 13 tests. Browser e2e (local and production) was not executed. `pnpm docs:sync` ran its documentation generators but failed when the durable docs-sync flow required the missing `smithers-jj-export` native helper. No deployment was attempted.

Raw receipts: `/tmp/trackc-c1-{tsc,importRules,tests,telemetry,auth-isolated}.log`, `/tmp/trackc-{final-tsc,final-importRules}.log`, `/tmp/trackc-c2-{tests-2,device-pure,browserRuntime,auth-engine-final,chat-unmatched,send-receipts,attention-telemetry-final,attention-retry-final,boot-final}.log`, and `/tmp/trackc-main-{all-tests,device-pure,browserRuntime,auth-expiry,invalid-response}.log`.

## Track C replay — 2026-10-22

Replaying onto main `9b86879e3606`. Earlier validation above belongs to the original stack, not this replay. Refresh enforcement follows main’s shared person-only table; main’s watch failure cleanup and live attention remain. Visitor adoption keeps the recovered-device branch reopen and conversation wait. New Latitude and mini receipts will be recorded here.

### Replay receipts

All installs and checks ran remotely; no local node_modules, push, or deployment. Source was plain `9b86879e3606` for each baseline comparison; its temporary jj change was empty.

- C1: full `pnpm typecheck` and `//apps/mvp:importRules` passed on Latitude (`/tmp/trackc17-c1.log`). Tip: both passed and 236/236 selected device, auth, attention, timeline, branch, Actor, person-only, run credential and telemetry tests passed (`/tmp/trackc17-tip-final.log`). Focused app runs disable whole-app coverage and establish no whole-app coverage claim.
- Platform-browser: the complete Node package suite passed 357/357, with executed aggregate coverage 100% (`/tmp/trackc17-platform.log`); its separate browser configuration was not run.
- All 31 worker suites importing Actor, plus boot, engine and chat, ran 779 tests: 777 passed. ShapeProxy’s message-column case received a non-array response; the chat defect case observed a refusal before the independent outbox write settled. The latter now awaits the existing expected message state with the original deadline. Plain main’s same selection ran 777 tests: 776 passed, and an Edit/reload case failed with a Postgres deadlock; neither tip failure reproduced there (`/tmp/trackc17-worker-docs.log`, `/tmp/trackc17-main-worker-docs.log`). Final serial ShapeProxy/chat verification passed all 79 tests, with full app typecheck and importRules also passing (`/tmp/trackc17-final-serial.log`). ShapeProxy’s earlier failure did not recur in isolation; the corrected chat ordering assertion passed with the unchanged deadline.
- Mini sign-in: 11 passed, one GitHub-only case skipped, one wipe test failed at line 67 (the unsent question remained). Plain main’s full suite: 9 passed, one skipped, the identical wipe assertion failed. Both new recovery/adoption cases and the recovered offline activation passed on the tip. Isolated diagnostics: main’s wipe case passed once; the tip’s retry failed earlier with a missing composer and HTTP 502s, so it did not reproduce the retained-question failure (`/tmp/trackc17-e2e-fixed.log`, `/tmp/trackc17-main-e2e-full.log`, `/tmp/trackc17-main-e2e.log`, `/tmp/trackc17-tip-wipe.log`).
- Copied the requested native helper into this clone’s `target/release` before docs commands. Latitude page generation completed and returned no changed site projections. Tip durable docs sync was stopped after nine minutes without a completion receipt; its subsequent docs check timed out at 120 seconds. Plain main’s docs check and sync also timed out at 120 seconds, after page generation (`/tmp/trackc17-docs.log`, `/tmp/trackc17-worker-docs.log`, `/tmp/trackc17-main-worker-docs.log`). Completed durable docs validation remains blocked; no success is claimed. Production e2e was not run.

## Lander replay and fixture isolation — 2026-10-22

Started from fetched `main@origin` `fae3a9e2`, applying the lander's resolved `08a6d9a3` and `2fa3be8d` patches verbatim before the isolation repair. No pushes.

The combined chat/device/auth reproduction failed at controls.test.ts:199: `QuestionFaults.asked` contained the same edited question twice. Its trace shows ChatApi returned 202 in 40 ms, but the Electric delivery confirmation hit the existing one-second deadline (1052 ms), producing a retry. No different test's message reached its database.

Electric 1.5.28's module-level `upToDateTracker` and `expiredShapesCache` use canonical shape URLs as keys. Every TestChatApi and simulated tab used identical URLs despite representing separate schemas and JavaScript realms. Isolating only API origins passed on nyc-02 but failed again on nyc-01 because tabs on the same API still shared the caches. A per-tab origin trial was rejected in review because it disagreed with worker navigation; it was cancelled while queued and is not part of the final change.

The catalog's `@smthrs/effect-electric` now exposes optional `ShapeSource.Source.cacheNamespace`. It distinguishes only Electric's client cache URL, and is stripped before the real source receives a request. Test layers allocate it per simulated browser realm over the real/faulty source. Ordinary browser behavior, origins, navigation, workers, deadlines, order, skips and existing assertions stay unchanged. The regression opens independent real APIs and streams, reopens the first API, checks distinct realm namespaces and confirms all requests retain the real origin. The SDK integration test covers initial and subsequent real Electric delivery and verifies the namespace never reaches the server.

Final receipts (all installs, tests, typechecks and lint remote):

- Exact `vitest run src/features/chat src/device src/features/auth --coverage.enabled=false`: 200/200 three times, all 15 files green on nyc-02. `/tmp/trackc17-realm-{1,2,4}.log`.
- Extra nyc-01 attempt: all 16 controls cases passed; 199/200 overall because the existing ordering test timed out awaiting the third answer row at chat.test.ts:203. Retained at `/tmp/trackc17-realm-3.log`; no assertion or deadline changed, and no plain-main baseline for that attempt is claimed.
- Earlier app selection plus boot, engine, registry and both Node test fixtures: 283/283 in 26 files, including the new isolation regression. `/tmp/trackc17-earlier-final.log`.
- Earlier broad worker/chat selection: 789/789 in 34 files. `/tmp/trackc17-worker.log`.
- Full platform-browser Node suite: 359/359 in 29 files, 100% aggregate coverage. `/tmp/trackc17-platform-final.log`.
- Full effect-electric suite: 128/128 in nine files, 100% aggregate coverage; package `pnpm check` passed. `/tmp/trackc17-cache-sdk.log`.
- Final full app `pnpm typecheck`, `//apps/mvp:importRules`, and effect-electric `pnpm lint`: passed. `/tmp/trackc17-{typecheck-final,importRules,sdk-lint-final}.log`.
- Mini sign-in on the final SDK source: 12 passed, the existing GitHub-only case skipped. `/tmp/trackc17-mini-realms.log`. The first pre-SDK mini run also passed 12/12 available cases.

Astra reviewed the final SDK namespace design with no actionable findings. The initial namespace regression forgot to start its lazy query; its failed receipt is retained at `/tmp/trackc17-realm-regression-unstarted.log`, and the corrected regression passed in the 283-test set. SDK lint initially found one formatting issue; final lint passed after whitespace-only correction.

Focused app selections establish no whole-app coverage claim. The earlier docs-sync/check timeouts, production e2e, and separate browser-runtime configuration remain historical unvalidated items; they were not rerun in this cache-isolation repair. No pushes, deployment, local dependencies, test reordering, new skips, or changes to existing deadlines/assertions.

## Refused shapes after replay isolation — 2026-10-22

Base ec182555; replayed lander's cf5a9aaf → aececc47 → e84c0474, including the flows documentation and e2e wait-helper resolutions. No push.

The full TODO suite reproduced exactly the two reported failures (25 passed, 2 failed). Direct SDK collections retain empty 401/403 responses under isolation. The fault was deferred stack construction: `TodosStore` retained persistence but looked up `ShapeSource` in the later caller's context. Effect 4.0.5’s `Cache.makeWith` merges its construction context with the lookup context using `Context.merge(context, input)`, giving the caller’s services precedence. The simulated tab now exports its isolated source, so that ambient healthy source displaced the refusal source provided when the store was built. Capture the source with the store and provide it when opening each stack. Existing access regressions fail before this change and pass afterward.

The SDK's `layerFaulty` also dropped the wrapped source's namespace. A new parameterized refusal regression failed first for both 401 and 403 because the namespace was undefined; the wrapper now retains it and the test requires both isolation and `Stopped:<status>`. Library catalog entry used: `@smthrs/effect-electric` (Electric-backed collections and injectable shape faults). No new library.

Validation receipts are recorded in the builder report after completion. The initial direct SDK refusal test passed; the namespace-preservation version supplied the red-first SDK proof. Two focused app probes were cancelled while queued for a farm permit; neither supplies a behavioral receipt.

Latitude app proof (`/tmp/trackc17-app-final.log`, nyc-02 slot 1, exit 0): full `todos.test.ts` 27/27; exact `src/features/chat src/device src/features/auth` selection 201/201 across 15 files on each of three consecutive runs; full app `typecheck` and `//apps/mvp:importRules` passed. These focused suites disable whole-app coverage and make no whole-app coverage claim. The SDK attempt was refused by an SSH connection reset before execution (`/tmp/trackc17-sdk-final.log`); the runner’s ten-minute cooldown was observed before retry.

Mini farm: reachability probe passed; `pnpm e2e sign-in.spec.ts` passed 12 tests, with the existing GitHub-only case skipped (exit 0, `/tmp/trackc17-mini-final.log`). No MacBook install or test was run.

Final SDK proof (`/tmp/trackc17-sdk-final-retry.log`, nyc-01 slot 2, exit 0): 130/130 tests across nine files; aggregate statements, branches, functions and lines all 100%; package `check`, `lint` and `//packages/effect-electric:importRules` passed. All requested proofs are complete. No push, deploy or main movement.

## Held-stack relay and Admin authority repair — 2026-10-22

Rebased the four held changes onto fetched `main@origin` `90ea5caf`. The original telemetry/spend selection reproduced 3 failed / 21 passed on nyc-01, including main's engine-worker failure (`/tmp/trackc17-held-red.log`). Both telemetry failures were unregistered engine lifecycle records: `flow.run.created` and `flow.run.claimed`. `FLOWS_TELEMETRY` now retains them and their numeric timestamps, with no identity fields added. The session relay test also requires the creation record and rejects identity fields on every retained record.

The restored spend failure was the shown-alert counter: the test changed a local role but the server still confirmed Admin on reload. The newly added test session route also captured each named actor once, unlike protected routes, which read the mutable actor map. A stronger regression demotes the server actor, performs the real session check, verifies all three queries disappear, and reloads with zero alerts, settings, receipts and shown count. This test failed first with `[1, 1, 1]`; a separate endpoint regression returned Admin after the actor became Member (`/tmp/trackc17-authority-red.log`). The session route now reads current authority through the real SignIn fallback. No permission assertion or deadline was relaxed.

Shared-state audit found the spend permission wrapper discarded `ShapeSource.cacheNamespace`; it now preserves it. The new independent-deployment regression opens Admin devices at the same real origin and reopens the first deployment after the second syncs. It passed before the fix and is additional isolation coverage, not a red-first claim. No new library: catalog entries `@smthrs/effect-electric` and `@smthrs/effect-tanstack-db` remain the sync and collection boundary.

Focused repair validation: 30/30 tests in four files passed on nyc-01 (`/tmp/trackc17-repair-focused.log`). Its following typecheck caught the test helper's missing `AuthClient` service annotation; corrected without a runtime change. Final checks and the three-per-revision five-file A/B completed below. Astra’s read-only repair review found no actionable issues; Fable’s follow-up found no blocking findings. No push, deploy, main movement, or MacBook dependency install/test/check/lint.

Fable requested a direct namespace contract regression and a reload that observes server confirmation without assigning a local role. Both are added: the existing permission wrapper is extracted to `spend/source.ts`, and its namespace regression failed first (one failed / one passed, `/tmp/trackc17-spend-namespace-red.log`, nyc-02). The reload now waits for real startup confirmation and persistence restore, with no test-authored role. The independent-deployment test remains additional behavioral coverage. The initial nyc-01 namespace attempt was cancelled while queued, with no tests executed (`/tmp/trackc17-spend-namespace-queued.log`).

Final repair receipts: the strengthened focused selection passed 32/32 (`/tmp/trackc17-repair-final-checks.log`). Its subsequent typecheck caught a type-only `ShapeSource` annotation; corrected to the public `ShapeSource.Source`. Final full app typecheck and `//apps/mvp:importRules` passed (`/tmp/trackc17-final-typecheck.log`). Astra and Fable reviewed the final repair; no actionable/blocking findings remained. Fable’s minor observability wording correction is included.

The exact five-file A/B ran on nyc-01 slot 17, with `--maxWorkers=2 --coverage.enabled=false`: `src/features/chat/chat.test.ts`, `src/features/chat/controls.test.ts`, `src/telemetry.test.ts`, `src/features/spend/spend.test.ts`, and `src/features/coedit/coedit.test.ts`. Plain main `90ea5caf` had 1 red, 122 passes and 2 expected failures on each of three runs. Repair revision `98e99ee9` had 0 reds, 125 passes and the same 2 expected failures on each of three runs. Main’s sole red was the known telemetry engine-worker lifecycle drift. All five files passed in all three tip repetitions; no chat or controls failure recurred. JSON counts include the two expected failures as passes; the counts above use Vitest’s console categories. Raw receipts: `/tmp/trackc17-ab-main.log` and `/tmp/trackc17-ab-tip.log`.

Only this receipt/status documentation changed after the tested revision. No full-app suite, whole-app coverage, SDK suite rerun, docs sync/check, or e2e execution is claimed for this repair. No push, deployment, main movement, or MacBook dependency install/test/check/lint.
