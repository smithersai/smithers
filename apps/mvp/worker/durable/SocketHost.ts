import { Cause, Clock, Deferred, Effect, type Scope } from "effect"
import { codeOf } from "../ErrorCode.ts"
import { actAt, type Admission, LEASE_MS, nextRenewal } from "../SocketAccess.ts"

// Durable Object instance-owned socket lease coordination (BranchRooms, BranchSandboxes, RunContent).
// Stateless Workers must never import this module; worker/durable/boundary.test.ts enforces that rule.

/**
 * One renewal at a time per host: a caller that finds one running waits for it instead of starting its own, so a burst
 * of frames on lapsed leases costs one renewal, not one each.
 */
export const singleFlight = () => {
  let running: Deferred.Deferred<void> | undefined
  return <E, R>(renewal: Effect.Effect<void, E, R>): Effect.Effect<void, E, R> =>
    Effect.suspend(() => {
      if (running !== undefined) return Deferred.await(running)
      const done = Deferred.makeUnsafe<void>()
      running = done
      return renewal.pipe(Effect.ensuring(Effect.suspend(() => {
        running = undefined
        return Deferred.succeed(done, undefined)
      })))
    })
}


/**
 * The renewal loop of a host that never hibernates while a socket is open: it sleeps until `nextRenewal` of `leases()`,
 * runs `renewDue`, and ends when no lease is left. Beside it, an expiry timer sleeps until the earliest cached session
 * end and runs `expire`. The terminal supplies its same bounded, single-flight authority check to both: frames remain
 * blocked while it verifies an extension or confirms an end. Both run only while the host holds a lease (`ensure`); a new lease acted on, or a session
 * ending, before a running child's wake wakes it sooner. It never cancels a renewal that runs, and a later lease never
 * moves a wake.
 */
export const renewalLoop = <R, RE>(
  leases: () => ReadonlyArray<{ readonly admission: Admission; readonly leaseUntil: number }>,
  renewDue: Effect.Effect<void, never, R>,
  expire: Effect.Effect<void, never, RE>,
  host: string,
) => {
  /** A sleep until `at` that `wakeIf` can cut short for a sooner time. */
  const timer = () => {
    let wakeAt: number | undefined
    let wake = Deferred.makeUnsafe<void>()
    const sleep = (at: number, now: number) =>
      Effect.suspend(() => {
        wake = Deferred.makeUnsafe<void>()
        wakeAt = at
        return Effect.raceFirst(Effect.sleep(at - now), Deferred.await(wake))
      }).pipe(Effect.ensuring(Effect.sync(() => void (wakeAt = undefined))))
    const wakeIf = (at: number) => {
      if (wakeAt !== undefined && at < wakeAt) Deferred.doneUnsafe(wake, Effect.void)
    }
    return { sleep, wakeIf }
  }
  const renewal = timer()
  const expiry = timer()
  /**
   * One owner per child: `ensure` reserves the slot in the step that finds it empty, before it forks, so concurrent
   * attaches start one child. The owner frees the slot when it finds the host empty, in the same step that checks, or
   * when it dies or is interrupted, and then only its own reservation; the next attach starts it again.
   */
  const child = (
    loop: "renewal" | "expiry",
    timed: ReturnType<typeof timer>,
    next: (now: number) => number,
    act: Effect.Effect<void, never, R | RE>,
  ) => {
    let owner: object | undefined
    const run = (me: object) => {
      const free = () => {
        if (owner === me) owner = undefined
      }
      return Effect.gen(function* () {
        for (;;) {
          const empty = yield* Effect.sync(() => {
            if (leases().length > 0) return false
            free()
            return true
          })
          if (empty) return
          const now = yield* Clock.currentTimeMillis
          yield* timed.sleep(next(now), now)
          yield* act
        }
      }).pipe(
        Effect.onError((cause) =>
          // The slot is free before anything reads the failure.
          Effect.andThen(
            Effect.sync(free),
            Effect.suspend(() =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logError("socket.loop").pipe(
                  Effect.annotateLogs({ host, loop, outcome: "died", errorCode: codeOf(Cause.squash(cause)) }),
                )
            ),
          )
        ),
      )
    }
    /** Starts the child in `scope` unless one owns the slot; answers whether it did. */
    const start = (scope: Scope.Scope) =>
      Effect.uninterruptible(Effect.suspend(() => {
        if (owner !== undefined) return Effect.succeed(false)
        const me = {}
        owner = me
        return Effect.as(Effect.forkIn(run(me), scope), true)
      }))
    return start
  }
  const startRenewal = child("renewal", renewal, (now) => nextRenewal(leases(), now) ?? now + LEASE_MS, renewDue)
  const startExpiry = child("expiry", expiry, (now) => {
    const ends = leases().flatMap((lease) => lease.admission.expiresAt === null ? [] : [lease.admission.expiresAt])
    // With no session end to wait for, it sleeps a lease long; a viewer attaching with one wakes it.
    return ends.length === 0 ? now + LEASE_MS : Math.max(Math.min(...ends), now + 1)
  }, expire)
  /**
   * After a socket attaches: starts whichever child isn't running, in `scope`, and wakes a running one sooner for
   * `lease`. Emptying the host retires both; attaching always leaves both running.
   */
  const ensure = (scope: Scope.Scope, lease: { readonly admission: Admission; readonly leaseUntil: number }) =>
    Effect.gen(function* () {
      if (!(yield* startRenewal(scope))) renewal.wakeIf(actAt(lease.admission, lease.leaseUntil))
      if (!(yield* startExpiry(scope)) && lease.admission.expiresAt !== null) expiry.wakeIf(lease.admission.expiresAt)
    })
  return { ensure }
}
