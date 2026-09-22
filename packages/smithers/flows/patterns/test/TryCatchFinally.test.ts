import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as TryCatchFinally from "../src/TryCatchFinally.ts"
import { execute } from "./Execute.ts"

class Timeout extends Schema.TaggedError<Timeout>()("Timeout", { seconds: Schema.Number }) {}
class Denied extends Schema.TaggedError<Denied>()("Denied", { who: Schema.String }) {}

// Each flow is tagged with its arm, so a built graph can name the flow behind
// every call node. `@smthrs/flow` names a call by the flow's tag, which is
// what core's echoed body value stood in for.
const named = (name: string) =>
  Flow.make(name, {
    payload: { input: Schema.Unknown, error: Schema.optional(Schema.Unknown) },
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture({ name }, () => Node.succeed({ from: name }))
  })

// A flow that fails with its own name, so a declaration run can name which arm
// produced the failure it reports.
const failing = (error: string) =>
  Flow.make(error.replace(/\s/g, "-"), {
    payload: { input: Schema.Unknown, error: Schema.optional(Schema.Unknown) },
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture({ error }, () => Node.fail(error))
  })

const request = { input: "request" }

const calledFlows = (graph: Graph.Graph): Array<string> =>
  Graph.nodes(graph)
    .filter((node) => node.kind === "FlowCall")
    .filter((call) => call.id !== "root")
    .map((call) => (call.ast as { readonly flow?: string }).flow!)

const flowId = (graph: Graph.Graph, tag: string): ReadonlyArray<string> =>
  Graph.nodes(graph)
    .filter((node) => node.kind === "FlowCall" && (node.ast as { readonly flow?: string }).flow === tag)
    .map((node) => node.id)

const kindsById = (graph: Graph.Graph): Readonly<Record<string, string>> =>
  Object.fromEntries(Graph.nodes(graph).map((node) => [node.id, node.kind]))

