import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Scope from "effect/Scope"
import { WebLock } from "../src/index.ts"

const name = () => `web-lock-${crypto.randomUUID()}`

/** Holds `lock` in a fresh scope and returns it, so a case can release it. */
const hold = (lock: WebLock.Service, lockName: string, options?: WebLock.HoldOptions) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const held = yield* lock.hold(lockName, options).pipe(Scope.provide(scope))
    return Object.assign(scope, { held })
  })

/** Who holds `lockName` now, and who waits for it, by client id. */
const holders = (lockName: string) =>
  Effect.promise(() => navigator.locks.query()).pipe(
    Effect.map((state) => ({
      held: (state.held ?? []).filter((info) => info.name === lockName).length,
      pending: (state.pending ?? []).filter((info) => info.name === lockName).length
    }))
  )

/**
 * Real Web Locks with only grant delivery paused, so interruption precedes
 * the adapter's callback. Acquisition, stealing and release stay native.
 */
const delayedGrant = () =>
  Effect.gen(function*() {
    const granted = yield* Deferred.make<void>()
    const delivery = yield* Deferred.make<void>()
    const settled = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(delivery, undefined))
    const lock = WebLock.make({
      request: (name, options, callback) =>
        navigator.locks.request(name, options, async (held) => {
          Deferred.doneUnsafe(granted, Exit.void)
          await Effect.runPromise(Deferred.await(delivery))
          return callback(held)
        }).finally(() => {
          Deferred.doneUnsafe(settled, Exit.void)
        })
    })
    return {
      lock,
      granted: Deferred.await(granted),
      deliver: Deferred.succeed(delivery, undefined),
      settled: Deferred.await(settled).pipe(Effect.timeout("5 seconds"))
    }
  })

