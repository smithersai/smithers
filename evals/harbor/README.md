# Harbor and Pier benchmark adapter

The Smithers flows harness as an external agent for [Harbor](https://www.harborframework.com)
(Terminal-Bench 4.0) and [Pier](https://github.com/datacurve-ai/pier) (DeepSWE
1.1). Harbor starts the task's container; `smithers_agent.py` runs OUR harness
on the host, the `smthrs` CLI out of this checkout, with the task instruction
as the flow's whole task and the task container as the only thing its `bash`
flow may touch. Every command reaches the container by `docker exec`, the same
seam the SWE-bench rig uses (`packages/smithers/agent/std/src/Container.ts`).
The model is called from the host, so the container keeps the task's
`no-network` seal.

This is an **operator-run** benchmark. It spends a model seat, needs docker and
the task images, and is not a CI gate. `./verify.sh` is the offline check of the
adapter's own logic and is the only thing here CI runs.

## Layout

| Path                      | What it is                                                             |
| ------------------------- | ---------------------------------------------------------------------- |
| `smithers_agent.py`       | `SmithersAgent`, the Harbor/Pier `BaseAgent` that drives the harness   |
| `plue_env.py`             | `PlueEnvironment` / `PluePierEnvironment`: the task on a Smithers Cloud workspace, public CLI only |
| `plue_docker.py`          | The `docker` the harness calls on Smithers Cloud: `exec` becomes `smithers workspace exec` |
| `accounts.py`             | Round-robin over every logged-in Codex subscription, one per trial     |
| `codex_pool.py`           | Harbor's stock Codex CLI agent drawing its `auth.json` from that pool  |
| `prompt.md`               | The one flow file every task runs; the instruction is pasted verbatim  |
| `verify.sh`               | Offline check: prompt, environment, journal fold, trajectory, names    |
| `fixtures/check_agent.py` | What `verify.sh` runs                                                  |

## Prerequisites

1. Build the CLI: `pnpm --filter @smthrs/cli build`. The adapter refuses to
   run against `src/bin.ts`, for the reason `evals/swebench/flows.sh` gives.
2. Build the atomic filesystem helper the CLI shells out to:
   `cargo +1.98.0 build --release -p smithers-ffi --bin smithers-jj-export`
   (the crate requires rustc 1.98; the repository toolchain file pins 1.89 for
   the wasm artifact). The CLI
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
  -i wal-recovery-ordering -i sound-change-cascade \
  -a evals.harbor.smithers_agent:SmithersAgent -m openai/gpt-6-sol \
  -k 1 -n 1 -o "$PWD/evals/harbor/jobs" --job-name smithers-smoke -y
```

The oracle arm proves the sandbox and the verifier (`--agent oracle`); the
stock Codex CLI arm is `-a codex -m openai/gpt-6-sol` with
`--ae CODEX_FORCE_AUTH_JSON=1` to use the ChatGPT login instead of an API key.
Every task runs at `effort: max` (`prompt.md`), the top of the OpenAI scale
and what the Terminal-Bench leaderboard's Codex entries ran at; the journal's
`model-requested` params say which effort each call was really made at and
`smithers-run.json` folds them into `run.efforts`.

### On Smithers Cloud

Add `-e evals.harbor.plue_env:PlueEnvironment` and the task runs in a plue
workspace through the public `smithers` CLI (`SMITHERS_CLI`, `PLUE_REPO`,
`SMITHERS_TOKEN`; see `plue_env.py`). The harness still speaks `docker exec`:
the adapter puts `plue_docker.py` first on the CLI's PATH as `docker`, and the
workspace id is the container the prompt names. The harness spawns that
`docker` with a least-authority environment (PATH, HOME, USER, LANG, TERM,
TMPDIR, SHELL), so the adapter writes the repository, the CLI's absolute path,
`SMITHERS_TOKEN` and `XDG_CONFIG_HOME` into an owner-only `plue-docker.json`
beside the shim in a per-attempt temporary directory, deleted when the attempt
ends. A create that finds no
capacity waits (`PLUE_CAPACITY_WAIT_SEC`) instead of failing the trial.

Both arms draw one Codex login per trial from `accounts.py`: `~/.codex`
(label `default`) and `~/.smithers/accounts/codex-*` in round robin, state in
`SMITHERS_CODEX_POOL_STATE` shared across runner processes. The label is
recorded per trial (`smithers-run.json` `account`, `codex-account.json` for
the stock arm). The stock arm is
`-a evals.harbor.codex_pool:PooledCodex --ak version=0.155.1 --ak reasoning_effort=max`.

**An infrastructure failure is never a score.** Both agents apply one policy:

- A usage limit (`rate_limited: The usage limit has been reached`,
  `quota_exceeded`, the Codex CLI's "You've hit your usage limit") takes the
  account out of rotation with the reset time the message names, and the
  trial is re-run whole on the next healthy account. Every re-run is in the
  trial's `agent/requeue.log` and in `requeues` of `smithers-run.json` /
  `codex-account.json`; the earlier attempt's log and workspace are kept as
  `*-attempt-N`.
- A route fault (`authentication`, `no_route`, `provider_internal`,
  `transport`, `call_timeout`, `completion_unjudged`, a `rate_limited` the
  harness gave up on) raises `ModelRouteError`, so Harbor records an
  exception and no reward.
- A trial in which no command reached the task container with exit 0
  raises `ContainerUnreachable`: for this adapter, no journalled `bash` call
  naming the container settled with `exitCode` 0; for the stock arm, no
  `command_execution` item in `codex.txt` exited 0. The count is
  `containerCommands` in `smithers-run.json` / `codex-account.json`.
- Run with `-r 2 --retry-include ModelRouteError --retry-include PlueError
  --retry-include ContainerUnreachable` to re-run those trials.
- When no healthy account is left the pool PAUSES: a lease waits
  (`SMITHERS_CODEX_POOL_WAIT_SEC`, default six hours) for a reset or a new
  `codex-*` login, then raises `NoSeatLeft`. `pool.json` carries `paused`.
- The model's own failures (`claim_unproven`, `read_only_cap`, a wrong
  answer) are scored as the verifier says.

The full benchmark drops the `-i` filters and raises `-n`. Use an absolute
`-o`: Harbor resolves a relative jobs directory against the task's `tests/`
directory when it copies artifacts into the verifier container, and the copy
falls back to a slower tar stream.

DeepSWE 1.1 through Pier, one task:

```sh
PYTHONPATH=$PWD pier run -p <deep-swe>/tasks/<task> \
  --agent-import-path evals.harbor.smithers_agent:SmithersAgent \
  -m openai/gpt-6-sol -k 1 -n 1 -o "$PWD/evals/harbor/jobs"
```

DeepSWE grades `git diff <base>..HEAD`, so under Pier the prompt tells the
model to commit and the adapter commits whatever is left afterwards
(`--ak commit=1` does the same under Harbor).

## What a trial records

Under the trial's `agent/` directory:

| File                | Contents                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `smithers-run.json` | seat, auth mode, route bindings off the journal, harness revision, subject fingerprint, wall clock, tokens, exit status, phase |
| `trajectory.json`   | ATIF-v1.8 trajectory folded from the harness journal; Harbor reads the token totals off it   |
| `smithers-run.log`  | the CLI's stdout and stderr                                                                  |
| `workspace/`        | the flow file and `.flows/engine.db`, the journal itself                                     |

Runs on the ChatGPT subscription are subscription-billed: `cost_usd` is left
unset rather than priced. `evals/swebench/prices.ts` carries the API list
price for `gpt-6-sol` ($2 in, $0.20 cached, $10 out per 1M tokens, standard
tier, short context) for the api-key arm; quote it against a subscription run
only as what the tokens would have cost.

## What the smoke showed, and what is not yet right

The 2026-09-22 smoke (oracle, this adapter, and the stock Codex CLI on
`wal-recovery-ordering` and `sound-change-cascade`; this adapter on DeepSWE
`abs-module-cache-flags` through Pier) found two things a reader of
`smithers-run.json` needs to know:

- **The harness judges the host workspace, and the task lives in the
  container.** `mutation-observed` hashes the host working directory, which
  this adapter leaves empty, so every completion is bounced once as an unmoved
  tree and the claim judge then sees "work this run never recorded". The run's
  own status is therefore `failed` (`claim_unproven`) even when the container
  holds the finished work and the verifier rewards it. Grade on the verifier's
  reward, and read `run.status` as the harness's opinion of its own evidence.
  The fix belongs in the harness (a container-scoped tree digest), not here.
- **Jev is mandatory.** The CLI refuses to run without `AI_GATEWAY_API_KEY`,
  and a gateway 503 on the final completion fails the run as
  `completion_unjudged` after the work is done. Export the key before a run;
  a subscription seat does not cover it.

## What the agent never sees

The prompt is `prompt.md` with the instruction, the container id, the working
directory and the seat filled in. The adapter discards the `task_dir` and
`trial_paths` Harbor hands every agent, never reads `tests/` or `solution/`,
and uploads nothing into the container. `fixtures/check_agent.py` pins that
the rendered prompt names none of them.
