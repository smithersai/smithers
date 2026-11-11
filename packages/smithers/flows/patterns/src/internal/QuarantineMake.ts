/**
 * The declaration side of `Quarantine`: its types, the outcome refinements,
 * and `all`, which throws a `PatternError` for a declaration it cannot build.
 * `Quarantine.vibe` re-exports all of it beside `run` and `settle`, the
 * pattern's Effect forms.
 *
 * @since 1.0.0
 */

import * as Node from "@smthrs/plan/Node"
import type { PatternError } from "../PatternError.ts"
import * as Compose from "./Compose.ts"

/**
 * What a failing member does to its siblings.
 *
 * `quarantine` isolates it. `halt` is the ordinary join: the first failure
 * interrupts every sibling still running.
 *
 * @category models
 * @since 1.0.0
 */
export type Policy = "quarantine" | "halt"

/**
 * A member that failed and was isolated from its siblings.
 *
 * This is one arm of the structural wire envelope used for durable replay.
 * Successful member values are always nested in {@link Succeeded}, so user
 * values can never collide with this protocol tag.
 *
 * @category models
 * @since 1.0.0
 */
export interface Quarantined<E> {
  readonly _tag: "Quarantined"
  readonly member: string
  readonly error: E
}

/**
 * A member that completed successfully.
 *
 * The value is nested so a legitimate user value can have any shape,
 * including the complete `Quarantined` wire shape, without being mistaken for
 * protocol metadata.
 *
 * @category models
 * @since 1.0.0
 */
export interface Succeeded<A> {
  readonly _tag: "Succeeded"
  readonly member: string
  readonly value: A
}

/**
 * One unambiguous member outcome under the quarantine policy.
 *
 * @category models
 * @since 1.0.0
 */
export type Settled<A, E> = Succeeded<A> | Quarantined<E>

/**
 * Configuration for {@link all}.
 *
 * @category models
 * @since 1.0.0
 */
export interface AllOptions {
  readonly policy: Policy
}

/**
 * Configuration for {@link run}.
 *
 * `concurrency` bounds how many members run at once and defaults to
 * unbounded.
 *
 * @category models
 * @since 1.0.0
 */
export interface RuntimeOptions {
  readonly policy: Policy
  readonly concurrency?: number | "unbounded" | undefined
}

/**
 * Tests whether a joined member was quarantined.
 *
 * The check reads the complete structural wire envelope without invoking
 * accessors. Successful user values are nested in {@link Succeeded}, so their
 * own shape is never interpreted as protocol metadata.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isQuarantined = (value: unknown): value is Quarantined<unknown> => outcome(value, "Quarantined", "error")

/**
 * Tests whether a joined member completed successfully.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isSucceeded = (value: unknown): value is Succeeded<unknown> => outcome(value, "Succeeded", "value")

const data = (value: object, key: string): PropertyDescriptor | undefined => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor ? descriptor : undefined
  } catch {
    return undefined
  }
}

const outcome = (value: unknown, tag: "Succeeded" | "Quarantined", payload: "value" | "error"): boolean => {
  if (typeof value !== "object" || value === null) return false
  let keys: ReadonlyArray<string>
  try {
    keys = Object.keys(value)
  } catch {
    return false
  }
  if (keys.length !== 3 || !keys.includes("_tag") || !keys.includes("member") || !keys.includes(payload)) return false
  return data(value, "_tag")?.value === tag && typeof data(value, "member")?.value === "string" &&
    data(value, payload) !== undefined
}

/**
 * Shared with `run` in `Quarantine.vibe`.
 *
 * @since 1.0.0
 * @private
 */
export const succeeded = <A>(member: string, value: A): Succeeded<A> =>
  Object.freeze({ _tag: "Succeeded", member, value })

/**
 * Shared with `run` in `Quarantine.vibe`.
 *
 * @since 1.0.0
 * @private
 */
export const quarantined = <E>(member: string, error: E): Quarantined<E> =>
  Object.freeze({ _tag: "Quarantined", member, error })

// Every refusal is minted once, as a value. `all` throws it, because a
// declaration is built eagerly and a broken one is a programming error. `run`
// FAILS with it, because `PatternError` is in its declared error channel and a
// caller composing it must be able to claim the refusal with `Effect.catchTag`.
// A thrown refusal inside `Effect.suspend` would be a defect no handler claims.
/**
 * Shared with `run` in `Quarantine.vibe`.
 *
 * @since 1.0.0
 * @private
 */
export const nonEmptyRefusal = (names: ReadonlyArray<string>): PatternError | undefined =>
  Compose.nonEmptyMembersRefusal("Quarantine", names)

// `"unbounded"` is the declared way to ask for no bound, so only a numeric one
// is checked.
/**
 * Shared with `run` in `Quarantine.vibe`.
 *
 * @since 1.0.0
 * @private
 */
export const widthRefusal = (concurrency: number | "unbounded"): PatternError | undefined =>
  concurrency === "unbounded" ? undefined : Compose.concurrencyRefusal("Quarantine", concurrency)

const nonEmpty = (names: ReadonlyArray<string>): void => {
  const refusal = nonEmptyRefusal(names)
  if (refusal !== undefined) throw refusal
}

/**
 * Joins a record of members under the declared failure policy.
 *
 * Under `quarantine` every member settles as an explicit {@link Settled}
 * envelope: success becomes {@link Succeeded} and failure becomes
 * {@link Quarantined}. The declaration shows one `Catch` per member and the
 * join can no longer fail on a member's behalf. Under `halt` the join is a
 * plain `Node.all` and preserves raw successful values.
 *
 * @category constructors
 * @since 1.0.0
 */
export function all(
  members: Readonly<Record<string, Node.Any>>,
  options: AllOptions & { readonly policy: "quarantine" }
): Node.Node<Readonly<Record<string, Settled<unknown, unknown>>>, never, any>
export function all(
  members: Readonly<Record<string, Node.Any>>,
  options: AllOptions & { readonly policy: "halt" }
): Node.Node<Readonly<Record<string, unknown>>, unknown, any>
export function all(
  members: Readonly<Record<string, Node.Any>>,
  options: AllOptions
): Node.Node<Readonly<Record<string, unknown | Settled<unknown, unknown>>>, unknown, any> {
  const names = Object.keys(members)
  nonEmpty(names)
  if (options.policy === "halt") return Node.all(members)
  const isolated = Object.fromEntries(
    names.map((member) => [
      member,
      Node.catch(
        Node.map(
          members[member]!,
          Node.capture({ member, outcome: "Succeeded" }, (value: unknown) => succeeded(member, value))
        ),
        {
          onFailure: Node.capture(
            { member, outcome: "Quarantined" },
            (error: unknown) => Node.succeed(quarantined(member, error))
          )
        }
      )
    ])
  ) as Record<string, Node.Any>
  return Node.all(isolated)
}
