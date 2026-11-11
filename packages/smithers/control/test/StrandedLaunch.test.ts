/**
 * A run admitted by a process that died before its executor took the launch.
 *
 * `Control.run` commits the run row and its idempotency receipt, then hands the
 * run to the executor outside that transaction. A crash in between left the run
 * `accepted` under a dead owner, and the client's retry with the same key only
 * read the recorded receipt back, so nothing ever launched it (#2175).
 */
import { Registry } from "@smthrs/registry"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { Control } from "../src/Control.vibe"
import { PersistenceError } from "../src/ControlError.vibe"
import * as ControlExecutor from "../src/ControlExecutor.vibe"
import * as ControlLive from "../src/ControlLive.ts"
import { ControlRuntime } from "../src/ControlRuntime.vibe"
import type { PlanCard } from "../src/ControlSchema.vibe"
import { durable, type DurableStack, fileBundle } from "./DurableStack.ts"

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

it("relaunches a run whose admitting process died before the launch when the client retries its key", async () => {
  const filename = join(directory, "stranded.sqlite")
  const planned = await run(stack(filename, 101, ControlExecutor.makeNoop()), admit)
  if (!Exit.isSuccess(planned)) throw new Error("plan failed")
  const card = planned.value

  // The host dies between committing the admission and the executor's launch.
  const crashed = await run(
    stack(filename, 101, ControlExecutor.makeNoop({ launch: () => Effect.die("host died") })),
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
      // is no reason to wait: the first retry launches.
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
  // The retry answers from the recorded receipt, and the run it names starts.
  expect(retried.value.receipt).toMatchObject({ _tag: "AlreadyApplied", receiptId: "run:stranded" })
  expect(retried.value.again).toEqual(retried.value.receipt)
  expect(launched).toEqual([retried.value.runId])
  expect(retried.value.status).toBe("running")
  expect(retried.value.runId).toBe("dispatch:stranded-caller-reservation")
})

it("retries stranded recovery in the same process after the plan read fails", async () => {
  const filename = join(directory, "plan-read-failure.sqlite")
  const planned = await run(stack(filename, 101, ControlExecutor.makeNoop()), admit)
  if (!Exit.isSuccess(planned)) throw new Error("plan failed")
  const card = planned.value
  const crashed = await run(
    stack(filename, 101, ControlExecutor.makeNoop({ launch: () => Effect.die("host died") })),
    retry(card)
  )
  expect(Exit.isFailure(crashed)).toBe(true)

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
