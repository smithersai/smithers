import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Frame from "../src/Frame.ts"
import * as TimeTravel from "../src/index.ts"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Fork from "../src/internal/Fork.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { error, TimeTravelError, TimeTravelErrorCode } from "../src/TimeTravelError.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

/**
 * A fork now assesses the boundary before it copies anything, so it reads the
 * journal suffix and consults the cache and the handler registry. An empty
 * suffix is the "nothing crossed" case these cases are about.
 */
const forkDeps = Layer.mergeAll(
  Layer.succeed(
    Journal.Journal,
    Journal.makeNoop({ entries: () => Effect.succeed({ entries: [], hasMore: false }) })
  ),
  Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop()),
  EffectHandlerRegistry.layerNoop
)

const frame = { lineageId: "parent/root", seq: 0 } as const
const owner = { hostId: "host", pid: 1, nonce: "owner" } as const

const row = (overrides: Partial<RunStore.RunRow> = {}): RunStore.RunRow => ({
  runId: "parent",
  status: "suspended",
  createdAtMs: 0,
  startedAtMs: 0,
  finishedAtMs: null,
  owner: null,
  heartbeatAtMs: null,
  claim: null,
  claimedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  stateJson: "{}",
  ...overrides
})

const runFork = (
  runs: RunStore.Service,
  store: TimeTravelStore["Service"],
  jj: Jj.Jj,
  dependencies = forkDeps
) =>
  Effect.scoped(
    Fork.fork({ parentRunId: "parent", frame, workspaceRoot: "/tmp/lanes" }).pipe(
      Effect.provide(Layer.succeed(RunStore.RunStore, runs)),
      Effect.provide(Layer.succeed(TimeTravelStore, store)),
      Effect.provide(Layer.succeed(Jj.Jj, jj)),
      Effect.provide(dependencies)
    )
  )

describe("public time-travel modules", () => {
  it("exports the service key and the injectable surface, and nothing else", () => {
    // `Replay`, `Fork`, `Rewind`, `Retry`, `Recovery`, `Compensation`, and the
    // effect-handler registry are machinery under `src/internal/` — this list
    // growing back is the regression.
    expect(Object.keys(TimeTravel).sort()).toEqual([
      // The handler DOOR is public; the registry behind it is not.
      "CompensationHandlers",
      "EffectBoundary",
      "Frame",
      "Migrations",
      "MemoryTimeTravelStore",
      "ReadOnlyTimeTravel",
      "SqlTimeTravelStore",
      "TimeTravel",
      "TimeTravelError",
      "TimeTravelStore",
      "defaultMaxHistoryEntries",
      "forkWorkspaceName"
    ].sort())
  })

  it("names the TimeTravel module's types and constants from the barrel", () => {
    // A caller who annotates a signature should not need a second import path.
    const position: TimeTravel.Position = { runId: "parent", frame }
    const projection: TimeTravel.Projection<number> = { initial: 0, reduce: (state) => state + 1 }
    const replayOptions: TimeTravel.ReplayOptions = { pageSize: 1 }
    const forkOptions: TimeTravel.ForkOptions = { retainWorkspace: true }
    const rewindOptions: TimeTravel.RewindOptions = { detachedChildren: "cancel" }
    const options: TimeTravel.Options = { maxHistoryEntries: 1 }
    const results: [TimeTravel.ForkResult, TimeTravel.RewindResult] | undefined = undefined
    const service: TimeTravel.Service | undefined = undefined

    expect([position, projection, replayOptions, forkOptions, rewindOptions, options]).toHaveLength(6)
    expect([results, service]).toEqual([undefined, undefined])
    expect(TimeTravel.forkWorkspaceName("child-1")).toBe(Fork.workspaceNameFor("child-1"))
    expect(TimeTravel.defaultMaxHistoryEntries).toBe(100_000)
  })

  it("exposes the service key as a yieldable tag carrying its own layer", () => {
    expect(TimeTravel.TimeTravel.key).toBe("@smthrs/time-travel/TimeTravel")
    expect(Object.keys(TimeTravel.TimeTravel)).toContain("layer")
  })

  it("accepts the exact frame boundary and every lineage edge kind", () => {
    expect(Schema.decodeUnknownSync(Frame.Frame)({ lineageId: "root", seq: 0 })).toEqual({
      lineageId: "root",
      seq: 0
    })
    for (const kind of ["child", "fork", "continuation"] as const) {
      expect(Schema.decodeUnknownSync(Frame.LineageEdgeKind)(kind)).toBe(kind)
    }
  })

  it("rejects malformed frames and lineage edge kinds", () => {
    for (
      const malformed of [
        { lineageId: "", seq: 0 },
        { lineageId: "root", seq: -1 },
        { lineageId: "root", seq: 0.5 },
        { lineageId: "root", seq: "0" }
      ]
    ) {
      expect(() => Schema.decodeUnknownSync(Frame.Frame)(malformed)).toThrow()
    }
    expect(() => Schema.decodeUnknownSync(Frame.LineageEdgeKind)("reset")).toThrow()
  })

  it("constructs every stable error variant with optional cause semantics", () => {
    const codes = Schema.decodeUnknownSync(Schema.Array(TimeTravelErrorCode))([
      "busy",
      "live_parent",
      "live_child",
      "not_found",
      "invalid",
      "already_crossed",
      "rate_limited",
      "compensation_failed",
      "irreversible",
      "fence_lost",
      "limit_exceeded",
      "unknown"
    ])
    const failures = codes.map((code) => error(code, code))
    const caused = error("unknown", "caused", "root-cause")

    expect(failures.every((failure) => failure instanceof TimeTravelError)).toBe(true)
    expect(failures.map((failure) => failure.code)).toEqual(codes)
    expect(failures.every((failure) => failure.cause === undefined)).toBe(true)
    expect(caused.cause).toBe("root-cause")
  })
})

