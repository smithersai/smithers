/**
 * The classify door, reached the way a cell reaches everything else.
 *
 * `CellFlows.test.ts` proves that a filesystem read, a shell command, and a
 * memory write are one call boundary. This file proves the same for Jev: a
 * cell calls `classify` and `classify/<id>` through `ctx.call`, branches on
 * the answers inside the same cell, and sees a host without a transport as a
 * resolved `{ ok: false, error }` rather than a thrown frame. Everything runs
 * on the production stack: the real durable engine, the real QuickJS sandbox,
 * the real controller. Only the model and the evaluator are scripted.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Capability from "@smthrs/capability/Capability"
import { FlowEngine } from "@smthrs/engine"
import { Flow as EngineFlow, FlowRuntime } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { Cause, Context, Deferred, Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as Seat from "../src/Seat.ts"
import * as StandardFlows from "../src/StandardFlows.ts"
import * as Safety from "./Safety.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

/** A recorded model that replies with one cell per frame and records its prompt. */
const recorded = (requests: Array<string>, cells: ReadonlyArray<string>): Model.Model => {
  let index = 0
  return Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push(
          request.system.map((part) => part.text).join("\n") +
            "\n" +
            request.messages.flatMap((message) =>
              message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
            ).join("\n")
        )
        const source = cells[index++] ?? cells.at(-1) ?? "ctx.done(\"done\")"
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `cell-${index}` }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: `cell-${index}`,
            text: "```cell\n" + source + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `cell-${index}` }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
}

const emptyRegistry = (): Registry.Registry =>
  Registry.makeNoop({
    list: () => Effect.succeed<ReadonlyArray<Descriptor.FlowDescriptor>>([]),
    visible: () => Effect.succeed<ReadonlyArray<Descriptor.FlowDescriptor>>([]),
    getOption: () => Effect.succeed(Option.none())
  })

type Outcome =
  | { readonly _tag: "completed"; readonly value: unknown }
  | { readonly _tag: "failed"; readonly error: unknown }
  | { readonly _tag: "suspended" }

const classify = (exit: Exit.Exit<unknown, unknown>): Outcome =>
  Exit.isSuccess(exit)
    ? { _tag: "completed", value: exit.value }
    : Cause.hasInterruptsOnly(exit.cause)
    ? { _tag: "suspended" }
    : { _tag: "failed", error: Cause.squash(exit.cause) }

const driveFlow = EngineFlow.make("agent/test/classify-flows", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

const snapshotBoundary = Layer.succeed(FlowEngine.SnapshotBoundary)(
  FlowEngine.SnapshotBoundary.of({
    snapshot: () => Effect.succeed(undefined),
    restore: () => Effect.void,
    diff: () => Effect.succeed(Option.none())
  })
)

/** Runs one body as the whole of one real durable flow execution. */
const drive = <A, E>(
  body: Effect.Effect<A, E, Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>
): Promise<Outcome> =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const settled = Deferred.makeUnsafe<Outcome>()
    yield* engine.register(driveFlow, () =>
      Effect.onExit(body, (exit) => Effect.asVoid(Deferred.succeed(settled, classify(exit))))).pipe(
        Scope.provide(scope)
      )
    yield* engine.execute(driveFlow, { executionId: "exec-1", payload: {}, discard: true })
    return yield* Deferred.await(settled)
  }).pipe(
    Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, snapshotBoundary)),
    Effect.scoped,
    Effect.runPromise
  )

const eventsOf = (outcome: Outcome): ReadonlyArray<AgentEvent.AgentEvent> =>
  outcome._tag === "completed" ? outcome.value as ReadonlyArray<AgentEvent.AgentEvent> : []

const settledCalls = (collected: ReadonlyArray<AgentEvent.AgentEvent>) =>
  collected.flatMap((event) => (event._tag === "cell-call-settled" ? [event] : []))

const doneOutput = (collected: ReadonlyArray<AgentEvent.AgentEvent>): unknown => {
  for (const event of collected) {
    if (event._tag === "transition-applied" && event.transition._tag === "complete") return event.transition.output
  }
  return undefined
}

const collect = (options: {
  readonly cells: ReadonlyArray<string>
  readonly requests?: Array<string> | undefined
  readonly flows: ReadonlyArray<FlowBinding.Source>
}) =>
  Effect.gen(function*() {
    const collected: Array<AgentEvent.AgentEvent> = []
    const agent = yield* Agent.Agent
    yield* agent.run({
      session: "session-1",
      seat: Seat.make({
        id: "anthropic:test-model",
        modelId: "test-model",
        model: recorded(options.requests ?? [], options.cells),
        route,
        contextWindowTokens: 0
      }),
      prompt: "do the task",
      registry: emptyRegistry(),
      capabilityEnvelope: [new Capability.CapabilityPattern({ action: "*", resource: "*" })],
      flows: options.flows,
      maxFrames: 3
    }).pipe(
      Stream.runForEach((event) => Effect.sync(() => collected.push(event))),
      Effect.provide(Agent.layerDefaults)
    )
    return collected
  }).pipe(Effect.provide(Agent.layer), Effect.provide(Safety.layer))

