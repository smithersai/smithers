/**
 * The fork verb: a new run seeded from a parent frame, never a parent mutation.
 *
 * `docs/guides/fork-a-run.md`: fork never touches the parent —
 * no compensation, no truncation, no restore of the parent's workspace — but
 * the boundary assessment still runs, and its result is **normalized to
 * warnings**: "this effect may execute again on the child". A fork with
 * warnings is a successful fork that disclosed something, not a refused one.
 *
 * @since 0.1.0
 */
import { Jj } from "@smthrs/jj";
import * as Journal from "@smthrs/journal/Journal";
import * as RunStore from "@smthrs/run-store/RunStore";
import * as CacheStore from "@smthrs/step-cache/CacheStore";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { Frame } from "../Frame.vibe";
import { type TimeTravelError } from "../TimeTravelError.vibe";
import { type Fork as ForkRecord, type Rebinding, type StepOverride, TimeTravelStore } from "../../../../src/TimeTravelStore.ts";
import type { EffectHandlerRegistry } from "../../../../src/internal/EffectHandlerRegistry.ts";
/**
 * What a fork needs to know: which parent frame to branch from, and which lane
 * the child's workspace goes under.
 *
 * The lane is a root rather than a full path because a fork adds a jj
 * workspace for the child rather than restoring the parent's — the parent
 * keeps its own working copy untouched — and the child's own run id, minted
 * inside the operation, is what names it.
 *
 * @since 0.1.0
 * @category models
 */
export interface ForkOptions {
    readonly parentRunId: string;
    readonly frame: Frame;
    /**
     * The lane the child's jj workspace is materialized under. The workspace's
     * own name is {@link workspaceNameFor} of the child run id, never a
     * caller-supplied label: the fork mints the child id first precisely so the
     * lane and the run it holds carry one identity.
     */
    readonly workspaceRoot: string;
    /** A CLI-created branch outlives the process that created it. */
    readonly retainWorkspace?: boolean | undefined;
    /**
     * One step result the child replays in place of the parent's. The step must
     * have been admitted at the frame; anything else refuses before a child id
     * is minted or a workspace provisioned.
     */
    readonly override?: StepOverride | undefined;
    /**
     * What the child rebinds, derived from its minted id: its recorded payload
     * and the spawned children it carries (`TimeTravelStore.Rebinding`). A
     * function because a carried child's new id, and a payload that names the
     * run, are functions of the child id the fork mints. It runs after the
     * mint and before the lane is provisioned, so a refusal leaves no lane.
     */
    readonly rebind?: ((childRunId: string) => Effect.Effect<Rebinding, TimeTravelError>) | undefined;
    /** Journal page size for the suffix scan; defaults to the store's own. */
    readonly pageSize?: number | undefined;
    /**
     * The most journal entries the suffix scan may read before it refuses with
     * `limit_exceeded`. Defaults to `HistoryLimit.defaultMaxHistoryEntries`.
     */
    readonly maxEntries?: number | undefined;
    /**
     * Brings the parent's frame anchors up to date, run AFTER the live-parent
     * refusal and before the assessment reads them. A fork of a live parent is
     * refused without reading its journal at all.
     */
    readonly refreshAnchors?: Effect.Effect<void, never, Journal.Journal | TimeTravelStore> | undefined;
    /**
     * Fault injection between the fork's durable steps, the seam the crash
     * suite uses to kill a real process after the workspace exists and before
     * the store commits. Mirrors `Rewind.Options.hooks`.
     */
    readonly hooks?: {
        readonly beforeStep?: (step: ForkStep) => Effect.Effect<void, unknown>;
    } | undefined;
}
/**
 * The two steps a fork performs after its assessment, in order: provisioning
 * the child's jj workspace, then committing the child through the store.
 *
 * @since 0.1.0
 * @category models
 */
export type ForkStep = "provision-workspace" | "commit-fork";
/**
 * How long a reserved fork id may stay uncommitted before startup treats its
 * lane as abandoned and forgets it.
 *
 * Provisioning a workspace is one `jj workspace add`, seconds even on a large
 * repository, so five minutes separates a crash from a slow checkout by a
 * wide margin. An intent reclaimed while its fork was still in flight costs
 * that fork its commit: the store refuses it with `fence_lost`, and the
 * refused-commit path forgets its lane. The refusal transaction first resets
 * even a forgotten intent to reclaiming, so startup retries if that cleanup
 * fails; a successful cleanup makes the later forget a no-op. The ordinal is
 * never reused.
 *
 * @since 0.1.0
 * @category constants
 */
export declare const intentStaleAfter: Duration.Duration;
/**
 * The workspace name a forked run's lane carries.
 *
 * THE CHILD RUN ID IS THE ONLY INPUT, on purpose. Naming the lane after the
 * parent frame, meaning the parent run id and the frame's seq, gave the second
 * fork of one frame the first child's name, and gave two parents that differ
 * only in a character the sanitizer folds (`demo/a` and `demo:a`) one shared
 * name.
 * The child run id distinguishes exactly what the store distinguishes, and the
 * digest of the RAW id restores what sanitizing and the 64-character cap fold
 * away. Two children share a name only when their sanitized, capped ids match
 * AND their raw ids share a 32-bit FNV-1a digest, about one pair in 4.3
 * billion for ids that already differ by an ordinal the store hands out. That
 * residual case is loud rather than silent: `jj workspace add` refuses a name
 * the repository already holds, so the fork fails instead of two runs sharing
 * one directory.
 *
 * `jj workspace list` shows this name to an operator, so it carries the
 * product's name rather than the imported repository's.
 *
 * @since 0.1.0
 * @category constructors
 */
export declare const workspaceNameFor: (childRunId: string) => string;
/**
 * A fork's outcome: the child run, its lineage edge, and everything the
 * boundary assessment disclosed.
 *
 * A fork never compensates, so the
 * assessment still runs and its blocking and revertible entries are
 * **normalized to warnings** — "this effect may execute again on the child".
 * A fork with a non-empty `warnings` is a successful fork, not a refused one.
 * The store commits {@link ForkRecord} and knows nothing of the warnings; this
 * layer computes them.
 *
 * @since 0.1.0
 * @category models
 */
export interface Result extends ForkRecord {
    readonly warnings: ReadonlyArray<string>;
}
/**
 * Branches a child run off a parent frame.
 *
 * Refuses with `live_parent` if the parent is still running, claimed, or
 * owned — a fork copies a settled prefix, and a live parent has no settled
 * prefix to copy. Otherwise it reads the journal suffix past the frame,
 * assesses the effects in it, normalizes every classification to a warning
 * (see the module header), mints the child's run id, provisions that child's
 * jj workspace under {@link ForkOptions.workspaceRoot}, and only then asks the
 * store to commit the fork in one transaction — so a failed provision leaves
 * nothing durable, and a failed commit forgets the lane it provisioned. The
 * parent is never mutated.
 *
 * @since 0.1.0
 * @category constructors
 */
export declare const fork: (options: ForkOptions) => Effect.Effect<Result, TimeTravelError, CacheStore.CacheStore | EffectHandlerRegistry | Jj | Journal.Journal | RunStore.RunStore | Scope.Scope | TimeTravelStore>;
