import { Action, Flow, FlowRuntime, HumanTask, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Layer, Metric, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { repoId } from "../../src/features/repo/contract.ts"
import { MAX_OPTION_LENGTH, MAX_OPTIONS, MAX_PROMPT_LENGTH } from "../../src/features/status/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import { rowIdOf } from "../RepoRuns.ts"

// `queue/ask { repo, id, to, askedBy, prompt, options? }` (decision 0031, docs/features/agent-status.md#addressed-waits):
// an agent with no person behind it asks one person a question, and its run waits, for days if need be, for the answer.
//
//   queue/ask/open    ─ writes the run's `runs` row once: needs_you, addressed to `to`, launched by `askedBy`
//   HumanTask (system/human-task, `ask`) ─ parks until the person answers; no deadline
//   queue/ask/settle  ─ settles the row: done, keeping the question and the answer; failed when the task failed
//
// It runs remotely because no device holds it: the asker is a machine, and the person may answer days later. The answer
// reaches the parked run through its execution's object (worker/ExecutionHost.ts `answer`), from
// `POST /api/runs/<id>/answer` (worker/Runs.ts). Both steps are sealed: their payloads hold the question and the answer,
// which the engine keeps for the run alone. Its records carry the execution id and outcomes, never the words.

/** The flow's name: a `runs` row's `flow`. */
export const ASK_FLOW = "queue/ask"

/** The human task a `queue/ask` run parks on. */
export const ASK_TASK = "queue-ask"

/**
 * The task's attempt budget: one. The answer route sends only words, which an `ask` task always takes, so no attempt is
 * ever refused; a second attempt could only follow an answer nothing sends, and would keep a stuck run open.
 */
export const MAX_ATTEMPTS = 1

/** An ask's id, chosen by its agent: unique within a repository. */
export const AskId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/))

/** Who asks: `machine:<agent>/<lane>`, a machine token's pair. */
export const AskedBy = Schema.String.check(Schema.isPattern(/^machine:[\w.:-]{1,100}\/[\w.:-]{1,100}$/))

/** The question, as the asks route admits it: `to` is the person's subject id, as `runs.launched_by` holds one. */
export const AskRequest = Schema.Struct({
  repo: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  id: AskId,
  to: Schema.String.check(Schema.isBetweenLength(1, 256)),
  askedBy: AskedBy,
  prompt: Schema.String.check(Schema.isBetweenLength(1, MAX_PROMPT_LENGTH)),
  options: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isBetweenLength(1, MAX_OPTION_LENGTH))).check(Schema.isMaxLength(MAX_OPTIONS)),
  ),
})
export type AskRequest = typeof AskRequest.Type

/** What `queue/ask` answers: the person's words, or `answered: false` when the question ended without them. */
export const AskOutcome = Schema.Struct({ answered: Schema.Boolean, answer: Schema.optional(Schema.String) })
export type AskOutcome = typeof AskOutcome.Type

/** One ask's execution id: one execution per repository and ask id, so starting it again is a no-op. */
export const askExecutionId = (repo: string, id: string) => `${ASK_FLOW}:${repo.toLowerCase()}:${id}`

/** Postgres failed. The step retries it, and never gives up: a question must not be lost. */
export class AskUnavailable extends Schema.TaggedError<AskUnavailable>()("@smthrs/mvp/queue/AskUnavailable", {}) {}

/** Asks' rows written, by `op` (`open`, `settle`) and `outcome` (`opened`, `existing`, `done`, `failed`, `unavailable`). */
export const writes = Metric.counter("smithers_ask_writes", {
  description: "queue/ask rows opened and settled, by op and outcome",
  incremental: true,
})

const retryPolicy = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })

/** Writes the run's row, needing the person, once. */
export const Open = Action.make("queue/ask/open", {
  payload: AskRequest.fields,
  success: Schema.Struct({ opened: Schema.Boolean }),
  error: AskUnavailable,
  capabilities: ["db:write:runs"],
  tier: "sealed",
  retryPolicy,
})

/** Settles the run's row: `done` with the answer, or `failed` with none. */
export const Settle = Action.make("queue/ask/settle", {
  payload: { answer: Schema.NullOr(Schema.String) },
  success: AskOutcome,
  error: AskUnavailable,
  capabilities: ["db:write:runs"],
  tier: "sealed",
  retryPolicy,
})

