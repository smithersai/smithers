/**
 * A run admitted by a process that died before its executor took the launch.
 *
 * `Control.run` commits the run row and its idempotency receipt, then hands the
 * run to the executor outside that transaction. A crash in between left the run
 * `accepted` under a dead owner, and the client's retry with the same key only
 * read the recorded receipt back, so nothing ever launched it (#2175).
 */
import { Registry } from "@smthrs/registry"
import { Deferred, Effect, Exit, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { PersistenceError } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import * as ControlLive from "../src/ControlLive.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { PlanCard } from "../src/ControlSchema.ts"
import { durable, type DurableStack, fileBundle } from "./DurableStack.ts"
import { live } from "./TestStack.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-control-stranded-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const stack = (
  filename: string,
  pid: number,
  executor: ControlExecutor.Service,
  alive: ReadonlyArray<number> = []
): Layer.Layer<DurableStack> =>
  durable({
    database: fileBundle(filename),
    owner: { hostId: "stranded-host", pid, nonce: `process-${pid}` },
    // This process is alive, and so is any pid in `alive`; every other is gone.
    isAlive: (owner) => Effect.succeed(owner.pid === pid || alive.includes(owner.pid)),
    executor
  })

const run = <A, E>(layer: Layer.Layer<DurableStack>, body: Effect.Effect<A, E, DurableStack>) =>
  Effect.runPromiseExit(body.pipe(Effect.provide(layer), Effect.scoped))

const admit = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "system/test", input: { suite: "stranded" } })
  yield* control.approve({ ...card.approval, idempotencyKey: "approve:stranded" })
  return card
})

const retry = (card: PlanCard) =>
  Effect.gen(function*() {
    const control = yield* Control
    return yield* control.run({
      _tag: "Plan",
      reservedRunId: "dispatch:stranded-caller-reservation",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: "run:stranded"
    })
  })

it.each(["interruption", "defect"])("recovers an unacknowledged launch after %s", async (failure) => {
  const filename = join(directory, `stranded-${failure}.sqlite`)
  const planned = await run(stack(filename, 101, ControlExecutor.makeNoop()), admit)
  if (!Exit.isSuccess(planned)) throw new Error("plan failed")
  const card = planned.value

  // The host dies inside launch, after the durable handoff.
  const crashed = await run(
    stack(
      filename,
      101,
      ControlExecutor.makeNoop({ launch: () => failure === "defect" ? Effect.die("host died") : Effect.interrupt })
    ),
    retry(card)
  )
  expect(Exit.isFailure(crashed)).toBe(true)

  const launched: Array<string> = []
  const launch = ControlExecutor.makeNoop({
    launch: (input) => Effect.sync(() => launched.push(input.run.runId)).pipe(Effect.as("accepted" as const))
  })
  // While the admitter's pid still answers, its run stays its own.
  const refused = await run(stack(filename, 202, launch, [101]), retry(card))
  if (!Exit.isSuccess(refused)) throw new Error(String(refused.cause))
  expect(refused.value).toMatchObject({ _tag: "AlreadyApplied", receiptId: "run:stranded" })
  expect(launched).toEqual([])

  const retried = await run(
    stack(filename, 202, launch),
    Effect.gen(function*() {
      // The admitter's pid is gone from this host, so its lease, still fresh,
      // is no reason to wait. The handoff still requires an explicit resume.
      const receipt = yield* retry(card)
      const again = yield* retry(card)
      const runtime = yield* ControlRuntime
      if (receipt._tag !== "AlreadyApplied" || receipt.runId === undefined) {
        return yield* Effect.die(JSON.stringify(receipt))
      }
      return { receipt, runId: receipt.runId, again, status: (yield* runtime.getRun(receipt.runId)).status }
    })
  )
  if (!Exit.isSuccess(retried)) throw new Error(String(retried.cause))
  // A replay returns the receipt without calling either executor again.
  expect(retried.value.receipt).toMatchObject({ _tag: "AlreadyApplied", receiptId: "run:stranded" })
  expect(retried.value.again).toEqual(retried.value.receipt)
  expect(launched).toEqual([retried.value.runId])
  expect(retried.value.status).toBe("running")
  expect(retried.value.runId).toBe("dispatch:stranded-caller-reservation")
})

