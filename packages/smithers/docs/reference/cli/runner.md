---
title: "Runner commands"
description: "Run a host's external agent jobs on your own machine: the runner token, runner.json, and how a job runs, stops and resumes."
---

A runner is a machine you attach to a Smithers host so a named external agent
can do a step's work there. The runner pulls: it claims jobs over HTTPS, so it
needs no inbound address. Each job runs the agent your `runner.json` maps the
job's profile to, speaking the [Agent Client Protocol](https://agentclientprotocol.com)
(ACP) on its stdio, in a jj checkout of the job's repository at the job's base
commit. The runner settles the files the agent changed.

| Command | Purpose |
| --- | --- |
| `smthrs runner token [--state <dir>] [--rotate]` | Make the runner's token and print its SHA-256 |
| `smthrs runner serve --config <runner.json>` | Claim and run jobs until stopped |

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
| `origin` | The host. `https`, or `http` on `localhost` only. |
| `name` | The name the admin registered. |
| `capacity` | Jobs run at once; 4 unless set, 64 at most. |
| `stateDir` | Token, journal (`engine.db`), checkouts (`work/`) and transcript spools (`spool/`); `~/.smithers/runner` unless set. |
| `heartbeatSeconds` | How often a running job's claim is renewed; 10 unless set. |
| `pollSeconds` | The wait after a claim that found nothing; 2 unless set. |
| `admission` | When the machine takes another job (see [Admission](#admission)): `loadPerCpu` (0.5 unless set), `diskFloorGb` (40 unless set), `jobLoad` (1 unless set). |
| `repositories` | Each repository the host may name, by the host's repository id, mapped to a local jj repository the runner checks out from. The runner fetches it when a job's base commit is missing. |
| `profiles` | What each profile runs. The host only ever passes a profile's name. |

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
  checkout holds earlier work. A reclaimed job whose checkout is gone fails
  `machine_lost`; nothing fails over to another machine.
- **Deadline.** At the job's deadline the runner stops the agent and fails
  `timeout`.

## Records

Logs carry job keys, generations, outcome codes, account labels and durations:
`runner.serve`, `runner.claim`, `runner.heartbeat`, `runner.session`, `runner.steer`, `runner.quiet`, `runner.tree`,
`runner.settle`, `runner.events`, `runner.transcript` and `runner.job`. They
never carry a prompt, the agent's text,
a command line, an environment or a path.
