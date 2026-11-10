/**
 * VIP-44: engine-store keeps action results as the JSON value their
 * serializer's `codecFor` encodes, so it accepts only a serializer whose
 * `codecFor` is the JSON codec and refuses any other when it is built.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as EngineStore from "../src/EngineStore.ts"
import { UnstorableSerialization } from "../src/Errors.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "serialization" as never, changeId: "serialization" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const store = (serialization: Layer.Layer<RpcSerialization.RpcSerialization>) =>
  EngineStore.layer({
    owner: { hostId: "serialization" },
    journalSource: "serialization",
    isAlive: () => Effect.succeed(true)
  }).pipe(Layer.provideMerge(Layer.mergeAll(
    TestStores.layerAt(":memory:"),
    StepBoundary.layerTest(),
    Layer.succeed(Jj.Jj, jj),
    serialization
  )))

const Stamp = Action.make("StoredSerialization/stamp", {
  payload: {},
  success: Schema.Struct({ at: Schema.Date, count: Schema.BigInt })
})

const Round = Flow.make("StoredSerialization/round", {
  payload: {},
  success: Schema.Struct({ at: Schema.Date, count: Schema.BigInt }),
  body: Node.capture({ action: Stamp.name }, () => Stamp.call({}))
})

const stamped = { at: new Date(0), count: 12345n }

describe("engine-store serializers", () => {
  for (
    const [name, serialization] of [
      ["json", RpcSerialization.layerJson],
      ["ndjson", RpcSerialization.layerNdjson],
      ["jsonRpc", RpcSerialization.layerJsonRpc()],
      ["ndJsonRpc", RpcSerialization.layerNdJsonRpc()]
    ] as const
  ) {
    it.effect(`stores and replays action results under ${name}, which shares the JSON codec`, () =>
      withCrypto(
        Round.execute({}, { executionId: `stamp-${name}` }).pipe(
          Effect.provide(Interpreter.layerWithImplementations(Round, Stamp.toLayer(() => Effect.succeed(stamped)))),
          Effect.map((value) => expect(value).toEqual(stamped)),
          Effect.provide(store(serialization)),
          Effect.scoped
        )
      ))
  }

  for (
    const [name, serialization] of [
      ["schema-binary", RpcSerialization.layerSchemaBinary()],
      ["schema-binary fingerprinted", RpcSerialization.layerSchemaBinary({ fingerprintPayloads: true })]
    ] as const
  ) {
    it.effect(`refuses ${name} when the store is built`, () =>
      withCrypto(
        Effect.gen(function*() {
          const exit = yield* Effect.exit(Layer.build(store(serialization)))
          const defect = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined
          expect(defect).toBeInstanceOf(UnstorableSerialization)
          expect(defect).toMatchObject({
            code: "unstorable_serialization",
            contentType: "application/vnd.effect.rpc+schema-binary"
          })
        }).pipe(Effect.scoped)
      ))
  }
})
