import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * Issue #3898: a run reclaimed from a SIGKILLed owner re-ran a step that the
 * step cache could already answer.
 *
 * The launch demo runs `Plan` then `Test`, both keyed, sealed, hard-bounded
 * and shared-scope cached. Kill it during `Test` and restart it as a new run:
 * the new run reuses `Plan` from the cache and runs `Test` once. The killed
 * run is still `running` under a dead owner, and the restart's stale-running
 * sweep steals it and re-drives it. Its `Test` attempt row is `running`, and
 * adoption re-executed the body without asking the cache:
 *
 * - steal during the restart's `Test` (restart more than 30 s after the kill):
 *   the reclaimed body ran concurrently with the restart's;
 * - steal after the restart recorded `Test` (quick restart, then any later
 *   process): the reclaimed body ran although the cache held that exact key.
 *
 * Each case kills a real child process, so the abandoned rows are the ones a
 * SIGKILL leaves, then reclaims on a `TestClock` set past the dead owner's
 * last heartbeat, with the pid probe a Node host uses. The bodies count
 * themselves; a label never decides.
 */
import { afterEach, describe, expect, it } from "@effect/vitest"
import { FlowRuntime } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as HostLiveness from "@smthrs/platform-node/HostLiveness"
import { Ownership, RunStore } from "@smthrs/run-store"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as Tracer from "effect/Tracer"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as ChildProcesses from "./ChildProcesses.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
import * as ReclaimedAttemptFlow from "./fixtures/ReclaimedAttemptFlow.ts"
import { killDuringTest, orphan, processBudget } from "./ReclaimedAttemptProcess.ts"
import { runPromise } from "./Sha256.ts"

const heartbeatMs = Duration.toMillis(Ownership.heartbeatInterval)
/** How far past the dead owner's last heartbeat its lease has expired. */
const expiry = Duration.toMillis(Ownership.heartbeatStaleAfter) + heartbeatMs

const restart = "restart"

// A timed-out case stops awaiting its child; teardown still kills its process group.
afterEach(ChildProcesses.reap)

/** What the survivor's step bodies did, in order. */
interface Ran {
  readonly plan: Array<string>
  readonly test: Array<string>
}

/** Real time for the store's own I/O, with the test clock held still. */
const pause = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)))

/**
 * Waits for `done`, moving the test clock one heartbeat, and so one sweep
 * tick, per quarter second of real time. The clock never outruns the store:
 * a lease the survivor holds renews long before it could lapse, on SQLite and
 * on PostgreSQL alike.
 */
const until = <R>(done: Effect.Effect<boolean, unknown, R>) =>
  Effect.gen(function*() {
    for (let turn = 0; turn < 4000; turn++) {
      if (yield* done) return true
      if (turn % 50 === 0) yield* TestClock.adjust(heartbeatMs)
      yield* pause
    }
    return yield* done
  })

const decisions = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1000 })
    return page.entries
      .filter((entry) => entry.eventType === "flows.engine.run-decision")
      .map((entry) => entry.payload as { readonly decision: string; readonly evidence?: string })
  })

/** Every attempt the run's journal opened, with whether it also closed it. */
const attemptSpans = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1000 })
    const named = (eventType: string) =>
      page.entries
        .filter((entry) => entry.eventType === eventType)
        .map((entry) => entry.payload as { readonly stepKeyDigest: string; readonly attempt: number })
    const finished = named("flows.engine.attempt-finished")
    return named("flows.engine.attempt-started").map((started) => ({
      ...started,
      finished: finished.some((row) => row.stepKeyDigest === started.stepKeyDigest && row.attempt === started.attempt)
    }))
  })

const statusOf = (runId: string) =>
  Effect.flatMap(RunStore.RunStore, (runs) => Effect.map(runs.get(runId), (row) => row.status))

const resultOf = (engine: FlowRuntime.FlowRuntime["Service"], runId: string) =>
  Effect.gen(function*() {
    const polled = yield* engine.poll(ReclaimedAttemptFlow.Fix, runId)
    const result = Option.getOrThrow(polled)
    if (result._tag !== "Complete" || !Exit.isSuccess(result.exit)) {
      return yield* Effect.die(new Error(`run ${runId} did not succeed: ${JSON.stringify(result)}`))
    }
    return result.exit.value
  })

