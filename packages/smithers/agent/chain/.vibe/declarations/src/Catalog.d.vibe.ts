/**
 * The catalog of entries a script may call — gate 3 is membership in it.
 *
 * Every effect goes through this one door: a call names a visible entry,
 * pinned by its declaration digest, and settles as a journaled event
 * (https://chain.smithers.sh/contract/).
 *
 * @since 0.1.0
 */
import { Context, type Effect, Layer, Schema } from "effect";
import type * as CallKey from "./CallKey.vibe";
declare const CallError_base: Schema.Class<CallError, Schema.TaggedStruct<"/chain/CallError", {
    readonly name: Schema.String;
    readonly message: Schema.String;
    /**
     * The underlying stable code when the failing subsystem has one (a
     * memory error code, a permission verdict), so callers branch on it
     * rather than parsing prose.
     */
    readonly cause: Schema.optional<Schema.String>;
}>, import("effect/Cause").YieldableError>;
/**
 * A call that reached its entry and failed there. The chain journals it as
 * an observation rather than crashing the run. The message is journaled
 * verbatim and shown to the model on the next link, so a handler must keep
 * credentials and private data out of it.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export declare class CallError extends CallError_base {
}
/**
 * Where a call sits in its chain — handed to every handler so entries
 * that spawn scoped work (sub-chains) can derive deterministic child
 * identities from the slot.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CallSlot {
    readonly chain: string;
    readonly link: number;
    readonly ordinal: number;
    /** The durable replay identity of this invocation. */
    readonly key?: CallKey.CallKey;
    /** Aborted on Stop for entries that settle before interruption returns. */
    readonly signal?: AbortSignal | undefined;
}
/**
 * One entry a script may call: the name it is reached by, the description
 * the model reads, and the handler that settles it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Entry {
    readonly name: string;
    readonly description: string;
    /** Signal cancellation, then await the handler and its journal receipt before returning. */
    readonly settleOnInterrupt?: boolean | undefined;
    readonly handler: (payload: unknown, slot?: CallSlot) => Effect.Effect<unknown, CallError>;
    /**
     * An optional declaration digest overriding the default name+description
     * digest — richer catalogs (the registry) pin their full declaration.
     */
    readonly digest?: string | undefined;
    /**
     * The capabilities this entry claims, as `action:resource` strings the
     * `Authorize` seam evaluates per call — the only policy input the seam
     * receives. Undeclared is conservatively the broadest claim — it
     * asks under rules, never silently passes.
     */
    readonly capabilities?: ReadonlyArray<string> | undefined;
}
/**
 * The visible entries and the lookup gate 3 decides membership with.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
    readonly entries: ReadonlyArray<Entry>;
    readonly lookup: (name: string) => Entry | undefined;
}
declare const Catalog_base: Context.ServiceClass<Catalog, "/chain/Catalog", Service>;
/**
 * The catalog service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export declare class Catalog extends Catalog_base {
}
/**
 * The declaration digest that pins an entry's identity into every call key
 * that names it.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const entryDigest: (entry: Entry) => string;
/**
 * Builds a catalog over the given entries, indexed by name.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const make: (entries: ReadonlyArray<Entry>) => Service;
/**
 * The system entries every sealed realm relies on: time and randomness as
 * ordinary journaled calls, so replay is deterministic with no special
 * identity (https://chain.smithers.sh/contract/).
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const system: ReadonlyArray<Entry>;
/**
 * Appends the system entries to a host's own — the composition every
 * sealed-realm host wants, since the QuickJS prelude deletes `Date` and
 * `Math.random` on the promise that `sys/now` and `sys/random` exist.
 *
 * The system entries come LAST because {@link make} indexes last-wins:
 * nothing a host passes can shadow `sys/now` or `sys/random` with an
 * unjournaled clock or RNG, which is what replay determinism rests on.
 * Every composition in the package goes through here, so the ordering has
 * one implementation rather than one per host.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const withSystem: (entries: ReadonlyArray<Entry>) => ReadonlyArray<Entry>;
/**
 * The empty catalog: every call misses gate 3.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const makeNoop: () => Service;
/**
 * A catalog over the given entries, as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layer: (entries: ReadonlyArray<Entry>) => Layer.Layer<Catalog>;
/**
 * The empty catalog as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layerNoop: Layer.Layer<Catalog>;
export {};