it("a late admitter cannot hand off a launch another runtime took", async () => {
  const file = join(directory, "late-handoff.sqlite")
  const calls: string[] = []
  const executor = ControlExecutor.makeNoop({
    launch: (input) =>
      Effect.sync(() => {
        calls.push(input.run.runId)
        return "accepted" as const
      })
  })
  const first = stack(file, 101, executor)
  const card = await run(first, admit)
  if (!Exit.isSuccess(card)) throw new Error("plan failed")
  const ready = Effect.runSync(Deferred.make<void>())
  const release = Effect.runSync(Deferred.make<void>())
  // Pause at the real handoff transaction while a peer recovers the abandoned admission.
  const delayed = Layer.effect(
    ControlRuntime,
    Effect.map(ControlRuntime, (runtime) => ({
      ...runtime,
      takeLaunch: (id: string) =>
        Deferred.succeed(ready, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(runtime.takeLaunch(id))
        )
    }))
  ).pipe(Layer.provideMerge(first))
  const original = run(
    Layer.provideMerge(Layer.fresh(ControlLive.layer), Layer.merge(Registry.layerNoop(), delayed)),
    retry(card.value)
  )
  try {
    await Effect.runPromise(Deferred.await(ready))
    expect(Exit.isSuccess(await run(stack(file, 202, executor), retry(card.value)))).toBe(true)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
  }
  expect(Exit.isSuccess(await original)).toBe(true)
  expect(calls).toEqual(["dispatch:stranded-caller-reservation"])
})

it("retries stranded recovery in the same process after the plan read fails", async () => {
  const filename = join(directory, "plan-read-failure.sqlite")
  const planned = await run(stack(filename, 101, ControlExecutor.makeNoop()), admit)
  if (!Exit.isSuccess(planned)) throw new Error("plan failed")
  const card = planned.value
  const crashed = await run(
    Layer.provideMerge(
      Layer.fresh(ControlLive.layer),
      Layer.merge(
        Registry.layerNoop(),
        Layer.effect(
          ControlRuntime,
          Effect.map(
            ControlRuntime,
            (runtime) => ({ ...runtime, takeLaunch: () => Effect.die("host died before handoff") })
          )
        ).pipe(Layer.provideMerge(stack(filename, 101, ControlExecutor.makeNoop())))
      )
    ),
    retry(card)
  )
  expect(Exit.isFailure(crashed)).toBe(true)

  const guarded = await run(
    stack(filename, 202, ControlExecutor.makeNoop({ launch: () => Effect.die("live admitter was bypassed") }), [101]),
    retry(card)
  )
  expect(Exit.isSuccess(guarded) && guarded.value._tag).toBe("AlreadyApplied")
  const launched: Array<string> = []
  let failNextPlanRead = true
  const base = stack(
    filename,
    202,
    ControlExecutor.makeNoop({
      launch: (input) => Effect.sync(() => launched.push(input.run.runId)).pipe(Effect.as("accepted" as const))
    })
  )
  const faultyRuntime = Layer.effect(
    ControlRuntime,
    Effect.map(ControlRuntime, (runtime) => ({
      ...runtime,
      getPlan: (planId: string) =>
        Effect.suspend(() => {
          if (failNextPlanRead) {
            failNextPlanRead = false
            return Effect.fail(new PersistenceError({ operation: "read plan", message: "injected plan read failure" }))
          }
          return runtime.getPlan(planId)
        })
    }))
  ).pipe(Layer.provideMerge(base))
  const recovered = await run(
    Layer.provideMerge(Layer.fresh(ControlLive.layer), Layer.merge(faultyRuntime, Registry.layerNoop())),
    Effect.gen(function*() {
      const first = yield* retry(card)
      expect(launched).toEqual([])
      const second = yield* retry(card)
      expect(second).toEqual(first)
      expect(launched).toEqual(["dispatch:stranded-caller-reservation"])
      expect((yield* (yield* ControlRuntime).getRun("dispatch:stranded-caller-reservation")).status).toBe("running")
      yield* retry(card)
      expect(launched).toHaveLength(1)
    })
  )
  if (!Exit.isSuccess(recovered)) throw new Error(String(recovered.cause))
})

