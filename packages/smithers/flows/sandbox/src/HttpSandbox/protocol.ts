/**
 * The wire shapes `HttpSandbox.serve` answers and `HttpSandbox.make` sends.
 *
 * @since 1.0.0-rc.17
 */

import * as Schema from "effect/Schema"
import { ProviderErrorCode } from "../RemoteChildProcessSpawner/ProviderError.ts"

/**
 * A session's machine ceilings, as a request body carries them.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Limits = Schema.Struct({
  cpus: Schema.optional(Schema.Finite),
  memoryMib: Schema.optional(Schema.Finite),
  timeoutSecs: Schema.optional(Schema.Finite)
})

/**
 * A session's machine ceilings, as a query string carries them on the routes
 * whose body is file bytes or nothing.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const LimitsQuery = Schema.Struct({
  cpus: Schema.optional(Schema.FiniteFromString),
  memoryMib: Schema.optional(Schema.FiniteFromString),
  timeoutSecs: Schema.optional(Schema.FiniteFromString)
})

/**
 * `POST /v1/sessions`: acquire the machine of session key `key`.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Acquire = Schema.Struct({ key: Schema.String, limits: Schema.optional(Limits) })

/**
 * The answer to {@link Acquire}: the session every later request names.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const SessionInfo = Schema.Struct({ id: Schema.String, remoteId: Schema.String, workdir: Schema.String })

/**
 * `POST /v1/sessions/<remoteId>/commands`: run one command to completion. An
 * environment value of `null` removes the variable. `stdin` is base64.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Command = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  stdin: Schema.optional(Schema.Uint8ArrayFromBase64),
  limits: Schema.optional(Limits)
})

/**
 * The answer to {@link Command}: its exit code and both streams, base64.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const CommandResult = Schema.Struct({
  exitCode: Schema.Int,
  stdout: Schema.Uint8ArrayFromBase64,
  stderr: Schema.Uint8ArrayFromBase64
})

/**
 * The body of every refusal but `401`: a `ProviderError`'s code and message,
 * never its cause.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Failure = Schema.Struct({ code: ProviderErrorCode, message: Schema.String })

/**
 * The HTTP status a `ProviderError` crosses the wire with: `404` for
 * `not_found`, `422` for every other code. A `5xx` is never a
 * `ProviderError`, so a client retries only what failed on the way.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const statusOf = (code: ProviderErrorCode): number => code === "not_found" ? 404 : 422
