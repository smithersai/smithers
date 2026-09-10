/**
 * `ControlLive` away from the happy path: paging and filtering a listing, the
 * decisions and mutations the shared contract does not exercise, and what each
 * collaborator's refusal is reported as.
 */
import { Journal } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { InvalidInput, LaunchFailed, PersistenceError, PlanDenied } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import { ControlRuntime, type MemoryFlow } from "../src/ControlRuntime.ts"
import type { Envelope, FireSummary, ListResponse, Principal, Receipt, TriggerSummary } from "../src/ControlSchema.ts"
import * as DispatchReader from "../src/DispatchReader.ts"
import { park } from "./Park.ts"
import { descriptor, live, memoryRuntime, type Stack } from "./TestStack.ts"

const envelope: Envelope = { capabilities: [], flows: [], budget: {} }
const principal: Principal = { id: "operator", kind: "test", stampedAt: 1 }

/** Three flows, so a page boundary can be named exactly. */
const flows: ReadonlyArray<MemoryFlow> = [
  { flowId: "system/test", description: "Reserved test system flow", deployClass: false, envelope },
  { flowId: "review/pull-request", description: "Review a pull request.", deployClass: false, envelope },
  { flowId: "release/train", description: "Ship a release.", deployClass: true, envelope }
]

const run = <A, E>(
  body: Effect.Effect<A, E, Stack>,
  stack: Layer.Layer<Stack> = live({ runtime: memoryRuntime({ flows }) })
): Promise<A> => Effect.runPromise(body.pipe(Effect.provide(stack), Effect.scoped, Effect.orDie))

/** Plans, approves, and starts one run of `flowId`. */
const start = (flowId: string, suffix: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const runtime = yield* ControlRuntime
    const card = yield* control.plan({ flowId, input: { suite: suffix } })
    yield* control.approve({ ...card.approval, idempotencyKey: `approve:${suffix}` })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${suffix}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a started run")
    yield* runtime.resume(receipt.runId)
    return { card, runId: receipt.runId }
  })

const items = (listed: ListResponse): ReadonlyArray<string> => {
  switch (listed._tag) {
    case "flows":
      return listed.items.map((item) => item.flowId)
    case "runs":
      return listed.items.map((item) => item.runId)
    case "triggers":
      return listed.items.map((item) => item.triggerId)
    case "fires":
      return listed.items.map((item) => `${item.triggerId}@${item.occurrenceAtMs}`)
  }
}

