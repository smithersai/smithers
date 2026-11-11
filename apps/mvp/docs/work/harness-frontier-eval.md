---
title: Smithers harness on the frontier-harness-eval benchmark
status: in-progress
area: sdk
owner: Fable lead session 2eeda18e (since 2026-11-10)
updated: 2026-11-11
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
- The 19 tasks with limits from 20 minutes to 2 hours are running
  (`smithers-mid-batch-1`). The 17 eight-hour tasks have not run.
- The Codex CLI and Claude Code arms have not run. They run inside the
  sandbox, so they upload a subscription login to Runta; that waits on Will.

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

## Open

- In 39 of 168 frames the model wrote more than one `cell` block, repeating
  the first in 6 and only printing again in 10. All blocks run as one
  program, so 14 calls ran twice. It is 6% of the visible output.
- `console.log(result)` prints the whole result object as JSON, with
  bookkeeping fields and escaped newlines.
- Rule 5's `git status` guard fails in a directory that is not a repository,
  and in a container with no `git`.
- A provider content refusal ends the run.
- The harness runs on the host and pays Runta's 2.3 s for each exec; an
  agent installed in the sandbox does not.
- The scores above are from the build before the batched file flows and the
  `worker` flow. Rerun the failures on the landed build.

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
