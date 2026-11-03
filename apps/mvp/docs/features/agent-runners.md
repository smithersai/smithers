# External agents on runners

A repository's TODOs can be coded by an external agent, an agent program on a machine you run, instead of their
committers' model connections ([decision 0136](../decisions/0136-external-agents-on-runners.md) §9). Smithers names no
agent vendor. An agent is a name, the machine labels a runner must carry, and an opaque profile that only the runner reads. The runner's own
configuration maps the profile to a command that speaks the [Agent Client Protocol](https://agentclientprotocol.com)
(ACP) on stdio. You choose the command, its login and its account; Smithers never sees them.

```
smithers.sh                                                     your runner machine (`smthrs runner serve`)
todo/Begin ─▶ todo/Agent ─┬─ none: todo/Implement (Smithers' agent)
                          └─ "<agent>": agent/Session ──start──▶ agent_jobs ◀── claim (long poll) ── runner/Job
                                       │                                   ◀── heartbeat every 10 s        │ jj workspace at the base
                                       │ probe 2 s → 30 s                  ◀── settle { changes }          │ ACP agent with its own tools
                             todo/Received ◀───────────────────────────────────────────────────────────────┘
                                ─▶ todo/Publish (one App commit, one pull request) ─▶ todo/Await
```

## Setting it up

An Admin of the repository does each step in person; an agent, a flow or a sandbox acting for them is refused.
Registering a runner, naming an agent or turning overflow on hands a machine the repository's jobs, so it needs the
App's recorded installation on the repository and the Admin role GitHub gives there; the deployment's own role never
stands in for it ([decision 0148](../decisions/0148-runner-git-credential.md)). Every Admin action on a repository's runners, agents
and overflow, `PUT` and `DELETE` alike, carries one fence (`worker/runners/Fence.ts`): the route reads the body
whole, then who is asking and their authority (the repository's role row, or on the deployment's own repository the
sign-in session and the alias it came through), and the flow's transaction takes the resource's lock (even for a name
not written yet), answers a replay with the outcome already recorded before it changes anything (the overflow setting
included), then locks the rows it writes (the runner's, or the repository's agents) and the authority's rows (the role
row; or the person, the session and the alias, all locked before any is judged), then checks that authority, the
fence's own expiry (5 minutes) by the clock as it stands then, and the generations it was admitted against: the
runner's or agent's, which a removal doesn't reset, and for an agent, the repository's coding selection's. An action
refused there writes nothing. Admitted, any lock the write still waits on gives up at its authority's earliest
deadline (`lock_timeout`): the fence's expiry, the session's, or the end of the role row's five-minute freshness. Right
before it commits, every change made, the write checks that deadline again: waits that add up past it roll the whole
write back, and the action is refused `authorization_expired`.
Each `202` answers `{ name, execution }`; `GET /api/runners/admin-receipts/<execution>` answers how it ended, for the
Admin who started it: `set`, `removed`, `missing`, `authorization_expired` (its authority no longer holds, or it
waited past its expiry, or it was started before fences) or `superseded` (the runner or agent changed since), and
`404` until it ends. A refused action is sent again. While a deploy brings fences in, a Worker still on the release before them writes
unfenced until it is replaced. A runner claims a job only when it was registered that way, and
while the App's installation on its repository is recorded.

1. On the runner machine, make its token. Only its SHA-256 leaves the machine:

   ```sh
   smthrs runner token --format json   # {"sha256":"<64 hex>"}; the token stays in ~/.smithers/runner/runner-token (0600)
   ```

   The text form prints `sha256: <64 hex>`: copy the hex alone.

   There is no Settings page yet, so steps 2 and 3 are HTTP calls in your own session, which is what "in person" means.
   A write with a session cookie must also say whose device sent it, or it is `401`: run them from the console of a
   signed-in tab, with this `put`:

   ```js
   const { personId } = await (await fetch("/api/auth/session")).json()
   const put = (path, body) => fetch(path, { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-smithers-device-person": personId } })
   ```

