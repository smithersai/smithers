# Harbor and Pier benchmark adapter

The Smithers flows harness as an external agent for [Harbor](https://www.harborframework.com)
(Terminal-Bench 4.0) and [Pier](https://github.com/datacurve-ai/pier) (DeepSWE
1.1). Harbor starts the task's container; `smithers_agent.py` runs OUR harness
on the host, the `smthrs` CLI out of this checkout, with the task instruction
as the flow's whole task and the task container as the only thing its `bash`
and file flows may touch. Every command and file operation reaches the
container by `docker exec`, the same seam the SWE-bench rig uses
(`packages/smithers/agent/std/src/Container.ts`). On a local Docker
environment that is the real `docker`. On any other Harbor environment, such
as Runta, the adapter puts a `docker` shim on the CLI's `PATH` that answers
`docker exec` with Harbor's own `environment.exec` (`harbor_exec.py`), so the
same harness runs wherever Harbor can run a command. `--ak transport=docker`
or `--ak transport=harbor` overrides the choice.
The model is called from the host, so the container keeps the task's
`no-network` seal.

This is an **operator-run** benchmark. It spends a model seat, needs docker and
the task images, and is not a CI gate. `./verify.sh` is the offline check of the
adapter's own logic and is the only thing here CI runs.

## Layout

| Path                      | What it is                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `smithers_agent.py`       | `SmithersAgent`, the Harbor/Pier `BaseAgent` that drives the harness                                              |
| `plue_env.py`             | `PlueEnvironment` / `PluePierEnvironment`: the task on a Smithers Cloud workspace, public CLI only                |
| `outcome.py`              | Which finished trials are scored (graded, agent outcome) and which are infra, re-run                              |
| `health.py`, `requeue.py` | Mid-run health rule; move infra trials aside for `harbor jobs resume`                                             |
| `plue_docker.py`          | The `docker` the harness calls on Smithers Cloud: `exec` becomes `smithers workspace exec`                        |
| `accounts.py`             | Round-robin over every logged-in Codex subscription, one per trial                                                |
| `codex_pool.py`           | Harbor's stock Codex CLI agent drawing its `auth.json` from that pool                                             |
| `seal.py`                 | The denied-connect probe and verdict behind the stock arm's `sealed`                                              |
| `harbor_exec.py`          | The `docker` the harness calls on a remote Harbor environment: `exec` becomes `environment.exec`, logged per call |
| `prompt.md`               | The flow file every task runs; the instruction is pasted verbatim                                                 |
| `worker.md`               | The `worker` flow beside it: the task's agent hands a sub-task to a copy of itself with `ctx.call("worker", ...)` |
| `trace.py`                | One trial as frames: tokens, the cell the model wrote, each call with its time and result, what was printed back  |
| `audit_host_calls.py`     | Per-trial audit of calls that ran on the host, not the task container: clean / host-calls-benign / host-calls-unread / TAINTED |
| `report.py`               | The publishable paired report of two finished jobs; refuses an unsealed, unfinished or under-50-task run          |
| `calls.py`                | Every model call of a trial as one row, for either arm: totals by purpose, the time split and the fit             |
| `verify.sh`               | Offline checks for the adapter, containment, ownership, resources and health                                      |
| `fixtures/check_*.py`     | Behavioral fixtures run by `verify.sh`                                                                            |

## Prerequisites

1. Build the CLI: `pnpm --filter @smthrs/cli build`. The adapter refuses to
   run against `src/bin.ts`, for the reason `packages/smithers/agent/harness/benchmarks/swebench/flows.sh` gives.
2. Build the atomic filesystem helper the CLI shells out to:
   `cargo build --release -p smithers-ffi --bin smithers-jj-export`
   (cargo uses the toolchain `rust-toolchain.toml` pins). The CLI
   looks for it at `/usr/local/bin/smithers-jj-export` or
   `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY`; the adapter sets the variable to
   `target/release/smithers-jj-export` when it is there and the variable is not.
3. A seat. For the ChatGPT subscription: `codex login` once, then
   `SMITHERS_OPENAI_AUTH=chatgpt` (the default the adapter picks for an
   `openai` seat). `OPENAI_API_KEY` is removed from the CLI's environment in
   that mode, so a fallback to the API cannot succeed silently.
4. `uv tool install harbor` and, for DeepSWE, `uv tool install datacurve-pier`.
   Both import the adapter by module path, so run them with
   `PYTHONPATH=<this checkout>` from the checkout root.

## Running

Terminal-Bench 4.0, two tasks, one attempt each, one at a time:

```sh
cd <checkout>
PYTHONPATH=$PWD harbor run -d terminal-bench/terminal-bench@4.0.0 \
  -i terminal-bench/wal-recovery-ordering -i terminal-bench/sound-change-cascade \
  -a packages.smithers.agent.harness.benchmarks.harbor.smithers_agent:SmithersAgent -m openai/gpt-6.1-sol \
  -k 1 -n 1 -o "$PWD/packages/smithers/agent/harness/benchmarks/harbor/jobs" --job-name smithers-smoke -y
```

On Runta (`uv tool install "harbor[runta]"`, `runta login`), add
`-e runta --override-storage-mb 32768`: Runta refuses a sandbox under 32 GiB of
disk and Harbor 0.25 asks for 16. Every `environment.exec` there costs about
2.3 s before the command starts, so a trial's wall clock is mostly round
trips; `bridge.jsonl` says how many.

The CLI runs as one process, `smthrs up task`: it plans, approves and runs the
flow without three separate starts. `up` approves only a flow that declares
its `capabilities`, which `prompt.md` and `worker.md` do.

The oracle arm proves the sandbox and the verifier (`--agent oracle`); the
stock Codex CLI arm is
`-a codex -m openai/gpt-6.1-sol --ak reasoning_effort=xhigh` with
`--ae CODEX_FORCE_AUTH_JSON=1` to use the ChatGPT login instead of an API key.

### One effort, one time limit

Two arms are a pair only when both get the same reasoning effort and the same
wall clock.

**Effort.** Both arms run at `xhigh` (`accounts.DEFAULT_EFFORT`, owner ruling
2026-10-10) and take `--ak reasoning_effort=<effort>` for a run at another.
This adapter writes it into the flow's `effort:` frontmatter (`prompt.md`) and
refuses a value the harness does not know, which the harness would run at
`high`. `PooledCodex` passes it to the CLI as `model_reasoning_effort`. Left
alone, Harbor's Codex agent sends no effort and Pier's sends `high`, so name
the effort when you run `-a codex` itself.

Each trial records the effort asked for and the effort every call ran at:

- Smithers arm: `effort` and `run.efforts` in `smithers-run.json`, `effort`
  and `efforts` in the trial's metadata. `efforts` is read off the journal's
  `model-requested` params.
- Codex arm: `reasoningEffort` in `codex-account.json`, `reasoning_effort` and
  `efforts` in the trial's metadata. `efforts` is read off the session's
  `turn_context` events.

**Time.** The runner cancels an agent at the trial's agent timeout:

    min(--agent-timeout or the task's [agent] timeout_sec, max_timeout_sec) * multiplier

The multiplier is `--agent-timeout-multiplier` when set, else
`--timeout-multiplier`. DeepSWE 1.1 tasks declare 5,400 s. Harbor 0.23.0 and
Pier 0.3.1 hand that number to the oracle agent only, so the adapter computes
it from the trial's `config.json` and `[agent] timeout_sec` in the task's
`task.toml`, and gives the CLI 30 s less. `--ak budget_sec=N` sets the
budget outright. There is no default: a trial whose timeout cannot be found
raises `BudgetUnknown` before any model call. The 2026-09-26 runs fell back to
3,600 s here while the stock Codex arm had each task's 5,400 s. When the
runner cancels the agent anyway (its timeout, a job stop), the running CLI
gets SIGTERM, then SIGKILL after 30 s, and the cancellation is re-raised.

`smithers-run.json` and the trial's metadata record the budget (`budgetSec`,
`budget_sec`), its source (`budgetSource`, `budget_source`: `budget_sec`,
`agent_timeout_sec`, `override_timeout_sec` or `task.toml`) and the runner's
timeout (`agentTimeoutSec`, `agent_timeout_sec`). With a runner's interpreter
as `HARBOR_PYTHON`, `fixtures/check_budget.py` compares the rule with that
runner's own function.

### On Smithers Cloud

See [workspace cleanup](docs/cleanup.md) for durable creation receipts and recovery.
See [benchmark health](docs/health.md) for complete trial counts and placement refusals.
See [benchmark publication](docs/publication.md) for the paired report a release publishes.

Add `-e packages.smithers.agent.harness.benchmarks.harbor.plue_env:PlueEnvironment` and the task runs in a plue
workspace through the public `smithers` CLI (`SMITHERS_CLI`, `PLUE_REPO`,
`SMITHERS_TOKEN`; see `plue_env.py`). The harness still speaks `docker exec`:
the adapter puts `plue_docker.py` first on the CLI's PATH as `docker`, and the
workspace id is the container the prompt names. The harness spawns that
`docker` with a least-authority environment (PATH, HOME, USER, LANG, TERM,
TMPDIR, SHELL), so the adapter writes the repository, the CLI's absolute path,
`SMITHERS_TOKEN` and `XDG_CONFIG_HOME` into an owner-only `plue-docker.json`
beside the shim in a per-attempt temporary directory, deleted when the attempt
ends. A `-e SMITHERS_TOKEN` from the harness is refused (exit 125): the
CLI's credential never reaches the task container.
`plue_docker.shim_config` and `shim_directory` write both; the SWE-bench rig's
plue transport (`packages/smithers/agent/harness/benchmarks/swebench/lib/plue.py`, `SWB_TRANSPORT=plue`) runs its
agent through the same shim and its workspaces through `plue_env`.

Waiting for capacity is not building the environment, so it happens before
Harbor's environment-start timer: importing `PlueEnvironment` makes Harbor
await `environment.reserve()` (slot, capacity wait, workspace boot) ahead of
the timed `start()`. A create that finds no capacity waits
(`PLUE_CAPACITY_WAIT_SEC`) instead of failing the trial. Two arms on one host
share `PLUE_SLOTS` first come, first served (a slot is 2 vCPU), and a task
bigger than `PLUE_MAX_CPUS`, or one needing a GPU, raises `PlueUnplaceable`
from `reserve()`, inside the trial. `PLUE_MAX_WORKSPACES` caps running
workspaces at the account plan's concurrent-sandbox limit. Every TB4 task
verifies in a separate workspace: the agent workspace hands its ledger slot
to its own verifier, whose `reserve()` also runs before Harbor's build timer.
A workspace SSH session the gateway lost (`ssh_session_failed`) or OpenSSH's
own exit 255 (`ssh_transport`: connect timeout, remote closed, dead read)
raises `PlueError` instead of passing the command a meaningless status.

A task is untrusted. A Dockerfile-only task is accepted when it is `FROM`,
`COPY` and `RUN chmod` alone: a `COPY` source must resolve, symlinks included,
inside the task's environment directory, and a `chmod` line must be a mode
and plain paths or globs; anything else raises `PlueImageError`. Debug logs
of CLI calls redact `--env` values, and an image's registry token realm must
be https.

No plue failure ends the job: every environment method raises `PlueError`
or a subclass, Harbor's constructor checks are deferred to `reserve()`
(Harbor builds the environment in `Trial.create`, outside the trial's
exception handling), the Trial's own artifact and network-policy refusals
are deferred to `_prepare()`, and `stop()` never raises; a workspace it could
not delete goes to `PLUE_LEAK_LOG`. A task that needs a GPU, more than
`PLUE_MAX_CPUS`, or compose sidecars is `PlueUnplaceable`: a plue workspace
is one guest with no network to other workspaces, and running a sidecar in
it would hand the agent the sidecar's files.

Both arms draw one Codex login per trial from `accounts.py`: `~/.codex`
(label `default`) and `~/.smithers/accounts/codex-*` in round robin, state in
`SMITHERS_CODEX_POOL_STATE` shared across runner processes. The label is
recorded per trial (`smithers-run.json` `account`, `codex-account.json` for
the stock arm). The stock arm is
`-a packages.smithers.agent.harness.benchmarks.harbor.codex_pool:PooledCodex --ak version=0.155.1`.

Harbor and Pier upload `auth.json` as root with mode 0600 and chown it only
when the task names an `[agent] user`. When it names none and the image's
`USER` is not root (TB4 `rs-archive-clone`: `agent`, `risk-scorer-replay`:
`nobody`), `PooledCodex` runs the trial as the uid `id -u` reports, so the
runner chowns the file to the CLI's user. Without that the CLI cannot read
it, falls back to `api.openai.com`, and fails with `AgentAuthenticationError`.

Harbor installs `curl bash nodejs npm ripgrep` all together when any one
command is missing. `PooledCodex` asks the package manager only for the
missing ones, so an image's own Node.js stays: Debian's npm cannot install
beside NodeSource's nodejs (SWE-bench Pro V2 openlibrary), and apt-get's exit
100 ended the trial in setup.

**An infrastructure failure is never a score.** Both agents apply one policy:

- A usage limit (`rate_limited: The usage limit has been reached`,
  `quota_exceeded`, the Codex CLI's "You've hit your usage limit") takes the
  account out of rotation with the reset time the message names (a date, a
  time of day such as "Try again at 9:27 AM.", or "in 3 hours"), or for five
  hours when it names none the pool can read, and raises `SeatExhausted`, an
  infra exception. The attempt already changed the task container and spent
  part of the agent timeout, so it is never re-run in place: the runner
  re-runs the trial in a fresh environment on the next healthy account
  (`--retry-include SeatExhausted`, or `requeue.py`). The stock arm records
  the limit as `usageLimit` and `resetAt` in `codex-account.json`.
  `report.py` refuses a scored trial whose metadata carries `requeues`: older
  harness revisions re-ran it in place.
- A route fault (`authentication`, `no_route`, `provider_internal`,
  `transport`, `completion_unjudged`, a `rate_limited` the
  harness gave up on) raises `ModelRouteError`, so Harbor records an
  exception and no reward.
- A trial in which no command reached the task container with exit 0
  raises `ContainerUnreachable`: for this adapter, no journalled `bash` call
  naming the container settled with `exitCode` 0; for the stock arm, no
  `command_execution` item in `codex.txt` exited 0. The count is
  `containerCommands` in `smithers-run.json` / `codex-account.json`.
- A trial is healthy only when it was graded, or graded after a whitelisted
  agent outcome: `AgentTimeoutError`, or `NonZeroAgentExitCodeError` unless
  Harbor's header says exit 255 and OpenSSH's transport message follows
  (`outcome.py`); a transport line in the agent's own output after any other
  exit code is the agent's, never a re-run. Everything
  else (`VerifierTimeoutError`, `CancelledError`, `PlueError`, start and
  setup timeouts, `ContainerUnreachable`, `ModelRouteError`, an ungraded
  agent outcome) is infrastructure: re-run, never scored. Run with `-r 3` and
  one `--retry-include` per name in `outcome.INFRA_EXCEPTIONS`; after the
  harbor process exits, `requeue.py <job>` moves the remaining infra and
  unfinished trials to `<job>.infra/` and `harbor jobs resume -p <job>`
  re-runs them. `health.py` trips when infra is over 20% of a job's trials
  finished in the last hour. `PlueUnplaceable` is neither retried nor
  scored: the guest cannot fit this cluster.
- When no healthy account is left the pool PAUSES: a lease waits
  (`SMITHERS_CODEX_POOL_WAIT_SEC`, default six hours) for a reset or a new
  `codex-*` login, then raises `NoSeatLeft`. `pool.json` carries `paused`.
  Each update replaces `pool.json` by rename, so a killed runner leaves the
  previous state whole. A `pool.json` that is not a JSON object raises
  `PoolStateUnreadable` instead of re-admitting every disabled account.
- The model's own failures (`claim_unproven`, `read_only_cap`, a wrong
  answer) are scored as the verifier says. So is `call_timeout`: the
  harness's per-call ceiling (`modelCallMs`, 1,800 s at `xhigh` and `max`)
  is the arm's own limit.

The full benchmark drops the `-i` filters and raises `-n`. Use an absolute
`-o`: Harbor resolves a relative jobs directory against the task's `tests/`
directory when it copies artifacts into the verifier container, and the copy
falls back to a slower tar stream.

With `-d`, a `-i` filter takes the registry's full task name
(`terminal-bench/<task>`), and a bare name matches nothing. With `-p`, it
takes the bare task directory name (`rs-archive-clone`).

DeepSWE 1.1 runs through Pier, not Harbor: on Smithers Cloud, Harbor's
`PlueEnvironment` refuses DeepSWE's agent-phase network policy. Download the
tasks once, then pass one task directory, or the dataset directory for all 113
(Pier keeps only the last `-p`):

```sh
harbor dataset download datacurve/deep-swe-1-1 -o <deep-swe>
PYTHONPATH=$PWD pier run -p <deep-swe>/deep-swe-1-1/<task> \
  --environment-import-path packages.smithers.agent.harness.benchmarks.harbor.plue_env:PluePierEnvironment \
  --agent-import-path packages.smithers.agent.harness.benchmarks.harbor.smithers_agent:SmithersAgent \
  -m openai/gpt-6.1-sol -k 1 -n 1 -o "$PWD/packages/smithers/agent/harness/benchmarks/harbor/jobs"
```

DeepSWE grades `git diff <base>..HEAD`, so under Pier the prompt tells the
model to commit and the adapter commits whatever is left afterwards
(`--ak commit=1` does the same under Harbor).

### The network seal under Pier

Every DeepSWE task declares `[agent] network_mode = "no-network"`. Pier 0.3.1
asks the agent for `network_allowlist()` and builds the task container's
network from the answer (`pier/environments/docker/docker.py`):

```
allowlist empty      main: network_mode none        only `lo`, no route
allowlist non-empty  main -- pier-egress-internal (internal: true) -- pier-egress-proxy -- default -- internet
                             squid: CONNECT to an allowlisted name on 443 with the trial's token, else 403
```

- **Smithers arm.** `SmithersAgent.network_allowlist()` is empty: the model is
  called from the host, and the container is on `network none`.
- **Stock Codex arm.** The CLI runs in the container and must reach its model.
  Pier's own `codex` agent allows `api.openai.com`, the API-key route, which a
  ChatGPT login never uses. `PooledCodex` hands Pier `seal.ALLOWED_HOSTS`
  and nothing else:

  | Host              | Why (Codex CLI `rust-v0.155.1`)                                                                  |
  | ----------------- | ------------------------------------------------------------------------------------------------ |
  | `chatgpt.com`     | Model backend, `chatgpt.com/backend-api/codex` (`CHATGPT_CODEX_BASE_URL`, `model-provider-info`) |
  | `auth.openai.com` | Token refresh, `auth.openai.com/oauth/token` (`REFRESH_TOKEN_URL`, `login/src/auth/manager.rs`)  |

The stock arm, sealed, with one login per trial from the pool, at the effort
the Smithers arm runs at (`xhigh` unless `--ak reasoning_effort` names
another):

```sh
PYTHONPATH=$PWD pier run -p <deep-swe>/deep-swe-1-1 \
  --agent-import-path packages.smithers.agent.harness.benchmarks.harbor.codex_pool:PooledCodex -m openai/gpt-6.1-sol \
  --ak version=0.155.1 \
  --ak 'config_toml=web_search = "disabled"' \
  -k 1 -n 1 -o "$PWD/packages/smithers/agent/harness/benchmarks/harbor/jobs"
```

`web_search = "disabled"` is part of the seal. The CLI runs with
`--dangerously-bypass-approvals-and-sandbox`, and in that mode `rust-v0.155.1`
prefers live web search unless the config disables it
(`resolve_web_search_mode_for_turn`, `core/src/config/mod.rs`). The model
backend runs the search, so no container network stops it.

**The proof, per trial.** Before the CLI starts, `PooledCodex` runs
`seal.script()` in the task container with the environment the CLI's commands
get. curl tries `github.com` through the proxy, then `github.com` and `1.1.1.1`
around it. `sealed` is true only when every one was refused (curl exit 5, 6,
7, 35, 56 or 97) and the CLI's transcript has no `web_search` item. Exit 35
is Harbor's docker egress control: its transparent proxy reads the SNI and
cuts the handshake to a host off the allowlist. A connection,
a missing curl, a timeout or a missing line reads `sealed: false` with the
`reason`. The verdict and every attempt are in `agent/codex-account.json`
(`sealed`, `seal`) and in `result.json` under `agent_result.metadata`.

**When the seal applies.** The seal matters only on a task that denies the
agent network. Do not score a `sealed: false` trial of such a task. On a
public task, `sealed: false` is the suite's protocol: both arms' containers
reach the internet, so the arms stay equal. Both runners resolve the agent's
network the same way: `[agent] network_mode`, else `[environment]
network_mode`, else the legacy `allow_internet` (absent: public).

| Suite                   | Agent network                                                     | Seal required |
| ----------------------- | ----------------------------------------------------------------- | ------------- |
| Terminal-Bench 4.0      | public: no `network_mode` declared                                | no            |
| DeepSWE 1.1 (Pier)      | `[agent] network_mode = "no-network"`                             | yes           |
| SWE-bench Pro V2        | `[environment]` public for setup, `[agent]` `no-network`          | yes           |

`report.py` applies this rule. It reads `task.toml` at the `task.path` each
trial's config records, and it refuses an unsealed stock trial when that
task denies the agent network, or when its `task.toml` cannot be read. Under
Harbor, the stock arm on a network-denied task needs its model route:
`--allow-agent-host chatgpt.com --allow-agent-host auth.openai.com`. The
report accepts those two hosts as extra agent hosts on the stock arm and
refuses any other host. Each report states the agent network of its tasks.

The report does not trust a stored `sealed`. It judges the seal again from the
probe attempts the trial saved, by the current `seal.py` rules, so a verdict
stored before a rule changed is corrected: nyc-01's trials stored
`sealed: false` on curl 35 before #3863. Missing or unreadable attempts, a
missing count of web searches, or any web search still unseal the trial. The
report counts, per arm, the trials whose verdict changed
(`sealVerdictsChanged`).

Rootless Docker needs nothing extra: the internal network and the proxy live
in the daemon's own network namespace. Start the runner inside the daemon's
user namespace, or `docker compose cp` fails with an `Lchown` error.

`fixtures/check_seal.py` pins the verdict, runs the script with a real curl
against a local proxy, and, with Pier's interpreter as `HARBOR_PYTHON`, pins
the allowlist `PooledCodex` hands Pier.

## What a trial records

Under the trial's `agent/` directory:

| File                | Contents                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `smithers-run.json` | seat, auth mode, route bindings off the journal, harness revision, subject fingerprint, wall clock, tokens, exit status, phase |
| `trajectory.json`   | ATIF-v1.8 trajectory folded from the harness journal; Harbor reads the token totals off it                                     |
| `smithers-run.log`  | the CLI's stdout and stderr                                                                                                    |
| `workspace/`        | the flow files and `.flows/control.db`, the journal itself                                                                     |
| `bridge.jsonl`      | `harbor` transport only: one line per remote exec with its time, exit status, byte counts and argv head; no stdin, no env values |

The trajectory holds one step for each model call the agent made. A frame
whose reply held no runnable cell asks the model again, so it is two steps,
the first marked `extra.rejected`. Every model call of the run, the judge's
included, is a row of `extra.calls`.

Runs on the ChatGPT subscription are subscription-billed: `cost_usd` is left
unset rather than priced. `packages/smithers/agent/harness/benchmarks/swebench/prices.ts` carries the API list
price for `gpt-6-sol` ($2 in, $0.20 cached, $10 out per 1M tokens, standard
tier, short context) for the api-key arm; quote it against a subscription run
only as what the tokens would have cost.

### Read what the agent did

```sh
python3 -B trace.py <trial dir>            # every frame, clipped
python3 -B trace.py <trial dir> --frame 3  # one frame
python3 -B trace.py <trial dir> --full --html trial.html
```

The trace opens with the run's totals and one row per frame, then a "Look
here first" list: frames that made one call and did not complete, a call
repeated with the same input, failed calls, non-zero exits and large prints.
Each frame then shows what the model read, the cell it wrote, every call with
its input, time and result, and what the cell printed back. A `worker` call
shows its child run under it, one line per child frame, and the child's
tokens are in the totals.

### Where time and tokens went

`calls.py` folds a trial's record into one row per model call, the same row
for both arms, and prints them:

```sh
python3 -B packages/smithers/agent/harness/benchmarks/harbor/calls.py <trial-dir>... [--json]
```

| Field                                         | Meaning                                                             |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `purpose`                                     | What the call was for; see the next table                           |
| `start`, `end`, `durationMs`                  | When the call ran, UTC, and its whole milliseconds                  |
| `inputTokens`, `cachedTokens`, `outputTokens` | The provider's counts                                               |
| `thinkingTokens`, `writtenTokens`             | Output split into reasoning and everything else                     |
| `totalTokens`                                 | Input + output                                                      |
| `settled`                                     | `false` when the record holds no settle for the call                |
| `frame`, `attempt`, `reask`, `rejected`       | Smithers arm: the call's frame, and why a frame asked again         |
| `retries`, `retried`, `tries`                 | Smithers arm: retry notices, each failed try, and transport tries   |
| `stages`                                      | When the harness saw the stream reach each stage, when recorded     |
| `timing`                                      | The same for the wire, when recorded                                |
| `work`                                        | Smithers arm: what the reply's cell amounted to                     |
| `costUsd`                                     | The call's cost as the journal priced it                            |
| `triggers`, `compact`, `compactSuppressed`    | A supervisor reading: what it fired and the compaction it handed on |
| `derived`                                     | The fields computed from other records, not read as such            |

`stages` and `timing` count whole milliseconds from the call's start. `stages`
holds `firstEventMs`, `firstThinkingMs`, `firstOutputMs` and `lastOutputMs`;
`timing` adds `preparedMs`, `signedMs`, `sentMs`, `headersMs`, `completedMs`
and `closedMs`. `retried` holds each failed try's `code`, `delayMillis`,
`elapsedMs` and `httpStatus`. `work` is `kind` (`calls`, `no_call`,
`comment_only`, `threw`, `rejected`), `calls` and `callMs`.

`derived` names `durationMs` when it is the time between two events,
`totalTokens` when it is the ledger's spend, `writtenTokens` when it is output
minus reasoning, and `purpose` when it follows from the event's kind. A
journal since #3844 records the first three on its own settles, so they are
read and not named. A judge reading's purpose always follows from the event
that settled it; the ledger names the same purposes.

| Purpose      | The call                                                             |
| ------------ | -------------------------------------------------------------------- |
| `frame`      | The agent's own call. Every Codex request is one                     |
| `compaction` | A compaction summary call                                            |
| `judge`      | A supervisor reading                                                 |
| `marks`      | A compaction-marks reading                                           |
| `claim`      | A completion check                                                   |
| `relevance`  | The reading that picks context before frame 0                        |
| `reading`    | An evaluator reading the agent's own cell asked for (the `jev` flow) |

- **Smithers arm.** The adapter folds the journal into the rows and writes
  them to `extra.calls` of `trajectory.json`. A reader folds the kept journal
  again, so a trial recorded by an older adapter gains what the fold has since
  learned to read. Without the journal it reads the trajectory's rows, else
  the trajectory's steps, which hold the agent's own calls only.
- **Codex arm.** The rows are read from `agent/sessions/**/rollout-*.jsonl`. A
  request starts at the previous tool output, or the user's message, and ends
  at its `token_usage_record`. The session's effort, summary setting and CLI
  version come from `turn_context` and `session_meta`; no id in the log is
  copied. `timing.firstItemMs` is when the log shows the reply's first item, a
  message's start or a reasoning block's end: an upper bound on the wait
  before the first token.

What each total includes:

| Total                                                                                       | Includes                                                                                             |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `n_input_tokens`, `n_cache_tokens`, `n_output_tokens`; `final_metrics.total_*`; `run.usage` | The agent's own calls (`frame`) only, as before, so they compare with earlier reports                |
| Weighted tokens                                                                             | Uncached input + 0.1 x cached input + 8 x output of those same calls                                 |
| `byPurpose`                                                                                 | Calls, tokens and milliseconds for each purpose                                                      |
| `allPurposes`                                                                               | Every purpose summed: the run's total                                                                |
| `ledgerTokens`, `ledgerEntries`                                                             | The harness's own count of every spend (`flows.agent.usage.v1`); it equals `allPurposes.totalTokens` |
| `ledgerByPurpose`                                                                           | That ledger's tokens and cost under each purpose it names; null for a ledger that names none         |

`byPurpose`, `allPurposes`, the three ledger fields, `time` and `compactions`
are in `run` of `smithers-run.json` and in `final_metrics.extra` of the
trajectory. A difference between the ledger and the rows, in all or under one
purpose, is a spend no row lists. A call with no token figure at all is
counted in `tokenless` and is in no total.

`compactions` is one record per compaction: when it ended, the frame it ran
ahead of, `durationMs`, `causes`, `marks`, `context` before and after, and
whether it made a summary call. A compaction's summary call is settled on
`compaction-settled`, not on a `model-settled`. A journal from before that
(#3844) leaves the call unsettled: its row's time is the time to
`compaction-settled`, and its tokens are the ledger's one sum
(`unsplitTokens`), with no input, cached or output count.

`time` splits the record's span, first event to last: `modelMs`,
`compactionMs`, `commandsMs`, `judgeMs` and `otherMs` sum to `spanMs`.

- A journal since #3844 times each frame itself (`turn-closed.time`). Those
  parts are taken as recorded: the frame's model calls, its compaction, the
  time its cell ran (`commandsMs`), and what the loop waited on the judge.
  `recordedMs` is how much of the span those clocks cover.
- Outside them, and in an older journal or a Codex session log, a second is
  counted once, for the first of these that was running: the agent's own
  model call, a compaction call, a command, a judge reading.
- `derived` names the parts that hold any time counted the second way.

A judge reading that ran beside a model call is model wait either way, and
`judgeMs` is the time the judge held the run. Every reading's own latency is
`durationMs` in `byPurpose`. `wallSec` is longer than the span by the CLI's
own start and exit.

The wait before a reply began is read, over the agent's own calls, from the
closest stage the rows record: the wire's `timing.firstEventMs`, else the
first event the harness saw (`stages.firstEventMs`), else the Codex log's
`timing.firstItemMs`. The report names which and gives the median and the
least. The Codex stage bounds each call's wait from above, so its least is the
closest reading. `stageMedians` is the median offset of every stage the rows
record, the harness's `stages` apart from the wire's `timing`.

The fit is least squares of call seconds on thinking and written tokens over
the agent's own settled calls:

    seconds = fixedSeconds + thinkingTokens x msPerThinkingToken / 1000 + writtenTokens x msPerWrittenToken / 1000

Fewer than four calls, or counts that move together, have no fit.

The stage fit (`stageFit`) splits a call on the wire's own `timing`:
`meanHeadersMs`, the mean wait for the response headers, then two lines by
least squares, each needing three calls:

    firstOutputMs - headersMs     = thinking.fixedMs + thinkingTokens x thinking.msPerThinkingToken
    lastOutputMs  - firstOutputMs = written.fixedMs  + writtenTokens  x written.msPerWrittenToken

A journal from before the wire was timed has none. Nor has the Codex arm: its
session log has no first-token time, so its whole-call fit stands alone and
`stageFitUnavailable` says why.

`cellWork` counts the agent's own calls by what their cell did, with their
time and tokens, where the journal records it.

`report.py` writes all of this for both arms, over every paired task and for
each one, to `report.md` and to `comparison` in `report.json`. A refused
report carries it too; it carries no pass rate.

## What the smoke showed, and what is not yet right

The 2026-09-22 smoke (oracle, this adapter, and the stock Codex CLI on
`wal-recovery-ordering` and `sound-change-cascade`; this adapter on DeepSWE
`abs-module-cache-flags` through Pier) found two things a reader of
`smithers-run.json` needs to know:

- **The claim brake refused true container claims.** The harness does see
  container edits: a `bash` call into the container reports `mutated`, which
  counts as a remote mutation, and Jev was sent `treeMoved: true`. What it
  lacked was the checks' output, and it read long, specific claims as a whole.
  The 2026-09-26 Luna smoke ended two of four runs `claim_unproven` at 0.91
  and 0.87 with the work on the record. The brake now lists each check with the
  tail of its output and reads a long claim one sentence at a time; replayed,
  those claims read at most 0.71 and 0.73 and a fabricated sentence 0.94 and
  0.92. Grade on the verifier's reward all the same, and read `run.status` as
  the harness's opinion of its own evidence.
- **Nobody answers an `ask`.** The adapter runs the CLI with
  `SMITHERS_ASKS=refuse`, so an in-run `ask` fails at once with
  `ApprovalUnavailable` and the model decides without it; `smithers-run.json`
  records `asks` and `run.asksRefused`. A run that still ends at a
  `waiting-*` status raises `RunParked`, which `outcome.py` counts as infra.
  Before this, luna-A-smoke2 `mp-checkpoint` asked at frame 46 and waited at
  `waiting-approval` until its hour ran out.
- **Jev is mandatory.** Without `AI_GATEWAY_API_KEY` the CLI judges on a
  subscription seat (Claude Haiku or GPT-6 Luna), which is not comparable, so
  `SmithersAgent.setup()` refuses the trial before any model call. A run that
  still ends `unconfigured`, or `completion_unjudged` after a gateway 503 on
  the final completion, is infrastructure and never a score. Export the key
  before a run.

## What the agent never sees

The prompt is `prompt.md` with the instruction, the container id, the working
directory, the seat and the effort filled in. The adapter discards the
`task_dir` and `trial_paths` Harbor hands every agent, never reads `tests/` or
`solution/`, and uploads nothing into the container. `fixtures/check_agent.py`
pins that the rendered prompt names none of them.

The adapter reads one value from the task directory: `[agent] timeout_sec` in
`task.toml`, for the budget. It opens no other file there and lists no
directory, the number never reaches the prompt, and with `--ak budget_sec` or
a trial `--agent-timeout` it does not open `task.toml` either.
`fixtures/check_budget.py` pins this with an audit hook around a real `run()`.
