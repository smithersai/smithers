/**
 * The supervisor, driven through the loop that offers to it.
 *
 * Every case runs the real controller against a recorded model, a scripted
 * engine and a scripted evaluator; nothing reaches a network. The scripted
 * evaluator tells the two classifiers apart by their questions: a request
 * carrying `complete` is the completion brake, which every case answers
 * confidently so the run can finish, and a request carrying `thrashing` is
 * the supervisor, which each case scripts for itself.
 *
 * The rule the cases pin: the loop never waits for the supervisor, the
 * supervisor is asked and answers off the hot path, a reading past its
 * threshold is delivered once at the next boundary and only when steering is
 * armed, a reading nobody could take inserts nothing and reports no level,
 * a replayed run re-delivers what it recorded without asking again, and
 * memory is written and inserted only for what Jev accepted.
 *
 * The steering source in the delivery cases WAITS for the supervisor to
 * settle before it drains. That is the test harness holding the boundary
 * open so the assertion is about what the boundary delivers rather than
 * about scheduler luck; the loop under test still never awaits the fiber,
 * which the first case proves with an evaluator that never answers.
 */
import { ModelRequest } from "@smthrs/model"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Deferred, Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import { HarnessError } from "../src/HarnessError.ts"
import * as Supervision from "../src/internal/supervision.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Steering from "../src/Steering.ts"
import * as Supervisor from "../src/Supervisor.ts"
import { descriptor, emits, of, prose, run } from "./fixtures/cellTurn.ts"
import * as ScriptedEngine from "./fixtures/scriptedEngine.ts"
import * as ScriptedModel from "./fixtures/scriptedModel.ts"

const task = "Fix the off-by-one in add()."

const window = ContextWindow.make({
  modelId: "test-model",
  segments: [
    { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
    {
      kind: "instructions",
      zone: "prefix",
      content: [ModelRequest.SystemPart.make({ text: `The task for this run:\n\n${task}` })]
    },
    { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("start")] }
  ]
})

const state = (maxFrames: number, revalidations?: number) =>
  CellTurn.make({
    revalidations,
    session: "session-1",
    seat: "anthropic:test-model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: [],
    capabilityEnvelope: [],
    placement: Option.none(),
    contextWindow: window,
    maxFrames,
    repeatCap: 0,
    narrowingCap: 0,
    unmovedCap: 0,
    unresolvedCap: 0
  })

/** The completion brake's confident answer, so every run can finish. */
const confident = {
  complete: { probability: 0.99 },
  overclaims: { probability: 0.01 },
  invented: { probability: 0.01 }
}

/** A calm supervisor answer over a snapshot with these many candidates and recalled rows. */
const calm = (
  overrides: Readonly<Record<string, Evaluator.ScriptedAnswer>> = {}
): Readonly<Record<string, Evaluator.ScriptedAnswer>> => ({
  thrashing: { probability: 0.05 },
  on_target: { probability: 0.95 },
  suspect: { probability: 0.05 },
  outdated_context: { probability: 0.05 },
  irrelevant_context: { probability: 0.05 },
  frustrated: { score: 0 },
  anxious: { score: 0 },
  scared: { score: 0 },
  confused: { score: 0 },
  confident: { score: 2 },
  needs_help: { choice: "none" },
  ...overrides
})

const isSupervisor = (request: Evaluator.Request): boolean => Object.hasOwn(request.questions, "thrashing")

/**
 * An evaluator that answers the completion brake at once and the supervisor
 * from `answer`, recording every supervisor request it was contacted with.
 */
const scripted = (
  answer: (request: Evaluator.Request, ordinal: number) =>
    | Readonly<Record<string, Evaluator.ScriptedAnswer>>
    | Effect.Effect<Readonly<Record<string, Evaluator.ScriptedAnswer>>, Evaluator.EvaluatorError>
) => {
  const contacted: Array<Evaluator.Request> = []
  const layer = Evaluator.layerScripted((request) => {
    if (!isSupervisor(request)) return confident
    contacted.push(request)
    // A per-item question the case did not script is declined, so a case
    // about the run's shape is not failed by the candidate the model fixture's
    // "Here is the next step." prose always offers.
    const declined = Object.fromEntries(
      Object.keys(request.questions)
        .filter((key) => key.startsWith("remember_") || key.startsWith("insert_"))
        .map((key) => [key, { probability: 0.1 }] as const)
    )
    const scripted = answer(request, contacted.length - 1)
    return Effect.isEffect(scripted)
      ? Effect.map(scripted, (answers) => ({ ...declined, ...answers }))
      : { ...declined, ...scripted }
  })
  return { layer, contacted }
}

/** A steering source that drains nothing and, when told to, waits first. */
const steeringAfter = (wait: (boundary: string) => Effect.Effect<void>): Layer.Layer<Steering.Source> =>
  Steering.layer({
    read: () => Effect.succeed(Steering.empty()),
    drain: (input) =>
      wait(input.boundary).pipe(Effect.as({
        inserts: [],
        seatChanges: [],
        remaining: Steering.empty(),
        queued: false,
        duplicate: false
      }))
  })

/**
 * Holds each frame's boundary open until the supervisor has settled or
 * failed its reading of the frame BEFORE it, observed off the event stream:
 * a frame is offered by its own live boundary, so the earliest boundary that
 * can deliver its reading is the next one. The wait is the test's, not the
 * loop's: the loop under test still never awaits the fiber, which the first
 * case proves with an evaluator that never answers.
 */
