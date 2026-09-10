import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { fileURLToPath } from "node:url"
import type * as FlowInvoker from "../src/FlowInvoker.ts"
import type * as Route from "../src/Route.ts"

export const visibleModule = fileURLToPath(new URL("./fixtures/command/visible.ts", import.meta.url))
export const specialModule = fileURLToPath(new URL("./fixtures/command/special%23flow.ts", import.meta.url))
export const invalidModule = fileURLToPath(new URL("./fixtures/command/invalid.ts", import.meta.url))
export const recordedModule = fileURLToPath(new URL("./fixtures/command/recorded.ts", import.meta.url))
export const refinedModule = fileURLToPath(new URL("./fixtures/command/refined.ts", import.meta.url))

/** How many times the import-recording fixture has been evaluated. */
export const recordedImports = (): number => (globalThis as { fsRecordedImports?: number }).fsRecordedImports ?? 0

export const makeRoute = (
  name: string,
  sourcePath = visibleModule,
  overrides: Partial<Route.Route> = {}
): Route.Route => ({
  name,
  segments: name.split("/"),
  kind: "module",
  sourcePath,
  description: Option.some(`${name} description`),
  input: new Descriptor.SchemaRefModule({ path: sourcePath, field: "input" }),
  output: new Descriptor.SchemaRefModule({ path: sourcePath, field: "output" }),
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  modelInvocable: true,
  placement: Option.none(),
  ui: Option.none(),
  ...overrides
})

/**
 * An invoker that blocks until released, recording when the invocation starts
 * and when its interruption finalizer runs, so cancellation tests can observe
 * an in-flight fiber without real timers.
 */
export const latchedInvoke = (): {
  readonly invoke: FlowInvoker.Service["invoke"]
  readonly started: Promise<void>
  readonly finalized: Promise<void>
  readonly release: () => void
} => {
  let begin!: () => void
  let finish!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    begin = resolve
  })
  const finalized = new Promise<void>((resolve) => {
    finish = resolve
  })
  const gate = new Promise<{ readonly accepted: boolean; readonly number: number }>((resolve) => {
    release = () => resolve({ accepted: true, number: 0 })
  })
  return {
    invoke: () =>
      Effect.promise(() => {
        begin()
        return gate
      }).pipe(Effect.onInterrupt(() => Effect.sync(finish))),
    started,
    finalized,
    release
  }
}
