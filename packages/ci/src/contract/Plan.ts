/**
 * Contract 2: the plan.
 *
 * The targets one change selects, with each target's key and dependencies.
 * It is what `smthrs ci --plan --format json` already prints. Shard
 * assignment, the replay, and fast mode's scorer all read it.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * One planned target.
 *
 * @category models
 * @since 0.1.0
 */
export const PlannedTarget = Schema.Struct({
  label: Schema.NonEmptyString,
  rule: Schema.NonEmptyString,
  key: Schema.String,
  cacheable: Schema.Boolean,
  dependencies: Schema.Array(Schema.String),
  mode: Schema.optionalKey(Schema.String)
})

/**
 * A decoded `PlannedTarget`.
 *
 * @category models
 * @since 0.1.0
 */
export type PlannedTarget = typeof PlannedTarget.Type

/**
 * The plan for one verb and pattern.
 *
 * @category models
 * @since 0.1.0
 */
export const Plan = Schema.Struct({
  verb: Schema.String,
  pattern: Schema.String,
  roots: Schema.Array(Schema.String),
  targets: Schema.Array(PlannedTarget)
})

/**
 * A decoded `Plan`.
 *
 * @category models
 * @since 0.1.0
 */
export type Plan = typeof Plan.Type
