/**
 * Service-level cover for the one public time-travel door.
 *
 * The module suites next door drive `Replay`, `Fork`, `Rewind`, and `Recovery`
 * directly; this one only asserts what the service adds — that the three verbs
 * are reachable with nothing but a `Position`, that the fork workspace and the
 * rewind ownership claim are derived internally, and that an interrupted
 * rewind is resolved while the layer is being built rather than by a call the
 * user has to remember to make.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import { Journal } from "@smthrs/journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import { RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Random from "effect/Random"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as CompensationHandlers from "../src/CompensationHandlers.ts"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import * as Fork from "../src/internal/Fork.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { layerWith, TimeTravel } from "../src/TimeTravel.ts"
import type { Audit } from "../src/TimeTravelStore.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"
import { journalOf, row as makeRow } from "./MemoryHarness.ts"
import { jjInstalled, parkSealedFlow, runRealEngine, withRealFixture } from "./RealTimeTravelHarness.ts"

const lineageId = "run/root"

const record = (seq: number, amount: number): MemoryTimeTravelStore.JournalRecord => ({
  runId: "run",
  seq,
  eventId: `event-${seq}`,
  lineageId,
  payload: {
    eventType: "test.credited",
    payload: { amount },
    meta: { lineageId }
  }
})

const row = (runId: string): RunStore.RunRow => makeRow({ runId })

const makeRuns = (): RunStore.Service => {
  const state = new Map([["run", { ...row("run") }]])
  return RunStore.makeNoop({
    get: (runId) => {
      const found = state.get(runId)
      return found === undefined
        ? Effect.fail(
          new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: "missing", cause: runId })
        )
        : Effect.succeed({ ...found })
    },
    claim: (runId, _expected, claimant, nowMs) =>
      Effect.sync(() => {
        const found = state.get(runId)!
        found.claim = claimant
        found.claimedAtMs = nowMs
        return { _tag: "Claimed" as const, claimedAtMs: nowMs }
      }),
    activate: (runId, claimant, claimedAtMs) =>
      Effect.sync(() => {
        const found = state.get(runId)!
        found.status = "running"
        found.owner = claimant
        found.heartbeatAtMs = claimedAtMs
        found.claim = null
        found.claimedAtMs = null
        return { _tag: "Activated" as const }
      }),
    transitionOwned: (runId, currentOwner, status) =>
      Effect.sync(() => {
        const found = state.get(runId)!
        if (found.owner?.nonce !== currentOwner.nonce) return { _tag: "FenceLost" as const }
        found.status = status
        found.owner = null
        found.heartbeatAtMs = null
        return { _tag: "Transitioned" as const }
      })
  })
}

const harness = (options: {
  readonly store: ReturnType<typeof MemoryTimeTravelStore.make>
  readonly workspaces?: Array<string>
}) =>
  TimeTravel.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(TimeTravelStore)(options.store),
        Layer.succeed(RunStore.RunStore)(makeRuns()),
        Layer.succeed(Journal.Journal)(journalOf(options.store)),
        Layer.succeed(Jj.Jj)(
          Jj.makeNoop({
            snapshot: () => Effect.succeed({ changeId: "current" }),
            workspaceAdd: (name, path) =>
              Effect.sync(() => {
                options.workspaces?.push(`${name}@${path}`)
              }),
            workspaceForget: () => Effect.void
          })
        ),
        CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) })
      )
    )
  )

const run = <A>(
  store: ReturnType<typeof MemoryTimeTravelStore.make>,
  body: (timeTravel: TimeTravel["Service"]) => Effect.Effect<A, unknown>,
  workspaces?: Array<string>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const timeTravel = yield* TimeTravel
      return yield* body(timeTravel)
    }).pipe(
      Effect.provide(harness({ store, ...(workspaces === undefined ? {} : { workspaces }) })),
      Effect.orDie
    )
  )

describe("TimeTravel", () => {
  it.effect("inspects a position by folding committed evidence up to the frame", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [record(0, 10), record(1, 20), record(2, 30)]
      })

      const total = yield* run(store, (timeTravel) =>
        timeTravel.inspect(
          { runId: "run", frame: { lineageId, seq: 1 } },
          {
            initial: 0,
            reduce: (state: number, entry) => {
              const payload = entry.payload as { readonly amount?: number } | null
              return state + (payload?.amount ?? 0)
            }
          }
        ))

      expect(total).toBe(30)
    }))

  it.effect("forks at a position and derives the workspace name and path itself", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: [record(0, 10), record(1, 20)] })
      const workspaces: Array<string> = []

      const fork = yield* run(
        store,
        (timeTravel) => timeTravel.fork({ runId: "run", frame: { lineageId, seq: 1 } }),
        workspaces
      )

      expect(fork.edge).toMatchObject({ parentRunId: "run", parentSeq: 1, kind: "fork" })
      expect(fork.runId).toBe("run:fork:1:1")
      // Derived, never caller-supplied: the CHILD names the lane, so a second
      // fork of this frame lands beside this one rather than on top of it.
      const lane = Fork.workspaceNameFor(fork.runId)
      expect(workspaces).toEqual([`${lane}@.flows/forks/${lane}`])
    }))

  it.effect("rewinds at a position with the ownership claim wired internally", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [record(0, 10), record(1, 20), record(2, 30), record(3, 40)]
      })

      const result = yield* run(
        store,
        (timeTravel) => timeTravel.rewind({ runId: "run", frame: { lineageId, seq: 1 } })
      )

      expect(result.archive.archived).toBe(2)
      expect(store.state().records.map((entry) => entry.seq)).toEqual([0, 1])
      expect(store.state().audits.map((audit) => audit.status)).toEqual(["completed"])
    }))

  it.effect("honours fork root and rewind paging", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [record(0, 10), record(1, 20), record(2, 30), record(3, 40)]
      })
      const workspaces: Array<string> = []

      const result = yield* run(
        store,
        (timeTravel) =>
          Effect.gen(function*() {
            yield* timeTravel.fork({ runId: "run", frame: { lineageId, seq: 1 } }, {
              workspaceRoot: "/tmp/lanes"
            })
            return yield* timeTravel.rewind({ runId: "run", frame: { lineageId, seq: 1 } }, {
              detachedChildren: "cancel",
              pageSize: 1
            })
          }),
        workspaces
      )

      const lane = Fork.workspaceNameFor("run:fork:1:1")
      expect(workspaces).toEqual([`${lane}@/tmp/lanes/${lane}`])
      expect(result.archive.archived).toBe(2)
    }))

  it.effect("resolves an interrupted rewind while the layer is built", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [record(0, 10), record(1, 20), record(2, 30)]
      })
      const interrupted: Audit = {
        id: "run:interrupted",
        runId: "run",
        frame: { lineageId, seq: 1 },
        status: "in_progress",
        detail: {
          version: 1,
          phase: "preflight_complete",
          originalStatus: "suspended",
          suffixCount: 1,
          warnings: [],
          cancelledChildren: []
        }
      }
      yield* (store.writeAudit(interrupted).pipe(Effect.orDie))

      // No user call: merely acquiring the service resolves the audit.
      const audits = yield* run(store, () => Effect.succeed(store.state().audits))

      expect(audits.map((audit) => audit.status)).toEqual(["failed"])
      expect(audits[0]?.detail).toMatchObject({ phase: "rolled_back" })
      // The suffix the interrupted rewind never committed is still there.
      expect(store.state().records.map((entry) => entry.seq)).toEqual([0, 1, 2])
    }))

  it.effect("refuses a detached-child policy it does not recognise before touching anything", () =>
    Effect.gen(function*() {
      // The policy used to be threaded through untyped, and the assessment read
      // every value other than the literal "block" as cancel, so a JSON surface
      // that misspelled it selected the destructive branch.
      const store = MemoryTimeTravelStore.make({ records: [record(0, 10), record(1, 20)] })
      const failure = yield* (
        Effect.flip(
          Effect.scoped(
            Effect.gen(function*() {
              const timeTravel = yield* TimeTravel
              return yield* timeTravel.rewind(
                { runId: "run", frame: { lineageId, seq: 0 } },
                { detachedChildren: "blcok" as never }
              )
            }).pipe(Effect.provide(harness({ store })))
          )
        )
      )

      expect(failure).toMatchObject({
        code: "invalid",
        message: "detachedChildren must be \"block\" or \"cancel\", not \"blcok\""
      })
      expect(store.state().audits).toEqual([])
      expect(store.state().records.map((entry) => entry.seq)).toEqual([0, 1])
    }))

  it.effect("reports an audit startup recovery closed as failed", () =>
    Effect.gen(function*() {
      // A `Failed` outcome closes the audit terminally, so the composition has
      // to hear about it: the array used to be discarded on the floor.
      const store = MemoryTimeTravelStore.make({ records: [record(0, 10)] })
      yield* store.writeAudit({
        id: "run:unrecoverable",
        runId: "run",
        frame: { lineageId, seq: 0 },
        status: "in_progress",
        detail: { version: 1, phase: "not-a-phase" }
      }).pipe(Effect.orDie)
      const logged: Array<string> = []

      const audits = yield* run(store, () => Effect.succeed(store.state().audits)).pipe(
        Effect.provide(
          Logger.layer([Logger.make<unknown, void>(({ message }) => logged.push(String(message)))])
        )
      )

      expect(audits.map((audit) => audit.status)).toEqual(["failed"])
      expect(logged).toContain("time-travel: startup recovery closed an audit as failed")
    }))
})

describe("TimeTravel wiring", () => {
  it.effect("mints distinct deterministic owners while preserving the durable service key across restart layers", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [
          record(0, 10),
          record(1, 20)
        ]
      })
      let current = row("run")
      const claimedOwners: Array<{ readonly hostId: string; readonly nonce: string }> = []
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed({ ...current }),
        claim: (_runId, _expected, claimant, nowMs) =>
          Effect.sync(() => {
            claimedOwners.push(claimant)
            if (current.status === "running" || current.claim !== null) {
              return { _tag: "AlreadyClaimed" as const }
            }
            current = { ...current, claim: claimant, claimedAtMs: nowMs }
            return { _tag: "Claimed" as const, claimedAtMs: nowMs }
          }),
        activate: (_runId, claimant, claimedAtMs) =>
          Effect.sync(() => {
            if (current.claim?.nonce !== claimant.nonce) return { _tag: "ClaimLost" as const }
            current = {
              ...current,
              status: "running",
              owner: claimant,
              heartbeatAtMs: claimedAtMs,
              claim: null,
              claimedAtMs: null
            }
            return { _tag: "Activated" as const }
          }),
        heartbeat: () => Effect.never,
        transitionOwned: (_runId, claimant, status) =>
          Effect.sync(() => {
            if (current.owner?.nonce !== claimant.nonce) return { _tag: "FenceLost" as const }
            current = { ...current, status, owner: null, heartbeatAtMs: null }
            return { _tag: "Transitioned" as const }
          })
      })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let suffixReaders = 0
      const blockingJournal = Journal.makeNoop({
        entries: ({ after, limit }) => {
          const page = journalOf(store).entries({
            runId: "run" as JournalEvent.RunId,
            ...(after === undefined ? {} : { after }),
            limit
          })
          if (after === undefined || suffixReaders > 0) return page
          suffixReaders += 1
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(page)
          )
        }
      })
      const dependencies = Layer.mergeAll(
        Layer.succeed(TimeTravelStore)(store),
        Layer.succeed(RunStore.RunStore)(runs),
        Layer.succeed(Journal.Journal)(blockingJournal),
        Layer.succeed(Jj.Jj)(Jj.makeNoop({ snapshot: () => Effect.succeed({ changeId: "current" }) })),
        CacheStore.layerNoop()
      )
      const serviceLayer = TimeTravel.layer.pipe(Layer.provide(dependencies))
      const fixedClock: Clock.Clock = {
        currentTimeMillisUnsafe: () => 1_000,
        currentTimeMillis: Effect.succeed(1_000),
        currentTimeNanosUnsafe: () => 1_000_000_000n,
        currentTimeNanos: Effect.succeed(1_000_000_000n),
        monotonicTimeNanosUnsafe: () => 1_000_000_000n,
        monotonicTimeNanos: Effect.succeed(1_000_000_000n),
        sleep: () => Effect.yieldNow
      }

      const result = yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const firstContext = yield* Layer.build(serviceLayer).pipe(Random.withSeed("owner-a"))
            const secondContext = yield* Layer.build(serviceLayer).pipe(Random.withSeed("owner-b"))
            const first = Context.get(firstContext, TimeTravel)
            const second = Context.get(secondContext, TimeTravel)
            const position = { runId: "run", frame: { lineageId, seq: 0 } } as const
            const winner = yield* Effect.forkChild(first.rewind(position), { startImmediately: true })
            yield* Deferred.await(entered)
            const loser = yield* Effect.exit(second.rewind(position))
            yield* Deferred.succeed(release, undefined)
            const won = yield* Fiber.join(winner)
            const completedAfterRace = store.state().audits.filter((audit) => audit.status === "completed").length
            const secondPass = yield* second.rewind(position)
            return { completedAfterRace, loser, secondPass, won }
          }).pipe(Effect.provideService(Clock.Clock, fixedClock))
        )
      )

      expect(result.won.archive.archived).toBe(1)
      expect(result.loser._tag).toBe("Failure")
      expect(result.completedAfterRace).toBe(1)
      expect(result.secondPass.archive.archived).toBe(0)
      expect(claimedOwners).toHaveLength(2)
      expect(claimedOwners[0]).not.toEqual(claimedOwners[1])
      expect(TimeTravel.key).toBe("@smthrs/time-travel/TimeTravel")
      expect(store.state().audits.filter((audit) => audit.status === "completed")).toHaveLength(2)
    }))

  // The finite budget covers two independent production engine/service lifetimes over one file database.
  it.effect.skipIf(!jjInstalled)(
    "keeps the TimeTravel service-key component of step identity stable across an engine restart",
    () =>
      Effect.gen(function*() {
        yield* withRealFixture("flows-time-travel-identity-", (fixture) =>
          Effect.gen(function*() {
            let dispatches = 0
            const execute = Effect.sync(() => {
              dispatches += 1
              return "stable"
            })
            const drive = (hostId: string) =>
              runRealEngine(
                fixture.databaseFile,
                hostId,
                Effect.gen(function*() {
                  yield* parkSealedFlow("identity-run", execute)
                  const journal = yield* Journal.Journal
                  yield* journal.flush
                  const sql = yield* Effect.service(SqlClient.SqlClient)
                  return yield* sql<{
                    readonly attempt: number
                    readonly step_key_digest: string
                  }>`
                SELECT step_key_digest, attempt
                FROM flows_attempts
                WHERE run_id = 'identity-run'
                ORDER BY step_key_digest, attempt
              `
                })
              )

            const first = yield* drive("identity-first")
            const restarted = yield* drive("identity-second")

            expect(first).toHaveLength(2)
            expect(restarted).toEqual(first)
            expect(new Set(restarted.map((row) => row.step_key_digest)).size).toBe(2)
            expect(dispatches).toBe(1)
            expect(TimeTravel.key).toBe("@smthrs/time-travel/TimeTravel")
          }))
      }),
    { timeout: 30_000 }
  )

  it.effect("logs and continues when the frame-anchor projection cannot run", () =>
    Effect.gen(function*() {
      // The anchor table is a cache of journal facts, so a journal that cannot be
      // paged for anchoring must not turn a verb into a failure of its own. The
      // fork still reaches its suffix read, and THAT is what fails here.
      const store = MemoryTimeTravelStore.make()
      const failure = yield* (
        Effect.flip(
          Effect.scoped(
            Effect.gen(function*() {
              const timeTravel = yield* TimeTravel
              return yield* timeTravel.fork({ runId: "run", frame: { lineageId, seq: 0 } })
            }).pipe(
              Effect.provide(
                TimeTravel.layer.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      Layer.succeed(TimeTravelStore)(store),
                      Layer.succeed(RunStore.RunStore)(makeRuns()),
                      Layer.succeed(Journal.Journal)(Journal.makeNoop()),
                      Layer.succeed(Jj.Jj)(Jj.makeNoop({})),
                      CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) })
                    )
                  )
                )
              )
            )
          )
        ) as unknown as Effect.Effect<{ readonly message: string }>
      )

      expect(failure.message).toBe("could not read fork suffix for run")
    }))

  it.effect("maps every member of a contributed handler onto the internal registry", () =>
    Effect.gen(function*() {
      // The door is `CompensationHandlers`; the registry behind it stays internal.
      // A handler that declares its optional members must arrive with them.
      const store = MemoryTimeTravelStore.make({ records: [record(0, 10)] })
      const total = yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const timeTravel = yield* TimeTravel
            return yield* timeTravel.inspect({ runId: "run", frame: { lineageId, seq: 0 } }, {
              initial: 0,
              reduce: (state: number, entry) => state + ((entry.payload as { amount: number }).amount ?? 0)
            })
          }).pipe(
            Effect.provide(
              TimeTravel.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    CompensationHandlers.layer([{
                      kind: "billing/Charge",
                      tier: "irreversible",
                      requiresIdempotencyKey: true,
                      residue: () => "The charge stands.",
                      assess: () =>
                        Effect.succeed({ classification: "warning" as const, reason: "policy", residue: "stands" }),
                      revert: () => Effect.succeed({}),
                      rollback: () => Effect.void
                    }]),
                    Layer.succeed(TimeTravelStore)(store),
                    Layer.succeed(RunStore.RunStore)(makeRuns()),
                    Layer.succeed(Journal.Journal)(journalOf(store)),
                    Layer.succeed(Jj.Jj)(Jj.makeNoop({})),
                    CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) })
                  )
                )
              )
            ),
            Effect.orDie
          )
        )
      )

      expect(total).toBe(10)
    }))
})

/**
 * `replay` is the frozen contract's fold verb: the same fold as `inspect`,
 * with the read knobs. Every verb reads under `maxHistoryEntries`, the
 * service default a call may override, and a rewind refuses an over-long
 * suffix before it claims anything.
 */
