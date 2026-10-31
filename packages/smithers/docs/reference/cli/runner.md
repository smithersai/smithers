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
   SHA-256. It refuses to replace a token unless you pass `--rotate`.
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
| `stateDir` | Token, journal (`engine.db`) and checkouts (`work/`); `~/.smithers/runner` unless set. |
| `heartbeatSeconds` | How often a running job's claim is renewed; 10 unless set. |
| `pollSeconds` | The wait after a claim that found nothing; 2 unless set. |
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

Which agents, logins and accounts a machine has is your own configuration. The
host knows a profile only by its name.

## How a job runs

Each claimed job is a durable flow, `runner/Job`, on the runner's journal:

1. **Work.** The job's checkout is a jj workspace of the repository's mirror at
   the base commit, under `work/`, shared by every generation of the step, so
   a later generation continues the earlier one's work. The runner runs
   `prestart`, starts the agent in the checkout, opens an ACP session and
   prompts it with the job's instructions and task. After the turn ends it
   waits until the agent has been quiet for 5 seconds (at most a minute), stops
   the agent's process tree, and reads the change: each added or modified
   file whole, and each deleted path. A change over the job's limits fails
   `too_large`.
2. **Settle.** The runner reports the outcome, fenced by its claim, retrying
   while the host can't be reached. A final outcome then forgets the checkout;
   a retryable one keeps it for the next generation.

The summary the runner reports is the agent's last message, at most 4 KiB,
scrubbed of known secret values, API key and bearer shapes, GitHub tokens,
JWTs and email addresses. Usage is the agent's last `usage_update`; an agent
that reports no cost leaves it out.

## Stop, loss and restart

- **Stop.** A heartbeat that says `cancel` sends `session/cancel`, waits up to
  30 s for the turn to end, then signals every process the agent started
  (`SIGINT`, then `SIGKILL` after 15 s), detached ones included: the runner
  watches the agent's descendants by pid and start time while it runs. The
  job settles `Cancelled` with `processTreeGone` true only when none is left.
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
`runner.serve`, `runner.claim`, `runner.heartbeat`, `runner.session`,
`runner.settle` and `runner.job`. They never carry a prompt, the agent's text,
a command line, an environment or a path.
