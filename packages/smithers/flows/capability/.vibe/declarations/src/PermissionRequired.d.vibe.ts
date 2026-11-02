/**
 * The suspended-request failure and its constructor.
 *
 * The schema id is identity, not display text: a stored decision keeps the
 * exact string and is read back through it.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
import { Capability, EffectTier } from "./Capability.ts";
declare const PermissionRequired_base: Schema.Class<PermissionRequired, Schema.TaggedStruct<"@smthrs/capability/PermissionRequired", {
    readonly code: Schema.Literal<"permission_required">;
    readonly requestId: Schema.String;
    readonly runId: Schema.optional<Schema.String>;
    readonly capability: typeof Capability;
    readonly tier: Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>;
    /**
     * Journal-safe permission context.
     *
     * Only JSON-representable values survive the grant journal. Construction
     * takes a deep-frozen snapshot and does not retain the caller's object. An
     * undefined property value is dropped, mirroring `JSON.stringify`, so the
     * encoded payload is unchanged and a host can pass an optional field it
     * does not have, such as a spawn with no explicit cwd. Undefined array
     * elements are rejected because JSON serialization would change them to
     * null rather than omit them. Own `__proto__` data properties are preserved.
     * Metadata is limited to depth 16 (root 0), 1024 members and 64 KiB of
     * UTF-8 JSON. Shared references retain one snapshot but count at every
     * occurrence toward the limits. Cycles and excesses fail naming the field.
     *
     * @since 0.1.0
     * @category models
     */
    readonly meta: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>, import("effect/Cause").YieldableError>;
/**
 * A permission request that must be resolved by an attended surface.
 *
 * The capability is always the exact adapter request, never a wildcard. The
 * error retains neither the caller's metadata object nor the caller's
 * `Capability` instance, and its `meta` and `capability` slots are non-writable.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export declare class PermissionRequired extends PermissionRequired_base {
    constructor(props: {
        readonly code?: "permission_required";
        readonly requestId: string;
        readonly runId?: string | undefined;
        readonly capability: Capability;
        readonly tier: EffectTier;
        readonly meta: Readonly<Record<string, unknown>>;
    });
}
/**
 * Constructs a permission request for an exact capability.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const permissionRequired: (options: {
    readonly requestId: string;
    readonly runId?: string | undefined;
    readonly capability: Capability;
    readonly tier: EffectTier;
    readonly meta?: Readonly<Record<string, unknown>> | undefined;
}) => PermissionRequired;
export {};
