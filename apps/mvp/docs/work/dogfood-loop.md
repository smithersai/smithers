---
title: Dogfood loop — Smithers builds Smithers on production
status: in-progress
area: app
owner: dogfood-loop builder (Claude Opus), from 11:10 on 2026-10-21
updated: 2026-10-21 13:45 PDT
links: [../rulings.md, ../features/issues.md, ../features/todos.md, ../features/pulls.md, ../proposals/ci-cd-parity.md, ../decisions/0016-todos-and-the-stack.md, todos-and-stack.md, issues-to-todos.md, prod-flows.md, ci-parity-commit-statuses.md, ci-parity-job-sandbox.md, ci-parity-repo-flows.md, ci-parity-required-checks.md, sandboxes.md]
---

**What:** One real low-priority issue on `smithersai/smithers` goes through the production app: the issue is opened in the app, TODOs are made from it, their runs open a stacked diff (one pull request per TODO, in the stack's order), Smithers runs the repository's checks on our infrastructure and reports them on each head as `smithers/<check>` commit statuses, and a person merges.

**Why:** Will, 2026-10-21 11:10: "Seeing if we can use our own product to produce an issue make todos from that issue produce a stacked diff run ci/cd on our infrastructure and merge. We likely are unable to do this yet and should prioritize unblocking it."

**The issue:** [smithersai/smithers#4432](https://github.com/smithersai/smithers/issues/4432): this note named #4430's platform-browser import() type annotations, which main has since fixed. Two TODOs, nothing blocked by them.

## Where it stands (2026-10-21 13:45, production 931fed70)

| Step | Status | Evidence, or what's left |
|---|---|---|
| 1. Open the issue in the app | **Works on production** | `e2e/dogfood.spec.ts` "dogfood 1" passed at 13:10: a Member opened [smithersai/smithers#4430](https://github.com/smithersai/smithers/issues/4430) through the app, under their own account. GIF `prod/gifs/dogfood-dogfood-1-the-issue.gif` |
| 2. Make TODOs | Built, not deployed | Make TODO stays on an open issue while its TODOs are open (lander queue) |
| 3. A stacked diff | Built, not deployed | Stacked pull requests; waits for a rebase onto the durable-effects `todo/Begin` and `todo/Publish` |
| 4. CI/CD on our infrastructure | Built, not deployed; blocked twice | GH-10 statuses and check jobs (registry-only egress, `.smithers/checks/lint.sh` and `check.sh`, which pass on nyc-01 for the loop's first TODO). Blocked on the App's "Commit statuses" permission (Will) and on Node 26.5 and pnpm 11.25 in the image (sandboxes builder) |
| 5. A person merges | Unchanged | Will or a Maintainer |

**The loop's TODOs** (dogfood 2): the fix to both lines, then its changeset, stacked on it. Each passes the package's lint and typecheck on its own, so both pull requests can go green.

## The map (2026-10-21 11:20, against `main@origin` c8df75af and production 78407fce)

| Step | Built in code | In production now | Blocker | Whose |
|---|---|---|---|---|
| 1. Open the issue in the app | Yes: New issue, `/issue` and the agent run `issue/create`; the writes route stores the write and starts `github/Write` on `FlowExecution`, which posts as the person ([issues](../features/issues.md)) | **Fails.** The write is stored, but `github/Write` is a remote flow, and every remote flow fails on the Worker's QuickJS WebAssembly compile. The issues list is empty: `items` and `github_sync` have no rows for `smithersai/smithers` because `github/Reconcile` never finished | Remote flows on production | prod-flows and prod-remote-flows builders (factory stack's QuickJS-on-workerd fix, then a deploy) |
| 2. Make TODOs from it | Partly: Make TODO (`todo/issue`) drafts a TODO linked to the issue; a Member commits it through the stack route, which needs no remote flow. Make TODO shows only while none of the issue's TODOs is open, so an issue gets one TODO at a time | **Blocked** behind step 1: Make TODO needs the issue synced to the device | (a) step 1; (b) one TODO per issue | (a) prod-flows; (b) mine |
| 3. A stacked diff | Partly: the `todo` run takes one TODO to one pull request, on its own branch machine. One lane, each TODO from `main` after the one before it settles: a queue of pull requests, never a stack | **Off.** `TODO_RUNS` defaults off on 78407fce; the factory stack turns it on, moves the machine's checkout to GitHub and gives ChatApi five minutes of CPU | (a) TODO runs in production; (b) stacked bases: the next TODO starts on the previous one's branch while it is in review, its pull request based on that branch, retargeted to `main` and updated when it merges (decision 0016 slice 2, cut until "a person needs it": Will needs it now) | (a) prod-flows; (b) mine |
| 4. CI/CD on our infrastructure | Partly: `checks/Run` starts on each published head and runs each `.smithers/checks/<name>.sh` on the TODO's machine, plus the `review` check. No commit status is written (GH-10 unbuilt; `docs/rules.md` still forbids statuses). `smithersai/smithers` has no `.smithers/checks/`. The branch machine's image has git and bash only: no Node, no pnpm, and no egress but the forge, so no Smithers check can run there | **Off** with step 3. On a published head only `review` would run | (a) GH-10 statuses; (b) the repository's checks; (c) a machine with Node 24, pnpm and npm registry egress | (a) mine; (b) mine; (c) ask the lead: the sandboxes builder owns the image, `ci-parity-job-sandbox` has no owner |
| 5. A person merges | Yes: Merge on the pull request page (`pr/merge`, a Maintainer's own press, squash) or GitHub's button. The `Main` ruleset requires linear history and no status checks yet | Pull request pages are in the factory stack, not on 78407fce; GitHub's button works today | None for a person. `codeplanesmithers` is a Member and can't merge, by design (M-47) | Will or a Maintainer |

**Verdict:** the loop can't run on production today. Step 1 fails at the remote flow; everything after it waits. Once the factory stack and the prod-flows fixes deploy, steps 1, 2 (one TODO) and 3 (one pull request at a time) are expected to work; a stacked diff and our own CI checks don't exist in code.

## Build order (smallest first)

1. **GH-10 commit statuses** (mine). `GitHub.Statuses.create` in `@smthrs/integrations`; `checks/Run` writes `smithers/<check>` pending when a check starts and success or failure when it ends, on the head SHA, as the App with `statuses: write`. Amend `docs/rules.md`'s no-statuses rule to GH-10's write-only exception. Needs the App's "Commit statuses: write" permission: confirm it on production, or ask Will to grant it.
2. **More than one TODO per issue** (mine). Make TODO stays on an open issue while its TODOs are open, so one issue yields a stack.
3. **The repository's checks** (mine): `.smithers/checks/<name>.sh` in this repository, replicating `ci.yml`'s cheapest gates for the package a change touches (lint and typecheck), and **a machine that can run them** (Node 24, pnpm, npm egress): extend the branch image or add `ci-parity-job-sandbox`'s `JobSandbox`, whichever the lead assigns.
4. **Stacked bases** (mine). A TODO in review frees its lane; the next starts on its branch, and its pull request is based on that branch. When the earlier one merges, the later run retargets its pull request to `main`, merges `main` in, and its new head's checks run. An earlier TODO dropped or closed fails the later one (`base_closed`) until slice 2's reset-and-redo.
5. **Run the loop** on production: open the issue in the app, Make TODO twice, commit both, watch two stacked pull requests go green, record each step, stop for a person's merge.

## History

2026-10-21 13:45 PDT: step 1 works on production (#4430); GH-10, more TODOs per issue, stacked pull requests and check jobs built; the dogfood spec runs each step against a deployment named by `E2E_DOGFOOD=smithersai/smithers`.

2026-10-21 11:20 PDT: map written by the dogfood-loop builder from `main@origin` c8df75af, the peer workspaces' unlanded commits (factory stack, prod-flows), production shapes read as `codeplanesmithers`, and `smithersai/smithers`' settings (`delete_branch_on_merge` off, the `Main` ruleset: no deletion, no force push, linear history).
