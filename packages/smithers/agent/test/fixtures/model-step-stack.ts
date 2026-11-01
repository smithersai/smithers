import { TestSchemas } from "@smthrs/database"
/**
 * The composition every ModelStep case runs on: the Node host runtime over a
 * scratch schema of the compose Postgres, one probe flow, and a scripted model
 * that counts its calls. The model is the only scripted seam.
 *
 * The child-process fixture loads this module under native TypeScript, so it
 * imports nothing from Vitest.
 */
import { Crypto } from "@smthrs/crypto"
import { StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Model, ModelEvent, ModelRequest, Route } from "@smthrs/model"
import { Node } from "@smthrs/plan"
import { NodeHost, NodeRuntime } from "@smthrs/platform-node"
import { Ownership } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as SqlClient from "effect/sql/SqlClient"
import * as Stream from "effect/Stream"
import * as FlowEngineLike from "../../src/FlowEngineLike.ts"
import * as ModelStep from "../../src/ModelStep.ts"

/**
 * A dedicated loopback PostgreSQL endpoint. The target supplies its isolated
 * service's port; direct Vitest runs retain the local compose port. Only a
 * port is configurable: these cases create and drop schemas and never accept
 * an arbitrary database destination from the environment.
 */
const port = Number(process.env.SMITHERS_MODEL_STEP_TEST_PG_PORT ?? "54321")
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("SMITHERS_MODEL_STEP_TEST_PG_PORT must be an integer from 1 to 65535")
}
export const postgres = { host: "127.0.0.1", port, url: `postgres://smithers:smithers@127.0.0.1:${port}/smithers` }

/** A schema name no other case uses. */
export const scratchSchema = (): string => TestSchemas.schemaName("model_step")

/** The flow every case executes. Its handler is the case's own. */
export const Probe = Flow.make("agent/test/model-step/Probe", {
  payload: { prompt: Schema.String },
  success: Schema.Json,
  error: ModelStep.Failure,
  body: () => Node.succeed(null)
})

/** What a probe handler may require: the services a flow body has. */
export type Handler = (
  payload: { readonly prompt: string },
  executionId: string
) => Effect.Effect<Schema.Json, ModelStep.Failure, Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>

/** A Jujutsu service that records nothing: no case here takes a snapshot. */
const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "model-step" as never, commitId: "model-step" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/**
 * One process's runtime over `schema`, with {@link Probe} registered to
 * `handler`. Liveness is the process table, so a resumed host takes a run only
 * from an owner that is really gone.
 */
export const runtime = (options: {
  readonly schema: string
  readonly workspaceRoot: string
  readonly hostId: string
  readonly handler: Handler
}) =>
  NodeRuntime.layer(
    {
      filename: `${postgres.url}?schema=${options.schema}`,
      workspaceRoot: options.workspaceRoot,
      owner: { hostId: options.hostId },
      isAlive: Ownership.sameHostPidProbe
    },
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    Layer.effectDiscard(
      Effect.flatMap(FlowRuntime.FlowRuntime, (engine) => engine.register(Probe, options.handler))
    )
  ).pipe(
    Layer.provide([NodeHost.AtomicFileSystem.layer, Crypto.layerFromDigest(NodeHost.NodeCrypto.layerDigest), stubJj])
  )

/**
 * Drops a scratch schema through a connection of its own, taking the schema's
 * writer lock first, as every store transaction does.
 */
export const dropSchema = (schema: string, workspaceRoot: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`)
  }).pipe(
    Effect.provide(NodeRuntime.storage(`${postgres.url}?schema=${schema}`, workspaceRoot)),
    Effect.provide([NodeHost.AtomicFileSystem.layer, Crypto.layerFromDigest(NodeHost.NodeCrypto.layerDigest)]),
    Effect.scoped
  )

/** Executes {@link Probe} in the runtime in context. */
export const execute = (executionId: string, prompt: string) =>
  Effect.flatMap(FlowRuntime.FlowRuntime, (engine) => engine.execute(Probe, { executionId, payload: { prompt } }))

/** One request: a fixed instruction and the conversation so far. */
export const ask = (history: ReadonlyArray<string>, modelId = "test-model"): ModelRequest.ModelRequest =>
  ModelRequest.ModelRequest.make({
    modelId,
    system: [ModelRequest.SystemPart.make({ text: "Answer in one word." })],
    messages: history.map((text) => ModelRequest.Message.user(text)),
    tools: [],
    params: ModelRequest.GenerationParams.make()
  })

/**
 * The scripted model that answers in a real route's place, and that route's
 * preparation, so the step's key is what this provider would be sent.
 */
export const through = (
  model: Model.Model,
  options: { readonly apiKey?: string; readonly baseUrl?: string } = {}
): { readonly model: Model.Model; readonly route: FlowEngineLike.RouteResolver } => ({
  model,
  route: FlowEngineLike.routeResolver(Result.getOrThrow(Route.openaiChatCompatible({
    id: "model-step-test",
    providerName: "test",
    baseUrl: options.baseUrl ?? "https://provider.invalid",
    apiKey: Redacted.make(options.apiKey ?? "first-key")
  })))
})

/** A complete answer: text, usage, and a settlement. */
export const reply = (text: string): ReadonlyArray<ModelEvent.ModelEvent> => [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "0" }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "0", text }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "0" }),
  ModelEvent.ModelEvent.Usage({ inputTokens: 5, outputTokens: 1 }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
]

/** The text a sequence of events folds to. */
export const textOf = (events: ReadonlyArray<ModelEvent.ModelEvent>): string =>
  ModelEvent.ModelEvent.settledMessage(events).message.content.flatMap((part) =>
    part.type === "text" ? [part.text] : []
  ).join("")

/**
 * A model that counts its calls and answers each from `script`, which sees
 * the call's 1-based number and its request.
 */
export const scripted = (
  script: (call: number, request: ModelRequest.ModelRequest) => Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure>
) => {
  const calls: Array<ModelRequest.ModelRequest> = []
  const model = Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        calls.push(request)
        return script(calls.length, request)
      })
  })
  return { calls, model }
}

/** Provides one runtime to `program`, scoped to it. */
export const within = <A, E, R>(
  layer: Layer.Layer<FlowRuntime.FlowRuntime, unknown, never>,
  program: Effect.Effect<A, E, R | FlowRuntime.FlowRuntime | Scope.Scope>
) => program.pipe(Effect.provide(layer), Effect.scoped)
