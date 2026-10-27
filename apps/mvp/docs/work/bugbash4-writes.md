---
title: Bug bash 4 write admission and progress
status: in-review
area: issues
owner: bb4-writes
updated: 2026-10-27
links:
  - ../decisions/0002-local-first.md
---

Confirm and fix issue-create reload loss, unavailable and offline write feedback, failed comment admission, and branch Publish/Update shared progress. W12 builder reports contain no overlapping fix. Use the catalog's @smthrs/effect-tanstack-db outbox, @smthrs/flow dispatch, and @smthrs/ui shared notices. Validation runs on Latitude; the lander runs deployment regressions after landing.


Code is ready for the lander. The Create receipt survives immediate device reopening; failed admission retries under the same id. Missing request URLs settle with recovery, offline requests say Requested, and failed comments retain their draft and Not sent outcome. Publish and Update share launch, working, completion and failure toasts backed by the write transaction.

Latitude: app typecheck, importRules and lint pass. Issue checks: 121 passed with all changed logic at 100% statements, branches, functions and lines. Branch/notification/server/migration checks: 1,126 passed, 11 declared skips; all changed logic at 100% in all four metrics. UI: typecheck and 2,665 tests pass; 40 DOM checks through V8 prove ToastStack.tsx at 100% in all four metrics.

Production reproduction on the old deployment confirmed all five findings. The new deployment's browser checks remain for the lander: write-admission.spec.ts, issue-create-navigation.spec.ts and branch-publish.spec.ts. The comment admission fault case requires a dev build with the declared faulty Effect service. Apply migration 0071, regenerate the device schema lock for notifications v4, and regenerate the UI API baseline. The underlying WebKit engine/storage failure belongs to the existing storage workstream.
