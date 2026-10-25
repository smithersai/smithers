# A repository's runs

Every run of a repository's own flow runs on Cloudflare ([CI](ci.md)). `/$owner/$repo/actions` lists them, newest first, and each opens its run page, which a Member watches live: the run, the runs it started (its jobs), each step and its log, with Stop. Work notes: [ci-parity-run-view](../work/ci-parity-run-view.md), [ci-parity-manual-run](../work/ci-parity-manual-run.md).

```
start (a trigger, a person's Run) ─ RepoRuns.record ─▶ runs row: execution, repo_id, flow, sha, ref, event, working
                                   ─ FlowStarter ─▶ FlowExecution DO <flow>:<id>
DO alarm finds the run settled ─ settled(execution) ─ RepoRuns.settle ─▶ runs.status done | failed | stopped
/$owner/$repo/actions ─▶ Electric: GET /api/shapes/actions?repo=<owner>/<name> ─▶ runs WHERE repo_id = $1 AND execution IS NOT NULL
/$owner/$repo/actions/runs/<run id> ─ openRun(runId, repo) ─▶ GET /api/remote-runs/<id>  (the run, then each run it started)
                                   ─ follow ─▶ GET /api/shapes/remote-runs?run=<id>  (the run and each run it started)
Stop ─▶ run/cancel { runId, seq, host: "cloud" } ─ step ─▶ POST /api/remote-runs/<id>/stop ─▶ DO cancel ─▶ cancelled
```

