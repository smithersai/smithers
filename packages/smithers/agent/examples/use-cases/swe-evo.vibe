/**
 * Carry a Python project across one release from its release notes, then score the patch on the hidden tests.
 *
 * Port of the 0.x `swe-evo/workflow/swe-evo.tsx`. One run is one SWE-EVO
 * instance, five steps in order: prepare the repository at the previous
 * release, draft the change from the release notes, review and complete the
 * draft against the same notes, capture the edits as one patch, and score that
 * patch. Each agent step gets one retry, as in 0.x.
 *
 * 0.x's `prepare`, `diff` and `score` were compute tasks over Docker and a Python scorer; here they are declared actions a host implements, and the scorer reloads the gold fields by instance id so no agent payload carries them.
 * 0.x drafted with Claude Opus and refined with Codex; both steps here take the examples' seat, and a host routes `Refine` to another seat to keep the mix.
 * 0.x's `retries={1}` is a `Node.catch` whose failure arm calls the step again.
 * 0.x ran the agents with file-editing CLIs in the checkout; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 * The dataset loader, the suite runner and the panel variant (`swe-evo-panel.tsx`) are not ported.
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** 0.x's `SWEEVO_AGENT_TIMEOUT_MS` default: half an hour per agent step. */
const agentTimeout = "30 minutes"

/** 0.x's `SWEEVO_SCORE_TIMEOUT_S` default. */
export const scoreTimeoutS = 1800

/**
 * The instance as the run receives it: the SWE-EVO fields with the gold
 * `patch`, `test_patch`, `FAIL_TO_PASS` and `PASS_TO_PASS` stripped.
 */
export const Instance = Schema.Struct({
  instance_id: Schema.String,
  repo: Schema.String,
  base_commit: Schema.String,
  image: Schema.String,
  problem_statement: Schema.String.annotate({ description: "The release notes of the next release" }),
  start_version: Schema.optional(Schema.String),
  end_version: Schema.optional(Schema.String)
})

/** The checkout the agents edit. */
export const Prepared = Schema.Struct({
  workdir: Schema.String,
  baseCommit: Schema.String,
  headLine: Schema.String
})

/** What an agent step reports about its edits. */
export const EditSummary = Schema.Struct({
  summary: Schema.String,
  filesChanged: Schema.Array(Schema.String)
})

/** The combined edits as one unified patch. */
export const Diff = Schema.Struct({
  patch: Schema.String,
  changedFiles: Schema.Number,
  insertions: Schema.Number,
  deletions: Schema.Number
})

/**
 * The scored instance. Resolved and the fix rate's components are integers,
 * a quirk 0.x kept because its output columns were integers.
 */
export const Score = Schema.Struct({
  instance_id: Schema.String,
  repo: Schema.String,
  image: Schema.String,
  log_parser: Schema.String,
  test_cmds: Schema.String,
  resolved: Schema.Number,
  fix_rate_pct: Schema.Number,
  f2p_total: Schema.Number,
  f2p_passed: Schema.Number,
  p2p_total: Schema.Number,
  p2p_passed: Schema.Number,
  all_p2p_pass: Schema.Boolean,
  candidate_applied: Schema.Boolean,
  testpatch_applied: Schema.Boolean,
  timed_out: Schema.Boolean,
  duration_s: Schema.Number,
  parsed_test_count: Schema.Number,
  f2p_status: Schema.Record(Schema.String, Schema.String),
  p2p_failures: Schema.Record(Schema.String, Schema.String)
})

/** Copies the repository at `baseCommit` out of the instance image. */
export const PrepareRepo = Action.make("examples/SweEvo/Prepare", {
  payload: { instanceId: Schema.String, image: Schema.String, baseCommit: Schema.String },
  success: Prepared
})

/** Stages every edit in the checkout and captures it as a patch. */
export const CaptureDiff = Action.make("examples/SweEvo/Diff", {
  payload: { instanceId: Schema.String },
  success: Diff
})