describe("TryCatchFinally", () => {
  it("declares a filtered catch and a finalizer on both arms", () => {
    const graph = Graph.build(
      TryCatchFinally.make({
        try: named("try"),
        catch: named("catch"),
        catchSchema: Timeout,
        finally: named("finally")
      }),
      request
    )
    const catches = Graph.nodes(graph).filter((node) => node.kind === "Catch")

    // Three boundaries: the unhandled-failure arm, the filtered recovery arm,
    // and the arm that absorbs a finalizer failure on the unhandled path.
    expect(calledFlows(graph)).toEqual(["try", "catch", "finally", "finally"])
    expect(catches).toHaveLength(3)
    // `@smthrs/flow` names the schema that selects handled failures `filter`
    // where core named it `error`, and the graph lists the arms innermost
    // first, so the filtered one is the recovery arm at index 0.
    expect((catches[0]?.draft.material.body as { readonly filter?: unknown }).filter).toBeDefined()
    expect((catches[1]?.draft.material.body as { readonly filter?: unknown }).filter).toBeUndefined()
    expect((catches[2]?.draft.material.body as { readonly filter?: unknown }).filter).toBeUndefined()
  })

  // The outer boundary exists to catch what the BODY raised. The success-arm
  // finalizer must sit outside it: inside, a finalizer that fails on the
  // success path would be caught by the boundary that then calls the finalizer
  // a second time and re-raises: a topology `run` does not implement, which
  // calls the finalizer exactly once and maps that case to `finalizer_failed`.
  it("keeps the success-arm finalizer outside the unhandled-failure boundary", () => {
    const graph = Graph.build(
      TryCatchFinally.make({
        try: named("try"),
        catch: named("catch"),
        catchSchema: Timeout,
        finally: named("finally")
      }),
      request
    )
    const kinds = kindsById(graph)
    const boundary = Graph.nodes(graph).filter((node) => node.kind === "Catch").map((node) => node.id).sort()

    // `@smthrs/flow` enters the declaration as a call of its own, so the body
    // this pattern declares is spliced under `root.flow`, and it names a
    // catch's two arms `protected` and `failure` where core named them `catch`
    // and `recover`. The topology is the same one, node for node.
    //
    // The body sequences the boundary into the success-arm finalizer, so the
    // finalizer is downstream of the boundary rather than protected by it.
    expect(kinds["root.flow"]).toBe("AndThen")
    expect(kinds["root.flow.andThen"]).toBe("Catch")
    // What the outer boundary protects is the try/catch node itself.
    expect(kinds["root.flow.andThen.protected"]).toBe("Catch")
    expect(boundary).toEqual([
      "root.flow.andThen",
      "root.flow.andThen.failure.andThen",
      "root.flow.andThen.protected"
    ])
    // The success-arm finalizer is the body's continuation, outside the catch.
    expect(flowId(graph, "finally")).toContain("root.flow.then.andThen")
    // The unhandled arm still calls the finalizer and re-raises. Its finalizer
    // call sits under a catch that recovers, so a cleanup failure cannot take
    // the place of the body failure the arm re-raises.
    expect(kinds["root.flow.andThen.failure.andThen"]).toBe("Catch")
    expect(flowId(graph, "finally")).toContain("root.flow.andThen.failure.andThen.protected")
    expect(kinds["root.flow.andThen.failure.andThen.failure"]).toBe("Succeed")
    expect(kinds["root.flow.andThen.failure.then"]).toBe("Fail")
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const boundary = TryCatchFinally.make({
      try: named("try"),
      name: "guarded-write",
      description: "Write behind a boundary."
    })

    expect(boundary._tag).toBe("guarded-write")
    expect(boundary.description).toBe("Write behind a boundary.")
    expect(TryCatchFinally.make({ try: named("try") }).description).toBeUndefined()
  })

  it("declares the unhandled arm as a re-raise", () => {
    const graph = Graph.build(
      TryCatchFinally.make({ try: named("try"), finally: named("finally") }),
      request
    )

    expect(calledFlows(graph)).toEqual(["try", "finally", "finally"])
    expect(Graph.nodes(graph).filter((node) => node.kind === "Fail")).toHaveLength(1)
  })

  // The declared plan and `run` must agree on which failure wins when both the
  // body and the finalizer fail. Sequencing the finalizer ahead of the re-raise
  // without catching it loses the body failure, and the boundary reports the
  // cleanup error the caller never asked about.
  it("declares the body failure as the one the unhandled arm reports when cleanup fails too", async () => {
    const boundary = TryCatchFinally.make({ try: failing("body failed"), finally: failing("cleanup failed") })
    const reported = await execute(boundary, request, "tcf-body-failure").then(
      (settled: unknown) => ({ settled }),
      (failure: unknown) => ({ failure })
    )

    expect(JSON.stringify(reported)).toContain("body failed")
    expect(JSON.stringify(reported)).not.toContain("cleanup failed")
  })

  it("declares nothing extra without a catch or a finalizer", () => {
    const graph = Graph.build(TryCatchFinally.make({ try: named("try") }), request)

    expect(calledFlows(graph)).toEqual(["try"])
    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(0)
  })

  it("declares an unfiltered catch when no error schema is supplied", () => {
    const graph = Graph.build(TryCatchFinally.make({ try: named("try"), catch: named("catch") }), request)

    expect(calledFlows(graph)).toEqual(["try", "catch"])
    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(1)
  })

  it("refuses a declaration that filters errors without a catch", () => {
    let refusal: unknown
    try {
      TryCatchFinally.make({ try: named("try"), catchSchema: Timeout })
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(PatternError)
    expect((refusal as PatternError).code).toBe("invalid_decorator")
    expect((refusal as PatternError).message).toBe("TryCatchFinally catchSchema requires catch")
  })

  // Content-addressed step identity requires that the same declaration key the
  // same way every time it is built. A recovery arm written as a bare arrow
  // takes `sha256-source-ephemeral/v4` identity, whose digest folds in a
  // per-process nonce and a fresh ordinal for every closure the body creates,
  // so a second build of the same boundary would key differently.
  it("builds the same key material twice", () => {
    const boundary = TryCatchFinally.make({
      try: named("try"),
      catch: named("catch"),
      catchSchema: Timeout,
      finally: named("finally")
    })
    const material = () => Graph.nodes(Graph.build(boundary, request)).map((node) => node.draft.material)

    expect(material()).toEqual(material())
    // Core digested a recovery arm as one captured FUNCTION and this case
    // pinned that digest's algorithm. `@smthrs/flow` expands each arm into its
    // own graph nodes instead, so there is no handler digest to pin; the
    // property the pin protected, that the same declaration keys the same way
    // on every build, is the equality above, and the three arms are the three
    // `Catch` nodes below.
    expect(Graph.nodes(Graph.build(boundary, request)).filter((node) => node.kind === "Catch")).toHaveLength(3)
  })

  it.effect("runs the finalizer once after a successful body", () =>
    Effect.gen(function*() {
      let finalized = 0
      const value = yield* TryCatchFinally.run("request", {
        try: (input) => Effect.succeed(`${input}-ok`),
        finally: () =>
          Effect.sync(() => {
            finalized = finalized + 1
          })
      })

      expect(value).toBe("request-ok")
      expect(finalized).toBe(1)
    }))

  it.effect("defers protected body construction and rebuilds it for every execution", () =>
    Effect.gen(function*() {
      let constructions = 0
      const protectedBody = TryCatchFinally.run("request", {
        try: (input) => {
          constructions += 1
          return Effect.succeed(`${input}-${constructions}`)
        }
      })

      expect(constructions).toBe(0)
      expect(yield* protectedBody).toBe("request-1")
      expect(constructions).toBe(1)
      expect(yield* protectedBody).toBe("request-2")
      expect(constructions).toBe(2)
    }))

  it.effect("reports a synchronously thrown body factory as a defect and still finalizes", () =>
    Effect.gen(function*() {
      const defect = new Error("factory exploded")
      let finalized = false
      const protectedBody = TryCatchFinally.run("request", {
        try: (): Effect.Effect<never> => {
          throw defect
        },
        finally: () =>
          Effect.sync(() => {
            finalized = true
          })
      })

      expect(finalized).toBe(false)
      const exit = yield* Effect.exit(protectedBody)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.find((reason) => reason._tag === "Die")).toMatchObject({
          _tag: "Die",
          defect
        })
      }
      expect(finalized).toBe(true)
    }))

  it.effect("recovers a matching failure and still runs the finalizer", () =>
    Effect.gen(function*() {
      let finalized = 0
      const value = yield* TryCatchFinally.run("request", {
        try: () => Effect.fail(new Timeout({ seconds: 30 })),
        catchErrors: (error) => error._tag === "Timeout",
        catch: (error) => Effect.succeed(`recovered-${error.seconds}`),
        finally: () =>
          Effect.sync(() => {
            finalized = finalized + 1
          })
      })

      expect(value).toBe("recovered-30")
      expect(finalized).toBe(1)
    }))

  it.effect("propagates a non-matching failure and still runs the finalizer", () =>
    Effect.gen(function*() {
      let finalized = 0
      let handled = 0
      const exit = yield* Effect.exit(
        TryCatchFinally.run("request", {
          try: (): Effect.Effect<string, Timeout | Denied> => Effect.fail(new Denied({ who: "root" })),
          catchErrors: (error) => error._tag === "Timeout",
          catch: () =>
            Effect.sync(() => {
              handled = handled + 1
              return "recovered"
            }),
          finally: () =>
            Effect.sync(() => {
              finalized = finalized + 1
            })
        })
      )

      expect(exit._tag).toBe("Failure")
      expect(handled).toBe(0)
      expect(finalized).toBe(1)
    }))

  it.effect("fails finalizer_failed when the finalizer fails after a successful body", () =>
    Effect.gen(function*() {
      const finalizerError = new Denied({ who: "cleanup" })
      const error = yield* Effect.flip(
        TryCatchFinally.run("request", {
          try: () => Effect.succeed("ok"),
          finally: () => Effect.fail(finalizerError)
        })
      )

      expect(error).toBeInstanceOf(PatternError)
      expect((error as PatternError).code).toBe("finalizer_failed")
      expect((error as PatternError).message).toBe(
        "The TryCatchFinally finalizer failed after the protected body succeeded"
      )
      expect((error as PatternError).cause).toEqual(finalizerError)
    }))

  it.effect("returns the protected body directly when no finalizer is configured", () =>
    Effect.gen(function*() {
      const value = yield* TryCatchFinally.run("request", {
        try: (input) => Effect.succeed(`${input}-ok`)
      })

      expect(value).toBe("request-ok")
    }))

  it.effect("refuses a runtime filter without a catch before the body runs", () =>
    Effect.gen(function*() {
      let ran = 0
      const error = yield* Effect.flip(
        TryCatchFinally.run("request", {
          try: (): Effect.Effect<string, Timeout> => Effect.sync(() => (ran += 1, "ok")),
          catchErrors: () => true
        })
      )

      expect(error).toBeInstanceOf(PatternError)
      expect((error as PatternError).code).toBe("invalid_decorator")
      expect((error as PatternError).message).toBe("TryCatchFinally catchErrors requires catch")
      expect(ran).toBe(0)
    }))

  it.effect("keeps the body failure when the finalizer fails too", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        TryCatchFinally.run("request", {
          try: () => Effect.fail(new Denied({ who: "root" })),
          finally: () => Effect.fail(new Timeout({ seconds: 1 }))
        })
      )

      expect(error).toBeInstanceOf(Denied)
    }))

  // Dropping the cleanup failure leaves a lock still held or a directory still
  // there with no record anywhere: not a log line, not a cause reason. It rides
  // behind the body failure instead, which keeps the precedence above.
  it.effect("keeps the finalizer failure on the cause behind the body failure", () =>
    Effect.gen(function*() {
      const cleanup = new Timeout({ seconds: 1 })
      const exit = yield* Effect.exit(
        TryCatchFinally.run("request", {
          try: () => Effect.fail(new Denied({ who: "root" })),
          finally: () => Effect.fail(cleanup)
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const errors = exit.cause.reasons
          .filter((reason) => reason._tag === "Fail")
          .map((reason) => (reason as { readonly error: unknown }).error)

        expect(errors[0]).toBeInstanceOf(Denied)
        expect(errors[1]).toBeInstanceOf(PatternError)
        expect((errors[1] as PatternError).code).toBe("finalizer_failed")
        expect((errors[1] as PatternError).message).toBe(
          "The TryCatchFinally finalizer failed after the protected body failed"
        )
        expect((errors[1] as PatternError).cause).toEqual(cleanup)
      }
    }))

  it.effect("runs the finalizer when the body is interrupted", () =>
    Effect.gen(function*() {
      let finalized = 0
      const fiber = yield* Effect.forkChild(
        TryCatchFinally.run("request", {
          try: () => Effect.never,
          finally: () =>
            Effect.sync(() => {
              finalized = finalized + 1
            })
        }),
        { startImmediately: true }
      )
      yield* Fiber.interrupt(fiber)

      expect(finalized).toBe(1)
    }))
})
