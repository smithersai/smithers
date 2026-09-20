/**
 * The persisted plan: a keyed action graph, its append-only store, its diff,
 * and the step-key compiler that gives every node its identity.
 *
 * A plan is a `Node` graph with every key computed, produced by the plan phase
 * and inert until run. This package is that value made durable and nothing
 * more: it performs no I/O beyond the database and never executes anything.
 * Driving a plan is `@smthrs/engine-store`'s `PlanScheduler`.
 *
 * Above the persisted form sits the authoring AST: `Node` describes a plan as
 * pure data, and `Planned` is the placeholder a body sees where a step result
 * will be. Both build plans; neither runs one.
 *
 * @since 0.1.0
 */

/**
 * @since 0.1.0
 * @category errors
 * @slop
 */
export * as GraphBuildError from "./GraphBuildError.ts"

/**
 * @since 0.1.0
 * @category models
 * @slop
 */
export * as KeyMaterial from "./KeyMaterial.ts"

/**
 * @since 0.1.0
 * @category models
 * @slop
 */
export * as FileSet from "./FileSet.ts"

/**
 * @since 0.1.0
 * @category models
 * @slop
 */
export * as Effects from "./Effects.ts"

/**
 * @since 0.1.0
 * @category models
 * @slop
 */
export * as Node from "./Node.ts"

/**
 * @since 0.1.0
 * @category models
 * @slop
 */
export * as Plan from "./Plan.ts"

/**
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export * as PlanDiff from "./PlanDiff.ts"

/**
 * @since 0.1.0
 * @category services
 * @slop
 */
export * as PlanStore from "./PlanStore.ts"

/**
 * @since 0.1.0
 * @category models
 * @slop
 */
export * as Planned from "./Planned.ts"

/**
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export * as StepKey from "./StepKey.ts"

/**
 * @since 1.0.0
 * @category constructors
 */
export * as Scheduling from "./Scheduling.ts"

/**
 * @since 0.1.0
 * @category migrations
 * @slop
 */
export * as Migrations from "./Migrations.ts"
