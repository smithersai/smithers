---
title: Smithers harness on the frontier-harness-eval benchmark
status: blocked
area: sdk
owner: Fable lead session 2eeda18e (since 2026-11-10)
updated: 2026-11-12
links: [benchmarks.md, harness-completion-calibration.md]
---

## What

Run the Smithers cell harness on `frontier-harness-eval/frontier-harness-eval@v1.1.0`
(62 Terminal-Bench tasks, Harbor 0.25, Runta sandboxes), read every trial's
trace, and fix what the traces show. Then run the stock Codex CLI and Claude
Code on the same tasks, each on its own model, with Smithers beside each on
that same model.

## Why

Will, 2026-11-10: the harness "should theoretically perform better than other
agents because we have a very simple codemode": a little smarter, cheaper in
tokens and cheaper in turns. No hacky fixes that make the agent less
composable (an automatic review step is the named example), and no
overfitting to the benchmark.

## State

- Oracle: passed, reward 1.0. Runta refuses a sandbox under 32 GiB of disk and
  Harbor 0.25 asks for 16, so every run adds `--override-storage-mb 32768`.
- **First score, 2026-11-11 02:32 PST:** the 26 tasks with a 15-minute limit,
  `gpt-6.1-sol` at `xhigh`, four at a time: **24 of 26 passed** in 58m 55s.
  168 frames (6.5 a task), 2.47M input tokens (80% cached), 240K output
  (138K reasoning). Model time was 66% of wall clock.
- The two failures:
  - `make-doom-for-mips`: ran out of its 15 minutes while building a cross
    toolchain. 111 remote execs, each with Runta's 2.3 s floor.
  - `vulnerable-secret`: the provider stopped the stream with "This content
    was flagged for possible cybersecurity risk". The harness recorded it as
    `unknown`; it is now `content_policy`. A second run was refused the same
    way at the same frame (`smithers-vulnsecret-2`), so on this seat the task
    fails at the provider, whichever harness asks. The stock Codex arm on the
    same login will show whether that holds for it.
- **Second batch, 2026-11-11 04:15 PST:** the 19 tasks with limits from 20
  minutes to 2 hours: **17 of 19 passed** in 1h 35m (`smithers-mid-batch-1`).
  223 frames, 6.58M input tokens (91% cached), 322K output. No frame wrote a
  second `cell` block. So far 41 of 45.
  - `filter-js-from-html`: the filter imports `html5lib`, which the verifier's
    Python does not have. 14 of 226 trials on the public board pass this task.
  - `schemelike-metacircular-eval`: 60 of 63 interpreter tests. Two `bash`
    calls hit their ten-minute limit and returned none of the progress lines
    the script had printed, so 20 of the run's 38 minutes taught the model
    nothing. Most harnesses on the board pass this task (141 of 183).
- **Third batch, 2026-11-11 06:13 PST:** the 17 tasks with an eight-hour
  limit, on the build landed that morning: **4 of 17 passed** in 1h 51m
  (`smithers-long-batch-1`). One of the 13 is a verifier timeout
  (`mvcc-lsm-compaction`: the tests did not finish in 900 s). Every harness
  on the public board that has run nine or more of these tasks passes 25% to
  33% of them.
- **All 62 tasks, one attempt each: 45 passed (72.6%)**: 24 of 26, 17 of 19,
  4 of 17. The first two batches ran on the build before the batched file
  flows and the `worker` flow.
- The long tasks ended in 5 to 27 minutes of an eight-hour limit. The model
  declared each done; no run was cut off. Whether more of the limit would
  have been used well is not known. Passing trials on the board take a
  median 30 to 96 minutes on the five long tasks we failed that the board
  passes more than once, on slower models.
- **Second attempt at the 17 failures, 2026-11-11 07:07 to 09:28 PST**, on
  the build with the timeout fix (`smithers-failures-rerun-1` and `-2`). It is
  a second attempt, so it is not added to the 45:
  - 3 now pass: `schemelike-metacircular-eval`, `batched-eval-parity`,
    `vpp-loss-divergence`. None of the three hit a time limit this time, so
    they show run-to-run variance, not the fix.
  - 10 fail again: `make-doom-for-mips`, `vulnerable-secret`,
    `filter-js-from-html`, `foodstuff-beta-activity`, `freecad-impeller`,
    `glycan-ms2-elucidation`, `bun-sourcemap-leak`, `cargo-flight-dispatch`,
    `gsea-proteomics`, `music-harmony`. The board passes seven of these in
    under 7% of trials and has no trial of two (`foodstuff-beta-activity`,
    `music-harmony`). It passes `vulnerable-secret` in 98%; ours is the
    provider's refusal.
  - `mvcc-lsm-compaction` is a real failure behind its verifier timeout.
    Run on this Mac against the solution the agent left, the hidden suite
    fails 4 of 15 tests (the prepared-version publication cases) and takes
    441 s, 187 s of it in one interleaving test. On Runta the reference
    solution passes all 15 in 728 s of the verifier's 900 (`oracle-mvcc-1`),
    so a slower solution runs out before pytest reports.
  - 4 have no verdict: `mvcc-lsm-compaction` (verifier timeout again),
    `ontology-kg-querying` (Runta answered HTTP 525 after the agent
    finished), `intrastat-meldung` and `roy-polymorph-cn` (the Codex seat
    reached its weekly limit).
  - The first pass lost ten trials to Docker Hub: Runta's image pulls were
    answered 429 Too Many Requests from 07:38 PST. Three of them had already
    run the agent and lost the verifier image. Pulls worked again by 08:06.
