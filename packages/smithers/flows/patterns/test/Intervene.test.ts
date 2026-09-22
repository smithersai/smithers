/**
 * `Intervene` on `@smthrs/flow`'s `Graph.build` and `Interpreter`.
 *
 * Every assertion is the one it was: which stages a declaration carries in
 * which order, that a dry run drops the writing call outright, where the
 * approval sits relative to apply, and what {@link Intervene.run} does. A
 * call's declared payload is read off `node.payload`, and the payload-parity
 * case runs the declaration through the real interpreter.
 */
import { describe, it } from "@effect/vitest"
import { Action, Flow, Graph, Interpreter } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Intervene from "../src/Intervene.ts"
import { PatternError } from "../src/PatternError.ts"
import * as WithApproval from "../src/WithApproval.ts"
import { execute } from "./Execute.ts"
import { payloadOf } from "./Graphs.ts"

/** Every payload a declared stage was handed while the plan ran, in order. */
const seen: Array<unknown> = []
/** What each declared stage answers, keyed by phase and set per case. */
const answers = new Map<string, unknown>()

const record = Action.make("intervene/record", {
  payload: { phase: Schema.String, payload: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Never
})

const recordLayer = record.toLayer(({ payload, phase }) =>
  Effect.sync(() => {
    seen.push(payload)
    return answers.get(phase)
  })
)

/**
 * A scripted member: a real `@smthrs/flow` flow, type-erased.
 *
 * `Flow.Any` states a declaration's schemas and annotations but not `.call`,
 * which is what a pattern member is called through, and a flow's `Requires`
 * names the actions its body reaches. Erasing both is what lets one
 * declaration compose members backed by different actions.
 */
type Scripted = Flow.Any & { readonly call: (payload: never) => Node.Node<unknown, unknown, never> }

/** One declared stage, taking exactly the payload the pattern hands it. */
const stage = (phase: string, fields: Schema.Struct.Fields): Scripted =>
  Flow.make(`intervene/${phase}`, {
    payload: fields,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture({ phase }, function(this: { readonly phase: string }, payload: unknown) {
      return record.call({ phase: this.phase, payload })
    })
  }) as unknown as Scripted

const read = stage("read", { phase: Schema.String, input: Schema.Unknown })
const propose = stage("propose", { phase: Schema.String, input: Schema.Unknown, context: Schema.Unknown })
const apply = stage("apply", { phase: Schema.String, input: Schema.Unknown, proposal: Schema.Unknown })
const report = stage("report", {
  phase: Schema.String,
  input: Schema.Unknown,
  proposal: Schema.Unknown,
  applied: Schema.Unknown,
  dryRun: Schema.Boolean
})

const decide = Action.make("intervene/decide", {
  payload: { input: Schema.Unknown, reason: Schema.String, scope: Schema.String },
  success: WithApproval.Approved,
  error: Schema.Never
})

const decideLayer = decide.toLayer(() => Effect.succeed("approved" as const))

const gate: Scripted = Flow.make("human-approval", {
  payload: { input: Schema.Unknown, reason: Schema.String, scope: Schema.String },
  success: WithApproval.Approved,
  error: Schema.Unknown,
  body: Node.capture(
    {},
    (payload: { readonly input: unknown; readonly reason: string; readonly scope: string }) => decide.call(payload)
  )
}) as unknown as Scripted

/** A declaration carrying exactly the schema pair a refusal case needs. */
const declaring = (input: Schema.Top, output: Schema.Top): Scripted =>
  Flow.make("intervene/probe", {
    payload: input as Flow.AnyStructSchema,
    success: output,
    error: Schema.Never,
    body: (value: unknown) => Node.succeed(value)
  }) as unknown as Scripted

/** Every member call a graph carries, in order, named by the flow it calls. */
const memberTags = (graph: Graph.Graph): ReadonlyArray<string> =>
  Graph.nodes(graph)
    .filter((node) => node.kind === "FlowCall" && node.id !== "root")
    .map((node) => (node.ast as { readonly flow: string }).flow)

/** Every member call a graph carries, in order, named by its declared phase. */
const phases = (graph: Graph.Graph): ReadonlyArray<unknown> =>
  Graph.nodes(graph)
    .filter((node) => node.kind === "FlowCall" && node.id !== "root")
    .map((node) => payloadOf(node).phase)

describe("Intervene", () => {
  it("declares the payloads it executes", async () => {
    for (const dryRun of [false, true]) {
      const executed: Array<unknown> = []
      await Effect.runPromise(
        Intervene.run("refactor", {
          dryRun,
          read: (input) => Effect.sync(() => (executed.push(input), ["a.ts"])),
          propose: (input) => Effect.sync(() => (executed.push(input), { edits: 1 })),
          apply: (input) => Effect.sync(() => (executed.push(input), "written")),
          report: (input) => Effect.sync(() => (executed.push(input), "reported"))
        })
      )

      seen.length = 0
      answers.clear()
      answers.set("read", ["a.ts"])
      answers.set("propose", { edits: 1 })
      answers.set("apply", "written")
      answers.set("report", "reported")
      const declaration = Intervene.make({ read, propose, apply, report, dryRun })
      await execute(declaration as never, { input: "refactor" }, `intervene-parity-${dryRun}`, recordLayer)

      expect(seen).toEqual(executed)
    }
  })

  it("declares read, propose, apply, and report", () => {
    const graph = Graph.build(Intervene.make({ read, propose, apply, report, dryRun: false }), { input: "refactor" })

    expect(phases(graph)).toEqual(["read", "propose", "apply", "report"])
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("drops the apply call on a dry run", () => {
    const graph = Graph.build(Intervene.make({ read, propose, apply, report, dryRun: true }), { input: "refactor" })

    expect(phases(graph)).toEqual(["read", "propose", "report"])
    expect(payloadOf(Graph.nodes(graph).filter((node) => node.kind === "FlowCall" && node.id !== "root")[2]!).dryRun)
      .toBe(true)
  })

  it("declares the approval call before apply only when an approval is configured", () => {
    const gated = Graph.build(
      Intervene.make({
        read,
        propose,
        apply,
        report,
        dryRun: false,
        approval: gate,
        reason: "rewrite the module"
      }),
      { input: "refactor" }
    )
    const ungated = Graph.build(
      Intervene.make({ read, propose, apply, report, dryRun: false }),
      { input: "refactor" }
    )

    // `withApproval` contributes two wrapper calls, the decorator and the
    // declaration it wraps, beside the approval and the apply flow itself:
    // seven member calls where an ungated intervention declares four.
    // `@smthrs/flow` lists a spliced body BEFORE the call that splices it,
    // where `@smthrs/core` listed the enclosing call first, so the two wrapper
    // calls sit after the pair they enclose rather than before it.
    expect(memberTags(gated)).toEqual([
      "intervene/read",
      "intervene/propose",
      "human-approval",
      "intervene/apply",
      "withApproval(intervene/apply)",
      "withApproval(intervene/apply)",
      "intervene/report"
    ])
    expect(memberTags(gated).indexOf("human-approval")).toBeLessThan(
      memberTags(gated).lastIndexOf("intervene/apply")
    )
    expect(memberTags(ungated)).toEqual([
      "intervene/read",
      "intervene/propose",
      "intervene/apply",
      "intervene/report"
    ])
    expect(Graph.diagnostics(gated)).toEqual([])
  })

  it("rejects an approval flow that permits denial", () => {
    const permissive = declaring(Schema.Unknown, Schema.String)
    const options = { read, propose, apply, report, dryRun: false, approval: permissive }

    expect(() => Intervene.make(options)).toThrow(expect.objectContaining({
      code: "invalid_decorator",
      message: "The bound flow has an incompatible output schema: expected Literal, received String"
    }))
    expect(() => Intervene.make(options)).toThrow(PatternError)
  })

  it.effect("never applies on a dry run and reports the proposal", () =>
    Effect.gen(function*() {
      let applied = 0

      const reported = yield* Intervene.run("refactor", {
        dryRun: true,
        read: () => Effect.succeed(["a.ts", "b.ts"]),
        propose: ({ context }) => Effect.succeed({ edits: context.length }),
        apply: () =>
          Effect.sync(() => {
            applied += 1
            return "written"
          }),
        report: (args) => Effect.succeed(args)
      })

      expect(applied).toBe(0)
      expect(reported).toEqual({
        phase: "report",
        input: "refactor",
        proposal: { edits: 2 },
        applied: undefined,
        dryRun: true
      })
    }))

  it.effect("applies and reports what was written when the approval decodes", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []

      const reported = yield* Intervene.run("refactor", {
        dryRun: false,
        read: () => Effect.sync(() => trace.push("read")).pipe(Effect.as(["a.ts"])),
        propose: () => Effect.sync(() => trace.push("propose")).pipe(Effect.as({ edits: 1 })),
        approval: () => Effect.sync(() => trace.push("approve")).pipe(Effect.as("approved")),
        apply: () => Effect.sync(() => trace.push("apply")).pipe(Effect.as("written")),
        report: (args) => Effect.sync(() => trace.push("report")).pipe(Effect.as(args))
      })

      expect(trace).toEqual(["read", "propose", "approve", "apply", "report"])
      expect(reported).toMatchObject({ applied: "written", dryRun: false })
    }))

  it.effect("applies directly when no approval callback is configured", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const reported = yield* Intervene.run("refactor", {
        dryRun: false,
        read: () => Effect.sync(() => (trace.push("read"), ["a.ts"])),
        propose: () => Effect.sync(() => (trace.push("propose"), { edits: 1 })),
        apply: () => Effect.sync(() => (trace.push("apply"), "written")),
        report: (args) => Effect.sync(() => (trace.push("report"), args))
      })

      expect(trace).toEqual(["read", "propose", "apply", "report"])
      expect(reported).toMatchObject({ applied: "written", dryRun: false })
    }))

  it.effect("stops before apply when the approval is denied", () =>
    Effect.gen(function*() {
      let applied = 0

      const failure = yield* Intervene.run("refactor", {
        dryRun: false,
        read: () => Effect.succeed(["a.ts"]),
        propose: () => Effect.succeed({ edits: 1 }),
        approval: () => Effect.succeed("denied"),
        apply: () =>
          Effect.sync(() => {
            applied += 1
            return "written"
          }),
        report: (args) => Effect.succeed(args)
      }).pipe(Effect.flip)

      expect(failure._tag).toBe("SchemaError")
      expect(applied).toBe(0)
    }))

  it("gives two approval reasons different step identity", () => {
    const nodes = (reason: string) =>
      Graph.nodes(Graph.build(
        Intervene.make({ read, propose, apply, report, dryRun: false, reason }),
        { input: "refactor" }
      ))

    const rename = nodes("rename the symbol")
    const rewrite = nodes("rewrite the greeting")

    expect(rename.map((node) => node.kind)).toEqual(rewrite.map((node) => node.kind))
    expect(rename.map((node) => node.draft.material.body)).not.toEqual(
      rewrite.map((node) => node.draft.material.body)
    )
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const named = Intervene.make({
      name: "rewrite",
      description: "Read, propose, apply, report.",
      read,
      propose,
      apply,
      report,
      dryRun: false
    })

    expect(named._tag).toBe("rewrite")
    expect(named.description).toBe("Read, propose, apply, report.")
    const derived = Intervene.make({ read, propose, apply, report, dryRun: true })
    expect(derived._tag).toBe("intervene(dryRun=true)")
    expect(derived.description).toBeUndefined()
  })
})

describe("Intervene execution", () => {
  it("runs the whole declared intervention through the interpreter", async () => {
    seen.length = 0
    answers.clear()
    answers.set("read", ["a.ts"])
    answers.set("propose", { edits: 1 })
    answers.set("apply", "written")
    answers.set("report", "reported")

    const settled = await execute(
      Intervene.make({ read, propose, apply, report, dryRun: false, approval: gate, reason: "rewrite" }) as never,
      { input: "refactor" },
      "intervene-gated-run",
      recordLayer,
      decideLayer,
      Interpreter.layer(gate as never) as never
    )

    expect(settled).toBe("reported")
    expect(seen).toEqual([
      { phase: "read", input: "refactor" },
      { phase: "propose", input: "refactor", context: ["a.ts"] },
      { phase: "apply", input: "refactor", proposal: { edits: 1 } },
      { phase: "report", input: "refactor", proposal: { edits: 1 }, applied: "written", dryRun: false }
    ])
  })
})