/** The survivor's view of one case, handed to its observation. */
interface Survivor {
  readonly engine: FlowRuntime.FlowRuntime["Service"]
  readonly execute: (runId: string) => Effect.Effect<string, never, (EffectDigest.Digest | SecureRandom.SecureRandom)>
  /** What the survivor's bodies have done so far. */
  readonly ran: Ran
  /** Every span the survivor opened, so a case can see a dispatch begin. */
  readonly spans: ReadonlyArray<Tracer.NativeSpan>
}

/** How the survivor names itself and decides whether the dead child is alive. */
interface SurvivorHost {
  readonly hostId: string
  readonly isAlive: Ownership.LivenessCheck
  /** Every message the survivor logs, in order. */
  readonly logs?: Array<string> | undefined
}

/**
 * The probe a Node host uses: the one `@smthrs/flows`' `layerHost` installs,
 * which reads the process table this test hands it.
 */
const pidProbe = (hostId: string, alive: ReadonlySet<number>): Ownership.LivenessCheck =>
  HostLiveness.isAlive({
    hostId,
    signal: (pid) => {
      if (!alive.has(pid)) throw Object.assign(new Error(`kill ${pid}: no such process`), { code: "ESRCH" })
    }
  })

/**
 * A fresh engine over the killed child's database, with its own bodies
 * attached, starting while the dead owner's lease is still `fresh` or once it
 * has `expired`. `observe` runs with the flow registered, so the sweep can
 * re-drive the orphan for as long as it runs. The sweep first ticks one
 * heartbeat after the engine starts.
 */
const survive = <A>(
  filename: string,
  lease: "fresh" | "expired",
  bodies: (ran: Ran) => ReclaimedAttemptFlow.Bodies,
  observe: (
    survivor: Survivor
  ) => Effect.Effect<
    A,
    unknown,
    RunStore.RunStore | Journal.Journal | Scope.Scope | (EffectDigest.Digest | SecureRandom.SecureRandom)
  >,
  host: SurvivorHost = {
    hostId: ReclaimedAttemptFlow.hostId,
    // The pid probe on the real process table: the child's pid is gone, so
    // its expired lease admits the steal, and the survivor's own runs stay
    // its own however far the test clock runs ahead of their heartbeats.
    isAlive: Ownership.sameHostPidProbe
  }
) => {
  const ran: Ran = { plan: [], test: [] }
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  return Effect.scoped(Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const killed = yield* runs.get(orphan)
    // What SIGKILL left: the orphan still `running` under the dead child.
    expect(killed.status).toBe("running")
    expect(killed.owner?.hostId).toBe(ReclaimedAttemptFlow.hostId)
    expect(killed.owner?.pid).not.toBe(process.pid)
    const killedHeartbeatAtMs = killed.heartbeatAtMs ?? 0
    yield* TestClock.setTime(killedHeartbeatAtMs + (lease === "fresh" ? 0 : expiry))
    const engine = yield* EngineStore.make({
      owner: { hostId: host.hostId },
      journalSource: "survivor",
      isAlive: host.isAlive
    })
    const context = yield* Layer.build(ReclaimedAttemptFlow.layer(engine, bodies(ran)))
    const execute = (runId: string) =>
      ReclaimedAttemptFlow.Fix.execute({ issue: "#42" }, { executionId: runId }).pipe(
        Effect.provide(context),
        Effect.orDie
      )
    return yield* observe({ engine, execute, ran, spans })
  })).pipe(
    Effect.map((observed) => ({ ran, observed })),
    Effect.provide(Logger.layer([Logger.make(({ message }) => {
      host.logs?.push((Array.isArray(message) ? message : [message]).map(String).join(" "))
    })])),
    Effect.provideService(Tracer.Tracer, tracer),
    Effect.provide(ReclaimedAttemptFlow.jj),
    Effect.provide(StepBoundary.layerTest()),
    Effect.provide(TestStores.layerAt(filename)),
    Effect.provide(TestClock.layer()),
    Effect.orDie,
    runPromise
  )
}

