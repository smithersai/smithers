---
title: "Runner commands"
description: "Run a host's external agent jobs on your own machine, or coding-agent lanes with the runner as its own host: the runner token, runner.json, and how a job runs, stops and resumes."
---

A runner is a machine you attach to a Smithers host so a named external agent
can do a step's work there. The runner pulls: it claims jobs over HTTPS, so it
needs no inbound address. Each job runs the agent your `runner.json` maps the
job's profile to, speaking the [Agent Client Protocol](https://agentclientprotocol.com)
(ACP) on its stdio, in a jj checkout of the job's repository at the job's base
commit. The runner settles the files the agent changed. A `runner.json` with
no `origin` makes the runner its own host, for [local lanes](#local-lanes).

| Command | Purpose |
| --- | --- |
| `smthrs runner token [--state <dir>] [--rotate]` | Make the runner's token and print its SHA-256 |
| `smthrs runner serve --config <runner.json>` | Claim and run jobs until stopped; with no `origin`, also host the lanes |
| `smthrs runner start <brief> --config <runner.json> --profile <p> --repository <id> [--base <rev>] [--standing] [--max-hours <n>] [--restarts <n>] [--workstream <w> --task <t> [--title <text>]]` | Queue a lane for a runner that is its own host, and print the request's id |
| `smthrs runner status --config <runner.json>` | Show each [workstream](#workstreams)'s tasks, the lanes on them and its progress, read from the lanes' runs |

## Register a runner

1. On the runner, run `smthrs runner token`. It writes 32 random bytes as
   base64url to `<state>/runner-token` (mode `0600`; the state directory is
   `~/.smithers/runner` unless `--state` says) and prints only the token's
   SHA-256, as `sha256: <hex>`, or as JSON with `--format json`. It refuses to
   replace a token unless you pass `--rotate`.
2. An admin registers the runner on the host by its name, that SHA-256, its
   machine labels and its capacity. The token itself never leaves the runner
   except as the bearer of its own requests.
3. Write `runner.json` and run `smthrs runner serve --config runner.json`
   under a service manager that restarts it.

A runner the host refuses `403 not_authorized` logs that it needs
re-registration: no registration through its repository's Admin role
authorized it. An admin registers it again with the same SHA-256, which
`printf %s "$(cat <state>/runner-token)" | shasum -a 256` prints without
replacing the token. While refused, a job the runner holds is suspended: a
refused heartbeat stops its agent and keeps its checkout, session checkpoint
and unsent transcript, and the runner beats on; the first heartbeat taken
again resumes the session, after a restart with a rotated token too. A `401`
counts the same as a `403`; only a heartbeat that says the claim no longer
holds ends the job. A suspended job still ends at its deadline, on a Stop
(a refused heartbeat that says `cancel: true`: the host ended the job), or
when the host no longer holds it. A refused settlement keeps the outcome
and asks again, 1 s doubling to a minute, for at most 10 minutes past the
job's deadline.

## runner.json

```json
{
  "origin": "https://smithers.example",
  "name": "build-01",
  "capacity": 4,
  "admission": { "loadPerCpu": 0.5, "diskFloorGb": 40 },
  "repositories": {
    "github/acme/app": { "mirror": "/srv/mirrors/app" }
  },
  "profiles": {
    "my-agent": {
      "argv": ["my-agent", "--acp"],
      "env": { "MY_AGENT_MODEL": "large" },
      "prestart": ["/usr/local/bin/pick-account"],
      "secretEnv": ["MY_AGENT_KEY"],
      "retryOn": ["refusal", "error"],
      "permission": "allow"
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `origin` | The host. `https`, or `http` on `localhost` only. Absent: the runner is its own host, and needs no token ([local lanes](#local-lanes)). |
| `lanes` | With no `origin`: `root`, the project whose control store holds the lanes' runs; the state directory unless set. |
| `name` | The name the admin registered. |
| `capacity` | Jobs run at once; 4 unless set, 64 at most. |
| `stateDir` | Token, journal (`engine.db`), checkouts (`work/`) and transcript spools (`spool/`); `~/.smithers/runner` unless set. |
| `heartbeatSeconds` | How often a running job's claim is renewed; 10 unless set. |
| `pollSeconds` | The wait after a claim that found nothing; 2 unless set. |
| `admission` | When the machine takes another job (see [Admission](#admission)): `loadPerCpu` (0.5 unless set), `diskFloorGb` (40 unless set), `jobLoad` (1 unless set). |
| `minQueuedSeconds` | For an overflow runner: take only a job that has waited this long, so the runners that ask without it take each job first. Unset on attached runners. |
| `idleExitSeconds` | End `serve` after this many seconds with no job, so an overflow box sleeps; never unless set. |
| `repositories` | Each repository the host may name, by the host's repository id, mapped to a local jj repository the runner checks out from. The runner fetches it when a job's base commit is missing. |
| `profiles` | What each profile runs. The host only ever passes a profile's name. |
| `workstreams` | With no `origin`: the plans the lanes work toward, by id ([workstreams](#workstreams)). |

A profile:

| Field | Meaning |
| --- | --- |
| `argv` | The agent's command line. It must speak ACP on stdio. |
| `env` | Variables added to the runner's own environment for the agent. |
| `prestart` | A command run (at most 60 s) in the checkout before each new generation. Each `NAME=VALUE` line it prints joins the agent's environment, and an `account=<label>` line names the account it chose; the runner logs only the label. A non-zero exit refuses the job (`refused`). Use it to pick among logins or accounts on the machine. |
| `secretEnv` | Variables whose values are scrubbed from anything the runner uploads. `prestart`'s variables are always scrubbed. |
| `retryOn` | Ends that settle `Retryable` instead of failing: `refusal` (the agent's stop reason), `exit` (the agent exited mid-turn) and `error` (an error answer to a request, which is how an agent reports a missing login or a usage limit). The host then queues another generation on this runner, up to the agent's restarts. |
| `permission` | How the agent's permission requests are answered: `allow` (the default) or `reject`. |
| `steering` | How a steer reaches the agent: `native` (the default) hands it to the turn in flight over `_session/steering` when the agent advertises it; `prompt` always cancels the turn and prompts with it, for an agent whose native steering moves its running command to the background and ends its turn. |

Which agents, logins and accounts a machine has is your own configuration. The
host knows a profile only by its name.

An agent with a sandbox of its own may refuse `jj` in the checkout, because a
workspace's store lives in the mirror, outside the checkout. The job still
works: the runner reads the change itself. A prompt shouldn't depend on the
agent running `jj`.

## How a job runs

Each claimed job is a durable flow, `runner/Job`, on the runner's journal:

1. **Work.** The job's checkout is a jj workspace of the repository's mirror at
   the base commit, under `work/`, shared by every generation of the step, so
   a later generation continues the earlier one's work. The runner runs
   `prestart`, starts the agent in the checkout, opens an ACP session and
   prompts it with the job's instructions and task. After the turn ends it
   waits until the agent has been quiet for 5 seconds (at most a minute),
   logging `runner.quiet` with how long it waited, then stops the agent's
   process tree, and reads the change: each added or modified
   file whole, and each deleted path. A change over the job's limits fails
   `too_large`.
2. **Settle.** The runner reports the outcome, fenced by its claim, retrying
   while the host can't be reached. A final outcome then forgets the checkout;
   a retryable one keeps it for the next generation.
3. **Transcript.** Beside the settlement, never before it, the runner writes
   the session's end to the job's transcript and sends whatever the host
   doesn't have yet, retrying for up to a day, then deletes the spool.

## Transcript

While the agent works, the runner sends its `session/update` stream to the host
at `POST /api/runners/events` (`@smthrs/agent`'s `Transcript`), so a person can
watch it:

- Each update becomes one or more events numbered from 0 within the job's
  generation. The agent's slash commands and configuration options are
  dropped; every string is scrubbed as the summary is; an event is at most
  16 KiB, so a long message is split and any other long string cut. The runner
  adds `_smithers/turn` with each turn's stop reason, `_smithers/steer` with
  each message's id and mode as it hands it to the agent, `_smithers/cancel`
  when the host stops the job, and `_smithers/end` with the outcome.
- Each event is written to `spool/<key hash>.jsonl` (`0600`) before it is
  sent, and sent at most once a second in requests of at most 64 KiB, at once
  again while a full request waits. The host answers the next number it lacks;
  the runner sends again from there, so an outage of the host costs nothing
  but time. A job's spool holds at most 64 MiB.
- After a restart the runner sends its spool again. The history an agent
  replays when it loads a session is not sent twice.

The summary the runner reports is the agent's last message, at most 4 KiB,
scrubbed of known secret values, API key and bearer shapes, GitHub tokens,
JWTs and email addresses. Usage is the agent's last `usage_update`; an agent
that reports no cost leaves it out.

## Steering

A heartbeat's answer carries the messages people sent the job's agent that it
hasn't read yet. The runner hands each one over once, in order:

- **Into the turn in flight** over ACP's `_session/steering`, when the agent's
  `initialize` advertised it and the profile's `steering` isn't `prompt` (`_meta.steering.supported`), as the published ACP
  adapters of two coding agents do.
- **Cancel, then prompt.** An agent without it, or one that didn't take the
  steer, has its turn cancelled (up to 30 s for it to end), then gets a prompt
  with the steer and "Then continue the task.": the only way every ACP agent
  takes a message.
- **As the next turn.** A steer that arrives after the turn ended, before the
  change is collected, starts the next turn the same way.

The agent read a steer once it sends its next update after it; the runner then
lists the steer as `delivered` on every heartbeat until the host stops handing it
out, and on the settlement, so a job that ends between two heartbeats still
reports it. The session checkpoint keeps a ledger of every steer, `handed` before it is
sent and `delivered` once read, carried from one generation to the next, so a
steer is never handed over twice: one handed over before a restart and never
confirmed stays unconfirmed. Each hand-over logs `runner.steer` with the steer's
id, its `mode` (`steering`, `cancel_prompt` or `prompt`) and how long it took;
never its words.

## Admission

The runner, not the host, decides whether its machine takes another job. It
claims only while both hold:

- its state directory's disk has at least `diskFloorGb` free (40 GB unless set);
- its load is under `loadPerCpu` of its CPUs (half unless set: 24 on a
  48-core host).

The load it compares is the one-minute load average smoothed over 30 seconds,
so one spike neither holds nor frees the machine, plus `jobLoad` for each job
it claimed in the last two minutes, fading as that job's own load has time to
show. Ten queued jobs on a host at 0.49 of its CPUs land one at a time, not
all at once. A fact the machine can't read holds nothing.

A runner that holds back, or is full, still asks the host every
`pollSeconds`, with no room: its machine row stays current, a job it holds but
didn't list comes back, and the claim says why it holds back, as
`held: "load 31/24"` or `held: "disk 31G/40G"`. Each change of reason logs
`runner.admission`. Running jobs are never stopped for load.

```
estimate = smoothed load1 + jobLoad x (1 - age / 120 s), for each claim younger than 120 s
claim     while estimate < loadPerCpu x CPUs  and  free disk >= diskFloorGb
```

## What the host sees

Each claim also says what the machine is like: the runner's version, the
one-minute load average, the free disk where its checkouts live, and why it
holds back, while it does. Each
heartbeat says how the job runs: the account label `prestart` printed, the
CPU seconds the agent's whole process tree has used (a process that exited
keeps the time it had used), and the usage the agent reported so far. Each is
optional, and a label that isn't written as a profile is (a path, say) is left
out. A host shows them in its fleet view, and its stall alert reads the CPU
time, so a quiet build isn't mistaken for a stuck agent.

## Stop, loss and restart

- **Stop.** A heartbeat that says `cancel` sends `session/cancel`, waits up to
  30 s for the turn to end, then signals every process the agent started
  (`SIGINT`, then `SIGKILL` after 5 s), detached ones included: the runner
  watches the agent's descendants by pid and start time while it runs. The
  job settles `Cancelled` with `processTreeGone` true only when none is left;
  a process table the runner couldn't read never counts as none left. Each
  stop logs `runner.tree` with how many processes it saw, signalled and
  killed, whether any was left, and how many table reads failed.
- **Lost claim.** A heartbeat that says the claim no longer holds the job stops
  the agent the same way and settles nothing.
- **Unreachable host.** The runner keeps working and keeps beating; a missing
  answer doesn't prove the claim is gone.
- **Restart.** A runner that restarts lists no running jobs, so the host hands
  back the claims it still holds. Each one's `runner/Job` resumes from the
  journal, and its session resumes from the checkpoint beside the checkout:
  same account, `session/load` of the agent's own session, then a prompt to
  continue. An agent that can't load a session gets a fresh one told that the
  checkout holds earlier work. A checkout whose `<checkout>.provisioning`
  mark says it was still being made is incomplete: it is discarded and made
  again within the same controlled attempt (a Stop, the claim lost or the
  deadline ends it too), unless `<state>/started/<checkout>` is there too,
  when it is kept. A job that ended frees its slot at once: its checkout's
  removal is written to `<state>/removals/` and done by the serve loop,
  every 2 s and after a restart, each try bounded to 5 minutes. A removal
  is done only when `jj workspace forget` succeeded, or the mirror no longer
  lists the workspace, and its directory is gone; otherwise it stays owed.
  The directory is deleted by `rm -rf` in a process group of its own, killed
  whole when the try is cut short, so a large checkout never stalls the
  runner's other jobs.
  A failed provisioning keeps the mark until the settlement forgets the
  checkout. A reclaimed job whose checkout is gone fails `machine_lost` only
  when `<state>/started/<checkout>` or its session checkpoint says an agent
  was to run in it; otherwise no agent ran, and the checkout is made.
  Nothing fails over to another machine.
- **Credential not issued now.** A private repository's fetch whose read
  credential the host can't issue now (`429`, `5xx`, no answer) waits on the
  same claim, the host's wait or 15 s doubling to 5 minutes, and tries again
  until the deadline: no generation or restart is spent.
- **Deadline.** At the job's deadline the runner stops the agent and fails
  `timeout`.

## Local lanes

A `runner.json` with no `origin` makes the runner its own host. `serve` then
runs one process holding three things: a job store of its own under the state
directory, the claim loop above, which claims from that store, and a control
host for the lanes root (`lanes.root`, the state directory unless set). A lane
is a control run of the `lane` module; each of its rounds is one external
agent step whose job the runner itself claims and works.

```
smthrs runner start brief.md --config runner.json --profile p --repository r
  └─ <state>/lanes/<id>.json ─────────────── waits there while serve is down
smthrs runner serve --config runner.json
  ├─ admits it: plan, approve, run (key runner-lane:<id>) ── a run in `runs list`
  │    runner/Lane round ── runner/Lane/Session step ── <state>/jobs/<job>.json
  └─ claim loop: claims the job, runner/Job does it in a checkout, settles it
       one-shot: the run completes with the step's result
       standing: runner/Lane/Base fetches the mirror and resolves --base again,
                 then the next round starts from it, same brief, same run
```

- **Start.** `runner start` checks the profile, the repository and the brief
  file, resolves `--base` with jj in the repository's mirror (its `main`
  unless set) to a commit, and writes the request whole under
  `<state>/lanes/`. It prints the request's id; once `serve` admits it, the
  run's id is in `<state>/lanes/admitted/<id>.json`. A standing lane follows
  the revision `--base` names: before each next round the runner fetches the
  mirror from all its remotes and resolves that revision again, so a lane
  that runs for weeks works on the current tree; a revision that then names
  no single commit keeps the last base. Each round's agent has
  `--max-hours` (4 unless set) and `--restarts` (1 unless set), and its change
  may hold at most 1,000 files and 16 MiB.
- **Admission.** `serve` admits each request every `pollSeconds`, after a
  restart too, and deletes it. A daemon stopped at any step admits it again
  from where it was, as the same run. A request that doesn't decode, or that
  control refuses, is renamed `<id>.json.rejected`.
- **Watch.** `smthrs runs list|show|logs --root <lanes root>` reads a lane's
  run. While its agent works the run reads `parked` between its step's probes,
  or `running`. The agent's transcript is appended to
  `<state>/transcripts/<job>.jsonl`, one event per line, once each.
- **Steer.** `smthrs runs steer <run> --message <text> --root <lanes root>`
  reaches the agent at the runner's next heartbeat, as [Steering](#steering)
  says, and the run then has no steer pending.
- **Stop.** `smthrs runs cancel <run> --root <lanes root>` cancels the run
  (its receipt exits 130). Once the run reads `cancelled`, after its step's
  next probe, its open job is cancelled: the runner stops the agent's whole
  process tree at its next heartbeat and removes the checkout. A standing
  lane ends only this way, or when a round fails.
- **Restart.** A daemon killed or stopped mid-job resumes the lane with no
  `runs resume`: the control host takes the run back, the store hands the
  claim back `reclaimed`, and the session resumes from its checkpoint. The
  job is done once.

The job store keeps each job as one JSON file under `<state>/jobs/`, written
to a temporary file and renamed, so a kill leaves the last whole write. It
has the hosted store's rules: a cancel before a job starts wins, a job past
its agent's hours ends `timeout`, and a retryable end past its restarts ends
`exhausted`. A file that doesn't decode is logged and left; nothing claims
its job. One `serve` owns a state directory.

## Workstreams

A workstream groups lanes under one goal. You declare its plan once, in
`runner.json`; `runner status` reads everything else from the lanes' runs, so
no agent writes a status file and nothing goes stale.

```json
{
  "workstreams": {
    "parser-port": {
      "title": "Parser port",
      "goal": "The new parser replaces the old one.",
      "criteria": ["The old parser's tests pass on the new one"],
      "tasks": [
        { "id": "lexer", "title": "Port the lexer", "criteria": ["lexer tests pass"] },
        { "id": "docs", "title": "Document the parser" }
      ]
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| key | The workstream's id: lowercase letters, digits and `-`, up to 64 characters. `runner.json` with any other key is refused. |
| `title` | What the workstream is called. |
| `goal` | One sentence: what done looks like. |
| `criteria` | Checkable statements that are true when it is done. |
| `tasks` | The tasks planned for it, in order: `id` (as a workstream id, once per workstream), `title`, `criteria`. |

`runner start --workstream <w> --task <t>` makes the lane an owner of task
`t` of workstream `w`. The workstream must be declared; the task need not be:
a task the plan doesn't list joins it with `--title` as its title, or its id.

```
smthrs runner start lexer.md --config runner.json --profile claude --repository app \
  --workstream parser-port --task lexer
smthrs runner status --config runner.json
Parser port (parser-port)  active  0/2 tasks
  goal: The new parser replaces the old one.
  doing   Port the lexer (lexer)  9f3c… claude parked
  todo    Document the parser (docs)  no lane
```

`runner status` reads the requests still queued, the admitted lanes and each
lane's run on the lanes root; `--format json` prints the same as
`{ "workstreams": [...] }`, each with `status`, `progress`
(`{ done, total, unit: "tasks" }`) and `tasks`, each task with `status` and
`owners` (the request, the run once admitted, the profile, whether it is
standing, and the lane's status: `queued`, the run's status, or `missing`
when the lanes root no longer holds the run).

| Task status | When |
| --- | --- |
| `done` | One of its lanes' runs completed. |
| `doing` | One of its lanes' runs is `accepted`, `running` or `parked`. |
| `blocked` | One waits for an approval, or its last lane failed. |
| `todo` | Otherwise: no lane, a lane still queued, or the last one cancelled. |

A workstream is `done` when it has tasks and every one is done, `active` while
any task is `doing`, `blocked` when tasks are blocked and none is `doing`, and
`idle` otherwise. A standing lane never completes, so its task stays `doing`
until it is cancelled. A lane naming a workstream `runner.json` no longer
declares still shows, under the workstream's id.

## Records

Logs carry job keys, generations, outcome codes, account labels and durations:
`runner.serve`, `runner.claim`, `runner.heartbeat`, `runner.session`, `runner.steer`, `runner.quiet`, `runner.tree`,
`runner.settle`, `runner.events`, `runner.transcript`, `runner.job`, and, for
local lanes, `runner.lane` and `runner.jobs`. They
never carry a prompt, the agent's text,
a command line, an environment or a path.
