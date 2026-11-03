/**
 * Projects the flow registry into the chain's catalog.
 *
 * Projection, not fusion: the registry stays the owner of discovery,
 * naming, warnings, and lazy bodies; this module renders its descriptors
 * as catalog entries at layer construction. Only callable descriptors are
 * projected — a module-bodied flow needs a host implementation and a
 * markdown-bodied flow needs a prompt runner — so the model's catalog
 * never discloses a call that is guaranteed to refuse. The system entries
 * (`sys/now`, `sys/random`) are always composed in, keeping the sealed
 * realm's promise (https://chain.smithers.sh/contract/).
 *
 * @since 0.1.0
 */
import * as Descriptor from "@smthrs/registry/Descriptor";
import * as Registry from "@smthrs/registry/Registry";
import { Effect, Layer } from "effect";
import * as Catalog from "./Catalog.vibe";
/**
 * A host-supplied handler for a module-bodied flow.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Implementation = (payload: unknown) => Effect.Effect<unknown, Catalog.CallError>;
/**
 * How a rendered markdown prompt executes — the seam a sub-agent seat
 * fills. Without one, markdown flows are not projected at all.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type PromptRunner = (rendered: string, descriptor: Descriptor.FlowDescriptor) => Effect.Effect<string, Catalog.CallError>;
/**
 * How the registry is projected into a catalog: which flows have host
 * implementations, how markdown prompts execute, which flows are visible,
 * and what extra entries follow.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
    readonly implementations?: ReadonlyMap<string, Implementation> | undefined;
    readonly prompt?: PromptRunner | undefined;
    readonly visible?: ((descriptor: Descriptor.FlowDescriptor) => boolean) | undefined;
    /** Extra host entries, composed after the projection. */
    readonly entries?: ReadonlyArray<Catalog.Entry> | undefined;
}
/**
 * The canonical digest of a descriptor's full declaration, and so of what
 * every catalog entry key pins.
 *
 * Re-exported from `@smthrs/registry`, which owns `FlowDescriptor`: one
 * declaration is one number here, in `@smthrs/harness`'s call identities, and
 * anywhere else that keys on a declaration.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const declarationDigest: (descriptor: Descriptor.FlowDescriptor) => string;
/**
 * Builds the catalog service from the ambient registry.
 *
 * Precedence when names collide: registry projection, then host extras,
 * then the system entries — later wins, so `sys/now` can never be
 * shadowed. Binding an implementation for a name the registry does not
 * know is a host configuration defect and dies at construction.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const make: (options?: Options) => Effect.Effect<Catalog.Service, never, Registry.Registry>;
/**
 * The registry-backed catalog layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layer: (options?: Options) => Layer.Layer<Catalog.Catalog, never, Registry.Registry>;