- **Paused, 2026-11-12 01:10 PST.** Will: "lets pause benchmarks for now dont
  worry about it". Both runs below were stopped part-way and their sandboxes
  removed. Start none without his word; the questions about a Kimi key and
  about logins in the sandbox are withdrawn.
  - `smithers-all-2` (all 62 tasks again, build `2ee6ec6b`, `gpt-6.1-sol` on
    `codex-6`): 17 scored, 13 passed. Failed: `vulnerable-secret` (refused
    again), `filter-js-from-html`, `embedding-drift-monitor` and
    `kv-store-grpc`; the last two passed on the first attempt. OpenAI refused
    `model-extraction-relu-logits` on its first frame, a task that passed
    before. 4 trials were cancelled mid-task and 40 never started.
  - `smithers-claude-short-1` (the 26 short tasks on Claude Opus 5.5, through
    the signed-in Claude Code seat, `-m claude-code/opus` with
    `CLAUDE_CONFIG_DIR`): 17 scored, 15 passed, `vulnerable-secret` among
    them. Both failures ran out of the 15 minutes: `make-doom-for-mips`, and
    `adaptive-rejection-sampler`, where one model turn ran for 13 minutes and
    never returned. 2 trials were cancelled mid-task and 7 never started.
  - The same 17 short tasks on `gpt-6.1-sol`'s first attempt
    (`smithers-15min-batch-1`): each model passed 15. Opus took 107 frames,
    2.12M input tokens, 228K output and 2,279 s of model time; `gpt-6.1-sol`
    took 103 frames, 1.53M input, 154K output and 4,238 s. Opus's visible
    replies were about a quarter of its output tokens; the rest was thinking.
- The Codex CLI and Claude Code arms have not run.

## The public board measures other models

`https://frontierharness.org/live/` (data: `/api/summary`, `/api/live`) scores
21 harnesses on five open-weight models served by Baseten at effort `max`,
four attempts a task: GLM-5.3, GLM-5.3-Flash, DeepSeek-V4.1-Flash, Muse Spark
Open and Kimi-K3. No GPT or Claude model is on it, so the 24 of 26 above is
not a place on that board. Read on 2026-11-11, on the same 26 short tasks:

| Harness on Kimi-K3 | Passed | Median input tokens |
| --- | --- | --- |
| alma | 97.3% | |
| codex 0.164.0 | 91.5% | 134K |
| pi | 90.9% | 49.5K |
| claude-code 2.1.308 | 85.5% | |

Codex leads four of the five models over all 62 tasks. Almost every harness
times out on `make-doom-for-mips` (3 passes in about 197 trials) and almost
every one passes `vulnerable-secret` (227 of 232), so our refusal there is
`gpt-6.1-sol` on the ChatGPT route, not the task. A like-for-like number
needs Smithers on one of the five models; Kimi-K3 is first.

## What the traces showed, and the fix for each

| Finding | Fix |
| --- | --- |
| The adapter spoke only to a local Docker daemon | `harbor_exec.py`: a `docker` shim that answers `docker exec` with Harbor's `environment.exec` |
| A `bash` call cost three remote execs (fingerprint, command, fingerprint) | One exec measures the tree around the command (`TreeFingerprint.around`) |
| The CLI started three times (`plan`, `approve`, `run`) | One `smthrs up` process |
| The model retyped the container and directory on every command | A sealed `bash` call that names no container runs in the sealed one |
| The catalog printed each flow's input as JSON Schema | A compact type (`schemaSignature.ts`); first prompt 6,700 to 5,350 tokens |
| Every run was told "no branch, tag, stash or reflog here holds a later fix" | Stated only where the host declares it (`SMITHERS_CHECKOUT_NO_LATER_COMMITS=1`, set by the SWE-bench rig) |
| A script could not call the agent itself | Markdown children on the native host; the adapter ships a `worker` flow |
| File flows made one remote exec per filesystem method: 523 execs, about 1,260 s of the batch's 9,896 s | A host that batches (`Read.Batched`) answers a whole snapshot or commit in one exec: `read` 6.4 s to 2.9, `edit` 32.9 to 5.5, `apply_patch` 24.8 to 5.6, `write` 30.5 to 5.2, `ls` 9.8 to 2.6 on Runta (`diag-tools-2`) |
| A `bash` call that hit its time limit returned none of its output, and in a container the command kept running | The failure carries the output (`error.output`); the container enforces the deadline in the same exec and stops the command's process group |
| `shell_command` and `test` also answered a time limit with no output | `shell_command` prints it after Codex's `command timed out after` line; `test` carries the end of each stream as `error.output` (`2ee6ec6b`) |
| A `claude-code:` seat reported no reasoning tokens while thinking at `xhigh` | The seat reads `output_tokens_details.thinking_tokens` off the turn's result (`66b7feaf`) |
| A patch of several files failed on a BusyBox guest: its `head -c` reads past the bytes it keeps | Several writes are cut from standard input spooled once; pinned against real Alpine |

