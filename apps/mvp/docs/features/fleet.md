# Fleet

A repository's agent runs and runner machines, live, for its Maintainers: who works, who waits for a runner, what
stalled or failed, and which machines answer ([decision 0143](../decisions/0143-fleet-and-alerts.md)). It is the
first-party plugin `plugins/fleet/` over two core queries, and five alerts reach people through the bell and the
deployment's alert channels. Libraries: `@smthrs/plugin`, `@smthrs/ui` (`Table`, `Badge`, `RelativeTime`, `EmptyState`,
`useClock`), `@smthrs/effect-electric`, `@smthrs/notifications` ([library catalog](../../../../docs/libraries.md)).

```
runner ── claim { machine } · heartbeat { account, cpuSeconds, usage } · settle ──▶ worker/runners/Api.ts
                                                                                     │ agent_jobs, runners, agent_runs
agent/Session (ExternalAgent) ── start · probe (≤ 30 s) · cancel ──▶ Jobs.ts ──▶ Fleet.ts: project the run, find what came due
                                                                                     │ alert due ─▶ ops/FleetAlert (its own execution)
todo/Fail ─────────────────────────────────────────────────────────────────────────────┤ Run failed
FlowExecution alarm ─▶ ops/RunnerHealth (once a minute) ─────────────────────────────────┘ Runner offline, no job to probe
ops/FleetAlert ─▶ fleet_alerts + one `fleet` notification each ─▶ the bell ; ops/DeliverFleetAlert × email, Telegram
agent_runs, runners ─▶ Electric (/api/shapes/agent-runs, /api/shapes/machines) ─▶ core/agent-runs, core/machines
   ─▶ plugins/fleet (/<owner>/<repo>/-/fleet) and the factory's Agents view
```

## The view

`/<owner>/<repo>/-/fleet`, a `repository` view for Maintainers and Admins; the header's `repo.tabs` shows **Fleet** on a
repository with agent runs.

```
12 working · 3 waiting · 1 stalled · 2 failed today · runners 2/2
Run                      Agent  Runner  Account   Time   Last event  Usage            State
T412 drive-foldkit-ui    opus   nyc-01  claude-3  1h12m  4 s ago     812k tok         Working
T398 migfix-t3code       sol    nyc-02  codex-a2  2h03m  14 min ago  unreported       Stalled
T420 fuzz-findings       sol    -       -         0h03m  -           unreported       Waiting
Machine  State              Jobs   Load   Disk  Version      Seen
nyc-01   Held · load 31/24  14/26  31.0   212G  1.0.0-rc.16  3 s ago
nyc-02   Online             9/26   12.4   340G  1.0.0-rc.16  1 s ago
```

- **Runs.** Every run of the repository, one row per generation: live ones first (Stalled, Waiting, Stopping,
  Working), then ended ones newest first. Nothing caps the list at 50. A run's TODO links to its page, where its
  transcript and Stop and Steer are. Time counts from the claim (from queueing while it waits) to its end, ticking every
  10 s; Last event ticks on `RelativeTime`. Usage the agent didn't report reads `unreported`, never `$0`.
- **States** in product words: Waiting (for a runner), Working, Stalled, Stopping, Stopped, Failed (with its code),
  Done, Retried (a generation that ended retryable; the next generation is its own row).
