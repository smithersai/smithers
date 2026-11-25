/**
 * `Control.pause` parks a running run without cancelling or failing it.
 *
 * 1.0.0-rc.0 removed the first pause because it flipped the control row to
 * `parked` while the execution kept running. This one parks the execution
 * through `ControlExecutor.pause` before it writes the control row, and a
 * composition whose executor cannot park an execution answers `Unavailable`
 * and changes nothing. The suites below hold that line over the in-memory
 * runtime, the durable one, and the RPC transport.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import type * as Ownership from "@smthrs/run-store/Ownership"
import { Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { RpcSerialization } from "effect/rpc"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Control, layerNoop, type PauseInput } from "../src/Control.ts"
import * as ControlClient from "../src/ControlClient.ts"
import {
  ClaimLost,
  type ControlError,
  InvalidInput,
  NoMatchingWait,
  PersistenceError,
  RunNotFound,
  TransportError,
  Unavailable
} from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import * as ControlRpcs from "../src/ControlRpcs.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { RunId, RunSummary } from "../src/ControlSchema.ts"
import * as ControlServer from "../src/ControlServer.ts"
import * as Monitor from "../src/Monitor.ts"
import * as ScopedToken from "../src/ScopedToken.ts"
import { delegateApproval } from "./ApprovalFixtures.ts"
import * as DurableStack from "./DurableStack.ts"
import * as TestStack from "./TestStack.ts"

type Parked = { readonly runId: RunId; readonly reason: string | undefined }

/**
 * An executor that takes every launch, so the run is `running` and owned, and
 * records each park it is asked for.
 *
 * @param pause what a park answers; `"absent"` builds an executor written
 *   before pause existed
 */
const executor = (
  pause: Effect.Effect<void, ControlError> | "absent" = Effect.void
): { readonly service: ControlExecutor.Service; readonly parked: Array<Parked> } => {
  const parked: Array<Parked> = []
  return {
    parked,
    service: ControlExecutor.makeNoop({
      launch: () => Effect.succeed("accepted" as const),
      pause: pause === "absent" ? undefined : (runId, reason) =>
        Effect.andThen(
          Effect.sync(() => {
            parked.push({ runId, reason })
          }),
          pause
        )
    })
  }
}

/** Plans, approves, and starts one run of the test flow. */
const start = (name: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const card = yield* control.plan({ flowId: "system/test", input: { pause: name } })
    yield* control.approve(card.approval)
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${name}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
      return yield* Effect.die(`expected an accepted run, received ${receipt._tag}`)
    }
    return receipt.runId
  })

const summaryOf = (runId: RunId) =>
  Effect.gen(function*() {
    const control = yield* Control
    const listed = yield* control.list({ _tag: "runs" })
    if (listed._tag !== "runs") return yield* Effect.die("expected a run listing")
    const run = listed.items.find((item) => item.runId === runId)
    if (run === undefined) return yield* Effect.die(`run ${runId} is not listed`)
    return run as RunSummary
  })

const eventsOf = (runId: RunId) =>
  Effect.gen(function*() {
    const control = yield* Control
    return Array.from(yield* Stream.runCollect(control.watch({ runId, follow: false })))
  })

const kindsOf = (runId: RunId) => Effect.map(eventsOf(runId), (events) => events.map((event) => event.kind))

const health = (summary: RunSummary): Monitor.Health =>
  Monitor.classify({
    summary,
    events: [],
    semanticProgress: false,
    beatsWithoutProgress: 99,
    stallBeats: 1
  } as unknown as Monitor.Observation)

/**
 * The behavior both runtimes owe, run against each.
 *
 * @param name the runtime under test
 * @param stack builds the control stack over the supplied executor
 */