const untilRead = () => {
  const gates = new Map<number, Deferred.Deferred<void>>()
  // What the observer saw, which is the durable record: the stream a test
  // collects may lag the fiber's publish, and a run that ends right after a
  // reading settles can end before that publish lands. Supervisor events are
  // asserted here; loop events are asserted on the stream as everywhere else.
  const seen: Array<AgentEvent.AgentEvent> = []
  const gate = (frame: number) => {
    const held = gates.get(frame)
    if (held !== undefined) return held
    const made = Effect.runSync(Deferred.make<void>())
    gates.set(frame, made)
    return made
  }
  return {
    seen,
    observer: (event: AgentEvent.AgentEvent) =>
      Effect.suspend(() => {
        seen.push(event)
        return event._tag === "supervisor-settled" || event._tag === "supervisor-unjudged"
          ? Effect.asVoid(Deferred.succeed(gate(event.frame), undefined))
          : Effect.void
      }),
    steering: steeringAfter((boundary) => {
      const frame = Number(boundary.split(":")[0])
      return frame === 0 ? Effect.void : Deferred.await(gate(frame - 1))
    })
  }
}

const threeFrames = [emits(`console.log("one")`), emits(`console.log("two")`), emits(`ctx.done("done")`)]

describe("Supervisor", () => {
  it("never waits for the supervisor: a run completes its frames while the evaluator never answers", async () => {
    const { contacted, layer } = scripted(() => Effect.never)
    const started = Date.now()
    const { events, failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      // A host's boundary does real work; a few milliseconds of it is what
      // lets the fiber be scheduled at all, and nothing here waits for it.
      steering: steeringAfter(() => Effect.sleep("5 millis"))
    })
    expect(failure).toBeUndefined()
    expect(of(events, "resolved")).toHaveLength(1)
    expect(of(events, "turn-closed")).toHaveLength(3)
    // Contacted, so the fiber ran; never settled, so the one reading in
    // flight at the end is journaled as interrupted and nothing else is.
    expect(contacted.length).toBeGreaterThanOrEqual(1)
    expect(of(events, "supervisor-settled")).toEqual([])
    expect(of(events, "supervisor-unjudged").map((event) => event.reason)).toEqual(["interrupted"])
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it("fires on every frame it reaches and is contacted with the snapshot the frame closed on", async () => {
    const seen: Array<Evaluator.Request> = []
    const read = untilRead()
    const { contacted, layer } = scripted((request) => {
      seen.push(request)
      return calm({
        frustrated: { score: 2 },
        anxious: { score: 1 },
        scared: { score: 0 },
        confused: { score: 1 },
        confident: { score: 0 },
        needs_help: { choice: "stuck" }
      })
    })
    const { events, failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      ...read
    })
    expect(failure).toBeUndefined()
    expect(contacted.length).toBeGreaterThanOrEqual(1)
    const first = seen[0]!
    const snapshot = Schema.decodeUnknownSync(Supervisor.Snapshot)(first.state)
    expect(snapshot.task).toContain(task)
    expect(snapshot.frames.map((frame) => frame.frame)).toEqual([0])
    expect(snapshot.frames[0]?.cell).toContain(`console.log("one")`)
    expect(snapshot.frames[0]?.transition).toBe("continue")
    expect(snapshot.signals.frame).toBe(0)
    expect(snapshot.signals.readOnlyFrames).toBe(1)
    expect(snapshot.recalled).toEqual([])
    // The model fixture's prose is one candidate, so one per-item question follows the eleven.
    expect(snapshot.candidates).toEqual(["Here is the next step."])
    expect(Object.keys(first.questions)).toEqual([
      "thrashing",
      "on_target",
      "suspect",
      "outdated_context",
      "irrelevant_context",
      "frustrated",
      "anxious",
      "scared",
      "confused",
      "confident",
      "needs_help",
      "remember_0"
    ])
    const settled = of(read.seen, "supervisor-settled")
    expect(settled.length).toBeGreaterThanOrEqual(1)
    expect(settled[0]).toMatchObject({
      scope: "session-1",
      frame: 0,
      thrashing: 0.05,
      onTarget: 0.95,
      suspect: 0.05,
      frustrated: "strong",
      anxious: "mild",
      scared: "none",
      confused: "mild",
      confident: "none",
      needsHelp: "stuck",
      crossed: false,
      nudged: false,
      inserted: [],
      remembered: []
    })
    // The full record beside it, under the supervisor's own classifier id.
    const decisions = of(read.seen, "decision-settled").filter((event) => event.classifier === "supervisor/turn")
    expect(decisions.length).toBeGreaterThanOrEqual(1)
    expect(decisions[0]?.answers["needs_help"]).toMatchObject({ kind: "choice", value: "stuck" })
    expect(decisions[0]?.acted).toBe(false)
  })

  it("delivers exactly one nudge at the next boundary when a reading crosses and steering is armed", async () => {
    const read = untilRead()
    const { contacted, layer } = scripted((_, ordinal) =>
      ordinal === 0 ? calm({ thrashing: { probability: 0.9 } }) : calm()
    )
    const { engine, events, failure } = await run({
      state: state(4),
      script: [
        emits(`console.log("a")`),
        emits(`console.log("b")`),
        emits(`console.log("c")`),
        emits(`ctx.done("done")`)
      ],
      evaluator: layer,
      ...read,
      supervisor: { steer: true, remember: true }
    })
    expect(failure).toBeUndefined()
    expect(contacted.length).toBeGreaterThanOrEqual(2)
    expect(of(events, "steering-drained").flatMap((event) => event.messages)).toEqual([])
    const drained = of(events, "steering-drained").flatMap((event) => event.supervisor ?? [])
    const texts = drained.flatMap((message) =>
      message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
    )
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("Supervisor")
    expect(texts[0]).toContain("thrashing 0.90")
    expect(texts[0]).toContain("1 consecutive frames changed nothing")
    // Frame 0 is offered by its own boundary and read during frame 1, so the
    // boundary closing frame 1 delivers it and frame 2 is the first to read it.
    const requests = engine.recorder.sealStep.map((step) =>
      step.request.messages.flatMap((message) =>
        message.content.flatMap((part) => part.type === "text" && part.text.includes("Supervisor") ? [part.text] : [])
      ).length
    )
    expect(requests[0]).toBe(0)
    expect(requests[1]).toBe(0)
    expect(requests[2]).toBe(1)
    expect(of(read.seen, "supervisor-settled")[0]).toMatchObject({ frame: 0, crossed: true, nudged: true })
    // The calm readings after it nudged nothing.
    expect(of(read.seen, "supervisor-settled").slice(1).every((event) => !event.nudged)).toBe(true)
  })

  it("journals a crossed reading and delivers nothing while steering is off", async () => {
    const read = untilRead()
    const { layer } = scripted(() => calm({ thrashing: { probability: 0.9 }, on_target: { probability: 0.1 } }))
    const { events } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      ...read
    })
    expect(of(events, "discipline-armed")[0]?.supervisorSteer).toBe(false)
    expect(of(events, "steering-drained").flatMap((event) => event.messages)).toEqual([])
    expect(of(read.seen, "supervisor-settled")[0]).toMatchObject({ crossed: true, nudged: false })
  })

  it("journals a typed unjudged reading and inserts nothing when the evaluator fails", async () => {
    const read = untilRead()
    const { contacted, layer } = scripted(() =>
      Effect.fail(new Evaluator.EvaluatorError({ code: "refused", status: 503, message: "gateway down" }))
    )
    const { events, failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      ...read,
      supervisor: { steer: true, remember: true }
    })
    expect(failure).toBeUndefined()
    expect(contacted.length).toBeGreaterThanOrEqual(1)
    const unjudged = of(read.seen, "supervisor-unjudged")
    expect(unjudged.length).toBeGreaterThanOrEqual(1)
    expect(unjudged[0]).toMatchObject({ scope: "session-1", frame: 0, reason: "refused", detail: "gateway down" })
    // No level, no word, no default: a failed reading is not a calm one.
    expect(of(read.seen, "supervisor-settled")).toEqual([])
    expect(of(read.seen, "decision-settled").filter((event) => event.classifier === "supervisor/turn")).toEqual([])
    expect(of(events, "steering-drained").flatMap((event) => event.messages)).toEqual([])
  })

  it("names the missing host when no evaluator is bound at all", async () => {
    const read = untilRead()
    const { events } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: Evaluator.layerUnavailable(),
      ...read
    })
    // `layerUnavailable` answers every request `unreachable`, the supervisor's included.
    expect(of(read.seen, "supervisor-unjudged")[0]?.reason).toBe("unreachable")
  })

  it("writes only the candidates Jev accepted and inserts only the recalled rows it accepted", async () => {
    const remembered: Array<string> = []
    const memory: Supervisor.Memory = {
      bound: true,
      recall: () =>
        Effect.succeed([
          { key: "tests", text: "Tests run with `python -m pytest -q`." },
          { key: "layout", text: "Sources live under src/." }
        ]),
      remember: (text) => Effect.sync(() => void remembered.push(text))
    }
    const read = untilRead()
    const { contacted, layer } = scripted((_, ordinal) =>
      // The first frame's reading accepts one candidate and one row; the
      // frames after it decline everything, as a reading of a run that has
      // already been shown the row would.
      ordinal === 0
        ? calm({
          remember_0: { probability: 0.9 },
          remember_1: { probability: 0.2 },
          insert_0: { probability: 0.9 },
          insert_1: { probability: 0.1 }
        })
        : calm()
    )
    const prose: ScriptedModel.Step = {
      events: [
        { type: "text-start", id: "t" },
        {
          type: "text-delta",
          id: "t",
          text:
            "The suite is invoked through tox, never pytest directly.\n\nNext I will edit add().\n\n```cell\nconsole.log(\"one\")\n```"
        },
        { type: "text-end", id: "t" },
        { type: "settle", stopReason: "stop" }
      ].map((event) => event as never)
    }
    const { events, failure } = await run({
      state: state(3),
      script: [prose, emits(`console.log("two")`), emits(`ctx.done("done")`)],
      evaluator: layer,
      ...read,
      supervisor: { steer: true, remember: true },
      memory
    })
    expect(failure).toBeUndefined()
    const first = contacted[0]!
    const snapshot = Schema.decodeUnknownSync(Supervisor.Snapshot)(first.state)
    expect(snapshot.candidates).toEqual([
      "The suite is invoked through tox, never pytest directly.",
      "Next I will edit add()."
    ])
    expect(snapshot.recalled.map((row) => row.key)).toEqual(["tests", "layout"])
    expect(Object.keys(first.questions).filter((key) => key.startsWith("remember_") || key.startsWith("insert_")))
      .toEqual(["remember_0", "remember_1", "insert_0", "insert_1"])
    expect(remembered).toEqual(["The suite is invoked through tox, never pytest directly."])
    const texts = of(events, "steering-drained").flatMap((event) => event.supervisor ?? []).flatMap((message) =>
      message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
    )
    expect(texts).toEqual([Supervisor.recalledInsert({ key: "tests", text: "Tests run with `python -m pytest -q`." })])
    expect(of(read.seen, "supervisor-settled")[0]).toMatchObject({ inserted: [0], remembered: [0], nudged: false })
  })

  describe("replay", () => {
    /** A scripted engine whose recorded boundaries persist across attempts. */
    const journaled = (fixture: ScriptedEngine.Fixture, records: Map<string, unknown>) =>
      EngineLike.layer(EngineLike.make({
        ...fixture.engine,
        record: (boundary) => {
          const key = `${boundary.name}\u0000${boundary.identity.frame}\u0000${boundary.identity.boundary}`
          const held = records.get(key)
          if (held !== undefined) {
            return Effect.fromResult(Schema.decodeUnknownResult(boundary.success)(held)).pipe(
              Effect.mapError((cause) => new HarnessError({ code: "engine_failed", message: "did not decode", cause }))
            )
          }
          const encode = Schema.encodeUnknownSync(
            boundary.success as unknown as Schema.Schema<unknown> & { readonly "EncodingServices": never }
          )
          return boundary.execute.pipe(Effect.tap((value) => Effect.sync(() => records.set(key, encode(value)))))
        }
      }))

    const attempt = async (
      records: Map<string, unknown>,
      evaluator: Layer.Layer<Evaluator.Evaluator>,
      read: ReturnType<typeof untilRead>
    ) => {
      const model = ScriptedModel.make([
        emits(`console.log("a")`),
        emits(`console.log("b")`),
        emits(`ctx.done("done")`)
      ])
      const events: Array<AgentEvent.AgentEvent> = []
      const engine = ScriptedEngine.make(model.model)
      await CellTurn.run({
        state: state(3),
        flows: [descriptor("fs/list")],
        supervisor: { steer: true, remember: true }
      })
        .pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.provide(journaled(engine, records)),
          Effect.provide(QuickJSSandbox.layer),
          Effect.provide(read.steering),
          Effect.provideService(AgentEvent.Observer, read.observer),
          Effect.provide(evaluator),
          Effect.runPromise
        )
      return { events, engine }
    }

    it("re-delivers the recorded nudge and makes zero supervisor calls", async () => {
      const records = new Map<string, unknown>()
      const first = scripted((_, ordinal) => ordinal === 0 ? calm({ thrashing: { probability: 0.9 } }) : calm())
      const originalRead = untilRead()
      const original = await attempt(records, first.layer, originalRead)
      expect(first.contacted.length).toBeGreaterThanOrEqual(1)
      expect([...records.keys()].filter((key) => key.startsWith("supervisor")).length).toBeGreaterThanOrEqual(1)

      const again = scripted(() => Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "asked" })))
      // Every boundary replays, so no frame is offered: nothing to wait for, nothing asked.
      const replayRead = untilRead()
      const replay = await attempt(records, again.layer, replayRead)
      expect(again.contacted).toEqual([])
      const inserts = (events: ReadonlyArray<AgentEvent.AgentEvent>) =>
        of(events, "steering-drained").map((event) =>
          [...event.messages, ...(event.supervisor ?? [])].flatMap((message) =>
            message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
          )
        )
      expect(inserts(replay.events)).toEqual(inserts(original.events))
      expect(inserts(replay.events).flat().filter((text) => text.includes("Supervisor"))).toHaveLength(1)
      // A replayed frame is not read again, and its recorded reading is not
      // re-published either: the journal already holds it.
      expect(of(replayRead.seen, "supervisor-settled")).toEqual([])
      expect(of(replayRead.seen, "supervisor-unjudged")).toEqual([])
      expect(of(originalRead.seen, "supervisor-settled").length).toBeGreaterThanOrEqual(1)
      // The replayed frames read the nudge exactly where the original did.
      expect(replay.engine.recorder.sealStep.map((step) => step.request.messages.length))
        .toEqual(original.engine.recorder.sealStep.map((step) => step.request.messages.length))
    })
  })

  describe("handle", () => {
    const open = (
      evaluator: Layer.Layer<Evaluator.Evaluator>,
      options: Supervisor.Options = { steer: true, remember: true }
    ) =>
      Effect.gen(function*() {
        const model = ScriptedModel.make([])
        const engine = ScriptedEngine.make(model.model)
        const events: Array<AgentEvent.AgentEvent> = []
        const handle = yield* Supervision.open({
          session: "session-1",
          engine: engine.engine,
          emit: (event) => Effect.sync(() => void events.push(event)),
          options
        })
        return { handle, events }
      }).pipe(Effect.provide(evaluator))

    const offer = (frame: number): Supervision.Offer => ({
      frame,
      digest: `cell-${frame}`,
      current: { frame, cell: "console.log(1)", prose: "", printed: "1", transition: "continue", mutated: false },
      snapshot: {
        task,
        signals: {
          frame,
          maxFrames: 10,
          readOnlyFrames: frame + 1,
          repeatFrames: 0,
          mutations: 0,
          remoteMutations: 0,
          treeMoved: false,
          paths: 0,
          checksRun: 0,
          checksFailing: 0,
          failuresUnanswered: 0,
          callsFailed: 0,
          callsSettled: 0,
          narrowingDemands: 0,
          unmovedDemands: 0,
          unresolvedDemands: 0,
          claimDemands: 0,
          sufficiencyStated: false
        },
        candidates: []
      }
    })

    it("keeps only the newest snapshot while a reading is in flight", async () => {
      const release = Effect.runSync(Deferred.make<void>())
      const { contacted, layer } = scripted(() =>
        Deferred.await(release).pipe(Effect.as(calm({ thrashing: { probability: 0.9 } })))
      )
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const { events, handle } = yield* open(layer)
        yield* handle.offer(offer(0))
        // Let the fiber take frame 0 and block on it, then slide two more in.
        yield* Effect.sleep("10 millis")
        yield* handle.offer(offer(1))
        yield* handle.offer(offer(2))
        yield* Deferred.succeed(release, undefined)
        yield* Effect.sleep("50 millis")
        expect(contacted.map((request) => (request.state as { signals: { frame: number } }).signals.frame)).toEqual([
          0,
          2
        ])
        expect(events.filter((event) => event._tag === "supervisor-settled").map((event) => event.frame)).toEqual([
          0,
          2
        ])
      })))
    })

    it("hands a verdict to the boundary of its own frame or the next, and drops it after that", async () => {
      const { layer } = scripted(() => calm({ thrashing: { probability: 0.9 } }))
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const { handle } = yield* open(layer)
        yield* handle.offer(offer(3))
        yield* Effect.sleep("20 millis")
        expect(yield* handle.take(3)).toHaveLength(1)
        // Taken once: the same boundary asked again gets nothing.
        expect(yield* handle.take(3)).toEqual([])
        yield* handle.offer(offer(4))
        yield* Effect.sleep("20 millis")
        expect(yield* handle.take(5)).toHaveLength(1)
        yield* handle.offer(offer(5))
        yield* Effect.sleep("20 millis")
        // A boundary two frames on is stale, and the stale verdict is dropped, not held.
        expect(yield* handle.take(7)).toEqual([])
        expect(yield* handle.take(6)).toEqual([])
      })))
    })

    it("keeps the transport's usage on the reading and the event", async () => {
      // A transport that answers calm and reports what the answer cost.
      const typed = (answers: Readonly<Record<string, Evaluator.ScriptedAnswer>>): Evaluator.RawAnswers =>
        Object.fromEntries(
          Object.entries(answers).map(([id, answer]) => [
            id,
            "probability" in answer
              ? { type: "boolean", probability: answer.probability }
              : "choice" in answer
              ? { type: "choice", choice: answer.choice }
              : { type: "score", score: answer.score }
          ])
        ) as Evaluator.RawAnswers
      const metered = Layer.succeed(Evaluator.Evaluator)(
        Evaluator.Evaluator.of({
          evaluate: () =>
            Effect.succeed({ answers: typed(calm()), latencyMs: 7, usage: { inputTokens: 321, outputTokens: 12 } })
        })
      )
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const { events, handle } = yield* open(metered)
        yield* handle.offer(offer(0))
        yield* Effect.sleep("20 millis")
        const settled = events.find((event) => event._tag === "supervisor-settled")
        expect(settled).toMatchObject({ frame: 0, usage: { inputTokens: 321, outputTokens: 12 } })
      })))
    })

    it("logs a reading it could not record and keeps serving the next one", async () => {
      const { contacted, layer } = scripted(() => calm())
      let refusals = 0
      await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          const model = ScriptedModel.make([])
          const engine = ScriptedEngine.make(model.model)
          const events: Array<AgentEvent.AgentEvent> = []
          const handle = yield* Supervision.open({
            session: "session-1",
            engine: {
              ...engine.engine,
              record: (boundary) =>
                boundary.identity.frame === 0
                  ? Effect.suspend(() => {
                    refusals += 1
                    return Effect.fail(new HarnessError({ code: "engine_failed", message: "journal closed" }))
                  })
                  : boundary.execute
            },
            emit: (event) => Effect.sync(() => void events.push(event)),
            options: { steer: true, remember: true }
          })
          yield* handle.offer(offer(0))
          yield* Effect.sleep("20 millis")
          yield* handle.offer(offer(1))
          yield* Effect.sleep("20 millis")
          // The refused frame journaled nothing and delivered nothing; the next one was read as usual.
          expect(refusals).toBe(1)
          expect(events.map((event) => [event._tag, "frame" in event ? event.frame : -1])).toEqual([
            ["decision-settled", 1],
            ["supervisor-settled", 1]
          ])
          expect(yield* handle.take(2)).toEqual([])
        }).pipe(Effect.provide(layer))
      ))
      expect(contacted).toHaveLength(1)
    })

    it("recalls only when a memory is bound and asks nothing per row when nothing was recalled", async () => {
      const { contacted, layer } = scripted(() => calm())
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const { handle } = yield* open(layer)
        yield* handle.offer(offer(0))
        yield* Effect.sleep("20 millis")
        expect(Object.keys(contacted[0]!.questions).some((key) => key.startsWith("insert_"))).toBe(false)
      })))
    })
  })

  describe("read", () => {
    const snapshot: Supervisor.Snapshot = {
      task,
      frames: [],
      signals: {
        frame: 0,
        maxFrames: 1,
        readOnlyFrames: 0,
        repeatFrames: 0,
        mutations: 0,
        remoteMutations: 0,
        treeMoved: false,
        paths: 0,
        checksRun: 0,
        checksFailing: 0,
        failuresUnanswered: 0,
        callsFailed: 0,
        callsSettled: 0,
        narrowingDemands: 0,
        unmovedDemands: 0,
        unresolvedDemands: 0,
        claimDemands: 0,
        sufficiencyStated: false
      },
      candidates: [],
      recalled: []
    }

    it("names the host that bound no evaluator, without asking anything", async () => {
      // The requirement is satisfied by the type and delivered by nothing: the
      // one case the compiler cannot rule out, so the reading says so itself.
      const result = await Effect.runPromise(
        Effect.result(Supervisor.read(snapshot)) as Effect.Effect<
          Result.Result<Supervisor.Reading, Supervisor.Unjudged>
        >
      )
      expect(result).toEqual(Result.fail({ reason: "unconfigured", detail: "No evaluator is installed on this host" }))
    })

    it("declares one classifier per snapshot shape and reuses it", () => {
      expect(Supervisor.classifierFor(0, 0)).toBe(Supervisor.classifier)
      expect(Supervisor.classifierFor(2, 1)).toBe(Supervisor.classifierFor(2, 1))
      expect(Supervisor.classifierFor(2, 1).digest).not.toBe(Supervisor.classifier.digest)
      // Bounded: a snapshot past the limits asks the limit's questions.
      expect(Object.keys(Supervisor.classifierFor(99, 99).questions).filter((key) => key.startsWith("remember_")))
        .toHaveLength(Supervisor.candidateLimit)
      expect(Object.keys(Supervisor.classifierFor(99, 99).questions).filter((key) => key.startsWith("insert_")))
        .toHaveLength(Supervisor.recalledLimit)
    })
  })

  describe("memory port", () => {
    it("recalls nothing and writes nothing when nothing is bound", async () => {
      expect(Supervisor.memoryNone.bound).toBe(false)
      expect(await Effect.runPromise(Supervisor.memoryNone.recall("anything", 3))).toEqual([])
      expect(await Effect.runPromise(Supervisor.memoryNone.remember("anything"))).toBeUndefined()
      expect(await Effect.runPromise(Effect.map(Supervisor.Memory, (memory) => memory.bound))).toBe(false)
    })

    it("the idle handle drops offers and hands every boundary nothing", async () => {
      await Effect.runPromise(Supervision.none.offer({
        frame: 0,
        digest: "c",
        current: { frame: 0, cell: "", prose: "", printed: "", transition: "continue", mutated: false },
        snapshot: {
          task,
          signals: {
            frame: 0,
            maxFrames: 1,
            readOnlyFrames: 0,
            repeatFrames: 0,
            mutations: 0,
            remoteMutations: 0,
            treeMoved: false,
            paths: 0,
            checksRun: 0,
            checksFailing: 0,
            failuresUnanswered: 0,
            callsFailed: 0,
            callsSettled: 0,
            narrowingDemands: 0,
            unmovedDemands: 0,
            unresolvedDemands: 0,
            claimDemands: 0,
            sufficiencyStated: false
          },
          candidates: []
        }
      }))
      expect(await Effect.runPromise(Supervision.none.take(0))).toEqual([])
    })
  })

  describe("text", () => {
    it("clips a frame's prints to their newest bytes and says so", () => {
      expect(Supervisor.tail("short")).toBe("short")
      const long = "x".repeat(Supervisor.frameBytes + 10)
      const clipped = Supervisor.tail(long)
      expect(clipped.startsWith("[… older bytes elided]\n")).toBe(true)
      expect(clipped.endsWith("x".repeat(Supervisor.frameBytes))).toBe(true)
    })

    it("offers prose paragraphs as candidates and never a fenced block", () => {
      expect(Supervisor.candidates("")).toEqual([])
      expect(Supervisor.candidates("one\n\n```\ncode\n```\n\ntwo\n\nthree\n\nfour\n\nfive")).toEqual([
        "one",
        "two",
        "three",
        "four"
      ])
    })

    it("strips a fenced cell from the model's prose", () => {
      expect(Supervision.prose("Plan.\n\n```cell\nctx.done(1)\n```\n\nAfter.")).toBe("Plan.\n\n\n\nAfter.")
      expect(Supervision.prose("```typescript\nlet x = 1")).toBe("")
    })
  })

  describe("judge", () => {
    const reading = (overrides: Partial<Supervisor.Reading> = {}): Supervisor.Reading => ({
      thrashing: 0.1,
      onTarget: 0.9,
      suspect: 0.1,
      outdatedContext: 0.1,
      irrelevantContext: 0.1,
      emotions: { frustrated: "none", anxious: "none", scared: "none", confused: "none", confident: "strong" },
      needsHelp: "none",
      remember: [],
      insert: [],
      latencyMs: 1,
      asked: { digest: "d", questions: {}, state: null, answers: {} },
      ...overrides
    })
    const snapshot: Supervisor.Snapshot = {
      task,
      frames: [],
      signals: {
        frame: 2,
        maxFrames: 10,
        readOnlyFrames: 0,
        repeatFrames: 2,
        mutations: 1,
        remoteMutations: 0,
        treeMoved: true,
        paths: 3,
        checksRun: 1,
        checksFailing: 1,
        failuresUnanswered: 1,
        callsFailed: 0,
        callsSettled: 4,
        narrowingDemands: 0,
        unmovedDemands: 0,
        unresolvedDemands: 0,
        claimDemands: 0,
        sufficiencyStated: false
      },
      candidates: ["a", "b"],
      recalled: [{ key: "k", text: "t" }]
    }

    it("crosses on any of the three thresholds and nudges only when armed", () => {
      expect(Supervisor.judge(snapshot, reading(), { steer: true, remember: true }).crossed).toBe(false)
      for (const crossed of [{ thrashing: 0.5 }, { onTarget: 0.5 }, { suspect: 0.5 }] as const) {
        const armed = Supervisor.judge(snapshot, reading(crossed), { steer: true, remember: true })
        expect(armed.crossed).toBe(true)
        expect(armed.nudge).toContain("1 check last reported failing")
        expect(armed.nudge).toContain("2 consecutive frames repeated earlier calls")
        const disarmed = Supervisor.judge(snapshot, reading(crossed), { steer: false, remember: true })
        expect(disarmed.crossed).toBe(true)
        expect(disarmed.nudge).toBeUndefined()
      }
      for (const obsolete of [{ outdatedContext: 0.9 }, { irrelevantContext: 0.9 }] as const) {
        const armed = Supervisor.judge(snapshot, reading(obsolete), { steer: true, remember: true })
        expect(armed.crossed).toBe(true)
        expect(armed.nudge).toContain("Consider compacting the obsolete material")
        expect(armed.nudge).toContain("stable cache prefix")
        expect(Supervisor.judge(snapshot, reading(obsolete), { steer: false, remember: true }).nudge).toBeUndefined()
      }
    })

    it("names the frame its counts describe", () => {
      const text = Supervisor.nudge(snapshot, reading({ thrashing: 0.9 }))
      expect(text).toContain("Evidence at frame 2:")
      expect(text).toContain("through frame 2")
    })

    it("decides crossing by one shared rule that names each trigger", () => {
      const cases: ReadonlyArray<readonly [Partial<Supervisor.Reading>, ReadonlyArray<Supervisor.Trigger>]> = [
        [{}, []],
        [{ thrashing: 0.5 }, ["thrashing"]],
        [{ thrashing: 0.49 }, []],
        [{ onTarget: 0.5 }, ["off_target"]],
        [{ onTarget: 0.51 }, []],
        [{ suspect: 0.5 }, ["suspect"]],
        [{ outdatedContext: 0.5 }, ["outdated_context"]],
        [{ irrelevantContext: 0.5 }, ["irrelevant_context"]],
        [{ thrashing: 0.9, irrelevantContext: 0.9 }, ["thrashing", "irrelevant_context"]]
      ]
      for (const [overrides, fired] of cases) {
        const read = reading(overrides)
        expect(Supervisor.triggered(read)).toEqual(fired)
        expect(Supervisor.crosses(read)).toBe(fired.length > 0)
        expect(Supervisor.judge(snapshot, read, { steer: false, remember: false }).crossed).toBe(fired.length > 0)
      }
      expect(Object.keys(Supervisor.triggers)).toEqual([
        "thrashing",
        "off_target",
        "suspect",
        "outdated_context",
        "irrelevant_context"
      ])
    })

    it("names only the evidence the counts hold", () => {
      const quiet: Supervisor.Snapshot = {
        ...snapshot,
        signals: {
          ...snapshot.signals,
          repeatFrames: 0,
          checksFailing: 0,
          failuresUnanswered: 0,
          callsFailed: 0,
          readOnlyFrames: 3,
          mutations: 0
        }
      }
      const text = Supervisor.nudge(quiet, reading({ thrashing: 0.7, onTarget: 0.2, suspect: 0.6 }))
      expect(text).toContain("thrashing 0.70")
      expect(text).toContain("on target 0.20")
      expect(text).toContain("suspect 0.60")
      expect(text).toContain("3 consecutive frames changed nothing; 0 frames changed the workspace")
      expect(text).not.toContain("failing")
      expect(text).not.toContain("repeated")
      expect(text).not.toContain("calls failed")
      const plural = Supervisor.nudge(
        { ...snapshot, signals: { ...snapshot.signals, checksFailing: 2, failuresUnanswered: 2, callsFailed: 1 } },
        reading({ thrashing: 0.9 })
      )
      expect(plural).toContain("2 checks last reported failing")
      expect(plural).toContain("2 failing checks never answered by a pass")
      expect(plural).toContain("1 of 4 calls failed")
      expect(plural).toContain("1 frame changed the workspace")
    })

    it("needs_help never nudges on its own", () => {
      const verdict = Supervisor.judge(snapshot, reading({ needsHelp: "risky_action" }), {
        steer: true,
        remember: true
      })
      expect(verdict.crossed).toBe(false)
      expect(verdict.nudge).toBeUndefined()
    })

    it("gates memory writes and inserts on the options and the per-item answers", () => {
      const accepted = reading({ remember: [true, false], insert: [true] })
      expect(Supervisor.judge(snapshot, accepted, { steer: true, remember: true })).toMatchObject({
        remembers: ["a"],
        inserts: [Supervisor.recalledInsert({ key: "k", text: "t" })]
      })
      expect(Supervisor.judge(snapshot, accepted, { steer: false, remember: false })).toMatchObject({
        remembers: [],
        inserts: []
      })
    })
  })
})

