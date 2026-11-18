/**
 * Contract 11: which target each CI step became.
 *
 * The generator writes this document among its files, at `path`. The replay
 * reads it there to compare a step's baseline verdict with its target's
 * verdict, and a report can name the step a target came from.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Where the document is written, relative to the repository root.
 *
 * @category constants
 * @since 0.1.0
 */
export const path = ".smithers/ci-targets.json"

/**
 * One step of one job, in one matrix variant, and the label of a target
 * that runs it. `label` is the label a run record reports. A job with no
 * matrix has the empty variant. A step that was split has one entry per
 * target, each naming the original step.
 *
 * @category models
 * @since 0.1.0
 */
export const Entry = Schema.Struct({
  label: Schema.NonEmptyString,
  job: Schema.NonEmptyString,
  step: Schema.NonEmptyString,
  variant: Schema.Record(Schema.String, Schema.String)
})

/**
 * A decoded `Entry`.
 *
 * @category models
 * @since 0.1.0
 */
export type Entry = typeof Entry.Type

/**
 * Every step the generator turned into a target. `maxJobs` is the most of
 * these targets that may run at once; a caller never exceeds it. It is 1
 * while generated targets share one working tree.
 *
 * @category models
 * @since 0.1.0
 */
export const TargetMap = Schema.Struct({
  version: Schema.Literal(1),
  targets: Schema.Array(Entry),
  maxJobs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))
})

/**
 * A decoded `TargetMap`.
 *
 * @category models
 * @since 0.1.0
 */
export type TargetMap = typeof TargetMap.Type

/**
 * One text for a variant, whatever order its keys were written in.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const variantKey = (variant: Readonly<Record<string, string>>): string =>
  JSON.stringify(Object.entries(variant).sort(([a], [b]) => (a < b ? -1 : 1)))

/**
 * The label of the target that runs a step, or `undefined` when the
 * generator made none for it.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const labelOf = (
  map: TargetMap,
  job: string,
  step: string,
  variant: Readonly<Record<string, string>>
): string | undefined => {
  const key = variantKey(variant)
  return map.targets.find((entry) => entry.job === job && entry.step === step && variantKey(entry.variant) === key)
    ?.label
}

/**
 * The labels of every target that runs a step: one, or several when the
 * step was split. Empty when the generator made none for it.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const labelsOf = (
  map: TargetMap,
  job: string,
  step: string,
  variant: Readonly<Record<string, string>>
): ReadonlyArray<string> => {
  const key = variantKey(variant)
  return map.targets
    .filter((entry) => entry.job === job && entry.step === step && variantKey(entry.variant) === key)
    .map((entry) => entry.label)
}