describe("ControlLive listings", () => {
  it("pages valid flow listings and refuses sizes or cursors that cannot make progress", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      return {
        all: yield* control.list({ _tag: "flows" }),
        invalidLimits: yield* Effect.forEach(
          [0, -1, 2.7, Number.NaN, Number.POSITIVE_INFINITY],
          (limit) => control.list({ _tag: "flows", limit }).pipe(Effect.flip)
        ),
        exact: yield* control.list({ _tag: "flows", limit: 3 }),
        tail: yield* control.list({ _tag: "flows", cursor: "2" }),
        beyond: yield* control.list({ _tag: "flows", cursor: "9" }),
        unparsable: yield* control.list({ _tag: "flows", cursor: "not-a-cursor" }).pipe(Effect.flip)
      }
    }))

    expect(items(observed.all)).toEqual(["system/test", "review/pull-request", "release/train"])
    for (const error of observed.invalidLimits) {
      expect(error).toBeInstanceOf(InvalidInput)
      expect((error as InvalidInput).code).toBe("invalid_input")
      expect((error as InvalidInput).issue).toContain("limit")
    }
    // A page that lands exactly on the end carries no next cursor.
    expect(observed.exact).not.toHaveProperty("nextCursor")
    expect(items(observed.tail)).toEqual(["release/train"])
    expect(observed.beyond).toEqual({ _tag: "flows", items: [] })
    expect(observed.unparsable).toBeInstanceOf(InvalidInput)
    expect((observed.unparsable as InvalidInput).issue).toContain("cursor")
  })

  it("bounds an omitted limit and walks every cursor to exhaustion without repeating one", async () => {
    const defaultPageSize = 100
    const catalog = Array.from({ length: defaultPageSize + 23 }, (_, index): MemoryFlow => ({
      flowId: `flow/${String(index).padStart(3, "0")}`,
      description: `Flow ${index}`,
      deployClass: false,
      envelope
    }))
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const first = yield* control.list({ _tag: "flows" })
        const pages: Array<ListResponse> = []
        const cursors: Array<readonly [string | undefined, string | undefined]> = []
        let cursor: string | undefined
        do {
          const current = cursor
          const listed = yield* control.list({ _tag: "flows", ...(cursor === undefined ? {} : { cursor }) })
          pages.push(listed)
          cursor = listed.nextCursor
          cursors.push([current, cursor])
        } while (cursor !== undefined && pages.length < 10)
        return { first, pages, cursors }
      }),
      live({ runtime: memoryRuntime({ flows: catalog }) })
    )

    expect(observed.first.items).toHaveLength(defaultPageSize)
    expect(observed.first.nextCursor).toBe(String(defaultPageSize))
    expect(observed.pages.flatMap(items)).toHaveLength(catalog.length)
    expect(new Set(observed.pages.flatMap(items)).size).toBe(catalog.length)
    expect(observed.cursors.every(([current, next]) => next === undefined || next !== current)).toBe(true)
    expect(observed.cursors.at(-1)?.[1]).toBeUndefined()
  })

  it("prefers the registry's descriptors over the runtime's catalog and pages them the same way", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        return {
          all: yield* control.list({ _tag: "flows" }),
          first: yield* control.list({ _tag: "flows", limit: 1 })
        }
      }),
      live({
        runtime: memoryRuntime({ flows }),
        registry: Registry.layerNoop({
          list: () =>
            Effect.succeed([
              descriptor("review/pull-request", "Review a pull request."),
              descriptor("release/train", "Ship a release.")
            ])
        })
      })
    )

    expect(observed.all).toEqual({
      _tag: "flows",
      items: [
        { flowId: "review/pull-request", description: "Review a pull request." },
        { flowId: "release/train", description: "Ship a release." }
      ]
    })
    expect(observed.first).toMatchObject({ nextCursor: "1" })
    expect(items(observed.first)).toEqual(["review/pull-request"])
  })

  it("carries registry discovery warnings beside every flow page", async () => {
    const warning = {
      code: "invalid_metadata" as const,
      path: "/project/flows/review/flow.ts",
      name: "review",
      message: "Could not statically read the flow declaration"
    }
    const listed = await run(
      Effect.flatMap(Control, (control) => control.list({ _tag: "flows", limit: 1 })),
      live({
        runtime: memoryRuntime({ flows }),
        registry: Registry.layerNoop({
          list: () => Effect.succeed([descriptor("review", "Review")]),
          warnings: () => Effect.succeed([warning])
        })
      })
    )

    expect(listed).toMatchObject({ _tag: "flows", warnings: [warning] })
  })

  it("filters runs by identifier, flow, and status, and combines them with paging", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const first = yield* start("system/test", "one")
      const second = yield* start("review/pull-request", "two")
      yield* park(yield* ControlRuntime, second.runId)
      return {
        byFlow: yield* control.list({ _tag: "runs", filters: { flowId: "review/pull-request" } }),
        byStatus: yield* control.list({ _tag: "runs", filters: { status: "accepted" } }),
        byAll: yield* control.list({
          _tag: "runs",
          filters: { runId: second.runId, flowId: "review/pull-request", status: "parked" }
        }),
        contradictory: yield* control.list({
          _tag: "runs",
          filters: { runId: first.runId, status: "parked" }
        }),
        paged: yield* control.list({ _tag: "runs", limit: 1 }),
        firstRunId: first.runId,
        secondRunId: second.runId
      }
    }))

    expect(items(observed.byFlow)).toEqual([observed.secondRunId])
    expect(items(observed.byStatus)).toEqual([observed.firstRunId])
    expect(items(observed.byAll)).toEqual([observed.secondRunId])
    // Filters intersect: a run matching one but not the other is excluded.
    expect(observed.contradictory).toEqual({ _tag: "runs", items: [] })
    expect(items(observed.paged)).toEqual([observed.firstRunId])
    expect(observed.paged).toMatchObject({ nextCursor: "1" })
  })

  it("uses the direct run lookup for a runId filter, including a missing run", async () => {
    let listRunsCalls = 0
    const guardedRuntime = Layer.effect(ControlRuntime)(
      Effect.map(ControlRuntime, (runtime) =>
        ControlRuntime.of({
          ...runtime,
          listRuns: Effect.sync(() => {
            listRunsCalls += 1
            throw new Error("listRuns must not serve an exact run lookup")
          })
        }))
    ).pipe(Layer.provide(memoryRuntime({ flows })))

    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const { runId } = yield* start("system/test", "direct-lookup")
        return {
          found: yield* control.list({ _tag: "runs", filters: { runId } }),
          missing: yield* control.list({ _tag: "runs", filters: { runId: "run-missing" } }),
          runId
        }
      }),
      live({ runtime: guardedRuntime })
    )

    expect(items(observed.found)).toEqual([observed.runId])
    expect(observed.missing).toEqual({ _tag: "runs", items: [] })
    expect(listRunsCalls).toBe(0)
  })
})

