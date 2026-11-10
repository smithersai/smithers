/**
 * VIP-44: an action's stored results go through the injected
 * `RpcSerialization`'s `codecFor`, and decode back through the same one.
 */
import { describe, expect } from "@effect/vitest"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as FastCheck from "fast-check"
import { FlowEngine } from "../src/index.ts"
import { effect } from "./Harness.ts"

const Value = Schema.Struct({
  at: Schema.Date,
  count: Schema.BigInt,
  tags: Schema.ReadonlySet(Schema.String),
  bytes: Schema.Uint8Array,
  name: Schema.String
})
type Value = typeof Value.Type

class Refused extends Schema.TaggedError<Refused>()("StoredSerialization/Refused", { value: Value }) {}

const value: FastCheck.Arbitrary<Value> = FastCheck.record({
  at: FastCheck.date({ noInvalidDate: true, min: new Date(-8.64e15), max: new Date(8.64e15) }),
  count: FastCheck.bigInt(),
  tags: FastCheck.array(FastCheck.string(), { maxLength: 5 }).map((tags) => new Set(tags) as ReadonlySet<string>),
  bytes: FastCheck.uint8Array({ maxLength: 8 }),
  name: FastCheck.string()
})

const samples = FastCheck.sample(value, {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 25),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) })
})

/** Every serializer Effect's `RpcSerialization` ships. */
const serializers = [
  ["json", RpcSerialization.layerJson],
  ["ndjson", RpcSerialization.layerNdjson],
  ["jsonRpc", RpcSerialization.layerJsonRpc()],
  ["ndJsonRpc", RpcSerialization.layerNdJsonRpc()],
  ["schema-binary", RpcSerialization.layerSchemaBinary()],
  ["schema-binary fingerprinted", RpcSerialization.layerSchemaBinary({ fingerprintPayloads: true })]
] as const

const Produce = Action.make("StoredSerialization/produce", {
  payload: { index: Schema.Number, fail: Schema.Boolean },
  success: Value,
  error: Refused
})

const Round = Flow.make("StoredSerialization/round", {
  payload: { index: Schema.Number, fail: Schema.Boolean },
  success: Value,
  error: Refused,
  body: (payload) => Produce.call(payload)
})

const program = (serialization: Layer.Layer<RpcSerialization.RpcSerialization>) =>
  Layer.mergeAll(
    Produce.toLayer(({ fail, index }) =>
      fail ? Effect.fail(new Refused({ value: samples[index]! })) : Effect.succeed(samples[index]!)
    ),
    Interpreter.layer(Round)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory.pipe(Layer.provide(serialization)))
  )

describe("action results through each RpcSerialization", () => {
  for (const [name, serialization] of serializers) {
    effect(`round-trip successes and typed failures under ${name}`, () =>
      Effect.gen(function*() {
        for (let index = 0; index < samples.length; index++) {
          const succeeded = yield* Round.execute({ index, fail: false }, { executionId: `ok-${index}` })
          expect(succeeded).toEqual(samples[index])
          const failed = yield* Round.execute({ index, fail: true }, { executionId: `fail-${index}` }).pipe(
            Effect.exit
          )
          const error = Exit.isFailure(failed) ? failed.cause.reasons.find(Cause.isFailReason)?.error : undefined
          expect(error).toBeInstanceOf(Refused)
          expect((error as Refused).value).toEqual(samples[index])
        }
      }).pipe(Effect.provide(program(serialization))))
  }
})

describe("a faulty injected serializer", () => {
  const faulty = Layer.succeed(RpcSerialization.RpcSerialization)({
    ...RpcSerialization.json,
    codecFor: () => {
      throw new Error("codec unavailable")
    }
  })

  effect("turns the unencodable result into a defect, not a stored value", () =>
    Effect.gen(function*() {
      const exit = yield* Round.execute({ index: 0, fail: false }, { executionId: "faulty" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("codec unavailable")
    }).pipe(Effect.provide(program(faulty))))
})

describe("a serializer whose values are not JSON", () => {
  // Keeps every value as its Type, as an in-process frame serializer may.
  const identity = Layer.succeed(RpcSerialization.RpcSerialization)({
    ...RpcSerialization.json,
    contentType: "application/x-identity",
    codecFor: Schema.toType as RpcSerialization.CodecFor
  })
  const Nothing = Action.make("StoredSerialization/nothing", { payload: {}, success: Schema.Undefined })
  const Empty = Flow.make("StoredSerialization/empty", {
    payload: {},
    success: Schema.Undefined,
    body: () => Nothing.call({})
  })

  effect("keeps an undefined result undefined instead of rewriting it as JSON null", () =>
    Effect.gen(function*() {
      expect(yield* Empty.execute({}, { executionId: "undefined-result" })).toBeUndefined()
    }).pipe(Effect.provide(
      Layer.mergeAll(Nothing.toLayer(() => Effect.succeed(undefined)), Interpreter.layer(Empty)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory.pipe(Layer.provide(identity)))
      )
    )))
})

describe("the stored serializer and an action body", () => {
  const Probe = Action.make("StoredSerialization/probe", { payload: {}, success: Schema.String })
  const Look = Flow.make("StoredSerialization/look", {
    payload: {},
    success: Schema.String,
    body: () => Probe.call({})
  })

  effect("pins only the stored representation, never the RpcSerialization the body sees", () =>
    Effect.gen(function*() {
      expect(yield* Look.execute({}, { executionId: "body-serialization" })).toBe("none")
    }).pipe(Effect.provide(
      Layer.mergeAll(
        Probe.toLayer(() =>
          Effect.map(
            Effect.serviceOption(RpcSerialization.RpcSerialization),
            (found) => found._tag === "Some" ? found.value.contentType : "none"
          )
        ),
        Interpreter.layer(Look)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory.pipe(Layer.provide(RpcSerialization.layerSchemaBinary())))
      )
    )))
})
