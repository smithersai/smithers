/**
 * The events a repository binds its flows to, as data.
 *
 * `FACTORY.ts` writes `Trigger.bind({ flow, on: On.push({ branches: ["main"] }) })`
 * (ruling FLOW-10). Each constructor returns a plain value; nothing here listens
 * for an event. The factory projection writes the binding into
 * `.smithers/factory.json` as a `contributes.triggers` row, and the host that
 * receives the event matches it there.
 *
 * @see packages/smithers/agent/triggers/docs/api.md
 *
 * @since 1.1.0
 */

import * as Schema from "effect/Schema"
import * as Schedule from "./Schedule.ts"

/**
 * At most 32 globs of 1 to 255 characters: `*` is any run of characters but
 * `/`, `**` any run at all.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Patterns = Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))).check(
  Schema.isMaxLength(32)
)

/**
 * A push: to the `branches` globs, or to every branch when absent. A tag push
 * matches only a binding that names `tags`, and one naming only `tags` matches
 * no branch.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Push = Schema.TaggedStruct("Push", {
  branches: Schema.optionalKey(Patterns),
  tags: Schema.optionalKey(Patterns)
})

/**
 * A pull request against the `branches` globs (every base branch when absent),
 * on its `actions` (`opened`, `synchronize` and `reopened` when absent).
 *
 * @category schemas
 * @since 1.1.0
 */
export const PullRequest = Schema.TaggedStruct("PullRequest", {
  branches: Schema.optionalKey(Patterns),
  actions: Schema.optionalKey(Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(32)))
})

/**
 * A person runs the flow by hand; the form is the flow's payload.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Manual = Schema.TaggedStruct("Manual", {})

/**
 * A schedule: five cron fields and the {@link Schedule.Schedule} policies.
 * Only the policies written are carried; the host applies the package's
 * defaults to the rest.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Cron = Schema.TaggedStruct("Cron", {
  cron: Schema.NonEmptyString.check(Schema.isPattern(/^\S+( \S+){4}$/)),
  timezone: Schema.optionalKey(Schema.NonEmptyString),
  overlap: Schema.optionalKey(Schedule.Overlap),
  catchUp: Schema.optionalKey(Schedule.CatchUp),
  maxCatchUp: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Schedule.maxCatchUpLimit))
  )
})

/**
 * Any event a flow can be bound to.
 *
 * @category schemas
 * @since 1.1.0
 */
export const On = Schema.Union([Push, PullRequest, Manual, Cron])

/**
 * Any event a flow can be bound to.
 *
 * @category models
 * @since 1.1.0
 */
export type On = typeof On.Type

/**
 * A push to the branches or tags the filter names; every branch when it names
 * neither.
 *
 * @example
 * ```ts
 * import { On } from "@smthrs/triggers"
 *
 * const mainPush = On.push({ branches: ["main"] })
 * ```
 *
 * @category constructors
 * @since 1.1.0
 */
export const push = (
  filter: { readonly branches?: ReadonlyArray<string>; readonly tags?: ReadonlyArray<string> } = {}
): typeof Push.Type => ({ _tag: "Push", ...filter })

/**
 * A pull request against the base branches the filter names, on its actions.
 *
 * @category constructors
 * @since 1.1.0
 */
export const pullRequest = (
  filter: { readonly branches?: ReadonlyArray<string>; readonly actions?: ReadonlyArray<string> } = {}
): typeof PullRequest.Type => ({ _tag: "PullRequest", ...filter })

/**
 * A run a person starts by hand.
 *
 * @category constructors
 * @since 1.1.0
 */
export const manual = (): typeof Manual.Type => ({ _tag: "Manual" })

/**
 * A schedule of five cron fields, with the policies written.
 *
 * @example
 * ```ts
 * import { On } from "@smthrs/triggers"
 *
 * const nightly = On.cron("23 3 * * *", { overlap: "skip" })
 * ```
 *
 * @category constructors
 * @since 1.1.0
 */
export const cron = (
  expression: string,
  policy: {
    readonly timezone?: string
    readonly overlap?: Schedule.Overlap
    readonly catchUp?: Schedule.CatchUp
    readonly maxCatchUp?: number
  } = {}
): typeof Cron.Type => ({ _tag: "Cron", cron: expression, ...policy })
