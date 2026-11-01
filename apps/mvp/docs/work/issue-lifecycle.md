---
title: Issue lifecycle — reproduction, commitment and playable POCs
status: in-progress
area: app
owner: Codex issue-lifecycle burn-down
updated: 2026-10-21 02:06 PDT
links: [../decisions/0018-issue-lifecycle.md, issue-triage.md, issues-to-todos.md, vibelang-coding-factory.md]
---

## Tracker reconciliation — 2026-10-21 02:06 PDT

**What:** Issue reproduction, maintainer commitment and playable POCs.

**Why:** VibeLang’s coding factory needs a clear acceptance and reproduction policy.

**Current state:** The lead reports the reduced issue-lifecycle slice landed in c6940ac5 at 01:49 PDT. The retained burn-down receipt reports 74 tests passing with Triage.ts and lifecycle.ts at full coverage. Sandbox reproduction verification, automatic POCs, playable previews and their budgets/expiry remain unbuilt; no live lifecycle GIF or production completion is established.

**Next step:** Smoke-test the landed slice after deployment; confirm the real test account’s Maintain access before recording. Build the deferred POC/reproduction slice with its own safe sandbox and migration proof.

**Open questions for Will:** The test account’s Maintain grant still needs a completion receipt; do not infer it from App installation.

Evidence: session 6253ecf2 user-typed text and lead replies extracted by script for the latest two hours through 2026-10-21 09:03:39 UTC; current rulings, queue answers, shared briefs/designs and retained builder receipts. Product tests are reported evidence; tracker validation is the site build. Execution owner retained.

## Earlier tracker history (retained)


Will's 19:40 request and lead's 19:42 brief. Implement three vertical slices in the shared checkout without commits. Existing triage and issue-to-TODO work retain their owners. The POC hands a draft to Make TODO; it never starts the factory or commits the draft. Design is proposed; no implementation or passing e2e receipt yet.


Implementation update: missing-repro gate and commitment write/UI/filter are present; migration 0032 and UI wording changeset are written. Nine targeted tests pass and lifecycle policy coverage is 100%. Mini typecheck found shared-checkout errors plus an optional commitment-row typing error, now corrected by requiring the migrated column with item persistence version 3. Wider mini tests and SDK UI tests are queued. The isolated live instance was absent; up.sh created/migrated smithers_live and started :1339. Its browser run is waiting for the shared heavy lock. Sandbox verification and auto-POC remain unbuilt; no feature completion or live/GIF claim.

Continuation 21:05: preserving the existing implementation; mini targeted suites and typecheck requested. Live :1339 is running. No shared database migration or AgentSandbox edits.

Continuation receipts: the first mini run reports shared credential/dispatcher/PR-merge type errors; a focused lifecycle coverage run is still executing. Changed the judge prompt to acceptance for discussion with no implementation/timeline promise, with a regression assertion. Live :1339 responds, but the browser run and docs:check are queued behind the shared heavy lock. The installed Smithers oneshot command is absent; the Smithers terminal print runner was launched on openai:gpt-6.1-sol for the remaining reproduction/POC host and flow slice (report issue-lifecycle-poc-worker.md). A launched runner is not an implementation receipt.

Mini receipt (continuation): issue-lifecycle-mini.log — 118 tests passed across lifecycle/view/Triage/Flows; lifecycle.ts alone measured 100% statements/branches/functions/lines. Broader coverage is not claimed. The later discussion-prompt regression assertion is queued separately.

Repro parser regression: an empty fenced block followed by prose and another fence previously passed the gate. Replaced the cross-line regex with a fence reader; seven behavioral tests pass with 100% statements (39/39), branches (28/28), functions (11/11), lines (31/31). Added the same case through triage so the judge must remain uncalled; mini validation queued. The prompt regression passed separately (1 passed, 57 unselected). The openai API worker failed for credits and was stopped; the replacement is running on codex:sol through the subscription.

Current mini vertical receipt: 13 selected tests passed, 52 unselected, policy coverage still 100% after the fence fix. Broader browser-issues suite: 58 passed, four failures owned by credential/outbox work: issues.test.ts offline send and records, steps.test.ts both no-tab cases. Typecheck log records 15 shared-error files; none in lifecycle.ts/Triage.ts. Browser recording now explicitly applies themeOf(info), matching its chapter manifest.

