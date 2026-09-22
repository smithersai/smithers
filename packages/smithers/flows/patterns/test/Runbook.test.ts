/**
 * `Runbook` on `@smthrs/flow`'s `Graph.build`.
 *
 * Every assertion is the one it was: which steps are gated, what each approval
 * request carries, and which declarations are refused. One reading moved: an
 * approval call's declared payload is `node.payload` rather than the first
 * `Literal` of `keyMaterial.inputs`.
 */
import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as Runbook from "../src/Runbook.ts"
import * as WithApproval from "../src/WithApproval.ts"
import { callsTo, payloadOf } from "./Graphs.ts"

/** The envelope every declared step is handed. */
const Envelope = Schema.Struct({
  step: Schema.String,
  risk: Schema.String,
  elevated: Schema.Boolean,
  input: Schema.Unknown,
  previous: Schema.Unknown
})

const step = Flow.make("runbook/step", {
  payload: Envelope,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: Node.capture({}, (payload: typeof Envelope.Type) => Node.succeed(payload))
}) as unknown as Flow.Any

const approval = Flow.make("human-approval", {
  payload: { input: Schema.Unknown, reason: Schema.String, scope: Schema.String },
  success: WithApproval.Approved,
  error: Schema.Unknown,
  body: Node.capture({}, () => Node.succeed("approved" as const))
}) as unknown as Flow.Any

/** A declaration carrying exactly the schema pair a refusal case needs. */
const declaring = (input: Schema.Top, output: Schema.Top): Flow.Any =>
  Flow.make("runbook/probe", {
    payload: input as Flow.AnyStructSchema,
    success: output,
    error: Schema.Never,
    body: (value: unknown) => Node.succeed(value)
  }) as unknown as Flow.Any

const steps = [
  { id: "backup", flow: step, risk: "safe" as const },
  { id: "deploy", flow: step, risk: "risky" as const },
  { id: "migrate", flow: step, risk: "critical" as const }
]

/** Every member call a graph carries, in order, named by the flow it calls. */
const memberTags = (graph: Graph.Graph): ReadonlyArray<string> =>
  Graph.nodes(graph)
    .filter((node) => node.kind === "FlowCall" && node.id !== "root")
    .map((node) => (node.ast as { readonly flow: string }).flow)

const approvalCalls = (graph: Graph.Graph): ReadonlyArray<Record<string, unknown>> =>
  callsTo(graph, "human-approval")
    .map((node) => payloadOf(node).input as Record<string, unknown>)
    .sort((left, right) => String(left.step).localeCompare(String(right.step)))

