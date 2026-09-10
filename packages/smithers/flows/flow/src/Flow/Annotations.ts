// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Execution policies attached to flow definitions through Effect context.
 *
 * @since 0.1.0
 */
import * as FileSet from "@smthrs/plan/FileSet"
import * as Context from "effect/Context"
import { constFalse, constTrue } from "effect/Function"
import * as Schema from "effect/Schema"
import { BoundaryMode } from "../Action/BoundaryMode.ts"

/**
 * Declared filesystem effects copied from the plan node effect contract.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Effects = Schema.Struct({
  reads: Schema.Array(FileSet.ReadDeclaration),
  writes: Schema.Array(FileSet.Declaration),
  /**
   * Paths the flow declares it will DELETE. Optional with an empty default:
   * an absent declared write is a defect, and a declared removal is what makes
   * an absent path legitimate instead. Workspace-relative like every other
   * declared path, because replay acts on a removal by deleting it.
   */
  removes: Schema.optional(Schema.Array(FileSet.Pattern)),
  boundaryMode: BoundaryMode
})

/**
 * The value form of {@link Effects}.
 *
 * @category models
 * @since 0.1.0
 */
export type Effects = typeof Effects.Type

/**
 * Schema-encodable placement directive retained opaquely until planning.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PlacementDirective = Schema.Unknown

/**
 * The value form of {@link PlacementDirective}.
 *
 * @category models
 * @since 0.1.0
 */
export type PlacementDirective = typeof PlacementDirective.Type

/**
 * Capability names a flow may require, defaulting to none.
 *
 * @category annotations
 * @since 0.1.0
 */
export const Capabilities = Context.Reference<ReadonlyArray<string>>(
  "@smthrs/flow/Flow/Capabilities",
  { defaultValue: () => [] }
)

/**
 * Required annotation key for a flow's declared filesystem effects.
 *
 * @category annotations
 * @since 0.1.0
 */
export const EffectsDeclaration = Context.Service<Effects>("@smthrs/flow/Flow/EffectsDeclaration")

/**
 * Required annotation key for a flow's schema-encodable placement directive.
 *
 * @category annotations
 * @since 0.1.0
 */
export const Placement = Context.Service<PlacementDirective>("@smthrs/flow/Flow/Placement")

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
export const CaptureDefects = Context.Reference<boolean>(
  "@smthrs/flow/Flow/CaptureDefects",
  {
    defaultValue: constTrue
  }
)

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
export const SuspendOnFailure = Context.Reference<boolean>(
  "@smthrs/flow/Flow/SuspendOnFailure",
  {
    defaultValue: constFalse
  }
)