## Open

- In 39 of 168 frames the model wrote more than one `cell` block, repeating
  the first in 6 and only printing again in 10. All blocks run as one
  program, so 14 calls ran twice. It is 6% of the visible output.
- `console.log(result)` prints the whole result object as JSON, with
  bookkeeping fields and escaped newlines. Measured on the long batch and
  the first rerun: 13% of printed characters are whole result objects, and
  the bookkeeping fields are about 1% of what is printed. Not worth a change.
- Rule 5's `git status` guard fails in a directory that is not a repository,
  and in a container with no `git`: 48 of the 62 tasks. It cut an `&&` chain
  short in 4 of 1,143 calls. Not worth a change.
- A provider content refusal ends the run. One on the first frame, before
  any command, is recorded as `ContainerUnreachable` (no verdict); its cause
  is in the trial's `metadata.cause`.
- A `claude-code:` seat hands over a turn only when it ends, so a long turn
  and a hung one look the same until the budget kills the run. Claude Code
  can stream the turn (`includePartialMessages`) and reports API retries;
  the seat reads neither. Opus's output cap there is 128,000 tokens, about
  23 minutes at the 93 tokens a second measured.
- The run is never told its time limit. `adaptive-rejection-sampler` took
  `gpt-6.1-sol` 862 s of 900 and timed Opus out.
- A seat disabled with no reset time re-enters the pool after its cool-off
  and costs one trial each time while its weekly limit lasts.
- The harness runs on the host and pays Runta's 2.3 s for each exec; an
  agent installed in the sandbox does not.
- One attempt a task is noisy: 3 of 13 failures passed on a second attempt.
  The board uses four attempts.
- Hypothesis, not tested: on the long tasks the agent finishes at its first
  green check. Rules 7 to 9 teach one proof, "failed before, passes after",
  in the fewest frames. Five long failures passed the agent's own check and
  failed a wider hidden one (`mvcc-lsm-compaction`, `vpp-loss-divergence`,
  `batched-eval-parity`, `roy-polymorph-cn`, and `schemelike` at 60 of 63).
  A rule that asks for the neighbouring cases of a fix would cost frames on
  easy tasks, so it needs both this benchmark at several attempts a task and
  the SWE-bench rig before it lands.
- Smithers on a Claude model needs no upload: the CLI's `claude-code:opus`
  seat runs the user's signed-in Claude Code from the host
  (`-m claude-code/opus` with `CLAUDE_CONFIG_DIR`). Not run: on 2026-11-11
  one Claude account outside the lead's had weekly capacity left.
- A like-for-like place on the board needs Smithers on one of its models
  (Kimi-K3 first). Which key to use is Will's call.

## Review

Codex Astra reviewed the first three commits and found 11 defects; all are
fixed with tests in `ac6ece15`, `4c15c04c` and `3291d6bd`: a child flow could
widen its caller's authority three ways (pattern admission, the `authorize`
hook, and services it was meant to lose), two concurrent batched commits
could lose an edit, a path ending in a newline was redirected, a foreign-owned
file could not be written, the adapter ignored child runs, and the compact
catalog type could drop a constraint. Fable then read the fix diffs (the deadline wrapper,
the batched commit script, the lock handling, exec capture and capability
admission), ran the wrapper in real Alpine and Debian containers, and found
no further defect.

## Reds on `main` this work did not cause (2026-11-11, base `7df5839aef01`)

Each fails the same way with `main`'s sources swapped in, or names only files
this work does not touch.

- A child `node` cannot load `.vibe` (`ERR_UNKNOWN_FILE_EXTENSION`):
  `agent/model` example 15, `agent` `ModelStep` (three process cases),
  `QuickstartExample`, `StepTrace`, `StepTraceCalls`.
- `agent` `Fault.sweep`: `JournalDecodeError` and `Intake/Unscreened` have no
  registered class.
- `agent` `ModelRetriesOnEngine`: the restart case counts 3 calls, not 2.
- `flows/sandbox`: `HttpSandbox` chunking, `SandboxJob` (this Mac's `git`
  guard) and `SandboxTools` (60 s timeout).

## How to run and read a trial

`packages/smithers/agent/harness/benchmarks/harbor/README.md`: the Runta
command, `trace.py`, and what a trial records.
