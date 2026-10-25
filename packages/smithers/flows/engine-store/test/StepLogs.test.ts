/**
 * Step logs through the real dispatch seam and the real stores: what an
 * action attempt's body logs lands in its run's journal as `telemetry.log`
 * events attributed to the attempt, while the body runs, bounded, redacted,
 * never for a replay, and never for a log outside an attempt.
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent, TelemetryLog } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as References from "effect/References"
import * as Schema from "effect/Schema"
import * as EngineStoreMetrics from "../src/EngineStoreMetrics.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as StepLogs from "../src/StepLogs.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "step-logs", pid: 9, nonce: "step-logs-process" }

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "step-logs" as never, changeId: "step-logs" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const layer = Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jj)

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

/** The run's journaled step log records, decoded, after the lossy writer commits. */
const logs = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({
      runId: JournalEvent.RunId.make(runId),
      eventTypes: [TelemetryLog.eventType],
      limit: 1000
    })
    return page.entries.map((entry) => ({
      sourceId: entry.sourceId,
      log: Schema.decodeUnknownSync(TelemetryLog.Log)(entry.payload)
    }))
  })

/** Every journal row the run has, as text. */
const journalText = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    return JSON.stringify((yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1000 })).entries)
  })

/** A logger standing in for the host's: every record it sees, with the fiber's annotations then. */
const ambient = () => {
  const seen: Array<{ readonly message: unknown; readonly annotations: Readonly<Record<string, unknown>> }> = []
  const logger = Logger.make<unknown, void>((options) => {
    seen.push({ message: options.message, annotations: options.fiber.getRef(References.CurrentLogAnnotations) })
  })
  return { seen, provide: Effect.provideService(Logger.CurrentLoggers, new Set([logger])) }
}

const dispatch = (runId: string, execute: (input: ActionPersistence.ActionInput) => Effect.Effect<unknown, unknown>) =>
  ActionPersistence.make({ runId, owner, sourceId: "step-logs", execute })

type Dispatch = ReturnType<typeof dispatch>
type Needs = Effect.Services<ReturnType<Dispatch>>

const counted = (outcome: keyof typeof EngineStoreMetrics.stepLog) =>
  Metric.value(EngineStoreMetrics.stepLog[outcome]).pipe(Effect.map((state) => state.count))

