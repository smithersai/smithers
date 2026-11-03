/**
 * Identifies the owner and requested configuration of a crash-left machine.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
/** A stable SHA-256 fingerprint, encoded to fit a Kubernetes label value.
 * @since 0.1.0
 * @private
 */
export declare const configurationFingerprint: (configuration: unknown) => Effect.Effect<string, import("../../../../src/RemoteChildProcessSpawner/ProviderError.ts").ProviderError, never>;
