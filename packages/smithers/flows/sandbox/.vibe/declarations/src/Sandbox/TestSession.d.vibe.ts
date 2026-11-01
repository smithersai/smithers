/**
 * Constructs deterministic sandbox providers for tests.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts";
import type { TestScript } from "../RemoteChildProcessSpawner/TestScript.ts";
import type { TestSessionProvider } from "./TestSessionProvider.ts";
/**
 * What a scripted session is built from.
 *
 * Named rather than inline, so a consumer can write a fixture factory whose
 * argument type is spellable — the sibling models `TestSessionState` and
 * `TestSessionProvider` already are.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestSessionOptions {
    readonly session?: string | undefined;
    readonly remoteId?: string | undefined;
    readonly workdir?: string | undefined;
    /** Initial guest files, path to contents. */
    readonly files?: Readonly<Record<string, string | Uint8Array>> | undefined;
    /** Scripted responses keyed by the exact command line. */
    readonly scripts?: Readonly<Record<string, TestScript>> | undefined;
    /** Resolves a script for a command the record does not name. */
    readonly script?: ((command: string) => TestScript | undefined) | undefined;
    readonly acquireFailure?: ProviderError | undefined;
    /** Gives every session a `ping`, backed by this effect. */
    readonly ping?: Effect.Effect<void, ProviderError> | undefined;
    /** Guest paths that are credentials: a fork leaves them behind. */
    readonly credentials?: ReadonlyArray<string> | undefined;
    /** Fails every `fork` with this error. */
    readonly forkFailure?: ProviderError | undefined;
}
/**
 * Constructs a deterministic scripted session provider.
 *
 * @category testing
 * @since 0.1.0
 */
declare const makeTestSession: (options?: TestSessionOptions) => TestSessionProvider;
/**
 * Deterministic scripted sandbox constructor for projection and consumer
 * tests: an in-memory guest tree, command lines answered from a script table
 * or resolver, observable acquire and release counts, and forks that copy the
 * tree without the paths named as credentials.
 *
 * @category testing
 * @since 0.1.0
 */
export declare const TestSession: {
    readonly make: typeof makeTestSession;
};
export {};