describe("Supervisor inserts on the transcript", () => {
  const textOf = (message: ModelRequest.Message): string =>
    message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")

  /** An evaluator that crosses on frame 0's reading, is calm after it, and records every request. */
  const crossingOnce = () => {
    const supervisor: Array<Evaluator.Request> = []
    const completion: Array<Evaluator.Request> = []
    const layer = Evaluator.layerScripted((request) => {
      if (!isSupervisor(request)) {
        completion.push(request)
        return confident
      }
      supervisor.push(request)
      const declined = Object.fromEntries(
        Object.keys(request.questions)
          .filter((key) => key.startsWith("remember_") || key.startsWith("insert_"))
          .map((key) => [key, { probability: 0.1 }] as const)
      )
      return { ...declined, ...(supervisor.length === 1 ? calm({ thrashing: { probability: 0.9 } }) : calm()) }
    })
    return { layer, supervisor, completion }
  }

  it("keeps a supervisor nudge out of the completion task and later snapshots while the model reads it", async () => {
    const read = untilRead()
    const evaluator = crossingOnce()
    const { engine, events, failure } = await run({
      // A frame to spare, so the completing boundary waits for frame 2's reading.
      state: state(5),
      script: [
        emits(`console.log("a")`),
        emits(`console.log("b")`),
        emits(`console.log("c")`),
        emits(`ctx.done("done")`)
      ],
      evaluator: evaluator.layer,
      ...read,
      supervisor: { steer: true, remember: false }
    })
    expect(failure).toBeUndefined()
    // The model read the nudge.
    const transcript = engine.recorder.sealStep.flatMap((step) => step.request.messages.map(textOf))
    expect(transcript.filter((text) => text.includes("Supervisor"))).not.toEqual([])
    // The drain names it as the supervisor's, not the person's.
    expect(of(events, "steering-drained").flatMap((event) => event.messages)).toEqual([])
    expect(of(events, "steering-drained").flatMap((event) => event.supervisor ?? []).map(textOf).join())
      .toContain("Supervisor")
    // The completion brake's task and every later snapshot's task carry none of it.
    expect(evaluator.completion).toHaveLength(1)
    const claimed = evaluator.completion[0]!.state as { readonly task: string }
    expect(claimed.task).toContain(task)
    expect(claimed.task).not.toContain("Supervisor")
    expect(claimed.task).not.toContain("The person now says")
    expect(evaluator.supervisor.length).toBeGreaterThanOrEqual(3)
    for (const request of evaluator.supervisor) {
      const snapshot = Schema.decodeUnknownSync(Supervisor.Snapshot)(request.state)
      expect(snapshot.task).not.toContain("Supervisor")
    }
  })

  const pathsToTheAsk = [
    { name: "a raised cell", frame: emits(`throw new Error("boom")`), ask: "The cell threw" },
    { name: "a parse rejection", frame: prose("I will think about it first."), ask: "No cell was found" },
    { name: "a refused park", frame: emits(`ctx.park("waiting-input", "which branch?")`), ask: "No human is available" }
  ] as const

  it.each(pathsToTheAsk)("puts a supervisor insert above the ask on $name", async ({ ask, frame }) => {
    // Only frame 1's boundary waits, for frame 0's reading: a rejected frame
    // is never offered, so no later boundary has a reading of its own to wait for.
    const settled = Effect.runSync(Deferred.make<void>())
    const read = {
      observer: (event: AgentEvent.AgentEvent) =>
        event._tag === "supervisor-settled" && event.frame === 0
          ? Effect.asVoid(Deferred.succeed(settled, undefined))
          : Effect.void,
      steering: steeringAfter((boundary) => boundary.startsWith("1:") ? Deferred.await(settled) : Effect.void)
    }
    const evaluator = crossingOnce()
    const { engine, failure } = await run({
      // No in-frame re-ask, so a cell-less answer takes the rejection exit.
      state: state(4, 0),
      script: [emits(`console.log("a")`), frame, emits(`console.log("c")`), emits(`ctx.done("done")`)],
      evaluator: evaluator.layer,
      ...read,
      supervisor: { steer: true, remember: false }
    })
    expect(failure).toBeUndefined()
    // Frame 1's boundary delivers frame 0's reading; frame 2 is the first to read it.
    const messages = engine.recorder.sealStep[2]!.request.messages.map(textOf)
    const lastIndex = (needle: string): number =>
      messages.reduce((found, text, index) => text.includes(needle) ? index : found, -1)
    const nudge = lastIndex("Supervisor")
    const asked = lastIndex(ask)
    expect(nudge).toBeGreaterThanOrEqual(0)
    expect(asked).toBeGreaterThan(nudge)
  })

  it("journals an unreachable reading with the jev flow's masked text, never the transport's own", async () => {
    const read = untilRead()
    const { layer } = scripted(() =>
      Effect.fail(
        new Evaluator.EvaluatorError({
          code: "unreachable",
          message: "connect ECONNREFUSED https://judge.internal.example:8443/v4?token=abc"
        })
      )
    )
    const { failure } = await run({ state: state(3), script: threeFrames, evaluator: layer, ...read })
    expect(failure).toBeUndefined()
    const unjudged = of(read.seen, "supervisor-unjudged")
    expect(unjudged.length).toBeGreaterThanOrEqual(1)
    expect(unjudged[0]).toMatchObject({ reason: "unreachable", detail: Evaluator.unreachableMessage })
    expect(JSON.stringify(unjudged)).not.toContain("judge.internal")
  })

  it("journals a reading still in flight when the run ends as interrupted, within the bound", async () => {
    const { contacted, layer } = scripted(() => Effect.never)
    const started = Date.now()
    const { events, failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      steering: steeringAfter(() => Effect.sleep("5 millis"))
    })
    const elapsed = Date.now() - started
    expect(failure).toBeUndefined()
    expect(of(events, "resolved")).toHaveLength(1)
    expect(contacted.length).toBeGreaterThanOrEqual(1)
    // Exactly the reading that was asked and never answered, typed, and nothing settled.
    const unjudged = of(events, "supervisor-unjudged")
    expect(unjudged).toHaveLength(1)
    expect(unjudged[0]).toMatchObject({ scope: "session-1", reason: "interrupted" })
    expect(of(events, "supervisor-settled")).toEqual([])
    // The grace is bounded: the run ends however long the reading would have taken.
    expect(elapsed).toBeLessThan(Supervisor.closeGraceMs + 3_000)
  })

  it("lets a reading in flight when the run ends settle inside the grace", async () => {
    const { contacted, layer } = scripted(() => Effect.as(Effect.sleep("150 millis"), calm()))
    const { events, failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      steering: steeringAfter(() => Effect.sleep("5 millis"))
    })
    expect(failure).toBeUndefined()
    expect(contacted.length).toBeGreaterThanOrEqual(1)
    // Every reading the fiber took settled; none was cut off by the run's end.
    expect(of(events, "supervisor-unjudged")).toEqual([])
    expect(of(events, "supervisor-settled")).toHaveLength(contacted.length)
  })

  it.each([false, true])("stamps every reading with the steer it ran under (steer: %s)", async (steer) => {
    const read = untilRead()
    const { layer } = scripted(() => calm())
    const { failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      ...read,
      supervisor: { steer, remember: false }
    })
    expect(failure).toBeUndefined()
    const settled = of(read.seen, "supervisor-settled")
    expect(settled.length).toBeGreaterThanOrEqual(1)
    // `discipline-armed` is written once, at frame 0; a resumed run armed
    // differently is only on the record through the readings it takes.
    expect(settled.map((event) => event.steer)).toEqual(settled.map(() => steer))
  })

  it("journals a typed memory failure for a recall or a write the store refused", async () => {
    const memory: Supervisor.Memory = {
      bound: true,
      recall: () => Effect.fail({ detail: "database is locked" }),
      remember: () => Effect.fail({ detail: "database is locked" })
    }
    const read = untilRead()
    const { layer } = scripted(() => calm({ remember_0: { probability: 0.9 } }))
    const { failure } = await run({
      state: state(3),
      script: threeFrames,
      evaluator: layer,
      ...read,
      supervisor: { steer: false, remember: true },
      memory
    })
    expect(failure).toBeUndefined()
    const failed = of(read.seen, "supervisor-memory-failed")
    expect(failed.filter((event) => event.operation === "recall").length).toBeGreaterThanOrEqual(1)
    expect(failed.filter((event) => event.operation === "remember").length).toBeGreaterThanOrEqual(1)
    expect(failed[0]).toMatchObject({ scope: "session-1", frame: 0, detail: "database is locked" })
    // The reading itself still settles: a memory fault is not a supervisor fault.
    expect(of(read.seen, "supervisor-settled").length).toBeGreaterThanOrEqual(1)
  })
})
