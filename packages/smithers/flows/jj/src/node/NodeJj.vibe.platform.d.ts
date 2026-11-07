import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Semaphore from "effect/Semaphore";
import { Jj, JjError } from "../../.vibe/declarations/src/Jj.vibe";
/**
 * Minimum jj CLI version supported by the Node and Bun adapters.
 * Git patch path quoting is repaired by the shared adapter for 0.39.0.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const minimumVersion = "0.39.0";
/**
 * Milliseconds a layer's first operation waits for each version probe
 * attempt, before cleanup. A probe that times out, or that the spawner reports
 * `TimedOut` starting, is retried once, so the operation waits at most twice
 * this long. Provide this reference to a layer to override the 5000 ms
 * default; the layer reads it when it is built. Values must be positive,
 * finite, and within the host timer range (2147483647 ms); an invalid value
 * fails the probe before it spawns.
 *
 * @category configuration
 * @since 1.0.0
 */
export declare const StartupTimeoutMs: Context.Reference<number>;
export interface Output {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
    /** The signal that terminated the child, when no exit code did. */
    readonly signal: NodeJS.Signals | null;
}
/** The absolute executable selected once for a layer and its diagnostic hint. */
export interface Binary {
    readonly command: string;
    readonly hint?: string | undefined;
}
export interface RepositoryLock {
    readonly semaphore: Semaphore.Semaphore;
    users: number;
}
/**
 * Milliseconds allowed to acquire both workspace and store fences.
 * Once acquired, this deadline never interrupts the protected operation.
 *
 * @category configuration
 * @since 1.0.0
 */
export declare const RepositoryMutationTimeoutMs: Context.Reference<number>;
/**
 * Share the workspace/store fences with host application of captured work.
 * The deadline bounds acquisition of both fences only, never execution.
 * Caller cancellation and operation failure release both fences.
 *
 * @category utils
 * @since 1.0.0
 */
export declare const withRepositoryMutation: <A, E, R>(method: string, from: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | JjError, R>;
/** How one `jj` invocation reaches the operating system. */
export type Run = (method: string, args: ReadonlyArray<string>, cwd?: string) => Effect.Effect<string, JjError>;
/** Runs `jj` with argv (never a shell string) in `cwd`. */
export declare const jj: (binary: Binary) => Run;
/**
 * Runs `jj` through a `ChildProcessSpawner`.
 *
 * The classification is the same as {@link jj}'s, including the `not_installed`
 * answer: a spawner reports a missing binary as a `NotFound` `PlatformError`,
 * which is `ENOENT` with a different name on it.
 */
export declare const viaSpawner: (spawner: ChildProcessSpawner["Service"]) => (binary: Binary) => Run;
/**
 * Bind the executable now; check its version before the first operation.
 *
 * Resolution reads the environment and the filesystem and spawns nothing, so a
 * host without jj builds and only an operation that needs jj fails, with the
 * probe's `not_installed`, `unsupported_version`, or startup failure. The path
 * is bound here, so a later PATH or cwd change cannot redirect the layer. Only
 * a supported probe is remembered: an operation after a refusal probes again,
 * so `chmod +x` or an in-place upgrade takes effect without a rebuild.
 */
export declare const checkedOperations: (makeRun: (binary: Binary) => Run, repositoryRoot?: string, spawner?: ChildProcessSpawner["Service"]) => Effect.Effect<Jj>;
/**
 * Provides `Jj` bound to one absolute repository root.
 *
 * Binding makes repository authority explicit: later changes to
 * `process.cwd()` cannot redirect snapshots, restores, or diffs into another
 * checkout.
 *
 * Two consequences a caller has to know. A RELATIVE `path` handed to
 * `workspaceAdd` resolves against `repositoryRoot` here and against the
 * caller's working directory under {@link layer}, so pass absolute lane paths.
 * And `root(from)` is exempt from the binding by design: its argument names the
 * directory jj must run in, which is the whole question it answers.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerAt: (repositoryRoot: string) => Layer.Layer<Jj>;
/**
 * Provides repository-bound `Jj` through the host's process spawner.
 *
 * The binding behaves exactly as {@link layerAt}'s, including how a relative
 * `workspaceAdd` path resolves and `root`'s exemption from it.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerSpawnerAt: (repositoryRoot: string) => Layer.Layer<Jj, never, ChildProcessSpawner>;
