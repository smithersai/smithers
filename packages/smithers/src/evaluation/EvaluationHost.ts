/** Invocation-local host selection for durable evaluations.
 * @since 1.0.0
 */

import { NodeRuntime } from "@smthrs/platform-node"
import { Context, Effect } from "effect"
import type { UnknownError } from "effect/Cause"

/**
 * The embedding host's runtime identity. Supplying it never changes process globals.
 * @category services
 * @since 1.0.0
 */
export const Host = Context.Reference<{ readonly bun: boolean }>("@smthrs/cli/EvaluationHost", {
  defaultValue: () => ({ bun: "Bun" in globalThis })
})

/**
 * Loads the real platform adapter selected by the current host.
 * Bun's SQLite driver stays lazy until that adapter opens a database.
 * @category constructors
 * @since 1.0.0
 */
export const runtime: Effect.Effect<typeof NodeRuntime, UnknownError> = Effect.flatMap(Host, (host) =>
  host.bun
    ? Effect.tryPromise(() => import("@smthrs/platform-bun").then((platform) => platform.BunRuntime))
    : Effect.succeed(NodeRuntime))
