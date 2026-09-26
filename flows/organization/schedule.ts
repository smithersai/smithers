/**
 * The host's scheduler: the durable trigger store in the state directory
 * (`triggers.db`) and `@smthrs/triggers`' scheduler over it, launching each
 * occurrence as an organization run through the host's own control plane.
 *
 * Schedules are cron expressions in an IANA zone, so a weekly slot keeps its
 * wall time across daylight saving; an occurrence's run is keyed by the
 * trigger and the occurrence, so a restart or a second poll joins the run it
 * started. At startup the host registers `organization-meetings:plan`, which
 * plans the weekly one-on-ones every day at 06:00 UTC; the plan registers each
 * role's prepare, open, and follow-up triggers (`meetings.ts`).
 */
import { Control } from "@smthrs/control"
import { Duration, Effect, Layer } from "effect"
import { join } from "node:path"
import * as Scheduler from "../../packages/smithers/agent/triggers/src/Scheduler.ts"
import * as SqlTriggerStore from "../../packages/smithers/agent/triggers/src/SqlTriggerStore.ts"
import * as Trigger from "../../packages/smithers/agent/triggers/src/Trigger.ts"
import { TriggerError } from "../../packages/smithers/agent/triggers/src/TriggerError.ts"
import * as TriggerStore from "../../packages/smithers/agent/triggers/src/TriggerStore.ts"
import type * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import { type Control as ControlPort, ControlRefused, operations } from "./client.ts"

/** The trigger store's database in the state directory. */
export const database = (stateDir: string) => join(stateDir, "triggers.db")

/** The durable trigger store over the state directory's `triggers.db`. */
export const store = (platform: NativeControl.Platform, stateDir: string) =>
  SqlTriggerStore.layer.pipe(Layer.provide(platform.database(database(stateDir))), Layer.orDie)

/** The host's control plane as the port the client operations use. */
const port = (control: Control.Control["Service"]): ControlPort => {
  const methods = {
    Plan: control.plan,
    Approve: control.approve,
    Run: control.run,
    List: control.list,
    Signal: control.signal
  } as const
  return {
    call: (tag, payload) => {
      const method = methods[tag] as (input: unknown) => Effect.Effect<unknown, { _tag: string; message: string }>
      return Effect.runPromise(
        method(payload).pipe(Effect.mapError((error) => new ControlRefused(error._tag, tag, error.message)))
      )
    }
  }
}

const failed = (message: string) => (cause: unknown) => new TriggerError({ code: "runner", message, cause })

/**
 * Launches a scheduled occurrence the way the CLI starts a run (plan,
 * approve, run, each keyed by the occurrence), and reads its state back.
 */
export const runner = Layer.effect(Scheduler.Runner)(Effect.gen(function*() {
  const control = yield* Control.Control
  const ops = operations(port(control))
  return Scheduler.makeRunner({
    start: (input) =>
      Effect.tryPromise({
        try: async () => (await ops.start(input.flowId, input.input, input.idempotencyKey)).runId,
        catch: failed(`the host could not start ${input.flowId}`)
      }),
    inspect: (runId) =>
      Effect.tryPromise({
        try: async () => {
          const [view] = await ops.runs({ runId })
          if (view === undefined) return "missing" as const
          return view.status === "completed" || view.status === "failed" || view.status === "cancelled"
            ? view.status
            : "active" as const
        },
        catch: failed(`the host could not inspect run ${runId}`)
      }),
    cancel: (runId) =>
      control.cancel({ runId, idempotencyKey: `trigger-cancel:${runId}` }).pipe(
        Effect.asVoid,
        Effect.mapError(failed(`the host could not cancel run ${runId}`))
      )
  })
}))

/** The daily meetings plan trigger. */
export const planTrigger = {
  id: "organization-meetings:plan",
  flowId: "organization/meetings-plan",
  input: {},
  cron: "0 6 * * *",
  timezone: "UTC",
  overlap: "skip",
  catchUp: "one",
  maxCatchUp: 1,
  enabled: true
} as const

/** Registers the daily plan trigger, then runs the scheduler until the host stops. */
export const layer = (options: { readonly pollInterval?: Duration.Input | undefined } = {}) =>
  Layer.effectDiscard(Effect.gen(function*() {
    const triggers = yield* TriggerStore.TriggerStore
    yield* triggers.register(yield* Trigger.make(planTrigger))
  })).pipe(
    Layer.provideMerge(Scheduler.layer({ pollInterval: options.pollInterval ?? "15 seconds", host: "organization" })),
    Layer.provide(runner),
    Layer.orDie
  )
