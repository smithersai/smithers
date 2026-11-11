/**
 * Repository workflow policy values, independent of GitHub mirroring and
 * artifact-test execution policy. These values declare preferences, never
 * capabilities: hosts still authorize every action and notification recipient.
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"
import * as Home from "./Home.vibe"

// Validate the input before Struct can discard excess keys. The check travels
// with the schema, including when it is nested in a decoded factory projection.
const strictStruct = <Fields extends Schema.Struct.Fields>(name: string, fields: Fields) =>
  Schema.Unknown.check(Schema.makeFilter((value) => {
    try {
      Home.plainOptions(name, value, new Set(Object.keys(fields)))
      return true
    } catch {
      return `${name} must be a plain object containing only its declared fields`
    }
  })).pipe(Schema.decodeTo(Schema.Struct(fields)))

/**
 * Default classification for newly authored documents and tests. An artifact
 * records a point in time; it does not exempt a test from CI or a blocking gate.
 * The independent Factory.lifecycle policy controls artifact-test execution.
 * @category schemas
 * @since 1.0.0
 */
export const Lifecycle = strictStruct("Factory policy lifecycle", {
  docs: Schema.Literals(["evergreen", "artifact"]),
  tests: Schema.Literals(["evergreen", "artifact"])
})

const Time = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/))

/**
 * A daily, half-open UTC quiet interval. An end before its start crosses
 * midnight; equal endpoints are refused instead of silently muting all day.
 * Quiet handling suppresses toasts, never delivery or access checks.
 * @category schemas
 * @since 1.0.0
 */
export const QuietHours = strictStruct("Factory policy quiet hours", {
  start: Time,
  end: Time,
  timeZone: Schema.Literal("UTC")
}).check(
  Schema.makeFilter((value) => value.start !== value.end || "quiet hours must have distinct start and end times")
)

/**
 * Notification handling preferences. The host's repository policy flow selects
 * recipients separately, and the host intersects those recipients with access.
 * @category schemas
 * @since 1.0.0
 */
export const Notifications = strictStruct("Factory policy notifications", {
  quietHours: Schema.Array(QuietHours).check(Schema.isMaxLength(24))
})

/**
 * Person-only operations cannot be delegated by repository policy. These
 * declarations never replace the host-owned ApprovalAuthority service or its
 * authenticated identity checks, including for a pre-approved operation.
 * @category schemas
 * @since 1.0.0
 */
export const Approvals = strictStruct("Factory policy approvals", {
  approve: Schema.Literal("person"),
  merge: Schema.Literal("person")
})

/**
 * The complete, validated policy carried by a factory projection.
 * @category schemas
 * @since 1.0.0
 */
export const Policy = strictStruct("Factory policy", {
  lifecycle: Lifecycle,
  notifications: Notifications,
  approvals: Approvals
})

/**
 * Normalized repository policy; no executable callbacks or authority grants.
 * @category models
 * @since 1.0.0
 */
export type Policy = typeof Policy.Type

/**
 * Inline options for `S.Factory({ summary, policy: { ... } })`. Omitted fields
 * keep evergreen classification, ordinary notification handling and person-only
 * approval and merge. Omission never opts a repository into artifact exemptions.
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly lifecycle?: Partial<Policy["lifecycle"]> | undefined
  readonly notifications?: Partial<Policy["notifications"]> | undefined
  readonly approvals?: Partial<Policy["approvals"]> | undefined
}

/**
 * Validates, copies and deeply freezes a policy. Use the same defaults for an
 * older factory projection with no policy; malformed supplied values fail.
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options = {}): Policy => {
  const plain = Home.plainOptions("Factory policy", options, new Set(["lifecycle", "notifications", "approvals"]))
  const lifecycle = Home.plainOptions(
    "Factory policy lifecycle",
    plain["lifecycle"] === undefined ? {} : plain["lifecycle"],
    new Set(["docs", "tests"])
  )
  const notifications = Home.plainOptions(
    "Factory policy notifications",
    plain["notifications"] === undefined ? {} : plain["notifications"],
    new Set(["quietHours"])
  )
  const approvals = Home.plainOptions(
    "Factory policy approvals",
    plain["approvals"] === undefined ? {} : plain["approvals"],
    new Set(["approve", "merge"])
  )
  return Home.freezeDeep(Home.decode("Factory policy", Policy, {
    lifecycle: { docs: "evergreen", tests: "evergreen", ...lifecycle },
    notifications: { quietHours: [], ...notifications },
    approvals: { approve: "person", merge: "person", ...approvals }
  }))
}
