/** A registration owns selected drives until their complete cleanup, before its resources close. */
import { expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { RunStore } from "@smthrs/run-store"
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const flow = Flow.make("RegistrationDrain/Flow", { payload: {}, success: Schema.String, body: opaqueHandlerBody })

// Faulty admission is an Effect service seam; SQL, registration and execution stay real.
it.effect("closing a registration interrupts selected pre-claim work before releasing its implementation", () =>
  withCrypto(
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const events: Array<string> = []
      let block = true
      const driver = yield* RunDriver.make({
        owner: { hostId: "registration-drain", pid: 1, nonce: "one" },
        journalSource: "registration-drain",
        engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"]),
        canExecute: () =>
          block
            ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.sync(() => {
                events.push("admission released")
              }))
            )
            : Effect.succeed(true)
      })
      const registration = yield* Scope.make()
      yield* Scope.addFinalizer(
        registration,
        Effect.sync(() => {
          events.push("implementation released")
        })
      )
      yield* driver.register(flow, () =>
        Effect.sync(() => {
          events.push("old handler")
          return "old"
        })).pipe(Scope.provide(registration))
      yield* driver.execute(flow, { executionId: "drain-before-claim", payload: {}, discard: true })
      yield* Deferred.await(entered)
      yield* Scope.close(registration, Exit.void)
      expect(events).toEqual(["admission released", "implementation released"])
      const runs = yield* RunStore.RunStore
      const released = yield* runs.get("drain-before-claim")
      expect(released.status).toBe("pending")
      expect(released.owner).toBeNull()
      expect(released.cancelRequestedAtMs).toBeNull()
      block = false
      yield* driver.register(flow, () => Effect.succeed("replacement"))
      yield* driver.execute(flow, { executionId: "drain-before-claim", payload: {}, discard: false })
      expect((yield* runs.get("drain-before-claim")).status).toBe("completed")
      expect(events).not.toContain("old handler")
    }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")))
  ))

for (const at of ["claim", "body", "body child", "nested body"] as const) {
  it.effect(`a drive can close its own registration from ${at} without deadlocking or cancelling the run`, () =>
    withCrypto(
      Effect.gen(function*() {
        const scope = yield* Scope.make()
        const released = yield* Deferred.make<void>()
        const calls: Array<string> = []
        yield* Scope.addFinalizer(scope, Deferred.succeed(released, undefined))
        const close = Scope.close(scope, Exit.void).pipe(Effect.andThen(Effect.sync(() => {
          calls.push("continued after close")
        })))
        const driver = yield* RunDriver.make({
          owner: { hostId: `registration-self-${at}`, pid: 1, nonce: "one" },
          journalSource: "registration-self",
          engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"]),
          canExecute: () => at === "claim" ? close.pipe(Effect.as(true)) : Effect.succeed(true)
        })
        const register = driver.register(flow, () =>
          Effect.gen(function*() {
            calls.push("body")
            if (at === "body child") {
              const child = yield* close.pipe(Effect.forkChild)
              yield* Fiber.join(child)
            } else yield* close
            return "unexpected"
          })).pipe(Scope.provide(scope))
        if (at === "nested body") {
          const parent = Flow.make("RegistrationDrain/Parent", {
            payload: {},
            success: Schema.String,
            body: opaqueHandlerBody
          })
          yield* driver.register(parent, () => register.pipe(Effect.as("registered")))
          yield* driver.execute(parent, { executionId: "register-in-parent", payload: {}, discard: false })
        } else yield* register
        const id = `self-${at}`
        yield* driver.execute(flow, { executionId: id, payload: {}, discard: true })
        yield* Deferred.await(released)
        // resume joins the drive already active at this point; the closed
        // registration cannot start its body again, and writes no cancellation.
        const joined = yield* Effect.exit(driver.resume(flow, id))
        if (Exit.isFailure(joined)) expect(Cause.hasInterruptsOnly(joined.cause)).toBe(true)
        expect(calls).toEqual(at === "claim" ? [] : ["body"])
        const row = yield* (yield* RunStore.RunStore).get(id)
        expect(row.cancelRequestedAtMs).toBeNull()
        expect(row.owner).toBeNull()
        expect(row.status).toBe(at === "claim" ? "pending" : "suspended")
      }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")))
    ))
}

for (const closer of ["outside", "newer drive"] as const) {
  it.effect(`closing an active older registration from ${closer} drains only its own run`, () =>
    withCrypto(
      Effect.gen(function*() {
        const older = yield* Scope.make()
        const newer = yield* Scope.make()
        const entered = yield* Deferred.make<void>()
        const newerEntered = yield* Deferred.make<void>()
        const closed = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const events: Array<string> = []
        const driver = yield* RunDriver.make({
          owner: { hostId: "registration-overrides", pid: 1, nonce: "one" },
          journalSource: "registration-overrides",
          engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"]),
          canExecute: () => Effect.succeed(true)
        })
        yield* Scope.addFinalizer(
          older,
          Effect.sync(() => {
            events.push("implementation released")
          })
        )
        yield* driver.register(flow, () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => {
              events.push("body released")
            }))
          )).pipe(Scope.provide(older))
        yield* driver.execute(flow, { executionId: "older-active", payload: {}, discard: true })
        yield* Deferred.await(entered)
        yield* driver.register(flow, () =>
          Effect.gen(function*() {
            yield* Deferred.succeed(newerEntered, undefined)
            if (closer === "newer drive") {
              yield* Scope.close(older, Exit.void)
              yield* Deferred.succeed(closed, undefined)
            }
            yield* Deferred.await(finish)
            return "newer completed"
          })).pipe(Scope.provide(newer))
        yield* driver.execute(flow, { executionId: "newer-active", payload: {}, discard: true })
        yield* Deferred.await(newerEntered)
        if (closer === "outside") yield* Scope.close(older, Exit.void)
        else yield* Deferred.await(closed)
        expect(events).toEqual(["body released", "implementation released"])
        const runs = yield* RunStore.RunStore
        const old = yield* runs.get("older-active")
        expect(old.status).toBe("suspended")
        expect(old.owner).toBeNull()
        expect(old.cancelRequestedAtMs).toBeNull()
        const active = yield* runs.get("newer-active")
        expect(active.status).toBe("running")
        expect(active.owner?.hostId).toBe("registration-overrides")
        expect(active.cancelRequestedAtMs).toBeNull()
        yield* Deferred.succeed(finish, undefined)
        yield* driver.resume(flow, "newer-active")
        expect((yield* runs.get("newer-active")).status).toBe("completed")
        yield* Scope.close(newer, Exit.void)
      }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")))
    ))
}
