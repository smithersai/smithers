import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node, Planned } from "@smthrs/plan"
import { Context, Effect, Schema } from "effect"

describe("Flow body and calls", () => {
  it("stores a plan-time body typed with the decoded payload", () => {
    const body = (payload: { readonly count: number }) => {
      expectTypeOf(payload.count).toEqualTypeOf<number>()
      return Node.succeed(payload.count + 1)
    }
    const flow = Flow.make("Authoring/body", {
      payload: { count: Schema.NumberFromString },
      success: Schema.Number,
      body
    })

    expect(flow.body).toBe(body)
    expect(flow.body?.({ count: 2 }).ast).toEqual({ _tag: "Succeed", value: 3 })
  })

  it("builds an inline flow-call node with planned payload references", () => {
    const flow = Flow.make("Authoring/call", {
      payload: { count: Schema.Number },
      success: Schema.String,
      error: Schema.Number,
      body: () => Node.succeed("ready")
    })
    const count = Planned.make<number>("upstream")

    expect(flow.call({ count }).ast).toEqual({
      _tag: "FlowCall",
      flow: "Authoring/call",
      mode: "inline",
      payload: {
        count: { _tag: "PlannedReference", node: "upstream", path: [] }
      }
    })
  })

  it("preserves the body when annotations are added or merged", () => {
    const body = ({ count }: { readonly count: number }) => Node.succeed(count)
    const flow = Flow.make("Authoring/body-annotations", {
      payload: { count: Schema.Number },
      success: Schema.Number,
      body
    })

    expect(flow.annotate(Flow.Capabilities, ["fs:read"]).body).toBe(body)
    expect(flow.annotateMerge(Context.make(Flow.Capabilities, ["fs:write"])).body).toBe(body)
  })

  it("carries a declared description through annotation", () => {
    // A catalog that lists a flow reads the description off the declaration
    // without importing the module, so it has to be a literal on the
    // declaration and it has to survive every combinator that rebuilds one.
    const flow = Flow.make("Authoring/described", {
      description: "Says what it does.",
      payload: { count: Schema.Number },
      body: () => Node.succeed(undefined)
    })

    expect(flow.description).toBe("Says what it does.")
    expect(flow.annotate(Flow.Capabilities, ["fs:read"]).description).toBe("Says what it does.")
    expect(flow.annotateMerge(Context.make(Flow.Capabilities, ["fs:write"])).description).toBe(
      "Says what it does."
    )
    expect(Flow.make("Authoring/undescribed", { payload: {}, body: () => Node.succeed(undefined) }).description)
      .toBeUndefined()
  })

  it("declares a capability ceiling a catalog can read without importing the module", () => {
    // The literal and the annotation are the same ceiling. Writing it as a
    // literal is what lets a registry project this flow's authority from the
    // source text, which an annotation built at run time cannot do.
    const declared = Flow.make("Authoring/ceiling", {
      capabilities: ["fs:read:**"],
      payload: {},
      body: () => Node.succeed(undefined)
    })
    const beside = Flow.make("Authoring/ceiling-beside", {
      capabilities: ["fs:read:**"],
      annotations: Context.make(Flow.SuspendOnFailure, true),
      payload: {},
      body: () => Node.succeed(undefined)
    })

    expect(Context.get(declared.annotations, Flow.Capabilities)).toEqual(["fs:read:**"])
    expect(Context.get(beside.annotations, Flow.Capabilities)).toEqual(["fs:read:**"])
    expect(Context.get(beside.annotations, Flow.SuspendOnFailure)).toBe(true)
    // An undeclared ceiling stays the reference's own default rather than
    // becoming an empty declaration.
    expect(Context.get(
      Flow.make("Authoring/no-ceiling", { payload: {}, body: () => Node.succeed(undefined) }).annotations,
      Flow.Capabilities
    )).toEqual([])
  })

  it("recognizes its own flows and nothing else", () => {
    const flow = Flow.make("Authoring/recognized", { payload: {}, body: () => Node.succeed(undefined) })

    expect(Flow.isFlow(flow)).toBe(true)
    // A look-alike from another flow model carries its own type id, so a host
    // loading a module can tell which model it found instead of guessing.
    expect(Flow.isFlow({ _tag: "Authoring/recognized", body: () => Node.succeed(undefined) })).toBe(false)
    expect(Flow.isFlow(undefined)).toBe(false)
    expect(Flow.isFlow(null)).toBe(false)
    expect(Flow.isFlow("Authoring/recognized")).toBe(false)
  })
})