/** A fresh database holding what the child left when it was killed during `Test`. */
const killedDatabase = async <A>(use: (filename: string) => Promise<A>): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "reclaimed-attempt-"))
  const filename = PersistentDatabase.filename(join(directory, "engine.db"))
  try {
    await killDuringTest(filename)
    return await use(filename)
  } finally {
    await PersistentDatabase.remove(filename)
    await rm(directory, { recursive: true, force: true })
  }
}

const passed = "passed: plan for #42"

describe("a reclaimed attempt reuses the step cache (issue #3898)", () => {
  it("serves the orphan's in-flight step from the record a later run made", async () => {
    const { observed, ran } = await killedDatabase((filename) =>
      survive(
        filename,
        "fresh",
        (ran) => ({
          plan: (issue) =>
            Effect.sync(() => {
              ran.plan.push(issue)
              return `plan for ${issue}`
            }),
          test: (plan) =>
            Effect.sync(() => {
              ran.test.push(plan)
              return `passed: ${plan}`
            })
        }),
        ({ engine, execute }) =>
          Effect.gen(function*() {
            // A quick restart: the dead owner's lease is fresh, so nothing
            // steals the orphan while the restart runs and records `Test`.
            const restarted = yield* execute(restart)
            const during = yield* statusOf(orphan)
            // Any later process: the lease has expired, so its sweep steals
            // the orphan and re-drives its in-flight `Test` attempt. The
            // survivor holds no lease across this jump.
            yield* TestClock.adjust(expiry)
            yield* until(Effect.map(statusOf(orphan), (status) => status === "completed"))
            return {
              restarted,
              during,
              reclaimed: yield* statusOf(orphan),
              result: yield* resultOf(engine, orphan),
              decisions: yield* decisions(orphan),
              attempts: yield* attemptSpans(orphan)
            }
          })
      )
    )

    expect(observed.restarted).toBe(passed)
    expect(observed.during).toBe("running")
    expect(observed.reclaimed).toBe("completed")
    expect(observed.result).toBe(passed)
    expect(observed.decisions).toContainEqual(
      expect.objectContaining({ decision: "stolen-and-activated", evidence: "same-host-pid-dead" })
    )
    // `Plan` came from the child's record for both runs, and `Test` ran once:
    // for the restart. The orphan's attempt was answered by that record.
    expect(ran.plan).toEqual([])
    expect(ran.test).toEqual(["plan for #42"])
    // The attempt the dead child opened is closed, not left running forever.
    expect(observed.attempts).toHaveLength(2)
    expect(observed.attempts.every((attempt) => attempt.finished)).toBe(true)
  }, processBudget)

  it("waits for the run already executing the orphan's step instead of running it beside it", async () => {
    const { observed, ran } = await killedDatabase(async (filename) => {
      const entered = Effect.runSync(Deferred.make<void>())
      const release = Effect.runSync(Deferred.make<void>())
      return survive(
        filename,
        "expired",
        (ran) => ({
          plan: (issue) =>
            Effect.sync(() => {
              ran.plan.push(issue)
              return `plan for ${issue}`
            }),
          test: (plan) =>
            Effect.gen(function*() {
              ran.test.push(plan)
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return `passed: ${plan}`
            })
        }),
        ({ engine, execute, ran, spans }) =>
          Effect.gen(function*() {
            // The lease has expired, but the sweep has not ticked: the restart
            // reaches `Test` first, and is mid-`Test` when the sweep steals.
            const restarted = yield* Effect.forkScoped(execute(restart))
            yield* Deferred.await(entered)
            // The sweep steals the orphan and its re-drive dispatches `Test`.
            const stolen = yield* until(Effect.sync(() =>
              spans.some((span) =>
                span.name === "FlowEngine.actionExecute" &&
                span.attributes.get("runId") === orphan &&
                span.attributes.get("action") === ReclaimedAttemptFlow.Test.name
              )
            ))
            // Give the dispatch real time to reach the step: a body that runs
            // beside the restart's shows up here.
            for (let turn = 0; turn < 100 && ran.test.length < 2; turn++) yield* pause
            const concurrent = ran.test.length
            yield* Deferred.succeed(release, undefined)
            const result = yield* Fiber.join(restarted)
            yield* until(Effect.map(statusOf(orphan), (status) => status === "completed"))
            return {
              stolen,
              concurrent,
              restarted: result,
              reclaimed: yield* statusOf(orphan),
              result: yield* resultOf(engine, orphan),
              decisions: yield* decisions(orphan),
              attempts: yield* attemptSpans(orphan)
            }
          })
      )
    })

    expect(observed.stolen).toBe(true)
    expect(observed.decisions).toContainEqual(
      expect.objectContaining({ decision: "stolen-and-activated", evidence: "same-host-pid-dead" })
    )
    // Nothing ran beside the restart's `Test`, and nothing ran after it.
    expect(observed.concurrent).toBe(1)
    expect(ran.test).toEqual(["plan for #42"])
    expect(ran.plan).toEqual([])
    expect(observed.restarted).toBe(passed)
    expect(observed.reclaimed).toBe("completed")
    expect(observed.result).toBe(passed)
    expect(observed.attempts).toHaveLength(2)
    expect(observed.attempts.every((attempt) => attempt.finished)).toBe(true)
  }, processBudget)
})

