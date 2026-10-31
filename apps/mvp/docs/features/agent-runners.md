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

1. On the runner machine, make its token. Only its SHA-256 leaves the machine:

   ```sh
   smthrs runner token            # prints the token's SHA-256; the token stays in ~/.smithers/runner/runner-token (0600)
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

4. Write `runner.json` on the machine and start the runner. The [CLI reference](../../../../packages/smithers/docs/reference/cli/runner.md)
   describes every field: the origin, the runner's name, its capacity, each repository's local `jj` mirror, and each
   profile's `argv`, `env`, `prestart` hook and `secretEnv`.

   ```sh
   smthrs runner serve --config runner.json
   ```

Each answer is `202` once the flow (`admin/AddRunner`, `admin/RemoveRunner`, `admin/SetAgent`, `admin/RemoveAgent`)
started; each records its change once in `runner_changes` or `agent_changes`. Refusals: `401 authentication`,
`403 forbidden` (not an Admin of the repository, or someone acting for one), `400 invalid`, `413 too_large`,
`503 unavailable`.

## A TODO on an external agent

`todo/Agent` reads the repository's coding agent once per attempt and journals it. With one set, `agent/Session` hands
the TODO to a runner:

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
- **Stop.** Cancelling the run cancels the job; the runner's next heartbeat says so. It cancels the ACP turn, then ends
  the agent's whole process tree and settles `Cancelled { processTreeGone }`.

## The runner protocol

Every request carries the runner's token as `Authorization: Bearer`. Schemas: `@smthrs/agent`'s `AgentRunner`.

| Route | Body | Answer |
|---|---|---|
| `POST /api/runners/claim` | `{ profiles, free, running, waitSeconds ≤ 25 }` | `{ job }` or `{ job: null }`; a held job not in `running` comes back first, `reclaimed: true` |
| `POST /api/runners/heartbeat` | `{ key, claim }` | `{ held, cancel, leaseSeconds: 45 }` |
| `POST /api/runners/settle` | `{ key, claim, outcome }` | `{ recorded }`; `false` when the claim no longer holds the job |

A job is `{ key, claim, generation, task, deadline, leaseSeconds, reclaimed }`; its task is `{ agent, repository, base,
system, prompt, limits }`. An outcome is `Done { changes, summary, usage }`, `Failed { reason }`, `Retryable {
afterSeconds? }` or `Cancelled { processTreeGone }`. Usage an agent doesn't report stays absent, never zero.

## Postgres

Migration `0078_agent_runners`:

| Table | What it holds |
|---|---|
| `runners` | `repo_id`, `name`, `labels`, `capacity`, `token_sha256` (never the token), `seen_at`, `removed_at` |
| `agents` | `repo_id`, `name`, `labels`, `profile`, `max_hours`, `restarts`, `coding` (one per repository) |
| `agent_jobs` | one row per generation, `<origin>#g<n>`: its task, `status` (`queued`, `claimed`, `done`, `failed`, `cancelled`, `retryable`), its runner and claim, `pinned_runner`, `not_before`, `deadline_at`, `cancel_requested`, `outcome` |
| `runner_changes`, `agent_changes` | each Admin change once, by invocation key |

Nothing here syncs to browsers yet; the fleet view (slice S5) reads them.

## Observability

- Spans: `agent.external.{start,status,collect,cancel,abandon}` with the job's key, agent and generation;
  `agent.jobs.{start,status,cancel}`; `runner.{claim,heartbeat,settle}`; `runner.admin`, `runner.admin_request`;
  `todo.agent`, `todo.received`.
- Metrics: `smithers_external_agent_jobs{agent,outcome,reason}`, `smithers_agent_jobs{op,outcome}`,
  `smithers_runner_requests{route,outcome}`, `smithers_runner_admin_requests`, `smithers_runner_admin_writes`.
- Logs carry runner names, job keys, agent names and outcome codes. Never a token, a prompt, a summary, a file, argv,
  environment or an account path (OBS-5).

## Code and tests

- `@smthrs/agent`: `AgentRunner` (the contract), `ExternalAgent` (the step), `Acp` (the client).
- `smthrs runner` (`packages/smithers/src/runner/`): the runner.
- `worker/runners/`: `Store.ts`, `AdminFlows.ts`, `Admin.ts` (Admin routes), `Jobs.ts` (the job store), `Api.ts`
  (runner routes). `worker/flows/TodoSession.ts`: `todo/Agent` and `agent/Session`.
- Tests: `packages/smithers/agent/test/{AgentRunner,ExternalAgent,Acp}.test.ts`; `worker/runners/Runners.test.ts`
  (store, routes and Admin writes on Postgres); `worker/runners/TodoRunner.test.ts` (a TODO to a pull request through a
  real `smthrs runner` process and the deterministic ACP test agent, the runner killed mid-job and resumed);
  `e2e/agent-runner.spec.ts` (the same through `alchemy dev` and GitHub).
- Not built yet: the transcript (S2), Stop and steering on the run page (S3), the fleet view and alerts (S5), choosing
  an agent per TODO, and a Settings page for runners and agents.
