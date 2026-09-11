/**
 * The durable poller: what one attempt puts in a plan, how long the rounds it
 * hands off to itself actually wait, what a re-driven round replays instead of
 * dispatching again, and what a check that hangs costs the poll.
 *
 * Every wait here is a step the case takes on the `TestClock`, so the schedule
 * is asserted rather than timed. Following a handoff to the next round is the
 * ENGINE's job, so each case opens the next round itself with the payload the
 * previous one settled on, which is what `@smthrs/engine` does for real.
 * `examples/src/34-poll.ts` runs the same poller on the durable engine across a
 * process restart.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, DurableClock, DurableDeferred, Flow, FlowRuntime, Graph, Interpreter, Poll, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { withCrypto } from "./Crypto.ts"
import { layerMemoryOver, makeMemoryState, type MemoryState } from "./MemoryFlowRuntime.ts"

/** Attempts observed by the check, in dispatch order. */
const probes: Array<number> = []

/** The check every case polls with: satisfied once `attempt` reaches `until`. */
const Probe = Action.make("poll/probe", {
  payload: { until: Schema.Number, attempt: Schema.Number },
  success: Poll.CheckResult(Schema.String)
})

const probeLayer = Probe.toLayer(({ attempt, until }) =>
  Effect.sync(() => {
    probes.push(attempt)
    return { satisfied: attempt >= until, output: `ready:${attempt}` }
  })
)

/**
 * A check whose own work never answers, bounded the way
 * `docs/guides/poll-until-ready.md` says to bound one: the work is raced against a durable clock INSIDE the
 * check's implementation, and the clock's branch reports "not ready yet" so the
 * poll goes on to its next attempt instead of hanging on this one.
 */
const Hung = Action.make("poll/hung", {
  payload: { attempt: Schema.Number },
  success: Poll.CheckResult(Schema.String)
})

/** The work the hung check waits on. Nothing ever answers it. */
const stuck = DurableDeferred.make("poll/hung/work", { success: Poll.CheckResult(Schema.String) })

const hungLayer = Hung.toLayer(({ attempt }) =>
  DurableDeferred.raceAll({
    name: `poll/hung#${attempt}`,
    success: Poll.CheckResult(Schema.String),
    error: Schema.Never,
    effects: [
      DurableDeferred.await(stuck),
      Effect.as(
        DurableClock.sleep({
          name: `poll/hung#${attempt}`,
          duration: Duration.millis(500),
          inMemoryThreshold: Duration.zero
        }),
        { satisfied: false, output: `unknown:${attempt}` }
      )
    ]
  })
)

const Rising = Poll.make("poll/rising", {
  input: { until: Schema.Number },
  result: Schema.String,
  intervalMs: 100,
  backoff: "exponential",
  maxAttempts: 3,
  check: ({ attempt, until }) => Probe.call({ attempt, until })
})

const Bounded = Poll.make("poll/bounded", {
  input: { until: Schema.Number },
  result: Schema.String,
  intervalMs: 10,
  maxAttempts: 2,
  onTimeout: "return-last",
  check: ({ attempt, until }) => Probe.call({ attempt, until })
})

const Failing = Poll.make("poll/failing", {
  input: { until: Schema.Number },
  result: Schema.String,
  intervalMs: 10,
  maxAttempts: 2,
  onTimeout: "fail",
  check: ({ attempt, until }) => Probe.call({ attempt, until })
})

const Hanging = Poll.make("poll/hanging", {
  input: {},
  result: Schema.String,
  intervalMs: 100,
  maxAttempts: 2,
  onTimeout: "return-last",
  check: ({ attempt }) => Hung.call({ attempt })
})

const wired = <Implemented>(
  registration: Layer.Layer<Implemented, never, Crypto.Crypto | FlowRuntime.FlowRuntime | Action.Implementations>,
  state: MemoryState = makeMemoryState()
): Layer.Layer<Implemented | FlowRuntime.FlowRuntime | Action.Implementations, never, Crypto.Crypto> =>
  registration.pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(layerMemoryOver(state))
  )

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body().pipe(Effect.provide(TestClock.layer()))))

/** One round of a poll lineage, whatever it settles with. */
type Round = Flow.Result<string, typeof Poll.Failure.Type>