- **One index.** A repository's run is a `runs` row, as every run is (decision [0009](../decisions/0009-notifications-and-live-work.md) §2), keyed by the version 5 UUID of its execution id, with the engine's run id in `execution` (migration `0053_repo_runs`). No second run model: the engine holds the journal, the row the list's state (ruling FLOW-2).
- **Settled by its object.** The row's state moves only once: when the run's `FlowExecution` alarm finds the run settled, it reads the engine's own status and writes `done`, `failed`, or `stopped` for a cancelled run (`worker/RepoRuns.ts` `settle`, `ExecutionHost.make`'s `settled`). A settlement seen twice writes once; one the app's database didn't take is tried again by the alarm that forgets the run a day later. A run stopped before the engine began it settles `stopped`.
- **The page is the Runs page.** `RunPageView` draws a repository's run as it draws a device's ([runs](runs.md#the-run-page)), with `Cloud` in its header. The route reads it through `GET /api/remote-runs/<id>`, the engine's own `RunInspection` with the same redaction, and the runs it started through the same route; each run it started opens on its own page under the repository.
- **Live, with no polling.** The page follows the run's row of the engine's change feed, and each run it started, through Electric. A job's change reads the run again, and of its jobs only that one; a job opened on its own page follows through the same subscription.
- **Logs.** A step's log is its `telemetry.log` journal events, shown in the step's inspector as on a device.
- **Who.** The list reads the route repository's rows through `?repo=<owner>/<name>`, with that repository's role resolved by `RepoRoles` (decision [0098](../decisions/0098-repository-run-scope.md)). An omitted parameter retains the deployment repository for existing clients; a malformed one returns 400. A run's page, the runs it started, and Stop are for a signed-in Member or above of that repository, in person or through an agent acting for them (ruling FLOW-3): a role read on it says nothing about another repository's runs, so a run without a role on its recorded repository reads `Not found`. Role resolution failures refuse the request; unavailable or rate-limited resolution returns 503.

## Routes

| Route | Answers |
|---|---|
| `GET /api/shapes/actions?repo=<owner>/<name>` | Electric's shape of the repository's runs: `id`, `repo_id`, `execution`, `flow`, `status`, `sha`, `ref`, `event`, `created_at`, `updated_at`; never who launched one |
| `GET /api/remote-runs/<run id>` | a repository's run, or a run it started (walking at most 16 generations of parents), as [a run on Cloudflare](runs.md#routes) reads |
| `GET /api/shapes/remote-runs?run=<run id>` | the same runs' rows of the engine's change feed |
| `POST /api/remote-runs/<run id>/stop` | `202 { outcome: "requested" }`, or `200 { outcome: "settled" }` for a run that had ended; a recorded run the engine hasn't begun is stopped before it starts |

The stop route's refusals are `{ code }`, `Cache-Control: no-store`:

| Status | `code` | When |
|---|---|---|
| 401 | `authentication` | signed out |
| 403 | `forbidden` | not a Member |
| 404 | `not_found` | no accessible recorded repository run, or a job of one: a job stops with its run |
| 503 | `unavailable` | sessions, Postgres or the object couldn't answer; `Retry-After: 5` |

## Acts

| Act | Shown | Does |
|---|---|---|
| `run/cancel { runId, seq, host: "cloud" }` | Stop: on the run's own page (not a job's), while the run hasn't settled and no stop was asked | Asks ChatApi, which answers `settled` for a run that ended and otherwise asks the run's `FlowExecution` to stop it (`ExecutionObject.make`'s `cancel`, `@smthrs/platform-cloudflare`): a durable tombstone, then the engine's cancellation of the run and every run it started; a run the object hasn't begun never starts. The object's next alarm settles it `cancelled`. A step already running finishes first. Refused `forbidden` for who may not stop it, `not_found` for a run that isn't a repository's |

The person's Stop and the agent's call run the same flow on this device's engine; its step asks ChatApi as the run that made it (decision 0017 slice 0).

## The browser

`src/features/runs/` holds it: `RunsStore.openRepoRuns(owner, name)` starts syncing that repository's runs (`repo-runs:<owner>/<name>`, normalized to lower case and kept on the device) the first time its list opens, `repoRunRows` (`page.ts`) draws a repository's, and `openRun(runId, repo)` marks a run read on Cloudflare (`RunsStore.cloud`) with the runs it started. Screens: `src/screens/actions/`.

## Observability

| Record | Kind | Fields |
|---|---|---|
| `run.stop`, `smithers_run_stops` | log, span; counter (ChatApi) | `host` (`remote`), `runId`, `via`, `outcome` (`requested`, `settled`, or the refusal's code), `status`, `durationMs`, `errorCode` |
| `cloudflare.execution.cancel`, `smithers_cloudflare_execution_cancellations` | log, span; counter (the object, [remote flows](../observability.md#remote-flow-executions)) | `outcome` |
| `repo.run.record`, `repo.run.settle`, `smithers_repo_run_writes` | log, span; counter | `runId`, `repoId`, `flow`, `event`, `op`, `outcome` |
| `run.act` | log (engine worker) | `act` (`cancel`), `host` (`remote`), `runId`, `outcome` |

No record carries a value of a run.

## Tests

| Test | Proves |
|---|---|
| `worker/RepoRuns.test.ts` | a run recorded once; settled `done`, `failed`, `stopped` from the engine; a job admitted as its run's, other runs not |
| `worker/ExecutionHost.test.ts` "settled" | the object hands each settled alarm's execution, and the forgetting one's, to `settled` |
| `worker/RemoteRuns.test.ts` "a repository's run", "stop" | a Member reads a run and its jobs with a role on its recorded repository, with role failures refused; Stop's answers and refusals |
| `worker/github/PullsApi.test.ts` "the repository's runs" | the actions shape carries a repository's flows' runs, the Checks shape its checks |
| `src/features/runs/remote.test.ts` "a repository's run on Cloudflare" | a device lists two repositories independently, follows live updates and deletes, reloads its SQLite store, watches the run, and stops it through `run/cancel` and ChatApi; a job's progress reads its run's page, and a job's own page, with no Stop; a Guest reads Not found |
| `e2e/ci.spec.ts` | a real push, repository run list, run page and reload; `requires("localLogs", "repoFlows")` plus `githubAppKey` on deployments, or `githubPushToken` and `webhookSecret` locally, declare the prerequisites; its recording supplies the run-view GIF |

Triggered runs are recorded by `triggers/Start` before the Durable Object start. A repeated delivery or failed start reuses the execution and its row.