describe("TimeTravel replay and history caps", () => {
  const dependencies = (store: ReturnType<typeof MemoryTimeTravelStore.make>, workspaces?: Array<string>) =>
    Layer.mergeAll(
      Layer.succeed(TimeTravelStore)(store),
      Layer.succeed(RunStore.RunStore)(makeRuns()),
      Layer.succeed(Journal.Journal)(journalOf(store)),
      Layer.succeed(Jj.Jj)(
        Jj.makeNoop({
          snapshot: () => Effect.succeed({ changeId: "current" }),
          workspaceAdd: (name) => Effect.sync(() => void workspaces?.push(name)),
          workspaceForget: () => Effect.void
        })
      ),
      CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) })
    )
  const sum = {
    initial: 0,
    reduce: (state: number, entry: JournalEvent.Entry) =>
      state + ((entry.payload as { readonly amount?: number } | null)?.amount ?? 0)
  }

  it.effect("replays a position through the fold inspect uses, under the caller's read knobs", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: [record(0, 10), record(1, 20), record(2, 30)] })
      const position = { runId: "run", frame: { lineageId, seq: 1 } }

      const result = yield* run(store, (timeTravel) =>
        Effect.all({
          replayed: timeTravel.replay(position, sum, { pageSize: 1, maxHistoryEntries: 2 }),
          inspected: timeTravel.inspect(position, sum)
        }))

      expect(result.replayed).toBe(30)
      expect(result.inspected).toBe(30)
    }))

  it.effect("refuses malformed replay knobs before reading, and a fold past the cap", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: [record(0, 10), record(1, 20)] })
      const position = { runId: "run", frame: { lineageId, seq: 1 } }

      const failures = yield* run(store, (timeTravel) =>
        Effect.all([
          Effect.flip(timeTravel.replay(position, sum, { pageSize: 0 })),
          Effect.flip(timeTravel.replay(position, sum, { maxHistoryEntries: 1.5 })),
          Effect.flip(timeTravel.replay(position, sum, { maxHistoryEntries: 1 }))
        ]))

      expect(failures.map((failure) => failure.code)).toEqual(["invalid", "invalid", "limit_exceeded"])
      expect(failures[0]!.message).toBe("replay pageSize must be a positive integer, not 0")
      expect(failures[1]!.message).toBe("maxHistoryEntries must be a positive integer, not 1.5")
    }))

  it.effect("caps the suffix a fork assesses, before it mints or provisions anything", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: [record(0, 10), record(1, 20), record(2, 30)] })
      const workspaces: Array<string> = []

      const failures = yield* run(
        store,
        (timeTravel) =>
          Effect.all([
            Effect.flip(timeTravel.fork({ runId: "run", frame: { lineageId, seq: 0 } }, { maxHistoryEntries: 1 })),
            Effect.flip(timeTravel.fork({ runId: "run", frame: { lineageId, seq: 0 } }, { maxHistoryEntries: 0 }))
          ]),
        workspaces
      )

      expect(failures.map((failure) => failure.code)).toEqual(["limit_exceeded", "invalid"])
      expect(workspaces).toEqual([])
      expect(store.state().forkIntents).toEqual([])
      expect(store.state().edges).toEqual([])
    }))

  // The cap is inclusive: a suffix of exactly `maxHistoryEntries` records is
  // read in full and the fork proceeds, the same boundary replay and rewind pin.
  it.effect("forks a suffix of exactly the capped length and provisions one lane", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: [record(0, 10), record(1, 20), record(2, 30)] })
      const workspaces: Array<string> = []

      const fork = yield* run(
        store,
        (timeTravel) => timeTravel.fork({ runId: "run", frame: { lineageId, seq: 0 } }, { maxHistoryEntries: 2 }),
        workspaces
      )

      expect(fork.edge).toMatchObject({ parentRunId: "run", parentSeq: 0, kind: "fork" })
      const lane = Fork.workspaceNameFor(fork.runId)
      expect(workspaces).toEqual([`${lane}@.flows/forks/${lane}`])
      expect(store.state().edges).toHaveLength(1)
    }))

  it.effect("refuses a service-level cap that is not a positive integer at build", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: [record(0, 10)] })
      const failure = yield* Effect.flip(
        Effect.scoped(
          Effect.provide(Effect.void, layerWith({ maxHistoryEntries: 0 }).pipe(Layer.provide(dependencies(store))))
        )
      )

      expect(failure).toMatchObject({ code: "invalid", message: "maxHistoryEntries must be a positive integer, not 0" })
    }))

  it.effect("applies the service-level cap when a call names none, and lets a call raise it", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: [record(0, 10), record(1, 20)] })
      const position = { runId: "run", frame: { lineageId, seq: 1 } }

      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const timeTravel = yield* TimeTravel
          return {
            capped: yield* Effect.flip(timeTravel.inspect(position, sum)),
            raised: yield* timeTravel.replay(position, sum, { maxHistoryEntries: 2 })
          }
        }).pipe(Effect.provide(layerWith({ maxHistoryEntries: 1 }).pipe(Layer.provide(dependencies(store)))))
      )

      expect(result.capped).toMatchObject({ code: "limit_exceeded" })
      expect(result.raised).toBe(30)
    }))
})