describe("ControlLive mutations", () => {
  it("refuses accessor-backed intent without executing it", async () => {
    let reads = 0
    const payload = Object.defineProperty({}, "decision", {
      enumerable: true,
      get: () => {
        reads++
        return "ship"
      }
    })
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { runId } = yield* start("system/test", "accessor-intent")
      const failure = yield* Effect.flip(control.signal({
        runId,
        signal: { name: "reviewed", payload },
        idempotencyKey: "signal:accessor"
      } as never))
      return { failure, delivered: yield* runtime.deliveredSignals(runId) }
    }))

    expect(observed.failure).toBeInstanceOf(InvalidInput)
    expect(reads).toBe(0)
    expect(observed.delivered).toEqual([])
  })

  it("does not consult proxy reads or toJSON while snapshotting intent", async () => {
    let proxyReads = 0
    let toJsonCalls = 0
    const payload = new Proxy({ decision: "ship" }, {
      get: (target, key, receiver) => {
        proxyReads++
        return Reflect.get(target, key, receiver)
      }
    })
    Object.defineProperty(payload, "toJSON", {
      configurable: true,
      value: () => {
        toJsonCalls++
        return { decision: "rewritten" }
      }
    })

    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { runId } = yield* start("system/test", "inert-intent")
      const receipt = yield* control.signal({
        runId,
        signal: { name: "reviewed", payload },
        idempotencyKey: "signal:inert"
      })
      return { receipt, delivered: yield* runtime.deliveredSignals(runId) }
    }))

    expect(observed.receipt._tag).toBe("Accepted")
    expect(proxyReads).toBe(0)
    expect(toJsonCalls).toBe(0)
    expect(observed.delivered.map((signal) => signal.payload)).toEqual([{ decision: "ship" }])
  })

  it("scopes one caller key to the authenticated actor without using its timestamp", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const notifications = yield* NotificationQueue.NotificationQueue
      const { runId } = yield* start("system/test", "actor-scope")
      const first = yield* control.steer({
        runId,
        message: {
          messageId: "actor-a",
          runId,
          body: "first",
          principal: { id: "alice", kind: "bearer", stampedAt: 1 },
          createdAt: 1
        },
        idempotencyKey: "shared-key"
      })
      const retry = yield* control.steer({
        runId,
        message: {
          messageId: "actor-a",
          runId,
          body: "first",
          principal: { id: "alice", kind: "bearer", stampedAt: 2 },
          createdAt: 1
        },
        idempotencyKey: "shared-key"
      })
      const second = yield* control.steer({
        runId,
        message: {
          messageId: "actor-b",
          runId,
          body: "second",
          principal: { id: "bob", kind: "bearer", stampedAt: 3 },
          createdAt: 1
        },
        idempotencyKey: "shared-key"
      })
      return { first, retry, second, pending: yield* notifications.pending(runId) }
    }))

    expect(observed.first._tag).toBe("Accepted")
    expect(observed.retry._tag).toBe("AlreadyApplied")
    expect(observed.second._tag).toBe("Accepted")
    expect(observed.pending.map((item) => item.provenance.sourceActor)).toEqual([
      "bearer:alice",
      "bearer:bob"
    ])
  })

  it("detaches intent before a downstream suspension", async () => {
    const entered = Effect.runSync(Deferred.make<ControlExecutor.Signal>())
    const release = Effect.runSync(Deferred.make<void>())
    const executor = ControlExecutor.makeNoop({
      deliverSignal: (input) =>
        Deferred.succeed(entered, input).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("unknown" as const)
        )
    })
    const payload = { decision: "before" }

    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const { runId } = yield* start("system/test", "snapshot-intent")
        const fiber = yield* control.signal({
          runId,
          signal: { name: "reviewed", payload },
          idempotencyKey: "signal:snapshot"
        }).pipe(Effect.forkChild({ startImmediately: true }))
        const handedOff = yield* Deferred.await(entered)
        payload.decision = "after"
        yield* Deferred.succeed(release, undefined)
        const receipt = yield* Fiber.join(fiber)
        return { handedOff, receipt, delivered: yield* runtime.deliveredSignals(runId) }
      }),
      live({ runtime: memoryRuntime({ flows }), executor })
    )

    expect(observed.receipt._tag).toBe("Accepted")
    expect(observed.handedOff.signal.payload).toEqual({ decision: "before" })
    expect(observed.delivered.map((signal) => signal.payload)).toEqual([{ decision: "before" }])
    expect(payload).toEqual({ decision: "after" })
  })

  it("preserves valid Unicode and refuses ill-formed or oversized intent", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { runId } = yield* start("system/test", "unicode-intent")
      const accepted = yield* control.signal({
        runId,
        signal: { name: "reviewed", payload: { text: "e\u0301 😀" } },
        idempotencyKey: "signal:unicode"
      })
      const malformed = yield* Effect.flip(control.signal({
        runId,
        signal: { name: "reviewed", payload: { text: "\ud800" } },
        idempotencyKey: "signal:malformed"
      }))
      const oversized = yield* Effect.flip(control.signal({
        runId,
        signal: { name: "reviewed", payload: { text: "x".repeat(4 * 1024 * 1024 + 1) } },
        idempotencyKey: "signal:oversized"
      }))
      return { accepted, malformed, oversized, delivered: yield* runtime.deliveredSignals(runId) }
    }))

    expect(observed.accepted._tag).toBe("Accepted")
    expect(observed.malformed).toBeInstanceOf(InvalidInput)
    expect(observed.oversized).toBeInstanceOf(InvalidInput)
    expect(observed.delivered.map((signal) => signal.payload)).toEqual([{ text: "e\u0301 😀" }])
  })

  it("reports a key reused for a different mutation as a conflict without applying it", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { runId } = yield* start("system/test", "conflict")
      const first = yield* control.signal({
        runId,
        signal: { name: "reviewed", payload: null },
        idempotencyKey: "signal:key"
      })
      const conflict = yield* control.signal({
        runId,
        signal: { name: "rejected", payload: null },
        idempotencyKey: "signal:key"
      })
      const delivered = yield* runtime.deliveredSignals(runId)
      return { first, conflict, delivered }
    }))

    expect(observed.first._tag).toBe("Accepted")
    expect(observed.conflict).toEqual({
      _tag: "Conflict",
      message: "idempotency key signal:signal:key was used for another mutation"
    })
    expect(observed.delivered.map((signal) => signal.name)).toEqual(["reviewed"])
  })

  it("replays the same intent when object keys arrive in a different order", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { runId } = yield* start("system/test", "canonical-intent")
      const first = yield* control.signal({
        runId,
        signal: { name: "reviewed", payload: { decision: "ship", score: 1 } },
        idempotencyKey: "signal:canonical"
      })
      const replay = yield* control.signal({
        runId,
        signal: { name: "reviewed", payload: { score: 1, decision: "ship" } },
        idempotencyKey: "signal:canonical"
      })
      return { first, replay, delivered: yield* runtime.deliveredSignals(runId) }
    }))

    expect(observed.first._tag).toBe("Accepted")
    expect(observed.replay._tag).toBe("AlreadyApplied")
    expect(observed.delivered).toHaveLength(1)
  })

  it("treats a nested principal in signal data as caller intent", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { runId } = yield* start("system/test", "nested-principal")
      const first = yield* control.signal({
        runId,
        signal: { name: "reviewed", payload: { principal: "alice" } },
        idempotencyKey: "signal:nested-principal"
      })
      const conflict = yield* control.signal({
        runId,
        signal: { name: "reviewed", payload: { principal: "bob" } },
        idempotencyKey: "signal:nested-principal"
      })
      return { first, conflict, delivered: yield* runtime.deliveredSignals(runId) }
    }))

    expect(observed.first._tag).toBe("Accepted")
    expect(observed.conflict._tag).toBe("Conflict")
    expect(observed.delivered.map((signal) => signal.payload)).toEqual([{ principal: "alice" }])
  })

  it("denies a plan without installing a grant and refuses to start it afterwards", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const card = yield* control.plan({ flowId: "system/test", input: { suite: "denied" } })
      const receipt = yield* control.deny({ ...card.approval, idempotencyKey: "deny:one" })
      const grants = yield* runtime.grants
      const stored = yield* runtime.getPlan(card.planId)
      const started = yield* Effect.flip(control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: "run:denied"
      }))
      return { receipt, grants, stored, started }
    }))

    expect(observed.receipt).toEqual({ _tag: "Accepted", receiptId: "deny:one" })
    // Only an approval installs an envelope; a denial installs nothing.
    expect(observed.grants).toEqual([])
    expect(observed.stored.decision).toBe("denied")
    expect(observed.started).toBeInstanceOf(PlanDenied)
    expect((observed.started as PlanDenied).planId).toBe(observed.stored.card.planId)
  })

  it("answers Terminal on every run-verb resume replay after the run settled", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const { runId } = yield* start("system/test", "terminal-resume")
      yield* control.cancel({ runId, idempotencyKey: "cancel:resume" })
      const first = yield* control.run({ _tag: "Resume", runId, idempotencyKey: "rejoin:terminal" })
      const again = yield* control.run({ _tag: "Resume", runId, idempotencyKey: "rejoin:terminal" })
      return { first, again, runId }
    }))

    expect(observed.first).toEqual({ _tag: "Terminal", runId: observed.runId, status: "cancelled" })
    expect(observed.again).toEqual(observed.first)
  })

  it("journals a run-verb resume under the durable resume event kind", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const journal = yield* Journal.Journal
      const { runId } = yield* start("system/test", "resume-kind")
      yield* park(yield* ControlRuntime, runId)
      const receipt = yield* control.run({ _tag: "Resume", runId, idempotencyKey: "rejoin:kind" })
      yield* journal.flush
      const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
      return { receipt, runId, kinds: events.map((event) => event.kind) }
    }))

    expect(observed.receipt).toEqual({ _tag: "Accepted", receiptId: "rejoin:kind", runId: observed.runId })
    expect(observed.kinds).toContain("control.run.resume")
    expect(observed.kinds).not.toContain("control.run.resumed")
  })

  it("journals one creation when a keyed plan is replayed", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const journal = yield* Journal.Journal
      const input = { flowId: "system/test", input: { suite: "plan-replay" }, idempotencyKey: "plan:replay" }
      const first = yield* control.plan(input)
      const again = yield* control.plan(input)
      yield* journal.flush
      const events = yield* control.watch({ runId: `plan:${first.planId}`, follow: false }).pipe(Stream.runCollect)
      return { first, again, created: events.filter((event) => event.kind === "control.plan.created") }
    }))

    expect(observed.again).toEqual(observed.first)
    expect(observed.created).toHaveLength(1)
  })

  it("leaves a run pending when no executor is composed at all", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const journal = yield* Journal.Journal
        const { runId } = yield* start("system/test", "no-executor")
        yield* journal.flush
        const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
        const listed = yield* control.list({ _tag: "runs", filters: { runId } })
        return { events, listed }
      }),
      live({ runtime: memoryRuntime({ flows }), executor: "absent" })
    )

    // An absent acceptance port is not a failed launch: the run is recorded
    // as pending and stays where the executor would have picked it up.
    expect(observed.events.map((event) => event.kind)).toEqual([
      "control.run.accepted",
      "control.run.pending"
    ])
    expect(observed.listed).toMatchObject({ items: [{ status: "accepted" }] })
  })

  it("reports a refusing journal as a persistence failure naming the event it lost", async () => {
    const error = await run(
      Effect.gen(function*() {
        const control = yield* Control
        return yield* Effect.flip(control.plan({ flowId: "system/test", input: {} }))
      }),
      live({
        runtime: memoryRuntime({ flows }),
        journal: Journal.layerNoop(),
        notifications: NotificationQueue.layerNoop()
      })
    )

    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).operation).toBe("control.plan.created")
    expect((error as PersistenceError).message).toBe("Failed to persist control.plan.created")
  })

  it("preserves a refusing notification queue's typed reason without accepting a lost steer", async () => {
    const error = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const { runId } = yield* start("system/test", "steer")
        return yield* Effect.flip(control.steer({
          runId,
          message: { messageId: "steer-1", runId, body: "", principal, createdAt: 1 },
          idempotencyKey: "steer:key"
        }))
      }),
      live({ runtime: memoryRuntime({ flows }), notifications: NotificationQueue.layerNoop() })
    )

    expect(error).toBeInstanceOf(NotificationQueue.NotificationError)
    expect(error.code).toBe("notification_unavailable")
  })

  it("refuses a steer whose embedded run id disagrees before admitting anything", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const notifications = yield* NotificationQueue.NotificationQueue
      const { runId } = yield* start("system/test", "steer-run-mismatch")
      const error = yield* control.steer({
        runId,
        message: { messageId: "steer-mismatch", runId: "run-someone-else", body: "stop", principal, createdAt: 1 },
        idempotencyKey: "steer:mismatch"
      }).pipe(Effect.flip)
      return { error, pending: yield* notifications.pending(runId) }
    }))

    expect(observed.error).toBeInstanceOf(InvalidInput)
    expect((observed.error as InvalidInput).code).toBe("invalid_input")
    expect((observed.error as InvalidInput).issue).toContain("message.runId")
    expect(observed.pending).toEqual([])
  })

  it("keeps the message's stated creation time on the enqueue record", async () => {
    // `steerItem` strips the control envelope before the message reaches the
    // queue, so the journal entry is the only place `createdAt` survives. It
    // is the caller's own statement, not a server stamp: over RPC the server's
    // clock is already on `message.principal.stampedAt`.
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const journal = yield* Journal.Journal
      const { runId } = yield* start("system/test", "steer-created-at")
      yield* control.steer({
        runId,
        message: { messageId: "steer-time", runId, body: "continue", principal, createdAt: 1712 },
        idempotencyKey: "steer:time"
      })
      yield* journal.flush
      const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
      return events.find((event) => event.kind === "control.steer.enqueued")
    }))

    expect(observed?.payload).toMatchObject({ messageId: "steer-time", createdAt: 1712 })
  })

  it("admits an empty steering body and keeps a second steer of the same run queued behind it", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const notifications = yield* NotificationQueue.NotificationQueue
      const { runId } = yield* start("system/test", "steering")
      const receipts: Array<Receipt> = []
      for (const body of ["", "second"]) {
        receipts.push(
          yield* control.steer({
            runId,
            message: { messageId: `steer-${body.length}`, runId, body, principal, createdAt: 1 },
            idempotencyKey: `steer:${body.length}`
          })
        )
      }
      const drained = yield* notifications.drain({
        runId,
        targetLineageId: runId,
        boundary: `${runId}/turn-1`,
        wouldIdle: false
      })
      return { receipts, drained }
    }))

    expect(observed.receipts.map((receipt) => receipt._tag)).toEqual(["Accepted", "Accepted"])
    expect(observed.drained.notifications.map((notification) => notification.payload)).toEqual([
      { kind: "Message", body: "" },
      { kind: "Message", body: "second" }
    ])
  })
})

