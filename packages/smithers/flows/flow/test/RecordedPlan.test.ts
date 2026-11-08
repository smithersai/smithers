import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Node, Plan, StepKey } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import * as SchemaAST from "effect/SchemaAST"
import { expect, it } from "vitest"
import { Action, Flow, Graph } from "../src/index.ts"
import { recordedPlanDrafts } from "../src/internal/RecordedPlan.ts"

const step = Action.make("recorded-plan/step", { payload: { value: Schema.Number }, success: Schema.Number })
const make = (offset: number) =>
  Flow.make("recorded-plan/flow", {
    payload: {},
    success: Schema.Number,
    body: () => step.call({ value: offset })
  })
const key = (body: unknown) =>
  Effect.runPromise(
    StepKey.content({
      body,
      inputs: {},
      layers: [],
      capabilities: {}
    }).pipe(Effect.provide(NodeCrypto.layer))
  )

it("compares callback shape while retaining entropy in step key material", async () => {
  const build = () =>
    Graph.build(
      Flow.make("recorded-plan/flow", {
        payload: {},
        success: Schema.Number,
        body: () => step.call({ value: 1 }).pipe(Node.map((value) => value + 1))
      }),
      {}
    )
  const first = build()
  const second = build()
  expect(await key(recordedPlanDrafts(first))).toBe(await key(recordedPlanDrafts(second)))
  expect(await key(Graph.drafts(first))).not.toBe(await key(Graph.drafts(second)))
  // Projection must never mutate the identities later used at dispatch.
  expect(await key(Graph.drafts(first))).not.toBe(await key(recordedPlanDrafts(first)))
  const compile = (graph: Graph.Graph) =>
    Effect.runPromise(
      Plan.compile({
        planId: "recorded-plan",
        flow: "recorded-plan/flow",
        nodes: Graph.drafts(graph)
      }).pipe(Effect.provide(NodeCrypto.layer))
    )
  const original = await compile(first)
  const rebuilt = await compile(second)
  const mapper = Graph.nodes(first).find((node) => node.kind === "Map")!.id
  expect(original.nodes.find((node) => node.id === mapper)!.key).not.toBe(
    rebuilt.nodes.find((node) => node.id === mapper)!.key
  )
  expect(original.digest).not.toBe(rebuilt.digest)
})

it("keeps input changes and identity-shaped literal payloads in the guard", async () => {
  expect(await key(recordedPlanDrafts(Graph.build(make(1), {})))).not.toBe(
    await key(recordedPlanDrafts(Graph.build(make(2), {})))
  )
  const build = (digest: string) =>
    Graph.build(
      Flow.make("literal", {
        payload: {},
        success: Schema.Unknown,
        body: () =>
          Node.succeed({
            _tag: "FunctionIdentity",
            algorithm: "sha256-source-ephemeral/v4",
            digest,
            resumeDigest: "same"
          })
      }),
      {}
    )
  expect(await key(recordedPlanDrafts(build("first")))).not.toBe(await key(recordedPlanDrafts(build("second"))))
})

it("compares a captured callback by its shape and captures, as a minifier renames it", async () => {
  const build = (value: number, body: () => unknown) =>
    Graph.build(
      Flow.make("captured", {
        payload: {},
        success: Schema.Number,
        body: Node.capture({ value }, body as (this: { readonly value: number }) => Node.Node<number>)
      }),
      {}
    )
  // One callback as two minified bundles name it, and as an edit changes it.
  const bundled = (name: string, value: string) =>
    new Function(name, `return function(){return ${name}.call({value:${value}})}`)(step) as () => unknown
  const first = build(1, bundled("s", "this.value"))
  const rebuilt = build(1, bundled("t", "this.value"))
  expect(await key(recordedPlanDrafts(first))).toBe(await key(recordedPlanDrafts(rebuilt)))
  // A cache still tells them apart: its identity is the exact source.
  expect(await key(Graph.drafts(first))).not.toBe(await key(Graph.drafts(rebuilt)))
  const edited = build(1, bundled("t", "this.value+1"))
  expect(await key(recordedPlanDrafts(first))).not.toBe(await key(recordedPlanDrafts(edited)))
  const recaptured = build(2, bundled("s", "this.value"))
  expect(await key(recordedPlanDrafts(first))).not.toBe(await key(recordedPlanDrafts(recaptured)))
})

it("keeps opaque bound callback source fail-closed", async () => {
  const build = () =>
    Graph.build(
      Flow.make("opaque", {
        payload: {},
        success: Schema.Number,
        body: (() => step.call({ value: 1 })).bind(null)
      }),
      {}
    )
  expect(await key(recordedPlanDrafts(build()))).not.toBe(await key(recordedPlanDrafts(build())))
})

it("compares branch predicate source without re-keying its declaration", async () => {
  const build = (edited: boolean) => {
    const predicate = edited ? (value: number) => value > 0 : (value: number) => 0 < value
    return Graph.build(
      Flow.make("branch", {
        payload: {},
        success: Schema.Number,
        body: () =>
          Node.succeed(1).pipe(Node.branch({
            if: predicate,
            then: () => Node.succeed(2),
            else: () => Node.succeed(3)
          }))
      }),
      {}
    )
  }
  expect(await key(recordedPlanDrafts(build(false)))).toBe(await key(recordedPlanDrafts(build(false))))
  expect(await key(recordedPlanDrafts(build(false)))).not.toBe(await key(recordedPlanDrafts(build(true))))
  expect(await key(Graph.drafts(build(false)))).not.toBe(await key(Graph.drafts(build(false))))
})

it("retains filter source and captured check values in aggregate schema identities", async () => {
  const build = (edited: boolean, limit: number) => {
    const check = edited ? (_value: string) => undefined : (_value: string) => {
      return undefined
    }
    const error = Schema.String.check(
      new SchemaAST.Filter((_value) => undefined),
      new SchemaAST.Filter(Node.capture({ limit }, check))
    )
    return Graph.build(
      Flow.make("filter", {
        payload: {},
        success: Schema.Number,
        body: () => Node.succeed(1).pipe(Node.catch({ error, onFailure: () => Node.succeed(0) }))
      }),
      {}
    )
  }
  expect(await key(recordedPlanDrafts(build(false, 1)))).toBe(await key(recordedPlanDrafts(build(false, 1))))
  expect(await key(recordedPlanDrafts(build(false, 1)))).not.toBe(await key(recordedPlanDrafts(build(true, 1))))
  expect(await key(recordedPlanDrafts(build(false, 1)))).not.toBe(await key(recordedPlanDrafts(build(false, 2))))
})
