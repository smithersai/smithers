/** Runtime configuration shared by injected and native hosts.
 * @since 1.0.0
 */
import type { EngineStore } from "@smthrs/engine-store";
import { Action } from "@smthrs/flow";
import type { Jj } from "@smthrs/jj";
import type { Ownership, RunStore } from "@smthrs/run-store";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
 * Nothing here names a file: the SQL client, the owner identity, the workspace
 * and the artifact store are injected by the host. The native hosts in
 * `@smthrs/platform-node` and `@smthrs/platform-bun` take their own options,
 * which add the database file and the workspace root.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Options {
    /** Stable identity of this engine host. */
    readonly owner: {
        readonly hostId: string;
    };
    /**
     * Whether a previously recorded owner is still alive.
     *
     * Takes the claim context as well as the owner, so a probe can tell whether
     * the recorded pid names a process on the machine it is running on. A
     * one-argument check that ignores the context still satisfies this.
     */
    readonly isAlive: Ownership.LivenessCheck;
    /** Routes shared-store runs to the host configured for their workspace. */
    readonly canExecute?: ((row: RunStore.RunRow) => Effect.Effect<boolean>) | undefined;
    /**
     * Read-only host admission rechecked in the native activation transaction.
     * Use captured native reads and synchronous local probes only; external I/O
     * and module loading belong in `canExecute`.
     */
    readonly canActivate?: ((row: RunStore.RunRow) => Effect.Effect<boolean>) | undefined;
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
    readonly requestResume?: ((executionId: string, reason: EngineStore.RequestedResumeReason) => Effect.Effect<void>) | undefined;
    /**
     * The complete runtime environment a sealed step's recorded result may be
     * reused under, folded into every cross-run cache key.
     *
     * Absent by default, and absence is the safe answer, not a missing feature:
     * `@smthrs/engine` `FlowEngine/ActionKey.actionKey` then scopes every sealed
     * keyed dispatch to its own execution, so a result recorded by one run is
     * addressed by an identity no later run can spell and nothing is ever
     * reused across runs. Declaring it is what lets a second run address the
     * first run's row.
     *
     * The engine cannot derive this value: it names the semantic runtime layers
     * and the effective capability groups a result was computed under, and only
     * the host knows both. It is complete or absent for that reason — a partial
     * environment would justify hits it cannot account for — so a host that
     * cannot enumerate its toolchain and its capability envelope leaves it out
     * rather than inventing one. A host that declares an environment its
     * machines do not actually share serves one machine's results to another.
     */
    readonly cacheEnvironment?: Action.CacheEnvironment | undefined;
    /**
     * The revision of the tree this host read its flows out of.
     *
     * Every node record can carry where its action was declared, and a path
     * with a line does not say which bytes were at that line: the tree moves
     * under a long-lived host, and the same path after an edit or a branch
     * switch is a different file. A host that can name the revision it loaded
     * from declares it here, and every recorded graph page carries it, so a
     * reader opens the declared file AT that revision rather than at whatever
     * is on disk when they look.
     *
     * Absent by default, which is the honest answer for a host served out of
     * no version control, or out of a tree no commit describes. A reader with
     * nothing shows no code at all rather than code it cannot bind (D-068).
     *
     * A host that only learns the answer after this call declares a reader
     * instead of a string, and it is asked once per recorded page. The native
     * host is one: the modules whose sites those records carry are read during
     * registration, which is the last startup phase, so the revision that
     * describes them is not known while this runtime is being built. A reader's
     * answer is not decoded here for the same reason it is not read here — it
     * does not exist yet — so an answer that is not a revision records nothing
     * rather than being refused after startup.
     */
    readonly sourceRevision?: string | (() => string | undefined) | undefined;
    /**
     * The repository the engine's own bookkeeping snapshots, restores and diffs
     * with, kept apart from the ambient `Jj` an action resolves.
     *
     * Absent, the engine uses the ambient `Jj` for both. A host that gives
     * action bodies the kernel-guarded `Jj` supplies its unguarded one here, so
     * a flow's capability ceiling bounds the action's repository access without
     * refusing the engine's own step snapshots.
     *
     * @since 1.0.0
     */
    readonly privilegedJj?: Layer.Layer<Jj> | undefined;
    /**
     * Who wakes this runtime's runs: `"process"`, the default, sweeps the store
     * from a long-lived process; `{ host: executionId }` leaves waking one
     * execution to a host that drives it per invocation. See
     * `@smthrs/engine-store` `EngineStore.Options.sweep`.
     *
     * @since 1.0.0
     */
    readonly sweep?: EngineStore.Sweep | undefined;
    /**
     * How many runs the engine resumes on its own at once, such as the runs a
     * restarted host finds unfinished; absent is no bound. A run a caller
     * starts or awaits never waits for them. See `@smthrs/engine-store`
     * `EngineStore.Options.resumeConcurrency`.
     *
     * @since 1.0.0
     */
    readonly resumeConcurrency?: number | undefined;
    /**
     * Where this runtime's runs run, as their usage metrics label it:
     * `browser`, `cloudflare`, `sandbox` or `local`, the default. See
     * `@smthrs/flow` `RunMetrics`.
     *
     * @since 1.0.0-rc.17
     */
    readonly placement?: string | undefined;
}
declare const RuntimeConfigurationError_base: Schema.Class<RuntimeConfigurationError, Schema.TaggedStruct<"@smthrs/flows/RuntimeConfigurationError", {
    readonly code: Schema.Literal<"invalid_runtime_configuration">;
    readonly field: Schema.String;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * Stable failure raised synchronously for invalid runtime construction input.
 *
 * @since 1.0.0
 * @category errors
 */
export declare class RuntimeConfigurationError extends RuntimeConfigurationError_base {
}
/**
 * Decodes one named option and reports the option that was wrong.
 *
 * A single struct decode would answer "options" for every refusal, and the
 * whole point of {@link RuntimeConfigurationError.field} is that an embedder
 * can tell an empty `filename` from an empty `owner.hostId` without reading
 * prose. Decoding field by field makes the name come from the call site rather
 * than from walking a schema issue tree. A host package decodes the options it
 * adds, such as a database filename, through this so its refusals carry the
 * same error and the host's own `label`.
 *
 * @since 1.0.0
 * @category validation
 */
export declare const decodeField: <A>(field: string, schema: Schema.Codec<A>, value: unknown, expectation: string, label?: string) => A;
/**
 * Captures the injected runtime's options as one immutable record.
 *
 * Throws `RuntimeConfigurationError` naming the first option that is wrong,
 * with `label` leading its message. `layer` calls it; a host package that
 * composes the engine itself calls it before reading the options.
 *
 * @since 1.0.0
 * @category validation
 */
export declare const validate: (options: Options, label?: string) => Options;
export {};
