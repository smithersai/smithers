---
title: CI parity: a machine per job with toolchains
status: in-progress
area: sdk
owner: Codex GPT-6.1 Sol (ci-spine)
updated: 2026-10-23 PDT
links: [../proposals/ci-cd-parity.md, ../features/ci.md, sandboxes.md, sandbox-budgets.md, ../features/sandbox-tools.md, ../decisions/0005-sandboxes-secrets-and-the-forge.md]
---

## Built, 2026-10-22: `ci/job` (the CI spine's slice 2)

- `@smthrs/sandbox`'s `CiJob`: the `ci/job` child flow checks out exactly the commit, runs each step as its own durable action (`ci/job/Step`) and settles `{ outcome, steps }`, `passed`, `failed`, `cancelled` or `skipped`, never a failure. The host provides `CiJob.Machine` ([API](../../../../packages/smithers/flows/sandbox/docs/api.md#cijob)).
- The app's machine (`worker/flows/CiJobMachine.ts`): one `SandboxObject` of `kind: "job"` per `job:<run>:<job>`, from the branch sandbox's image (Node 26.5.0, pnpm 11.25.0, git; Go, Python and `build-essential` since 2026-10-25), registry-only egress, commands as the `ci` user. A job's machine fetches the one commit by its id (`worker/branch/Checkout.ts`), so a fork's head needs no branch. Registered on `FlowExecution` by `ExecutionHost.withCiJobs` ([CI on Smithers](../features/ci.md#jobs)).
- **No `JobSandbox` container class and no `infra/job/Dockerfile`:** the branch sandbox's image already pins the toolchain, and a second class would duplicate `SandboxObject`. bun and Postgres 18 are not in the image; a job that needs them waits for a job image of its own.
- Proof: `worker/flows/CiJob.docker.test.ts` on the Mac mini, real containers of the image: two jobs at once at a commit of `roninjin10/smithers-github-tests` fetched from GitHub, `node --version` v26.5.0 and `pnpm --version` 11.25.0 pass while `exit 1` settles failed.

**Not built:** long commands (`ci-parity-long-commands`: a step is still one sandbox-tools `run`, 600 s at most, 64 KiB of output kept), step logs on a run page, machine sizes.

## Built, 2026-10-21 (the dogfood loop's first slice)

- A pull request head's checks run on a check job: a throwaway branch machine per head, `job-<owner>-<name>-<sha>`, `kind: "job"` on its `SandboxBranch`, put to sleep once its scripts ran ([where checks run](../features/pulls.md#where-checks-run)).
- A job's box reaches `registry.npmjs.org` and `plugins.dprint.dev` and nothing else, through the object's existing outbound intercept and `@smthrs/secrets`' `Egress.forward` with no secret (`worker/branch/JobEgress.ts`, since 2026-10-25 `RegistryEgress.ts`, which every box uses).
- This repository's checks: `.smithers/checks/lint.sh` and `check.sh` run the changed packages' own `lint` and `check` scripts. Simulated on nyc-01 with pnpm 11.25.0 against a T1-like change.
- The lead decided at 12:58 that the sandboxes builder installs Node 26.5.0 (nodejs.org, SHA-256 pinned) and corepack pnpm 11.25.0 in `infra/sandbox/Dockerfile`. Debian's nodejs is v20; the repository needs Node 26.4 or later.

**Not built:** the `ci/job` child flow, matrices and outcome values below; one job per script; a job image of its own.

## Tracker reconciliation — 2026-10-21 13:44 PDT
**What:** Run each PR-head check in its own temporary machine with pinned tools and restricted egress.
**Why:** Hosted checks need isolated machines; branch boxes remain closed.
**Current state:** At 13:26 PDT the dogfood builder reports per-head machines and npm/dprint-only access built. Lint and check passed on Latitude, not a production job container. Node 26.5 image commit a98f91e4 follows the sandbox production test. This is the first hosted-check slice, not proof of every broader CI matrix capability in the historical proposal.
**Next step:** Land and deploy the check slice and pinned tooling; prove independent outcomes, exact-head checkout and sleep in production before expanding the matrix.
**Open questions for Will:** None for this slice; commit-status permission remains tracked separately.
Evidence: script-filtered user-typed messages and lead text replies from session 6253ecf2, approximately 11:44–13:44 PDT; automated notifications and tool content excluded. Rulings and queue answers govern over historical briefs, panel designs, decisions, proposals, TODOs and rules. Product receipts are lead-reported; this pass validates the site build only. Existing execution owners retained; Codex curates tracker documentation.
## Earlier tracker history (retained)
## What

`ci/job`: a child flow that reserves one `JobSandbox` container for a job, checks out the exact SHA, runs its steps in order and settles an outcome value (`passed`, `failed`, `cancelled`, `skipped`), never a failure, so a matrix reports every row.

## Why

The only container today is a branch sandbox: Debian with git, tmux and bash, no Node and no internet (`infra/sandbox/Dockerfile`; [branch workspace](../features/branch-workspace.md) lines 96-102). Every CI job needs a toolchain and a machine of its own, and Smithers' `ci.yml` runs 15 jobs at once. A `SandboxObject` already works under any id, as the `todo` run's `todo-<attemptId>` machines show (`worker/flows/TodoMachine.ts:17`).

## Repositories

Smithers, Tevm, Effect: every job.

## Smallest slice

A `JobSandbox` container class from `infra/job/Dockerfile` (Debian trixie, Node 24, corepack pnpm, bun, git, build-essential, python3 and Postgres 18 binaries, pinned by digest), one object per `job:<run>:<job>`. The job checks out the SHA from the forge after `pullUpstream`, including `refs/pull/<n>/head`, and runs one step through `SandboxTools.run`. `CiJob` lives in `@smthrs/sandbox` (catalog: "Run commands on a container", `docs/libraries.md:64`). Proof: a two-job flow runs `node --version` and `pnpm --version` on two machines at once, and a job that exits 1 settles `failed` while its sibling settles `passed`.

## Disposition

Build now, 2 of 18. Matrix rows 16 to 19. Design: [the CI/CD parity proposal](../proposals/ci-cd-parity.md).

## History

2026-10-20 22:50 PDT: written by the Claude Opus merger from the merged CI/CD parity proposal (Opus and Codex Sol designs, ruling FLOW-8).

## CI-spine rebase receipt, 2026-10-23

Rebased on `eeb01ea499d0`; migration `0053_repo_runs`, generated device epoch 75, decision 0082. Latitude full app gate: 308 files passed, 4,014 tests passed, 2 expected failures and 17 skips; all four coverage metrics 100%, exit 0. Mini CI fixture: 1/1 passed. The grant-store summary integration test now verifies six real ModelStep attempts and allows 90 seconds because the unchanged retry policy can spend 31 seconds in delays. Sandbox: 61 files, 862 tests passed, 31 platform skips, all four coverage metrics 100%. Final typecheck and importRules passed. Docs site generation completed with no output changes; both docs CLI tails timed out after 180 seconds, so the lander runs docs:check on the MacBook as requested. This receipt supersedes the earlier rebase and coverage blockers in this note.