it("a live claimant retains its in-flight handoff until another owner proves it dead", async () => {
  const filename = join(directory, "in-flight.sqlite")
  const ready = Effect.runSync(Deferred.make<void>())
  const release = Effect.runSync(Deferred.make<void>())
  const first = stack(
    filename,
    101,
    ControlExecutor.makeNoop({
      launch: () =>
        Deferred.succeed(ready, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.interrupt)
        )
    })
  )
  const planned = await run(first, admit)
  if (!Exit.isSuccess(planned)) throw new Error("plan failed")
  const original = run(first, retry(planned.value))
  const calls: string[] = []
  const peer = ControlExecutor.makeNoop({
    launch: ({ run }) =>
      Effect.sync(() => {
        calls.push(run.runId)
        return "accepted" as const
      })
  })
  try {
    await Effect.runPromise(Deferred.await(ready))
    expect(Exit.isSuccess(await run(stack(filename, 202, peer, [101]), retry(planned.value)))).toBe(true)
    expect(calls).toEqual([])
    expect(Exit.isSuccess(await run(stack(filename, 202, peer), retry(planned.value)))).toBe(true)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
  }
  expect(Exit.isFailure(await original)).toBe(true)
  expect(calls).toEqual(["dispatch:stranded-caller-reservation"])
  expect(Exit.isSuccess(await run(stack(filename, 303, peer), retry(planned.value)))).toBe(true)
  expect(calls).toHaveLength(1)
})

it("the memory owner can retry a failed handoff and ignores an obsolete release", async () => {
  let attempts = 0
  const executor = ControlExecutor.makeNoop({
    launch: () => ++attempts === 1 ? Effect.interrupt : Effect.succeed("accepted" as const)
  })
  await Effect.runPromise(
    Effect.gen(function*() {
      const card = yield* admit
      expect(Exit.isFailure(yield* Effect.exit(retry(card)))).toBe(true)
      const runtime = yield* ControlRuntime
      const id = "dispatch:stranded-caller-reservation"
      const nonce = yield* runtime.takeLaunch(id)
      expect(nonce).toBeDefined()
      yield* runtime.finishLaunch(id, "obsolete", false)
      expect(yield* runtime.takeLaunch(id)).toBeUndefined()
      yield* runtime.finishLaunch(id, nonce!, true)
      yield* retry(card)
      expect((yield* runtime.getRun(id)).status).toBe("running")
      expect(attempts).toBe(2)
    }).pipe(Effect.provide(live({ executor })))
  )
})

// R3-Astra-D2-002: a failed run.acceptance commit after executor acceptance never starts a second driver on replay.
it("retries acknowledgment without re-launching when run.acceptance fails after executor acceptance", async () => {
  const filename = join(directory, "ack-failure.sqlite")
  const launched: Array<string> = []
  let failWriteStatusOnce = true
  const base = stack(
    filename,
    101,
    ControlExecutor.makeNoop({
      launch: (input) => Effect.sync(() => launched.push(input.run.runId)).pipe(Effect.as("accepted" as const))
    })
  )
  const faultyRuntime = Layer.effect(
    ControlRuntime,
    Effect.map(ControlRuntime, (runtime) => ({
      ...runtime,
      writeStatus: (runId, fence, status) =>
        Effect.suspend(() => {
          if (status === "running" && failWriteStatusOnce) {
            failWriteStatusOnce = false
            return Effect.fail(new PersistenceError({ operation: "write status", message: "transient ack failure" }))
          }
          return runtime.writeStatus(runId, fence, status)
        })
    }))
  ).pipe(Layer.provideMerge(base))

  const result = await run(
    Layer.provideMerge(Layer.fresh(ControlLive.layer), Layer.merge(faultyRuntime, Registry.layerNoop())),
    Effect.gen(function*() {
      const card = yield* admit
      const first = yield* Effect.exit(retry(card))
      expect(Exit.isFailure(first)).toBe(true)
      expect(launched).toEqual(["dispatch:stranded-caller-reservation"])
      expect((yield* (yield* ControlRuntime).getRun("dispatch:stranded-caller-reservation")).status).toBe("accepted")
      // Replaying the original admission key commits the acknowledgment without calling executor.launch again.
      const replayed = yield* retry(card)
      expect(replayed).toMatchObject({ _tag: "AlreadyApplied", receiptId: "run:stranded" })
      expect(launched).toEqual(["dispatch:stranded-caller-reservation"])
      expect((yield* (yield* ControlRuntime).getRun("dispatch:stranded-caller-reservation")).status).toBe("running")
    })
  )
  if (!Exit.isSuccess(result)) throw new Error(String(result.cause))
})

