import { syncCrypto } from "@smthrs/crypto"
import { Node } from "@smthrs/plan"
import * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, test } from "vitest"
import { Action, Flow, Graph, RetryPolicy, StepIdentity } from "../src/index.ts"

const ReadFile = Action.make("bench/readFile", {
  payload: { path: Schema.String },
  success: Schema.String
})

const Transform = Action.make("bench/transform", {
  payload: { content: Schema.String, index: Schema.Number },
  success: Schema.Struct({ digest: Schema.String, lines: Schema.Number })
})

const Summarize = Action.make("bench/summarize", {
  payload: { count: Schema.Number },
  success: Schema.Number
})

const ChildFlow = Flow.make("bench/child", {
  payload: { path: Schema.String, index: Schema.Number },
  success: Schema.Struct({ digest: Schema.String, lines: Schema.Number }),
  body: ({ path, index }) =>
    ReadFile.call({ path }).pipe(
      Node.bindPlanned((content) => Transform.call({ content, index }))
    )
})

const PipelineFlow = Flow.make("bench/pipeline", {
  payload: { files: Schema.Array(Schema.String) },
  success: Schema.Number,
  body: ({ files }) =>
    Node.all(
      Object.fromEntries(files.map((path, index) => [`f${index}`, ChildFlow.call({ path, index })]))
    ).pipe(
      Node.map((results) => Object.keys(results).length),
      Node.bindPlanned((count) => Summarize.call({ count }))
    )
})

const eightFiles = Array.from({ length: 8 }, (_, i) => `packages/smithers/flows/src/file-${i}.ts`)

const provideSync = <A, E>(effect: Effect.Effect<A, E, EffectDigest.Digest>) =>
  Effect.provideService(effect, EffectDigest.Digest, syncCrypto)

const scopeEffect = provideSync(StepIdentity.allocationScope({
  kind: "action",
  name: "bench/transform",
  idempotency: { path: "src/Engine.ts", revision: "a".repeat(40) },
  site: "node-7/branch-2"
}))

const invKeyEffect = provideSync(StepIdentity.invocationKey({
  runId: "run-bench-001",
  parentScope: "action/15:bench/transform/g:15:node-7/branch-2",
  ordinal: 12,
  tier: "compensable"
}))

const retryPolicy = RetryPolicy.transient
const sampleError = new Error("ETIMEDOUT")

const buildGraph = Graph.build
const graphNodes = Graph.nodes
const nextDelayFn = RetryPolicy.nextDelay
const decideFn = RetryPolicy.decide
const runSync = Effect.runSync
const opts = { time: 120, warmupTime: 30 }

describe("@smthrs/flow", () => {
  test("Graph.build + Graph.nodes on 8-way nested flow pipeline", async ({ bench }) => {
    await bench("Graph.build (8 parallel subflows)", () => {
      graphNodes(buildGraph(PipelineFlow.call({ files: eightFiles })))
    }).run(opts)
  })

  test("StepIdentity.allocationScope with object idempotency", async ({ bench }) => {
    await bench("StepIdentity.allocationScope", () => {
      runSync(scopeEffect)
    }).run(opts)
  })

  test("StepIdentity.invocationKey derivation", async ({ bench }) => {
    await bench("StepIdentity.invocationKey", () => {
      runSync(invKeyEffect)
    }).run(opts)
  })

  test("RetryPolicy.nextDelay and RetryPolicy.decide", async ({ bench }) => {
    await bench("RetryPolicy.nextDelay", () => {
      nextDelayFn(retryPolicy, 3, { random: 0.5 })
    }).run(opts)

    await bench("RetryPolicy.decide", () => {
      decideFn(retryPolicy, { attempt: 2, elapsedMs: 1_500, error: sampleError, random: 0.5 })
    }).run(opts)
  })

  test("Flow.make + Action.make declaration construction", async ({ bench }) => {
    await bench("Action.make + Flow.make", () => {
      const act = Action.make("bench/ephemeral/act", {
        payload: { x: Schema.Number },
        success: Schema.Number
      })
      Flow.make("bench/ephemeral/flow", {
        payload: { x: Schema.Number },
        success: Schema.Number,
        body: ({ x }) => act.call({ x })
      })
    }).run(opts)
  })
})
