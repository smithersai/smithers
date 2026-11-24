/**
 * Maps provider error codes onto normalized platform reasons.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import { ProviderError, type ProviderErrorCode } from "../RemoteChildProcessSpawner/ProviderError.ts"

import { boundedMessage } from "./boundedMessage.ts"
import { ProcessStatus } from "./localProcess.ts"

/**
 * The one mapping from a provider's closed code set onto the reasons
 * `PlatformError` already has.
 *
 * It lives here rather than in each adapter because two copies of the same
 * table under the same comment drifted: a caller holding a normalized
 * `PlatformError` could not infer the provider code without also knowing which
 * adapter had produced it.
 *
 * `unavailable` and `not_found` share `NotFound` deliberately at the process
 * seam. `not_found` exists so "absent" and "broken" stay apart in the PROVIDER
 * vocabulary, and they do; what they mean to a caller of a spawner is the same
 * instruction — this session cannot run your command, try somewhere else —
 * which is the reason `SandboxSupervision.retired` reports a retired session
 * as `NotFound` too. A caller that needs the distinction reads
 * `PlatformError.cause`, which carries a sanitized `ProviderError` with the original code.
 *
 * @category models
 * @since 0.1.0
 */
export const platformReason: Record<ProviderErrorCode, PlatformError.SystemErrorTag> = {
  aborted: "Unknown",
  timeout: "TimedOut",
  unavailable: "NotFound",
  not_found: "NotFound",
  spawn_error: "Unknown",
  unknown: "Unknown"
}

/**
 * Restates a provider failure in the platform vocabulary both spawner-facing
 * adapters share, so a session that refused to open reads the same whether the
 * caller reached it through `RemoteChildProcessSpawner` or `SandboxSupervision`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const platformFailure =
  (method: string) => (error: ProviderError): Effect.Effect<never, PlatformError.PlatformError> => {
    // Command operations may return guest arguments or SDK payloads in an arbitrary
    // provider's message. Only the open diagnostic and host-authored statuses are public.
    const message = method === "open" || error instanceof ProcessStatus ? boundedMessage(error.message) : undefined
    return Effect.logWarning("sandbox.provider.failed").pipe(
      Effect.annotateLogs({ method, code: error.code, ...(message === undefined ? {} : { message }) }),
      Effect.andThen(Effect.fail(PlatformError.systemError({
        _tag: platformReason[error.code],
        module: "ChildProcess",
        method,
        description: `remote ${method} failed (${error.code})`,
        cause: new ProviderError({ code: error.code, message: `remote ${method} failed` })
      })))
    )
  }

/**
 * The reason a refused utility gives, in the vocabulary of the platform
 * implementations: `EACCES` and `EPERM`, which glibc and musl word
 * `Permission denied` and `Operation not permitted`, are `PermissionDenied`
 * there too. A caller that tells a denial from
 * a broken session (the std file flows answer `permission_denied` rather than
 * `command_failed`) reads the same reason from a sandbox as from the host.
 *
 * @category models
 * @since 1.0.0-rc.8
 */
export const refusalReason = (stderr: string): PlatformError.SystemErrorTag =>
  stderr.includes("Permission denied") || stderr.includes("Operation not permitted") ? "PermissionDenied" : "Unknown"
