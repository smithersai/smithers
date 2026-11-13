# The Smithers agent eval suite

An offline, deterministic evaluation of **our** agent: the loop in
`@smthrs/agent`, reached through its public API. It replaces the removed
`evals/orchestrator` suite, which scored an external CLI agent's planning prose
and could not run from a checkout at all.

That removal took twelve doctrine checks with it. They graded orchestration
doctrine for an external CLI — how a plan was phrased, staged, and handed off —
and they were retired with the subject they described, not relocated here. This
suite grades our own loop, so none of the twelve has an equivalent to move.

## Running it

From the repository root:

```bash
bun packages/smithers/agent/regression/run.ts
```

Use Bun with the repository's VibeLang preload to load workspace sources.

No API key, no network, no global CLI install. The suite exits `0` when every
case matched the committed baseline and cleared the gate, `1` when a score
dropped or moved or a threshold was breached, and `5` when the gate could not
decide: an observation is missing, a case did not finish, scoring was
inconclusive, or the baseline could not be read or decoded. A measured failure
takes precedence over missing observations. Inspect the report for a `5`:
a case error can indicate an agent regression, and a new case needs a deliberate
baseline update.

Two flags:

| Flag       | Effect                                                                |
| ---------- | --------------------------------------------------------------------- |
| `--update` | Rewrites `baseline.json` from this run.                               |
| `--json`   | Prints the full machine-readable regression report when a run drifts. |

## What it measures

Twenty-three cases. Each one is a whole agent run: the real cell loop, the real QuickJS
sandbox, the real registry-backed call bridge, and the real structured-output
boundary, executing over `FlowEngine.layerMemory` — the engine's in-process
volatile runtime, not the durable SQLite one a deployed host uses. Three things
around the loop are supplied by the suite: the `Model` behind `SeatResolver`,
which answers with recorded cells; the `Route` it seals against, which never
leaves the process; and the `Registry`, which is empty. That is what makes the
suite deterministic, and it is also the limit of what a green run proves — the
loop and its seams, not durability and not a real catalog.

| Case | Behaviour under evaluation |
| --- | --- |
| `structured-output-decode` | A well-formed answer decodes into the action's declared output schema in one model call. |
| `structured-output-from-prose` | An answer wrapped in prose is extracted and decoded without a correction re-prompt. |
| `correction-reprompt-recovers` | One malformed answer spends one correction slot; the re-prompted run decodes and the step succeeds. |
| `correction-budget-exhausted` | A model that never produces the declared shape fails typed after its one correction, not silently. |
| `cell-calls-a-flow` | A cell reaches a host capability through `ctx.call`, and the flow's typed result reaches the answer. |
| `read-only-cap-stops-a-reading-run` | A task run that only reads is told to write or justify at its cap, and stops as a typed failure at twice it rather than reporting work it never did. |
| `sufficiency-signal-reaches-the-next-frame` | A run that watched a check fail, changed the workspace, and watched a broader check pass is told its evidence is complete, and completes on it. |
| `speculative-inspection-park-recovers-once` | A first-response four-fence inspection park gets one turn to consume its unseen prints without an approval channel. |
| `second-speculative-inspection-park-fails` | A repeated speculative inspection park still fails `approval_unavailable` after its one recovery. |
| `park-without-a-human-is-answered` | An unattended park fails visibly with `approval_unavailable` in its first frame; the agent cannot answer its own approval question. |
| `park-every-frame-still-hits-the-read-only-cap` | An unattended park fails before the read-only cap can demand another frame, preserving the approval failure rather than continuing autonomously. |
| `repl-realm-carries-a-binding-across-frames` | A cell's top-level name is still bound in the next cell, and the run finishes by calling `ctx.done`. |
| `repl-print-reaches-the-next-frame` | What a cell prints opens the next frame, so `console.log` is the whole of the context channel. |
| `repl-completion-behind-a-guard` | One cell reproduces the failure, writes, replays the identical check and completes behind a check of both exit codes — the shape the contract teaches, in the frame that took the evidence. |
| `repl-guard-that-does-not-fire-carries-on` | The identical cell against a check that was green to begin with does not complete: the guard is the whole difference between answering and getting another frame. |
| `checkpoint-mint-is-refused-catchably-without-a-store` | `ctx.checkpoint()` reaches the boundary through the real loop, and a composition that pins no trees answers it as an ordinary catchable failure the cell reads a code off. |
| `checkpoint-at-base-is-never-silently-ignored` | A call that names `ctx.base` on a host that pins no trees is refused rather than run, because a reading of the live tree presented as a reading of the pinned one is a proof of nothing. |
| `checkpoint-refuses-a-write-at-a-pinned-tree` | A flow that declares a write is refused at a checkpoint before it reaches the engine: a checkpoint is a read-only view of a tree that has already been, and nothing runs. |
| `checkpoint-is-refused-by-a-host-that-pins-nothing` | `ctx.base` is always there and costs nothing; a mint on a host with no store is a catchable refusal at the line that asked, not a failed run. |
| `repl-completion-stops-the-calls-after-it` | `ctx.done` takes effect where it is called: the flow calls a cell would have made after it never reach the boundary, and they fail soft rather than throwing. |
| `repl-read-only-cap-takes-ctx-justify` | The read-only cap holds a run that only reads, and `ctx.justify` is the answer that buys quiet frames. |
| `max-frames-stops-the-run` | A run that never completes stops at its frame budget and reports a typed harness failure. |
| `seat-unresolved-is-typed` | A host with no model for the declared seat refuses before any model call, as a typed error. |

