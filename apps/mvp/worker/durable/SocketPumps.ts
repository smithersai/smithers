import { type Cause, Deferred, Effect, type Fiber, Queue, type Scope } from "effect"
import { coalesced } from "../SocketAccess.ts"

// Durable Object instance-owned socket pump coordination (BranchSandboxes): the object's one fiber that runs what a
// socket's own event asks for, and the order a viewer is registered and its pump started in. Like
// worker/durable/SocketHost.ts, these hold per-object waits, so stateless Workers must never import this module
// (worker/BranchSandboxes.test.ts enforces that).

/**
 * The object's notifier for lapsed leases, built once with the object. A gate calls it from a socket's own event,
 * outside any effect, and one fiber in `scope` (the object's own, for as long as it is in memory) runs the renewal it
 * asked for with the services the object was built with: nothing is run through a captured runtime, and no request's
 * context outlives its request. A burst of frames on lapsed leases asks for one renewal (`SocketAccess.coalesced`); a
 * renewal that dies is handed to `died` and the next one still runs.
 */
export const lapsedRenewals = <R, RD>(
  renewDue: Effect.Effect<void, never, R>,
  scope: Scope.Scope,
  died: (cause: Cause.Cause<never>) => Effect.Effect<void, never, RD>,
) =>
  Effect.gen(function* () {
    const asked = yield* Queue.unbounded<Effect.Effect<void, never, R>>()
    yield* Effect.forkIn(
      Effect.forever(Effect.flatMap(Queue.take(asked), (renewal) => Effect.catchCause(renewal, died))),
      scope,
    )
    return coalesced<R>(renewDue, (renewal) => Queue.offerUnsafe(asked, renewal))
  })

/**
 * Starts a socket's pump in `scope` only once its viewer is registered: `run` is given the effect that waits for the
 * registration, and `register` hears the fiber before `run` passes that wait, so a pump that ends at once still finds,
 * and removes, its own entry. The fork and the registration are one uninterruptible step, so neither is left without
 * the other; the pump itself stays interruptible.
 */
export const attachRegistered = <A, E, R>(
  run: (registered: Effect.Effect<void>) => Effect.Effect<A, E, R>,
  register: (fiber: Fiber.Fiber<A, E>) => void,
  scope: Scope.Scope,
) =>
  Effect.uninterruptible(Effect.gen(function* () {
    const registered = Deferred.makeUnsafe<void>()
    const fiber = yield* Effect.forkIn(Effect.interruptible(run(Deferred.await(registered))), scope)
    register(fiber)
    Deferred.doneUnsafe(registered, Effect.void)
    return fiber
  }))
