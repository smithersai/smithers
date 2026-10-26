# Remote flows

A remote flow is a `@smthrs/flow` flow that runs on Cloudflare instead of in the browser. Each execution runs in its own Durable Object, `FlowExecution`, which ChatApi hosts. The object wakes itself with its alarm and drives the same durable engine the Node, Bun and browser hosts run, over Postgres through Hyperdrive.

## When a flow runs remotely

Flows run locally first ([decision 0011](../decisions/0011-the-agent-runs-in-the-browser.md) §2, [`flows.local-first-placement`](../rules.md#flowslocal-first-placement)). A flow runs here only when it needs something the browser doesn't have:

- a key the person must not hold, such as the Code Storage organization key;
- a machine to run code on;
- something that must happen while every device is off, such as a webhook or a schedule.

How long a flow takes never decides. The host runs `probe/Pause`, which proves the host and does nothing else; `chat/Expire`, which settles an answer still streaming once its queue has been still for 25 minutes, because it must happen while every device is off ([agent.md](agent.md#settling)); and, when sign-in is configured, `auth/RecheckRole`, which checks a session's role with GitHub using the session's GitHub token, a key the browser must not hold ([sign-in.md](sign-in.md#roles-and-role-checks)), and `auth/RevokeGitHubToken`, which signs a session out and revokes its GitHub token as the App, with the App's client secret ([sign-in.md](sign-in.md#signing-out)). It runs `ops/SpendAlert`, which tells the Admins about a window's model spend once the window ends, because that must happen while every device is off ([spend-alerts.md](spend-alerts.md)), and `ops/DatabaseLoad`, which samples the app's Postgres connections once a window and alerts the Admins when 80% are in use, because it reads the deployment's database and must run while every device is off ([database-alerts.md](database-alerts.md)). When the deployment has a Code Storage organization, it also runs `repo/Clone`, which clones a public GitHub repository with the organization's key ([repo.md](repo.md#the-clone)).

## No remote door

No route starts a remote flow by its name alone. Each remote flow is started by the route or flow that admits it:

| Flow | Who starts it | Why not by name |
|---|---|---|
| `repo/Clone` | `repo/clone`, the client flow a person's Clone, `/clone` and the agent run, through `POST /api/repos` ([repo.md](repo.md#cloning)) | RepoApi admits it first: sign-in, the repository cap, the spend budget, the `repositories` row and the attempt's `cloneId`. A start by payload alone would skip all five. |
| `chat/Expire` | ChatApi, when it takes a question | Neither a person nor the agent starts it. |
| `ops/SpendAlert` | the model endpoint, when it admits a call, once per window ([spend-alerts.md](spend-alerts.md)) | Neither a person nor the agent starts it. |
| `ops/DatabaseLoad` | every `FlowExecution` alarm, once it is done, once per window ([database-alerts.md](database-alerts.md)) | Neither a person nor the agent starts it. |
| `ops/BugReport` | `POST /api/bugs`, once it filed the report, one execution per report ([bugs.md](bugs.md#the-admins-hear)) | The route admits it first: sign-in, the body's bounds and the stored row. |
| `auth/RecheckRole`, `auth/RevokeGitHubToken` | sign-in | Neither a person nor the agent starts them. |
| `github/Write` | `issue/create` and `issue/comment`, the client flows a person's buttons, `/issue`, `/comment` and the agent run, through the device's outbox and `POST /api/repos/<owner>/<name>/writes` ([issues.md](issues.md#writes)) | The writes route admits it first: sign-in, the role, the App, the repository, the bounds and the payload's hash, recorded in `github_writes` under the device's write id. |
| `github/Apply` | `POST /api/github/webhook`, for a verified delivery naming an issue of the synced repository ([issues.md](issues.md#sync)) | GitHub's signature admits it; neither a person nor the agent starts it. |
| `github/Reconcile` | a read of `GET /api/shapes/items` that finds the sync older than 5 minutes ([issues.md](issues.md#sync)) | Neither a person nor the agent starts it. |
| `triage/Run` | `POST /api/github/webhook` for `issues.opened` while triage is on, and Run triage again (`triage/run`) through the writes route ([issues.md](issues.md#triage)) | GitHub's signature, or the writes route's Member check; the agent never starts it. It decides with the `judge` model role in process (`ModelEndpoint.local`), metered against the deployment's budget and the repository's own. |
| `probe/Pause` | tests | It only proves the host. |

[Decision 0003](../decisions/0003-flows-and-the-agent.md) §2 put one door, `POST /api/flows/<name>`, in front of every remote flow in the registry, admitted by its own payload schema. [0011](../decisions/0011-the-agent-runs-in-the-browser.md) §2 then placed every flow a person or the agent dispatches on the device, so the door shipped with nothing to start. It was removed on 2026-10-20 with its client, `RemoteFlows`, and the registry's `needs`. Every registered flow runs on this device ([flows.md](flows.md#the-registry)).

Add the door back with its first consumer: a remote flow that a person or the agent starts, and that its payload schema alone admits. When the agent needs to clone, its registered flow calls RepoApi's admission, not a door by name.

## How an execution runs

```
caller ── FlowExecution.getByName(executionId).start(intent) ──▶ Durable Object
                                                                   │ store the intent, alarm at now + 5 s, alarm at now
alarm ◀─────────────────────────────────────────────────────────────┘
  │ count the attempt, arm the alarm one backoff away (the watchdog)
  │ build the engine for this execution over Postgres (schema smithers_flows), drive it once
  ├─ settled ──▶ record when, alarm one day later
  ├─ parked  ──▶ alarm at the engine's next wake, such as a durable sleep's end
  ├─ yielded ──▶ alarm at now: the drive spent its budget (10 min) at a step boundary
  └─ failed  ──▶ alarm one backoff away (1 s, doubling, at most 5 min, never giving up)
final alarm, one day after the settlement
  └─ forgotten ─▶ delete the intent, the count and the settlement; arm nothing
```

- **One object per execution.** The object's name is the execution id, so a retried start reaches the object that already holds the intent. The same intent again is a no-op; a different payload is an `IntentConflict`.
- **Objects live beside the database when the deployment says where.** Each engine statement is a round trip to Postgres, so `FLOW_EXECUTION_LOCATION` creates every new execution's object at a Durable Object location hint; unset, Cloudflare creates it near its first caller ([placement](../infrastructure.md#placement)).
- **The object holds only the intent, a failure count and when the run settled.** Leases, attempts, timers, retries and results stay in the engine's Postgres tables, in the schema `smithers_flows` beside the app's tables. Each alarm opens its own connection and closes it when the alarm ends.
- **A settled object forgets its execution a day later.** Its final alarm deletes everything the object stored and arms nothing, so storage doesn't grow with every answer, role check and clone. Until then a repeated start, such as a question's resend, costs one alarm and no drive. After it a repeated start runs no step: the engine answers it from the settled run, and the object forgets it again a day later. The run's history stays in `smithers_flows` ([retention](../../../../packages/smithers/flows/platform-cloudflare/docs/concepts/execution-lifecycle.md#retention)).
- **A reset object resumes the run.** If the object dies mid-step (an evicted isolate, a reset, a deploy), the watchdog alarm wakes a new incarnation one backoff later. It takes the run over at once, replays what the engine recorded and runs the interrupted step again. A step runs at least once, so a step with an outside effect must be idempotent.
- **A drive stops starting steps after `EXECUTION_DRIVE_BUDGET_SECONDS` (600).** Cloudflare kills an alarm at 15 minutes of wall time, and a run with enough work never parks by itself. Past the budget the drive starts no new step, lets the running ones finish and record their results, releases the run and re-arms the alarm for now, so the next alarm goes on with no step run twice. The budget is whole seconds from 1 to 899, read once by `worker/Executions.ts`; set it below 900 less the longest step. Each alarm logs `smithers.execution.drive_ms`, and `smithers_cloudflare_execution_drive_duration` records it by outcome ([the drive budget](../../../../packages/smithers/flows/platform-cloudflare/docs/concepts/execution-lifecycle.md#the-drive-budget)).
- **The engine migrates its own schema** on the first alarm that builds it. `pnpm db:migrate` doesn't apply the engine's migrations yet.

The package behind it is [`@smthrs/platform-cloudflare`](../../../../packages/smithers/flows/platform-cloudflare/README.md); its [execution lifecycle](../../../../packages/smithers/flows/platform-cloudflare/docs/concepts/execution-lifecycle.md) states each guarantee.

## Files

| File | What it holds |
|---|---|
| `worker/flows/Pause.ts` | `probe/Pause`: marks a label, sleeps on a durable timer, marks it again. Host-agnostic: the host injects what a step does. |
| `worker/flows/Expire.ts` | `chat/Expire`, a lineage of rounds: `chat/ExpiresIn` (how long until `ANSWER_EXPIRY` after the answer's queue last moved, sealed), a durable sleep that long, and `chat/Abandon`, which settles the answer `failed`, `abandoned` only if it still streams and its queue stayed still, or hands off to the next round. The host injects Postgres and the expiry. |
| `worker/flows/SpendAlert.ts` | `ops/SpendAlert`: `ops/SpendAlertIn` (how long until its window ends, sealed), a durable sleep that long, and `ops/RecordSpendAlert`, which claims the window's uncarried model calls and records one alert. The host injects Postgres. |
| `worker/flows/DatabaseLoad.ts` | `ops/DatabaseLoad`: `ops/SampleConnections`, which reads the connections in use and `max_connections`, and, when 80% are in use, `ops/DeliverDatabaseAlert` per channel. The host injects Postgres and the channels; `sampler` is what each alarm runs once it is done (`ExecutionHost.make`'s `afterAlarm`). |
| `worker/flows/AlertDelivery.ts` | what `ops/DeliverSpendAlert` and `ops/DeliverDatabaseAlert` do on one channel: the receipt, the setting, the send, and refusal against retry. |
| `worker/flows/RecheckRole.ts` | `auth/RecheckRole`: refreshes a session's GitHub token when it is about to expire and records the person's role again. The host injects Postgres and GitHub. |
| `worker/flows/RevokeGitHubToken.ts` | `auth/RevokeGitHubToken`: revokes an ended session's GitHub token on GitHub, then forgets the session's GitHub tokens; after its step's last attempt, forgets them anyway. The host injects Postgres and GitHub. |
| `worker/flows/RepoClone.ts` | `repo/Clone`: Inspect, Import, Pull, AwaitSync and Settle ([repo.md](repo.md#the-clone)). The host injects Postgres, Code Storage and GitHub; `ExecutionHost.withRepoClone` adds it when `CODE_STORAGE_ORG` and `CODE_STORAGE_KEY` are set (`worker/RepoConfig.ts`). |
| `worker/github/{Write,Apply,Reconcile,Triage}.ts` | the git loop's flows and triage ([issues.md](issues.md)). The host injects Postgres, GitHub's `HttpClient`, the tokens and triage's judge (`worker/github/Host.ts`); `ExecutionHost.withGitHub` adds them when `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are set. |
| `worker/ExecutionHost.ts` | The object's `start` and `alarm` handlers over its storage, the flows it may run (`remote(app)`, over the app's tables and the answer expiry, and `remoteWithSignIn(app, services)` when sign-in is configured), the engine's schema and `intent`, which builds a start request. |
| `worker/Flows.ts` | `FlowStarter`, where a route that admits a remote flow starts it, and its failures `StartConflict` and `StartUnavailable`; `startEachWindow`, a start once a window per isolate. |
| `worker/Executions.ts` | The Alchemy Durable Object `FlowExecution`, which hands its storage, id and Hyperdrive connection to `ExecutionHost`, reads `ANSWER_EXPIRY` and `EXECUTION_DRIVE_BUDGET_SECONDS`, and adds sign-in's services when they are configured. |
| `worker/Placement.ts` | `FLOW_EXECUTION_LOCATION` and `placed`, the namespace every caller creates execution objects through, at that location hint when it is set. |
| `worker/ChatApi.ts` | Hosts `FlowExecution`, binds its namespace, starts `auth/RecheckRole` for sign-in, and gives sign-in's routes (`worker/SignIn.ts`, which starts `auth/RevokeGitHubToken`), `POST /api/questions` (`worker/Chat.ts`, which starts `chat/Expire`) and RepoApi (`worker/RepoApi.ts`, which starts `repo/Clone`) their `FlowStarter` (`worker/Flows.ts`). |

Only the Worker entries (`worker/ChatApi.ts`, `worker/index.ts`, `worker/Executions.ts`, `worker/ExecutionHost.ts`), `alchemy.run.ts` and `infra/` may import Cloudflare or `@smthrs/platform-cloudflare` ([`sdk.host-agnostic-flows`](../rules.md#sdkhost-agnostic-flows)). A remote flow lives in `worker/flows/` and never imports them.

## Starting an execution

ChatApi starts `chat/Expire` when it takes a question, through `FlowStarter`, one execution per answer (`chat-expire-<answerId>`), without waiting for the flow, and acknowledges the ask (`202`, or a resend's `200`) only once the start is recorded; a start the host can't record is logged `not_started` and answered `503`, which the outbox sends again ([agent.md](agent.md#settling)). It starts `auth/RecheckRole` from sign-in's `RoleChecks`, one execution per session and the check it replaces (`auth-recheck-<sessionId>-<role_checked_at in epoch ms>`), without waiting for it, so one check of a session runs at a time ([sign-in.md](sign-in.md#roles-and-role-checks)). Sign-in starts `auth/RevokeGitHubToken` through `FlowStarter` when a person signs out, or signs in again over a session, one execution per session (`auth-revoke-<sessionId>`), without waiting for the flow, and answers only once the start is recorded ([sign-in.md](sign-in.md#signing-out)). A handler starts a remote flow like this:

```ts
const executions = yield* Executions.FlowExecution // in ChatApi's init
// in the handler, after it authorizes and bounds the request:
const intent = yield* ExecutionHost.intent(Clone, { executionId, payload })
yield* executions.getByName(executionId).start(intent)
```

The response returns once `start` does; the flow runs from the object's alarm.

## Adding a remote flow

1. Write the flow in `worker/flows/` with `Flow.make` and a registration built with `Interpreter.layerWithImplementations`, as `Pause.ts` does.
2. Add it and its registration to `remote` in `worker/ExecutionHost.ts`.
3. Test it on the Node host with `runFlow` from `worker/test/flowHost.ts`.

Child flows run on this host: `@smthrs/platform-cloudflare` routes a child execution to its own object (`ExecutionObject.ts`), as CI's `repo/Jobs` and `ci/job` do ([CI](ci.md)).

## Tests

| Test | Proves |
|---|---|
| `worker/flows/Pause.test.ts` | `probe/Pause` runs to the end on the Node host (`Runtime.layer` with `@smthrs/platform-node`) over the compose Postgres, waits for its timer, and fails with its declared error on a negative pause |
| `worker/flows/Expire.test.ts` | `chat/Expire` on the Node host: it sleeps until the answer is old enough, settles a streaming one `abandoned`, leaves a settled one, and a device that comes back after it fails `AnswerSettled` ([agent.md](agent.md#tests)) |
| `worker/flows/RepoClone.test.ts` | `repo/Clone` on the Node host, including a run killed mid-step that a new engine resumes with no second create ([repo.md](repo.md#tests)) |
| `worker/ExecutionHost.test.ts` | `start` wakes the object at once; the first alarm parks on the durable timer with the alarm armed for it; the next settles the run and arms the final alarm a day later, which empties the object's storage; each start and alarm logs and counts its outcome without the payload; the deployed flows run `chat/Expire` through its durable sleep to the answer's settling, and a round that finds the queue moved hands the next round to that round's own object |
| `worker/flows/DatabaseLoad.test.ts`, `worker/ExecutionHost.test.ts` "afterAlarm" and "ops/DatabaseLoad" | `ops/DatabaseLoad` on the Node host, under and over its share; every alarm, idle or settling, runs `afterAlarm`; an alarm starts the window's sample on its own object, which samples once ([database-alerts.md](database-alerts.md#tests)) |
| `worker/ExecutionHost.workerd.test.ts` | in local workerd (Miniflare), a real Durable Object runs `probe/Pause` from real alarms; its second step calls `ctx.abort()`, and the retried alarm's new incarnation takes the run over, completes it and arms the final alarm |

| `worker/flows/Todo.test.ts` "the todo run on a host that dies mid-implement" | an engine killed while the agent waits on its third frame is resumed by a new one: frames 1 and 2 replay from their sealed model steps, only frame 3 is asked again, each tool call keeps its id, and the run reaches its merged pull request. This is what a Durable Object alarm cut at 15 minutes does to a 40-minute `todo/Implement` ([infrastructure.md](../infrastructure.md#limits)) |
| `e2e/remote-flows.spec.ts` | on the deployment, as the e2e test account: the synced repository's issues list fills through `github/Reconcile`, with no failed walk; a signed `issues` delivery is `applied` and its `github/Apply` reads the issue back; with `E2E_LONG=1`, a question's spend is recorded by `ops/SpendAlert` when its window ends, an answer whose device left settles `abandoned` through `chat/Expire` and shows Couldn't answer on another device, the session's role is checked again by `auth/RecheckRole` an hour after it was read, and a TODO committed on a scratch repository's stack (`E2E_TODO_REPOSITORY`, `roninjin10/smithers-github-tests` unless set, never `smithersai/*`) runs through `todo` to an open pull request, which Drop closes. Each waits for the flow's own record through a Cloudflare tail on ChatApi (`e2e/logs.ts`) |

Against a deployment (`E2E_PROD_URL=<url> pnpm e2e:prod remote-flows.spec.ts`), ChatApi's records come from a Cloudflare tail, which needs `CLOUDFLARE_API_TOKEN` (with Workers Tail read) and `CLOUDFLARE_ACCOUNT_ID`; the webhook test signs its delivery with `E2E_GITHUB_WEBHOOK_SECRET`, the deployment's webhook secret; `E2E_LONG=1` runs the tests that wait out production's windows (up to 66 minutes). Without them each test skips with its declared need. No test signs out: that would end the run's shared session, so sign-out's revocation is proven by its record (`auth.revoke_token`, `outcome: revoked`) after a person signs out.

The workerd test's object (`worker/test/workerd/worker.ts`) is a plain Durable Object that hands its storage and id to `ExecutionHost`, as `FlowExecution` does under Alchemy. `FlowExecution` itself runs only in Alchemy's bundle, under `alchemy dev` or a deploy.

Run them with the compose Postgres up (`pnpm db:up`):

```sh
pnpm exec vitest run worker/flows/Pause.test.ts worker/ExecutionHost.test.ts worker/ExecutionHost.workerd.test.ts
```

## Observability

Each start and alarm logs, traces and counts itself, and so does each probe step. [observability.md](../observability.md#remote-flow-executions) lists the records.