// R3-Astra-D2-003: reconcile pre-0011 owned accepted rows (launch_pending = 0, handing_nonce = NULL) on upgrade.
it("reconciles pre-0011 legacy owned accepted rows: redispatches stranded handoffs and promotes already-started executions", async () => {
  for (const mode of ["stranded", "started"] as const) {
    const filename = join(directory, `pre-0011-${mode}.sqlite`)
    const planned = await run(stack(filename, 101, ControlExecutor.makeNoop()), admit)
    if (!Exit.isSuccess(planned)) throw new Error("plan failed")
    const card = planned.value

    // Simulate a pre-0011 crash: admit committed under pid 101, old code set launch_pending = 0, handing_nonce = NULL,
    // and process died before writing status = "running".
    const crashed = await run(
      stack(filename, 101, ControlExecutor.makeNoop({ launch: () => Effect.interrupt })),
      retry(card)
    )
    expect(Exit.isFailure(crashed)).toBe(true)
    const seeded = await run(
      stack(filename, 101, ControlExecutor.makeNoop()),
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE control_runs SET launch_pending = 0, handing_nonce = NULL WHERE run_id = ${"dispatch:stranded-caller-reservation"}`
      })
    )
    if (!Exit.isSuccess(seeded)) throw new Error(String(seeded.cause))

    const launched: Array<string> = []
    const peerExecutor = ControlExecutor.makeNoop({
      readExecution: () =>
        Effect.succeed(
          mode === "started"
            ? ({ _tag: "Observed", status: "running" } as const)
            : ({ _tag: "Missing" } as const)
        ),
      launch: (input) => Effect.sync(() => launched.push(input.run.runId)).pipe(Effect.as("accepted" as const))
    })

    // While pid 101 is still alive, a peer never touches the legacy row.
    const guarded = await run(stack(filename, 202, peerExecutor, [101]), retry(card))
    if (!Exit.isSuccess(guarded)) throw new Error(String(guarded.cause))
    expect(launched).toEqual([])

    // Once pid 101 is dead, replay reconciles via durable execution evidence.
    const recovered = await run(
      stack(filename, 202, peerExecutor),
      Effect.gen(function*() {
        const receipt = yield* retry(card)
        const status = (yield* (yield* ControlRuntime).getRun("dispatch:stranded-caller-reservation")).status
        return { receipt, status }
      })
    )
    if (!Exit.isSuccess(recovered)) throw new Error(String(recovered.cause))
    expect(recovered.value.receipt).toMatchObject({ _tag: "AlreadyApplied", receiptId: "run:stranded" })
    expect(recovered.value.status).toBe("running")
    expect(launched).toEqual(mode === "stranded" ? ["dispatch:stranded-caller-reservation"] : [])
  }
})

it("promotes a launch_pending=1 stranded run without relaunching when durable execution is already observed", async () => {
  const filename = join(directory, "pending-observed.sqlite")
  const planned = await run(stack(filename, 101, ControlExecutor.makeNoop()), admit)
  if (!Exit.isSuccess(planned)) throw new Error("plan failed")
  const card = planned.value

  // Crash during launch so launch_pending remains 1 and handing_nonce is released.
  const crashed = await run(
    stack(filename, 101, ControlExecutor.makeNoop({ launch: () => Effect.interrupt })),
    retry(card)
  )
  expect(Exit.isFailure(crashed)).toBe(true)

  const launched: Array<string> = []
  const peerExecutor = ControlExecutor.makeNoop({
    readExecution: () => Effect.succeed({ _tag: "Observed", status: "running" } as const),
    launch: (input) => Effect.sync(() => launched.push(input.run.runId)).pipe(Effect.as("accepted" as const))
  })
  const recovered = await run(
    stack(filename, 202, peerExecutor),
    Effect.gen(function*() {
      const receipt = yield* retry(card)
      const status = (yield* (yield* ControlRuntime).getRun("dispatch:stranded-caller-reservation")).status
      return { receipt, status }
    })
  )
  if (!Exit.isSuccess(recovered)) throw new Error(String(recovered.cause))
  expect(recovered.value.receipt).toMatchObject({ _tag: "AlreadyApplied", receiptId: "run:stranded" })
  expect(recovered.value.status).toBe("running")
  expect(launched).toEqual([])
})

it("memory ControlRuntime.takeLaunch accepts legacy includeLegacy=true when no pending launch exists", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      expect(yield* runtime.takeLaunch("legacy-run", false)).toBeUndefined()
      const nonce = yield* runtime.takeLaunch("legacy-run", true)
      expect(nonce).toBeDefined()
      yield* runtime.finishLaunch("legacy-run", nonce!, false)
    }).pipe(Effect.provide(live({ executor: ControlExecutor.makeNoop() })))
  )
  expect(result).toBeUndefined()
})

it("releases pending handoff when acknowledging a queued launch fails, and skips observed promotion if launch nonce is already held", async () => {
  // 1. Failing acknowledge on a "pending" launch releases the launch fence via finishLaunch(id, nonce, true).
  const pendingFilename = join(directory, "pending-ack-failure.sqlite")
  let failReleaseOnce = true
  const base = stack(
    pendingFilename,
    101,
    ControlExecutor.makeNoop({ launch: () => Effect.succeed("pending" as const) })
  )
  const faultyRuntime = Layer.effect(
    ControlRuntime,
    Effect.map(ControlRuntime, (runtime) => ({
      ...runtime,
      releasePending: (runId, fence) =>
        Effect.suspend(() => {
          if (failReleaseOnce) {
            failReleaseOnce = false
            return Effect.fail(new PersistenceError({ operation: "release pending", message: "transient failure" }))
          }
          return runtime.releasePending(runId, fence)
        })
    }))
  ).pipe(Layer.provideMerge(base))

  const pendingResult = await run(
    Layer.provideMerge(Layer.fresh(ControlLive.layer), Layer.merge(faultyRuntime, Registry.layerNoop())),
    Effect.gen(function*() {
      const card = yield* admit
      expect(Exit.isFailure(yield* Effect.exit(retry(card)))).toBe(true)
      const runtime = yield* ControlRuntime
      // Fence was released back to pending so retry completes cleanly and releases the owner.
      const receipt = yield* retry(card)
      expect(receipt._tag).toBe("AlreadyApplied")
      const runRow = yield* runtime.getRun("dispatch:stranded-caller-reservation")
      expect(runRow.status).toBe("accepted")
      expect(runRow.ownerId).toBeUndefined()
    })
  )
  if (!Exit.isSuccess(pendingResult)) throw new Error(String(pendingResult.cause))

  // 2. When launch_pending = 1 and another caller holds the launch nonce, observed promotion exits cleanly without double-ack.
  const filename = join(directory, "pending-observed-contended.sqlite")
  const planned = await run(stack(filename, 101, ControlExecutor.makeNoop()), admit)
  if (!Exit.isSuccess(planned)) throw new Error("plan failed")
  const card = planned.value
  const crashed = await run(
    stack(filename, 101, ControlExecutor.makeNoop({ launch: () => Effect.interrupt })),
    retry(card)
  )
  expect(Exit.isFailure(crashed)).toBe(true)

  const peerExecutor = ControlExecutor.makeNoop({
    readExecution: () => Effect.succeed({ _tag: "Observed", status: "running" } as const)
  })
  const contendedBase = stack(filename, 202, peerExecutor)
  const contendedRuntime = Layer.effect(
    ControlRuntime,
    Effect.map(ControlRuntime, (runtime) => ({
      ...runtime,
      takeLaunch: () => Effect.succeed(undefined)
    }))
  ).pipe(Layer.provideMerge(contendedBase))
  const contended = await run(
    Layer.provideMerge(Layer.fresh(ControlLive.layer), Layer.merge(contendedRuntime, Registry.layerNoop())),
    Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const receipt = yield* retry(card)
      expect(receipt._tag).toBe("AlreadyApplied")
      // Status remains accepted because takeLaunch returned undefined while held.
      expect((yield* runtime.getRun("dispatch:stranded-caller-reservation")).status).toBe("accepted")
    })
  )
  if (!Exit.isSuccess(contended)) throw new Error(String(contended.cause))
})
