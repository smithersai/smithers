/**
 * Execution policies attached to flow definitions through Effect context.
 *
 * @since 0.1.0
 */
import * as PlanEffects from "@smthrs/plan/Effects";
import * as PlanPlacement from "@smthrs/plan/Placement";
import * as Plan from "@smthrs/plan/Plan";
import * as Context from "effect/Context";
/**
 * Declared filesystem effects: the plan node effect contract itself.
 *
 * This is `@smthrs/plan`'s `Plan.NodeEffects`, not a copy of it. The two were
 * field-for-field identical structs in two packages, which meant a change to
 * one silently stopped `Plan.compile` decoding what this package wrote.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Effects: import("effect/Schema").Struct<{
    readonly reads: import("effect/Schema").$Array<import("effect/Schema").Union<readonly [import("effect/Schema").Union<readonly [import("effect/Schema").NonEmptyString, import("effect/Schema").TaggedStruct<"Glob", {
        readonly include: import("effect/Schema").NonEmptyArray<import("effect/Schema").NonEmptyString>;
        readonly exclude: import("effect/Schema").optional<import("effect/Schema").$Array<import("effect/Schema").NonEmptyString>>;
    }>]>, import("effect/Schema").TaggedStruct<"Filegroup", {
        readonly name: import("effect/Schema").NonEmptyString;
        readonly entries: import("effect/Schema").$Array<import("effect/Schema").Union<readonly [import("effect/Schema").NonEmptyString, import("effect/Schema").TaggedStruct<"Glob", {
            readonly include: import("effect/Schema").NonEmptyArray<import("effect/Schema").NonEmptyString>;
            readonly exclude: import("effect/Schema").optional<import("effect/Schema").$Array<import("effect/Schema").NonEmptyString>>;
        }>]>>;
    }>]>>;
    readonly writes: import("effect/Schema").$Array<import("effect/Schema").Union<readonly [import("effect/Schema").Union<readonly [import("effect/Schema").NonEmptyString, import("effect/Schema").TaggedStruct<"Glob", {
        readonly include: import("effect/Schema").NonEmptyArray<import("effect/Schema").NonEmptyString>;
        readonly exclude: import("effect/Schema").optional<import("effect/Schema").$Array<import("effect/Schema").NonEmptyString>>;
    }>, import("effect/Schema").TaggedStruct<"TreeArtifact", {
        readonly path: import("effect/Schema").NonEmptyString;
    }>]>, import("effect/Schema").TaggedStruct<"Filegroup", {
        readonly name: import("effect/Schema").NonEmptyString;
        readonly entries: import("effect/Schema").$Array<import("effect/Schema").Union<readonly [import("effect/Schema").NonEmptyString, import("effect/Schema").TaggedStruct<"Glob", {
            readonly include: import("effect/Schema").NonEmptyArray<import("effect/Schema").NonEmptyString>;
            readonly exclude: import("effect/Schema").optional<import("effect/Schema").$Array<import("effect/Schema").NonEmptyString>>;
        }>, import("effect/Schema").TaggedStruct<"TreeArtifact", {
            readonly path: import("effect/Schema").NonEmptyString;
        }>]>>;
    }>]>>;
    readonly removes: import("effect/Schema").optional<import("effect/Schema").$Array<import("effect/Schema").NonEmptyString>>;
    readonly boundaryMode: import("effect/Schema").Literals<readonly ["hard", "expected"]>;
}>;
/**
 * The value form of {@link Effects}.
 *
 * @category models
 * @since 0.1.0
 */
export type Effects = Plan.NodeEffects;
/**
 * A directive naming where a node runs, carried unchanged until planning.
 *
 * This is `@smthrs/plan`'s `Placement.Placement`, the one typed model. It was
 * `Schema.Unknown` here while `@smthrs/core` held a four-variant enum of the
 * same thing, which made every crossing a cast.
 *
 * @category models
 * @since 0.1.0
 */
export type PlacementDirective = PlanPlacement.Placement;
/**
 * Capability ceiling. An omitted annotation inherits; an explicit empty array denies.
 * The reference default remains an empty metadata projection for catalog readers;
 * execution distinguishes an absent annotation from an explicitly stored one.
 *
 * @category annotations
 * @since 0.1.0
 */
export declare const Capabilities: Context.Reference<readonly string[]>;
/**
 * Required annotation key for a flow's declared filesystem effects.
 *
 * @category annotations
 * @since 0.1.0
 */
