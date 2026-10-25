# CI on Smithers

A repository's checks run on Smithers' machines, as durable flows, never on GitHub Actions (ruling FLOW-8; [the CI/CD parity proposal](../proposals/ci-cd-parity.md)). This page covers the spine: a push or a pull request starts a repository's own flow, planned in a QuickJS realm, whose jobs each run on their own machine, and the result shows on the commit as the check `smithers/<flow>`.

```
FlowExecution DO                                   SandboxObject DO + container (kind "job")
 ci/job { target, job } ─ ci/job/Checkout ──────────▶ wake: git fetch --depth 1 origin <sha>; detached checkout
                        ─ ci/job/Step × n ──────────▶ sh -c <step> as the `ci` user, once per (run, job, step)
                        ─ ci/job/Release ───────────▶ sleep now
 settles { outcome, steps }                          egress: the package registries; nothing else
```

## Jobs

`ci/job` is `@smthrs/sandbox`'s `CiJob` ([its API](../../../../packages/smithers/flows/sandbox/docs/api.md#cijob)): a child flow that reserves one machine for one job, checks out exactly the commit, runs each step in order and settles an outcome value, never a failure.

| Outcome | When |
|---|---|
| `passed` | the checkout is exactly `target.sha` and every step exited 0 within its time |
| `failed` | the machine has another commit; a step exited non-zero, ran past its time (600 s at most) or was lost; or the machine never answered within 30 minutes of retries, which the result shows as one `machine` step |
| `skipped` | a step after the one that failed: never run |
| `cancelled` | the run was stopped |