2. Register the runner for the repository, with the labels it carries and how many jobs it runs at once (1 to 64):

   ```http
   PUT /api/repos/<owner>/<name>/runners/<runner>
   { "tokenSha256": "<64 hex>", "labels": ["linux", "nyc"], "capacity": 4 }
   ```

   `DELETE` the same path retires it: its token is refused at once.

3. Name the agent and make it the repository's coding agent:

   ```http
   PUT /api/repos/<owner>/<name>/agents/<agent>
   { "labels": ["linux"], "profile": "my-agent", "maxHours": 4, "restarts": 1, "coding": true }
   ```

   `maxHours` (1 to 12, 4 unless set) bounds one TODO's work, every generation included. `restarts` (0 to 5, 1 unless
   set) is how many more generations a retryable end may have. At most one agent is the coding agent; `DELETE` it, or
   set another, and TODOs code with their committers' model connections again. `smithers` is reserved.

   The `202` means the write started. `GET` the same path answers `{ "name", "coding" }` once it has landed, and `404`
   before: a TODO committed sooner reads the repository's old coding agent, or none.

4. Write `runner.json` on the machine and start the runner. The [CLI reference](../../../../packages/smithers/docs/reference/cli/runner.md)
   describes every field: the origin, the runner's name, its capacity, each repository's local `jj` mirror, and each
   profile's `argv`, `env`, `prestart` hook and `secretEnv`.

   ```sh
   smthrs runner serve --config runner.json
   ```

Each answer is `202` once the flow (`admin/AddRunner`, `admin/RemoveRunner`, `admin/SetAgent`, `admin/RemoveAgent`)
started; each records its change once in `runner_changes` or `agent_changes`. Refusals: `401 authentication`,
`403 forbidden` (not an Admin of the repository by GitHub, no recorded installation, or someone acting for one), `400 invalid`, `413 too_large`,
`503 unavailable`.

## A TODO on an external agent

`todo/Agent` reads the repository's coding agent once per attempt and journals it. With one set, `agent/Session` hands
the TODO to a runner:

- **One agent at a time.** `todo/Agent` reads the coding agent when the attempt starts, so a TODO keeps its agent when
  an Admin names another. To send two TODOs to two agents today, name the first, commit, wait for its claim, then name
  the second. The TODO's pull request body is its prompt, so a repository that asks for results in the pull request
  gets them from the transcript.
- **Waiting for a runner.** Until a runner claims the job, the TODO reads Waiting for a runner (`todos.waiting`,
  decision 0135): `todo/Wait` reports it before the job is queued, and the claim route clears it for every claim and
  reclaim (`TodoSession.claimed`).
- **Claim.** A runner registered for the repository claims the oldest queued job whose profile its configuration has
  and whose labels it carries, while it has fewer jobs than its capacity.
- **Work.** The runner checks the repository out at the attempt's base in a `jj` workspace and runs the agent there
  with its own tools. The prompt is the TODO, its acceptance lines, and instructions to leave the change in the working
  copy uncommitted.
- **Settle.** When the agent's turn ends and it has gone quiet, the runner settles the files it changed: at most 50
  paths and 1 MiB added, the same limits as Smithers' own agent. `todo/Received` checks them (none is
  `empty_change`), and `todo/Publish` makes one App commit and opens the pull request, as for any TODO.

Failures carry a code, never the agent's text: `agent` (it stopped short), `refused` (the profile's `prestart` hook
refused, or the agent refused its login at the first prompt), `workspace`, `too_large`, `timeout`, `machine_lost`,
`exhausted` and `cancelled`. Each fails the TODO `implement`.

## Durability

The whole agent session is one durable step (ruling DUR-9). The engine journals the job's start, each probe, each
generation and the result, never the transcript. Inside the session, the runner keeps the agent's ACP session id beside
the checkout. After a crash of the runner it resumes with `session/load` on the same account, from the last turn the
agent's own session recorded. Nothing outside the runner module knows how.

