import * as Control from "@smthrs/control/Control"
import { Unavailable } from "@smthrs/control/ControlError"
import * as ControlLive from "@smthrs/control/ControlLive"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as SqlTriggerStore from "@smthrs/triggers/SqlTriggerStore"
import * as Trigger from "@smthrs/triggers/Trigger"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Effect, Layer, Option } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"
import { databaseLayer } from "../src/operator/Store.ts"
import * as TriggerPlans from "../src/operator/TriggerPlans.ts"

const roots: Array<string> = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-trigger-plans-"))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const controlLayer = (root: string) => {
  const engine = NodeControl.engineDurable(root)
  return ControlLive.layer.pipe(Layer.provide([
    engine.runtime,
    engine.journal,
    Registry.layerNoop(),
    NotificationQueue.layerNoop()
  ]))
}
const run = <A, E>(root: string, effect: Effect.Effect<A, E, Control.Control | Scheduler.Runner>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TriggerPlans.layer(root).pipe(Layer.provideMerge(controlLayer(root))))))
const input = { flowId: "system/test", input: { suite: "scheduled" }, idempotencyKey: "daily:1970-01-01T00:00:01.000Z" }
const start = Effect.gen(function*() {
  return yield* (yield* Scheduler.Runner).start(input)
})
const state = (handle: string) =>
  Effect.gen(function*() {
    return yield* (yield* Scheduler.Runner).inspect(handle)
  })
const active = (handle: string) => Effect.map(state(handle), (current) => current === "active")
const rows = (root: string, query: string) => {
  const db = new DatabaseSync(join(root, ".flows", "control.db"), { readOnly: true })
  try {
    return db.prepare(query).all()
  } finally {
    db.close()
  }
}