describe("ControlLive executor acceptance", () => {
  it("releases a failed launch's memory claim so the same request can be retried", async () => {
    let launches = 0
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: {} })
        yield* control.approve({ ...card.approval, idempotencyKey: "approve:retry" })
        const input = {
          _tag: "Plan" as const,
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "run:retry"
        }
        const first = yield* Effect.flip(control.run(input))
        const second = yield* control.run(input)
        return { first, second }
      }),
      live({
        runtime: memoryRuntime({ flows }),
        executor: ControlExecutor.makeNoop({
          launch: ({ run }) =>
            Effect.suspend(() => {
              launches++
              return launches === 1
                ? Effect.fail(new LaunchFailed({ runId: run.runId, message: "retry later" }))
                : Effect.succeed("pending" as const)
            })
        })
      })
    )
    expect(observed.first).toBeInstanceOf(LaunchFailed)
    expect(observed.second._tag).toBe("Accepted")
    expect(launches).toBe(2)
  })

  it("surfaces an executor's refusal as a launch failure, and settles the run it recorded", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const failure = yield* Effect.flip(start("system/test", "refused"))
        const listed = yield* control.list({ _tag: "runs" })
        return { failure, listed }
      }),
      live({
        runtime: memoryRuntime({ flows }),
        executor: ControlExecutor.makeNoop({
          launch: Effect.fn("RefusingExecutor.launch")(({ run }) =>
            Effect.fail(new LaunchFailed({ runId: run.runId, message: "no capacity" }))
          )
        })
      })
    )

    expect(observed.failure).toBeInstanceOf(LaunchFailed)
    expect((observed.failure as LaunchFailed).message).toBe("no capacity")
    // The run row survives the refusal, because the acceptance decision is
    // separate from the record of the run having been accepted — but it
    // survives settled. Left `accepted`, it was a run nothing would ever drive
    // and nothing but `smithers cancel` could end (release rehearsal).
    expect(observed.listed).toMatchObject({ items: [{ status: "failed" }] })
  })

  it("marks a run running only once the executor takes it, under its own fence", async () => {
    const accepted: Array<string> = []
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const journal = yield* Journal.Journal
        const { runId } = yield* start("system/test", "accepted")
        yield* journal.flush
        const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
        return { runId, events }
      }),
      live({
        runtime: memoryRuntime({ flows }),
        executor: ControlExecutor.makeNoop({
          launch: Effect.fn("AcceptingExecutor.launch")(({ plan, run }) =>
            Effect.sync(() => {
              accepted.push(`${plan.card.planId}:${run.runId}`)
              return "accepted" as const
            })
          )
        })
      })
    )

    expect(accepted).toEqual([`plan-1:${observed.runId}`])
    expect(observed.events.map((event) => event.kind)).toEqual([
      "control.run.accepted",
      "control.run.running"
    ])
  })
})