- **A runner restart.** The runner's job flow (`runner/Job`, on `@smthrs/platform-node` with its own SQLite journal)
  replays. The claim route hands the runner the jobs it still holds, `reclaimed`, with the same claim, so the job keeps
  its place.
- **A runner that stops answering.** A missing heartbeat doesn't prove the agent stopped, so its job keeps reading
  Running until the runner comes back or the agent's hours run out. Nothing fails over to another machine.
- **A retryable end.** A profile maps an agent's limit or exit to `Retryable`. The step starts the next generation,
  pinned to the same runner, whose checkout holds the work so far; the runner's `prestart` hook may pick another
  account. A runner that comes back without the checkout settles `machine_lost`.
- **Stop.** A Member's Stop on the run's page stops the job ([Stop](#stop)); cancelling the run, as dropping its TODO
  does, cancels it too. The runner's next heartbeat says so. It cancels the ACP turn, then ends the agent's whole process
  tree and settles `Cancelled { processTreeGone }`. A run cancelled while `agent/Session` is parked between probes
  stops its job through `@smthrs/flow`'s durable cancellation: the cancelled observation starts `agent/Session/stop` as
  its own run, `cancel:<job key>`, whose one step cancels the job, so the stop reaches the runner although no process
  held the step (decision [0142](../decisions/0142-stop-and-steer-external-agents.md)).

## Steering

A Member steers a TODO's external agent as they steer Smithers' own ([runs](runs.md#steering)): the message is admitted
to the run's notification queue, and the run's page shows it. The runner reaches it, not the agent's step:

```
run page ─ Steer ─▶ POST /api/remote-runs/<run>/steers ─▶ the run's queue (Sent)
runner heartbeat (10 s) ◀── { steers: [{ id, text }] }: the run's pending steers, rendered as Smithers' agent reads them
   the runner hands each over once: _session/steering into the turn in flight, else cancel the turn, then prompt
   the agent's next update ─▶ next heartbeat { delivered: [id] } ─▶ the queue promotes exactly those ids under
   `runner:<job key>:<digest>` ─▶ the run page reads Delivered
```

- **Delivered means read.** The runner reports a steer only once the agent sent an update after it was handed over,
  and the heartbeat route promotes those ids and no others (`DrainInput.ids`, `@smthrs/notifications`). A steer handed
  over before a runner restart and never confirmed stays Sent, then Not delivered when the agent ends; it is never
  handed over twice.
- **Cancel, then prompt** is the fallback every ACP agent takes: an agent that doesn't advertise `_session/steering`
  has its turn cancelled and is prompted with the steer and "Then continue the task." S0 found both coding agents' published
  ACP adapters it probed take `_session/steering`. A runner profile's `steering: "prompt"` uses cancel-then-prompt
  even so, for an agent whose native steering moves its running command to the background and ends its turn.
- **The route** (`worker/runners/Api.ts`) carries steers only while the job holds its claim and isn't asked to stop. A
  steering read that fails hands out none and still renews the lease; the runner reports its deliveries again.
- **Cost.** Each heartbeat of a working job reads its run's pending steers from the engine's journal: about one read
  every 10 s per job.

## Stop

A Member stops a TODO's external agent from the run's page while its `agent/Session` step works
([runs](runs.md#stopping-a-todos-agent)). `POST /api/remote-runs/<run>/stop` (`worker/RemoteRuns.ts`) stops every
open generation of the attempt's job in one statement (`TodoSession.stop`, `Jobs.stop`): a queued or retryable one ends
`cancelled` at once, a claimed one gets `cancel` at its runner's next heartbeat, and a later generation's start finds
its predecessor cancelled and queues nothing. The run is not cancelled: `agent/Session` reads the job `Cancelled` at
its next probe and fails `cancelled`, and `todo/Fail` fails the TODO `stopped`, which keeps its place for Retry.
Nothing reaches GitHub before Publish, so a stopped attempt leaves no branch.

## The runner protocol

Every request carries the runner's token as `Authorization: Bearer`. Schemas: `@smthrs/agent`'s `AgentRunner`.

| Route | Body | Answer |
|---|---|---|
| `POST /api/runners/claim` | `{ profiles, free, running, waitSeconds ≤ 25, machine?, minQueuedSeconds? }` | `{ job }` or `{ job: null }`; a held job not in `running` comes back first, `reclaimed: true`; `403 not_authorized` for a runner not registered by GitHub's role ([decision 0148](../decisions/0148-runner-git-credential.md)) |
| `POST /api/runners/heartbeat` | `{ key, claim, delivered?, account?, cpuSeconds?, usage? }` | `{ held, cancel, leaseSeconds: 45, steers? }`: the job's undelivered steers, `{ id, text }` |
| `POST /api/runners/settle` | `{ key, claim, outcome, delivered? }` | `{ recorded }`; `false` when the claim no longer holds the job. `delivered` records the steers the agent read since the last heartbeat that reported them |
| `POST /api/runners/events` | `{ key, claim, events }` | `{ next }`: the agent's transcript ([transcripts](agent-transcripts.md#the-events-route)) |
| `POST /api/runners/git-credential` | `{ key, claim }` | `{ remote, username, password, expiresAt }`: a read-only token for the runner's own repository while it holds that job ([private repositories](#private-repositories)); `409 not_held`, `403 other_repository`, `403 not_authorized` (needs [registering again](#registering-a-runner-again)), `503 unavailable` with `retry-after` when GitHub can't mint now, `429 busy` with `retry-after`, `404` without the App or a recorded installation |

A claim's `machine` is `{ version?, load1?, diskFreeGb?, held? }`, `held` saying why the runner takes no job by its
own [admission](#admission) rule; a heartbeat's `account` is the label the profile's hook
chose, `cpuSeconds` the agent's process tree's CPU time and `usage` what the agent reported so far, each for the
[fleet](fleet.md). A job is `{ key, claim, generation, task, deadline, leaseSeconds, reclaimed }`; its task is `{ agent, repository, base,
system, prompt, limits }`. An outcome is `Done { changes, summary, usage }`, `Failed { reason }`, `Retryable {
afterSeconds? }` or `Cancelled { processTreeGone }`. Usage an agent doesn't report stays absent, never zero.

## Private repositories

Off in production until the review of decision 0148's fixes passes (`GIT_CREDENTIAL_ON` in `worker/runners/Api.ts`): the route answers `404 not_configured` and a runner fetches as before.

A runner fetches a private repository with a token the host mints for the job it holds ([decision 0148](../decisions/0148-runner-git-credential.md)): the App's installation token for that one repository, `contents: read` only. The host hands one only to a runner an Admin registered by the role GitHub gives on the repository, only where the App's installation is recorded, one mint in flight per job, at most one started every 30 seconds and 3 issued an hour, a failed one waiting 30 seconds or GitHub's own wait, and it checks the hold again as it counts a mint, revoking a token it won't deliver.

The runner asks only when the mirror must clone or fetch the base, while it holds the mirror's lock, and reuses the token for that claim until 10 minutes before its `expiresAt`. A `404` fetches as before (a public repository, or a host without the App); on `429`, `5xx` or no answer the same claim waits the host's wait and tries again until the job's deadline, spending no generation or restart; any other refusal fails `workspace`. The token goes to git in the command's own environment, never on a command line, in a file or a log. That command never runs in the mirror, whose configuration the agent can write: it fetches the token's exact remote into a bare repository under the runner's state directory (`<state>/fetch/<16 hex>.git`), following no link on the way to it or inside it, whose configuration the runner rewrites before each fetch, with no hook, no global or system git file, none of the runner's `GIT_*`, and the `git` on the runner's own `PATH`; the mirror then fetches from it without the token. The agent runs as the runner's user and shares its trust ([decision 0136](../decisions/0136-external-agents-on-runners.md)): decision 0148 lists what this does and doesn't stop.

## Registering a runner again

Migration `0095_runner_reauthorization` (decision 0148) cleared every runner's authorization: before 2026-11-02 the registration route could take the deployment's Admin role instead of the one GitHub gives on the repository, and no earlier registration can be told apart. From that deploy each runner's claims, reclaims, heartbeats, settlements, transcript events, credential requests and work-link posts get `403 not_authorized`, and its token reads no issues list, until an Admin of its repository registers it again. A runner whose repository has no recorded App installation is refused the same way. Its queued jobs wait. A job it holds is suspended: a refused heartbeat (`403`, or `401` after its token was rotated) stops its agent and keeps its checkout, session and unsent transcript, a refused settlement keeps its outcome and asks again, and once the runner is registered again (restarted with the new token, if it was rotated) the job goes on where it stopped. A suspended job still ends at its deadline, on a Stop (which the host tells a runner it refuses, and ends itself), or when the host no longer holds it, which frees its slot. A claim ends the runner's own claimed jobs past their deadline and the five-minute settlement grace (`timeout`) before it hands anything back. A job whose hours run out first ends `timeout`, so register runners again soon after the deploy. The fleet shows the runner `Needs re-registration`, the [audit](#audit) flags it `needs_registration`, and the runner logs on every refused claim:

```
runner.claim outcome=not_authorized hint="this runner needs re-registration: an Admin of its repository registers it again ..."
```

To register it again, keep the runner running and its token as it is:

1. On the runner machine, print the SHA-256 of its existing token (`smthrs runner token` refuses to replace one, and `--rotate` would make a new one):

   ```sh
   printf %s "$(cat ~/.smithers/runner/runner-token)" | shasum -a 256   # the 64 hex before the "-"
   ```

2. An Admin of the repository, in person, sends the same `PUT` as [step 2 of setting it up](#setting-it-up), with the runner's name, that SHA-256, its labels and its capacity. The next claim after the write lands is served.

A machine that posts issue work links with `ops/work-links/link.mjs` ([work links](work-links.md#posting-links-the-client)) posts with a runner's token, so that runner is registered again the same way, with the SHA-256 of the token file the script reads (`--token-file`, `$SMITHERS_WORK_TOKEN_FILE`, else `~/.smithers/runner/runner-token`). Until then each post exits non-zero with `403 not_authorized`.

A repository's Cloudflare overflow runner is registered again by turning the overflow on again with its `PUT` (`/overflow/cloudflare`), which also rotates its token. A runner that an end-to-end run registers is registered on each run, so it needs nothing.

## Audit

`GET /api/runners/audit`, for an Admin of the deployment's own repository acting in person (`403` for anyone else,
an Admin of another repository included), lists every live runner on every repository: `repoId`, `name`, `addedBy`
(the registrant's person id) and `addedByLogin`, `addedAt`, `authorizedAt` (when a registration through the
repository's Admin role authorized it, or null), `labels`, `seenAt`, and its repository's
`installation: { recorded, checkedAt }`. A runner is flagged `needs_registration` where nothing authorized it
([registering a runner again](#registering-a-runner-again)) and `no_installation` where no installation is recorded:
either way it claims nothing until someone acts ([decision 0148](../decisions/0148-runner-git-credential.md)). It never
answers a token or a token's digest.

## Admission

A runner admits jobs by its own machine, never by a host rule ([decision 0144](../decisions/0144-half-load-and-cloudflare-overflow.md)):
it claims only while its load stays under half its CPUs and its disk keeps 40 GB free, both set in its `runner.json`
([CLI reference](../../../../packages/smithers/docs/reference/cli/runner.md#admission)). The claim route stays the
same for every machine and vendor: a held or full runner asks with `free: 0`, the route hands it only a job it holds
and didn't list, and keeps the reason it sent on `runners.held` (migration `0085_runner_held`) for the
[fleet](fleet.md), which shows the runner as **Held · load 31/24**. `capacity` stays the hard cap on jobs at once.

## Overflow

A runner whose `runner.json` sets `minQueuedSeconds` claims only a job that has been claimable that long: one no
attached runner took because each was held or full. A repository's Cloudflare overflow is that runner in a box
([decision 0144](../decisions/0144-half-load-and-cloudflare-overflow.md)):

```
Admin ── PUT /api/repos/<owner>/<name>/overflow/cloudflare { connectionId, profile, argv, labels?, minQueuedSeconds?, capacity? }
           │ Admin in person · their own active api_key connection · SECRETS_KEY · mint the token, seal it
           ▼
         admin/SetOverflow ──▶ runners `cloudflare-overflow` (its SHA-256, labels + cloudflare) + repo_overflow (sealed)

agent/Session probe: queued ≥ minQueuedSeconds, pinned to none, `cloudflare-overflow` unseen 45 s
           ▼ Sandboxes.wake(overflow-<repo>)   (sandbox admission, kind overflow, OVERFLOW_INSTANCE standard-4)
         box: runner.json + runner-token + SMITHERS_MODEL_KEY / _BASE_URL / _PROTOCOL, placeholders only
              smthrs runner serve ── claim, heartbeat, settle ──▶ egress: token → this deployment's host only
              the agent's model calls ──────────────────────────▶ egress: the Admin's key → its base URL's host only
              no job for 300 s: the runner ends, sandbox/Keep finds the box idle and stops it
```

- **Who pays.** The Admin's own BYOK `api_key` connection, named in the setting. Its key never enters the box. A
  subscription can't be named: a plan's login stays on attached runners.
- **The token.** The host mints it and keeps it sealed in `repo_overflow` (migration `0086_repo_overflow`). Each PUT
  rotates it; `DELETE` retires the runner and drops the seal. No person, journal, log or answer sees it.
- **The box.** `profile` and `argv` are what its runner runs, from the image's ACP adapters; `argv` maps
  `SMITHERS_MODEL_KEY`, `SMITHERS_MODEL_BASE_URL` and `SMITHERS_MODEL_PROTOCOL` to what its agent reads. Its runner admits up
  to its CPUs and keeps 5 GB free. It holds no repository secret. Its `smthrs` is the deploy's own build
  (`infra/sandbox/pack-cli.mjs`), so it always matches the host.
- **Refusals.** `401 authentication`, `403 forbidden` (not an Admin in person), `400 invalid` (a body that doesn't
  read, or a connection that isn't the Admin's active key on a model wire), `404 not_found` (anything but
  `cloudflare`), `503 unavailable` (no SECRETS_KEY, or the flow couldn't start).

## Postgres

Migration `0078_agent_runners`:

| Table | What it holds |
|---|---|
| `runners` | `repo_id`, `name`, `labels`, `capacity`, `token_sha256` (never the token), `seen_at`, `removed_at` |
| `agents` | `repo_id`, `name`, `labels`, `profile`, `max_hours`, `restarts`, `coding` (one per repository) |
| `agent_jobs` | one row per generation, `<origin>#g<n>`: its task, `status` (`queued`, `claimed`, `done`, `failed`, `cancelled`, `retryable`), its runner and claim, `pinned_runner`, `not_before`, `deadline_at`, `cancel_requested`, `outcome` |
| `runner_changes`, `agent_changes` | each Admin change once, by invocation key |

Migration `0089_runner_git_credentials` adds `runners.repo_authorized_at` (when a registration through the
repository's Admin role authorized the runner, decision 0148) and `agent_jobs.git_credentials`, `git_credentials_since`
and `git_credential_at`: credentials issued in the hour since the first, and when the last mint started. Its backfill of
`repo_authorized_at` proved nothing, so migration `0095_runner_reauthorization` clears it on every runner
([registering a runner again](#registering-a-runner-again)) and adds `agent_jobs.git_credential_reservation` and
`git_credential_reserved_at` (the one mint in flight, by its request's id), `git_credential_retry_at` (the soonest
the next may start after one failed) and `stopped_claim` (the claim of a job the host ended for a Stop while it
refused the runner, whose heartbeats keep hearing `cancel`) and `claimed_token_sha256` (the token that claimed the job,
so a runner whose token was since rotated or retired still hears a Stop on it).

Migration `0082_agent_transcripts` adds `agent_jobs.first_event_at`, `last_event_at`, `transcript_events` and
`transcript_bytes`, a job's [transcript](agent-transcripts.md) summary; the transcript itself is in the run's
`RunContent` Durable Object.

Nothing here syncs to browsers. The [fleet](fleet.md) projects each job into `agent_runs` (migration `0084_fleet`),
which does, with each runner's machine facts on `runners`.

## Observability

- Spans: `agent.external.{start,status,collect,cancel,abandon}` with the job's key, agent and generation;
  `agent.jobs.{start,status,cancel}`; `runner.{claim,heartbeat,settle}`; `runner.admin`, `runner.admin_request`;
  `todo.agent`, `todo.received`, `todo.stop`, `agent.jobs.stop`; the runner's `runner.steer` log line (mode, outcome,
  duration) and the heartbeat line's `delivered`, `steers` and `steering` (a failed read's code) fields.
- Metrics: `smithers_external_agent_jobs{agent,outcome,reason}`, `smithers_agent_jobs{op,outcome}` (`op` `stop`:
  `stopping` or `ended`),
  `smithers_runner_requests{route,outcome}`, `smithers_runner_admin_requests`, `smithers_runner_admin_writes`.
- Logs carry runner names, job keys, agent names and outcome codes. Never a token, a prompt, a summary, a file, argv,
  environment or an account path (OBS-5).

## Code and tests

- `@smthrs/agent`: `AgentRunner` (the contract), `ExternalAgent` (the step), `Acp` (the client).
- `smthrs runner` (`packages/smithers/src/runner/`): the runner.
- `worker/runners/`: `Store.ts`, `AdminFlows.ts`, `Admin.ts` (Admin routes), `Jobs.ts` (the job store), `Api.ts`
  (runner routes). `worker/flows/TodoSession.ts`: `todo/Agent` and `agent/Session`.
- Overflow: `worker/runners/Overflow.ts`, `worker/secrets/SandboxEgress.ts` `forwardOverflow`, the overflow box in
  `worker/BranchSandboxes.ts`; tests in `worker/runners/Overflow.test.ts` and `TodoRunner.test.ts` "overflow on
  Cloudflare".
- Tests: `packages/smithers/agent/test/{AgentRunner,ExternalAgent,Acp}.test.ts`; `worker/runners/Runners.test.ts`
  (store, routes and Admin writes on Postgres); `worker/runners/TodoRunner.test.ts` (a TODO to a pull request through a
  real `smthrs runner` process and the deterministic ACP test agent, the runner killed mid-job and resumed);
  `e2e/agent-runner.spec.ts` (the same through `alchemy dev` and GitHub).
- Steering and Stop (slice S3): `worker/runners/TodoRunner.test.ts` steers a TODO's agent on a real runner process into
  its pull request and stops one parked in a detached 10-minute command (process gone, TODO `stopped`, nothing on
  GitHub, Retry); `worker/runners/Runners.test.ts` covers a faulty steering store and `Jobs.stop`;
  `e2e/agent-runner.spec.ts` "steers" and "stops" run the same through the browser;
  `packages/smithers/evals/agent-steer-cli.eval.ts` steers and stops real agents through a real runner.
- Private repositories (decision 0148): `worker/runners/GitCredential.ts` and the `git-credential` route in `Api.ts`,
  tested in `worker/runners/GitCredential.test.ts` (holds, registration, caps, races, revocation) and
  `Runners.test.ts` (registration needs GitHub's role and a recorded installation); the runner's side in
  `packages/smithers/src/runner/{Credential,Workspace}.ts`, tested in `packages/smithers/test/RunnerCredential.test.ts`,
  `RunnerWorkspace.test.ts` (a real smart-HTTP server: laziness, tracing, a planted jj `git.executable-path` and hook)
  and `Runner.test.ts` (retryable and refused credentials).
- The agent's transcript, live on the run page: [Transcripts of external agents](agent-transcripts.md).
- The fleet view and its alerts: [fleet.md](fleet.md).
- Not built yet: choosing an agent per TODO, and a Settings page for runners and agents.
