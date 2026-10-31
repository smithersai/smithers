import { AgentRunner } from "@smthrs/agent"
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Metric, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { codeOf } from "../ErrorCode.ts"
import * as Store from "./Store.ts"

// `admin/AddRunner`, `admin/RemoveRunner`, `admin/SetAgent` and `admin/RemoveAgent` (decision 0133,
// docs/features/agent-runners.md#admin): an Admin registers a repository's runner machines and names its external
// agents. The route admits the write (signed in; an Admin of the repository acting in person, never an agent, flow or
// sandbox) before it starts the flow. Each flow is one durable step that writes and records its change once, under its
// invocation key. A runner is registered by its token's SHA-256, so no token reaches a journal, a log or Postgres.

/** Postgres couldn't record the write. Retried. */
export class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()("@smthrs/mvp/runners/StoreUnavailable", {}) {}

/** The step couldn't tell which step it is, so it couldn't record its change once. */
export class NoInvocationKey extends Schema.TaggedError<NoInvocationKey>()("@smthrs/mvp/runners/NoInvocationKey", {}) {}

/** Writes, by `flow` and `change` (`set`, `removed`, `missing`, `repeat`). */
export const writes = Metric.counter("smithers_runner_admin_writes", {
  description: "Admin writes of runners and agents, by flow and change",
  incremental: true,
})

/** Recording: 1 s doubling to a minute, for at most 30 minutes, while Postgres is unreachable. */
export const STORE_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 30 * 60_000 })

/** A token's SHA-256: 64 lowercase hexadecimal characters. */
export const TokenSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

/** How many jobs one runner may run at once. */
export const Capacity = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }))

const addPayload = {
  repoId: Schema.String,
  name: AgentRunner.Name,
  tokenSha256: TokenSha256,
  labels: Schema.Array(AgentRunner.Label),
  capacity: Capacity,
  actorId: Schema.String,
}
const removePayload = { repoId: Schema.String, name: AgentRunner.Name, actorId: Schema.String }
const setAgentPayload = { repoId: Schema.String, agent: AgentRunner.Agent, coding: Schema.Boolean, actorId: Schema.String }

const Changed = Schema.Struct({ change: Schema.Literals(["set", "removed", "missing", "repeat"]) })

const write = <const Name extends string, P extends Schema.Struct.Fields>(name: Name, payload: P) =>
  Action.make(name, {
    payload,
    success: Changed,
    error: StoreUnavailable,
    capabilities: ["db:write:runners"],
    retryPolicy: STORE_RETRY,
  })

export const WriteRunner = write("admin/WriteRunner", addPayload)
export const RetireRunner = write("admin/RetireRunner", removePayload)
export const WriteAgent = write("admin/WriteAgent", setAgentPayload)
export const EraseAgent = write("admin/EraseAgent", removePayload)

const flow = { capabilities: ["db:write:runners"], modelInvocable: false, success: Changed, error: StoreUnavailable } as const

/** `admin/AddRunner`: registers a repository's runner machine by its token's SHA-256, labels and capacity. */
export const AddRunner = Flow.make("admin/AddRunner", {
  ...flow,
  description:
    "Register a repository's runner machine by its name, labels, capacity and token's SHA-256; an Admin in person only.",
  payload: addPayload,
  body: Node.capture({ step: WriteRunner.name }, (change) => WriteRunner.call(change)),
})

/** `admin/RemoveRunner`: retires a runner machine, refusing its token from then on. */
export const RemoveRunner = Flow.make("admin/RemoveRunner", {
  ...flow,
  description: "Remove a repository's runner machine, refusing its token from then on; an Admin in person only.",
  payload: removePayload,
  body: Node.capture({ step: RetireRunner.name }, (change) => RetireRunner.call(change)),
})

/** `admin/SetAgent`: names an external agent, and whether TODOs code with it. */
export const SetAgent = Flow.make("admin/SetAgent", {
  ...flow,
  description: "Set a repository's named external agent (machine labels, profile, hours, restarts) and whether " +
    "TODOs code with it; an Admin in person only.",
  payload: setAgentPayload,
  body: Node.capture({ step: WriteAgent.name }, (change) => WriteAgent.call(change)),
})

/** `admin/RemoveAgent`: removes a named external agent. */
export const RemoveAgent = Flow.make("admin/RemoveAgent", {
  ...flow,
  description: "Remove a repository's named external agent; TODOs code with Smithers' own agent when it was the " +
    "coding agent; an Admin in person only.",
  payload: removePayload,
  body: Node.capture({ step: EraseAgent.name }, (change) => EraseAgent.call(change)),
})

/** Every flow here, for a host that resolves executions by tag. */
export const flows = [AddRunner, RemoveRunner, SetAgent, RemoveAgent] as const

/**
 * One step's implementation: its write under the step's invocation key, recorded by flow and change, never a token. A
 * database failure is `StoreUnavailable`, which the step's policy retries; a step with no invocation key is a defect.
 */
export const step = <P extends { readonly repoId: string; readonly actorId: string }, E, R>(
  flowName: string,
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  name: (payload: P) => string,
  run: (payload: P, by: Store.By) => Effect.Effect<Store.Change, unknown, SqlClient.SqlClient>,
) =>
(payload: P) =>
  Effect.gen(function* () {
    const invocationKey = yield* Action.CurrentInvocationKey
    if (invocationKey === undefined) return yield* Effect.die(new NoInvocationKey())
    const change = yield* run(payload, { actorId: payload.actorId, invocationKey }).pipe(
      Effect.provide(database),
      Effect.catch((error) =>
        Effect.andThen(
          Effect.logWarning("runner.admin").pipe(
            Effect.annotateLogs({ flow: flowName, outcome: "unavailable", errorCode: codeOf(error) }),
          ),
          Effect.fail(new StoreUnavailable()),
        )
      ),
    )
    yield* Metric.update(Metric.withAttributes(writes, { flow: flowName, change }), 1)
    yield* Effect.logInfo("runner.admin").pipe(
      Effect.annotateLogs({ flow: flowName, change, repoId: payload.repoId, name: name(payload) }),
    )
    return { change }
  }).pipe(Effect.withSpan("runner.admin", { attributes: { "smithers.flow": flowName, "smithers.repo.id": payload.repoId } }))

/** Registers the four flows with their steps over `database`. */
export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Layer.mergeAll(
    Interpreter.layerWithImplementations(
      AddRunner,
      WriteRunner.toLayer(step(AddRunner._tag, database, (p) => p.name, (p, by) => Store.addRunner(p, by))),
    ),
    Interpreter.layerWithImplementations(
      RemoveRunner,
      RetireRunner.toLayer(step(RemoveRunner._tag, database, (p) => p.name, (p, by) => Store.removeRunner(p, by))),
    ),
    Interpreter.layerWithImplementations(
      SetAgent,
      WriteAgent.toLayer(step(SetAgent._tag, database, (p) => p.agent.name, (p, by) => Store.setAgent(p, by))),
    ),
    Interpreter.layerWithImplementations(
      RemoveAgent,
      EraseAgent.toLayer(step(RemoveAgent._tag, database, (p) => p.name, (p, by) => Store.removeAgent(p, by))),
    ),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