/**
 * A fork reserves its id, provisions the lane, then commits. A process that
 * dies between the last two steps leaves a registered lane behind; building
 * the service forgets it, once the reservation is older than the window a
 * live provisioning could plausibly still be inside.
 */
describe("TimeTravel fork lane reclamation", () => {
  const frame = { lineageId, seq: 0 } as const

  const build = (
    store: ReturnType<typeof MemoryTimeTravelStore.make>,
    jj: Partial<Jj.Jj>
  ) =>
    Effect.scoped(
      Effect.provide(
        Effect.void,
        TimeTravel.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(TimeTravelStore)(store),
              Layer.succeed(RunStore.RunStore)(makeRuns()),
              Layer.succeed(Journal.Journal)(journalOf(store)),
              Layer.succeed(Jj.Jj)(Jj.makeNoop(jj)),
              CacheStore.layerNoop()
            )
          )
        )
      )
    )

  it.effect("forgets the lane of a fork that reserved an id and never committed, and leaves a fresh one alone", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: [record(0, 10)] })
      const abandoned = yield* store.nextForkId("run", frame)
      yield* TestClock.adjust("6 minutes")
      const fresh = yield* store.nextForkId("run", frame)
      const forgotten: Array<string> = []

      yield* build(store, { workspaceForget: (name) => Effect.sync(() => void forgotten.push(name)) })

      expect(forgotten).toEqual([Fork.workspaceNameFor(abandoned)])
      expect(store.state().forkIntents.map((intent) => intent.childRunId)).toEqual([fresh])
    }))

  it.effect("reports a lane it cannot forget and still builds", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: [record(0, 10)] })
      yield* store.nextForkId("run", frame)
      yield* TestClock.adjust("6 minutes")
      const logged: Array<string> = []

      yield* build(store, {}).pipe(
        Effect.provide(Logger.layer([Logger.make<unknown, void>(({ message }) => logged.push(String(message)))]))
      )

      expect(logged).toContain("time-travel: could not forget an abandoned fork workspace")
      expect(store.state().forkIntents).toEqual([])
    }))
})

