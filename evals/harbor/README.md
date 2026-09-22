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
