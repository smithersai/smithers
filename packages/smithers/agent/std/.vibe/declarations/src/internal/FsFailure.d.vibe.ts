/**
 * Maps a filesystem failure to the standard-flow code that names its reason.
 *
 * A permission denial is not a missing file. Telling the model a denied path
 * does not exist sends it searching for a file that is right there, and hides
 * the denial from whoever reads the run. Every standard flow that touches the
 * filesystem routes its failures through here so `PermissionDenied` always
 * reaches the model as `permission_denied`.
 *
 * @since 1.0.0
 */
import type * as PlatformError from "effect/PlatformError";
import * as StdError from "../StdError.vibe";
/**
 * The failure for a path the host or the kernel guard refused.
 *
 * @private
 * @since 1.0.0
 */
export declare const permissionDenied: (path: string) => StdError.StdError;
/**
 * Maps `PermissionDenied` to `permission_denied` and any other reason through
 * `otherwise`.
 *
 * @private
 * @since 1.0.0
 */
export declare const denied: (path: string, otherwise: (error: PlatformError.PlatformError) => StdError.StdError) => (error: PlatformError.PlatformError) => StdError.StdError;
/**
 * Maps a read-side failure: `NotFound` to `not_found` with `notFoundMessage`,
 * `PermissionDenied` to `permission_denied`, and anything else to
 * `command_failed` carrying the host's reason.
 *
 * @private
 * @since 1.0.0
 */
export declare const reading: (path: string, notFoundMessage: string) => (error: PlatformError.PlatformError) => StdError.StdError;