describe("Fork.fork", () => {
  it.effect("retains an explicitly requested workspace after the service scope closes", () =>
    Effect.gen(function*() {
      const calls: Array<"add" | "forget"> = []
      const store = MemoryTimeTravelStore.make({
        records: [{ runId: "parent", seq: 0, eventId: "e0", lineageId: "parent/root", payload: {} }]
      })
      const result = yield* Effect.scoped(
        Fork.fork({
          parentRunId: "parent",
          frame,
          workspaceRoot: "/tmp/lanes",
          retainWorkspace: true
        }).pipe(
          Effect.provide(Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(row()) }))),
          Effect.provide(Layer.succeed(TimeTravelStore, store)),
          Effect.provide(Layer.succeed(
            Jj.Jj,
            Jj.makeNoop({
              workspaceAdd: () => Effect.sync(() => calls.push("add")),
              workspaceForget: () => Effect.sync(() => calls.push("forget"))
            })
          )),
          Effect.provide(forkDeps)
        )
      )
      expect(result.edge).toMatchObject({ parentRunId: "parent", parentSeq: 0, kind: "fork" })
      expect(calls).toEqual(["add"])
    }))

  it.effect("fails a repeated suffix page instead of spinning", () =>
    Effect.gen(function*() {
      const repeated = {
        runId: "parent" as JournalEvent.RunId,
        seq: 1 as JournalEvent.Seq,
        eventId: "repeated",
        sourceId: "test" as JournalEvent.SourceId,
        sourceSeq: 1 as JournalEvent.SourceSeq,
        emittedAtMs: 0,
        eventType: "unrelated",
        payload: {},
        meta: { lineageId: frame.lineageId }
      }
      const dependencies = Layer.mergeAll(
        Layer.succeed(
          Journal.Journal,
          Journal.makeNoop({ entries: () => Effect.succeed({ entries: [repeated], hasMore: true }) })
        ),
        Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop()),
        EffectHandlerRegistry.layerNoop
      )
      const failure = yield* Effect.flip(runFork(
        RunStore.makeNoop({ get: () => Effect.succeed(row()) }),
        MemoryTimeTravelStore.make(),
        Jj.makeNoop({}),
        dependencies
      ))

      expect(failure).toMatchObject({ code: "invalid", message: "journal fork pagination did not advance for parent" })
    }))

  it.effect("creates the fork workspace and always forgets it when the scope closes", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const store = MemoryTimeTravelStore.make({
        records: [{ runId: "parent", seq: 0, eventId: "e0", lineageId: "parent/root", payload: {} }]
      })
      const result = yield* runFork(
        RunStore.makeNoop({ get: () => Effect.succeed(row()) }),
        store,
        Jj.makeNoop({
          workspaceAdd: (name, path) => Effect.sync(() => calls.push(`add:${name}:${path}`)),
          workspaceForget: (name) => Effect.sync(() => calls.push(`forget:${name}`))
        })
      )

      const lane = Fork.workspaceNameFor(result.runId)
      expect(result).toMatchObject({ edge: { parentRunId: "parent", parentSeq: 0, kind: "fork" } })
      expect(calls).toEqual([
        `add:${lane}:/tmp/lanes/${lane}`,
        `forget:${lane}`
      ])
    }))

  it.effect("maps parent-read and workspace-add failures without leaking a workspace", () =>
    Effect.gen(function*() {
      const addFailure = yield* (
        Effect.flip(
          Effect.scoped(
            Fork.fork({ parentRunId: "parent", frame, workspaceRoot: "/tmp/lanes" }).pipe(
              Effect.provide(Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(row()) }))),
              Effect.provide(Layer.succeed(TimeTravelStore, MemoryTimeTravelStore.make())),
              Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({}))),
              Effect.provide(forkDeps)
            )
          )
        )
      )
      const readFailure = yield* (
        Effect.flip(
          Effect.scoped(
            Fork.fork({ parentRunId: "parent", frame, workspaceRoot: "/tmp/lanes" }).pipe(
              Effect.provide(Layer.succeed(RunStore.RunStore, RunStore.makeNoop())),
              Effect.provide(Layer.succeed(TimeTravelStore, MemoryTimeTravelStore.make())),
              Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({}))),
              Effect.provide(forkDeps)
            )
          )
        )
      )

      expect(addFailure).toMatchObject({ code: "unknown", message: "could not add fork workspace" })
      expect(readFailure).toMatchObject({ code: "unknown", message: "could not read parent" })
    }))

  it.effect("walks the run table's ancestry before provisioning, mapping a missing or unreadable ancestor", () =>
    Effect.gen(function*() {
      let added = false
      const jj = Jj.makeNoop({ workspaceAdd: () => Effect.sync(() => void (added = true)) })
      const rows = new Map<string, RunStore.RunRow>([
        ["parent", row({ parentRunId: "root" })],
        ["root", row({ runId: "root", status: "running", owner })]
      ])
      const runs = (ancestorFailure?: RunStore.RunStoreErrorCode) =>
        RunStore.makeNoop({
          get: (runId) => {
            const found = rows.get(runId)
            return found !== undefined && (runId === "parent" || ancestorFailure === undefined)
              ? Effect.succeed(found)
              : Effect.fail(
                new RunStore.RunStoreError({
                  code: ancestorFailure ?? "not_found_row",
                  method: "get",
                  message: runId,
                  cause: runId
                })
              )
          }
        })

      const live = yield* Effect.flip(runFork(runs(), MemoryTimeTravelStore.make(), jj))
      const missing = yield* Effect.flip(runFork(runs("not_found_row"), MemoryTimeTravelStore.make(), jj))
      const unreadable = yield* Effect.flip(runFork(runs("persistence_failed"), MemoryTimeTravelStore.make(), jj))

      expect(live).toMatchObject({ code: "live_parent", message: "ancestor run root is live" })
      expect(missing).toMatchObject({ code: "not_found", message: "parent root was not found" })
      expect(unreadable).toMatchObject({ code: "unknown", message: "could not read ancestor root" })
      expect(added).toBe(false)
    }))

  it.effect("rejects every live-parent signal before copying history or adding a workspace", () =>
    Effect.gen(function*() {
      const liveRows = [
        row({ status: "running", owner }),
        row({ claim: owner, claimedAtMs: 1 }),
        row({ owner, heartbeatAtMs: 1 })
      ]
      for (const liveRow of liveRows) {
        let added = false
        const store = MemoryTimeTravelStore.make()
        const failure = yield* (
          Effect.flip(
            Effect.scoped(
              Fork.fork({ parentRunId: "parent", frame, workspaceRoot: "/tmp/lanes" }).pipe(
                Effect.provide(
                  Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(liveRow) }))
                ),
                Effect.provide(Layer.succeed(TimeTravelStore, store)),
                Effect.provide(
                  Layer.succeed(
                    Jj.Jj,
                    Jj.makeNoop({ workspaceAdd: () => Effect.sync(() => void (added = true)) })
                  )
                ),
                Effect.provide(forkDeps)
              )
            )
          )
        )

        expect(failure).toMatchObject({ code: "live_parent", message: "parent run parent is live" })
        expect(store.state().records).toEqual([])
        expect(added).toBe(false)
      }
    }))
})
