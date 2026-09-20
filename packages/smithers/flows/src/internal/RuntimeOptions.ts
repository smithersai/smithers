/** Runtime configuration shared by injected and native hosts.
 * @since 1.0.0
 */
import type * as EngineStore from "@smthrs/engine-store/EngineStore"
import type { Ownership, RunStore } from "@smthrs/run-store"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Configuration for the injected runtime.
 *
 * `isAlive` is intentionally required, and a stub is not an answer: a check
 * that returns `false` without asking says "that owner is gone" about an owner
 * it never looked at, and the engine steals runs out of live processes on the
 * strength of it. A single-machine host passes `Ownership.sameHostPidProbe`,
 * which asks this machine's process table; a multi-process deployment answers
 * from its supervisor or lease system instead.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Options {
  /** SQLite database filename. Its parent directory is created recursively. */
  readonly filename: string
  /** Workspace whose file actions may read or mutate. */
  readonly workspaceRoot: string
  /** Stable identity of this engine host. */
  readonly owner: {
    readonly hostId: string
  }
  /**
   * Whether a previously recorded owner is still alive.
   *
   * Takes the claim context as well as the owner, so a probe can tell whether
   * the recorded pid names a process on the machine it is running on. A
   * one-argument check that ignores the context still satisfies this.
   */
  readonly isAlive: Ownership.LivenessCheck
  /** Routes shared-store runs to the host configured for their workspace. */
  readonly canExecute?: ((row: RunStore.RunRow) => Effect.Effect<boolean>) | undefined
  /**
   * Records, for a host that keeps one, that the engine has asked a parked
   * execution to resume — a durable clock fired, a durable deferred
   * completed, or a child settled under a parent that parked on it.
   *
   * A control plane that refuses to re-enter a parked run nobody asked for
   * reads the record to tell an engine wake from its own heartbeat sweep.
   *
   * @since 1.0.0-rc.0
   */
  readonly requestResume?:
    | ((executionId: string, reason: EngineStore.RequestedResumeReason) => Effect.Effect<void>)
    | undefined
}

/**
 * Stable failure raised synchronously for invalid runtime construction input.
 *
 * @since 1.0.0
 * @category errors
 */
export class RuntimeConfigurationError extends Schema.TaggedError<RuntimeConfigurationError>()(
  "@smthrs/flows/RuntimeConfigurationError",
  {
    code: Schema.Literal("invalid_runtime_configuration"),
    field: Schema.String,
    message: Schema.String
  }
) {}

const invalidConfiguration = (field: string, message: string): RuntimeConfigurationError =>
  new RuntimeConfigurationError({ code: "invalid_runtime_configuration", field, message })

/**
 * Decodes one named option and reports the option that was wrong.
 *
 * A single struct decode would answer "options" for every refusal, and the
 * whole point of {@link RuntimeConfigurationError.field} is that an embedder
 * can tell an empty `filename` from an empty `owner.hostId` without reading
 * prose. Decoding field by field makes the name come from the call site rather
 * than from walking a schema issue tree.
 * @since 1.0.0
 * @private
 */
export const decodeField = <A>(
  field: string,
  schema: Schema.Codec<A>,
  value: unknown,
  expectation: string,
  label = "Runtime"
): A => {
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch {
    throw invalidConfiguration(field, `${label} ${field} ${expectation}`)
  }
}

const nonEmpty = "must be a non-empty string"

/** Captures immutable options; paths resolve through the injected Path service.
 * @since 1.0.0
 * @private
 */
export const validate = (options: Options, label = "Runtime"): Options => {
  const filename = decodeField("filename", Schema.NonEmptyString, options.filename, nonEmpty, label)
  const workspaceRoot = decodeField("workspaceRoot", Schema.NonEmptyString, options.workspaceRoot, nonEmpty, label)
  // A JavaScript caller can omit `owner` entirely, so the field is read off a
  // possibly-absent record rather than dereferenced.
  const owner = options.owner as { readonly hostId?: unknown } | undefined
  const hostId = decodeField("owner.hostId", Schema.NonEmptyString, owner?.hostId, nonEmpty, label)
  const isAlive = options.isAlive
  if (typeof isAlive !== "function") {
    throw invalidConfiguration("isAlive", `${label} isAlive must be a function`)
  }
  const canExecute = options.canExecute
  if (canExecute !== undefined && typeof canExecute !== "function") {
    throw invalidConfiguration("canExecute", `${label} canExecute must be a function when supplied`)
  }
  const requestResume = options.requestResume
  if (requestResume !== undefined && typeof requestResume !== "function") {
    throw invalidConfiguration("requestResume", `${label} requestResume must be a function when supplied`)
  }
  return Object.freeze({
    filename,
    workspaceRoot,
    owner: Object.freeze({ hostId }),
    isAlive,
    canExecute,
    requestResume
  })
}