export declare const EffectsDeclaration: Context.Service<{
    readonly reads: readonly (string | {
        readonly _tag: "Filegroup";
        readonly name: string;
        readonly entries: readonly (string | {
            readonly _tag: "Glob";
            readonly include: readonly [string, ...string[]];
            readonly exclude?: readonly string[] | undefined;
        })[];
    } | {
        readonly _tag: "Glob";
        readonly include: readonly [string, ...string[]];
        readonly exclude?: readonly string[] | undefined;
    })[];
    readonly writes: readonly (string | {
        readonly _tag: "Filegroup";
        readonly name: string;
        readonly entries: readonly (string | {
            readonly _tag: "TreeArtifact";
            readonly path: string;
        } | {
            readonly _tag: "Glob";
            readonly include: readonly [string, ...string[]];
            readonly exclude?: readonly string[] | undefined;
        })[];
    } | {
        readonly _tag: "TreeArtifact";
        readonly path: string;
    } | {
        readonly _tag: "Glob";
        readonly include: readonly [string, ...string[]];
        readonly exclude?: readonly string[] | undefined;
    })[];
    readonly removes?: readonly string[] | undefined;
    readonly boundaryMode: "expected" | "hard";
}, {
    readonly reads: readonly (string | {
        readonly _tag: "Filegroup";
        readonly name: string;
        readonly entries: readonly (string | {
            readonly _tag: "Glob";
            readonly include: readonly [string, ...string[]];
            readonly exclude?: readonly string[] | undefined;
        })[];
    } | {
        readonly _tag: "Glob";
        readonly include: readonly [string, ...string[]];
        readonly exclude?: readonly string[] | undefined;
    })[];
    readonly writes: readonly (string | {
        readonly _tag: "Filegroup";
        readonly name: string;
        readonly entries: readonly (string | {
            readonly _tag: "TreeArtifact";
            readonly path: string;
        } | {
            readonly _tag: "Glob";
            readonly include: readonly [string, ...string[]];
            readonly exclude?: readonly string[] | undefined;
        })[];
    } | {
        readonly _tag: "TreeArtifact";
        readonly path: string;
    } | {
        readonly _tag: "Glob";
        readonly include: readonly [string, ...string[]];
        readonly exclude?: readonly string[] | undefined;
    })[];
    readonly removes?: readonly string[] | undefined;
    readonly boundaryMode: "expected" | "hard";
}>;
/**
 * The effect AUTHORITY a flow declares: the ceiling every step spliced beneath
 * it must stay inside.
 *
 * This is the one envelope model, `@smthrs/plan/Effects`, which `@smthrs/core`
 * re-exports and `@smthrs/patterns` intersects against. It answers a different
 * question from {@link EffectsDeclaration}: that one says which FILES a node
 * touches, so a plan can order writers and a sandbox can enforce a boundary at
 * run time, while this one says how much a flow is ALLOWED to touch, so
 * {@link module:Graph.build} can refuse a composition that claims more than its
 * caller granted.
 *
 * `Flow.make`'s `effects` option writes it, which is what makes it readable by
 * a catalog that projects a declaration without importing this module.
 *
 * @category annotations
 * @since 0.1.0
 */
export declare const EffectEnvelope: Context.Service<PlanEffects.Declaration, PlanEffects.Declaration>;
/**
 * Required annotation key for a flow's schema-encodable placement directive.
 *
 * @category annotations
 * @since 0.1.0
 */
export declare const Placement: Context.Service<{
    readonly _tag: "flows/core/Placement/Client";
} | {
    readonly _tag: "flows/core/Placement/Local";
} | {
    readonly _tag: "flows/core/Placement/Remote";
    readonly image?: string | undefined;
    readonly profile?: string | undefined;
    readonly target?: string | undefined;
} | {
    readonly _tag: "flows/core/Placement/Sandbox";
    readonly image?: string | undefined;
    readonly profile?: string | undefined;
    readonly target?: string | undefined;
}, {
    readonly _tag: "flows/core/Placement/Client";
} | {
    readonly _tag: "flows/core/Placement/Local";
} | {
    readonly _tag: "flows/core/Placement/Remote";
    readonly image?: string | undefined;
    readonly profile?: string | undefined;
    readonly target?: string | undefined;
} | {
    readonly _tag: "flows/core/Placement/Sandbox";
    readonly image?: string | undefined;
    readonly profile?: string | undefined;
    readonly target?: string | undefined;
}>;
/**
 * Captures defects for a flow and includes them in the result of the flow or its actions.
 *
 * **Details**
 *
 * By default, this annotation is set to `true`, meaning defects are captured.
 *
 * @category annotations
 * @since 0.1.0
 */
export declare const CaptureDefects: Context.Reference<boolean>;
/**
 * Whether a catalog may offer this flow to a model, defaulting to yes.
 *
 * It answers a different question from {@link Capabilities}: that one says how
 * much a flow is allowed to touch, this one says whether a model is shown the
 * flow at all. A flow whose actions only one host implements is discoverable
 * everywhere its file is, and teaching it to an agent running somewhere else
 * offers a call that has no implementation to reach.
 *
 * `Flow.make`'s `modelInvocable` option writes it, which is what makes it
 * readable by a catalog that projects a declaration from source text without
 * importing this module, exactly as `capabilities` and `effects` are.
 *
 * @category annotations
 * @since 0.1.0
 */
export declare const ModelInvocable: Context.Reference<boolean>;
/**
 * Marks a flow to suspend when it encounters any error.
 *
 * **Details**
 *
 * The suspended execution can later be resumed with the flow's `resume` method, for example `MyFlow.resume(executionId)`.
 *
 * @category annotations
 * @since 0.1.0
 */
export declare const SuspendOnFailure: Context.Reference<boolean>;