/** Three registered triggers, so a page boundary and each filter can be named exactly. */
const triggers: ReadonlyArray<TriggerSummary> = [
  {
    triggerId: "nightly-lint",
    flowId: "lint",
    input: { scope: "all" },
    cron: "0 3 * * *",
    timezone: "UTC",
    overlap: "skip",
    catchUp: "none",
    enabled: true,
    revision: 2,
    lastFiredAtMs: 1_700_000_000_000,
    nextOccurrencesMs: [1_700_086_400_000, 1_700_172_800_000],
    schedulerLastTickMs: 1_700_000_060_000
  },
  {
    triggerId: "hourly-triage",
    flowId: "issue-triage",
    input: null,
    cron: "0 * * * *",
    overlap: "buffer-one",
    catchUp: "one",
    maxCatchUp: 1,
    enabled: true,
    revision: 1,
    pendingAtMs: 1_700_003_600_000,
    activeRunId: "run-triage-7",
    nextOccurrencesMs: [1_700_003_600_000]
  },
  {
    triggerId: "weekly-release-notes",
    flowId: "release-notes",
    input: { channel: "#releases" },
    cron: "0 9 * * 1",
    overlap: "supersede",
    catchUp: "all",
    maxCatchUp: 4,
    enabled: false,
    revision: 5,
    nextOccurrencesMs: []
  }
]