describe("Flow trampoline outcomes", () => {
  const roundTrip = <A extends Flow.Outcome>(value: A) =>
    Effect.flatMap(
      Schema.encodeEffect(Schema.toCodecJson(Flow.Outcome))(value),
      Schema.decodeEffect(Schema.toCodecJson(Flow.Outcome))
    )

  it.effect("constructs and round trips done", () =>
    Effect.gen(function*() {
      const node = Flow.done({ answer: 42 })
      expect(node.ast).toEqual({ _tag: "Succeed", value: { _tag: "Done", value: { answer: 42 } } })
      const value = (node.ast as { readonly value: Flow.Outcome }).value
      expect(value).toEqual({ _tag: "Done", value: { answer: 42 } })
      expect(yield* roundTrip(value)).toEqual(value)
    }))

  it("constructs a typed next-flow invocation as a visible handoff node", () => {
    const flow = Flow.make("Authoring/next", {
      payload: { count: Schema.NumberFromString },
      body: () => Node.succeed(undefined)
    })
    const node = flow.to({ count: 2 })
    expectTypeOf(node).toEqualTypeOf<Node.Node<Flow.To<{ readonly count: number }>>>()
    expect(node.ast).toEqual({
      _tag: "FlowCall",
      flow: "Authoring/next",
      mode: "handoff",
      payload: { count: 2 }
    })
  })

  it.effect("constructs and round trips park with the waiting reason vocabulary", () =>
    Effect.gen(function*() {
      const node = Flow.park({ reason: "approval", wakeAt: 100, token: "request-1" })
      const value = (node.ast as { readonly value: Flow.Park }).value
      expect(value).toEqual({
        _tag: "Park",
        reason: { reason: "approval", wakeAt: 100, token: "request-1" }
      })
      expect(yield* roundTrip(value)).toEqual(value)
    }))

  it.effect("constructs the same park from a positional reason and token", () =>
    Effect.gen(function*() {
      const node = Flow.park("approval", "request-1")
      const value = (node.ast as { readonly value: Flow.Park }).value
      expect(value).toEqual({
        _tag: "Park",
        reason: { reason: "approval", token: "request-1" }
      })
      // The two forms are the same request, so the record spelling of this call
      // produces the identical node.
      expect(value).toEqual(
        (Flow.park({ reason: "approval", token: "request-1" }).ast as { readonly value: Flow.Park }).value
      )
      expect(yield* roundTrip(value)).toEqual(value)
    }))

  it.effect("omits the token of a positional park that named none", () =>
    Effect.gen(function*() {
      const node = Flow.park("quota")
      const value = (node.ast as { readonly value: Flow.Park }).value
      // Absent, not empty: a wake handler compares tokens, and `""` is a token
      // that something could match.
      expect(value).toEqual({ _tag: "Park", reason: { reason: "quota" } })
      expect("token" in value.reason).toBe(false)
      expect(yield* roundTrip(value)).toEqual(value)
    }))
})

describe("Flow authoring annotations", () => {
  it("defaults capabilities and attaches all authoring annotations", () => {
    const effects: Flow.Effects = {
      reads: ["src/**"],
      writes: ["dist/**"],
      boundaryMode: "hard"
    }
    const placement: Flow.PlacementDirective = { host: "sandbox" }
    const original = Flow.make("Authoring/annotations", { payload: {}, body: () => Node.succeed(undefined) })
    const annotated = original
      .annotate(Flow.Capabilities, ["fs:read"])
      .annotate(Flow.EffectsDeclaration, effects)
      .annotate(Flow.Placement, placement)

    expect(Context.get(original.annotations, Flow.Capabilities)).toEqual([])
    expect(Context.get(annotated.annotations, Flow.Capabilities)).toEqual(["fs:read"])
    expect(Context.getUnsafe(annotated.annotations, Flow.EffectsDeclaration)).toEqual(effects)
    expect(Context.getUnsafe(annotated.annotations, Flow.Placement)).toEqual(placement)
  })

  it("declares one spelling of the vocabulary it shares with actions and the runtime", () => {
    // Re-spelling either concept lets the annotation accept what the action
    // boundary or the durable park refuses, so both names resolve to the one
    // definition rather than a copy of it.
    expect(Flow.Effects.fields.boundaryMode).toBe(Action.BoundaryMode)
    expect(Flow.Park.fields.reason).toBe(FlowRuntime.WaitingAnnotation)
    expectTypeOf<typeof FlowRuntime.WaitingAnnotation.Type>().toEqualTypeOf<FlowRuntime.WaitingAnnotation>()
  })

  it("refuses a declared removal the workspace cannot contain", () => {
    const decode = Schema.decodeUnknownResult(Flow.Effects)

    // A replay acts on a removal by deleting the path, so an absolute or
    // upward spelling hands it an eraser aimed outside the workspace.
    for (const path of ["/etc/passwd", "C:\\Windows\\system32", "../outside.js", "dist/./stale.js", ""]) {
      expect(decode({ reads: [], writes: [], removes: [path], boundaryMode: "hard" })._tag).toBe("Failure")
    }

    expect(decode({ reads: [], writes: [], removes: ["dist/stale.js"], boundaryMode: "hard" })._tag).toBe("Success")
  })
})
