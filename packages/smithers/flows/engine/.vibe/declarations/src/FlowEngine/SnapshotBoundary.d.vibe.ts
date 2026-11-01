/**
 * The host snapshot boundary compensable actions are executed against.
 *
 * @since 0.1.0
 */
import type { Flow } from "@smthrs/flow";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
declare const SnapshotBoundaryRequired_base: Schema.Class<SnapshotBoundaryRequired, Schema.TaggedStruct<"@smthrs/engine/SnapshotBoundaryRequired", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"snapshot_boundary_required">>;
    readonly actionName: Schema.String;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A compensable action was admitted without a snapshot boundary.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class SnapshotBoundaryRequired extends SnapshotBoundaryRequired_base {
}
/**
 * Context passed to a compensable action snapshot boundary.
 *
 * @category models
 * @since 0.1.0
 */
export interface SnapshotBoundaryOptions {
    readonly flow: Flow.Any;
    readonly executionId: string;
    readonly key: string;
    readonly attempt: number;
    readonly metadata: unknown;
}
declare const SnapshotBoundary_base: Context.ServiceClass<SnapshotBoundary, "@smthrs/engine/FlowEngine/SnapshotBoundary", {
    readonly snapshot: (options: SnapshotBoundaryOptions) => Effect.Effect<unknown>;
    readonly restore: (snapshot: unknown, options: SnapshotBoundaryOptions) => Effect.Effect<void>;
    readonly diff: (snapshot: unknown, options: SnapshotBoundaryOptions) => Effect.Effect<unknown>;
}>;
/**
 * Minimal host snapshot boundary required by compensable actions.
 *
 * @category services
 * @since 0.1.0
 */
export declare class SnapshotBoundary extends SnapshotBoundary_base {
}
export {};
