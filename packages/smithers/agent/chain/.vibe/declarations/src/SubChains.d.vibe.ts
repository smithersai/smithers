/**
 * Sub-agents as an ordinary catalog entry — recursion is the primitive.
 *
 * The `agent` entry runs a nested chain under a deterministic child id
 * derived from its call slot (`parent-chain/link.ordinal`), in the same
 * journal: the child's events are scoped by that id, so a re-executed
 * spawning call resumes the child from its own settled events — child
 * chains are incrementally durable for free. A child's `done` and
 * terminal parks settle as data the parent script inspects; a child
 * waiting on approval bubbles as an in-place park so a later grant
 * resumes the child through the same slot. Children run unattended —
 * the chain core never drains steering under a child scope
 * (https://chain.smithers.sh/contract/).
 *
 * Composition invariants: the catalog layer must be built over the SAME
 * journal/author/runner layers the chain runs on (the services are
 * captured at construction), root chain ids must not contain `/` or look
 * like `<digits>.<digits>`, and the reserved names (`agent`, `author`,
 * the system entries) may not appear in the host's entries. Invalid root
 * ids fail Chain.run with ChainError; reserved entries die at construction.
 *
 * @since 0.1.0
 */
import { Effect, Layer } from "effect";
import * as Author from "./Author.vibe";
import * as Catalog from "./Catalog.vibe";
import * as Journal from "./Journal.vibe";
import * as ScriptRunner from "../../../src/ScriptRunner.ts";
/**
 * The catalog name a script spawns a sub-agent by.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export declare const agentName = "agent";
/**
 * The agent entry's description, as the model reads it in the catalog block.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export declare const agentDescription = "Run a sub-agent chain to completion and return its terminal outcome as data";
/**
 * The capability the agent entry claims: spawning a sub-agent is a
 * process-spawn-shaped authority hosts grant deliberately. The child's
 * own calls are gated individually by the same seam.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export declare const agentCapability = "proc:spawn:agent";
/**
 * The nesting bound a catalog inherits when {@link Options.maxDepth} is
 * unset, counted in derived child segments. It is part of the agent entry's
 * contract digest, so changing it re-keys every settled spawn.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export declare const defaultMaxDepth = 4;
/**
 * What the recursive catalog needs: the host's own entries, the nesting
 * bound, and the budgets and prefix every child runs under.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
    /** Entries every chain in the tree can call; the agent and system entries are appended. */
    readonly entries: ReadonlyArray<Catalog.Entry>;
    /**
     * Maximum nesting depth, counted in derived child segments. Must be a
     * non-negative integer; construction dies on any other value.
     */
    readonly maxDepth?: number | undefined;
    /**
     * Per-child budgets and prefix, independent of the parent's. A budget,
     * when set, must be a non-negative integer; construction dies on any
     * other value.
     */
    readonly maxLinks?: number | undefined;
    readonly maxCallsPerLink?: number | undefined;
    readonly prefix?: string | undefined;
}
/**
 * The digest of the agent entry's behavior contract: redeclaring the
 * child budgets, prefix, or depth bound re-keys every settled spawn.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const contractDigest: (options: Options) => string;
/**
 * Builds the recursive catalog: the given entries plus the `agent` entry
 * (whose handler runs a nested chain against this same catalog, so
 * children recurse up to `maxDepth`) and the system entries, which
 * nothing can shadow. Dies when an entry shadows a reserved name, or when
 * `maxDepth`, `maxLinks`, or `maxCallsPerLink` is not a non-negative
 * integer.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const make: (options: Options) => Effect.Effect<Catalog.Service, never, Journal.Journal | Author.Author | ScriptRunner.ScriptRunner>;
/**
 * The recursive catalog layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layer: (options: Options) => Layer.Layer<Catalog.Catalog, never, Journal.Journal | Author.Author | ScriptRunner.ScriptRunner>;
