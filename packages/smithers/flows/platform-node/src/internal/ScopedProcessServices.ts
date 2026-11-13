/**
 * Native dependencies for one transient scope, with Effect-local fault injection.
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import { processLifecycle } from "../ProcessReaper.ts"
import * as PipedProcess from "./PipedProcess.ts"
import { targetPidOf } from "./ProcessSupervisor.ts"

/**
 * The real lifecycle and pipes; overrides affect only the requesting Effect.
 * @private
 * @since 1.0.0
 */
export const Services = Context.Reference("@smthrs/platform-node/ScopedProcess/Services", {
  defaultValue: () => ({
    lifecycle: processLifecycle,
    spawn: PipedProcess.spawn,
    targetPid: targetPidOf
  })
})