Continuation boundary receipt: nine new repro gate tests passed locally against scratch schemas in smithers_live (not the shared public schema). Opus has added poc.ts and Repro.ts plus tests. Parent review corrected cross-repository machine-ID collisions and isolated each verification execution so concurrent checks cannot move one another’s pinned checkout; missing/unexecutable commands are unverified. Live sign-in was renewed through GitHub, but the authenticated scratch account is Guest; requested an existing Maintainer profile from the lead. No permission was widened and no fake session was created.

Parent POC review corrections: machine keys now encode repository boundaries and verification execution identity; shell checkout arguments are quoted; empty revisions and shell exit 126/127 cannot verify a reproduction. POC policy: 12 tests pass at 100% coverage. Repro pinning now asks for Contents read permission because GitHub refs require it. The worker remains responsible for completing the Repro/POC wiring, suites, SDK host preview, docs and changesets.

Current ownership seam: parent owns Repro.ts/Repro.test.ts (including telemetry and safety fixes) and validation; POC continuation owns the acceptance trigger, per-repository controls, agent/preview/expiry and host registration. VerifyRepro is still an implementation primitive, not a registered user-facing route; final integration must give it a real caller/host (or explicitly report that gap). Do not leave an unused alternative path. The first Opus run ended at the TUI’s 40-frame backstop; the fresh POC-only run preserves its code and skips redoing Repro.

Parent expiry review: POC machines are now acceptance-scoped too, so an earlier expiry cannot retire a later acceptance. Reclaim no longer records expired after sleepIfIdle answers busy. Remaining integration concern for the POC worker: generation is not yet captured from build-tool calls, so a build failure before publish cannot be assumed to have woken no machine; a long-lived preview also needs explicit retirement rather than pretending a busy server was reclaimed. Add the host capability and cancellation/expiry coverage before claiming completion.

## Burn-down, 23:04

Keep only needs-repro, one App request across reruns, person-only commitment labels/control/chip/URL filter and Accepted for discussion. Removed unfinished Prototype execution registration; draft POC/Repro files are preserved outside the landing. No POC or repository-switch UI is exposed.

Follow-up status: **todo** — sandbox reproduction verification; automatic POC; playable preview; token budget; expiry; repository switch; POC-to-TODO context. No new scope tonight.

Live proof is blocked: the existing real-GitHub recording fails the Maintainer prerequisite because codeplanesmithers is Guest; :1339 is currently down. Do not widen access or manufacture a session.

Burn-down receipts: `vitest run src/features/issues/lifecycle.test.ts --coverage.include=src/features/issues/lifecycle.ts` passes 7 tests at 100% (39 statements, 28 branches, 11 functions, 31 lines). `vitest run src/features/issues/issues.test.ts -t "Maintainer's commitment" --coverage.enabled=false` passes the real durable-outbox/replacement regression. `vitest run worker/flows/TodoHost.test.ts --coverage.enabled=false` passes, including absence of issue/Prototype. Browser and worker tsc complete with shared errors, none in lifecycle files after making the press helper generic over its Effect requirements. Full targeted Triage file: 63 pass, 4 fail (3 timeouts, then an extra decision from timed-out work); not a green suite. Earlier mini receipt issue-lifecycle-triage-coverage.log measured Triage.ts and lifecycle.ts at 100%, 74 tests passed. Latest docs check is queued on the shared heavy lock.

Fresh burn-down mini receipt (23:18): 74 tests passed, Triage.ts and lifecycle.ts both 100% statements/branches/functions/lines, mini-run exit 0 (295.4 s total). This supersedes the local timeout run. Log: /private/tmp/issue-lifecycle-burndown-mini.log. SDK wording: 11 triage-control and 16 issues-view tests passed. No live lifecycle GIF claim: mini-run's copied media are pre-existing shared artifacts, not proof from this unit run.

Unfinished auto-POC code (2026-11-01, stranded-commit audit): a saved builder snapshot, commit e98419b928 in the `~/smithers` jj repository, holds `worker/github/Prototype.ts`, `PrototypeStore.ts`, `Repro.ts` with their tests, `src/features/issues/poc.ts` with its test, and migration `0034_prototypes.ts`. None of it is wired to a flow or the UI, and it predates main's per-repository roles. The builder who finishes slice 3 starts from it: `jj -R ~/smithers --ignore-working-copy file show -r e98419b928 root-file:<path>`.