Seven cases drive the agent through `AgentAction` — one typed step inside an
ordinary flow, which is how a workflow author reaches it. The read-only-cap
case, the sufficiency case, the four park cases and the `repl-` cases drive the
`Agent` service directly inside a real flow execution, because `readOnlyCap`
and `approvalChannel` are `Agent.Options` fields that `AgentAction` does not
forward.

The `repl-` cases gate the realm's own promises — a binding survives a frame, a
print reaches the next turn, a completion is decided by a call the cell just
made, and the loop's discipline is armed the same way. They keep their names
from the wave that measured the realm against the surface it replaced; that
surface is gone, and the names are left alone so the committed baseline stays
the record of what the agent used to do.

Each case reduces its run to one `Observation`:

```ts
{ kind: "answer" | "failure", value?, failure?, modelCalls, flowCalls }
```

The case's `expected` is that observation written out in full, so a red case
names the behaviour that changed rather than a number that moved. The
`behaviour` scorer compares each observation with that expectation. The subject
constructs the observation's shape; validating that construction again would
not supply an independent grade.

Cases are self-evidencing rather than count-based wherever the prompt makes that
possible. The correction case answers with valid JSON only when the prompt
carries the correction teaching, so a boundary that stopped re-prompting reports
the wrong answer and not merely a different call count. The read-only case
records `probe:demanded` only if the structural demand actually reached the
model, and the park case answers only when the refusal text reached it, so a
loop that suspended quietly cannot pass by ending some other way.

## Files

| File            | What it is                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `subject.ts`    | The composition under evaluation: the scripted provider, the seat seam, the host, and the two ways to run the agent. |
| `agent.eval.ts`      | The twenty-three scenarios, their declared expectations, the behaviour scorer, and the case executor.                            |
| `run.ts`        | The entry point: runs the suite, compares it to the baseline, applies the gate, sets the exit code.                  |
| `baseline.json` | The committed baseline, in `@smthrs/evals` `Baseline` v1 form. Twenty-three records: one behaviour score per case.          |
| `tsconfig.json` | Typechecks the suite: `pnpm --filter @smthrs/eval-agent check`. Nothing else references it.                                          |

`baseline.json` is written by `Baseline.write`, which emits canonical
sorted-key single-line JSON. Do not reformat it: the file is regenerated, and a
pretty-printed copy only produces a diff the next `--update` reverses.

## Updating the baseline

```bash
bun packages/smithers/agent/regression/run.ts --update
```

Do this only when a score moved for a reason you can name in the commit message.
The baseline is the record of what the agent used to do, and rewriting it is how
a behaviour change stops being visible.

Two mechanical facts about the baseline are worth knowing before you read a
red run:

- A scorer's identity is `Scorer.scorerKey`, a SHA-256 digest over its explicit
  stable id, version, and canonical configuration. Function source and runtime
  transpilation are deliberately absent, so Node and Bun reproduce the same
  baseline keys. Bump the scorer version when its scoring contract changes.
- A case's step key is fixed as `evals/agent:<case>`. The regression comparison
  reads a changed key as a new step and a changed score under an unchanged key as
  nondeterminism, so the key is stated rather than derived from a run.

