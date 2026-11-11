/**
 * Durable trigger declarations.
 *
 * @see packages/smithers/agent/triggers/docs/api.md
 *
 * @since 0.1.0
 */

import type * as Flow from "@smthrs/flow/Flow"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as On from "./On.ts"
import * as Schedule from "./Schedule.ts"
import { fromSchemaError, type TriggerError } from "./TriggerError.ts"

/**
 * How a trigger behaves when an occurrence arrives while its previous run
 * is still going.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Overlap = Schedule.Overlap
/**
 * The decoded form of {@link Overlap}.
 *
 * @category models
 * @since 0.1.0
 */
export type Overlap = Schedule.Overlap
/**
 * How many missed occurrences a trigger owes after downtime.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CatchUp = Schedule.CatchUp
/**
 * The decoded form of {@link CatchUp}.
 *
 * @category models
 * @since 0.1.0
 */
export type CatchUp = Schedule.CatchUp

/**
 * A trigger declaration: which flow to run, with what input, on what
 * schedule.
 *
 * `input` is JSON rather than `unknown` because the store persists it with
 * `JSON.stringify` into a `NOT NULL` column. The schema refuses `undefined`,
 * `NaN`, a `Date`, and functions at the declaration boundary.
 * Enumerable getters are accepted when their values are JSON. They are
 * evaluated during decoding and again during SQL serialization. Every store
 * takes an eager serialized snapshot before returning its Effect; use plain
 * JSON values for stable input across reads.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Trigger = Schema.Struct({
  id: Schema.NonEmptyString,
  flowId: Schema.NonEmptyString,
  input: Schema.Json,
  ...Schedule.Schedule.fields,
  enabled: Schema.Boolean
})
/**
 * The decoded form of {@link Trigger}.
 *
 * @category models
 * @since 0.1.0
 */
export type Trigger = typeof Trigger.Type

/**
 * Decodes and validates a trigger declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (input: unknown): Effect.Effect<Trigger, TriggerError> =>
  Schema.decodeUnknownEffect(Trigger)(input).pipe(
    Effect.mapError((cause) => fromSchemaError("invalid_trigger", "Trigger declaration is invalid", cause)),
    Effect.flatMap(Schedule.validate)
  )

/**
 * A flow bound to an event, as `FACTORY.ts` declares it: decision 0017's
 * `Trigger` contribution. `flow` is the bound flow's tag, taken from the
 * imported flow value; `title` is what a person reads for it (the Run form of a
 * manual binding).
 *
 * @category schemas
 * @since 1.1.0
 */
export const Binding = Schema.TaggedStruct("TriggerBinding", {
  flow: Schema.NonEmptyString,
  on: On.On,
  title: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(80)))
})

/**
 * A flow bound to an event.
 *
 * @category models
 * @since 1.1.0
 */
export type Binding = typeof Binding.Type

/**
 * Binds an imported flow to an event: "config binds; code composes" (decision
 * 0017). The result is data; the host that receives the event starts the flow.
 *
 * @example
 * ```ts
 * import { On, Trigger } from "@smthrs/triggers"
 * import Gate from "./flows/gate/flow.ts"
 *
 * export const gateOnMain = Trigger.bind({ flow: Gate, on: On.push({ branches: ["main"] }) })
 * ```
 *
 * @category constructors
 * @since 1.1.0
 */
export const bind = (options: {
  readonly flow: Pick<Flow.Any, "_tag">
  readonly on: On.On
  readonly title?: string
}): Binding => ({
  _tag: "TriggerBinding",
  flow: options.flow._tag,
  on: options.on,
  ...(options.title === undefined ? {} : { title: options.title })
})

const manifestEvents = {
  Push: "github.push",
  PullRequest: "github.pull_request",
  Manual: "manual",
  Cron: "cron"
} as const

/**
 * One `contributes.triggers` row of a plugin manifest: the event's name, the
 * flow, the title, and the event's filters or schedule fields beside them.
 *
 * @category schemas
 * @since 1.1.0
 */
export const ManifestRow = Schema.Struct({
  on: Schema.Literals(["github.push", "github.pull_request", "manual", "cron"]),
  flow: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  branches: Schema.optionalKey(On.Patterns),
  tags: Schema.optionalKey(On.Patterns),
  actions: On.PullRequest.fields.actions,
  cron: Schema.optionalKey(On.Cron.fields.cron),
  timezone: On.Cron.fields.timezone,
  overlap: On.Cron.fields.overlap,
  catchUp: On.Cron.fields.catchUp,
  maxCatchUp: On.Cron.fields.maxCatchUp
})

/**
 * One `contributes.triggers` row of a plugin manifest.
 *
 * @category models
 * @since 1.1.0
 */
export type ManifestRow = typeof ManifestRow.Type

/**
 * The manifest row for `binding`, contributed as `id`: titled `id` unless the
 * binding names a title.
 *
 * @category constructors
 * @since 1.1.0
 */
export const manifestRow = (id: string, binding: Binding): ManifestRow => {
  const { _tag, ...fields } = binding.on
  return { on: manifestEvents[_tag], flow: binding.flow, title: binding.title ?? id, ...fields }
}