describe("Runbook", () => {
  it("declares an approval call only for a non-safe step", () => {
    const graph = Graph.build(Runbook.make({ steps, approval, onDeny: "fail" }), { input: "release" })

    expect(Graph.diagnostics(graph)).toEqual([])
    expect(approvalCalls(graph).map((value) => value.step)).toEqual(["deploy", "migrate"])
  })

  it("marks a critical step's approval elevated and a risky one not", () => {
    const graph = Graph.build(Runbook.make({ steps, approval, onDeny: "fail" }), { input: "release" })

    expect(approvalCalls(graph).map((value) => value.elevated)).toEqual([false, true])
    expect(approvalCalls(graph).map((value) => value.risk)).toEqual(["risky", "critical"])
  })

  it("declares no approval call when every step is safe", () => {
    const graph = Graph.build(
      Runbook.make({ steps: [{ id: "backup", flow: step, risk: "safe" }], approval, onDeny: "fail" }),
      { input: "release" }
    )

    expect(approvalCalls(graph)).toEqual([])
    expect(memberTags(graph)).toEqual(["runbook/step"])
  })

  it("rejects an empty runbook, a duplicate step id, and an approval that permits denial", () => {
    expect(() => Runbook.make({ steps: [], approval, onDeny: "fail" })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "Runbook requires at least one step" })
    )
    expect(() => Runbook.make({ steps: [steps[0]!, steps[0]!], approval, onDeny: "fail" })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "Runbook step ids must be unique" })
    )
    const permissive = declaring(Schema.Unknown, Schema.String)
    expect(() => Runbook.make({ steps, approval: permissive, onDeny: "fail" })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "The bound flow has an incompatible output schema: expected Literal, received String"
      })
    )
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const named = Runbook.make({
      steps,
      approval,
      onDeny: "fail",
      name: "release-runbook",
      description: "Walk the release steps, gating the risky ones."
    })

    expect(named._tag).toBe("release-runbook")
    expect(named.description).toBe("Walk the release steps, gating the risky ones.")
    expect(Runbook.make({ steps, approval, onDeny: "fail" }).description).toBeUndefined()
  })

  it.effect("never asks for approval of a safe step", () =>
    Effect.gen(function*() {
      const asked: Array<string> = []

      const result = yield* Runbook.run("release-1", {
        onDeny: "fail",
        approve: (request) =>
          Effect.sync(() => {
            asked.push(request.step)
            return "approved"
          }),
        steps: [
          { id: "backup", risk: "safe", run: () => Effect.succeed("backed up") },
          { id: "deploy", risk: "risky", run: () => Effect.succeed("deployed") }
        ]
      })

      expect(asked).toEqual(["deploy"])
      expect(result.ran).toEqual(["backup", "deploy"])
      expect(result.skipped).toEqual([])
      expect(result.outputs).toEqual({ backup: "backed up", deploy: "deployed" })
    }))

  it.effect("returns own outputs for prototype-shaped step ids", () =>
    Effect.gen(function*() {
      const ids = ["__proto__", "constructor", "toString", "normal"]
      const result = yield* Runbook.run("release-1", {
        onDeny: "fail",
        approve: () => Effect.succeed("approved"),
        steps: ids.map((id) => ({ id, risk: "safe" as const, run: () => Effect.succeed(`${id}-value`) }))
      })

      expect(Object.getPrototypeOf(result.outputs)).toBe(Object.prototype)
      for (const id of ids) {
        expect(Object.hasOwn(result.outputs, id)).toBe(true)
        expect(result.outputs[id]).toBe(`${id}-value`)
      }
    }))

  it.effect("passes elevated true for a critical step and the previous step's output", () =>
    Effect.gen(function*() {
      const requests: Array<{ readonly step: string; readonly elevated: boolean; readonly previous: unknown }> = []

      yield* Runbook.run("release-1", {
        onDeny: "fail",
        approve: (request) =>
          Effect.sync(() => {
            requests.push({ step: request.step, elevated: request.elevated, previous: request.previous })
            return "approved"
          }),
        steps: [
          { id: "deploy", risk: "risky", run: () => Effect.succeed("deployed") },
          { id: "migrate", risk: "critical", run: () => Effect.succeed("migrated") }
        ]
      })

      expect(requests).toEqual([
        { step: "deploy", elevated: false, previous: undefined },
        { step: "migrate", elevated: true, previous: "deployed" }
      ])
    }))

  it.effect("stops the runbook on a denial under onDeny fail", () =>
    Effect.gen(function*() {
      const ran: Array<string> = []

      const failure = yield* Runbook.run("release-1", {
        onDeny: "fail",
        approve: () => Effect.succeed("denied"),
        steps: [
          {
            id: "deploy",
            risk: "risky",
            run: () =>
              Effect.sync(() => {
                ran.push("deploy")
                return "deployed"
              })
          },
          {
            id: "notify",
            risk: "safe",
            run: () =>
              Effect.sync(() => {
                ran.push("notify")
                return "notified"
              })
          }
        ]
      }).pipe(Effect.flip)

      expect(failure._tag).toBe("SchemaError")
      expect(ran).toEqual([])
    }))

  it.effect("skips a denied step and runs the next one under onDeny skip", () =>
    Effect.gen(function*() {
      const ran: Array<string> = []

      const result = yield* Runbook.run("release-1", {
        onDeny: "skip",
        approve: (request) => Effect.succeed(request.step === "deploy" ? "denied" : "approved"),
        steps: [
          {
            id: "deploy",
            risk: "risky",
            run: () =>
              Effect.sync(() => {
                ran.push("deploy")
                return "deployed"
              })
          },
          {
            id: "notify",
            risk: "safe",
            run: () =>
              Effect.sync(() => {
                ran.push("notify")
                return "notified"
              })
          }
        ]
      })

      expect(ran).toEqual(["notify"])
      expect(result.skipped).toEqual(["deploy"])
      expect(result.ran).toEqual(["notify"])
      expect(result.outputs).toEqual({ notify: "notified" })
    }))

  it.effect("hands a skipped step's predecessor to the next step", () =>
    Effect.gen(function*() {
      const seen: Array<unknown> = []

      yield* Runbook.run("release-1", {
        onDeny: "skip",
        approve: (request) => Effect.succeed(request.step === "deploy" ? "denied" : "approved"),
        steps: [
          { id: "backup", risk: "safe", run: () => Effect.succeed("backed up") },
          { id: "deploy", risk: "risky", run: () => Effect.succeed("deployed") },
          {
            id: "notify",
            risk: "safe",
            run: ({ previous }) =>
              Effect.sync(() => {
                seen.push(previous)
                return "notified"
              })
          }
        ]
      })

      expect(seen).toEqual(["backed up"])
    }))

  it.effect("rejects an empty runbook and a duplicate step id at runtime", () =>
    Effect.gen(function*() {
      const empty = yield* Runbook.run("release-1", {
        onDeny: "fail",
        approve: () => Effect.succeed("approved"),
        steps: []
      }).pipe(Effect.flip)
      expect(empty).toBeInstanceOf(PatternError)
      // `run` declares `SchemaError | PatternError`, so the assertion above is
      // what proves the arm; the guard is only how TypeScript reads the code.
      if (!(empty instanceof PatternError)) throw new Error("expected a PatternError")
      expect(empty.code).toBe("invalid_decorator")
      expect(empty.message).toBe("Runbook requires at least one step")

      const duplicate = yield* Runbook.run("release-1", {
        onDeny: "fail",
        approve: () => Effect.succeed("approved"),
        steps: [
          { id: "deploy", risk: "safe", run: () => Effect.succeed("a") },
          { id: "deploy", risk: "safe", run: () => Effect.succeed("b") }
        ]
      }).pipe(Effect.flip)
      expect(duplicate).toBeInstanceOf(PatternError)
      if (!(duplicate instanceof PatternError)) throw new Error("expected a PatternError")
      expect(duplicate.code).toBe("invalid_decorator")
      expect(duplicate.message).toBe("Runbook step ids must be unique")
    }))

  it.effect("does not admit a step appended while the run is in flight", () =>
    Effect.gen(function*() {
      const trace: Array<string> = []
      const runtimeSteps: Array<Runbook.RuntimeStep<string, string, never, never>> = []
      const late: Runbook.RuntimeStep<string, string, never, never> = {
        id: "late",
        risk: "safe",
        run: () => Effect.sync(() => (trace.push("late"), "late-done"))
      }
      runtimeSteps.push({
        id: "first",
        risk: "safe",
        run: () => Effect.sync(() => (trace.push("first"), runtimeSteps.push(late), "first-done"))
      })

      const result = yield* Runbook.run("release-1", {
        steps: runtimeSteps,
        approve: () => Effect.succeed("approved"),
        onDeny: "fail"
      })

      expect(trace).toEqual(["first"])
      expect(result).toEqual({ outputs: { first: "first-done" }, ran: ["first"], skipped: [] })
    }))

  // A declared plan has no branch to drop a denied step from, and the gated
  // node carries the step's own failures beside the denial, so an arm here
  // would declare that the runbook continues past a FAILED critical step.
  // `make` refuses the option rather than accepting it and building a plan
  // that halts, which is the shape an operator reading the plan would
  // misread as a skip.
  it("refuses onDeny skip at declaration, naming run as the way to skip", () => {
    expect(() => Runbook.make({ steps, approval, onDeny: "skip" })).toThrow(
      expect.objectContaining({ code: "invalid_decorator" })
    )
    const refusal = (() => {
      try {
        Runbook.make({ steps, approval, onDeny: "skip" })
        return undefined
      } catch (error) {
        return error as PatternError
      }
    })()

    expect(refusal?.code).toBe("invalid_decorator")
    expect(refusal?.message).toBe(
      "Runbook.make does not support onDeny: \"skip\". A declared plan has no branch that drops a denied step, " +
        "and the gated node carries the step's own failures beside the denial, so the arm that would skip also " +
        "declares that the runbook continues past a failed step. Declare the runbook with onDeny: \"fail\", and " +
        "call Runbook.run with onDeny: \"skip\" to skip a denied step at run time."
    )
    // The supported declaration is unaffected.
    expect(Graph.diagnostics(Graph.build(Runbook.make({ steps, approval, onDeny: "fail" }), { input: "release" })))
      .toEqual([])
  })
})
