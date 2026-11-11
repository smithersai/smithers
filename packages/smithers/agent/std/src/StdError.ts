/**
 * The single typed error returned by every standard flow handler.
 *
 * @since 1.0.0
 */

import { Schema } from "effect"

/**
 * Stable, model-facing failure codes shared by the standard flows.
 *
 * @category models
 * @since 1.0.0
 */
export const Code = Schema.Literals([
  "stale_read",
  "not_found",
  "not_a_directory",
  "not_a_file",
  "is_directory",
  "binary_file",
  "offset_out_of_range",
  "invalid_pattern",
  "invalid_input",
  "no_match",
  "not_modified",
  "permission_denied",
  "outside_declared_reads",
  "outside_declared_writes",
  "command_failed",
  "request_failed",
  "timeout",
  "rate_limited",
  "provider_unavailable",
  "moved_off",
  "unsupported",
  "unsupported_content_type",
  "response_too_large",
  "outside_container"
])

/**
 * Stable, model-facing failure codes shared by the standard flows.
 *
 * @category models
 * @since 1.0.0
 */
export type Code = typeof Code.Type

/**
 * What a command printed before its time limit stopped it, on the terms a
 * finished command's output uses: each stream cut to its start and end past
 * the shell flows' capture limit, with the bytes dropped between them counted.
 *
 * `mutated` is present when the command ran in a container whose working
 * directory was measured before it started and after it was stopped: a
 * command that ran out of time may still have changed files.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export const PartialOutput = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
  stdoutDroppedBytes: Schema.Number,
  stderrDroppedBytes: Schema.Number,
  mutated: Schema.optional(Schema.Boolean)
})

/**
 * What a command printed before its time limit stopped it.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type PartialOutput = typeof PartialOutput.Type

/**
 * A recoverable standard-flow failure.
 *
 * Handlers keep ordinary outcomes (a non-zero exit code, an empty match set)
 * in the success channel; this error is reserved for failures the model must
 * see as failures.
 *
 * @category errors
 * @since 1.0.0
 */
export class StdError extends Schema.TaggedError<StdError>()("@smthrs/std/StdError", {
  code: Code,
  message: Schema.String,
  path: Schema.optional(Schema.String),
  /** Full-file base, or unread when this run has not read the existing file. */
  base_digest: Schema.optional(Schema.String),
  /** Full-file current SHA-256, or absent. */
  current_digest: Schema.optional(Schema.String),
  /** Language-server request that failed. */
  method: Schema.optional(Schema.String),
  /** JSON-RPC diagnostics, bounded by the transport's maximum frame size. */
  rpcError: Schema.optional(Schema.Struct({
    code: Schema.Number,
    message: Schema.String,
    data: Schema.optional(Schema.Unknown)
  })),
  /** At most 64 KiB of the language server's most recent stderr. */
  stderr: Schema.optional(Schema.String),
  /** The limit a `timeout` ran past, in milliseconds, when the flow knows it. */
  limitMillis: Schema.optional(Schema.Number),
  /** What a `timeout` from a shell flow printed before it was stopped. */
  output: Schema.optional(PartialOutput)
}) {}