describe("step logs", () => {
  it.effect("journal an attempt's records to its run, attributed, while the ambient loggers still see them", () =>
    Effect.gen(function*() {
      const runId = "step-logs-attributed", key = `${runId}/load`
      const host = ambient()
      yield* activate(runId)
      const result = yield* Effect.gen(function*() {
        yield* Effect.logInfo("before the attempt")
        const value = yield* dispatch(runId, () =>
          Effect.gen(function*() {
            yield* Effect.logInfo("fetching", { repo: "octo/hello" })
            yield* Effect.logDebug("below the minimum level")
            yield* Effect.logWarning("slow").pipe(Effect.annotateLogs({ code: "slow_fetch" }))
            return "loaded"
          }))({ action: {}, attempt: 1, key, tier: "sealed" })
        yield* Effect.logInfo("after the attempt")
        return value
      }).pipe(host.provide)
      expect(result).toBe("loaded")

      const records = yield* logs(runId)
      const digest = sha256(key)
      expect(records.map(({ log }) => [log.level, log.message])).toEqual([
        ["Info", ["fetching", { repo: "octo/hello" }]],
        ["Warn", ["slow"]]
      ])
      expect(records.every(({ sourceId }) => sourceId === StepLogs.sourceId)).toBe(true)
      expect(records[0]!.log.annotations).toMatchObject({ runId, stepKeyDigest: digest, attempt: 1 })
      expect(records[1]!.log.annotations).toMatchObject({
        runId,
        stepKeyDigest: digest,
        attempt: 1,
        code: "slow_fetch"
      })
      // Merged, not replaced: the host saw every record, the body's carrying the step's digest.
      expect(host.seen.map((record) => record.message)).toEqual([
        ["before the attempt"],
        ["fetching", { repo: "octo/hello" }],
        ["slow"],
        ["after the attempt"]
      ])
      expect(host.seen[1]!.annotations).toMatchObject({ runId, stepKeyDigest: digest })
      expect(host.seen[0]!.annotations.stepKeyDigest).toBeUndefined()
    }).pipe(Effect.provide(layer), Effect.scoped, withCrypto))

  it.live("journal a record while the attempt is still running", () =>
    Effect.gen(function*() {
      const runId = "step-logs-live", key = `${runId}/long`
      yield* activate(runId)
      const release = yield* Deferred.make<void>()
      const running = yield* Effect.forkChild(
        dispatch(runId, () =>
          Effect.gen(function*() {
            yield* Effect.logInfo("cloning")
            yield* Deferred.await(release)
            yield* Effect.logInfo("done")
            return "built"
          }))({ action: {}, attempt: 1, key, tier: "sealed" })
      )
      let seen: ReadonlyArray<{ readonly log: TelemetryLog.Log }> = []
      for (let poll = 0; poll < 400 && seen.length === 0; poll++) {
        seen = yield* logs(runId)
        if (seen.length === 0) yield* Effect.sleep("5 millis")
      }
      expect(seen.map(({ log }) => log.message)).toEqual([["cloning"]])
      const attempts = yield* AttemptStore.AttemptStore
      const row = yield* attempts.get({ runId, stepKeyDigest: sha256(key), attempt: 1 })
      expect(Option.isSome(row) && row.value.state).toBe("running")
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(running)).toBe("built")
      expect((yield* logs(runId)).map(({ log }) => log.message)).toEqual([["cloning"], ["done"]])
    }).pipe(Effect.provide(layer), Effect.scoped, withCrypto))

  it.effect("attribute a retried attempt's records to that attempt, and write none for a replay", () =>
    Effect.gen(function*() {
      const runId = "step-logs-retry", key = `${runId}/flaky`
      yield* activate(runId)
      let runs = 0
      const execute = dispatch(runId, (input) =>
        Effect.gen(function*() {
          runs++
          yield* Effect.logInfo(`try ${input.attempt}`)
          if (input.attempt === 1) return yield* Effect.fail("unavailable")
          return "ok"
        }))
      const first = yield* Effect.exit(execute({ action: {}, attempt: 1, key, tier: "sealed" }))
      expect(Exit.isFailure(first) && Cause.squash(first.cause)).toBe("unavailable")
      expect(yield* execute({ action: {}, attempt: 2, key, tier: "sealed" })).toBe("ok")
      // The recorded success answers the same attempt again without its body.
      expect(yield* execute({ action: {}, attempt: 2, key, tier: "sealed" })).toBe("ok")
      expect(runs).toBe(2)
      const records = yield* logs(runId)
      expect(records.map(({ log }) => [log.message, log.annotations.attempt])).toEqual([
        [["try 1"], 1],
        [["try 2"], 2]
      ])
    }).pipe(Effect.provide(layer), Effect.scoped, withCrypto))

  it.effect("keep a nested action's records on its own step, each record once", () =>
    Effect.gen(function*() {
      const runId = "step-logs-nested", outer = `${runId}/outer`, inner = `${runId}/inner`
      yield* activate(runId)
      // The outer body dispatches the inner action as the engine does, with the dispatch's own services.
      const services = yield* Effect.context<Needs>()
      const execute: Dispatch = dispatch(
        runId,
        (input) =>
          input.key === inner
            ? Effect.logInfo("inner").pipe(Effect.as("inner-result"))
            : Effect.gen(function*() {
              yield* Effect.logInfo("outer before")
              yield* execute({ action: {}, attempt: 1, key: inner, tier: "sealed" }).pipe(Effect.provide(services))
              yield* Effect.logInfo("outer after")
              return "outer-result"
            })
      )
      expect(yield* execute({ action: {}, attempt: 1, key: outer, tier: "sealed" })).toBe("outer-result")
      const records = yield* logs(runId)
      expect(records.map(({ log }) => [log.message, log.annotations.stepKeyDigest])).toEqual([
        [["outer before"], sha256(outer)],
        [["inner"], sha256(inner)],
        [["outer after"], sha256(outer)]
      ])
    }).pipe(Effect.provide(layer), Effect.scoped, withCrypto))

  it.effect("never journal a credential the body logs", () =>
    Effect.gen(function*() {
      const runId = "step-logs-sentinel", key = `${runId}/deploy`
      const sentinel = "sentinel-step-log-7f3a-never-shown"
      yield* activate(runId)
      const exit = yield* Effect.exit(
        dispatch(runId, () =>
          Effect.gen(function*() {
            yield* Effect.logInfo("connecting", Redacted.make(sentinel), { apiKey: sentinel })
            yield* Effect.logInfo(`token=${sentinel}`).pipe(Effect.annotateLogs({ password: sentinel }))
            yield* Effect.logInfo(`Authorization: Bearer ${sentinel}`)
            yield* Effect.logError("refused", Cause.fail(new Error(`password=${sentinel}`)))
            return yield* Effect.fail("refused")
          }))({ action: {}, attempt: 1, key, tier: "sealed" })
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* logs(runId)).toHaveLength(4)
      expect(yield* journalText(runId)).not.toContain(sentinel)
    }).pipe(Effect.provide(layer), Effect.scoped, withCrypto))

  it.effect("bound an attempt's records and bytes, count the rest, and say so in the step's log", () =>
    Effect.gen(function*() {
      const runId = "step-logs-bounded", key = `${runId}/chatty`
      yield* activate(runId)
      const before = {
        journaled: yield* counted("Journaled"),
        limit: yield* counted("DroppedLimit")
      }
      yield* dispatch(runId, () =>
        Effect.gen(function*() {
          yield* Effect.logInfo("x".repeat(10_000))
          for (let line = 1; line <= 4; line++) yield* Effect.logInfo(`line ${line}`)
        }))({ action: {}, attempt: 1, key, tier: "sealed" }).pipe(
          Effect.provideService(StepLogs.Limits, { ...StepLogs.defaultLimits, records: 2, recordBytes: 512 })
        )
      const records = yield* logs(runId)
      expect(records).toHaveLength(3)
      const [long, line, summary] = records.map(({ log }) => log)
      expect(new TextEncoder().encode(JSON.stringify(long)).byteLength).toBeLessThanOrEqual(512)
      expect((long!.message as ReadonlyArray<string>)[0]).toMatch(/^x+\[Truncated\]$/)
      expect(line!.message).toEqual(["line 1"])
      expect(summary).toMatchObject({
        level: "Warn",
        message: ["Log lines dropped"],
        annotations: { runId, stepKeyDigest: sha256(key), attempt: 1, code: StepLogs.droppedCode, dropped: 3 }
      })
      expect((yield* counted("Journaled")) - before.journaled).toBe(3)
      expect((yield* counted("DroppedLimit")) - before.limit).toBe(3)
    }).pipe(Effect.provide(layer), Effect.scoped, withCrypto))

  it.effect("journal nothing when records is 0, and leave the ambient loggers alone", () =>
    Effect.gen(function*() {
      const runId = "step-logs-off", key = `${runId}/quiet`
      const host = ambient()
      yield* activate(runId)
      yield* dispatch(runId, () => Effect.logInfo("only the host sees this"))({
        action: {},
        attempt: 1,
        key,
        tier: "sealed"
      }).pipe(Effect.provideService(StepLogs.Limits, { ...StepLogs.defaultLimits, records: 0 }), host.provide)
      expect(yield* logs(runId)).toEqual([])
      expect(host.seen.map((record) => record.message)).toEqual([["only the host sees this"]])
      expect(host.seen[0]!.annotations).toMatchObject({ stepKeyDigest: sha256(key) })
    }).pipe(Effect.provide(layer), Effect.scoped, withCrypto))
})