/**
 * Scores a patch with the instance's hidden tests in its own image. The host
 * loads the gold fields by `instanceId`; they never enter the run.
 */
export const ScoreCandidate = Action.make("examples/SweEvo/Score", {
  payload: { instanceId: Schema.String, patch: Schema.String, timeoutS: Schema.Number },
  success: Score
})

const rules = `Rules:
- Explore the codebase first to understand the modules involved before editing.
- Implement the described behavior with minimal, correct, idiomatic changes that
  match the existing code style and conventions of this project.
- Make the change complete and self-consistent across ALL affected source files.
- Do NOT add, modify, or delete any test files (paths containing tests/ or named
  test_*.py / *_test.py). Your work is validated by a hidden test suite; editing
  tests cannot help and will be discarded.
- Do not bump version numbers or edit changelog/release-note files unless the
  behavior described literally requires it.
- Prefer fixing root causes over special-casing. Do not leave TODOs.`

type Instance = typeof Instance.Type

const specification = (instance: Instance) =>
  `==================== RELEASE SPECIFICATION (${instance.end_version ?? "next release"}) ====================
${instance.problem_statement}
====================================================================================`

/** Drafts the release from its notes. */
export const Implement = AgentAction.make("examples/SweEvo/Implement", {
  payload: Instance,
  output: EditSummary,
  seat,
  timeout: agentTimeout,
  prompt: (instance) =>
    `You are evolving the \`${instance.repo}\` codebase from one release to the next.

The repository in your working directory is checked out at the PREVIOUS release
(\`${instance.start_version ?? instance.base_commit}\`, commit ${instance.base_commit}).
Implement the changes described in the following release specification so the new
release's behavior is realized in the code.

${specification(instance)}

${rules}

Apply your edits directly to the files in the working directory. When finished,
report a short summary and the list of source files you changed.`
})

/** Reviews the draft against the same notes and completes it. */
export const Refine = AgentAction.make("examples/SweEvo/Refine", {
  payload: Instance,
  output: EditSummary,
  seat,
  timeout: agentTimeout,
  prompt: (instance) =>
    `You are a senior reviewer completing an in-progress implementation in the
\`${instance.repo}\` codebase. Another engineer has already attempted to implement
the release specification below; their uncommitted edits are in the working
directory (run \`git diff\` to review them).

${specification(instance)}

Your job:
- Review the current changes against the specification.
- Find and fix bugs, missing edge cases, incomplete coverage across files,
  incorrect logic, or anything that would make the new behavior wrong or partial.
- If you find the implementation already correct and complete, make no changes.

${rules}

Apply any fixes directly to the files. When finished, report what you changed (or
confirm the implementation was already correct and complete).`
})

/** One agent step with 0.x's single retry. */
const retriedOnce = <E, R>(call: () => Node.Node<typeof EditSummary.Type, E, R>) =>
  Node.catch(call(), { onFailure: () => call() })

/** The five-step instance run. Each step waits for the one before it. */
export const SweEvo = Flow.make("examples/SweEvo", {
  payload: Instance,
  success: Score,
  error: AgentAction.AgentFailure,
  body: (instance) =>
    Node.andThen(
      PrepareRepo.call({ instanceId: instance.instance_id, image: instance.image, baseCommit: instance.base_commit }),
      Node.andThen(
        retriedOnce(() => Implement.call(instance)),
        Node.andThen(
          retriedOnce(() => Refine.call(instance)),
          Node.bindPlanned(
            CaptureDiff.call({ instanceId: instance.instance_id }),
            (diff: Planned.Planned<typeof Diff.Type>) =>
              ScoreCandidate.call({ instanceId: instance.instance_id, patch: diff.patch, timeoutS: scoreTimeoutS })
          )
        )
      )
    )
})

/**
 * The agent steps. `PrepareRepo`, `CaptureDiff` and `ScoreCandidate` are the
 * host's: it supplies their `toLayer` implementations over its own checkout
 * and scorer.
 */
export const layer = Layer.mergeAll(Implement.layer, Refine.layer)
