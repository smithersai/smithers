/**
 * What a person sees when something fails: one plain sentence, whose fault it
 * is, and the buttons that can fix it.
 *
 * Every failure a surface can show is a tagged error (`Schema.TaggedError` or
 * `Data.TaggedError`, so it carries `_tag`). A surface lists the tags it can
 * receive in a `UserFailureRegistry`, a mapped type over the tag union: a tag
 * with no entry does not compile, and neither does an entry for a tag the
 * union lacks. Exception detail is redacted before it reaches any surface;
 * a collapsed Details control is still a disclosure of that text.
 *
 * An error with no registered tag is unknown. It gets one generic sentence,
 * the surface's fallback actions, and a report to `onUnknown`, and its message
 * never becomes the sentence.
 *
 * The fault classes are `PlueFault`, the one taxonomy every refusal already
 * uses; there is no second model.
 *
 * @since 1.0.0
 */

import type { PlueFault } from "./PlueFailureCodes.ts"

/**
 * Every action a failure can offer, as a stable id a surface maps to a button.
 *
 * `retry` reloads or repeats the act; `reset-local-data` erases this browser's
 * saved Smithers data after a confirmation; `download-recovery` saves a local
 * recovery file first; `sign-in` opens the sign-in door; `use-here` moves the
 * one writer from another tab to this one.
 *
 * @since 1.0.0
 * @category constants
 */
export const USER_FAILURE_ACTIONS = ["retry", "reset-local-data", "download-recovery", "sign-in", "use-here"] as const

/**
 * One action a failure offers.
 *
 * @since 1.0.0
 * @category models
 */
export type UserFailureAction = (typeof USER_FAILURE_ACTIONS)[number]

/**
 * The words and buttons for one failure, without its raw detail.
 *
 * @since 1.0.0
 * @category models
 */
export interface UserFailureCopy {
  /** Who caused it. `user` only when the person can fix it themselves. */
  readonly fault: PlueFault
  /** One plain sentence in product words. Never an error message. */
  readonly sentence: string
  /** The buttons, in the order the surface shows them. */
  readonly actions: ReadonlyArray<UserFailureAction>
}

/**
 * A failure ready to render.
 *
 * @since 1.0.0
 * @category models
 */
export interface UserFailure extends UserFailureCopy {
  /** The registered `_tag`, or `null` for an unknown error. */
  readonly tag: string | null
  /** Redaction placeholder. Exception messages, stacks and causes never reach the surface. */
  readonly detail: string
}

/**
 * Anything with a string `_tag`: every Effect tagged error.
 *
 * @since 1.0.0
 * @category models
 */
export interface TaggedFailure {
  readonly _tag: string
}

/**
 * The copy for every tag in the union `E`, keyed by `_tag`.
 *
 * An entry is either fixed copy or a function of the narrowed error, for a
 * variant whose words depend on its fields.
 *
 * @since 1.0.0
 * @category models
 */
export type UserFailureRegistry<E extends TaggedFailure> = {
  readonly [K in E["_tag"]]: UserFailureCopy | ((failure: Extract<E, { readonly _tag: K }>) => UserFailureCopy)
}

/**
 * The copy an unknown error gets when a surface names no fallback of its own.
 *
 * @since 1.0.0
 * @category constants
 */
export const UNKNOWN_FAILURE: UserFailureCopy = {
  fault: "bug",
  sentence: "Something went wrong on our side. Not your fault.",
  actions: ["retry"]
}

/**
 * How a surface presents failures.
 *
 * @since 1.0.0
 * @category models
 */
export interface UserFailureOptions {
  /** Called once per unknown error, e.g. the client error reporter. */
  readonly onUnknown?: (error: unknown) => void
  /** The unknown copy for this surface. Defaults to `UNKNOWN_FAILURE`. */
  readonly unknown?: UserFailureCopy
}

const MAX_CAUSE_DEPTH = 8

const tagOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  try {
    const tag = (value as { readonly _tag?: unknown })._tag
    return typeof tag === "string" ? tag : undefined
  } catch {
    return undefined
  }
}

const causeOf = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return undefined
  try {
    return (value as { readonly cause?: unknown }).cause
  } catch {
    return undefined
  }
}

/**
 * A redaction placeholder for any thrown value. Exception messages, stacks,
 * causes and arbitrary objects can all contain credentials or user content;
 * without a secret inventory they cannot be safely partially redacted.
 * Never inspects or serializes the value, and never throws. The presentation's
 * registered tag, fault and actions remain available for diagnostics.
 *
 * @since 1.0.0
 * @category utils
 */
export const failureDetail = (_error: unknown): string => "[REDACTED]"

/**
 * Present one thrown value.
 *
 * The first error in the `cause` chain whose `_tag` the registry lists wins,
 * so a boot step that wraps a tagged cause still shows the cause's copy.
 * Anything else is unknown: the fallback copy, `tag: null`, and `onUnknown`.
 * A registered formatter that throws on a malformed failure is unknown too:
 * its exception never replaces the failure being shown.
 *
 * @since 1.0.0
 * @category constructors
 */
export const presentUserFailure = <E extends TaggedFailure>(
  registry: UserFailureRegistry<E>,
  error: unknown,
  options: UserFailureOptions = {}
): UserFailure => {
  const entries = registry as Readonly<Record<string, UserFailureCopy | ((failure: never) => UserFailureCopy)>>
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    const tag = tagOf(current)
    if (tag !== undefined && Object.hasOwn(entries, tag)) {
      const entry = entries[tag]!
      try {
        // A formatter reads fields its tag promises; a value that only carries the tag can make it throw.
        const copy = typeof entry === "function" ? entry(current as never) : entry
        return { tag, fault: copy.fault, sentence: copy.sentence, actions: copy.actions, detail: failureDetail(error) }
      } catch {
        break
      }
    }
    current = causeOf(current)
  }
  try {
    options.onUnknown?.(error)
  } catch {
    // A reporter that throws must not replace the failure being shown.
  }
  const copy = options.unknown ?? UNKNOWN_FAILURE
  return { tag: null, fault: copy.fault, sentence: copy.sentence, actions: copy.actions, detail: failureDetail(error) }
}