const evaluatorServices = (layer: Layer.Layer<Evaluator.Evaluator>): Context.Context<Evaluator.Evaluator> =>
  Effect.runSync(Effect.provide(Effect.context<Evaluator.Evaluator>(), layer))

/** Answers relevance by file suffix, so a cell can branch on what it gets back. */
const byFile = Evaluator.layerScripted((request) => {
  const state = request.state as { readonly file: string }
  const answers: Record<string, Evaluator.ScriptedAnswer> = {}
  for (const [id, question] of Object.entries(request.questions)) {
    answers[id] = question.type === "boolean"
      ? { probability: state.file.endsWith(".py") ? 0.94 : 0.08 }
      : question.type === "choice"
      ? { choice: state.file.endsWith(".py") ? "implementation" : "unrelated" }
      : { score: 1 }
  }
  return answers
})

describe("classify is a flow", () => {
  it("judges a batch of files in one call and branches on the answers inside the same cell", async () => {
    const requests: Array<string> = []
    const outcome = await drive(
      collect({
        requests,
        flows: [StandardFlows.classify(evaluatorServices(byFile))],
        cells: [
          `const task = "fix the flaky unit test"
const files = ["src/units/widen.py", "src/units/convert.py", "README.md"]
const verdicts = await ctx.call("classify", {
  states: files.map((file) => ({ task, file, excerpt: "..." })),
  questions: {
    relevant: { type: "boolean", instructions: "Does this file need to change to fix the flaky test?" },
    role: { type: "choice", instructions: "What is this file's role?", criteria: { implementation: "code under test", fixture: "test data or setup", unrelated: "nothing to do with the test" } }
  }
})
const targets = verdicts.results.filter((r) => r.ok && r.answers.relevant.probability > 0.7).map((r) => r.state.file)
const curated = await ctx.call("classify/triage/relevance", { task, file: "README.md", excerpt: "..." })
ctx.done(JSON.stringify({ targets, readme: curated.answers.role.value, confidence: curated.confidence.role }))`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    const collected = eventsOf(outcome)
    const settled = settledCalls(collected)
    expect(settled.map((event) => event.flowName)).toEqual(["classify", "classify/triage/relevance"])
    expect(settled.every((event) => event.result.outcome === "success")).toBe(true)
    expect(JSON.parse(doneOutput(collected) as string)).toEqual({
      targets: ["src/units/widen.py", "src/units/convert.py"],
      readme: "unrelated",
      confidence: 1
    })

    // The catalog discloses the door and what each curated flow judges.
    expect(requests[0]).toContain("classify")
    expect(requests[0]).toContain("classify/check/verdict")
    expect(requests[0]).toContain("never text")
  })

  it("resolves { ok: false } on a host without an evaluator, and the cell carries on", async () => {
    const outcome = await drive(
      collect({
        flows: [StandardFlows.classify(evaluatorServices(Evaluator.layerUnavailable()))],
        cells: [
          `const verdict = await ctx.call("classify", { state: { file: "a.py" }, questions: { ok: { type: "boolean", instructions: "Is it done?" } } })
const check = await ctx.call("classify/check/verdict", { command: "pytest", exitCode: 1, output: "E assert" })
ctx.done(JSON.stringify({ single: verdict, curated: check }))`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    const collected = eventsOf(outcome)
    const settled = settledCalls(collected)
    expect(settled.map((event) => event.result.outcome)).toEqual(["failure", "failure"])
    const seen = JSON.parse(doneOutput(collected) as string) as {
      readonly single: { readonly ok: boolean; readonly error: { readonly code: string; readonly message: string } }
      readonly curated: { readonly ok: boolean; readonly error: { readonly code: string; readonly message: string } }
    }
    expect(seen.single.ok).toBe(false)
    expect(seen.single.error.code).toBe("flow_failed")
    expect(seen.single.error.message).toBe(
      "Flow classify failed: unreachable: No evaluator is installed on this host"
    )
    expect(seen.curated.error.message).toMatch(/^Flow classify\/check\/verdict failed: unreachable:/)
  })

  it("refuses an oversized batch as invalid_input before any transport is reached", async () => {
    let asked = 0
    const counting = Evaluator.layerScripted(() => {
      asked += 1
      return { ok: { probability: 1 } }
    })
    const outcome = await drive(
      collect({
        flows: [StandardFlows.classify(evaluatorServices(counting), { classifiers: [] })],
        cells: [
          `const tooMany = await ctx.call("classify", { states: Array.from({ length: 65 }, (_, i) => i), questions: { ok: { type: "boolean", instructions: "Is it?" } } })
ctx.done(JSON.stringify(tooMany))`
        ]
      })
    )

    expect(outcome._tag).toBe("completed")
    const seen = JSON.parse(doneOutput(eventsOf(outcome)) as string) as {
      readonly ok: boolean
      readonly error: { readonly code: string; readonly message: string; readonly hint: string }
    }
    expect(seen.ok).toBe(false)
    expect(seen.error.code).toBe("invalid_input")
    expect(seen.error.message).toContain("at most 64")
    expect(seen.error.hint).toContain("Fix the input")
    expect(asked).toBe(0)
  })
})
