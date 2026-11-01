import { describe, expect, it } from "@effect/vitest"
import type { Crypto } from "@smthrs/crypto"
import { Action, Flow, FlowRuntime, Graph } from "@smthrs/flow"
import { Node, Planned } from "@smthrs/plan"
import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import type * as Scope from "effect/Scope"
import { withCrypto } from "./Crypto.ts"
import { layerMemory, makeInstance } from "./MemoryFlowRuntime.ts"

const Label = Context.Reference<string>("ActionDeclared/Label", {
  defaultValue: () => "missing"
})

const InlineHost = Flow.make("ActionDeclared/inline-host", {
  payload: {},
  body: () => Node.succeed(undefined)
})

const runInline = <A, E>(
  effect: Effect.Effect<A, E, Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Scope.Scope>
) =>
  withCrypto(
    Effect.scoped(effect).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(InlineHost, "inline-host")),
      Effect.provide(layerMemory)
    )
  )

describe("Action.make declared overload", () => {
  it.effect("round-trips transformed executeEncoded successes and failures on annotated copies", () =>
    Effect.gen(function*() {
      const success = Action.make({
        name: "Inline/transformed-success",
        success: Schema.NumberFromString,
        execute: Effect.succeed(42)
      })
      const failure = Action.make({
        name: "Inline/transformed-failure",
        error: Schema.NumberFromString,
        execute: Effect.fail(7)
      })
      const successCopies = [
        success,
        success.annotate(Label, "annotated"),
        success.annotateMerge(Context.make(Label, "merged"))
      ]
      const failureCopies = [
        failure,
        failure.annotate(Label, "annotated"),
        failure.annotateMerge(Context.make(Label, "merged"))
      ]

      for (const copy of successCopies) {
        const encoded = yield* runInline(copy.executeEncoded)
        expect(encoded).toBe("42")
        expect(Schema.decodeUnknownSync(copy.successSchema)(encoded)).toBe(42)
      }
      for (const copy of failureCopies) {
        const encoded = yield* runInline(Effect.flip(copy.executeEncoded))
        expect(encoded).toBe("7")
        expect(Schema.decodeUnknownSync(copy.errorSchema)(encoded)).toBe(7)
      }
    }))

  it.effect("reports invalid executeEncoded success and error values as schema defects", () =>
    Effect.gen(function*() {
      const invalid = [
        Action.make({
          name: "Inline/invalid-success",
          success: Schema.NumberFromString,
          execute: Effect.succeed("not-a-number" as unknown as number)
        }),
        Action.make({
          name: "Inline/invalid-error",
          error: Schema.NumberFromString,
          execute: Effect.fail("not-a-number" as unknown as number)
        })
      ]

      for (const action of invalid) {
        const exit = yield* runInline(Effect.exit(action.executeEncoded))
        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) continue
        expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false)
        const defect = exit.cause.reasons.find(Cause.isDieReason)
        expect(defect?.defect).toMatchObject({ _tag: "SchemaError" })
      }
    }))

  it("discriminates declared and inline actions by the first argument", () => {
    const declared = Action.make("Declared/discrimination", {
      payload: { value: Schema.Number }
    })
    const inline = Action.make({
      name: "Inline/discrimination",
      execute: Effect.void
    })

    expect(declared.name).toBe("Declared/discrimination")
    expect("payloadSchema" in declared).toBe(true)
    expect(inline.name).toBe("Inline/discrimination")
    expect("executeEncoded" in inline).toBe(true)
  })

  it("exposes declared schemas, defaults, tier, and idempotency", () => {
    const payload = Schema.Struct({ value: Schema.Number })
    const declared = Action.make("Declared/fields", {
      payload,
      success: Schema.String,
      error: Schema.Number,
      tier: "irreversible",
      idempotencyKey: { operation: "fields" },
      nondeterministic: true
    })
    const defaults = Action.make("Declared/defaults", {
      payload: { value: Schema.Number }
    })

    expect(declared.payloadSchema).toBe(payload)
    expect(declared.successSchema).toBe(Schema.String)
    expect(declared.errorSchema).toBe(Schema.Number)
    expect(declared.tier).toBe("irreversible")
    expect(declared.idempotencyKey).toEqual({ operation: "fields" })
    expect(declared.nondeterministic).toBe(true)
    expect(defaults.tier).toBe("sealed")
    expect(defaults.idempotencyKey).toBeUndefined()
    expect(defaults.nondeterministic).toBeUndefined()
  })

  it("builds an action-call node and preserves planned payload references", () => {
    const declared = Action.make("Declared/call", {
      payload: { value: Schema.Number, nested: Schema.Struct({ label: Schema.String }) },
      success: Schema.String,
      error: Schema.Number
    })
    const value = Planned.make<number>("upstream")
    const label = Planned.make<{ readonly label: string }>("details").label
    const node = declared.call({ value, nested: { label } })

    expect(Node.isNode(node)).toBe(true)
    expect(node.ast).toEqual({
      _tag: "ActionCall",
      action: "Declared/call",
      payload: {
        value: { _tag: "PlannedReference", node: "upstream", path: [] },
        nested: {
          label: { _tag: "PlannedReference", node: "details", path: ["label"] }
        }
      }
    })
  })

  it("adds and merges annotations without mutating the declaration", () => {
    const original = Action.make("Declared/annotations", {
      payload: {},
      annotations: Context.make(Label, "initial")
    })
    const annotated = original.annotate(Label, "added")
    const merged = original.annotateMerge(Context.make(Label, "merged"))

    expect(Context.get(original.annotations, Label)).toBe("initial")
    expect(Context.get(annotated.annotations, Label)).toBe("added")
    expect(Context.get(merged.annotations, Label)).toBe("merged")
  })

  it.effect("registers an implementation that receives decoded payload and executes durably", () =>
    Effect.gen(function*() {
      const NumberPayload = Schema.Struct({ value: Schema.NumberFromString })
      const declared = Action.make("Declared/execution", {
        implementationVersion: "Declared/execution/v1",
        payload: NumberPayload,
        success: Schema.Number,
        tier: "sealed",
        idempotencyKey: "double"
      })
      // Drive the public declared call through a composite body. This verifies
      // the ActionCall node, its payload decoding, and the registered
      // implementation as one durable path.
      const invocation = Flow.make("Declared/execution", {
        payload: NumberPayload,
        success: Schema.Number,
        body: (payload) => declared.call(payload)
      })
      const seen: Array<number> = []
      const layer = declared.toLayer(({ value }) =>
        Effect.sync(() => {
          seen.push(value)
          return value * 2
        }), { implementationVersion: "Declared/execution/v1" }).pipe(Layer.provideMerge(layerMemory))

      expect(Graph.nodes(Graph.build(invocation, { value: 21 }))[0]).toMatchObject({
        kind: "ActionCall",
        payload: { value: 21 }
      })

      const result = yield* withCrypto(
        invocation.execute({ value: 21 }, { executionId: "declared-execution" }).pipe(
          Effect.provide(layer)
        )
      )
      expect(result).toBe(42)
      expect(seen).toEqual([21])
    }))

  it.effect("registers a flow whose body is the one call to the action", () =>
    Effect.gen(function*() {
      const declared = Action.make("Declared/flow-form", {
        payload: { value: Schema.Number },
        success: Schema.Number
      })
      let registered: Flow.Any | undefined
      // The registration seam is internal, so the only way to read what it files
      // is to be the runtime it files with.
      const capturing = Layer.succeed(FlowRuntime.FlowRuntime)(
        {
          register: (flow: Flow.Any) =>
            Effect.sync(() => {
              registered = flow
            })
        } as unknown as FlowRuntime.FlowRuntime["Service"]
      )

      yield* withCrypto(
        Effect.void.pipe(
          Effect.provide(
            declared.toLayer(({ value }) => Effect.succeed(value * 2)).pipe(Layer.provideMerge(capturing))
          )
        )
      )

      expect(registered?._tag).toBe("Declared/flow-form")
      const graph = Graph.build(registered!, { value: 7 })
      expect(Graph.nodes(graph).map((node) => [node.id, node.kind])).toEqual([
        ["root.flow", "ActionCall"],
        ["root", "FlowCall"]
      ])
      expect(Graph.nodes(graph)[0]?.payload).toEqual({ value: 7 })
    }))
})