- **One machine per job.** `worker/flows/CiJobMachine.ts` names it `job-<digest of job:<run>:<job>>`: a branch machine of `kind: "job"` (`worker/BranchSandboxes.ts`) from the branch sandbox's image, which pins Node 26.5.0, pnpm 11.25.0 and git (`infra/sandbox/Dockerfile`). Two jobs of a run, and the same job of two runs, never share one. There is no separate job container class: the image and the object are the branch sandbox's.
- **Exactly the commit.** The machine's wake fetches the one commit by its id from GitHub and checks it out detached (`worker/branch/Checkout.ts`), finishing a checkout a stopped machine left half done, so a pull request's head from a fork, which is no branch of the repository, checks out the same way. `ci/job/Checkout` reads `HEAD` back and runs no step unless it is `target.sha`.
- **Commands only in the box.** A step is a `sh -c` command run by the sandbox tools' `run` (`@smthrs/sandbox`'s `SandboxTools`), as the box's `ci` user, never a person's. The Worker runs none.
- **Registries only.** A job's box reaches the package registries (npm, PyPI, crates.io, Go's proxy, GitHub's releases, dprint's plugins) and nothing else, and holds no secret ([where checks run](pulls.md#where-checks-run), `worker/branch/RegistryEgress.ts`).
- **At most once.** Each step is its own durable action; its tool call id is the version 5 UUID of `<run>:<job>:step:<index>`, so a step the machine started and lost settles `failed` with exit code `-1` and never runs twice.
- **Released when done.** `ci/job/Release` stops whatever the job's steps left running (a server or a watcher started in the background) and puts the machine to sleep at once rather than waiting for its keep-alive. A job whose machine never answered is released too.

A CI job starts only from a repository's flow; no route starts one by name ([no remote door](remote-flows.md#no-remote-door)).

## Repository flows

A repository declares its CI as TypeScript: `.smithers/flows/<flow>/flow.ts`, one `Flow.make` whose body returns the flow's jobs. It type-checks against the real SDK; the realm reads only its tag and its body (e2e/fixtures/ci-repo is one).

```ts
// .smithers/flows/ci/flow.ts
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

const versions = CiJob.make("versions", { steps: [{ name: "node", run: "node --version" }] })
const lint = CiJob.make("lint", { steps: [{ name: "install", run: "pnpm install --frozen-lockfile" }, { name: "lint", run: "pnpm lint" }] })

export default Flow.make("ci", {
  payload: { run: Schema.String, repo: Schema.String, sha: Schema.String, ref: Schema.String, event: Schema.String },
  success: Schema.Struct({ versions: CiJob.Result, lint: CiJob.Result }),
  body: (run) => Node.all({ versions: versions.call(run), lint: lint.call(run) }),
})
```

```
FlowExecution DO
 repo/Run { run, repo, flow, sha, ref, event, secrets }
   repo/Plan ── GET contents/.smithers/flows/<flow>/flow.ts?ref=<sha> (App, Contents: read)
             └─ QuickJS realm: sucrase strips types; Flow.make, Node.all, CiJob.make as data ─▶ { jobs }
   repo/Jobs (child) ─ repo/Pending ─▶ smithers/<flow> pending
                     ─ ci/job × n, at once (one machine each)
                     ─ repo/Report ─▶ smithers/<flow> success | failure (App, Commit statuses)
```

- **The realm plans; the machines run.** `worker/ci/Realm.ts` evaluates `flow.ts` in a fresh QuickJS runtime with 8 MiB of memory, a 128 KiB stack and a step budget, against four modules: `@smthrs/flow` (`Flow.make`), `@smthrs/plan` (`Node.all`), `@smthrs/sandbox` (`CiJob.make(name, { steps }).call()`) and `effect` (`Schema`, inert). The body is called once with `{ run, repo, sha, ref, event }`. Any other import, a relative one included, is refused, and the plan is checked as `CiJob.Job`s outside the realm. The Worker and the engine never evaluate the repository's code, and no command runs anywhere but a job's machine.
- **Exactly the commit.** `repo/Plan` reads `flow.ts` at the run's commit, and each job checks out that commit; nothing the flow returns can change the commit, the repository or the machine.
- **One status per flow.** `repo/Jobs` reports `smithers/<flow>` pending as its jobs start (best effort), then success when every job passed, else failure naming the failed jobs (`Failed: lint`). A flow that can't be planned runs no job and reports failure with the reason: `Couldn't run the flow (not_found)`, `(import)`, `(syntax)`, `(limit)`, `(invalid_plan)`, `(tag)`, `(too_large)`, `(evaluation)` or `(unreadable)`.
- **The flow's tag is its directory.** `.smithers/flows/ci/flow.ts` must declare `Flow.make("ci", …)`.
- **Retries.** GitHub's or Postgres' outages are retried, 1 s doubling to a minute, for 30 minutes (the report: until GitHub takes it). A refusal (no Contents or Commit statuses permission, the App not installed) is recorded once and never retried; the jobs still run.

Not yet: a repository flow imports nothing but the four modules (no shared `../_ci/target.ts`); `Node.all` is the only combinator, so jobs can't depend on one another; a person can't start a repository flow by hand (`ci-parity-manual-run`). Runs are listed and watched on the [repository’s Actions page](actions.md), with Stop.

## Triggers

```
GitHub ──push / pull_request──▶ POST /api/github/webhook (REPO_FLOWS on): verify, start triggers/Dispatch once per delivery (triggers/dispatch:<delivery>)
triggers/Dispatch { delivery, repo, defaultBranch, event, ref, branch, tag, action, sha, trusted }
  triggers/Match ── GET contents/.smithers/factory.json?ref=<default branch> (App, Contents: read)
                 └─ matching trigger rows whose .smithers/flows/<flow>/flow.ts is on the default branch
  triggers/Start ── repo/Run under <flow>:<delivery>, at the event's commit
```

A repository says when its flows run in its plugin manifest, `.smithers/factory.json` on its default branch (ruling FLOW-10; decision 0017's `Plugin.Manifest`). A flow file never says when it runs.

```json
{
  "apiVersion": 1,
  "id": "repository",
  "contributes": {
    "triggers": [
      { "on": "github.push", "flow": "ci", "branches": ["main"] },
      { "on": "github.pull_request", "flow": "ci" }
    ]
  }
}
```

| Row | Matches |
|---|---|
| `on: "github.push"` | a push to a branch: every branch, or the `branches` globs; a tag only when `tags` names it; a trigger with only `tags` runs on no branch. A deleted ref never runs |
| `on: "github.pull_request"` | `opened`, `synchronize` and `reopened`, or the `actions` it names; against every base branch, or the `branches` globs |
| `branches`, `tags` | globs: `*` is any run of characters but `/`, `**` any run at all; matched without regular expressions, so no pattern backtracks |

- **The default branch decides.** Triggers and flows are read from the default branch when the event arrives, so a branch or a pull request can't add a trigger to itself; a flow is active once a person merges its `flow.ts`. The run then plans `flow.ts` at the event's commit (a pull request's head).
- **Every installed repository.** A push or a pull request of any repository the App is installed on dispatches, not only the deployment's `GITHUB_REPOSITORY`.
- **Once per delivery.** The dispatch is `triggers/dispatch:<delivery>` and each run `<flow>:<delivery>` (a flow's name has no slash, so the two never meet), so a delivery GitHub sends again changes nothing.
- **Unreadable is not an outage.** A manifest or a `flow.ts` GitHub refuses, or won't give as text (a directory, over 1 MB, not UTF-8), is read as absent at once; only an outage is retried. One unreadable flow never holds back the others.
- **Secrets.** A fork's pull request, or one whose author is below Member (`author_association` not `OWNER`, `MEMBER` or `COLLABORATOR`), runs with `secrets: false`. Jobs get no secrets yet in any case ([job secrets](../work/ci-parity-job-secrets.md)).
- **Off unless `REPO_FLOWS=true`.** Only repositories in `REPO_FLOWS_REPOSITORIES` can start flows; the App must also have access.
- Not yet: `trust: "base"` (`pull_request_target`), tags, issues, comments, labels and reviews as triggers; `concurrency`; path filters; a manifest written as `FACTORY.ts` with `Trigger.bind` (flows-as-code-api.md §5.7), which projects to the same JSON. `.smithers/factory.json` written by `S.Factory`, as smithersai/smithers' is today, has no `apiVersion` and starts nothing.

## Observability

| Name | Kind | Fields |
|---|---|---|
| `ci.job.call` | log | `run`, `repo`, `job`, `call` (`checkout`, `step`, `release`), `outcome` |
| `smithers_ci_job_calls{call,outcome}` | counter | `checkout`: `exact`, `refused`; `step`: `passed`, `failed`; `release`: `slept`, `busy`, `gone` |
| `ci.repo_flow.plan` | log, span | `run`, `repo`, `flow`, `sha`, `outcome` (`planned` or the refusal), `jobs` |
| `ci.repo_flow.status` | log | `run`, `repo`, `flow`, `sha`, `state`, `outcome` (`sent`, `refused`, `dropped`), `errorCode` |
| `ci.realm.plan`, `ci.repo_flow.report` | span | `smithers.ci.flow` |
| `ci.dispatch` | log | `delivery`, `repo`, `event`, `sha`, `outcome` (`matched`, `none`, `no_manifest`, `unreadable`), `flows` |
| `ci.start` | log | `delivery`, `repo`, `flow`, `executionId`, `outcome` (`started`, `not_started`), `errorCode` |
| `ci.dispatch.match`, `ci.dispatch.start` | span | `smithers.ci.delivery` |
| `smithers_ci_dispatches{event,outcome}`, `smithers_ci_starts{outcome}` | counter | |
| `github.webhook` | log | gains `dispatched`: the repository a push or pull request dispatched for |
| `smithers_repo_flow_plans{outcome}`, `smithers_repo_flow_statuses{state,outcome}` | counter | |

No record carries a flow's source, a command, its output or a secret.

## Tests

| Test | Proves |
|---|---|
| `packages/smithers/flows/sandbox/test/CiJob.test.ts` | the flow on the memory engine: order, skip after a failure, a timeout, another commit, the schemas' refusals, and two jobs as two child runs where one fails and its sibling passes |
| `worker/flows/CiJobMachine.test.ts` | the app's machine on the Node host: one machine per run and job, the `ci` user, one call id per call, a lost step, a machine that couldn't start |
| `worker/flows/CiJob.docker.test.ts` | real containers of the branch sandbox's image, commands as a user of their own: two jobs at once, each at exactly a commit of `roninjin10/smithers-github-tests` fetched from GitHub, Node v26.5.0 and pnpm 11.25.0, `exit 1` failing while its sibling passes, and a background process a step left stopped by the release |
| `worker/branch/Checkout.test.ts` | the checkout of one commit by its id, detached and shallow, and a commit the forge lacks |
| `worker/ci/Realm.test.ts` | the realm in Node's QuickJS: a TypeScript flow's jobs; a body deciding from its payload; refused imports, used or not, static or aliased; a loop, a memory bomb and a runaway recursion stopped; syntax, throws, a forged `JSON.stringify`, bad or repeated jobs, a wrong tag |
| `worker/ci/Realm.workerd.test.ts` | the realm in local workerd, bundled as Alchemy bundles ChatApi: a flow planned, and a loop stopped by the step budget, since workerd holds its clock still while code runs |
| `worker/ci/RepoFlow.test.ts` | `repo/Run` on the Node host against the scripted GitHub: flow.ts read at the commit, two jobs on two machines, `smithers/ci` pending then success or `Failed: lint`, no flow or a refused one running nothing, missing permissions, and GitHub's and Postgres' outages retried |
| `worker/ci/Triggers.test.ts` | the manifest's rows (a Plugin.Manifest only; rows this slice can't read skipped) and matching: branches, tags, tag-only triggers, pull request actions and base branches, globs |
| `worker/ci/Dispatch.test.ts` | a delivery as the webhook names it (push, tag, deleted, pull requests from the repository, a fork or below Member); `triggers/Dispatch` on the Node host: active flows started under `<flow>:<delivery>`, a fork without secrets, a trigger only the branch adds starting nothing, no manifest, unreadable, outages retried |
| `worker/github/Api.test.ts` | with `REPO_FLOWS` on, a push of any installed repository starts its `triggers/Dispatch`; off, nothing |
| `e2e/ci.spec.ts` | a deployment's App installation pushes a real commit; its real GitHub delivery is found by SHA in ChatApi's tail. Local development pushes as a person and signs its own delivery. Both watch the repository run, each job on its own machine, and `smithers/ci` success on the commit as GitHub shows it |

The deployment spec needs `E2E_REPO_FLOWS_REPOSITORY` (the scratch repository holding the fixture), `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` through the vault's environment wrapper, and `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID` for ChatApi's tail (`E2E_CHATAPI_SCRIPT` may select its script). The target must enable and allow that repository's flows; the App must be installed with Contents and Commit statuses write. The spec declares `repoFlows`, `githubAppKey` and `localLogs` in `e2e/target.ts` and skips with a reason when credentials are absent. Its short-lived installation token is restricted to that repository, Contents write and Commit statuses read. The SDK keeps credentials redacted, including errors and their causes; authenticated GitHub requests stay outside Playwright so no request attachment contains the token, JWT or key. Local runs instead declare `githubPushToken` and `webhookSecret`, supplied by `E2E_GITHUB_TOKEN` and `E2E_GITHUB_WEBHOOK_SECRET`. The deployer runs production e2e and generates the CI and run-view recordings.

### Repository rollout allowlist

`REPO_FLOWS=true` enables dispatch admission. `REPO_FLOWS_REPOSITORIES` is a comma-separated list of `owner/name` values (for example `smithersai/smithers,acme/widgets`), trimmed and case-insensitive. Unset or blank allows none; invalid entries authorize nothing. Matching records `not_allowed` in the durable step result, `ci.dispatch` log and dispatch counter before reading GitHub. ChatApi captures this set alongside `REPO_FLOWS` while Alchemy builds the program and injects it into both dispatch steps; neither step reads ambient runtime Config. Starting checks the captured allowlist again and records a denial with a `ci.start` log. A changed allowlist takes effect with the next deployment. GitHub installation access alone never authorizes repository flows.

The legacy `summary`/`flows`/`on`/`github` factory format in smithersai/smithers at `eeb01ea499d0` produces no triggers. Only supported plugin manifest trigger rows are eligible; the committed exact fixture proves legacy data never runs silently.