/**
 * Joins `fiber` within `ms` of real time while the test clock stands still,
 * or answers `None` with the fiber still running.
 */
const within = <A>(fiber: Fiber.Fiber<A>, ms: number) =>
  Effect.raceFirst(
    Effect.map(Fiber.join(fiber), Option.some),
    Effect.as(Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms))), Option.none<A>())
  )

/** Waits up to `ms` of real time, the test clock standing still, for a logged line containing `text`. */
const logged = (logs: ReadonlyArray<string>, text: string, ms = 20_000) =>
  Effect.gen(function*() {
    for (let turn = 0; turn * 5 < ms; turn++) {
      if (logs.some((line) => line.includes(text))) return true
      yield* pause
    }
    return false
  })

/** The orphan's owner as SIGKILL left it, read back after the survivor gave up waiting. */
const ownerOf = (runId: string) =>
  Effect.flatMap(
    RunStore.RunStore,
    (runs) => Effect.map(runs.get(runId), (row) => ({ status: row.status, owner: row.owner }))
  )

const counting = (ran: Ran): ReclaimedAttemptFlow.Bodies => ({
  plan: (issue) =>
    Effect.sync(() => {
      ran.plan.push(issue)
      return `plan for ${issue}`
    }),
  test: (plan) =>
    Effect.sync(() => {
      ran.test.push(plan)
      return `passed: ${plan}`
    })
})

/**
 * Issue #3897: after `kill -9`, rerunning the same execution printed nothing
 * for about 30 s and then resumed. Every case reruns the orphan with the test
 * clock on the dead child's last heartbeat, so its lease stays fresh for the
 * whole case and nothing may wait it out; the process table is the one handed
 * to the probe `layerHost` installs.
 */