/** The shape every poll declared here has, so the helpers can be shared. */
type Poller<Payload extends Flow.AnyStructSchema, R> = Flow.Flow<
  string,
  Payload,
  typeof Schema.String,
  typeof Poll.Failure,
  R
>

/**
 * Lets the runtime's forked fibers reach the state the round settles in,
 * WITHOUT moving the clock: every wait in these cases is a step the case takes
 * itself, so a helper that nudged the clock would blur the schedule it asserts.
 *
 * `past` names the state the caller is waiting to leave, for the step after a
 * timer fires and the round that was parked is re-driven.
 */
const settled = <Payload extends Flow.AnyStructSchema, R>(
  flow: Poller<Payload, R>,
  executionId: string,
  options?: { readonly past: Round["_tag"] }
): Effect.Effect<Round, never, FlowRuntime.FlowRuntime> =>
  Effect.gen(function*() {
    for (let turn = 0; turn < 200; turn++) {
      yield* Effect.yieldNow
      const polled = yield* Effect.orDie(flow.poll(executionId))
      if (Option.isSome(polled) && polled.value._tag !== options?.past) return polled.value
    }
    return yield* Effect.die(`${executionId} never left ${options?.past ?? "its unstarted state"}`)
  })

/** Opens one round the way the engine opens the round after a handoff. */
const openRound = <Payload extends Flow.AnyStructSchema, R>(
  flow: Poller<Payload, R>,
  payload: Payload["~type.make.in"],
  executionId: string
) =>
  Effect.gen(function*() {
    yield* Effect.orDie(flow.execute(payload, { executionId, discard: true }))
    return yield* settled(flow, executionId)
  })

/** The payload the next round is opened with, as the round handed it off. */
const handoff = <Payload extends Flow.AnyStructSchema, R>(
  flow: Poller<Payload, R>,
  round: Round
): Effect.Effect<Payload["Type"], never, Payload["DecodingServices"]> =>
  Effect.gen(function*() {
    if (round._tag !== "Handoff") return yield* Effect.die(`expected a handoff, got ${round._tag}`)
    return yield* Effect.orDie(Schema.decodeUnknownEffect(flow.payloadSchema)(round.payload))
  })

/**
 * Gives the runtime's forked fibers turns to run, without moving the clock, so
 * a round that was re-driven has armed its next wait before the case steps the
 * clock again.
 */
const turns = Effect.gen(function*() {
  for (let turn = 0; turn < 50; turn++) yield* Effect.yieldNow
})

/** The wake a fired timer produces: the round is re-driven and settles again. */
const wake = <Payload extends Flow.AnyStructSchema, R>(
  flow: Poller<Payload, R>,
  executionId: string
) => settled(flow, executionId, { past: "Suspended" })

const succeededWith = (round: Round): unknown =>
  round._tag === "Complete" && Exit.isSuccess(round.exit) ? round.exit.value : undefined

describe("Poll.delayMillis", () => {
  it("spaces attempts by the declared backoff", () => {
    const fixed = [1, 2, 3].map((attempt) => Poll.delayMillis({ intervalMs: 100, backoff: "fixed", attempt }))
    const linear = [1, 2, 3].map((attempt) => Poll.delayMillis({ intervalMs: 100, backoff: "linear", attempt }))
    const exponential = [1, 2, 3].map((attempt) =>
      Poll.delayMillis({ intervalMs: 100, backoff: "exponential", attempt })
    )

    expect(fixed).toEqual([100, 100, 100])
    expect(linear).toEqual([100, 200, 300])
    expect(exponential).toEqual([100, 200, 400])
  })
})

describe("stable error codes", () => {
  it("defaults every newly frozen code", () => {
    expect(new Poll.PollExhausted({ poll: "poll/code", attempts: 1, message: "done" })).toMatchObject({
      _tag: "@smthrs/flow/PollExhausted",
      code: "poll_exhausted"
    })
    expect(new FlowRuntime.FlowCycleDetected({ path: ["parent", "child"] })).toMatchObject({
      _tag: "@smthrs/flow/FlowCycleDetected",
      code: "flow_cycle_detected"
    })
    expect(new FlowRuntime.FlowExecutionNotFound({ executionId: "missing" })).toMatchObject({
      _tag: "@smthrs/flow/FlowExecutionNotFound",
      code: "execution_not_found"
    })
  })
})

