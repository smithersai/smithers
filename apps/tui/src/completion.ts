/** Bounded background model calls, sealed in the native durable engine. */
import * as Budget from "@smthrs/agent/Budget"
import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as ModelStep from "@smthrs/agent/ModelStep"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Capability, Permission } from "@smthrs/capability"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Evaluator from "@smthrs/model/Evaluator"
import { ModelError } from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Node } from "@smthrs/plan"
import { BunRuntime } from "@smthrs/platform-bun"
import { NodeRuntime } from "@smthrs/platform-node"
import { Effect, Layer, Logger, ManagedRuntime, Schema, Stream } from "effect"
import { createHash } from "node:crypto"
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs"
import { join } from "node:path"
import * as Log from "./log.ts"
import * as Monitors from "./monitors.ts"
import * as Session from "./session.ts"

export interface Input {
  /** Stable identity of the persisted request; omitted callers are keyed by the complete request. */
  readonly id?: string
  readonly system: string
  readonly prompt: string
  readonly seat: string
}

const completion = Flow.make("tui/completion", {
  payload: { system: Schema.String, prompt: Schema.String, seat: Schema.String },
  success: Schema.String,
  error: Schema.Union([Seat.SeatUnresolved, ModelStep.Failure]),
  body: () => Node.succeed("")
})

const paidReading = Schema.Struct({
  answers: Evaluator.RawAnswers,
  latencyMs: Schema.Number,
  usage: Schema.optional(Schema.Struct({
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
    modelId: Schema.optional(Schema.String),
    costUsd: Schema.optional(Schema.Number)
  }))
})
const reading = Flow.make("tui/monitor-reading", {
  payload: { watch: Schema.String, before: Schema.String, after: Schema.String },
  success: paidReading,
  error: Schema.Union([
    Evaluator.EvaluatorError,
    HarnessError,
    Budget.AccountingUnavailable,
    Budget.BudgetExceeded,
    Budget.Skipped
  ]),
  body: () => Node.succeed({ answers: {}, latencyMs: 0 })
})

export const make = (options: {
  readonly cwd: string
  readonly seats: Layer.Layer<SeatResolver.SeatResolver>
  readonly budget: Layer.Layer<Budget.Budget>
  readonly judge: Layer.Layer<Evaluator.Evaluator>
}) => {
  const native = process.versions.bun === undefined ? NodeRuntime : BunRuntime
  // A private parent also protects the SQLite WAL and shared-memory files.
  const directory = join(Session.directory(options.cwd), "completions")
  let runtime: ManagedRuntime.ManagedRuntime<FlowRuntime.FlowRuntime, never> | undefined
  const open = () => {
    if (runtime !== undefined) return runtime
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    const filename = join(directory, "engine.db")
    closeSync(openSync(filename, "a", 0o600))
    chmodSync(filename, 0o600)
    const registration = Layer.effectDiscard(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.register(reading, (input) =>
        Effect.gen(function*() {
          const budget = yield* Budget.current
          const key = "monitor-reading"
          const charge = (usage: Evaluator.Usage | undefined) =>
            usage === undefined ?
              Effect.void :
              budget.record(key, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }, usage.modelId)
          const result = yield* Action.make({
            name: "tui/monitor-reading/evaluate",
            success: paidReading,
            error: Schema.Union([
              Evaluator.EvaluatorError,
              Budget.AccountingUnavailable,
              Budget.BudgetExceeded,
              Budget.Skipped
            ]),
            tier: "sealed",
            idempotencyKey: key,
            // The evaluator's typed deadline preserves usage on a paid timeout.
            execute: Effect.gen(function*() {
              const verdict = yield* budget.admitReading(key)
              if (verdict._tag === "refuse") return yield* Effect.fail(verdict.failure)
              return yield* (yield* Evaluator.Evaluator).evaluate({
                state: { watching: input.watch, before: input.before, after: input.after },
                questions: Monitors.question
              })
            })
          }).pipe(
            Effect.tapError((error) => error instanceof Evaluator.EvaluatorError ? charge(error.usage) : Effect.void)
          )
          yield* charge(result.usage)
          return result
        }))
      yield* engine.register(completion, (input) =>
        Effect.gen(function*() {
          const seat = yield* (yield* SeatResolver.SeatResolver).resolve(input.seat)
          // FlowEngineLike is the shared model boundary: it admits, seals and charges
          // every physical provider attempt, including failed attempts and replays.
          const port = yield* FlowEngineLike.make({ model: seat.model, route: seat.route })
          const request = ModelRequest.ModelRequest.make({
            modelId: seat.modelId,
            system: [ModelRequest.SystemPart.make({ text: input.system })],
            messages: [ModelRequest.Message.user([ModelRequest.TextPart.make({ text: input.prompt })])],
            tools: [],
            toolChoice: "none",
            // Subscription routes refuse maxTokens; admission and call time bound the work.
            params: ModelRequest.GenerationParams.make({})
          })
          const events = Array.from(
            yield* Stream.runCollect(port.sealStep({
              request,
              modelCallMs: 60_000,
              keyMaterial: {
                version: "flows/key-material/v2",
                kind: "sealed",
                body: { _tag: "ModelCall", request },
                inputs: [],
                layers: ["tui/completion/v1"],
                capabilities: [],
                effects: undefined,
                placement: undefined
              }
            }))
          )
          const settled = ModelEvent.ModelEvent.settledMessage(events)
          if (settled.message.stopReason !== "stop") {
            return yield* Effect.fail(new ModelError({ code: "unknown", message: "Answer incomplete" }))
          }
          return settled.message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")
        }))
    })).pipe(Layer.provide(Layer.mergeAll(options.seats, options.budget, options.judge, QuotaPolicy.layerDefault())))
    const opened = ManagedRuntime.make(
      native.layerHost(
        {
          filename,
          workspaceRoot: options.cwd,
          owner: { hostId: "tui-completion" },
          signals: [],
          // The operator already chose this host's model seats. No filesystem,
          // process or contributed flow capability is granted to background work.
          rules: [
            new Permission.Rule({
              effect: "allow",
              pattern: new Capability.CapabilityPattern({ action: "model:call", resource: "*" })
            })
          ]
        },
        registration,
        Layer.empty
      ).pipe(
        Layer.orDie,
        Layer.provide(Logger.layer([Logger.make(({ message }) => Log.write("completion.engine", message))]))
      )
    )
    runtime = opened
    return opened
  }
  return {
    complete: (input: Input): Promise<string> => {
      const executionId = `tui-completion-${
        createHash("sha256").update(
          JSON.stringify([directory, input.id ?? null, input.system, input.prompt, input.seat])
        ).digest(
          "hex"
        )
      }`
      return open().runPromise(Effect.flatMap(FlowRuntime.FlowRuntime, (engine) =>
        engine.execute(completion, {
          executionId,
          payload: { system: input.system, prompt: input.prompt, seat: input.seat }
        })))
    },
    judge: (input: Monitors.Judged): Promise<boolean> => {
      const executionId = `tui-monitor-${
        createHash("sha256").update(
          JSON.stringify([directory, input.id ?? null, input.watch, input.before, input.after])
        ).digest(
          "hex"
        )
      }`
      return Monitors.jev(() =>
        open().runPromise(Effect.flatMap(FlowRuntime.FlowRuntime, (engine) =>
          engine.execute(reading, {
            executionId,
            payload: { watch: input.watch, before: input.before, after: input.after }
          })))
      )(input)
    },
    dispose: () => runtime?.dispose() ?? Promise.resolve()
  }
}
