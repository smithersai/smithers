# CI/CD parity: GitHub Actions jobs as Smithers flows

Status: the spine is built (gaps 2 to 6: [CI](../features/ci.md), [actions](../features/actions.md)); gap 1 (job secrets) and gaps 7 to 18 are not. Will answered its questions as rulings GH-9 and GH-10. Proposed 2026-10-20; merged by Claude Opus from two independent designs, Opus and Codex Sol (PROC-6). It answers ruling FLOW-8 ([rulings](../rulings.md)): replicate all the CI/CD of Smithers, Tevm and Effect as `Flow.make` TypeScript running on Smithers cloud, and add or ticket every missing capability. The full drafts are in the session scratchpad: `final/ci-parity-opus.md` and `final/ci-parity-sol.md` (Sol's carries a step-by-step inventory of every job).

**Summary.** The flow engine can already express every job graph in these repositories, but Smithers can't run one: it lacks a job machine with toolchains and secrets, repository flows, GitHub event and cron triggers, long commands and a way to watch a remote run, and those six gaps are the build-now spine.

**In one paragraph.** We read 49 workflow files: Smithers 14, Tevm 16, `Effect-TS/effect` 9 on `main` (Effect 4) and 5 on `v3` (Effect 3), and the retired `effect-smol` 5. `@smthrs/flow` covers job graphs, matrices, dynamic fan-out, retries, timeouts, approvals and external jobs, and it runs on Cloudflare Durable Objects with child flows routed to their own objects (`worker/ExecutionHost.ts:192-226`). Everything around the engine is missing. The only container is a branch sandbox with git, tmux and bash, no internet, and commands capped at 600 seconds and 64 KiB of output (`infra/sandbox/Dockerfile`, `packages/smithers/flows/sandbox/src/SandboxTools/index.ts:59-70`). Repository flows are neither discovered nor run ([flows](../features/flows.md) line 202). `@smthrs/triggers` exists, but nothing in the app runs it (`worker/github/Reconcile.ts:19`). The webhook route starts no flow on a push, pull request or tag (`worker/github/Api.ts:323-405`), and it serves one repository per deployment (`worker/github/Config.ts:1-5`). The Runs page reads only this browser's engine ([runs](../features/runs.md) lines 14-17). Smithers and Tevm already declare their CI as typed targets that render GitHub YAML (`PACKAGE.ts:580-660`, `tevm-monorepo/.github/PACKAGE.ts:44-60`). Most of their jobs therefore port as "check out the SHA, set up, run one `smthrs` target" on a job machine. Of 52 capabilities, 10 exist, 14 are small additions, 16 are missing and built now, and 12 are tickets. That makes 18 build-now gaps and 8 ticket-only gaps, each with a work note named `ci-parity-<gap>`. macOS, Windows, arm64, self-hosted, GPU, Docker in the job, KVM and OIDC provenance are tickets. Two questions go to Will: how we publish to npm without GitHub's OIDC, and whether Smithers may write commit statuses so GitHub's branch protection can require Smithers checks.

## What exists today

Paths that start with `worker/`, `infra/`, `src/` or `alchemy.run.ts` are under `apps/mvp/`; `flow/…` is `packages/smithers/flows/flow/…`; every other path starts at the repository root.

| Area | Today | Evidence |
|---|---|---|
| Durable engine on Cloudflare | One `FlowExecution` Durable Object per execution, woken by alarms, over Postgres through Hyperdrive | [remote flows](../features/remote-flows.md); `worker/ExecutionHost.ts:192-226` |
| Child flows on Cloudflare | Each child is routed to its own object | `worker/ExecutionHost.ts:196-201`; `worker/Executions.ts:101-104`. [Remote flows](../features/remote-flows.md) line 95 still says they don't run, which is stale |
| Job graph, matrix, branch, recovery | `Node.all`, `Node.andThen`, `Node.bindPlanned`, `Node.branch`, `Node.catch`; a shape known only at run time is a new trampoline round | `packages/smithers/flows/flow/docs/guides/build-a-body.md:57-155`; `packages/smithers/flows/plan/docs/api.md:730-741` |
| Retries and timeouts | `RetryPolicy`; `Flow.make({ deadline })`; `Action.make({ attemptTimeoutMs, heartbeatTimeoutMs })` | `flow/docs/api.md:47`, `:374-384`; `flow/src/Action/make.ts:125-140` |
| Waits and external work | `DurableClock`, `WaitFor`, `Poll`, `ExternalJob` (start, probe, collect, cancel, journaled deadline) | `flow/docs/api.md:246-321` |
| Approvals | `HumanTask` with deadline and re-asking; `run/answer` is person-only | `flow/docs/api.md:342-370`; [flows](../features/flows.md) line 62 |
| Result reuse and selective replay | `Action.withCache` with a shared scope; `TimeTravel` `replay`, `inspect`, `fork`, `rewind` | `flow/docs/guides/reuse-a-recorded-result.md:15-35`; `docs/libraries.md:230` |
| Cron and webhook triggers (SDK) | `Trigger.make`, `Cron`, overlap `skip`, `buffer-one`, `supersede`, catch-up, `Scheduler.make` (forks nothing), `Webhook.make` | `docs/libraries.md:269`; `packages/smithers/agent/triggers/docs/api.md:42-160`, `:602-810` |
| Cron in the app | Not wired | `worker/github/Reconcile.ts:19` |
| GitHub webhook | Verified HMAC route. Issue and pull request events of the one synced repository start `github/Apply`; `issues.opened` starts `triage/Run`; a push to the default branch and a published release become notifications only | `worker/github/Api.ts:259`, `:323-405`; `worker/github/Config.ts:1-5`; `worker/Notifications.ts:261-290` |
| Pull request checks | `checks/Run` runs each `.smithers/checks/<name>.sh` in turn on a TODO attempt's machine, plus the review. Each is a `runs` row on the head SHA that the Checks tab reads. Only a `todo` run's publish starts it, and it never gates the merge | `worker/flows/Checks.ts:30-41`, `:86-99`, `:147-203`; `worker/flows/Todo.ts:514`; `src/features/pulls/contract.ts:11-14` |
| Merge | `pr/Merge` reads no Smithers check; GitHub's own protection applies | `worker/github/Merge.ts:14-21` |
| Machines | `SandboxObject` per id with one Debian image (git, tmux, bash, CA certificates), no internet, a read-only forge proxy; any id works, as `todo-<attemptId>` shows | `worker/BranchSandboxes.ts:31-38`; `infra/BranchSandbox.ts:8-11`; [branch workspace](../features/branch-workspace.md) lines 96-102; `worker/flows/TodoMachine.ts:15-30` |
| Machine limits | linux/amd64 only, Docker only with host networking, no KVM, at most 4 vCPU, 12 GiB and 20 GB; size is a per-class `instanceType` | [0005](../decisions/0005-sandboxes-secrets-and-the-forge.md) lines 49-53 and 73; `node_modules/alchemy/src/Cloudflare/Containers/ContainerApplication.ts:111` |
| Secrets | Write-only repository secrets; the egress puts a value only into the headers of requests to that secret's hosts; `EGRESS_ALLOW_HOSTS`; off unless `SANDBOX_SECRETS` | [secrets](../features/secrets.md) lines 3 and 39-51; `worker/BranchSandboxes.ts:51-56` |
| Runs UI | List and page read this device's engine only; Stop, Retry (whole run), Resume; no step retry; no repository runs page | [runs](../features/runs.md) lines 14-17, 41-46 and 83 |
| Repository flows | Not built: no discovery, activation or host for repository code | [flows](../features/flows.md) line 202; [0014](../decisions/0014-flows-authoring-debugging-and-home-view.md) lines 20, 185, 399-400; [0017](../decisions/0017-everything-is-a-plugin.md) line 735 |
| Plugin triggers (approved design) | `contributes.triggers` (event, cron, webhook, run events) in slice 2; `pr/checks` collect hook; `merge/rules` guard hook | [0017](../decisions/0017-everything-is-a-plugin.md) lines 276-279, 341, 362-368, 533-538 |
| GitHub writes (SDK) | `CommentOnIssue`, `AddLabels`, sticky `UpsertComment`, `createPull`, `createReview`, `createBranch`; `CheckRun` exists, and the app bans it (`github.no-actions`) | `packages/smithers/agent/integrations/src/GitHub/Actions.ts:90`, `:207`, `:324`, `:473`; `GitHub/Pulls.ts:306`, `:460`; `GitHub/Refs.ts:121`; [rules](../rules.md) line 436 |
| Caches and blobs (SDK) | `ArtifactStore`, `RemoteArtifacts`, `ImmutableCache`, `step-cache`; the app binds no R2 bucket | `docs/libraries.md:68-69`, `:229`, `:233`; `alchemy.run.ts:1-22` |
| CI as typed targets | `Smithers.GithubCiGen` and `S.Github.Workflow` render workflows from target graphs with toolchains, secrets and a remote cache | `packages/smithers/build/targets/src/GithubCiGen.ts:1-20`; `PACKAGE.ts:553-660`; `tevm-monorepo/.github/PACKAGE.ts:1-60` |

## Capability matrix

Status: **exists**; **small** (small addition, built now); **build** (missing, built now); **ticket** (missing, ticket only). Repositories: S Smithers, T Tevm, E Effect (main and v3). Appendix A lists every workflow; Sol's draft cites each step.

| # | GitHub feature | Used by | Smithers equivalent | Status | Work note |
|---|---|---|---|---|---|
| 1 | `push` to branches | S ci, distribution, drift, native-windows, reference-host, trusted-setup-validation; T ci, prerelease, release, wasm-size-check; E check, release, snapshot, release-queue | the route records a push (`Api.ts:323-405`, `Notifications.ts:268-282`) and starts nothing | build | `ci-parity-triggers` |
| 2 | `pull_request` | S ci, distribution, drift, native-windows; T ci, parity-suites, review, wasm-size-check, claude-code-review; E check, snapshot | reaches `github/Apply` (`Apply.ts:52`); `checks/Run` starts only from a TODO publish (`Todo.ts:514`) | build | `ci-parity-triggers` |
| 3 | Tag pushes and release events | S release, apps-deploy (`v*`) | not decoded | build | `ci-parity-triggers` |
| 4 | `issues`, `issue_comment`, labels, reviews, `pull_request_target` | T claude, factory-intake, factory-issue; E release-queue, effect-bot | ingested for sync and triage (`Api.ts:259`, `:377`); no repository flow starts | build | `ci-parity-triggers` |
| 5 | Every repository on one deployment | all | one synced repository (`github/Config.ts:1-5`) | build | `ci-parity-triggers` |
| 6 | Fork pull requests without secrets; base-trusted runs | E snapshot (fork gate), release-queue; S trusted-drift | none | build | `ci-parity-triggers` |
| 7 | `schedule` crons | S canary, reliability; T cron-nightlyConformance, claude-auto-update; E npm-promote, ai-codegen | `@smthrs/triggers`, not wired (`Reconcile.ts:19`) | build | `ci-parity-cron` |
| 8 | `workflow_dispatch` with typed inputs | S 9 files, T 12, E 8 | the payload schema is the input; personal flows take one string ([flows](../features/flows.md) line 192) | small | `ci-parity-manual-run` |
| 9 | `paths` filters | S native-windows, trusted-setup-validation | none; the compare route exists (`worker/github/Compare.ts`) | small | `ci-parity-path-filters` |
| 10 | Workflows defined in the repository | all | not built ([flows](../features/flows.md) line 202; 0017 slice 5) | build | `ci-parity-repo-flows` |
| 11 | `needs` job graph | S release, apps-deploy, drift; T factory-issue; E snapshot | `Node.andThen`, `Node.bindPlanned` | exists | none |
| 12 | Static matrix, `include`, `fail-fast`, `continue-on-error` | S ci, release, reliability, apps-deploy; E check, V3 check | `Node.all` keyed by row; `Node.catch` | exists | none |
| 13 | Dynamic matrix (`fromJSON`) | S release (145-149), reliability (248) | a trampoline round sized from a step's result | exists | none |
| 14 | Reusable workflows, composite actions | S drift calls trusted-drift; T and E setup actions | `.call()`, `.child()`, plain TypeScript functions | exists | none |
| 15 | `workflow_run` | E npm-promote, bundle-comment | a later step of the same flow; run-event triggers are 0017 slice 2 | exists | none |
| 16 | A Linux machine per job | every job | `SandboxObject` per id; git, tmux and bash only; no internet | build | `ci-parity-job-sandbox` |
| 17 | Toolchains: Node, pnpm, bun, Deno, Rust, Go, Foundry, Zig, jj | all | none in the image | build | `ci-parity-job-sandbox` |
| 18 | Postgres for tests | S distribution, ci, release (installed by script, never a service container) | Postgres 18 in the CI image, started per job | small | `ci-parity-job-sandbox` |
| 19 | Parallel machines | S ci (15 jobs), E check (6) | one object and container per job id | build | `ci-parity-job-sandbox` |
| 20 | Long jobs (to 360 min) | S ci (180, 190), release (330), reliability (360) | `SandboxTools.run` caps at 600 s and 64 KiB | build | `ci-parity-long-commands` |
| 21 | Machine sizes (larger runners, Namespace profiles) | E check, snapshot, cluster, ai-codegen | `instanceType` per container class | small | `ci-parity-machine-sizes` |
| 22 | Dependency caches (setup-node, rust-cache, mise, `actions/cache`, nscloud) | all | SDK only; no bucket bound | build | `ci-parity-cache` |
| 23 | Remote build cache | S ci, release | `build.smithers.sh` (`docs/libraries.md:311`) through the egress | small | `ci-parity-job-secrets` |
| 24 | Artifacts, retention, handoff between jobs | S ci, release, reliability, apps-deploy, canary, native-windows; T factory-intake, factory-issue; E check, bundle-comment | none bound | build | `ci-parity-artifacts` |
| 25 | Job outputs, step summaries | S release; T factory-intake | step results on the run page | exists | none |
| 26 | Repository secrets in jobs | all | egress placeholders, off by default ([secrets](../features/secrets.md) line 51) | small | `ci-parity-job-secrets` |
| 27 | Environments: reviewers, branch policy, scoped secrets | S release, apps-deploy, npm-dist-tag, release-auth; T factory-configure, factory-issue; E snapshot (`fork`), npm-promote | `HumanTask`; main-only secrets designed, unbuilt (0005 line 209) | small | `ci-parity-environments` |
| 28 | People approve, agents never | all environments | `HumanTask` and person-only `run/answer` | exists | none |
| 29 | A token for GitHub writes: PRs, branches, tags, releases, deployments, `repository_dispatch` | S release; T prerelease, release, factory-issue; E release, npm-promote, release-queue, ai-codegen | the SDK has PRs and branches; no releases, tags, deployments or dispatch; no grant to repository flows | build | `ci-parity-github-writes` |
| 30 | Bots that comment or label | S canary; T claude, claude-code-review, factory-configure; E bundle-comment, release-queue, effect-bot | `UpsertComment`, `AddLabels`; `checks/Review` posts a review (`Checks.ts:232-262`) | small | `ci-parity-github-writes` |
| 31 | Agents in CI (claude-code-action, Claude Code CLI, Codex) | T claude, claude-code-review, claude-auto-update, factory-issue, review | the Smithers agent: `checks/Review`, the `todo` run behind `TODO_RUNS` (`Todo.ts:44-47`), triage | exists | `ci-parity-triggers` (mention trigger) |
| 32 | npm and JSR publishing with tokens; dist-tags | S release, npm-dist-tag, release-auth; T prerelease, release, snapshot, jsr-publish; E release, npm-promote | the egress puts `NPM_TOKEN` or `JSR_TOKEN` into the request header | small | `ci-parity-publish` |
| 33 | npm trusted publishing and provenance; JSR OIDC; keyless cosign; cloud federation | S release; T prerelease, jsr-publish; E release, npm-promote | npm accepts only GitHub Actions, GitLab.com and CircleCI cloud; provenance only the first two ([npm](https://docs.npmjs.com/trusted-publishers)); JSR only GitHub Actions ([JSR](https://jsr.io/docs/publishing-packages)) | ticket | `ci-parity-oidc-provenance` |
| 34 | Deploys, pushes to other remotes, outgoing webhooks | S apps-deploy; E npm-promote, effect-bot, V3 release | the egress with a bound header | small | `ci-parity-job-secrets` |
| 35 | `concurrency` groups, `cancel-in-progress` | S 13 files, T 7, E 8 | execution identity dedupes; cron overlap `supersede`; nothing for events | small | `ci-parity-concurrency` |
| 36 | `timeout-minutes` | all | `deadline`, `attemptTimeoutMs`, `heartbeatTimeoutMs`; commands past 600 s need long commands | exists | `ci-parity-long-commands` |
| 37 | Retries | S release (publish retries) | `RetryPolicy` | exists | none |
| 38 | Watching a run live, logs, a repository's runs list | all | device engine only ([runs](../features/runs.md) lines 14-17) | build | `ci-parity-run-view` |
| 39 | Cancelling and re-running a whole run | all | `run/cancel` and `run/retry` on device runs ([runs](../features/runs.md) lines 43-44) | small | `ci-parity-run-view` |
| 40 | Re-running failed jobs | all | "No step retry is offered" ([runs](../features/runs.md) line 83) | small | `ci-parity-rerun-failed` |
| 41 | Retry from a chosen step | all | Retry from here on device runs: `run/retry/from` over `FlowRuntime.retryFrom` (ruling FLOW-11); not yet on Cloudflare runs | exists | `ci-parity-retry-from-here` |
| 42 | Required checks on pull requests | E main (6 checks), `v4/next-*` (7), V3 (6) | the Checks tab reads `runs` on the head; `pr/Merge` ignores them (`Merge.ts:21`); `merge/rules` hook designed | small | `ci-parity-required-checks` |
| 43 | Status badges | no README in the three repositories uses a CI badge | none | ticket | `ci-parity-status-badges` |
| 44 | Docker daemon, testcontainers, service containers | S ci (35-47), release; E check Test (145-154), cluster | Docker with host networking only | ticket | `ci-parity-docker` |
| 45 | KVM, microVMs, privileged sysctl, bubblewrap user namespaces | S ci (87-95), release (926-943), reliability (336-353) | none on Cloudflare | ticket | `ci-parity-privileged-linux` |
| 46 | macOS runners | S ci `packages` (advisory), release (4 jobs), reliability | none | ticket | `ci-parity-advanced-runners` |
| 47 | Windows runners | S ci `packages` (advisory), release, native-windows | none | ticket | `ci-parity-advanced-runners` |
| 48 | Linux arm64 runners | S release `native-helper`, `installer-archive` | linux/amd64 only | ticket | `ci-parity-advanced-runners` |
| 49 | Self-hosted runners | S reference-host, reliability | `smthrs environment` SSH locations as prior art | ticket | `ci-parity-advanced-runners` |
| 50 | GPU runners | none | none | ticket | `ci-parity-advanced-runners` |
| 51 | Preview packages (pkg.pr.new) | E snapshot, V3 snapshot | pkg.pr.new checks the Actions run | ticket | `ci-parity-preview-packages` |
| 52 | Workflows generated from target declarations | S (`GithubCiGen`), T (`S.Github.Workflow`) | a GitHub renderer only | ticket | `ci-parity-flow-renderer` |

**Counts.** 52 capabilities: 10 exist, 14 small additions, 16 missing and built now, 12 tickets.

## Build-now gaps, in order

The first six are the spine: nothing runs or shows without them, so they come first whatever their size. After them, the order puts what the most workflows need first, and the smaller item first on a tie. Once the spine lands, items 7 to 18 can run as parallel lanes.

| # | Gap | Size | Workflows that need it | First slice |
|---|---|---|---|---|
| 1 | `ci-parity-job-secrets` | S | all three repositories | Prove the egress with an e2e (a bound host gets the value; the box never sees it), turn `SANDBOX_SECRETS` on, and allow `registry.npmjs.org`, `build.smithers.sh` and the toolchain download hosts. |
| 2 | `ci-parity-job-sandbox` | M | every job | `ci/job`: a `JobSandbox` container class from a CI image (Node, pnpm, bun, git, build tools, Postgres 18), one object per `job:<run>:<job>`, which checks out the SHA from the forge after `pullUpstream`, runs its steps and settles an outcome. |
| 3 | `ci-parity-repo-flows` | L | every workflow | Discover `.smithers/flows/<name>/flow.ts` on the default branch, read its `triggers` literal without running it, and evaluate its body in the QuickJS realm on `FlowExecution`, with `ci/job` as its machine action (0017 slice 5). |
| 4 | `ci-parity-triggers` | M | 28 of 44 live workflows | `push` and `pull_request` for every installed repository start each active flow whose trigger matches, with `{ repo, sha, ref, event }` and execution id `<flow>:<delivery>`; fork pull requests run without secrets. |
| 5 | `ci-parity-long-commands` | M | S ci, release, reliability; every job over 10 minutes | Each step is an `ExternalJob` over a detached process in the job's box (start once by call id, probe with a heartbeat, collect, cancel), with its log written to a file the box keeps. |
| 6 | `ci-parity-run-view` | M | all | `/$owner/$repo/actions` lists the repository's `runs`, and a run page reads a Cloudflare run's journal and step logs through `GET /api/runs/:id/trace`, with Stop and Retry. |
| 7 | `ci-parity-cache` | M | every job that installs dependencies | An R2 bucket behind `RemoteArtifacts`; `ci/job` restores and saves a directory keyed by a lockfile hash, scoped so a pull request can't write the default branch's entry. |
| 8 | `ci-parity-concurrency` | S | 28 | `concurrency: { group, cancelInProgress }` on a trigger: a run with the same group key interrupts or queues the earlier one, and a publish step is never interrupted half done. |
| 9 | `ci-parity-manual-run` | S | 29 | Run a repository flow from its page or `/flow.run`, with a form drawn from its payload schema (`FlowFormView`), Member and up. |
| 10 | `ci-parity-github-writes` | M | 17 | System actions repository flows may call with the installation token: commit files to a branch, open or update a PR, create a tag, create a release with assets, create a deployment, send `repository_dispatch`, plus the existing comment and label actions. |
| 11 | `ci-parity-artifacts` | M | 11 | Named artifacts with a retention, uploaded on success or failure, handed between jobs by digest and downloadable from the run page. |
| 12 | `ci-parity-environments` | S | 9 | `environment: "<name>"` on a job: a Maintainer approves through `HumanTask` bound to the exact candidate digest, and only then does the job get that environment's secrets. |
| 13 | `ci-parity-publish` | S | 9 | `npm publish`, `npm dist-tag` and `jsr publish --token` through the egress, proven against a scratch package, with the version read back after each write. |
| 14 | `ci-parity-cron` | M | 6 | A `triggers/Tick` lineage on `FlowExecution`: one step calls `Scheduler.make(...).runOnce` over `SqlTriggerStore` with a runner that starts flows through `FlowStarter`, then a durable one-minute sleep and a hand-off. |
| 15 | `ci-parity-rerun-failed` | S | all | Each `ci/job` result is sealed under `(repo, sha, job, inputs digest)` with `Action.withCache`, so Retry failed starts a new run that replays passed jobs and reruns the failed ones. |
| 16 | `ci-parity-machine-sizes` | S | E check, snapshot, cluster, ai-codegen | Two more container classes (`standard-2`, `standard-4`) and `machine` on `ci/job`; an unknown size is refused before anything runs. |
| 17 | `ci-parity-path-filters` | S | S native-windows, trusted-setup-validation | `paths` and `pathsIgnore` on a trigger, matched against the push's commits or the compare API; when the diff can't be read, the flow runs. |
| 18 | `ci-parity-required-checks` | S | E main, `v4/next-*`, V3 | A repository setting lists required flows per branch; `pr/Merge` refuses until each has passed on the head SHA (0017 `merge/rules`). |

## Ticket-only gaps

| Gap | Why it's a ticket | What it blocks |
|---|---|---|
| `ci-parity-advanced-runners` | Will: macOS and other advanced machines are tickets. Cloudflare has no macOS, Windows, arm64 or GPU containers, and a self-hosted machine needs a runner agent | macOS: S ci `packages` (advisory), release `server-bundle`, `native-helper`, `installer-archive`, `homebrew-bottle`, the reliability reference leg. Windows: S ci `packages` (advisory), native-windows, release `native-helper`. arm64: S release `native-helper`, `installer-archive`. Self-hosted: S reference-host, reliability. GPU: none |
| `ci-parity-docker` | Docker runs only with host networking; testcontainers maps ports | E Test (Node, Deno, Bun) integration tests and cluster; S tests that use the Docker image store |
| `ci-parity-privileged-linux` | No KVM; no user-namespace sysctl | S release and reliability fault suites; bubblewrap tests |
| `ci-parity-oidc-provenance` | npm, JSR and Sigstore accept only named CI issuers | S release provenance and cosign; E release and npm-promote; T jsr-publish |
| `ci-parity-preview-packages` | pkg.pr.new checks the GitHub Actions run | E and V3 snapshot |
| `ci-parity-retry-from-here` | Built for runs on this device (ruling FLOW-11, `FlowRuntime.retryFrom`); a run on Cloudflare doesn't offer it yet | none; Retry failed covers the common case |
| `ci-parity-status-badges` | No README uses one | none |
| `ci-parity-flow-renderer` | A migration convenience, not parity | S and T generated workflows |

## Design

```
GitHub ──webhook──▶ Worker (ChatApi): verify, dedupe by delivery, match triggers ──▶ FlowStarter
cron   ──triggers/Tick lineage (FlowExecution)──────────────────────────────────────▶ FlowStarter
person ──Run with inputs (manual-run)─────────────────────────────────────────────▶ FlowStarter
                                                                                      │
FlowExecution Durable Object: the repository flow's graph, built in the QuickJS realm ◀┘
  ├─ ci/job (child flow) ──▶ JobSandbox object + container, one per job
  │     steps: ExternalJob over a detached process; log file; cache and artifacts in R2
  │     egress: placeholders in, values swapped only for bound hosts
  ├─ HumanTask (environment approval, Maintainer) ── person-only answer
  └─ github/* system actions (installation token): comments, PRs, tags, releases
runs rows + journal ──▶ /$owner/$repo/actions, the run page, the PR Checks tab, pr/Merge
```

1. **Triggers live beside the flow, as a literal.** `Flow.make` gains `triggers`, lowered into annotations exactly as `capabilities` and `effects` are, so discovery reads them from source without importing the module (`flow/docs/api.md:47`). The default branch's active snapshot holds the triggers, so a pull request can't add a trigger to itself. For a `pull_request` event the body loads at the head, unless the trigger says `trust: "base"`, which is GitHub's `pull_request_target`. Both carriers, this literal and a plugin's `contributes.triggers`, lower to 0017's one `Trigger` row, with filters added. This amends 0017 §5 ("the manifest binds flows to … triggers") for a repository's own flows; it stays data, never code.
2. **Orchestration in the realm, commands in containers.** A repository's `flow.ts` builds its graph in the QuickJS realm on `FlowExecution` (0017 lines 502-506, Will's "quickjs is a sandbox"). Every command runs in a job sandbox. No CI step runs in the Worker or the tab, and the Worker never evaluates repository code.
3. **A job is a child flow on one machine; a step is a durable action.** `ci/job` reserves one `JobSandbox` for its life. Each step runs as one `ExternalJob` (at most once per call id, probed with a heartbeat), so the run page shows steps as GitHub does. A step marked `always` is `Node.catch` topology. A job settles an outcome value (`passed`, `failed`, `cancelled`, `skipped`), never a failure, so a matrix reports every row and `fail-fast: false` needs no special case.
4. **Crons are a durable tick, not a loop.** `Scheduler.layer` forks a supervisor fiber that runs forever (`triggers/docs/api.md:785-790`), which a Durable Object can't host and DUR-3 forbids as a job loop. `Scheduler.make` forks nothing, and `runOnce` is one tick, so a `triggers/Tick` lineage keeps the package's claim protocol and stays a flow.
5. **Secrets never enter a box.** Jobs get placeholders; the egress swaps values only in requests to a secret's bound hosts (ARCH-16). An environment's secrets reach a job only after a person approves that job's candidate.
6. **Agents in CI are Smithers features.** Tevm's `@claude`, Claude review and Codex factory map to the Smithers agent, `checks/Review` and the `todo` run; only the mention trigger is new. A port never reproduces an agent pushing to `main` (Tevm `claude-auto-update.yml:87-101`); it opens a PR for a person to merge.
7. **GitHub check runs stay banned.** Under M-52 the Checks tab shows Smithers runs, and Smithers' own merge enforces required flows. Whether Smithers may also write commit statuses is question 2.
8. **Port the jobs, not the old stack.** Smithers' `apps-deploy.yml` deploys `apps/server` with wrangler, the old product. Its port deploys `apps/mvp` with Alchemy (`pnpm run deploy --yes`).

## Where the drafts disagreed

| Topic | Opus | Sol | Chosen, and why |
|---|---|---|---|
| Effect scope | Port `effect` `main` and `v3`; `effect-smol` is retired | Port `effect` `main` and `effect-smol`; `v3` missing | Opus. `effect-smol`'s README says "This repository is archived and read-only", and its Release, Snapshot and Nightly AI Codegen workflows are disabled. Effect 3 ships from `effect` branch `v3`, which has 5 workflows and its own ruleset. |
| Where triggers are declared | A `triggers` literal on `Flow.make` | A plugin registration through `Trigger.make`, "not a Flow.make option" | Opus. Discovery already reads `Flow.make` literals from source text; Will asked for "flows typescript configs"; a repository's file flow has no manifest. One `Trigger` row keeps one implementation. |
| Where `flow.ts` is evaluated | The QuickJS realm on `FlowExecution` | In an isolated job sandbox | Opus. 0017 makes the realm the sandbox for flow code and containers the place for machine work. A graph evaluated inside one container would have to call back out to start every other job's machine. |
| Step granularity | One job, one command list | Every source step its own durable action | Merged: a job is a child flow on one machine and each step is one durable `ExternalJob`. Sol's granularity gives per-step status, logs and `always` steps; Opus's process mechanism gives long steps and cancellation. |
| Build order | The spine first | Pure pieces first (filters, matrix, manual dispatch, trusted reuse, bots); the job host 10th | Opus. Sol's own note says public dispatch, cron and event wiring "must remain disabled … until the job-host admission exists", so selectors built first produce nothing a person can use. |
| Matrices | Exist | Small addition (expansion, row ids, bounded launch) | Opus. `Node.all` keyed by row with `Node.catch` is the matrix; per-row outcomes come from `ci/job` settling values. No workflow sets `max-parallel`. |
| `workflow_run` | Exists by composition | Build now: completion triggers | Opus. `bundle-comment` becomes a step of `check`; `npm-promote`'s 10-minute cron already covers its `workflow_run`; run-event triggers are 0017 slice 2. |
| Status badges | Ticket | Build now, last | Opus. No README in the three repositories shows a CI badge; Effect's one badge is a static pkg.pr.new badge. |
| JSR | Token publishing is a small addition; provenance is a ticket | Ticket | Opus. JSR's docs: "Tokenless OIDC publishing is only available from GitHub Actions, but token-based publishing works everywhere." |
| Postgres | Part of the job image | Its own build-now note | Opus. None of the repositories uses a Postgres service container; Smithers installs Postgres 18 by script (`distribution.yml:26-27`, `ci.yml:96-125`). |
| Deployments and mirror pushes | Part of the egress | Their own build-now note | Opus. wrangler, Alchemy, `git push` with an extra header and the website dispatch all carry their credential in a request header, which the egress already substitutes. |
| Trusted reuse of setup | Not a gap | Build now | Opus. Composite actions become TypeScript functions, and Alchemy pins the CI image by digest (`infra/BranchSandbox.ts:1-5`). `trusted-ci-setup` verifies a GitHub runner's integrity, which has no meaning off GitHub. |
| Re-run failed jobs | Sealed results replayed by cache | A new linked execution of the failed child | Opus. `Action.withCache` with a shared scope exists and needs no new linkage; irreversible steps are never sealed, so a publish is never replayed. |
| Retry from here | Folded into re-run | Ticket, through `TimeTravel` | Sol. `TimeTravel.fork` and `rewind` exist but need jj on the host (`docs/libraries.md:230`) and invalidation rules. |
| Cache and artifacts | One note | Two notes | Sol. They share a bucket but have different keys, lifetimes and readers. |
| Machine types | One note per kind, plus build-now sizes | One ticket note for every kind | Sol, plus Opus's build-now sizes. The tracker had already opened `ci-parity-advanced-runners`; each kind's slice is one paragraph in it. Linux sizes are a small addition and get their own note. |
| Approvals | Maintainer approval and scoped secrets | Approval bound to the exact candidate digest, rechecked before the write | Both: approval binds to the candidate digest. |
| Timeouts | Flow `deadline` | `attemptTimeoutMs` and `heartbeatTimeoutMs` on actions | Sol's evidence added (`flow/src/Action/make.ts:125-140`). |
| Inventory depth | Per-workflow summary tables | Every job and step expanded | Both kept: the summary here, Sol's full inventory in the scratchpad. |

## Questions for Will

1. **How do we publish to npm without GitHub's OIDC?** npm trusted publishing works only from GitHub Actions, GitLab.com and CircleCI cloud, and provenance only from the first two ([npm](https://docs.npmjs.com/trusted-publishers)). JSR provenance works only from GitHub Actions ([JSR](https://jsr.io/docs/publishing-packages)). Effect publishes with OIDC and has no `NPM_TOKEN` (Effect `release.yml:32-43`). Smithers publishes with `--provenance` (Smithers `release.yml:1146-1147`). From Smithers cloud we can publish only with a granular `NPM_TOKEN` through the egress, and packages lose the provenance badge. **Recommendation:** publish with tokens now, and keep `ci-parity-oidc-provenance` as the ticket for becoming a trusted publisher.
2. **May Smithers write commit statuses to GitHub?** Effect's rulesets require six checks posted by the GitHub Actions app. M-52 forbids any App permission for check runs or commit statuses, so a merge on github.com would skip Smithers' checks entirely. **Recommendation:** allow write-only commit statuses named `smithers/<flow>`, so a ruleset can require them. Reading and showing Actions and check runs stay banned.

## Found along the way

- [Remote flows](../features/remote-flows.md) line 95 says child flows don't run on Cloudflare; `ExecutionHost.ts:196-224` routes them.
- Smithers `release.yml:1308`, `:1390` and `:1394` call `flows/release/…`, which doesn't exist (the scripts are in `.smithers/flows/release/`). Only a stable tag reaches those steps. The linux-x64 native helper is a debug build (`release.yml:286-289`, `:1006`).
- Smithers' Homebrew qualification reads GitHub check runs from an App (`.smithers/flows/release/homebrew-release.mjs:115-127`); its port must read Smithers runs.
- Smithers' `npm-publish` and `production` environments have no reviewer rule; they only scope secrets.
- Tevm: `jsr-publish.yml`'s `dry_run` and `prerelease-exit.yml`'s `branch` inputs are never used; `snapshot.yml` and `jsr-publish.yml` can't publish as written, because smthrs refuses `approval: "required"` targets; `wasm-size-check.yml` measures nothing; `claude.yml` lets anyone on the public repository start the agent (15-19); `nx.json:161` commits an Nx Cloud access token.
- Effect: V3's `ts-nightly.yml` is `if: false`; `effect-smol`'s `bundle-comment.yml` concurrency group makes every pull request's comment run cancel every other's.

## Appendix A. Inventory

Smithers paths are under this repository's `.github/workflows/` and Tevm's under `.github/workflows/` in `evmts/tevm-monorepo`. Effect files were read with `gh api` at E `ca6d1cc5f8` (`main`), V3 `8c46c75565` and S `3a1128c768` (`effect-smol`).

### A.1 Smithers (14 files)

| Workflow | Triggers | Jobs, graph, runners | Secrets, OIDC, environments | Concurrency | Outputs |
|---|---|---|---|---|---|
| `ci.yml` | push `main`, `pull_request` (3-5) | 15 parallel jobs, no `needs`; all `ubuntu-latest` except `packages`, a matrix over ubuntu, macOS and Windows with the last two advisory (1395-1407); timeouts 10 to 190 min; 3 browser shards unrolled by hand (920, 1010, 1100) | `SMITHERS_CACHE_URL`, `SMITHERS_CACHE_READ_TOKEN` (126-132) | `ci-pr-<n>` or ref; cancels only on PRs (6-8) | a check per job; `smthrs-results-*` artifacts (133-139) |
| `release.yml` | tags `v*`; dispatch with `releaseTag`, `sourceRef`, `dryRun` (default true), `candidateRunId`, `candidateArtifactId` (4-37) | 7 jobs: `server-bundle` (macos-15); `native-helper` matrix over macos-15, macos-15-intel, ubuntu-24.04-arm and windows (90-120); `publish` with a lane matrix from `fromJSON` (145-149, 330 min); `candidate-result` polls the jobs API (1183-1205); `installer-archive` on 4 platforms; `installer-publish`; `homebrew-bottle` (macos-15) | `NPM_TOKEN`, `SMITHERS_MODE_MATRIX_PLUE_TOKEN`, `HOMEBREW_TAP_TOKEN`, cache tokens; `id-token: write` for npm provenance (155-158, 1146-1147) and keyless cosign (1271-1273, 1334-1336); environments `npm-publish` (154), `installer-publish` (1267), `homebrew-publish` (1333) | per tag, no cancel (45-47) | npm `--provenance` to `next` or `latest`; signed installer archives; a GitHub release with assets; a Homebrew tap PR |
| `apps-deploy.yml` | tags `v*`; dispatch `ref` (6-18) | `gate` matrix of 3 shards (46-49), then `deploy` (155-232) | cache tokens, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; environment `production` (159) | `apps-deploy`, no cancel (25-27) | wrangler deploy of `apps/server`; a deploy receipt |
| `canary.yml` | crons `0 * * * *` (43) and `15,30,45 * * * *` (46); dispatch `metered`, `force_failure` (49-56) | `probe` (67-233), 15 min | `CANARY_SESSION_COOKIE`; vars | `canary`, no cancel (62-64) | opens, comments on and closes "Canary: smithers.sh is failing" (184-212) |
| `distribution.yml` | PR, push `main` (4-6) | `image`: Postgres 18 by script (26-27), Go backup and restore tests | none | per ref (11-14) | pass or fail |
| `drift.yml` | push `main`, PR (3-5) | calls `trusted-drift.yml@7df5f685…` (12-13), then a gate job (14-22) | none | per SHA (6-8) | pass or fail |
| `native-windows.yml` | push `main` and PR with path filters (3-23); dispatch `portablePackages` (24-29) | `kernel`, `filesystem` on `windows-latest` (37, 50) | none | per ref (32-34) | coverage artifacts |
| `npm-dist-tag.yml` | dispatch `package`, `version`, `tag`, `replaceZeroLatest` (29-48) | `npm dist-tag add` (110-114) | `NPM_TOKEN`; environment `npm-publish` (62) | per package (53-55) | a moved dist-tag |
| `reference-host.yml` | push `main`, dispatch (34-36) | `[self-hosted, reference-host]`, a Mac mini (53) | none | `reference-host` (40-42) | pass or fail |
| `release-auth.yml` | dispatch (3-4) | `npm whoami`, token list (10-75) | `NPM_TOKEN`; environment `npm-publish` (13) | none | log only |
| `reliability.yml` | cron `23 3 * * *` (3-4); dispatch `campaign`, `seed` (7-17) | 6 jobs; Node matrix (55-58); `e2e-faults` host × tier with a self-hosted macOS ARM64 leg (248-253), KVM and Microsandbox (336-353), up to 360 min (259) | none | per ref and campaign (20-22) | 30-day artifacts |
| `trusted-drift.yml` | `workflow_call` (2-3) | `trusted-ci-setup@c4ece3f8…` before checkout (15-16), then 12 drift lints | none | per SHA (4-6) | pass or fail |
| `trusted-setup-validation.yml` | push `main` with path filters (3-11); dispatch | `trusted-ci-setup-campaign@82d38ca5…` (25-26) | none | per run (15-17) | a receipt artifact |

`main`'s ruleset holds deletion, non-fast-forward and linear history, and no required checks. `ci.yml`, `drift.yml` and `trusted-drift.yml` are rendered from `Smithers.GithubCiGen` (`PACKAGE.ts:553-660`).

### A.2 Tevm (16 files; repository `evmts/tevm`)

Ten files are rendered by `S.Github.Workflow` (`.github/PACKAGE.ts:57-202`); each runs checkout, `node scripts/factory/checkout-native.mjs`, the setup action, then one `pnpm exec smthrs target …` (`.github/PACKAGE.ts:12-17`). Every job runs on `ubuntu-latest`, with no matrix, services, path filters, `workflow_run` or reusable workflow. `main` is protected with no required checks; `factory-admin` and `factory-approval` require a reviewer.

| Workflow | Triggers | What runs | Secrets, OIDC, environments | Concurrency | Outputs |
|---|---|---|---|---|---|
| `ci.yml` | PR; push `main`; dispatch (4-8) | `smthrs target //:ci`: builds, coverage, Rust, typecheck, lint, docs, changeset status (`PACKAGE.ts:528-547`) | `TEVM_RPC_URLS_MAINNET`, `TEVM_RPC_URLS_OPTIMISM`, `TEVM_TEST_ALCHEMY_KEY` (13-15) | `ci-<ref>`, cancels on PRs (9-11) | pass or fail |
| `parity-suites.yml` | PR; dispatch | `//test:parityFast`, `conformanceFast`, `hiveSmoke` (20) | the three `TEVM_*` | none | none |
| `cron-nightlyConformance.yml` | cron `0 3 * * *` (5); dispatch | `//test:nightlyConformance` (19) | none | none | none |
| `wasm-size-check.yml` | PR; push `main`; dispatch | `//:cargoBuilds` only | none | none | none |
| `review.yml` | PR | `//:prReview`, a Codex lint with no Codex CLI or key installed | none | cancels per ref | none |
| `prerelease.yml` | push `main` (4-6) | `changesets/action@v1`: the Version Packages PR, or `release:publish` (30-37) | `NPM_TOKEN`, `GITHUB_TOKEN`; `id-token: write` (10-13) | per ref | npm under `rc`, tags, GitHub releases |
| `release.yml` | push `v1`; dispatch | as prerelease | as prerelease | per ref | as prerelease |
| `snapshot.yml` | dispatch | `//:snapshot`, which smthrs refuses as written | `TEVM_*` | per ref | none as written |
| `prerelease-exit.yml` | dispatch `branch` (unused) | `changeset pre exit`, never committed | `contents: write` | none | none as written |
| `jsr-publish.yml` | dispatch `dry_run` (unused) | `//tevm:publishJsr` (OIDC; approval required) | `id-token: write` (10-13) | none | refused as written |
| `claude.yml` | `issue_comment`, `pull_request_review_comment`, `issues` opened or assigned, `pull_request_review` (3-11), on `@claude` (15-19) | `anthropics/claude-code-action@beta` | `ANTHROPIC_API_KEY`; `id-token: write` | none | comments, branches |
| `claude-code-review.yml` | PR opened, synchronize (4-5) | `claude-code-action@beta` review | `ANTHROPIC_API_KEY`; `id-token: write` | none | review comments |
| `claude-auto-update.yml` | cron `0 0 * * *` (5); dispatch | Claude Code updates, then `git push origin HEAD:main` (87-101) | `ANTHROPIC_API_KEY`, `TEVM_*`; `contents: write` | none | a direct push to `main` |
| `factory-configure.yml` | dispatch | `labels.mjs --apply` (24-27) | environment `factory-admin` (11-14) | none | labels |
| `factory-intake.yml` | `issues` opened, edited, reopened, labeled, unlabeled; dispatch `issue` (4-11) | `issue-intake.mjs` | none | per issue, cancels (17-19) | a step summary and an artifact |
| `factory-issue.yml` | `issues` labeled `factory:ready`; dispatch `issue`, `type` (4-16, 24) | `candidate` (Codex, 90 min, `factory-candidate`), a patch artifact, then `settle` (`factory-approval`) opens a PR (161-263) | `OPENAI_API_KEY` | per issue (18-20) | a branch and a PR |

### A.3 Effect

| Workflow (E `main`) | Triggers | Jobs | Secrets, OIDC, environments | Concurrency | Outputs |
|---|---|---|---|---|---|
| `check.yml` | dispatch; PR and push on `main`, `v4/next-minor`, `v4/next-major` (3-7) | Static, Types, Build (PR), Bundle (PR; builds base and head), Test over Node, Deno and Bun (116-141) with 7 testcontainers images (145-154), Test (Documentation); Namespace runners for Types, Test and doctest | none | per ref, cancels (9-11) | `bundle-stats` |
| `release.yml` | push `main` (2-4) | `changesets/action` v2 (34-43) | `CHANGESET_GITHUB_TOKEN`; `id-token: write`; no `NPM_TOKEN` | no cancel | the Version PR; npm `staging` with provenance; tags; releases |
| `npm-promote.yml` | cron `*/10 * * * *` (3-4); `workflow_run` of Release (5-8); dispatch `dry-run` | promote `latest`, record a deployment, dispatch to `Effect-TS/website`, open an overdue issue | `WEBSITE_DISPATCH_TOKEN`; `id-token: write`; environment `npm-promote`, which npm's trusted publisher pins (33-37) | per workflow | dist-tags, a deployment, a dispatch, an issue |
| `snapshot.yml` | push `main`, PR to `main`, dispatch | `approval-gate` for fork PRs with environment `fork` (15-19), then `pkg-pr-new publish` (47-49) | none | cancels | pkg.pr.new packages |
| `release-queue.yml` | `issue_comment`; `pull_request_target` and push on three branches (3-8) | `next-release-action`: `/rebase`, force-push rebases, retargets PRs | `EFFECT_BOT_GH` | none | branches, PRs, labels |
| `bundle-comment.yml` | `workflow_run` of Check (2-6) | downloads `bundle-stats`, bounds and checks it, posts a sticky comment | `pull-requests: write` | per head branch, cancels | a PR comment |
| `ai-codegen.yml` | cron `0 0 * * *`; dispatch | codegen, `create-pull-request` | `GITHUB_TOKEN` | cancels | a PR |
| `cluster.yml` | dispatch | `pnpm test-cluster` with testcontainers | none | none | pass or fail |
| `effect-bot.yml` | `issue_comment` starting `/effect-bot` (11-13) | role check, HMAC POST to Multica | `MULTICA_EFFECT_BOT_WEBHOOK_URL`, `…_SECRET` | none | a reaction |

V3 (`effect` branch `v3`): `check.yml` (Lint, Types, Test on Node in 4 shards), `release.yml` (changesets with OIDC, `--tag prev`, then a website dispatch), `snapshot.yml` (pkg.pr.new), `release-queue.yml` (fork gate), `ts-nightly.yml` (`if: false`). `effect-smol` (retired): `check.yml` (Node and Deno × 2 shards), `release.yml` (`NPM_TOKEN`, beta pre mode), `snapshot.yml`, `bundle-comment.yml`, `ai-codegen.yml`; Release, Snapshot and AI Codegen are disabled.

Required checks: E `main` requires `Build`, `Static`, `Test (Node)`, `Types`, `Test (Bun)`, `Test (Documentation)`; `v4/next-minor` and `v4/next-major` add `Test (Deno)`; V3 requires `Lint`, `Types`, `Test (Node 1/4)` to `Test (Node 4/4)`. All are bound to the GitHub Actions app (integration 15368). Environments: `fork` (reviewers), `npm-promote` (branch policy), `website-v4`.

```
Workflows that use each feature   Smithers  Tevm  Effect (main + v3)
push or pull_request                  7       7       8
tag pushes                            2       0       0
issue, comment or label events        0       3       2
crons                                 2       2       2  (+1 that never runs)
manual inputs                         9      12       8
path filters                          2       0       0
workflow_run or workflow_call         1       0       2
matrices                              4       0       2
non-Linux or self-hosted machines     5       0       0
Docker in the job                     2       0       2
environments                          4       2       3
npm or JSR publishing                 2       4       3
OIDC                                  1       5       3
bots: comments, labels, PRs, pushes   2       7       8
```

## Appendix B. Port sketches

Shape only; nothing here compiles today. `NEW` marks an API that doesn't exist. Placement: **W** the Worker route; **DO** a `FlowExecution` Durable Object (graph, waits, GitHub API calls with the installation token); **R** the QuickJS realm inside the DO, which evaluates repository code; **SB** a job sandbox container, which runs commands.

### B.0 Shared pieces

```ts
// @smthrs/sandbox gains CiJob (NEW): a child flow on one JobSandbox; each step an ExternalJob over a process.
import { CiJob } from "@smthrs/sandbox"                     // NEW

// .smithers/flows/_ci/target.ts, plain TypeScript like a composite action
export const target = (name: string, command: string, options: Partial<CiJob.Options> = {}) =>
  CiJob.make(`ci/${name}`, {                                 // NEW; runs on SB, started from DO
    machine: "standard-4",                                   // NEW: ci-parity-machine-sizes
    timeoutMinutes: 60,
    cache: [{ name: "pnpm", key: { files: ["pnpm-lock.yaml"] }, paths: ["~/.local/share/pnpm/store"] }], // NEW: ci-parity-cache
    steps: [
      { name: "install", run: "pnpm install --frozen-lockfile --ignore-scripts" },
      { name: name, run: command },
    ],
    ...options,
  })
```

`CiJob.make(...).call({ sha })` is one child run. It settles `{ outcome: "passed" | "failed" | "cancelled" | "skipped", steps }` and never fails, so a matrix reports every row. `secrets` are names: the box gets placeholders, and the egress swaps values ([secrets](../features/secrets.md)). `artifacts: [{ name, paths, when: "always" }]` is `ci-parity-artifacts`.

### B.1 Smithers

```ts
// .smithers/flows/ci/flow.ts, replacing ci.yml
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"                     // NEW
import { Schema } from "effect"
import { target } from "../_ci/target.ts"

const secrets = ["SMITHERS_CACHE_URL", "SMITHERS_CACHE_READ_TOKEN"]
const smthrs = (verb: string, pattern: string) =>
  `pnpm exec smthrs ${verb} '${pattern}' --known-red .github/ci-known-red.json`

export default Flow.make("ci", {
  description: "Every push to main and every pull request: the workspace graph, repository flows, apps, Rust and Go.",
  capabilities: ["sandbox:job"],                             // NEW capability
  triggers: [                                                // NEW: ci-parity-repo-flows, ci-parity-triggers
    { on: "github.push", branches: ["main"] },
    { on: "github.pull_request", concurrency: { group: "pr", cancelInProgress: true } }, // NEW: ci-parity-concurrency
  ],
  payload: { repo: Schema.String, sha: Schema.String },
  success: Schema.Record(Schema.String, CiJob.Outcome),      // NEW schema
  body: ({ sha }) =>
    Node.all({                                               // 15 jobs at once, as ci.yml; R builds, SB runs
      test: target("test", smthrs("ci", "//packages/...") + " --jobs 2", { timeoutMinutes: 180, secrets }).call({ sha }),
      repository: target("repository", smthrs("test", "//.smithers/flows:pack"), { secrets }).call({ sha }),
      scripts: target("scripts", smthrs("test", "//.smithers/flows:releaseSuite"), { secrets }).call({ sha }),
      docs: target("docs", smthrs("test", "//.smithers/flows:packageDocs"), { timeoutMinutes: 45 }).call({ sha }),
      appsE2e: target("apps-e2e", smthrs("test", "//apps/app:unitTests"), { timeoutMinutes: 70 }).call({ sha }),
      browser1: target("apps-browser-1", smthrs("test", "//apps/app:browserE2eShard1")).call({ sha }),
      browser2: target("apps-browser-2", smthrs("test", "//apps/app:browserE2eShard2")).call({ sha }),
      browser3: target("apps-browser-3", smthrs("test", "//apps/app:browserE2eShard3")).call({ sha }),
      rust: target("rust", smthrs("test", "//packages/smithers/flows/jj-wasm:cargoTest")).call({ sha }),
      rustFfi: target("rust-ffi", smthrs("build", "//:nativeFfi")).call({ sha }),
      wasmRepro: target("wasm-repro", smthrs("test", "//packages/smithers/flows/jj-wasm:wasmReproducibility")).call({ sha }),
      browser: target("browser", smthrs("test", "//packages/repo-targets:webBundleContract"), { timeoutMinutes: 10 }).call({ sha }),
      packages: target("packages", smthrs("test", "//packages/...") + " --jobs 2", { timeoutMinutes: 90 }).call({ sha }),
      // packages on macOS and Windows: ci-parity-advanced-runners (advisory legs today)
      goBackend: target("go-backend", smthrs("test", "//:backendGo"), { timeoutMinutes: 190 }).call({ sha }),
      goAccess: target("go-backend-access", smthrs("test", "//:backendGoAccess"), { timeoutMinutes: 90 }).call({ sha }),
    }),
})
```

Each job runs all of its gates as steps; the sketch shows one. Gates that need Docker's image store or bubblewrap user namespaces stay red until `ci-parity-docker` and `ci-parity-privileged-linux`.

| Workflow | Flow tag | Triggers (`NEW` literal) | Steps and placement | Blocked by |
|---|---|---|---|---|
| `release.yml` | `smithers/Release` (exists: `.smithers/flows/release/flow.ts`, with `HumanTask`) | `github.push` tags `v*`; `manual` `{ releaseTag, sourceRef, dryRun, candidateRunId }` | DO: approval, `environment: "npm-publish"` → SB: gates, `release/build-packages`, pack, smoke → DO: artifacts by digest → SB: `release/publish` with `NPM_TOKEN` → DO: GitHub release with assets (`github/release`, NEW); qualification reads Smithers runs, never check runs | macOS, Windows and arm64 helpers, the Homebrew bottle (tickets); provenance and keyless cosign (question 1) |
| `apps-deploy.yml` | `apps/deploy` | tags `v*`; `manual` `{ ref }`; `concurrency: { group: "deploy" }` | SB: 3 gate shards (`Node.all`) → DO: `environment: "production"` → SB: `pnpm run deploy --yes` for `apps/mvp` with `CLOUDFLARE_API_TOKEN` through the egress → SB: smoke both hosts | none |
| `canary.yml` | `ops/canary` | `cron` `0 * * * *` and `15,30,45 * * * *`; `manual` `{ metered, forceFailure }` | SB: the probe and the browser canary → DO: open, comment on or close the issue (`github/Write`, exists) | none |
| `distribution.yml` | `ci/distribution` | push `main`; PR | SB: Postgres 18 from the image, `go test …`, `node --test …` | none |
| `drift.yml`, `trusted-drift.yml` | `ci/drift` | push `main`; PR | SB: 12 `smthrs lint` drift gates; the image replaces the trusted setup action | none |
| `native-windows.yml` | `ci/windows` | push `main`, PR, `paths` | SB on Windows | `ci-parity-advanced-runners` |
| `npm-dist-tag.yml` | `release/dist-tag` | `manual` `{ package, version, tag, replaceZeroLatest }`; `concurrency: { group: "package" }` | DO: `environment: "npm-publish"` → SB: guards, `npm dist-tag add`, read back | none |
| `reference-host.yml` | `ci/reference-host` | push `main`; `manual` | a self-hosted Mac | `ci-parity-advanced-runners` |
| `release-auth.yml` | `release/auth` | `manual` | SB: `npm whoami`, token list | none |
| `reliability.yml` | `ci/reliability` | `cron` `23 3 * * *`; `manual` `{ campaign, seed }` | SB: 5 Linux jobs (`Node.all`), a soak matrix over two Node versions, the Linux fault leg | KVM (`ci-parity-privileged-linux`), the reference leg (`ci-parity-advanced-runners`) |
| `trusted-setup-validation.yml` | none | none | checks a GitHub runner's integrity, which has no meaning off GitHub | not ported |

### B.2 Tevm

```ts
// .smithers/flows/_ci/tevm.ts
export const tevmTarget = (name: string, label: string, secrets: ReadonlyArray<string> = []) =>
  target(name, `pnpm exec smthrs target ${label}`, {
    steps: [
      { name: "vendor", run: "git submodule update --init -- vendor/flows" },
      { name: "native", run: "node scripts/factory/checkout-native.mjs" }, // voltaire, guillotine-mini, zevm at pinned commits
      { name: "toolchain", run: "mise install" },                          // bun, foundry, zig (mise.toml)
      { name: "install", run: "pnpm install --frozen-lockfile" },
      { name, run: `pnpm exec smthrs target ${label}` },
    ],
    secrets,
  })

// .smithers/flows/ci/flow.ts, replacing ci.yml
export default Flow.make("ci", {
  description: "Build, test, lint and type-check Tevm on each pull request and push to main.",
  capabilities: ["sandbox:job"],
  triggers: [                                                // NEW
    { on: "github.pull_request", concurrency: { group: "ref", cancelInProgress: true } },
    { on: "github.push", branches: ["main"] },
    { on: "manual" },
  ],
  payload: { repo: Schema.String, sha: Schema.String },
  success: CiJob.Outcome,
  body: ({ sha }) =>
    tevmTarget("ci", "//:ci", ["TEVM_RPC_URLS_MAINNET", "TEVM_RPC_URLS_OPTIMISM", "TEVM_TEST_ALCHEMY_KEY"]).call({ sha }),
})
```

| Workflow | Flow tag | Triggers | Steps and placement | Blocked by |
|---|---|---|---|---|
| `parity-suites.yml` | `ci/parity` | PR; `manual` | SB: three targets with the `TEVM_*` secrets | none |
| `cron-nightlyConformance.yml` | `ci/nightly-conformance` | `cron` `0 3 * * *`; `manual` | SB: `//test:nightlyConformance` | none |
| `wasm-size-check.yml` | `ci/wasm-size` | PR; push `main`; `manual` | SB: `//:cargoBuilds` | none |
| `review.yml`, `claude-code-review.yml` | `checks/Run` (exists; its `checks/Review` step) | PR opened, synchronize | DO: the judge reads the diff and posts one comment review (`Checks.ts:232-262`) | `ci-parity-triggers` |
| `claude.yml` | `agent/mention` | `github.issue_comment`, `github.pull_request_review_comment`, `github.pull_request_review`, `github.issues` opened or assigned; `contains: "@smithers"`; `minimum: "Member"` (NEW) | DO: start the Smithers agent on the issue or PR; writes through `github/Write` | `ci-parity-triggers` |
| `claude-auto-update.yml` | `maint/auto-update` | `cron` `0 0 * * *`; `manual` | DO: a TODO per `update-*` prompt; the `todo` run opens a PR; a person merges | `TODO_RUNS` on |
| `prerelease.yml`, `release.yml` | `release/changesets` | push `main` (rc) and `v1`; `concurrency: { group: "ref" }` | SB: `changeset status`; with changesets pending, SB: `pnpm release:version` → DO: commit to `changeset-release/<branch>` and open or update the Version PR (`github/commit`, NEW); with none pending, SB: `pnpm release:publish` with `NPM_TOKEN` → DO: tags and releases (`github/release`, NEW) | none; token publishing (question 1) |
| `snapshot.yml` | `release/snapshot` | `manual` | DO: `environment: "npm-publish"` → SB: `changeset version --snapshot snapshot && pnpm run release:publish` | none |
| `prerelease-exit.yml` | `release/pre-exit` | `manual` `{ branch }` | SB: `changeset pre exit` → DO: commit and PR | none |
| `jsr-publish.yml` | `release/jsr` | `manual` `{ dryRun }` | DO: approval → SB: `jsr publish --token` through the egress | provenance (ticket) |
| `factory-configure.yml` | `factory/labels` | `manual` | DO: `environment: "factory-admin"` → DO: create or update labels from `.github/labels.yml` (`github/labels`, NEW) | none |
| `factory-intake.yml` | `factory/intake` | `github.issues` opened, edited, reopened, labeled, unlabeled; `manual` `{ issue }`; `concurrency: { group: "issue", cancelInProgress: true }` | SB: `issue-intake.mjs` → DO: the report on the run page | none |
| `factory-issue.yml` | the `todo` run (exists) | `github.issues` labeled `factory:ready` | DO: `todo/commit` from the issue → the `todo` run implements on a machine and opens a PR → a person merges | `TODO_RUNS` on |

### B.3 Effect (`main`; V3 has the same shape)

```ts
// .smithers/flows/check/flow.ts, replacing check.yml and bundle-comment.yml
export default Flow.make("check", {
  description: "Static checks, types, build, bundle size and tests on Node, Deno and Bun.",
  capabilities: ["sandbox:job", "github:comment"],           // NEW capabilities
  triggers: [                                                // NEW
    { on: "github.pull_request", branches: ["main", "v4/next-minor", "v4/next-major"],
      concurrency: { group: "ref", cancelInProgress: true } },
    { on: "github.push", branches: ["main", "v4/next-minor", "v4/next-major"] },
    { on: "manual" },
  ],
  payload: { repo: Schema.String, sha: Schema.String, baseSha: Schema.optional(Schema.String) },
  success: Schema.Record(Schema.String, CiJob.Outcome),
  body: ({ sha, baseSha }) =>
    Node.all({
      static: target("static", "pnpm lint && pnpm jsdocs --check && pnpm circular", { timeoutMinutes: 10 }).call({ sha }),
      types: target("types", "pnpm check && deno check . && pnpm test-types --target '>=5.9'", { machine: "standard-2" }).call({ sha }),
      build: target("build", "pnpm build && pnpm check-dist-types").call({ sha }),
      bundle: target("bundle", "node ./packages/tools/bundle/src/bin.ts compare --base-dir base/packages/tools/bundle/fixtures", {
        steps: [/* build head; check out baseSha into base/ and build it */],
        artifacts: [{ name: "bundle-stats", paths: ["stats.txt"] }],         // NEW: ci-parity-artifacts
      }).call({ sha }),
      testNode: target("test-node", "pnpm test --max-concurrency=10").call({ sha }),
      testDeno: target("test-deno", "deno task test --max-concurrency=10").call({ sha }),
      testBun: target("test-bun", "bun run --bun vitest run --max-concurrency=10").call({ sha }),
      doctest: target("doctest", "pnpm doctest").call({ sha }),
    }).pipe(
      // bundle-comment.yml: a DO step with the installation token; the stats are bounded and checked as untrusted data
      Node.bindPlanned((jobs) => BundleComment.call({ outcome: jobs.bundle })), // NEW wrapper over UpsertComment
    ),
})
```

`EFFECT_INTEGRATION_TESTS=1` needs Docker for testcontainers. Until `ci-parity-docker`, the three test jobs run without integration tests, so they check less than today's required `Test (Node)` and `Test (Bun)`.

| Workflow | Flow tag | Triggers | Steps and placement | Blocked by |
|---|---|---|---|---|
| `release.yml` | `release/changesets` | push `main`; `concurrency: { group: "release" }` | as Tevm's, with `--tag staging`; the App commits the Version PR (DO) | an `NPM_TOKEN` (question 1) |
| `npm-promote.yml` | `release/promote` | `cron` `*/10 * * * *`; `manual` `{ dryRun }`; a repository setting replaces the `NPM_PROMOTE_PAUSED` variable | DO: `environment: "npm-promote"` → SB: the `npm-promote` tool with `NPM_TOKEN` → DO: deployment, `repository_dispatch` to `Effect-TS/website`, the overdue issue (`github/*`, NEW) | question 1 |
| `snapshot.yml` | `release/snapshot` | PR to `main`, push `main`, `manual` | DO: a fork PR waits on `HumanTask` (environment `fork`) → SB: build, publish previews | `ci-parity-preview-packages` |
| `release-queue.yml` | `release/queue` | `github.issue_comment` starting `/rebase`; `github.pull_request` with `trust: "base"`; push on three branches | SB: the rebase logic with the App token through the egress → DO: PR, retarget, labels | none |
| `ai-codegen.yml` | `maint/ai-codegen` | `cron` `0 0 * * *`; `manual` | SB: codegen → DO: commit to `chore/ai-codegen-update` and open a PR (`github/commit`, NEW); the App's PR starts `check`, unlike `GITHUB_TOKEN`'s | none |
| `cluster.yml` | `ci/cluster` | `manual` | SB: `pnpm test-cluster` | `ci-parity-docker` |
| `effect-bot.yml` | `bot/effect` | `github.issue_comment` starting `/effect-bot`; `minimum: "Maintainer"` | SB: HMAC POST to the Multica webhook, with the secret through the egress → DO: a reaction | none |

Sources outside the repositories: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), [npm provenance](https://docs.npmjs.com/generating-provenance-statements), [JSR publishing](https://jsr.io/docs/publishing-packages).

## Will's answers

- **Publishing (2026-10-20 23:36, ruling GH-9):** "Keep publishing on github utilize and warn in the coding factory that promoting main on github is equivelent to deploying while production happens on smithers". npm and JSR publishing with OIDC provenance stays in GitHub Actions, the one exception to GH-1. Every other job moves to Smithers flows. The coding factory's merge step shows a warning that promoting `main` on GitHub deploys, because the publish workflow runs on it. The publishing rows in the capability matrix change from "build now" to "stays on GitHub".
- **Required checks (2026-10-20 23:37, ruling GH-10):** approved. Smithers writes write-only commit statuses named `smithers/<flow>`, so branch protection can require them (for example Effect's 6 required checks). This amends M-52 for statuses only. Smithers still never reads or shows GitHub Actions.
