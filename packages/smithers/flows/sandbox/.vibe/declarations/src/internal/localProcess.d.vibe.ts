/**
 * Adapts local child-process handles to the remote-process shape.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import type { ChildProcessHandle } from "effect/process/ChildProcessSpawner";
import type { RemoteProcess } from "../../../../src/RemoteChildProcessSpawner/Provider.ts";
import { ProviderError } from "../../../../src/RemoteChildProcessSpawner/ProviderError.ts";
/**
 * Wraps a failure cause in the provider vocabulary. A cause that is already a
 * `ProviderError` is the more precise answer and passes through unchanged.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const providerFailure: (code: ProviderError["code"], message: string) => (cause: unknown) => ProviderError;
/**
 * Presents a locally spawned handle as a remote process. The in-repository
 * providers run their transport locally — a shell, a container CLI — so the
 * three pieces a remote process has are the local handle's, with failures
 * restated in the provider vocabulary.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const remoteProcessOf: (handle: ChildProcessHandle, command: string) => RemoteProcess;
/**
 * One gathered local command run: concatenated stdout bytes, decoded stderr,
 * and the exit code, consumed concurrently so output larger than a pipe
 * cannot deadlock the exit observation.
 *
 * @category models
 * @since 0.1.0
 */
export interface GatheredRun {
    readonly stdout: Uint8Array;
    readonly stderr: string;
    readonly code: number;
}
/**
 * Runs one local command to completion and gathers its outputs.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const gather: (handle: ChildProcessHandle, command: string) => Effect.Effect<GatheredRun, ProviderError>;