/**
 * The compensation descriptor an adapter records crosses the contribution
 * door with the handler that implements it. Dropping it there resolved every
 * handler by kind alone, so an adapter swapped in after a restart compensated
 * evidence another implementation left behind.
 */
describe("TimeTravel compensation descriptors", () => {
  const boundary = (
    seq: number,
    status: "intended" | "succeeded",
    compensation: string
  ): MemoryTimeTravelStore.JournalRecord => ({
    runId: "run",
    seq,
    eventId: `event-${seq}`,
    lineageId,
    payload: {
      eventType: EffectBoundary.eventType,
      payload: {
        version: 1,
        effect: {
          id: "charge-1",
          kind: "billing/charge",
          tier: "irreversible",
          status,
          runId: "run",
          lineageId,
          idempotencyKey: "charge-1",
          compensation,
          ...(status === "succeeded" ? { output: { chargeId: "ch_1" } } : {})
        }
      },
      meta: { lineageId }
    }
  })

  const rewindWith = (compensation: string) =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [
          record(0, 10),
          boundary(1, "intended", "billing/refund/v1"),
          boundary(2, "succeeded", "billing/refund/v1")
        ]
      })
      const reverted: Array<string> = []
      const exit = yield* Effect.scoped(
        Effect.gen(function*() {
          const timeTravel = yield* TimeTravel
          return yield* Effect.exit(timeTravel.rewind({ runId: "run", frame: { lineageId, seq: 0 } }))
        }).pipe(
          Effect.provide(
            TimeTravel.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  CompensationHandlers.layer([{
                    kind: "billing/charge",
                    tier: "irreversible",
                    requiresIdempotencyKey: true,
                    compensation,
                    residue: () => "The charge was refunded, not un-charged.",
                    revert: (effect) => Effect.sync(() => void reverted.push(effect.id)),
                    rollback: () => Effect.void
                  }]),
                  Layer.succeed(TimeTravelStore)(store),
                  Layer.succeed(RunStore.RunStore)(makeRuns()),
                  Layer.succeed(Journal.Journal)(journalOf(store)),
                  Layer.succeed(Jj.Jj)(Jj.makeNoop({ snapshot: () => Effect.succeed({ changeId: "current" }) })),
                  CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) })
                )
              )
            )
          )
        )
      )
      return { exit, reverted, records: store.state().records.map((entry) => entry.seq) }
    })

  it.effect("refuses to compensate evidence recorded under another descriptor", () =>
    Effect.gen(function*() {
      const drifted = yield* rewindWith("billing/refund/v2")

      expect(drifted.exit._tag).toBe("Failure")
      expect(drifted.reverted).toEqual([])
      expect(drifted.records).toEqual([0, 1, 2])
    }))

  it.effect("compensates through the handler that declares the recorded descriptor", () =>
    Effect.gen(function*() {
      const matched = yield* rewindWith("billing/refund/v1")

      expect(matched.exit._tag).toBe("Success")
      expect(matched.reverted).toEqual(["charge-1"])
      expect(matched.records).toEqual([0])
    }))
})