## Adding a case

1. Add a scenario to the `scenarios` table in `agent.eval.ts` with its `summary`, its
   `run`, and the `expected` observation written out in full. `cases` is derived
   from that table, so there is nothing else to keep in sync.
2. Prefer a scenario whose answer encodes the behaviour, not just its cost. A
   case that only counts model calls passes for the wrong reason as soon as an
   unrelated retry changes the count.
3. Run `bun packages/smithers/agent/regression/run.ts --update`, read the recorded scores, and commit
   the baseline with the case.

## Limits

- **It scores a scripted provider.** Every case fixes what the model says, so
  the suite measures the loop around the model — decoding, correction, calls,
  budgets, discipline, seat resolution — and measures nothing about model
  quality.
  A live-provider suite is a separate thing and would not be deterministic.
- **One composition.** Every case runs with an empty registry, an empty
  capability envelope, and at most one host flow. Plugin ordering, memory
  injection, steering, compaction, and durable park-and-resume are covered by
  `packages/smithers/agent/test`, not here.
- **Most failures are matched by tag, not by content.** A case that expects
  `/harness/HarnessError` would still pass if the harness raised that tag for a
  different reason. The two unattended park cases additionally require
  `approval_unavailable` before reducing the failure to an observation.

## Character evals: how an agent profile speaks and acts

`character/` runs an agent profile (shared instructions, a charter, skills)
through the same agent loop, one conversational turn at a time, in a simulated
workplace, and scores what people would read and what the agent did. It is for
behaviour a unit test can't pin down: whether a chat agent leads with the
answer, avoids jargon, links what it names, routes work to the right owner,
keeps private things private, and ignores instructions hidden in content.

```bash
node packages/smithers/agent/regression/character/run.ts                                  # offline example gate
node packages/smithers/agent/regression/character/run.ts --suite <dir>                    # offline: goldens pass, counterexamples fail
node packages/smithers/agent/regression/character/run.ts --suite <dir> --live --judge --trials 3
node packages/smithers/agent/regression/character/run.ts --suite <dir> --calibrate        # judge agreement on labelled turns
```

Offline runs spend nothing and work under Bun or Node. `--live` needs Node (the
egress HTTP client uses Undici's dispatcher, which Bun lacks) and runs on the
owner's subscription login (`SMITHERS_OPENAI_AUTH=chatgpt`, the codex login in
`$CODEX_HOME/auth.json`); every `*_API_KEY` and `*_API_KEY_FILE` variable,
`ANTHROPIC_AUTH_TOKEN`, `CODEX_API_KEY`, and the metered account pool and model
proxy variables are removed. At most `--concurrency` (default 2)
conversations run at once. `--trials` and `--concurrency` must be positive
integers; invalid values exit `5` before a suite or subscription seat is loaded. `--label` names the results file, so it is one path
segment of letters, digits, `.`, `_` and `-`.

