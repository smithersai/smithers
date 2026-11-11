import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import * as Cell from "@smthrs/harness/Cell"
import * as Model from "@smthrs/model/Model"
import { Node } from "@smthrs/plan"
import { Deferred, Effect, Layer, Option, Schema, Scope, Stream } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import * as Budget from "../src/Budget.ts"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"
import materialApproval from "./fixtures/cell-call-material-approval-required.json" with { type: "json" }
import materialV1 from "./fixtures/cell-call-material-effect-rc115.json" with { type: "json" }
import materialEncoding3 from "./fixtures/cell-call-material-key-encoding-3.json" with { type: "json" }
import materialEncoding4 from "./fixtures/cell-call-material-key-encoding-4.json" with { type: "json" }
import materialModelErrorCause from "./fixtures/cell-call-material-model-error-cause.json" with { type: "json" }
import materialCost from "./fixtures/cell-call-material-reported-cost.json" with { type: "json" }
import material112 from "./fixtures/cell-call-material-v1.json" with { type: "json" }
import * as V1 from "./fixtures/CellCallV1.ts"

const call = new Cell.Call({
  flowName: "fs/write",
  input: { path: "out.txt", text: "done" },
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  placement: Option.none(),
  identity: new Cell.CallIdentity({
    session: "golden-session",
    frame: 0,
    cell: "golden-cell-digest",
    ordinal: 0,
    declaration: "golden-declaration-digest",
    layers: []
  })
})

const flow = Flow.make("agent/test/cell-call-identity", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

/** Dispatches the fixed call under `encoding` and returns its key and the material hashed on the way. */
const observe = async (encoding: FlowEngine.KeyEncoding) => {
  const material: Array<string> = []
  const crypto = Layer.effect(EffectDigest.Digest)(Effect.map(EffectDigest.Digest, (live) => ({
    ...live,
    digest: (algorithm: EffectDigest.Algorithm, bytes: Uint8Array) => {
      material.push(new TextDecoder().decode(bytes))
      return live.digest(algorithm, bytes)
    }
  }))).pipe(Layer.provideMerge(NodeCrypto.layer))
  const observed = await Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const settled = Deferred.makeUnsafe<Cell.CallResult, unknown>()
    yield* engine.register(flow, () =>
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({
          model: Model.make({ stream: () => Stream.empty }),
          route: { prepare: () => Effect.die("cell calls must not prepare a model request") },
          layers: ["golden-host-layer"],
          capabilities: {},
          calls: {
            run: () =>
              Effect.map(Action.CurrentInvocationKey, (key) =>
                Cell.CallResult.new({ outcome: "success", value: key ?? "missing" }))
          }
        })
        return yield* port.call(call)
      }).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Deferred.done(settled, exit)
        )
      )).pipe(Scope.provide(scope))
    yield* engine.execute(flow, { executionId: "exec-golden", payload: {}, discard: true })
    return yield* Deferred.await(settled)
  }).pipe(
    Effect.provide(
      Layer.mergeAll(FlowEngine.layerMemory, crypto, Budget.layerUnbounded(), QuotaPolicy.layerUnclassified())
    ),
    Effect.provideService(FlowEngine.ActionKeyEncoding, encoding),
    Effect.scoped,
    Effect.runPromise
  )
  return { material, observed }
}

it("pins the complete canonical material delivered to SHA-256", async () => {
  const { material, observed } = await observe(FlowEngine.keyEncodings[0])
  // Preserve the archived checksum and pin the complete current preimage.
  // An Effect upgrade is not transparent replay compatibility.
  expect(`key1_${createHash("sha256").update(V1.canonical(material112)).digest("hex")}`).toBe(V1.key)
  expect(V1.effect115Key).not.toBe(V1.key)
  const archived115 = V1.canonical(materialV1)
  expect(`key1_${createHash("sha256").update(archived115).digest("hex")}`).toBe(V1.effect115Key)
  const expected = V1.canonical(materialApproval)
  expect(`key1_${createHash("sha256").update(expected).digest("hex")}`).toBe(V1.approvalRequiredKey)
  expect(V1.approvalRequiredKey).not.toBe(V1.effect115Key)
  expect(material).not.toContain(archived115)
  const reportedCost = V1.canonical(materialCost)
  expect(`key1_${createHash("sha256").update(reportedCost).digest("hex")}`).toBe(V1.reportedCostKey)
  expect(V1.reportedCostKey).not.toBe(V1.approvalRequiredKey)
  expect(material).not.toContain(expected)
  expect(material).not.toContain(reportedCost)
  const modelErrorCause = V1.canonical(materialModelErrorCause)
  expect(`key1_${createHash("sha256").update(modelErrorCause).digest("hex")}`).toBe(V1.modelErrorCauseKey)
  expect(V1.modelErrorCauseKey).not.toBe(V1.reportedCostKey)
  // Key encoding 3 names itself in the same material.
  const encoding3 = V1.canonical(materialEncoding3)
  expect(`key1_${createHash("sha256").update(encoding3).digest("hex")}`).toBe(V1.keyEncoding3Key)
  // Key encoding 4 does too, and is what a new record is written under.
  const current = V1.canonical(materialEncoding4)
  expect(`key1_${createHash("sha256").update(current).digest("hex")}`).toBe(V1.keyEncoding4Key)
  expect(material).not.toContain(modelErrorCause)
  expect(material).not.toContain(encoding3)
  expect(material).toContain(current)
  expect(observed.value).toBe(V1.keyEncoding4Key)
})

it("derives the encoding-3 key under key encoding 3, so a recorded call is found again", async () => {
  const { material, observed } = await observe(3)
  expect(material).toContain(V1.canonical(materialEncoding3))
  expect(observed.value).toBe(V1.keyEncoding3Key)
})

it("derives the pre-encoding-3 key under key encoding 2, so a recorded call is found again", async () => {
  const { material, observed } = await observe(2)
  expect(material).toContain(V1.canonical(materialModelErrorCause))
  expect(observed.value).toBe(V1.modelErrorCauseKey)
})