const contract = (
  name: string,
  stack: (service: ControlExecutor.Service | "absent") => Layer.Layer<Control | ControlRuntime>
) => {
  const run = <A, E>(
    effect: Effect.Effect<A, E, Control | ControlRuntime>,
    service: ControlExecutor.Service | "absent"
  ) => Effect.runPromise(effect.pipe(Effect.provide(stack(service)), Effect.scoped))

  describe(`Control.pause over the ${name} runtime`, () => {
    it("parks a running run, records who paused it and why, and parks the execution", async () => {
      const { parked, service } = executor()
      const result = await run(
        Effect.gen(function*() {
          const control = yield* Control
          const runId = yield* start("active")
          const before = yield* summaryOf(runId)
          const kindsBefore = yield* kindsOf(runId)
          const receipt = yield* control.pause({
            runId,
            idempotencyKey: "pause:active",
            reason: "deploy freeze",
            principal: { id: "ada", kind: "operator", stampedAt: 7 }
          })
          const events = yield* eventsOf(runId)
          return { runId, before, receipt, after: yield* summaryOf(runId), added: events.slice(kindsBefore.length) }
        }),
        service
      )

      expect(result.before.status).toBe("running")
      expect(result.before.ownerId).toBeDefined()
      expect(result.receipt).toEqual({ _tag: "Accepted", receiptId: "pause:active", runId: result.runId })
      expect(result.after.status).toBe("parked")
      expect(result.after.waitingReason).toBeUndefined()
      expect(result.after.ownerId).toBeUndefined()
      expect(result.after.parkedBy).toBeDefined()
      expect(health(result.after)).toBe("awaiting-human")
      expect(parked).toEqual([{ runId: result.runId, reason: "deploy freeze" }])
      expect(result.added.map((event) => event.kind)).toEqual(["control.run.paused", "control.run.parked"])
      expect(result.added[0]?.payload).toMatchObject({
        runId: result.runId,
        reason: "deploy freeze",
        principal: { id: "ada", kind: "operator" }
      })
      expect(result.added[1]?.payload).toMatchObject({ runId: result.runId, status: "parked", factVersion: 1 })
    })

    it("records no reason when none is given", async () => {
      const { parked, service } = executor()
      const result = await run(
        Effect.gen(function*() {
          const control = yield* Control
          const runId = yield* start("unreasoned")
          yield* control.pause({ runId, idempotencyKey: "pause:unreasoned" })
          const paused = (yield* eventsOf(runId)).find((event) => event.kind === "control.run.paused")
          return { runId, payload: paused?.payload }
        }),
        service
      )

      expect(parked).toEqual([{ runId: result.runId, reason: undefined }])
      expect(result.payload).toBeDefined()
      expect(result.payload).not.toHaveProperty("reason")
    })

    it("replays the same key and intent as AlreadyApplied without parking twice", async () => {
      const { parked, service } = executor()
      const result = await run(
        Effect.gen(function*() {
          const control = yield* Control
          const runId = yield* start("replay")
          const input: PauseInput = { runId, idempotencyKey: "pause:replay", reason: "once" }
          const first = yield* control.pause(input)
          const kinds = yield* kindsOf(runId)
          const again = yield* control.pause(input)
          return { runId, first, again, kinds, kindsAfter: yield* kindsOf(runId) }
        }),
        service
      )

      expect(result.first._tag).toBe("Accepted")
      expect(result.again).toEqual({ _tag: "AlreadyApplied", receiptId: "pause:replay", runId: result.runId })
      expect(result.kindsAfter).toEqual(result.kinds)
      expect(parked).toHaveLength(1)
    })

    it("answers Conflict when the same key carries a different intent", async () => {
      const { parked, service } = executor()
      const result = await run(
        Effect.gen(function*() {
          const control = yield* Control
          const runId = yield* start("conflict")
          yield* control.pause({ runId, idempotencyKey: "pause:conflict", reason: "first" })
          const kinds = yield* kindsOf(runId)
          const conflict = yield* control.pause({ runId, idempotencyKey: "pause:conflict", reason: "second" })
          return { conflict, kinds, kindsAfter: yield* kindsOf(runId) }
        }),
        service
      )

      expect(result.conflict._tag).toBe("Conflict")
      expect(result.kindsAfter).toEqual(result.kinds)
      expect(parked).toHaveLength(1)
    })

    it("keys idempotency on the principal, so another actor's same key is a new request", async () => {
      const { service } = executor()
      const error = await run(
        Effect.gen(function*() {
          const control = yield* Control
          const runId = yield* start("namespaced")
          const input = { runId, idempotencyKey: "pause:shared", reason: "same" }
          yield* control.pause({ ...input, principal: { id: "ada", kind: "operator", stampedAt: 1 } })
          return yield* Effect.flip(
            control.pause({ ...input, principal: { id: "grace", kind: "operator", stampedAt: 2 } })
          )
        }),
        service
      )

      // Not `AlreadyApplied`: grace never paused this run, and it is parked now.
      expect(error).toBeInstanceOf(InvalidInput)
      expect((error as InvalidInput).issue).toContain("is parked, and only a running run can be paused")
    })

    it("answers Terminal for a settled run and changes nothing, even under a used key", async () => {
      const { parked, service } = executor()
      const result = await run(
        Effect.gen(function*() {
          const control = yield* Control
          const runId = yield* start("terminal")
          const input: PauseInput = { runId, idempotencyKey: "pause:terminal" }
          yield* control.pause(input)
          yield* control.cancel({ runId, idempotencyKey: "cancel:terminal" })
          const kinds = yield* kindsOf(runId)
          const replayed = yield* control.pause(input)
          const fresh = yield* control.pause({ runId, idempotencyKey: "pause:terminal:fresh" })
          return { runId, replayed, fresh, kinds, kindsAfter: yield* kindsOf(runId), after: yield* summaryOf(runId) }
        }),
        service
      )

      const terminal = { _tag: "Terminal", runId: result.runId, status: "cancelled" }
      expect(result.replayed).toEqual(terminal)
      expect(result.fresh).toEqual(terminal)
      expect(result.after.status).toBe("cancelled")
      expect(result.kindsAfter).toEqual(result.kinds)
      expect(parked).toHaveLength(1)
    })

    it("fails RunNotFound for a run that does not exist", async () => {
      const { parked, service } = executor()
      const error = await run(
        Effect.flatMap(
          Control,
          (control) => Effect.flip(control.pause({ runId: "missing-run", idempotencyKey: "pause:missing" }))
        ),
        service
      )

      expect(error).toBeInstanceOf(RunNotFound)
      expect(parked).toEqual([])
    })

    it.each([
      ["a missing idempotency key", { runId: "run" }],
      ["an empty idempotency key", { runId: "run", idempotencyKey: "" }],
      ["a missing run id", { idempotencyKey: "pause:invalid" }],
      ["a reason that is not a string", { runId: "run", idempotencyKey: "pause:invalid", reason: 5 }],
      ["a value that is not detached JSON", { runId: "run", idempotencyKey: "pause:invalid", reason: new Date(0) }],
      ["a principal that is not one", { runId: "run", idempotencyKey: "pause:invalid", principal: "ada" }]
    ])("refuses %s as InvalidInput before reading the run", async (_name, input) => {
      const { parked, service } = executor()
      const error = await run(
        Effect.flatMap(Control, (control) => Effect.flip(control.pause(input as unknown as PauseInput))),
        service
      )

      expect(error).toBeInstanceOf(InvalidInput)
      expect((error as InvalidInput).issue).toMatch(/^pause/)
      expect(parked).toEqual([])
    })

    it("round-trips through resume, and the resumed run can be paused again", async () => {
      const { parked, service } = executor()
      const result = await run(
        Effect.gen(function*() {
          const control = yield* Control
          const runId = yield* start("round-trip")
          yield* control.pause({ runId, idempotencyKey: "pause:round-trip:1", reason: "hold" })
          const resumed = yield* control.resume({ runId, idempotencyKey: "resume:round-trip", reason: "go" })
          const live = yield* summaryOf(runId)
          const again = yield* control.pause({ runId, idempotencyKey: "pause:round-trip:2" })
          return { runId, resumed, live, again, after: yield* summaryOf(runId), kinds: yield* kindsOf(runId) }
        }),
        service
      )

      expect(result.resumed).toEqual({ _tag: "Accepted", receiptId: "resume:round-trip", runId: result.runId })
      expect(result.live.status).toBe("accepted")
      expect(result.live.ownerId).toBeDefined()
      expect(result.live.parkedBy).toBeUndefined()
      expect(result.again._tag).toBe("Accepted")
      expect(result.after.status).toBe("parked")
      expect(result.kinds.filter((kind) => kind.startsWith("control.run.pa") || kind === "control.run.resume"))
        .toEqual([
          "control.run.paused",
          "control.run.parked",
          "control.run.resume",
          "control.run.paused",
          "control.run.parked"
        ])
      expect(parked).toHaveLength(2)
    })

    it.each([
      ["has no executor", "absent" as const],
      ["has an executor that cannot park an execution", executor("absent").service]
    ])("fails Unavailable and leaves the run running when the composition %s", async (_name, service) => {
      const result = await run(
        Effect.gen(function*() {
          const control = yield* Control
          const runtime = yield* ControlRuntime
          const runId = yield* start("unavailable")
          // With no executor nothing takes the launch, so claim the run here.
          yield* runtime.resume(runId)
          const before = yield* summaryOf(runId)
          const kinds = yield* kindsOf(runId)
          const input: PauseInput = { runId, idempotencyKey: "pause:unavailable" }
          const error = yield* Effect.flip(control.pause(input))
          // Nothing was recorded, so the same key asks again rather than replaying.
          const again = yield* Effect.flip(control.pause(input))
          return { before, error, again, after: yield* summaryOf(runId), kinds, kindsAfter: yield* kindsOf(runId) }
        }),
        service
      )

      expect(result.error).toBeInstanceOf(Unavailable)
      expect((result.error as Unavailable).feature).toBe("pause")
      expect(result.again).toBeInstanceOf(Unavailable)
      expect(result.after.status).toBe(result.before.status)
      expect(result.after.ownerId).toBe(result.before.ownerId)
      expect(result.kindsAfter).toEqual(result.kinds)
    })

    it("fails ClaimLost, before the execution is parked, for a run this process does not hold", async () => {
      const parked: Array<Parked> = []
      // The default launch answers `pending`, which releases the claim.
      const service = ControlExecutor.makeNoop({
        pause: (runId, reason) => Effect.sync(() => void parked.push({ runId, reason }))
      })
      const result = await run(
        Effect.gen(function*() {
          const control = yield* Control
          const runId = yield* start("unowned")
          const before = yield* summaryOf(runId)
          const error = yield* Effect.flip(control.pause({ runId, idempotencyKey: "pause:unowned" }))
          return { before, error, after: yield* summaryOf(runId) }
        }),
        service
      )

      expect(result.before.ownerId).toBeUndefined()
      expect(result.error).toBeInstanceOf(ClaimLost)
      expect(result.after.status).toBe(result.before.status)
      expect(parked).toEqual([])
    })

    it.each([
      [
        "a failure pause declares",
        new PersistenceError({ operation: "engine.park", message: "disk full" }),
        "engine.park"
      ],
      ["any other control error", new NoMatchingWait({ runId: "run", waitName: "gate" }), "pause"]
    ])("leaves the run running when the executor refuses with %s", async (_name, refusal, operation) => {
      const { parked, service } = executor(Effect.fail(refusal))
      const result = await run(
        Effect.gen(function*() {
          const control = yield* Control
          const runId = yield* start("refused")
          const kinds = yield* kindsOf(runId)
          const error = yield* Effect.flip(control.pause({ runId, idempotencyKey: "pause:refused" }))
          return { error, after: yield* summaryOf(runId), kinds, kindsAfter: yield* kindsOf(runId) }
        }),
        service
      )

      expect(result.error).toBeInstanceOf(PersistenceError)
      expect((result.error as PersistenceError).operation).toBe(operation)
      expect(result.after.status).toBe("running")
      expect(result.after.ownerId).toBeDefined()
      expect(result.kindsAfter).toEqual(result.kinds)
      expect(parked).toHaveLength(1)
    })
  })

  describe(`ControlRuntime.pause over the ${name} runtime`, () => {
    it("parks an owned run, answers a settled run as it stands, and refuses a run it does not hold", async () => {
      const { service } = executor()
      const result = await run(
        Effect.gen(function*() {
          const control = yield* Control
          const runtime = yield* ControlRuntime
          const runId = yield* start("runtime")
          const parked = yield* runtime.pause(runId)
          const unowned = yield* Effect.flip(runtime.pause(runId))
          yield* control.cancel({ runId, idempotencyKey: "cancel:runtime" })
          const settled = yield* runtime.pause(runId)
          const missing = yield* Effect.flip(runtime.pause("missing-run"))
          return { parked, unowned, settled, missing }
        }),
        service
      )

      expect(result.parked.status).toBe("parked")
      expect(result.parked.waitingReason).toBeUndefined()
      expect(result.parked.ownerId).toBeUndefined()
      expect(result.parked.parkedBy).toBeDefined()
      expect(result.unowned).toBeInstanceOf(ClaimLost)
      expect(result.settled.status).toBe("cancelled")
      expect(result.missing).toBeInstanceOf(RunNotFound)
    })
  })
}