describe("Poll as a plan", () => {
  it("reproduces body and predicate identities and re-keys each semantic capture", () => {
    const make = (changes: {
      tag?: string
      intervalMs?: number
      backoff?: Poll.Backoff
      maxAttempts?: number
      onTimeout?: "fail" | "return-last"
      checkVersion?: string
    } = {}) =>
      Poll.make(changes.tag ?? "poll/identity", {
        input: { until: Schema.Number },
        result: Schema.String,
        intervalMs: changes.intervalMs ?? 10,
        backoff: changes.backoff ?? "fixed",
        maxAttempts: changes.maxAttempts ?? 3,
        onTimeout: changes.onTimeout ?? "fail",
        check: Node.capture(
          { action: Probe.name, implementationVersion: changes.checkVersion ?? "probe/v1" },
          ({ attempt, until }) => Probe.call({ attempt, until })
        )
      })
    const identities = (poll: ReturnType<typeof make>) => {
      const graph = Graph.build(poll, { until: 3 }, { callbackIdentity: "stable" })
      expect(graph.diagnostics).toEqual([])
      const branch = graph.nodes.find((node) => node.ast._tag === "Branch")?.ast
      expect(branch?._tag).toBe("Branch")
      return { body: Node.functionIdentity(poll.body), predicate: branch?._tag === "Branch" && branch.predicate }
    }
    const first = identities(make())
    expect(identities(make())).toEqual(first)
    for (
      const change of [
        { tag: "poll/renamed" },
        { intervalMs: 20 },
        { backoff: "linear" as const },
        { maxAttempts: 4 },
        { onTimeout: "return-last" as const },
        { checkVersion: "probe/v2" }
      ]
    ) {
      const changed = identities(make(change))
      expect(changed.body).not.toEqual(first.body)
      expect(changed.predicate).not.toEqual(first.predicate)
    }
  })

  it("keeps an uncaptured check process-local", () => {
    const graph = Graph.build(Rising, { until: 3 }, { callbackIdentity: "stable" })
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({ code: "unstable_callback", node: "root" }))
    expect(() => Graph.drafts(graph)).toThrow(/process-local identity/)
    expect(Graph.build(Rising, { until: 3 }).diagnostics).toEqual([])
  })

  it("shows the attempt's check, its sleep, and the handoff that opens the next round", () => {
    const graph = Graph.build(Rising, { until: 3, attempt: 1 })
    const nodes = Graph.nodes(graph)
    const sleep = nodes.find((node) => node.ast._tag === "ActionCall" && node.ast.action === Sleep.tag)
    const handedOff = nodes.find((node) => node.ast._tag === "FlowCall" && node.ast.mode === "handoff")

    expect(graph.diagnostics).toEqual([])
    expect(nodes.some((node) => node.ast._tag === "ActionCall" && node.ast.action === "poll/probe")).toBe(true)
    expect(sleep?.payload).toEqual({ millis: 100 })
    expect(handedOff?.ast).toMatchObject({ _tag: "FlowCall", flow: "poll/rising", mode: "handoff" })
    expect(handedOff?.payload).toEqual({ until: 3, attempt: 2 })
  })

  it("grows the declared wait with the attempt", () => {
    const second = Graph.nodes(Graph.build(Rising, { until: 3, attempt: 2 }))
      .find((node) => node.ast._tag === "ActionCall" && node.ast.action === Sleep.tag)

    expect(second?.payload).toEqual({ millis: 200 })
  })

  it("replaces the wait with the exhaustion step on the last attempt", () => {
    const nodes = Graph.nodes(Graph.build(Rising, { until: 3, attempt: 3 }))

    expect(nodes.some((node) => node.ast._tag === "ActionCall" && node.ast.action === Sleep.tag)).toBe(false)
    expect(nodes.some((node) => node.ast._tag === "FlowCall" && node.ast.mode === "handoff")).toBe(false)
    expect(
      nodes.find((node) => node.ast._tag === "ActionCall" && node.ast.action === Poll.exhaustedTag)?.payload
    ).toEqual({ poll: "poll/rising", attempts: 3 })
  })

  it("carries the attempt budget as the lineage round budget", () => {
    expect(Rising.maxRounds).toBe(3)
  })

  it("refuses an interval no durable clock can be armed with", () => {
    const declare = (intervalMs: number) => () =>
      Poll.make("poll/refused-interval", {
        input: { until: Schema.Number },
        result: Schema.String,
        intervalMs,
        maxAttempts: 2,
        check: ({ attempt, until }) => Probe.call({ attempt, until })
      })

    // The wait between attempts becomes a `system/sleep` payload, and a sleep
    // of any of these lengths arms a timer that never fires.
    expect(declare(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(declare(Number.POSITIVE_INFINITY)).toThrow(/intervalMs/)
    expect(declare(Number.NaN)).toThrow(/intervalMs/)
    expect(declare(-1)).toThrow(/intervalMs/)
    // Zero is a schedule, not a mistake: it checks again on the next round.
    expect(declare(0)).not.toThrow()
  })

  it("refuses an attempt budget below one whole attempt, naming the poll option", () => {
    const declare = (maxAttempts: number) => () =>
      Poll.make("poll/refused-budget", {
        input: { until: Schema.Number },
        result: Schema.String,
        intervalMs: 10,
        maxAttempts,
        check: ({ attempt, until }) => Probe.call({ attempt, until })
      })

    expect(declare(0)).toThrow(RangeError)
    // `maxAttempts`, not the `maxRounds` the budget becomes: the author never
    // wrote `maxRounds`, so a complaint about it names an option they cannot
    // find.
    expect(declare(0)).toThrow(/maxAttempts/)
    expect(declare(1.5)).toThrow(/maxAttempts/)
    expect(declare(Number.POSITIVE_INFINITY)).toThrow(/maxAttempts/)
    expect(declare(1)).not.toThrow()
  })

  it("reserves the durable attempt field for the poll lineage", () => {
    expect(() =>
      Poll.make("poll/reserved-attempt", {
        input: { attempt: Schema.Number },
        result: Schema.String,
        intervalMs: 10,
        maxAttempts: 2,
        check: ({ attempt }) => Probe.call({ until: 2, attempt })
      })
    ).toThrow(/reserved "attempt"/)
  })

  it("refuses a schedule whose longest wait no durable clock can be armed with", () => {
    const declare = (options: {
      readonly intervalMs: number
      readonly maxAttempts: number
      readonly backoff: Poll.Backoff
    }) =>
    () =>
      Poll.make("poll/refused-schedule", {
        input: { until: Schema.Number },
        result: Schema.String,
        check: ({ attempt, until }) => Probe.call({ attempt, until }),
        ...options
      })

    // Every option below is a finite number on its own. The SCHEDULE they
    // describe is not: `delayMillis` multiplies the interval by the backoff, so
    // a five-second poll doubling for two thousand attempts asks, long before
    // the last one, for a wait of `Infinity` — the timer that never fires the
    // interval guard exists to refuse.
    expect(Poll.delayMillis({ intervalMs: 1000, backoff: "exponential", attempt: 2000 })).toBe(
      Number.POSITIVE_INFINITY
    )
    expect(declare({ intervalMs: 1000, maxAttempts: 2000, backoff: "exponential" })).toThrow(RangeError)
    expect(declare({ intervalMs: 1000, maxAttempts: 2000, backoff: "exponential" })).toThrow(/backoff/)
    expect(declare({ intervalMs: 1e308, maxAttempts: 3, backoff: "linear" })).toThrow(/backoff/)

    // The bound is the LAST wait the poll can arm, and that is the one before
    // the final attempt: an attempt at the budget gives up rather than sleeps.
    // Doubling from one millisecond, attempt 1024 is the longest finite wait,
    // so 1025 attempts is the largest legal budget and 1026 is one too many.
    expect(Poll.delayMillis({ intervalMs: 1, backoff: "exponential", attempt: 1024 })).toBeLessThan(
      Number.POSITIVE_INFINITY
    )
    expect(Poll.delayMillis({ intervalMs: 1, backoff: "exponential", attempt: 1025 })).toBe(
      Number.POSITIVE_INFINITY
    )
    expect(declare({ intervalMs: 1, maxAttempts: 1025, backoff: "exponential" })).not.toThrow()
    expect(declare({ intervalMs: 1, maxAttempts: 1026, backoff: "exponential" })).toThrow(/backoff/)

    // A poll of one attempt never sleeps, so it has no schedule to refuse.
    expect(declare({ intervalMs: 1e308, maxAttempts: 1, backoff: "exponential" })).not.toThrow()
  })
})

describe("Poll rounds", () => {
  effect("rejects an invalid caller-visible attempt before running the round", () => {
    probes.length = 0
    return Effect.gen(function*() {
      const result = yield* Rising.execute(
        { until: 3, attempt: Number.NaN },
        { executionId: "poll-invalid-attempt/1" }
      ).pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(String(result)).toContain("attempt")
      expect(probes).toEqual([])
    }).pipe(
      Effect.provide(wired(Layer.mergeAll(probeLayer, Sleep.layer, Poll.layer, Interpreter.layer(Rising))))
    )
  })

  effect("waits the declared schedule between attempts, then answers with what satisfied the check", () => {
    probes.length = 0
    return Effect.gen(function*() {
      // Round one runs the first attempt and parks on its own timer.
      const first = yield* openRound(Rising, { until: 3 }, "poll-rising/1")
      expect(first._tag).toBe("Suspended")
      expect(probes).toEqual([1])

      // Ninety-nine of the declared hundred milliseconds: nothing wakes, and
      // no second attempt runs.
      yield* TestClock.adjust("99 millis")
      expect((yield* settled(Rising, "poll-rising/1"))._tag).toBe("Suspended")
      expect(probes).toEqual([1])

      // The hundredth is the wait: the round wakes, replays the attempt it
      // already made, and hands off to the next one.
      yield* TestClock.adjust("1 milli")
      const opened = yield* wake(Rising, "poll-rising/1")
      expect(opened._tag).toBe("Handoff")
      expect(probes).toEqual([1])

      // Round two runs the second attempt and parks on a DOUBLED wait, which
      // is what `exponential` declared.
      const second = yield* openRound(Rising, yield* handoff(Rising, opened), "poll-rising/2")
      expect(second._tag).toBe("Suspended")
      expect(probes).toEqual([1, 2])

      yield* TestClock.adjust("199 millis")
      expect((yield* settled(Rising, "poll-rising/2"))._tag).toBe("Suspended")
      expect(probes).toEqual([1, 2])

      yield* TestClock.adjust("1 milli")
      const reopened = yield* wake(Rising, "poll-rising/2")
      expect(reopened._tag).toBe("Handoff")

      // Round three is satisfied, so the lineage settles with its output.
      const third = yield* openRound(Rising, yield* handoff(Rising, reopened), "poll-rising/3")
      expect(probes).toEqual([1, 2, 3])
      expect(succeededWith(third)).toBe("ready:3")
    }).pipe(
      Effect.provide(wired(Layer.mergeAll(probeLayer, Sleep.layer, Poll.layer, Interpreter.layer(Rising))))
    )
  })

  effect("answers with the last output at the bound when asked to return it", () => {
    probes.length = 0
    return Effect.gen(function*() {
      const first = yield* openRound(Bounded, { until: 99 }, "poll-bounded/1")
      yield* TestClock.adjust("10 millis")
      const opened = yield* wake(Bounded, "poll-bounded/1")
      const second = yield* openRound(Bounded, yield* handoff(Bounded, opened), "poll-bounded/2")

      expect(first._tag).toBe("Suspended")
      expect(succeededWith(second)).toBe("ready:2")
      expect(probes).toEqual([1, 2])
    }).pipe(
      Effect.provide(wired(Layer.mergeAll(probeLayer, Sleep.layer, Poll.layer, Interpreter.layer(Bounded))))
    )
  })

  effect("fails the lineage at the bound when asked to fail", () => {
    probes.length = 0
    return Effect.gen(function*() {
      yield* openRound(Failing, { until: 99 }, "poll-failing/1")
      yield* TestClock.adjust("10 millis")
      const opened = yield* wake(Failing, "poll-failing/1")
      const second = yield* openRound(Failing, yield* handoff(Failing, opened), "poll-failing/2")

      expect(second._tag).toBe("Complete")
      if (second._tag === "Complete") {
        expect(Exit.isFailure(second.exit)).toBe(true)
        if (Exit.isFailure(second.exit)) {
          expect(second.exit.cause.reasons[0]).toMatchObject({
            error: {
              _tag: "@smthrs/flow/PollExhausted",
              code: "poll_exhausted",
              poll: "poll/failing",
              attempts: 2
            }
          })
        }
      }
      expect(probes).toEqual([1, 2])
    }).pipe(
      Effect.provide(wired(Layer.mergeAll(probeLayer, Sleep.layer, Poll.layer, Interpreter.layer(Failing))))
    )
  })
})

describe("Poll across a restart", () => {
  effect("re-drives the round it was dropped in without re-running that round's attempt", () => {
    probes.length = 0
    // The durable record both runtimes read: the recorded outcomes and the
    // settled wakes. Everything else — registrations, live executions, armed
    // timers — is process state the second runtime rebuilds for itself.
    const durable = makeMemoryState()
    const runtime = () => wired(Layer.mergeAll(probeLayer, Sleep.layer, Poll.layer, Interpreter.layer(Rising)), durable)
    return Effect.gen(function*() {
      // The first process: attempt one, its wait, and attempt two, which parks
      // on a two-hundred millisecond wait it will not live to see the end of.
      const opened = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* openRound(Rising, { until: 3 }, "poll-restart/1")
          yield* TestClock.adjust("100 millis")
          const handedOff = yield* wake(Rising, "poll-restart/1")
          const next = yield* handoff(Rising, handedOff)
          const second = yield* openRound(Rising, next, "poll-restart/2")
          expect(second._tag).toBe("Suspended")
          // Half way into the second wait, the process is gone.
          yield* TestClock.adjust("100 millis")
          return next
        }).pipe(Effect.provide(runtime()))
      )
      expect(probes).toEqual([1, 2])

      // The second process re-drives the round it found parked. The attempt
      // that round already made replays from its recorded outcome; a runtime
      // that had lost the record would dispatch a third `2` here.
      const finished = yield* Effect.scoped(
        Effect.gen(function*() {
          const resumed = yield* openRound(Rising, opened, "poll-restart/2")
          expect(resumed._tag).toBe("Suspended")
          expect(probes).toEqual([1, 2])

          yield* TestClock.adjust("200 millis")
          const handedOff = yield* wake(Rising, "poll-restart/2")
          return yield* openRound(Rising, yield* handoff(Rising, handedOff), "poll-restart/3")
        }).pipe(Effect.provide(runtime()))
      )

      expect(succeededWith(finished)).toBe("ready:3")
      expect(probes).toEqual([1, 2, 3])
    })
  })
})