- **Machines.** Every runner the repository registered, with no run too: Online, Held (online, but its runner takes no
  job by its own [admission](agent-runners.md#admission) rule, with its reason: `Held · load 31/24`, `Held · disk
  31G/40G`), Offline (no request for 45 s), Never seen, Removed; its jobs of its capacity, load, free disk, version and
  last request. The header counts Held runners as online and adds `· 1 held`.
- **Accounts.** The account label the runner's hook chose shows to Maintainers and Admins only; the shape leaves it out
  for anyone else. Never an email, a path or a token.
- **Phone.** At 40 rem and below the runner, account, last event, usage and the machines' facts columns hide.

The factory's **Agents** view ([factory.md](factory.md)) reads `core/agent-runs` too: Smithers' own runs show in their
own **On Smithers** section above the collector's lanes, so during the cutover a lane is a run or a collector lane,
never both.

## Queries

| Query | Params | Rows |
|---|---|---|
| `core/agent-runs` | `{ repo: "owner/name" }` | `agent_runs` of the repository, newest first: `key`, `agent`, `generation`, `runId`, `number`, `title`, `runner`, `accountLabel` (Maintainers only), `state`, `reason`, `queuedAt`, `claimedAt`, `firstEventAt`, `lastEventAt`, `activityAt`, `endedAt`, `contextTokens`, `costUsd`, `transcriptBytes` |
| `core/machines` | `{ repo: "owner/name" }` | `runners` of the repository, by name: `id`, `name`, `labels`, `capacity`, `seenAt`, `removedAt`, `version`, `load1`, `diskFreeGb`, `held` |

Each is one Electric shape per repository, opened once a tab asks and kept while it lives (`src/features/fleet/store.ts`),
never kept on the device. A first read answers once its first sync arrived, or after 30 s (`INDEX_FIRST_SYNC`), so rows
still loading never read as "No agent runs". Fifty runs are fifty rows of one shape; no run inspector opens. A missing or malformed `repo`
is refused `invalid_fields`.

## The shapes

| Route | Who | Filter |
|---|---|---|
| `GET /api/shapes/agent-runs?repo=<owner>/<name>` | signed-in Members and up of the repository (as the TODOs' shape) | `repo_id`; the account label only for Maintainers and Admins in person |
| `GET /api/shapes/machines?repo=<owner>/<name>` | Maintainers and Admins of the repository, in person | `repo_id`; never `token_sha256` or `added_by` |

The role is the person's on that repository (`RepoRoles`, decision 0079), decided once per request: `401` signed out,
`403` below the role or no repository named, `503` when GitHub or Postgres can't say.

## The projection

`agent_runs` is written only under its job's key, never by a sweep (ruling DUR-2, `worker/runners/Fleet.ts`):

| Writer | When | Writes |
|---|---|---|
| `Jobs.start` | the step queues a generation | the run, Queued, with its TODO's run id, number and title (from the task's `context.attemptId`) |
| the claim route | a runner claims or reclaims the job | Working, the runner's name; the machine's facts on `runners` (rounded, written only when they changed) |
| `Jobs.status`, the step's parked probe (2 s doubling to 30 s) | every probe | what changed since: state, the heartbeat's account, CPU seconds and usage, S2's first and last event and bytes, the end; and the alerts that came due |
| `Jobs.cancel`, and `Jobs.stop` for a person's Stop on the TODO's run | Stop | Stopping (claimed) or Stopped (queued) |
| `Fleet.crashed`, from `settleCrashed` | the TODO's run died | every open generation reads Failed `crashed`; a later settle adds only its usage |
| the settle route | the runner settles | Done, Failed with its code, Stopped or Retried, and the final usage |

A heartbeat writes the account label, CPU seconds and usage on `agent_jobs`, which nobody syncs; the probe projects them
at most once a probe and only when something changed, so a talkative fleet writes `agent_runs` about once a run per
30 s. A request marks its runner seen at most every 10 s, so heartbeats don't rewrite the synced `runners` row.

## Alerts

Durable flows, no sweeps (FINAL.md §4.2):

| Alert | Raised by | Threshold | Who hears it |
|---|---|---|---|
| Run failed or lost | `todo/Fail`, once its failure is reported | at once | the committer; the repository's Maintainers and Admins |
| Run stalled | the probe | no event and under 5 CPU seconds for `AGENT_STALL_MINUTES` (10) | the committer; Maintainers and Admins |
| Runner offline | the probe of a job on it; `ops/RunnerHealth` once a minute for runners with none | no request for `RUNNER_OFFLINE_SECONDS` (45) | the repository's Admins |
| Waiting too long | the probe | queued for `AGENT_WAIT_MINUTES` (5) | Maintainers and Admins |
| Cost | the probe | reported cost past `MAX_RUN_USD` (unset: off) | the committer; Admins |

- **The stall rule.** A run's activity is the latest of its claim, its agent's last transcript event, and the last
  probe that saw its process tree's CPU seconds pass the mark by 5 (which moves the mark). So a 20-minute `go test` that
  prints nothing is work, and an agent waiting on nothing is a stall. A runner that reports no CPU time stalls on events
  alone.
- **One incident each.** An alert's id is its incident: `fleet-stalled-<key>-<quiet since>`, `fleet-waiting-<key>`,
  `fleet-cost-<key>`, `fleet-failed-<attempt>`, `fleet-offline-<runner>-<last seen>`. It is the `ops/FleetAlert`
  execution's id, the `fleet_alerts` row's and the delivery receipts' key, so a second start of the same incident runs
  nothing. The probe records each alert it started on the run (`agent_runs.alerted`) and starts none twice; a start that
  fails is logged and the next probe starts it again.
- **Recovery.** A stall closes when work shows again, a wait when a runner claims the job, an outage when the runner's
  next request arrives (`fleet_alerts.closed_at`). A later stall or outage is a new incident.
- **Who.** A repository's roles are the ones GitHub gave (`github_repo_roles`, decision 0079); on the deployment's own
  repository, the live sessions' roles. The committer is the TODO's.
- **The bell.** One `fleet` notification per person (`fleet:<alert id>`), in the panel only, never a toast: `Agents ·
  T398 migfix-t3code · Stalled`, opening the TODO's page (an outage opens the fleet). The bell always works.
- **Outside the app.** `ops/DeliverFleetAlert` sends on the deployment's email and Telegram channels, where an Admin set
  them, as every alert delivers ([spend-alerts.md](spend-alerts.md#delivery)), each with an `alert_deliveries` receipt.
  Nothing here sends to Telegram any other way.

## Settings

| Variable | Default | |
|---|---|---|
| `AGENT_STALL_MINUTES` | 10 | 1 to 720 |
| `AGENT_WAIT_MINUTES` | 5 | 1 to 720 |
| `RUNNER_OFFLINE_SECONDS` | 45 | 45 to 3600; a runner reads Offline in the view after 45 s |
| `MAX_RUN_USD` | unset (off) | above 0; raises an alert, stopping stays a person's act |

`FlowExecution` reads them when its Durable Object starts; a value out of bounds fails its start.

## The runner's side

`@smthrs/agent`'s `AgentRunner` carries the facts, each optional: a claim's `machine { version, load1, diskFreeGb }`, and
a heartbeat's `account` (written as a profile is), `cpuSeconds` (the agent's whole process tree, each process at its
last observed time, so one that exited keeps what it used) and `usage`. `smthrs runner` sends them
([CLI reference](../../../../packages/smithers/docs/reference/cli/runner.md)); a label it can't carry, such as a path, is
left out rather than refused with the heartbeat.

## Postgres

Migration `0084_fleet`:

| Table | |
|---|---|
| `agent_runs` | one row per generation, keyed as `agent_jobs`: the columns of `core/agent-runs`, plus `todo_id`, `cpu_seconds`, `cpu_mark`, `alerted`, `updated_at`. No task, prompt, summary or file. `REPLICA IDENTITY FULL` |
| `agent_jobs` + `account_label`, `cpu_seconds`, `usage` | what the last heartbeat said |
| `runners` + `version`, `load1`, `disk_free_gb` | what the last claim said; `REPLICA IDENTITY FULL` |
| `fleet_alerts` | one row per incident: `id`, `kind`, `repo_id`, `subject`, `title`, `href`, `recipients`, `opened_at`, `closed_at` |
| `notifications.kind` | takes `fleet` |

Migration `0085_runner_held` adds `runners.held`: why the runner's last claim said it takes no job, null while it
admits.

## Observability

- Spans and logs: `fleet.project` (a projection that failed, by code), `fleet.alert` (started or `not_started`, by
  kind), `fleet.alert.bell`, `fleet.alert.delivery`, `runner.health`, `fleet.shape.runs`, `fleet.shape.machines`.
- Metrics: `smithers_agent_runs_writes{op}`, `smithers_fleet_alerts_raised{kind,outcome}`,
  `smithers_fleet_alert_bells{kind}`, `smithers_fleet_alert_deliveries{channel,outcome}`,
  `smithers_runner_health_checks{outcome}`, `smithers_fleet_run_shape_requests`, `smithers_fleet_machine_shape_requests`.
- They carry job keys, runner names, alert ids, kinds and counts. Never a prompt, a transcript, an account path, an
  address, a chat id or a token (OBS-5); account labels are never metric labels.

## Code and tests

- `worker/runners/Fleet.ts` (the projection and the rules), `Jobs.ts`, `Api.ts`, `FleetApi.ts` (the shapes);
  `worker/flows/FleetAlert.ts` (`ops/FleetAlert`, `ops/RunnerHealth`); `src/features/fleet/` (contract, schema, store);
  `src/plugins/plugins.ts` (the queries); `plugins/fleet/` (manifest, `model.ts`, `tab.ts`, components).
- `worker/runners/Fleet.test.ts`: `project`'s rules (stall by quiet, a CPU-bound build, recovery, waiting, offline,
  cost, outcomes); the projection on Postgres through the real job store and runner routes; `ops/FleetAlert` on the Node
  host to the bell and the local Telegram stand-in, once; Admins only for an outage; the deployment's own repository;
  `ops/RunnerHealth`.
- `worker/runners/TodoRunner.test.ts` "the fleet over a real runner": real `todo` runs, a real `smthrs runner` process
  and the ACP test agent: a silent agent reads Stalled and its committer and an Admin hear it; a CPU-bound quiet build
  doesn't stall; a refused run's failure; the runner killed, one Runner offline alert; each once in the bell and on
  Telegram.
- `plugins/fleet/src/model.test.ts`, `tab.test.ts`; `src/plugins/facts.test.ts` (the manifest loads).
- `packages/smithers/test/Runner.test.ts`: each heartbeat carries the hook's account, the tree's CPU time and usage;
  each claim the machine.
- `e2e/fleet.spec.ts`: on a build with the GitHub App (`agentRunner`), a deployment included: 53 runs, the oldest
  listed, on a desktop and a phone; a silent agent Stalled and a busy one Working, waiting out the server's own window
  (`fleetStall`: `AGENT_STALL_MINUTES=1` on a stack, a deployment's 10 minutes with `E2E_LONG=1`); the runner killed
  and one Runner offline alert in the bell within 90 s, and with a Telegram stand-in (`fleetTelegram`) one message. A
  deployment's real Telegram can't be read back, so the summary lists that part as left out.

## Not yet

- **`/app/fleet`**, every repository's runs for a deployment's Admins: FINAL.md §4.1's second view.
- **Steer and Stop** as row acts: they are S3's, on the TODO's page the row links to.
- **Containers** (`sandbox_generations`) beside the runners in Machines.