/** Newest first, as a store's history would answer. */
const fires: ReadonlyArray<FireSummary> = [
  { triggerId: "hourly-triage", occurrenceAtMs: 1_700_003_600_000, outcome: null },
  { triggerId: "nightly-lint", occurrenceAtMs: 1_700_000_000_000, outcome: "launched", runId: "run-lint-3" },
  { triggerId: "nightly-lint", occurrenceAtMs: 1_699_913_600_000, outcome: "skipped" },
  { triggerId: "hourly-triage", occurrenceAtMs: 1_699_999_200_000, outcome: "failed", error: "plan denied" },
  {
    triggerId: "nightly-lint",
    occurrenceAtMs: 1_699_827_200_000,
    outcome: "launched",
    runId: "run-lint-2",
    waiting: "approval"
  }
]

/** A reader that answers the fixtures and records what it was asked. */
const recordingReader = (): { readonly reader: DispatchReader.Service; readonly asked: Array<string> } => {
  const asked: Array<string> = []
  return {
    asked,
    reader: DispatchReader.make({
      list: (request) =>
        Effect.sync(() => {
          asked.push(`list:${JSON.stringify(request.filters ?? {})}`)
          return triggers
        }),
      fires: (request) =>
        Effect.sync(() => {
          asked.push(`fires:${JSON.stringify(request.filters ?? {})}`)
          return fires
        })
    })
  }
}

