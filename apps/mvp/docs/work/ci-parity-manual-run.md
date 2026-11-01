---
title: CI parity: run a repository flow by hand with inputs
status: done
area: sdk
owner: ci-run-view
updated: 2026-11-01 PST
links: [../proposals/ci-cd-parity.md, ../features/flows.md, flow-authoring.md]
---

## What

Run a repository flow from its page or `/flow.run`, with a form drawn from its payload schema.

## Why

29 live workflows take `workflow_dispatch` inputs: strings, booleans, choices and defaults. A person's flow takes one string today ([flows](../features/flows.md) line 192).

## Repositories

Smithers, Tevm, Effect.

## Smallest slice

`flow/run { repo, name, ref, input }`, admitted by the route for a Member and up (or the trigger's own minimum). The form is `FlowFormView` (`@smthrs/views`) over the payload's JSON Schema, with defaults and choices kept. The run starts at the head of the chosen branch.

## Disposition

Build now, 9 of 18. Matrix row 8. Design: [the CI/CD parity proposal](../proposals/ci-cd-parity.md).

## Plan (ci-run-view, 2026-10-22)

- `GET /api/repos/<owner>/<name>/flows/<flow>?ref=<branch>`: the flow's inputs as JSON Schema, read from its `flow.ts` at the branch's head in the realm.
- `flow/run { repo, name, ref, input }`: the existing client flow (the person's Run, `/flow.run`, the agent), which with `repo` runs that repository's flow, through the outbox to `POST /api/repos/<owner>/<name>/runs`: a Member and up; the route records the run and starts `repo/Run` with `event: "manual"` at the branch's head.
- The form is `FlowFormView` over that schema, on `/$owner/$repo/actions`.

## History

2026-10-20 22:50 PDT: written by the Claude Opus merger from the merged CI/CD parity proposal (Opus and Codex Sol designs, ruling FLOW-8).

## CI-spine rebase receipt, 2026-10-23

Rebased on `eeb01ea499d0`; migration `0053_repo_runs`, generated device epoch 75, decision 0082. Latitude full app gate: 308 files passed, 4,014 tests passed, 2 expected failures and 17 skips; all four coverage metrics 100%, exit 0. Mini CI fixture: 1/1 passed. The grant-store summary integration test now verifies six real ModelStep attempts and allows 90 seconds because the unchanged retry policy can spend 31 seconds in delays. Sandbox: 61 files, 862 tests passed, 31 platform skips, all four coverage metrics 100%. Final typecheck and importRules passed. Docs site generation completed with no output changes; both docs CLI tails timed out after 180 seconds, so the lander runs docs:check on the MacBook as requested. This receipt supersedes the earlier rebase and coverage blockers in this note.

## Engine slice landed, 2026-11-01

Landed from the stranded `~/smithers` commit `d8e24d5fbe94` (stranded-audit/home-2), re-implemented on current main: `Realm.describe` (a flow's inputs as JSON Schema), `RunRequest` with `event: "manual"`, `input` and `only` (Retry failed), `manual` trigger rows (`Triggers.manualFlows`), the e2e fixture's `hand` flow, and a run whose jobs failed settling its row `failed`. Still to build on current main: `GET /api/repos/<o>/<n>/flows[/<flow>]` and `POST /api/repos/<o>/<n>/runs` (per allowlisted repository and its role, decision 0079), the `repo/run` client flow, the Run form (`FlowFormView`) on `/$owner/$repo/actions`, and Retry and Retry failed on a repository's run. The stranded commit holds a single-repository version of all of it (`worker/ci/RunsApi.ts`, `e2e/actions.spec.ts`).

## Routes, form and Retry landed, 2026-11-01

The rest of `d8e24d5fbe94`, ported by stranded-audit/home-2 onto the allowlist and per-repository roles: `worker/ci/RunsApi.ts` (`GET .../flows`, `GET .../flows/<flow>`, `POST .../runs` for a run by hand and Retry/Retry failed), the `repo/run` client flow and its `repo/run/start` step, the Run form (`RepoFlowsView`, `FlowFormView`) on `/$owner/$repo/actions`, Retry and Retry failed on a repository run's page, and `e2e/actions.spec.ts`. See [actions](../features/actions.md#running-a-flow-by-hand).