describe("a rerun after SIGKILL does not wait out a dead owner's lease in silence (issue #3897)", () => {
  it("reclaims at once when the probe proves the owner's pid gone, and runs the step once", async () => {
    const logs: Array<string> = []
    const { observed, ran } = await killedDatabase((filename) =>
      survive(
        filename,
        "fresh",
        counting,
        ({ execute }) =>
          Effect.gen(function*() {
            const rerun = yield* Effect.forkScoped(execute(orphan))
            return {
              result: yield* within(rerun, 60_000),
              status: yield* statusOf(orphan),
              decisions: yield* decisions(orphan),
              attempts: yield* attemptSpans(orphan)
            }
          }),
        // The child's pid is not in the table: its process is gone.
        { hostId: ReclaimedAttemptFlow.hostId, isAlive: pidProbe(ReclaimedAttemptFlow.hostId, new Set()), logs }
      )
    )

    expect(observed.result).toEqual(Option.some(passed))
    expect(observed.status).toBe("completed")
    expect(observed.decisions).toContainEqual(
      expect.objectContaining({ decision: "stolen-and-activated", evidence: "same-host-pid-dead" })
    )
    // `Plan` came from the child's record, and the step the kill interrupted
    // ran once, in the survivor.
    expect(ran.plan).toEqual([])
    expect(ran.test).toEqual(["plan for #42"])
    expect(observed.attempts.every((attempt) => attempt.finished)).toBe(true)
    expect(logs.filter((line) => line.includes("waiting"))).toEqual([])
  }, processBudget)

  it("never takes the run from a pid that is still alive, and says why it waits", async () => {
    const logs: Array<string> = []
    const { observed, ran } = await killedDatabase((filename) =>
      survive(
        filename,
        "fresh",
        counting,
        ({ execute }) =>
          Effect.gen(function*() {
            const rerun = yield* Effect.forkScoped(execute(orphan))
            const said = yield* logged(logs, "a live process on this host")
            const result = yield* within(rerun, 250)
            yield* Fiber.interrupt(rerun)
            return { said, result, held: yield* ownerOf(orphan), decisions: yield* decisions(orphan) }
          }),
        {
          hostId: ReclaimedAttemptFlow.hostId,
          // The child's pid answers, as it does once the system hands it to
          // another process: liveness cannot be told from reuse.
          isAlive: (owner, context) => pidProbe(ReclaimedAttemptFlow.hostId, new Set([owner.pid]))(owner, context),
          logs
        }
      )
    )

    expect(observed.said).toBe(true)
    expect(observed.result).toEqual(Option.none())
    expect(observed.held.status).toBe("running")
    expect(observed.held.owner?.hostId).toBe(ReclaimedAttemptFlow.hostId)
    expect(observed.decisions).not.toContainEqual(expect.objectContaining({ decision: "stolen-and-activated" }))
    expect(ran.test).toEqual([])
    const holder = `${ReclaimedAttemptFlow.hostId}:${observed.held.owner?.pid}`
    expect(logs.filter((line) => line.includes("waiting"))).toEqual([
      `engine-store: run ${orphan} is held by ${holder}, a live process on this host; waiting for it to finish or exit`
    ])
  }, processBudget)

  it("waits out the lease of an owner on another host, and says why and for how long", async () => {
    const logs: Array<string> = []
    const otherHost = "another-host"
    const { observed, ran } = await killedDatabase((filename) =>
      survive(
        filename,
        "fresh",
        counting,
        ({ execute }) =>
          Effect.gen(function*() {
            const rerun = yield* Effect.forkScoped(execute(orphan))
            const fresh = yield* logged(logs, "for its lease to expire")
            const duringLease = yield* within(rerun, 250)
            // Past the lease, the probe `layerHost` installs still answers
            // for a host it cannot see: alive. The survivor holds no lease
            // across this jump.
            yield* TestClock.adjust(expiry)
            const expired = yield* logged(logs, "reports alive")
            const afterLease = yield* within(rerun, 250)
            yield* Fiber.interrupt(rerun)
            return { fresh, duringLease, expired, afterLease, held: yield* ownerOf(orphan) }
          }),
        { hostId: otherHost, isAlive: pidProbe(otherHost, new Set()), logs }
      )
    )

    expect(observed.fresh).toBe(true)
    expect(observed.duringLease).toEqual(Option.none())
    expect(observed.expired).toBe(true)
    expect(observed.afterLease).toEqual(Option.none())
    expect(observed.held.status).toBe("running")
    expect(observed.held.owner?.hostId).toBe(ReclaimedAttemptFlow.hostId)
    expect(ran.test).toEqual([])
    const holder = `${ReclaimedAttemptFlow.hostId}:${observed.held.owner?.pid}`
    expect(logs.filter((line) => line.includes("waiting"))).toEqual([
      `engine-store: run ${orphan} is held by ${holder} on another host; waiting up to 30 s for its lease to expire`,
      `engine-store: run ${orphan} is held by ${holder} on another host, which the liveness check reports alive; waiting for it to release the run`
    ])
  }, processBudget)
})
