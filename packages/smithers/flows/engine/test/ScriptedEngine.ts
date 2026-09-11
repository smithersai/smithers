import { Effect } from "effect"
import { FlowEngine } from "../src/index.ts"

/**
 * A scripted `Encoded` driver: every required member defaults to a no-op, so
 * a test states only the members its scenario drives.
 */
export const scriptedEngine = (overrides: Partial<FlowEngine.Encoded>) =>
  FlowEngine.makeUnsafe({
    register: () => Effect.void,
    execute: () => Effect.die("not used"),
    poll: () => Effect.succeedNone,
    interrupt: () => Effect.void,
    interruptUnsafe: () => Effect.void,
    resume: () => Effect.void,
    actionExecute: () => Effect.die("not used"),
    deferredResult: () => Effect.succeedNone,
    deferredDone: () => Effect.void,
    scheduleClock: () => Effect.void,
    ...overrides
  })