describe("WebLock over navigator.locks", () => {
  it.live("grants the lock to one holder at a time, and to the next when the holder lets go", () =>
    Effect.gen(function*() {
      const lock = yield* WebLock.WebLock
      const lockName = name()
      const first = yield* hold(lock, lockName)
      const second = yield* Effect.forkChild(hold(lock, lockName))
      yield* Effect.sleep("50 millis")
      expect(second.pollUnsafe()).toBeUndefined()
      yield* Scope.close(first, Exit.void)
      yield* Scope.close(yield* Fiber.join(second), Exit.void)
    }).pipe(Effect.provide(WebLock.layer)))

  it.live("withdraws an interrupted wait, so it never takes the lock", () =>
    Effect.gen(function*() {
      const lock = yield* WebLock.WebLock
      const lockName = name()
      const first = yield* hold(lock, lockName)
      const waiting = yield* Effect.forkChild(hold(lock, lockName))
      yield* Effect.sleep("20 millis")
      yield* Fiber.interrupt(waiting)
      yield* Scope.close(first, Exit.void)
      yield* Effect.sleep("20 millis")
      const state = yield* Effect.promise(() => navigator.locks.query())
      expect([...(state.held ?? []), ...(state.pending ?? [])].some((info) => info.name === lockName)).toBe(false)
    }).pipe(Effect.provide(WebLock.layer)))

  it.effect("dies when the lock manager refuses the request", () =>
    Effect.gen(function*() {
      const refusing = WebLock.make({
        request: () => Promise.reject(new DOMException("reserved", "NotSupportedError"))
      })
      const exit = yield* refusing.hold("-reserved").pipe(Effect.scoped, Effect.exit)
      expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true)
    }))

  it.effect("gives back a lock granted in the moment its wait was interrupted", () =>
    Effect.gen(function*() {
      let grant: (() => Promise<void>) | undefined
      const late = WebLock.make({
        request: (_name, options, callback) =>
          new Promise((resolve) => {
            ;(options as { readonly signal: AbortSignal }).signal.addEventListener("abort", () => {
              grant = () => callback(undefined).then(resolve)
            })
          })
      })
      const waiting = yield* Effect.forkChild(late.hold("late").pipe(Effect.scoped))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(waiting)
      // The lock manager grants the withdrawn request anyway; the grant ends at once.
      yield* Effect.promise(() => grant!())
    }))

  it.live("steals a held lock at once; the holder learns it lost the lock and keeps no claim", () =>
    Effect.gen(function*() {
      const lock = yield* WebLock.WebLock
      const lockName = name()
      const first = yield* hold(lock, lockName)
      const lost = yield* Effect.forkChild(first.held.lost)
      const second = yield* hold(lock, lockName, { steal: true })
      yield* Fiber.join(lost)
      expect(yield* holders(lockName)).toEqual({ held: 1, pending: 0 })
      // Closing the robbed holder's scope gives back nothing it still holds.
      yield* Scope.close(first, Exit.void)
      expect(yield* holders(lockName)).toEqual({ held: 1, pending: 0 })
      const third = yield* Effect.forkChild(hold(lock, lockName))
      yield* Effect.sleep("20 millis")
      expect(third.pollUnsafe()).toBeUndefined()
      yield* Scope.close(second, Exit.void)
      yield* Scope.close(yield* Fiber.join(third), Exit.void)
    }).pipe(Effect.provide(WebLock.layer)))

  it.live("an interrupted steal still robs the holder and gives the granted lock back", () =>
    Effect.gen(function*() {
      const lock = yield* WebLock.WebLock
      const lockName = name()
      const first = yield* lock.hold(lockName)
      const delayed = yield* delayedGrant()
      const stealing = yield* delayed.lock.hold(lockName, { steal: true }).pipe(
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      yield* delayed.granted
      yield* Fiber.interrupt(stealing)
      yield* first.lost
      // Native ownership has moved, but the interrupted adapter has not seen the grant.
      expect(yield* holders(lockName)).toEqual({ held: 1, pending: 0 })
      yield* delayed.deliver
      yield* delayed.settled
      expect(yield* holders(lockName)).toEqual({ held: 0, pending: 0 })
      // A subsequent waiter can acquire and release it normally.
      yield* lock.hold(lockName).pipe(Effect.scoped)
    }).pipe(Effect.scoped, Effect.provide(WebLock.layer)))

  it.live("an interrupted tryHold on a free lock leaves no holder or waiter", () =>
    Effect.gen(function*() {
      const lock = yield* WebLock.WebLock
      const lockName = name()
      const delayed = yield* delayedGrant()
      const taking = yield* delayed.lock.tryHold(lockName).pipe(
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      yield* delayed.granted
      yield* Fiber.interrupt(taking)
      expect(yield* holders(lockName)).toEqual({ held: 1, pending: 0 })
      yield* delayed.deliver
      yield* delayed.settled
      expect(yield* holders(lockName)).toEqual({ held: 0, pending: 0 })
      yield* lock.hold(lockName).pipe(Effect.scoped)
    }).pipe(Effect.scoped, Effect.provide(WebLock.layer)))

  it.live("an interrupted tryHold on a held lock leaves its holder undisturbed", () =>
    Effect.gen(function*() {
      const lock = yield* WebLock.WebLock
      const lockName = name()
      const first = yield* lock.hold(lockName)
      const lost = yield* Effect.forkChild(first.lost)
      const delayed = yield* delayedGrant()
      const taking = yield* delayed.lock.tryHold(lockName).pipe(
        Effect.scoped,
        Effect.forkChild({ startImmediately: true })
      )
      yield* delayed.granted
      yield* Fiber.interrupt(taking)
      yield* delayed.deliver
      yield* delayed.settled
      expect(yield* holders(lockName)).toEqual({ held: 1, pending: 0 })
      expect(lost.pollUnsafe()).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(WebLock.layer)))

  it.live("steals a lock nobody holds, and a lock held to the end is never lost", () =>
    Effect.gen(function*() {
      const lock = yield* WebLock.WebLock
      const lockName = name()
      const stolen = yield* hold(lock, lockName, { steal: true })
      expect(yield* holders(lockName)).toEqual({ held: 1, pending: 0 })
      const lost = yield* Effect.forkChild(stolen.held.lost)
      yield* Scope.close(stolen, Exit.void)
      yield* Effect.sleep("20 millis")
      expect(lost.pollUnsafe()).toBeUndefined()
      expect(yield* holders(lockName)).toEqual({ held: 0, pending: 0 })
    }).pipe(Effect.provide(WebLock.layer)))

  it.effect("asks a steal without a signal, which the lock manager refuses alongside one", () =>
    Effect.gen(function*() {
      const asked: Array<unknown> = []
      const recording = WebLock.make({
        request: (_name, options, callback) => {
          asked.push(options)
          return callback(undefined)
        }
      })
      yield* recording.hold("asked", { steal: true }).pipe(Effect.scoped)
      yield* recording.hold("asked").pipe(Effect.scoped)
      expect(asked[0]).toEqual({ steal: true })
      expect(asked[1]).toEqual({ signal: expect.any(AbortSignal) })
    }))

  it.live("tryHold takes a free lock and holds it until the scope closes; a held one it answers none, at once, and waits for nothing", () =>
    Effect.gen(function*() {
      const lock = yield* WebLock.WebLock
      const lockName = name()
      const scope = yield* Scope.make()
      const taken = yield* lock.tryHold(lockName).pipe(Scope.provide(scope))
      expect(Option.isSome(taken)).toBe(true)
      expect(yield* holders(lockName)).toEqual({ held: 1, pending: 0 })
      const refused = yield* lock.tryHold(lockName).pipe(Effect.scoped)
      expect(refused).toEqual(Option.none())
      expect(yield* holders(lockName)).toEqual({ held: 1, pending: 0 })
      // A waiting request makes the lock taken too, even once its holder lets go.
      const waiting = yield* Effect.forkChild(hold(lock, lockName))
      yield* Effect.sleep("20 millis")
      yield* Scope.close(scope, Exit.void)
      const next = yield* Fiber.join(waiting)
      expect(yield* lock.tryHold(lockName).pipe(Effect.scoped)).toEqual(Option.none())
      yield* Scope.close(next, Exit.void)
      yield* Effect.sleep("20 millis")
      expect(yield* holders(lockName)).toEqual({ held: 0, pending: 0 })
    }).pipe(Effect.provide(WebLock.layer)))

  it.live("a lock tryHold took can be stolen, and its holder learns so", () =>
    Effect.gen(function*() {
      const lock = yield* WebLock.WebLock
      const lockName = name()
      const scope = yield* Scope.make()
      const taken = Option.getOrThrow(yield* lock.tryHold(lockName).pipe(Scope.provide(scope)))
      const lost = yield* Effect.forkChild(taken.lost)
      const thief = yield* hold(lock, lockName, { steal: true })
      yield* Fiber.join(lost)
      yield* Scope.close(scope, Exit.void)
      expect(yield* holders(lockName)).toEqual({ held: 1, pending: 0 })
      yield* Scope.close(thief, Exit.void)
    }).pipe(Effect.provide(WebLock.layer)))

  it.effect("asks tryHold with ifAvailable and no signal, and dies when the lock manager refuses it", () =>
    Effect.gen(function*() {
      const asked: Array<unknown> = []
      const recording = WebLock.make({
        request: (_name, options, callback) => {
          asked.push(options)
          return callback(undefined)
        }
      })
      expect(Option.isSome(yield* recording.tryHold("asked").pipe(Effect.scoped))).toBe(true)
      expect(asked).toEqual([{ ifAvailable: true }])
      const refusing = WebLock.make({
        request: () => Promise.reject(new DOMException("reserved", "NotSupportedError"))
      })
      const exit = yield* refusing.tryHold("-reserved").pipe(Effect.scoped, Effect.exit)
      expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true)
    }))
})
