import { AgentRunner, ExternalAgent } from "@smthrs/agent"
import { Action, RetryPolicy } from "@smthrs/flow"
import { Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as Stack from "../stack/Stack.ts"
import * as Jobs from "../runners/Jobs.ts"
import * as Store from "../runners/Store.ts"
import { promptOf } from "./TodoAgent.ts"

// The `todo` run's implement step when the repository codes with an external agent (decision 0133,
// docs/features/agent-runners.md#a-todo-on-an-external-agent). `todo/Agent` reads the repository's coding agent once
// and journals it; `agent/Session` (`ExternalAgent` from `@smthrs/agent`) hands the TODO to a runner whose labels and
// profile fit that agent. The runner checks the repository out at the attempt's base, runs the agent with its own
// tools there, and settles the files it changed, which `todo/Received` checks as `todo/Collect` checks a machine's.
// Nothing here names an agent vendor, and nothing outside worker/runners/ knows how the runner keeps a session durable:
// the step is the session's durable unit, as `todo/Implement` is Smithers' own agent's (ruling DUR-9).

/** Which agent codes one attempt: an external agent's settings, or none for Smithers' own. */
export const Coding = Schema.Struct({ agent: Schema.NullOr(AgentRunner.Agent) })
export type Coding = typeof Coding.Type

/** The external agent's instructions: what it works on, and what Smithers does with what it leaves. */
export const SYSTEM = [
  "You implement one TODO in the git repository checked out in your working directory.",
  "Make the smallest change that does the TODO, and keep the repository's style. Never commit, push or create " +
  "branches: Smithers commits every file you leave in the working copy and opens the pull request, so leave nothing " +
  "else there.",
  "Check the change with the lint, typecheck and tests of each package you changed, and fix what they find.",
  "Finish with a one-paragraph summary of what you changed and how you checked it.",
]

/** What the step is given: the TODO, the attempt's base commit, its agent, and the change's limits. */
export const SessionPayload = {
  attemptId: Schema.String,
  todoId: Schema.String,
  repoId: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  prompt: Schema.String,
  acceptance: Schema.Array(Schema.String),
  baseSha: Schema.String,
  agent: AgentRunner.Agent,
  limits: AgentRunner.Limits,
}

/** The job a runner gets for one attempt. */
export const taskOf = (payload: Schema.Struct.Type<typeof SessionPayload>): AgentRunner.Task => ({
  agent: payload.agent,
  repository: payload.repoId,
  base: payload.baseSha,
  system: SYSTEM,
  prompt: promptOf(payload),
  limits: payload.limits,
  // The attempt, so the runner routes can tell its TODO a runner holds the job (worker/ChatApiProgram.ts).
  context: { attemptId: payload.attemptId },
})

/** `agent/Session`: an external agent writes the TODO's change on a runner. */
export const Session = ExternalAgent.make("agent/Session", { payload: SessionPayload, task: taskOf })

/** The repository's coding agent could not be read. Retried by the step's policy. */
export class CodingUnavailable extends Schema.TaggedError<CodingUnavailable>()("@smthrs/mvp/todo/CodingUnavailable", {}) {}

/** `todo/Agent`: which agent codes this attempt, read once and journaled. */
export const Agent = Action.make("todo/Agent", {
  payload: { attemptId: Schema.String, repoId: Schema.String },
  success: Coding,
  error: CodingUnavailable,
  // Postgres unreachable: 1 s doubling to a minute, for at most an hour, as the run's other steps.
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 60 * 60_000 }),
})

/** `todo/Agent`'s implementation over `database`: the repository's coding agent, logged by name only. */
export const agentStep = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
(payload: typeof Agent.payloadSchema.Type) =>
  Store.codingAgent(payload.repoId).pipe(
    Effect.provide(database),
    Effect.mapError(() => new CodingUnavailable()),
    Effect.map((agent): Coding => ({ agent: Option.getOrNull(agent) })),
    Effect.tap((coding) =>
      Effect.logInfo("todo.agent").pipe(
        Effect.annotateLogs({ attemptId: payload.attemptId, agent: coding.agent?.name ?? "smithers" }),
      )
    ),
    Effect.withSpan("todo.agent", { attributes: { "smithers.todo.attempt": payload.attemptId } }),
  )

/** `todo/Agent` and `agent/Session` over `database`: the step waits on the job store in the app's Postgres. */
export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Layer.mergeAll(
    Agent.toLayer(agentStep(database)),
    Session.toLayer().pipe(Layer.provide(Jobs.layer(database))),
  )

/**
 * A runner claimed attempt `attemptId`'s job: its TODO no longer waits for one (`todos.waiting`, decision 0132). The
 * claim route runs it for every claim and reclaim (worker/runners/Api.ts `onClaimed`); an attempt the TODO no longer
 * runs is a stale report, which changes nothing.
 */
export const claimed = (attemptId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [attempt] = yield* sql<Stack.RunAttempt>`
      SELECT id::text AS "attemptId", todo_id::text AS "todoId", repo_id AS "repoId", ordinal
      FROM todo_attempts WHERE id::text = ${attemptId}`
    if (attempt === undefined) return
    yield* Stack.report(attempt, { kind: "waiting", waiting: null }, { runs: false })
  })