/** `queue/ask`: asks one person for an agent, and waits for their answer. */
export const Ask = Flow.make(ASK_FLOW, {
  description: "Ask one person a question for an agent, and wait for their answer.",
  capabilities: ["db:write:runs"],
  modelInvocable: false,
  payload: AskRequest.fields,
  success: AskOutcome,
  error: AskUnavailable,
  body: Node.capture({ open: Open.name, task: ASK_TASK, settle: Settle.name }, (request: AskRequest) =>
    Open.call(request).pipe(
      Node.andThen(
        HumanTask.action.call({ name: ASK_TASK, kind: "ask", prompt: request.prompt, maxAttempts: MAX_ATTEMPTS }).pipe(
          // An `ask` task takes words only, so its answer is a string.
          Node.map(Node.capture({ answer: "words" }, (answer: typeof Schema.Json.Type) => String(answer))),
          // The task failed: the question ends without an answer.
          Node.catch({ onFailure: Node.capture({ answer: null }, () => Node.succeed<string | null>(null)) }),
        ),
      ),
      Node.bindPlanned(Node.capture({ settle: Settle.name }, (answer) => Settle.call({ answer }))),
    )),
})

/** Counts and logs one write, with the execution id and its outcome only. */
const recorded = (op: "open" | "settle", runId: string, outcome: string, errorCode?: string) =>
  Effect.andThen(
    Metric.update(Metric.withAttributes(writes, { op, outcome }), 1),
    Effect.logWithLevel(outcome === "unavailable" ? "Warn" : "Info")(`queue.ask.${op}`).pipe(
      Effect.annotateLogs({ runId, outcome, ...(errorCode === undefined ? {} : { errorCode }) }),
    ),
  )

/** Runs `write` for the step's execution over `database`; any failure is `AskUnavailable`, logged with its code. */
const step = <A, E, R, DE, DR>(
  op: "open" | "settle",
  database: Layer.Layer<SqlClient.SqlClient, DE, DR>,
  write: (executionId: string, rowId: string) => Effect.Effect<A, E, R | SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const { executionId } = yield* FlowRuntime.FlowInstance
    return yield* Effect.flatMap(rowIdOf(executionId), (rowId) => write(executionId, rowId)).pipe(
      Effect.provide(database),
      Effect.catchCause((cause) =>
        Effect.andThen(recorded(op, executionId, "unavailable", codeOf(Cause.squash(cause))), Effect.fail(new AskUnavailable()))
      ),
      Effect.withSpan(`queue.ask.${op}`, { attributes: { "smithers.run.id": executionId } }),
    )
  })

/** `queue/ask/open`: the row, needing `request.to`, written once; a replay finds it and writes nothing. */
export const open = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => (request: AskRequest) =>
  step("open", database, (executionId, rowId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [owner, name] = request.repo.split("/") as [string, string]
      const wait = { execution: executionId, kind: "question", prompt: request.prompt, options: request.options ?? [] }
      // `execution` stays NULL: the row is the person's wait, not a run on the repository's runs list.
      const rows = yield* sql<{ readonly id: string }>`
        INSERT INTO runs (id, flow, status, waiting, wait, version, launched_by, addressed_to, repo_id)
        VALUES (${rowId}::uuid, ${ASK_FLOW}, 'needs_you', 'input', ${JSON.stringify(wait)}::jsonb, 1, ${request.askedBy},
          ${request.to}, ${repoId(owner, name)})
        ON CONFLICT (id) DO NOTHING
        RETURNING id::text`
      yield* recorded("open", executionId, rows.length === 1 ? "opened" : "existing")
      return { opened: rows.length === 1 }
    }))

/**
 * `queue/ask/settle`: the row `done`, keeping the question, with the answer when the answer route hasn't recorded it
 * yet; `failed` when the task failed. A row already settled changes nothing.
 */
export const settle = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
(input: { readonly answer: string | null }) =>
  step("settle", database, (executionId, rowId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { answer } = input
      const kept = answer === null ? null : JSON.stringify({ value: answer })
      yield* sql`
        UPDATE runs SET status = ${answer === null ? "failed" : "done"}, waiting = NULL,
          answer = COALESCE(answer, ${kept}::jsonb),
          answered_at = CASE WHEN COALESCE(answer, ${kept}::jsonb) IS NULL THEN NULL ELSE COALESCE(answered_at, now()) END,
          updated_at = now()
        WHERE id = ${rowId}::uuid AND status = 'needs_you'`
      yield* recorded("settle", executionId, answer === null ? "failed" : "done")
      return answer === null ? { answered: false } : { answered: true, answer }
    }))

/** Registers `queue/ask` and the human task it parks on, with its steps over the app's tables in `database`. */
export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Interpreter.layerWithImplementations(
    Ask,
    Layer.mergeAll(Open.toLayer(open(database)), Settle.toLayer(settle(database)), HumanTask.layer),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