| File | What it is |
| --- | --- |
| `character/world.ts` | The simulated workplace: `world.yaml`, `wiki/`, `repo/`, and the tools a role may call (chat, handoffs, requests, calendar, email, wiki, issues, web, and the work tools: `repo_read`, `repo_search`, `run_tests`, `ops_run`, `pr_open`, `issue_create`, `issue_comment`, `issue_update`), each recording its calls. |
| `character/profile.ts` | Composes a profile (the role's `.smithers/flows/<role>/flow.mdx`: `model`, `effort`, and `metadata` `name` and comma-separated `skills`; the body is the charter) into its system segments: the host's turn contract, shared instructions, charter, skills, with byte caps. |
| `character/event.ts` | Renders the event that starts a turn: time, where it arrived, the conversation so far, the new message. |
| `character/subject.ts` | Runs one turn through `Agent` on a live subscription seat or a replay seat. |
| `character/score.ts` | Deterministic checks (`@smthrs/scorers` `Checks`): jargon, forbidden phrases and truncation on every human-read message (replies, DMs, digest items, posts, requests to Will, handoff briefs, questions, notes, wiki pages, issue comments, new issues, pull requests); openers, bare paths and unlinked references on what Will reads directly; leakage on what other people read; expected calls; booking rules. |
| `character/rubric.ts` | The seven-criterion, role-neutral rubric judge (`@smthrs/scorers` `Rubric`) on a subscription seat; it reads every human-read message in full and takes the role's ideal from the case's `focus` note. `judgeKey` records what a verdict depended on. |
| `character/suite.ts` | Loads `suite.yaml` (its `profile` names the role's `flow.mdx`; `org` holds `Skills/` and the shared instructions) and `cases/*.yaml`. |
| `character/run.ts` | Runs cases through `@smthrs/evals` (`Suite`, `Runner`, `Trials`), prints pass@1, pass@k and pass^k, and writes results and a regression log for live runs. |
| `character/example/` | A seven-case suite in a tiny invented company: the offline gate and a template. |

A case file holds the world patch, the conversation so far, the trigger (or
`turns` for a conversation), expectations (`reply`, `owner`, `calls`,
`booking`, `leakage`, `allow`, `focus`), a golden transcript and
counterexamples. Offline, each counterexample replaces one turn of the golden
conversation and must complete every turn with a reply and fail at least one
expectation check. An intentionally empty reply still counts as completed.
An executor error, a missing transcript, or a replay that rejects one of its
calls or has no `reply` makes the gate fail; it does not count as catching the
counterexample. A counterexample that
passes means the case can't see that failure.

Replies use the case's `where` to identify their readers: a reply in a
`channel:` is team-visible even when the trigger came from `owner`, so
private markers fail the leakage check there as they do in channel posts.
A private reply to `owner` may contain private markers.

Work is simulated against the world's fixtures, so a case can assert that a
role did it instead of saying it can't: `repo_read` and `repo_search` read
`repo/`; `run_tests` answers from the world's `tests` list (of the entries whose
`match` terms all appear in the filter, the one with the most terms wins, an empty `match` is the
default, and a world without `tests` has no runner); `ops_run` (deploy, roll
back, restart, rotate and other operational commands) answers from the world's
`ops` list (of the entries whose `action`, when set, equals the action and
whose `match` terms all appear in the target, the most specific wins, and a world without `ops`
has no operations workspace), so a case can assert that a role deployed or
rolled back, or that it didn't; `pr_open`,
`issue_create`, `issue_comment` and `issue_update` (state, labels, assignee,
priority, `duplicateOf`) change the turn's copy of the issue list, which
`issues_search` and `issue_read` then see. A world grants them per role like
any other tool. A case patch applies `set`, then `remove`, then `add`, then
`pages`, so removing and re-adding an issue replaces it. A private wiki page is
the `personal-assistant` role's alone: other roles can neither read, list nor
overwrite it. Symlinks under `wiki/` and `repo/`, and those two directories
themselves when they are symlinks, are skipped.

`--rescore <results.json>` scores an earlier live run again with the current
cases and checks without calling the role's model; with `--judge` it judges a
conversation again when it has no verdict or its verdict was made under other
judge notes or another rubric version (each saved conversation carries the
`judgeKey` its verdict was made under, and a rescore that keeps a verdict keeps
its key), and `--rejudge` judges every conversation again. Each saved case ID
absent from the loaded suite is reported on stderr; if none match, the runner
exits `5` without writing results or a regression-log entry. `--check-profile`
composes the suite's role file (shared instructions, charter, skills, byte
caps), prints what it found and exits non-zero on a missing skill or an
oversized part; it is the check for a role file.

Suite `profile`, `org`, `world`, `calibration` and `voice.jargon` paths must
stay inside the suite directory, including when resolved through symlinks.
Explicit CLI `--profile` and `--common` overrides are chosen by the operator.
`calendar_list` and `calendar_freebusy` include every event overlapping the
requested local-minute interval; an event ending at the start or starting at
the end is outside it.

Limits: the world's tools are simulations, so a live pass shows how the
profile behaves against this world, not that real integrations work. The
judge shares a model family with most roles. The harness keys the provider's
prompt cache on the whole system prompt including the task, so the first model
call of every turn reads nothing from cache and dominates a pass's cost.

### Character text patterns

`Checks.includes`, `Checks.excludes` and `Checks.leakage` treat strings as
literal text. Intentional patterns use `RegExp` values. In `suite.yaml`,
`voice.forbid` accepts strings and explicit objects such as
`{ pattern: "\\b[0-9a-f]{10,40}\\b", flags: "i" }`; the loader converts only
those objects to `RegExp` values before scoring.