describe("durable trigger approval plans", () => {
  it("keeps one exact approval card beyond the old retry limit and resumes after reopening SQLite", async () => {
    const root = fixture()
    const handle = await run(root, start)
    const pending = await TriggerPlans.inspect(root, handle)
    expect(pending).toMatchObject({ status: "waiting-approval", runId: null, idempotencyKey: input.idempotencyKey })
    expect(pending?.plan.approval.target).toMatchObject({ _tag: "Plan", planId: pending?.plan.planId })
    await run(
      root,
      Effect.gen(function*() {
        for (let attempt = 0; attempt < 12; attempt++) expect(yield* active(handle)).toBe(true)
      })
    )
    expect(rows(root, "SELECT * FROM control_runs")).toHaveLength(0)
    expect(await run(root, start)).toBe(handle)
    expect(await TriggerPlans.inspect(root, handle)).toEqual(pending)
    expect(rows(root, "SELECT * FROM control_plans")).toHaveLength(1)
    await run(
      root,
      Effect.gen(function*() {
        const control = yield* Control.Control
        yield* control.approve(pending!.plan.approval)
      })
    )
    expect(await run(root, active(handle))).toBe(true)
    const running = await TriggerPlans.inspect(root, handle)
    expect(running).toMatchObject({ status: "running", plan: pending!.plan })
    expect(running?.runId).toEqual(expect.any(String))
    expect(await run(root, active(handle))).toBe(true)
    expect(rows(root, "SELECT * FROM control_runs")).toHaveLength(1)
    await run(
      root,
      Effect.gen(function*() {
        yield* (yield* Scheduler.Runner).cancel(handle)
      })
    )
    expect(await run(root, state(handle))).toBe("cancelled")
    expect(await TriggerPlans.inspect(root, handle)).toMatchObject({ status: "cancelled", runId: running!.runId })
    expect(await TriggerPlans.inspect(root, "run-not-a-trigger-plan")).toBeNull()
  })

  it("recovers Control commits on either side of the adapter's persistence boundary", async () => {
    const root = fixture()
    const original = await run(
      root,
      Effect.gen(function*() {
        return yield* (yield* Control.Control).plan(input)
      })
    )
    const handle = await run(root, start)
    expect((await TriggerPlans.inspect(root, handle))?.plan).toEqual(original)
    const receipt = await run(
      root,
      Effect.gen(function*() {
        const control = yield* Control.Control
        yield* control.approve(original.approval)
        return yield* control.run({
          _tag: "Plan",
          planId: original.planId,
          digest: original.digest,
          envelope: original.envelope,
          idempotencyKey: input.idempotencyKey
        })
      })
    )
    expect(receipt._tag).toBe("Accepted")
    expect(await run(root, active(handle))).toBe(true)
    expect((await TriggerPlans.inspect(root, handle))?.runId).toBe("runId" in receipt ? receipt.runId : undefined)
    expect(rows(root, "SELECT * FROM control_plans")).toHaveLength(1)
    expect(rows(root, "SELECT * FROM control_runs")).toHaveLength(1)
  })

  it("reconciles cancellation after a crash between Control acceptance and recording the run id", async () => {
    const root = fixture()
    const handle = await run(root, start)
    const pending = await TriggerPlans.inspect(root, handle)
    await run(
      root,
      Effect.gen(function*() {
        yield* (yield* Control.Control).approve(pending!.plan.approval)
      })
    )
    const crashAfterAcceptance = Layer.effect(
      Control.Control,
      Effect.gen(function*() {
        const control = yield* Control.Control
        return Control.make({
          ...control,
          run: (request) => control.run(request).pipe(Effect.andThen(Effect.interrupt))
        })
      })
    ).pipe(Layer.provide(controlLayer(root)))
    const exit = await Effect.runPromiseExit(
      active(handle).pipe(Effect.provide(TriggerPlans.layer(root).pipe(Layer.provide(crashAfterAcceptance))))
    )
    expect(exit._tag).toBe("Failure")
    expect(rows(root, "SELECT * FROM control_runs")).toHaveLength(1)
    expect(await TriggerPlans.inspect(root, handle)).toMatchObject({ status: "launching", runId: null })
    await run(
      root,
      Effect.gen(function*() {
        const runner = yield* Scheduler.Runner
        for (let attempt = 0; attempt < 2; attempt++) {
          const error = yield* Effect.flip(runner.cancel(handle))
          expect(error.message).toContain("awaiting cancellation reconciliation")
        }
      })
    )
    expect(await TriggerPlans.inspect(root, handle)).toMatchObject({ status: "cancelling", runId: null })
    const unavailable = (operation: "run" | "cancel") =>
      Layer.effect(
        Control.Control,
        Effect.gen(function*() {
          const control = yield* Control.Control
          return Control.make({
            ...control,
            [operation]: () => Effect.fail(new Unavailable({ feature: operation, ticket: "fixture" }))
          })
        })
      ).pipe(Layer.provide(controlLayer(root)))
    for (const operation of ["run", "cancel"] as const) {
      expect(
        await Effect.runPromise(
          active(handle).pipe(Effect.provide(TriggerPlans.layer(root).pipe(Layer.provide(unavailable(operation)))))
        )
      ).toBe(true)
      expect(await TriggerPlans.inspect(root, handle)).toMatchObject({
        status: "cancelling",
        runId: operation === "run" ? null : expect.any(String)
      })
    }
    expect(await run(root, state(handle))).toBe("cancelled")
    expect(await TriggerPlans.inspect(root, handle)).toMatchObject({
      status: "cancelled",
      runId: expect.any(String)
    })
    expect(
      await run(
        root,
        Effect.gen(function*() {
          return yield* (yield* Control.Control).list({ _tag: "runs" })
        })
      )
    ).toMatchObject({ _tag: "runs", items: [{ status: "cancelled" }] })
    expect(await run(root, active(handle))).toBe(false)
    expect(rows(root, "SELECT * FROM control_runs")).toHaveLength(1)
  })

  it.each(["approved", "pending", "denied"] as const)(
    "honors cancellation during a launch attempt for a %s plan",
    async (approval) => {
      const root = fixture()
      const handle = await run(root, start)
      const pending = await TriggerPlans.inspect(root, handle)
      await run(
        root,
        Effect.gen(function*() {
          const control = yield* Control.Control
          if (approval === "approved") yield* control.approve(pending!.plan.approval)
          if (approval === "denied") yield* control.deny(pending!.plan.approval)
        })
      )
      const cancelDuringLaunch = Layer.effect(
        Control.Control,
        Effect.gen(function*() {
          const control = yield* Control.Control
          return Control.make({
            ...control,
            run: (request) =>
              Effect.gen(function*() {
                expect(yield* Effect.promise(() => TriggerPlans.inspect(root, handle))).toMatchObject({
                  status: "launching",
                  runId: null
                })
                yield* Effect.promise(() =>
                  run(
                    root,
                    Effect.gen(function*() {
                      const error = yield* Effect.flip((yield* Scheduler.Runner).cancel(handle))
                      expect(error.message).toContain("awaiting cancellation reconciliation")
                    })
                  )
                )
                expect(yield* Effect.promise(() => TriggerPlans.inspect(root, handle))).toMatchObject({
                  status: "cancelling",
                  runId: null
                })
                return yield* control.run(request)
              })
          })
        })
      ).pipe(Layer.provide(controlLayer(root)))
      expect(
        await Effect.runPromise(
          state(handle).pipe(Effect.provide(TriggerPlans.layer(root).pipe(Layer.provide(cancelDuringLaunch))))
        )
      ).toBe("cancelled")
      expect(await TriggerPlans.inspect(root, handle)).toMatchObject({
        status: "cancelled",
        runId: approval === "approved" ? expect.any(String) : null
      })
      expect(
        await run(
          root,
          Effect.gen(function*() {
            return yield* (yield* Control.Control).list({ _tag: "runs" })
          })
        )
      ).toMatchObject({ _tag: "runs", items: approval === "approved" ? [{ status: "cancelled" }] : [] })
      expect(await run(root, active(handle))).toBe(false)
    }
  )

  it.each([false, true])("does not launch cancelled or denied pending plans (polled: %s)", async (polled) => {
    const root = fixture()
    const handle = await run(root, start)
    const pending = await TriggerPlans.inspect(root, handle)
    if (polled) expect(await run(root, active(handle))).toBe(true)
    await run(
      root,
      Effect.gen(function*() {
        yield* (yield* Scheduler.Runner).cancel(handle)
        yield* (yield* Control.Control).approve(pending!.plan.approval)
      })
    )
    expect(await run(root, active(handle))).toBe(false)
    expect(rows(root, "SELECT * FROM control_runs")).toHaveLength(0)
    const other = await run(
      root,
      Effect.gen(function*() {
        return yield* (yield* Scheduler.Runner).start({ ...input, idempotencyKey: "denied" })
      })
    )
    const denied = await TriggerPlans.inspect(root, other)
    await run(
      root,
      Effect.gen(function*() {
        yield* (yield* Control.Control).deny(denied!.plan.approval)
      })
    )
    expect(await run(root, active(other))).toBe(false)
    expect(await TriggerPlans.inspect(root, other)).toMatchObject({ status: "failed" })
    expect(rows(root, "SELECT * FROM control_runs")).toHaveLength(0)
  })

  it("recovers a waiting scheduled occurrence after the scheduler scope closes", async () => {
    const root = fixture()
    const schedulerLayer = SqlTriggerStore.layer.pipe(Layer.provide(databaseLayer(root)))
    const tick = (register: boolean) =>
      Effect.scoped(Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        if (register) {
          yield* store.register(
            yield* Trigger.make({
              id: "daily",
              flowId: "system/test",
              input: input.input,
              cron: "0 0 * * *",
              enabled: true
            })
          )
          yield* store.setPending({ triggerId: "daily", occurrence: 1000 })
        }
        yield* (yield* Scheduler.make()).runOnce
        return Option.getOrNull(yield* store.activeRun("daily"))
      })).pipe(Effect.provide(schedulerLayer))
    const handle = await run(root, tick(true))
    expect(handle).toBe(`trigger-plan:${input.idempotencyKey}`)
    const pending = await TriggerPlans.inspect(root, handle!)
    expect(pending?.status).toBe("waiting-approval")
    expect(await run(root, tick(false))).toBe(handle)
    await run(
      root,
      Effect.gen(function*() {
        yield* (yield* Control.Control).approve(pending!.plan.approval)
      })
    )
    expect(await run(root, tick(false))).toBe(handle)
    expect(await TriggerPlans.inspect(root, handle!)).toMatchObject({ status: "running", plan: pending!.plan })
    expect(rows(root, "SELECT * FROM control_runs")).toHaveLength(1)
  })

  it.each(["failed", "cancelled"] as const)(
    "preserves %s status and leaves missing run records visibly unresolved",
    async (terminalStatus) => {
      const root = fixture()
      const handle = await run(root, start)
      const pending = await TriggerPlans.inspect(root, handle)
      await run(
        root,
        Effect.gen(function*() {
          yield* (yield* Control.Control).approve(pending!.plan.approval)
          yield* active(handle)
        })
      )
      const withStatus = (status: "failed" | "cancelled" | undefined) => {
        const projected = Layer.effect(
          Control.Control,
          Effect.gen(function*() {
            const control = yield* Control.Control
            return Control.make({
              ...control,
              list: (request) =>
                control.list(request).pipe(Effect.map((response) =>
                  response._tag === "runs"
                    ? {
                      ...response,
                      items: status === undefined ? [] : response.items.map((run) => ({ ...run, status }))
                    }
                    : response
                ))
            })
          })
        ).pipe(Layer.provide(controlLayer(root)))
        return Effect.runPromise(
          state(handle).pipe(Effect.provide(TriggerPlans.layer(root).pipe(Layer.provide(projected))))
        )
      }
      expect(await withStatus(undefined)).toBe("active")
      expect(await TriggerPlans.inspect(root, handle)).toMatchObject({
        status: "running",
        error: expect.stringContaining("no durable record")
      })
      expect(await withStatus(terminalStatus)).toBe(terminalStatus)
      expect(await TriggerPlans.inspect(root, handle)).toMatchObject({ status: terminalStatus, error: null })
    }
  )

  it("retains cancellation intent when Control temporarily cannot cancel the accepted run", async () => {
    const root = fixture()
    const handle = await run(root, start)
    const pending = await TriggerPlans.inspect(root, handle)
    await run(
      root,
      Effect.gen(function*() {
        yield* (yield* Control.Control).approve(pending!.plan.approval)
        yield* active(handle)
      })
    )
    const unavailable = Layer.effect(
      Control.Control,
      Effect.gen(function*() {
        const control = yield* Control.Control
        return Control.make({
          ...control,
          cancel: () => Effect.fail(new Unavailable({ feature: "cancel", ticket: "fixture" }))
        })
      })
    ).pipe(Layer.provide(controlLayer(root)))
    await expect(Effect.runPromise(
      Effect.gen(function*() {
        yield* (yield* Scheduler.Runner).cancel(handle)
      }).pipe(Effect.provide(TriggerPlans.layer(root).pipe(Layer.provide(unavailable))))
    )).rejects.toThrow("cancel")
    expect(await TriggerPlans.inspect(root, handle)).toMatchObject({ status: "cancelled" })
    expect(await run(root, active(handle))).toBe(false)
    const response = await run(
      root,
      Effect.gen(function*() {
        return yield* (yield* Control.Control).list({ _tag: "runs" })
      })
    )
    expect(response).toMatchObject({ _tag: "runs", items: [{ status: "cancelled" }] })
  })
})