describe("ControlLive trigger listings", () => {
  it("pages trigger rows from the reader and walks the cursor back to the rest", async () => {
    const { asked, reader } = recordingReader()
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const first = yield* control.list({ _tag: "triggers", limit: 2 })
        const rest = first.nextCursor === undefined
          ? undefined
          : yield* control.list({ _tag: "triggers", limit: 2, cursor: first.nextCursor })
        return { first, rest, all: yield* control.list({ _tag: "triggers" }) }
      }),
      live({ runtime: memoryRuntime({ flows }), dispatch: reader })
    )

    expect(observed.first._tag).toBe("triggers")
    expect(items(observed.first)).toEqual(["nightly-lint", "hourly-triage"])
    expect(observed.first.nextCursor).toBe("2")
    expect(observed.rest).toBeDefined()
    expect(items(observed.rest as ListResponse)).toEqual(["weekly-release-notes"])
    expect(observed.rest).not.toHaveProperty("nextCursor")
    // Rows cross the plane unchanged: the optional fields a store reports stay
    // where the store put them, and the ones it omitted stay absent.
    expect(observed.all).toEqual({ _tag: "triggers", items: triggers })
    expect(asked).toEqual(["list:{}", "list:{}", "list:{}"])
  })

  it("applies the trigger filters over what the reader answered and hands the reader the request", async () => {
    const { asked, reader } = recordingReader()
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        return {
          one: yield* control.list({ _tag: "triggers", filters: { triggerId: "hourly-triage" } }),
          byFlow: yield* control.list({ _tag: "triggers", filters: { flowId: "release-notes" } }),
          disabled: yield* control.list({ _tag: "triggers", filters: { enabled: false } }),
          enabled: yield* control.list({ _tag: "triggers", filters: { enabled: true } }),
          none: yield* control.list({ _tag: "triggers", filters: { flowId: "lint", enabled: false } })
        }
      }),
      live({ runtime: memoryRuntime({ flows }), dispatch: reader })
    )

    expect(items(observed.one)).toEqual(["hourly-triage"])
    expect(items(observed.byFlow)).toEqual(["weekly-release-notes"])
    expect(items(observed.disabled)).toEqual(["weekly-release-notes"])
    expect(items(observed.enabled)).toEqual(["nightly-lint", "hourly-triage"])
    expect(observed.none).toEqual({ _tag: "triggers", items: [] })
    expect(asked[0]).toBe("list:{\"triggerId\":\"hourly-triage\"}")
  })

  it("pages the fire ledger newest first and a runId filter returns the one fire naming that run", async () => {
    const { reader } = recordingReader()
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const first = yield* control.list({ _tag: "fires", limit: 3 })
        const rest = first.nextCursor === undefined
          ? undefined
          : yield* control.list({ _tag: "fires", cursor: first.nextCursor })
        return {
          first,
          rest,
          byRun: yield* control.list({ _tag: "fires", filters: { runId: "run-lint-3" } }),
          byTrigger: yield* control.list({ _tag: "fires", filters: { triggerId: "hourly-triage" } }),
          launched: yield* control.list({ _tag: "fires", filters: { outcome: "launched" } }),
          unknownRun: yield* control.list({ _tag: "fires", filters: { runId: "run-nobody" } })
        }
      }),
      live({ runtime: memoryRuntime({ flows }), dispatch: reader })
    )

    expect(observed.first._tag).toBe("fires")
    expect(items(observed.first)).toEqual([
      "hourly-triage@1700003600000",
      "nightly-lint@1700000000000",
      "nightly-lint@1699913600000"
    ])
    expect(observed.first.nextCursor).toBe("3")
    expect(items(observed.rest as ListResponse)).toEqual([
      "hourly-triage@1699999200000",
      "nightly-lint@1699827200000"
    ])
    expect(observed.byRun).toEqual({
      _tag: "fires",
      items: [{
        triggerId: "nightly-lint",
        occurrenceAtMs: 1_700_000_000_000,
        outcome: "launched",
        runId: "run-lint-3"
      }]
    })
    expect(items(observed.byTrigger)).toEqual(["hourly-triage@1700003600000", "hourly-triage@1699999200000"])
    expect(items(observed.launched)).toEqual(["nightly-lint@1700000000000", "nightly-lint@1699827200000"])
    expect(observed.unknownRun).toEqual({ _tag: "fires", items: [] })
  })

  it("refuses sizes and cursors that cannot make progress before asking the reader", async () => {
    const { asked, reader } = recordingReader()
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        return {
          limit: yield* control.list({ _tag: "triggers", limit: 0 }).pipe(Effect.flip),
          cursor: yield* control.list({ _tag: "fires", cursor: "later" }).pipe(Effect.flip)
        }
      }),
      live({ runtime: memoryRuntime({ flows }), dispatch: reader })
    )

    expect(observed.limit).toBeInstanceOf(InvalidInput)
    expect((observed.limit as InvalidInput).issue).toContain("limit")
    expect(observed.cursor).toBeInstanceOf(InvalidInput)
    expect((observed.cursor as InvalidInput).issue).toContain("cursor")
    expect(asked).toEqual([])
  })

  it("answers the typed refusal, not an empty page, when the host serves no trigger store", async () => {
    const refusals = await Effect.runPromise(
      Effect.forEach(
        [live({ runtime: memoryRuntime({ flows }), dispatch: "none" }), live({ runtime: memoryRuntime({ flows }) })],
        (stack) =>
          Effect.gen(function*() {
            const control = yield* Control
            return {
              triggers: yield* control.list({ _tag: "triggers" }).pipe(Effect.flip),
              fires: yield* control.list({ _tag: "fires", filters: { runId: "run-lint-3" } }).pipe(Effect.flip),
              // The two variants a store is not needed for keep answering.
              flows: yield* control.list({ _tag: "flows", limit: 1 }),
              runs: yield* control.list({ _tag: "runs" })
            }
          }).pipe(Effect.provide(stack), Effect.scoped, Effect.orDie)
      )
    )

    for (const observed of refusals) {
      for (const refusal of [observed.triggers, observed.fires]) {
        expect(refusal).toBeInstanceOf(InvalidInput)
        expect((refusal as InvalidInput).code).toBe("invalid_input")
        expect((refusal as InvalidInput).issue).toBe(DispatchReader.noStoreIssue)
        expect((refusal as InvalidInput).issue).toBe("this host serves no trigger store")
      }
      expect(items(observed.flows)).toEqual(["system/test"])
      expect(observed.runs).toEqual({ _tag: "runs", items: [] })
    }
  })
})
