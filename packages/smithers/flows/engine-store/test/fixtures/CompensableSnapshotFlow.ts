import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { opaqueHandlerBody } from "./OpaqueHandlerBody.ts"

/**
 * The flow and compensable action of `CompensableSnapshotRestart`, declared
 * once for its in-process cases and for the child process its hard-kill case
 * SIGKILLs. Declared in its own module because the child is a process
 * entrypoint, and importing a declaration from there would start an engine
 * inside the test worker.
 */
export const RestartFlow = Flow.make("CompensableSnapshotRestart/Flow", {
  payload: {},
  success: Schema.String,
  error: Schema.String,
  body: opaqueHandlerBody
})

/** The host both processes name, so the survivor's pid probe can see that the child is gone. */
export const hostId = "compensable-restart-host"

export const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "engine-pre-image" as never, changeId: "engine-pre-image" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/** A host boundary whose handles are only meaningful if carried across processes. */
export const recordingBoundary = (
  events: Array<string>,
  handleFor: (count: number) => unknown = (count) => `handle-${count}`
) => {
  let taken = 0
  return FlowEngine.SnapshotBoundary.of({
    snapshot: ({ attempt }) =>
      Effect.sync(() => {
        const handle = handleFor(++taken)
        events.push(`snapshot:${attempt}:${String(handle)}`)
        return handle
      }),
    restore: (handle, { attempt }) => Effect.sync(() => events.push(`restore:${attempt}:${String(handle)}`)),
    diff: (handle, { attempt }) =>
      Effect.sync(() => {
        events.push(`diff:${attempt}:${String(handle)}`)
        return ""
      })
  })
}

export type Step = "fail" | "hang" | "succeed"

/**
 * Each dispatch follows the next scripted step. `hang` runs `onHang`, which
 * never settles by default.
 */
export const scriptedAction = (
  name: string,
  script: ReadonlyArray<Step>,
  dispatches: { count: number },
  onHang: Effect.Effect<never> = Effect.never
) =>
  Action.make({
    name,
    success: Schema.String,
    error: Schema.String,
    tier: "compensable",
    retryPolicy: RetryPolicy.make({ initialMs: 10_000, factor: 1, maxMs: 10_000, maxAttempts: 3 }),
    execute: Effect.suspend(() => {
      const step = script[dispatches.count++] ?? "succeed"
      return step === "fail" ? Effect.fail("boom") : step === "hang" ? onHang : Effect.succeed("done")
    })
  })
