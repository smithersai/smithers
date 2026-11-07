/**
 * The writer elections of a program's persisted synced collections, as one
 * `Persistence` service holds them: each collection's first role, so a report
 * can sum them in one line once they are taken.
 *
 * @since 0.3.0
 */

import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import type { Role } from "./oneWriter.ts"

/**
 * How many of a program's persisted synced collections first took each role.
 *
 * @category models
 * @since 0.3.0
 */
export interface Roles {
  readonly writers: number
  readonly watchers: number
}

/**
 * One collection's election.
 *
 * @category models
 * @since 0.3.0
 */
export interface Election {
  /**
   * Hears a role the program took, and answers whether it is logged at Info: a change of role, or a first role no
   * report counts. A first role a report counts is logged at Debug.
   */
  readonly took: (role: Role) => Effect.Effect<boolean>
  /** The election is over: a first role it never took counts as none, so a report waiting for it goes on. */
  readonly ended: Effect.Effect<void>
}

/**
 * A program's elections.
 *
 * @category models
 * @since 0.3.0
 */
export interface Elections {
  /** Starts a collection's election, counted by a report unless one has started already. */
  readonly begin: Effect.Effect<Election>
  /**
   * Waits for the first role, or the end, of every election begun before it, then logs `persisted sync roles` at Info
   * with how many first took each role, and answers them. Elections begun after the first report are not counted.
   */
  readonly report: Effect.Effect<Roles>
}

/**
 * New elections, with no report yet.
 *
 * @category constructors
 * @since 0.3.0
 */
export const make = (): Elections => {
  // Once a report starts, a new election's first role is logged at Info: no report counts it.
  let reported = false
  const firsts: Array<Deferred.Deferred<Role | undefined>> = []
  return {
    begin: Effect.sync(() => {
      const counted = !reported
      const first = Deferred.makeUnsafe<Role | undefined>()
      if (counted) firsts.push(first)
      let taken = false
      return {
        took: (role) =>
          Effect.suspend(() => {
            if (taken) return Effect.succeed(true)
            taken = true
            return Effect.as(Deferred.succeed(first, role), !counted)
          }),
        ended: Effect.asVoid(Deferred.succeed(first, undefined))
      }
    }),
    report: Effect.suspend(() => {
      reported = true
      return Effect.forEach([...firsts], Deferred.await).pipe(
        Effect.map((roles): Roles => ({
          writers: roles.filter((role) => role === "writer").length,
          watchers: roles.filter((role) => role === "watcher").length
        })),
        Effect.tap((roles) => Effect.logInfo("persisted sync roles").pipe(Effect.annotateLogs({ ...roles })))
      )
    })
  }
}

// A program's elections, by the `Persistence` service its collections were made with.
const byService = new WeakMap<object, Elections>()

/**
 * The elections of the collections made with `service`.
 *
 * @category constructors
 * @since 0.3.0
 */
export const of = (service: object): Elections => {
  let elections = byService.get(service)
  if (elections === undefined) {
    elections = make()
    byService.set(service, elections)
  }
  return elections
}