contract("in-memory", (service) => TestStack.live({ executor: service }))
contract(
  "durable SQL",
  // `DurableStack` always composes an executor, so the absent composition is
  // an executor that carries no pause: both reach the same refusal.
  (service) => DurableStack.durable({ executor: service === "absent" ? executor("absent").service : service })
)

describe("SqlControlRuntime parked-owner liveness reclaim", () => {
  it("reclaims a parked run when the same-host parked owner is reported dead by isAlive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctrl-park-reclaim-"))
    try {
      const dbFile = join(dir, "control.sqlite")
      const ownerA: Ownership.OwnerId = { hostId: "same-host", pid: 101, nonce: "n-a" }
      const ownerB: Ownership.OwnerId = { hostId: "same-host", pid: 202, nonce: "n-b" }
      const layerA = DurableStack.durable({
        database: DurableStack.fileBundle(dbFile),
        owner: ownerA,
        executor: executor().service
      })
      const layerB = DurableStack.durable({
        database: DurableStack.fileBundle(dbFile),
        owner: ownerB,
        isAlive: () => Effect.succeed(false),
        executor: executor().service
      })
      const runId = await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime
          const id = yield* start("reclaim-dead-park")
          yield* runtime.pause(id)
          return id
        }).pipe(Effect.provide(layerA), Effect.scoped)
      )
      const reclaimed = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          return yield* control.resume({ runId, idempotencyKey: "resume:reclaim-dead-park" })
        }).pipe(Effect.provide(layerB), Effect.scoped)
      )
      expect(reclaimed).toMatchObject({ _tag: "Accepted", runId })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
