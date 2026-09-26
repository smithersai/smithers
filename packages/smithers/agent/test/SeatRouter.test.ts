/**
 * Jev picks the seat and the system variant in one call, and a declared seat
 * asks nothing.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Jj from "@smthrs/jj"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Seat from "../src/Seat.ts"
import * as SeatRouter from "../src/SeatRouter.ts"

const candidates: ReadonlyArray<SeatRouter.Candidate> = [
  { id: "luna", description: "Cheap and fast; small, well-specified edits." },
  { id: "sol", description: "Strong reasoning; multi-file changes." },
  { id: "anthropic:claude-opus-5", description: "The strongest; long, high-risk work." }
]

const state: SeatRouter.State = {
  task: "Rename the helper.",
  flow: "agent",
  description: "The coding agent.",
  capabilities: ["fs.read", "fs.write"]
}

const catalog = (
  offered: ReadonlyArray<SeatRouter.Candidate>,
  variants: ReadonlyArray<SeatRouter.Variant> = SeatRouter.defaultVariants
) => SeatRouter.layer({ candidates: Effect.succeed(offered), variants })

const answering = (
  requests: Array<Evaluator.Request>,
  answers: Readonly<Record<string, Evaluator.ScriptedAnswer>> = {
    seat: { choice: "sol" },
    system: { choice: "investigate" }
  }
) =>
  Evaluator.layerScripted((request) => {
    requests.push(request)
    return answers
  })

const throwing = Evaluator.layerScripted(() => {
  throw new Error("Jev must not be asked")
})

const auto = (input: Partial<SeatRouter.Input> = {}) => SeatRouter.route({ declared: Seat.auto, state, ...input })

const run = <A, E>(effect: Effect.Effect<A, E, SeatRouter.Catalog>, layer: Layer.Layer<SeatRouter.Catalog>) =>
  Effect.runPromise(Effect.exit(effect.pipe(Effect.provide(layer))))

const failure = (exit: Exit.Exit<SeatRouter.Decision, Seat.SeatUnrouted>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  return Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error : undefined
}

describe("SeatRouter.route", () => {
  it("asks Jev for the seat and the variant in one call", async () => {
    const requests: Array<Evaluator.Request> = []
    const long = "x".repeat(20_000)
    const exit = await run(
      auto({ state: { ...state, task: long, parent: { seat: "sol", flow: "coordinator" } } }).pipe(
        Effect.provide(answering(requests))
      ),
      catalog(candidates)
    )
    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(Object.keys(request!.questions)).toEqual(["seat", "system"])
    expect(Object.keys((request!.questions.seat as Evaluator.ChoiceQuestion).criteria)).toEqual(
      candidates.map((candidate) => candidate.id)
    )
    expect(request!.questions.seat!.instructions).toBe(SeatRouter.seatInstructions)
    const sent = request!.state as { readonly task: string; readonly parent: unknown }
    expect(sent.task.length).toBeLessThan(long.length)
    expect(sent.parent).toEqual({ seat: "sol", flow: "coordinator" })
    expect(Exit.isSuccess(exit)).toBe(true)
    const decision = Exit.isSuccess(exit) ? exit.value : undefined
    expect(decision).toMatchObject({
      seat: "sol",
      variant: "investigate",
      decidedBy: "jev",
      candidates: ["luna", "sol", "anthropic:claude-opus-5"],
      asked: {
        classifier: "seat/route",
        digest: SeatRouter.classifierFor(candidates, SeatRouter.defaultVariants).digest
      }
    })
    expect(decision).not.toHaveProperty("confidence")
    expect(Schema.decodeUnknownSync(SeatRouter.DecisionSchema)(decision)).toEqual(decision)
  })

  it("carries the provider's confidence in the seat and its usage", async () => {
    const provider = Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
      evaluate: () =>
        Effect.succeed({
          answers: {
            seat: { type: "choice", choice: "luna" },
            system: { type: "choice", choice: "change" }
          },
          confidence: { seat: 0.62 },
          usage: { inputTokens: 40, outputTokens: 2 },
          latencyMs: 1
        })
    }))
    const exit = await run(auto().pipe(Effect.provide(provider)), catalog(candidates))
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      seat: "luna",
      variant: "change",
      confidence: 0.62,
      asked: { usage: { inputTokens: 40, outputTokens: 2 } }
    })
  })

  it("asks only for the seat over one variant or none", async () => {
    for (const [variants, variant] of [[[SeatRouter.defaultVariants[0]!], "change"], [[], null]] as const) {
      const requests: Array<Evaluator.Request> = []
      const exit = await run(
        auto().pipe(Effect.provide(answering(requests, { seat: { choice: "luna" } }))),
        catalog(candidates, variants)
      )
      expect(requests.map((request) => Object.keys(request.questions))).toEqual([["seat"]])
      expect(Exit.isSuccess(exit) && exit.value).toMatchObject({ seat: "luna", variant, decidedBy: "jev" })
    }
  })

  it("keeps a declared seat and asks nothing", async () => {
    const exit = await run(
      SeatRouter.route({ declared: "anthropic:claude-sonnet-5", state }).pipe(Effect.provide(throwing)),
      catalog(candidates)
    )
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      seat: "anthropic:claude-sonnet-5",
      variant: null,
      decidedBy: "declared",
      latencyMs: 0,
      candidates: [],
      asked: null
    })
  })

  it("takes the only candidate and asks nothing when there is no variant to choose", async () => {
    for (const [variants, variant] of [[[], null], [[SeatRouter.defaultVariants[3]!], "review"]] as const) {
      const exit = await run(auto().pipe(Effect.provide(throwing)), catalog([candidates[0]!], variants))
      expect(Exit.isSuccess(exit) && exit.value).toEqual({
        seat: "luna",
        variant,
        decidedBy: "only",
        latencyMs: 0,
        candidates: ["luna"],
        asked: null
      })
    }
  })

  it("takes the only candidate and asks Jev the variant alone", async () => {
    const requests: Array<Evaluator.Request> = []
    const exit = await run(
      auto().pipe(Effect.provide(answering(requests, { system: { choice: "investigate" } }))),
      catalog([candidates[0]!])
    )
    expect(Object.keys(requests[0]!.questions)).toEqual(["system"])
    const decision = Exit.isSuccess(exit) ? exit.value : undefined
    expect(decision).toMatchObject({ seat: "luna", variant: "investigate", decidedBy: "only", candidates: ["luna"] })
    expect(decision?.confidence).toBeUndefined()
    expect(SeatRouter.events(decision!, { scope: "s", modelId: "m" }).map((event) => event._tag)).toEqual([
      "seat-routed",
      "decision-settled"
    ])
  })

  it("refuses an empty catalog, one too long to ask, and one it cannot list", async () => {
    const many = Array.from({ length: 256 }, (_, index) => ({ id: `seat-${index}`, description: `Seat ${index}.` }))
    const cases = [
      [catalog([]), "no_candidates"],
      [catalog(many), "too_many_candidates"],
      [
        SeatRouter.layer({
          candidates: Effect.fail(new Seat.SeatUnresolved({ seat: "auto", message: "No seat resolver is configured" })),
          variants: []
        }),
        "unconfigured"
      ]
    ] as const
    for (const [layer, reason] of cases) {
      const error = failure(await run(auto().pipe(Effect.provide(throwing)), layer))
      expect(error).toBeInstanceOf(Seat.SeatUnrouted)
      expect(error).toMatchObject({ seat: "auto", reason })
    }
  })

  it("fails typed when Jev cannot answer, and never picks a seat", async () => {
    const cases = [
      [Evaluator.layerUnavailable(), "unreachable"],
      [Layer.empty, "unconfigured"],
      [answering([], { seat: { choice: "gpt-9" }, system: { choice: "change" } }), "invalid_answer"]
    ] as const
    for (const [judge, reason] of cases) {
      const error = failure(
        await run(auto().pipe(Effect.provide(judge as Layer.Layer<never>)), catalog(candidates))
      )
      expect(error).toMatchObject({ _tag: "@smthrs/agent/Seat/SeatUnrouted", seat: "auto", reason })
    }
  })
})

describe("SeatRouter.classifierFor", () => {
  it("is stable for one catalog and changes with a description", () => {
    const first = SeatRouter.classifierFor(candidates, SeatRouter.defaultVariants)
    expect(SeatRouter.classifierFor([...candidates], [...SeatRouter.defaultVariants])).toBe(first)
    const edited = SeatRouter.classifierFor(
      [{ ...candidates[0]!, description: "Cheapest." }, ...candidates.slice(1)],
      SeatRouter.defaultVariants
    )
    expect(edited.digest).not.toBe(first.digest)
    expect(first.id).toBe("seat/route")
  })
})

describe("SeatRouter.defaultVariants", () => {
  it("teaches each kind of work in one or two sentences", () => {
    expect(SeatRouter.defaultVariants).toEqual([
      {
        id: "change",
        description: "Change the workspace.",
        system: [
          "Edit the workspace to do what the task asks.",
          "Prove the change with a check whose result is recorded before you finish."
        ]
      },
      {
        id: "investigate",
        description: "Find something out without changing anything.",
        system: ["Read what the task needs and cite the files and lines you rely on.", "Change nothing."]
      },
      {
        id: "answer",
        description: "Reply to a question.",
        system: ["Reply only: the task needs an answer, not a change."]
      },
      {
        id: "review",
        description: "Judge a given diff.",
        system: ["Judge the diff you were given and cite each problem where it is.", "Make no edits."]
      }
    ])
  })

  it("reads a variant's text", () => {
    expect(SeatRouter.variantText(SeatRouter.defaultVariants, "answer")).toEqual([
      "Reply only: the task needs an answer, not a change."
    ])
    expect(SeatRouter.variantText(SeatRouter.defaultVariants, null)).toEqual([])
    expect(SeatRouter.variantText(SeatRouter.defaultVariants, "unknown")).toBeUndefined()
  })
})

describe("SeatRouter.events", () => {
  const at = { scope: "session-1", modelId: "sol-1" }

  it("journals a Jev pick with its reading, the only seat alone, and a declared seat not at all", async () => {
    const exit = await run(
      auto().pipe(
        Effect.provide(
          Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
            evaluate: () =>
              Effect.succeed({
                answers: { seat: { type: "choice", choice: "sol" }, system: { type: "choice", choice: "change" } },
                confidence: { seat: 0.9 },
                usage: { inputTokens: 10, outputTokens: 1 },
                latencyMs: 0
              })
          }))
        )
      ),
      catalog(candidates)
    )
    const decision = Exit.isSuccess(exit) ? exit.value : undefined
    const [routed, settled, ...rest] = SeatRouter.events(decision!, at)
    expect(rest).toEqual([])
    expect(routed).toBeInstanceOf(AgentEvent.SeatRouted)
    expect(routed).toMatchObject({
      scope: "session-1",
      declared: "auto",
      seat: "sol",
      modelId: "sol-1",
      variant: "change",
      decidedBy: "jev",
      confidence: 0.9,
      candidates: ["luna", "sol", "anthropic:claude-opus-5"]
    })
    expect(settled).toBeInstanceOf(AgentEvent.DecisionSettled)
    expect(settled).toMatchObject({
      scope: "session-1",
      frame: 0,
      classifier: "seat/route",
      acted: true,
      decidedBy: "jev",
      usage: { inputTokens: 10, outputTokens: 1 },
      latencyMs: decision!.latencyMs
    })

    const only = SeatRouter.events(
      { seat: "luna", variant: null, decidedBy: "only", latencyMs: 0, candidates: ["luna"], asked: null },
      at
    )
    expect(only).toHaveLength(1)
    expect(only[0]).toMatchObject({ decidedBy: "only", seat: "luna" })
    expect(only[0]).not.toHaveProperty("confidence")

    expect(SeatRouter.events(
      { seat: "sol", variant: null, decidedBy: "declared", latencyMs: 0, candidates: [], asked: null },
      at
    )).toEqual([])
  })
})

describe("SeatRouter.durable", () => {
  const input: SeatRouter.Input = { declared: Seat.auto, state }

  it("keys by execution and purpose, not by the catalog", () => {
    const key = { executionId: "run-1", purpose: "root" }
    const action = SeatRouter.durable(input, key)
    expect(action.tier).toBe("sealed")
    expect(action.name).toBe("agent/route-seat")
    expect(action.idempotencyKey).toBe("seat/route:run-1:root")
    expect(SeatRouter.durable({ ...input, state: { ...state, description: "Edited." } }, key).idempotencyKey)
      .toBe(action.idempotencyKey)
  })

  const Picked = Schema.Struct({ seat: Schema.String, variant: Schema.NullOr(Schema.String), decidedBy: Schema.String })

  // The run's start: the step a host routes its seat in.
  const Start = Action.make("agent/test/Start", {
    payload: {},
    success: Picked,
    error: Seat.SeatUnrouted
  })

  const Routing = Flow.make("agent/test/Routing", {
    payload: {},
    success: Picked,
    error: Seat.SeatUnrouted,
    body: () => Start.call({})
  })

  const registration = (judge: Layer.Layer<Evaluator.Evaluator>) =>
    Interpreter.layer(Routing).pipe(
      Layer.provideMerge(
        Start.toLayer(() =>
          SeatRouter.durable(input, { executionId: "run-durable", purpose: "root" }).pipe(
            Effect.map(({ decidedBy, seat, variant }) => ({ seat, variant, decidedBy }))
          )
        )
      ),
      Layer.provideMerge(Layer.mergeAll(catalog(candidates), judge)),
      Layer.provideMerge(Action.layerImplementations)
    )

  const runtime = (judge: Layer.Layer<Evaluator.Evaluator>) =>
    ManagedRuntime.make(
      registration(judge).pipe(
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer)
      )
    )

  it("asks Jev once for two runs of one execution", async () => {
    const requests: Array<Evaluator.Request> = []
    const host = runtime(answering(requests))
    const first = await host.runPromise(Routing.execute({}, { executionId: "run-durable" }))
    const second = await host.runPromise(Routing.execute({}, { executionId: "run-durable" }))
    await host.dispose()
    expect(requests).toHaveLength(1)
    expect(second).toEqual(first)
    expect(first).toMatchObject({ seat: "sol", variant: "investigate", decidedBy: "jev" })
  })

  it("re-asks once when the process dies before Jev's answer is recorded", async () => {
    const directory = mkdtempSync(join(tmpdir(), "seat-router-"))
    let calls = 0
    const answered = Deferred.makeUnsafe<void>()
    const judge = Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
      evaluate: () =>
        Effect.suspend(() => {
          calls++
          // The first process is asked, and dies before its answer lands.
          return calls === 1
            ? Effect.andThen(Deferred.succeed(answered, undefined), Effect.never)
            : Effect.succeed({
              answers: { seat: { type: "choice", choice: "sol" }, system: { type: "choice", choice: "change" } },
              latencyMs: 0
            })
        })
    }))
    const jj = Jj.layerNoop({
      snapshot: () => Effect.succeed({ commitId: "seat-router", changeId: "seat-router" }),
      restore: () => Effect.void,
      diff: () => Effect.succeed("")
    })
    const incarnation = (hostId: string) =>
      NodeRuntime.layer(
        {
          filename: join(directory, "engine.db"),
          workspaceRoot: directory,
          owner: { hostId },
          isAlive: () => Effect.succeed(false)
        },
        StepBoundary.layer,
        WorkspaceSandbox.layerFileSystem(),
        registration(judge)
      ).pipe(Layer.provideMerge(Layer.mergeAll(AtomicFileSystem.layer, NodeCrypto.layer, jj)))
    const execute = Routing.execute({}, { executionId: "run-durable" })
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(execute)
          yield* Deferred.await(answered)
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.provide(incarnation("first")), Effect.scoped)
      )
      const resumed = await Effect.runPromise(execute.pipe(Effect.provide(incarnation("second")), Effect.scoped))
      const replayed = await Effect.runPromise(execute.pipe(Effect.provide(incarnation("third")), Effect.scoped))
      expect(calls).toBe(2)
      expect(resumed).toEqual({ seat: "sol", variant: "change", decidedBy: "jev" })
      expect(replayed).toEqual(resumed)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