describe("Poll with a bounded check", () => {
  effect("goes on to the next attempt when the check's own bound settles it unsatisfied", () =>
    Effect.gen(function*() {
      // The check parks: its work never answers, so the only thing that can
      // settle this attempt is the durable clock it raced the work against.
      const first = yield* openRound(Hanging, {}, "poll-hanging/1")
      expect(first._tag).toBe("Suspended")

      // One millisecond short of the bound the check declared, the attempt is
      // still open. Without the race it would stay open forever.
      yield* TestClock.adjust("499 millis")
      expect((yield* settled(Hanging, "poll-hanging/1"))._tag).toBe("Suspended")

      // The bound settles the attempt unsatisfied, so the round goes on to the
      // poll's OWN interval rather than failing: the handoff is a hundred
      // milliseconds after the bound, not at it.
      yield* TestClock.adjust("1 milli")
      yield* turns
      yield* TestClock.adjust("99 millis")
      expect((yield* settled(Hanging, "poll-hanging/1"))._tag).toBe("Suspended")

      yield* TestClock.adjust("1 milli")
      const opened = yield* wake(Hanging, "poll-hanging/1")
      expect(opened._tag).toBe("Handoff")

      // The second attempt is bounded the same way, and it is the last, so the
      // poll answers with what the bounded check last read.
      const second = yield* openRound(Hanging, yield* handoff(Hanging, opened), "poll-hanging/2")
      expect(second._tag).toBe("Suspended")
      yield* TestClock.adjust("500 millis")
      const settledRound = yield* wake(Hanging, "poll-hanging/2")

      expect(succeededWith(settledRound)).toBe("unknown:2")
    }).pipe(
      Effect.provide(wired(Layer.mergeAll(hungLayer, Sleep.layer, Poll.layer, Interpreter.layer(Hanging))))
    ))
})
