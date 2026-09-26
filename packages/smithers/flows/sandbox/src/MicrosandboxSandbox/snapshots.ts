/**
 * Named Microsandbox disk snapshots: capture a prepared machine, ask whether
 * one exists, and prune a family down to its newest members.
 *
 * A snapshot is the machine's whole root disk. A machine booted from it with
 * the provider's `snapshot` option starts with everything the captured
 * machine had installed, so an expensive preparation runs once per snapshot
 * rather than once per machine.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import { attemptIn } from "../internal/attempt.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Sdk } from "./Sdk.ts"

const attempt = attemptIn("microsandbox")

/** How long the captured machine's graceful stop may take. */
const defaultStopTimeoutMs = 30_000

const isMissingSnapshot = (cause: unknown): boolean =>
  /\[SnapshotNotFound\]/.test(cause instanceof Error ? cause.message : String(cause))

/**
 * What {@link captureSnapshot} captures and names.
 *
 * @category models
 * @since 1.0.0
 */
export interface CaptureOptions {
  /** The injected Microsandbox SDK module. */
  readonly sdk: Sdk
  /** The machine's Microsandbox name (a session's `remoteId`). */
  readonly machine: string
  /** The snapshot's name. */
  readonly name: string
  /** How long the machine's graceful stop may take. Default 30000. */
  readonly stopTimeoutMs?: number | undefined
}

/**
 * Stops a machine, captures its root disk as the named snapshot, and removes
 * the machine. The machine is removed whether or not the capture succeeded.
 *
 * @category snapshots
 * @since 1.0.0
 */
export const captureSnapshot = (options: CaptureOptions): Effect.Effect<void, ProviderError> =>
  attempt(
    async () => {
      const handle = await options.sdk.Sandbox.get(options.machine)
      try {
        if (handle.status === "running") {
          await handle.stop()
        }
        await handle.snapshot(options.name)
      } finally {
        await handle.destroy({ timeoutMs: options.stopTimeoutMs ?? defaultStopTimeoutMs, force: true })
      }
    },
    "unavailable",
    `the microVM ${options.machine} could not be captured as ${options.name}`
  )

/**
 * Whether a snapshot of that name exists.
 *
 * @category snapshots
 * @since 1.0.0
 */
export const hasSnapshot = (sdk: Sdk, name: string): Effect.Effect<boolean, ProviderError> =>
  Effect.tryPromise({
    try: () => sdk.Snapshot.get(name),
    catch: (cause) => cause
  }).pipe(
    Effect.as(true),
    Effect.catch((cause) =>
      isMissingSnapshot(cause)
        ? Effect.succeed(false)
        : Effect.fail(
          new ProviderError({ code: "unavailable", message: `microsandbox: snapshot ${name} could not be read`, cause })
        )
    )
  )

/**
 * Removes the snapshots whose names start with `prefix`, except the `keep`
 * newest and any named in `retain` (snapshots a machine is about to boot
 * from), and returns the removed names.
 *
 * @category snapshots
 * @since 1.0.0
 */
export const pruneSnapshots = (
  sdk: Sdk,
  prefix: string,
  keep: number,
  retain: ReadonlyArray<string> = []
): Effect.Effect<ReadonlyArray<string>, ProviderError> =>
  attempt(
    async () => {
      const family = (await sdk.Snapshot.list())
        .filter((entry) => entry.name !== null && entry.name.startsWith(prefix))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      const removed: Array<string> = []
      for (const entry of family.slice(Math.max(0, keep))) {
        if (retain.includes(entry.name!)) continue
        await sdk.Snapshot.remove(entry.name!, { force: true })
        removed.push(entry.name!)
      }
      return removed
    },
    "unavailable",
    `the snapshots named ${prefix}* could not be pruned`
  )

/**
 * Removes the named snapshot; one that is already gone is not an error.
 *
 * @category snapshots
 * @since 1.0.0
 */
export const removeSnapshot = (sdk: Sdk, name: string): Effect.Effect<void, ProviderError> =>
  Effect.tryPromise({ try: () => sdk.Snapshot.remove(name, { force: true }), catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      isMissingSnapshot(cause)
        ? Effect.void
        : Effect.fail(
          new ProviderError({
            code: "unavailable",
            message: `microsandbox: snapshot ${name} could not be removed`,
            cause
          })
        )
    )
  )
