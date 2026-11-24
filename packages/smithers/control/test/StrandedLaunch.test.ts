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
