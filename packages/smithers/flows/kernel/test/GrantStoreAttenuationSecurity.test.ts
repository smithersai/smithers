/**
 * Comprehensive GrantStore capability-attenuation security suite for
 * smithersai/smithers#4531 synthesized from all 5 panel submissions.
 */
import { describe, expect, it } from "@effect/vitest"
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import { GrantStoreError, PermissionDenied, PermissionRequired, Rule } from "@smthrs/capability/Permission"
import { Context, Effect, Fiber } from "effect"
import * as CapabilitySet from "../src/CapabilitySet.ts"
import type { GrantEvent } from "../src/GrantEvent.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

const ATTENUATE_SERVICE_SYMBOL = Symbol.for("@smthrs/capability/attenuateService")
const ForgedRef = Context.Reference<unknown>("@smthrs/kernel/CurrentCapabilities", {
  defaultValue: () => ({ groups: [] })
})

const pattern = (action: CapabilityPattern["action"], resource: string) => new CapabilityPattern({ action, resource })
const capability = (action: Capability["action"], resource: string) => new Capability({ action, resource })

const readReadme = capability("fs:read", "/workspace/readme.md")
const readSecret = capability("fs:read", "/workspace/secret.env")
const writeReadme = capability("fs:write", "/workspace/readme.md")
const spawnSh = capability("proc:spawn", "sh")

const readmeOnly = [pattern("fs:read", "/workspace/readme.md")]
const workspaceReads = [pattern("fs:read", "/workspace/**")]
const allowAll = [new Rule({ effect: "allow", pattern: pattern("*", "**") })]

const makeStore = (options: GrantStore.MakeOptions = {}) =>
  GrantStore.make({
    attended: false,
    rules: allowAll,
    ...options
  }).pipe(Effect.provide(Workspace.layer("/workspace")))

const awaitPending = (
  store: GrantStore.Service,
  count: number
): Effect.Effect<ReadonlyArray<GrantStore.PendingRequest>> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending.length >= count
        ? Effect.succeed(pending)
        : Effect.yieldNow.pipe(Effect.andThen(awaitPending(store, count))))
  )

const expectOutsideCeiling = (error: unknown): void => {
  expect(error).toBeInstanceOf(PermissionDenied)
  expect((error as PermissionDenied).reason).toBe("outside capability ceiling")
}

const emptied = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.updateContext(effect, (_: Context.Context<R>) => Context.empty() as Context.Context<R>)

describe("#4531: GrantStore unbreakable capability attenuation", () => {
  describe("1. Ambient ceiling enforcement under forged references, context stripping, and forks", () => {
    it.effect("blocks forged references, context stripping, root replay, and fiber.setContext on pre-acquired handles", () =>
      Effect.scoped(Effect.gen(function*() {
        const store = yield* makeStore()
        const rootCtx = yield* Effect.context<never>()
        yield* store.check(writeReadme)
        yield* CapabilitySet.attenuate(readmeOnly)(store.check(readReadme))

        const attacks = [
          store.check(readSecret).pipe(Effect.provideService(ForgedRef, { groups: [] })),
          store.check(readSecret).pipe(Effect.provideService(ForgedRef, CapabilitySet.fromGroups([]))),
          emptied(store.check(readSecret)),
          Effect.updateContext(store.check(readSecret), (_: Context.Context<never>) => Context.makeUnsafe(new Map())),
          Effect.provideContext(store.check(readSecret), rootCtx),
          Effect.withFiber((fiber) => {
            fiber.setContext(Context.empty())
            return store.check(readSecret)
          }),
          CapabilitySet.attenuate([pattern("*", "**")])(store.check(readSecret)),
          CapabilitySet.attenuateGroups([])(store.check(readSecret)),
          Effect.flatMap(Effect.forkChild(emptied(store.check(readSecret))), Fiber.join),
          Effect.flatMap(
            Effect.forkChild(Effect.flatMap(Effect.forkChild(emptied(store.check(spawnSh))), Fiber.join)),
            Fiber.join
          )
        ]

        for (const attack of attacks) {
          expectOutsideCeiling(yield* Effect.flip(CapabilitySet.attenuate(readmeOnly)(attack)))
        }
      })))

    it.effect("policy reports the confined ceiling under attack", () =>
      Effect.scoped(Effect.gen(function*() {
        const store = yield* makeStore()
        const policy = yield* CapabilitySet.attenuate(readmeOnly)(
          emptied(store.policy).pipe(Effect.provideService(ForgedRef, { groups: [] }))
        )
        expect(CapabilitySet.allows(policy.ceiling, readReadme)).toBe(true)
        expect(CapabilitySet.allows(policy.ceiling, readSecret)).toBe(false)
      })))
  })

  describe("2. Closure-bound GrantStore attenuation across Effect.forkDetach and stripped contexts", () => {
    it.effect("blocks Effect.forkDetach + Context.pick(GrantStore) + fiber.setContext(Context.empty()) automatically", () =>
      Effect.scoped(Effect.gen(function*() {
        const rootStore = yield* makeStore()
        const failure = yield* CapabilitySet.attenuate(readmeOnly)(
          Effect.gen(function*() {
            const daemon = yield* Effect.forkDetach(
              Effect.contextWith((ctx: Context.Context<GrantStore.GrantStore>) => {
                const picked = Context.pick(GrantStore.GrantStore)(ctx)
                return Effect.setContext(
                  Effect.gen(function*() {
                    const store = yield* GrantStore.GrantStore
                    return yield* Effect.withFiber((f) => {
                      f.setContext(Context.empty())
                      return store.check(readSecret)
                    })
                  }),
                  picked
                )
              })
            )
            return yield* Fiber.join(daemon)
          })
        ).pipe(
          Effect.provideService(GrantStore.GrantStore, rootStore),
          Effect.flip
        )
        expectOutsideCeiling(failure)
      })))

    it.effect("keeps GrantStore.policy narrowed in Effect.forkDetach with stripped context", () =>
      Effect.scoped(Effect.gen(function*() {
        const rootStore = yield* makeStore()
        const policy = yield* CapabilitySet.attenuate(readmeOnly)(
          Effect.flatMap(
            Effect.forkDetach(
              Effect.contextWith((ctx: Context.Context<GrantStore.GrantStore>) =>
                Effect.setContext(
                  Effect.flatMap(GrantStore.GrantStore, (store) => store.policy),
                  Context.pick(GrantStore.GrantStore)(ctx)
                )
              )
            ),
            Fiber.join
          )
        ).pipe(Effect.provideService(GrantStore.GrantStore, rootStore))

        expect(CapabilitySet.allows(policy.ceiling, readReadme)).toBe(true)
        expect(CapabilitySet.allows(policy.ceiling, readSecret)).toBe(false)
      })))

    it.effect("prevents E9 attended RunGrant ceiling laundering even in forkDetach with stripped context", () =>
      Effect.scoped(Effect.gen(function*() {
        const events: Array<GrantEvent> = []
        const rootStore = yield* GrantStore.make({
          attended: true,
          planDigest: "plan-sec",
          persist: (event) =>
            Effect.sync(() => {
              events.push(event)
            })
        }).pipe(Effect.provide(Workspace.layer("/workspace")))

        const waiter = yield* CapabilitySet.attenuate(readmeOnly)(
          Effect.forkDetach(
            Effect.contextWith((ctx: Context.Context<GrantStore.GrantStore>) =>
              Effect.setContext(
                Effect.flatMap(GrantStore.GrantStore, (store) => store.check(readReadme)),
                Context.pick(GrantStore.GrantStore)(ctx)
              )
            ),
            { startImmediately: true }
          )
        ).pipe(Effect.provideService(GrantStore.GrantStore, rootStore))

        const [pending] = yield* awaitPending(rootStore, 1)
        yield* rootStore.reply(pending!.requestId, "run", pattern("fs:read", "/workspace/**"))
        yield* Fiber.join(waiter)

        expect(events).toMatchObject([{
          eventType: "flows.kernel.grant.run.v2",
          ceiling: [[{ action: "fs:read", resource: "/workspace/readme.md" }]]
        }])

        // The run grant MUST NOT authorize /workspace/secret.env even at root.
        const second = yield* rootStore.check(readSecret).pipe(Effect.forkChild({ startImmediately: true }))
        const nextPending = yield* awaitPending(rootStore, 1)
        expect(nextPending.map((item) => item.capability)).toEqual([readSecret])
        yield* Fiber.interrupt(second)
      })))

    it.effect("keeps GrantStore attenuation protocol frozen, non-configurable, and strictly monotone", () =>
      Effect.scoped(Effect.gen(function*() {
        const rootStore = yield* makeStore()
        const attenuated = yield* CapabilitySet.attenuate(readmeOnly)(GrantStore.GrantStore).pipe(
          Effect.provideService(GrantStore.GrantStore, rootStore)
        )
        expect(Object.isFrozen(attenuated)).toBe(true)
        expect(() => {
          ;(attenuated as { check: unknown }).check = () => Effect.void
        }).toThrow(TypeError)
        expect(() => {
          ;(attenuated as unknown as Record<PropertyKey, unknown>)[ATTENUATE_SERVICE_SYMBOL] = () => rootStore
        }).toThrow(TypeError)

        const hook = (attenuated as unknown as Record<symbol, (c: CapabilitySet.CapabilitySet) => GrantStore.Service>)[
          ATTENUATE_SERVICE_SYMBOL
        ]!
        const widened = hook(CapabilitySet.fromGroups([]))
        expectOutsideCeiling(yield* Effect.flip(widened.check(readSecret)))
        yield* widened.check(readReadme)

        const fake = hook({ groups: [] } as unknown as CapabilitySet.CapabilitySet)
        expectOutsideCeiling(yield* Effect.flip(fake.check(readReadme)))
      })))
  })

  describe("3. Construction-bound stores (bindCeiling) and hardened makeNoop", () => {
    it.effect("bindCeiling: true keeps the construction ceiling even for an unrestricted caller", () =>
      Effect.scoped(Effect.gen(function*() {
        const store = yield* CapabilitySet.attenuate(workspaceReads)(makeStore({ bindCeiling: true }))
        yield* store.check(readReadme)
        expectOutsideCeiling(yield* Effect.flip(store.check(writeReadme)))
        expect(CapabilitySet.allows((yield* store.policy).ceiling, writeReadme)).toBe(false)
        expect(Object.isFrozen(store)).toBe(true)
        expectOutsideCeiling(yield* CapabilitySet.attenuate([])(Effect.flip(store.check(readReadme))))
      })))

    it.effect("makeNoop enforces both ambient and closure-bound ceilings with single-read capability snapshotting", () =>
      Effect.gen(function*() {
        yield* GrantStore.makeNoop.check(writeReadme)
        expectOutsideCeiling(
          yield* CapabilitySet.attenuate(readmeOnly)(Effect.flip(GrantStore.makeNoop.check(writeReadme)))
        )
        yield* CapabilitySet.attenuate(readmeOnly)(GrantStore.makeNoop.check(readReadme))

        // makeNoop attenuates automatically in Context across forkDetach
        const daemonFailure = yield* CapabilitySet.attenuate(readmeOnly)(
          Effect.flatMap(
            Effect.forkDetach(
              Effect.contextWith((ctx: Context.Context<GrantStore.GrantStore>) =>
                Effect.setContext(
                  Effect.flatMap(GrantStore.GrantStore, (s) => s.check(writeReadme)),
                  Context.pick(GrantStore.GrantStore)(ctx)
                )
              )
            ),
            Fiber.join
          )
        ).pipe(Effect.provide(GrantStore.layerNoop), Effect.flip)
        expectOutsideCeiling(daemonFailure)

        // Shifting-getter capability is snapshotted once in makeNoop.check
        let reads = 0
        const shifting = Object.create(Capability.prototype, {
          action: { enumerable: true, get: () => (reads++ === 0 ? "fs:read" : "fs:write") },
          resource: { enumerable: true, value: "/workspace/readme.md" }
        }) as Capability
        yield* CapabilitySet.attenuate(readmeOnly)(GrantStore.makeNoop.check(shifting))
        expect(reads).toBe(1)
      }))
  })

  describe("4. GrantStore.attenuated & GrantStore.bindCeiling control-plane hardening", () => {
    const readBound = CapabilitySet.fromPatterns(workspaceReads)

    it.effect("native GrantStore.attenuated bounds check, policy, list, reply, and grantEnvelope atomically", () =>
      Effect.scoped(Effect.gen(function*() {
        const store = yield* GrantStore.make({ attended: true, planDigest: "plan-1" }).pipe(
          Effect.provide(Workspace.layer("/workspace"))
        )
        const view = GrantStore.attenuated(store, readBound)

        // Fails closed on unverified ceiling argument
        const fakeView = GrantStore.attenuated(store, { groups: [] } as unknown as CapabilitySet.CapabilitySet)
        expectOutsideCeiling(yield* Effect.flip(fakeView.check(readReadme)))

        // Enforces bound on fresh root Effect.runPromise
        expectOutsideCeiling(yield* Effect.promise(() => Effect.runPromise(Effect.flip(view.check(writeReadme)))))

        // list & reply isolation
        const writer = yield* store.check(writeReadme).pipe(Effect.forkChild({ startImmediately: true }))
        const reader = yield* view.check(readReadme).pipe(Effect.forkChild({ startImmediately: true }))
        const all = yield* awaitPending(store, 2)
        const writeReq = all.find((req) => req.capability.action === "fs:write")!
        const readReq = all.find((req) => req.capability.action === "fs:read")!

        const visible = yield* view.list
        expect(visible.map((req) => req.requestId)).toEqual([readReq.requestId])
        expect(Object.isFrozen(visible)).toBe(true)

        for (const res of ["once", "run", "remembered", "deny"] as const) {
          expect((yield* Effect.flip(view.reply(writeReq.requestId, res))).code).toBe("request_not_found")
        }

        // Cannot reply with a pattern wider than its bound (both run and remembered)
        const wideRun = yield* Effect.flip(view.reply(readReq.requestId, "run", pattern("fs:read", "**")))
        expect(wideRun.code).toBe("invalid_resolution")
        expect(wideRun.message).toContain("outside the capability ceiling")

        const wideRemembered = yield* Effect.flip(
          view.reply(readReq.requestId, "remembered", pattern("fs:read", "**"))
        )
        expect(wideRemembered.code).toBe("invalid_resolution")
        expect(wideRemembered.message).toContain("outside the capability ceiling")

        yield* view.reply(readReq.requestId, "run", pattern("fs:read", "/workspace/readme.md"))
        yield* Fiber.join(reader)
        yield* store.reply(writeReq.requestId, "once")
        yield* Fiber.join(writer)

        // grantEnvelope refuses patterns outside bound
        const envStore = yield* GrantStore.make({ attended: false, planDigest: "plan-1" }).pipe(
          Effect.provide(Workspace.layer("/workspace"))
        )
        const envView = GrantStore.attenuated(envStore, readBound)
        const refused = yield* Effect.flip(envView.grantEnvelope({
          planDigest: "plan-1",
          patterns: [pattern("fs:read", "/workspace/readme.md"), pattern("fs:write", "/workspace/readme.md")]
        }))
        expect(refused.code).toBe("invalid_resolution")
        expect(refused.message).toContain("patterns[1] is outside the capability ceiling")
        expect(yield* Effect.flip(envStore.check(readReadme))).toBeInstanceOf(PermissionRequired)

        // Admits patterns within bound
        yield* envView.grantEnvelope({
          planDigest: "plan-1",
          patterns: [pattern("fs:read", "/workspace/readme.md")]
        })
        yield* envStore.check(readReadme)

        // Nested view composition is strictly monotone
        const narrower = GrantStore.attenuated(view, CapabilitySet.fromPatterns(readmeOnly))
        const rewrapped = GrantStore.attenuated(narrower, CapabilitySet.fromGroups([]))
        expectOutsideCeiling(yield* Effect.flip(rewrapped.check(readSecret)))
      })))

    it.effect("fallback GrantStore.attenuated wrapper protects custom non-native Service doubles", () =>
      Effect.gen(function*() {
        const seen: Array<Capability> = []
        const pendingItems: Array<GrantStore.PendingRequest> = [
          { requestId: "req-read", capability: readReadme, tier: "sealed", meta: {} },
          { requestId: "req-write", capability: writeReadme, tier: "compensable", meta: {} }
        ]
        const replies: Array<readonly [string, GrantStore.Resolution, CapabilityPattern | undefined]> = []
        const envelopes: Array<GrantStore.EnvelopeGrantOptions> = []

        const customService = GrantStore.GrantStore.of({
          policy: GrantStore.emptyPolicy,
          check: (req) => Effect.sync(() => void seen.push(req)),
          reply: (id, res, pat) => Effect.sync(() => void replies.push([id, res, pat])),
          list: Effect.succeed(pendingItems),
          grantEnvelope: (opts) => Effect.sync(() => void envelopes.push(opts))
        })

        // Also ensure a writable spoofed hook is ignored (falls back to safe wrapper)
        Object.defineProperty(customService, ATTENUATE_SERVICE_SYMBOL, {
          value: () => customService,
          writable: true,
          configurable: true
        })

        const view = GrantStore.attenuated(customService, readBound)
        expect(Object.isFrozen(view)).toBe(true)

        // Shifting-getter TOCTOU capability snapshot
        let reads = 0
        const shifting = Object.create(Capability.prototype, {
          action: { enumerable: true, get: () => (reads++ === 0 ? "fs:read" : "fs:write") },
          resource: { enumerable: true, value: "/workspace/readme.md" }
        }) as Capability
        yield* view.check(shifting)
        expect(reads).toBe(1)
        expect(seen.map((c) => c.action)).toEqual(["fs:read"])
        expect(Reflect.set(seen[0]!, "action", "fs:write")).toBe(false)

        expectOutsideCeiling(yield* Effect.flip(view.check(writeReadme)))

        const hostileCap = Object.create(Capability.prototype, {
          action: {
            get: () => {
              throw new Error("hostile")
            }
          }
        }) as Capability
        expect(yield* Effect.flip(view.check(hostileCap))).toBeInstanceOf(GrantStoreError)

        // policy intersects bound
        const policy = yield* view.policy
        expect(CapabilitySet.equals(policy.ceiling, readBound)).toBe(true)

        // list filters out write request
        expect((yield* view.list).map((r) => r.requestId)).toEqual(["req-read"])

        // reply rejects out-of-bound request and out-of-bound pattern
        expect((yield* Effect.flip(view.reply("req-write", "once"))).code).toBe("request_not_found")
        expect((yield* Effect.flip(view.reply("req-read", "run", pattern("fs:read", "**")))).message).toContain(
          "outside the capability ceiling"
        )
        yield* view.reply("req-read", "once")
        yield* view.reply("req-read", "run", pattern("fs:read", "/workspace/readme.md"))
        expect(replies).toHaveLength(2)

        // grantEnvelope validates shape, limit, and ceiling
        expect((yield* Effect.flip(view.grantEnvelope({ planDigest: "p", patterns: "bad" as never }))).code).toBe(
          "invalid_resolution"
        )
        expect(
          (yield* Effect.flip(view.grantEnvelope({
            planDigest: "p",
            patterns: Array.from(
              { length: GrantStore.maximumEnvelopePatterns + 1 },
              (_, i) => pattern("fs:read", `/workspace/${i}.txt`)
            )
          }))).message
        ).toContain("patterns exceed")
        expect(
          (yield* Effect.flip(view.grantEnvelope({
            planDigest: "p",
            patterns: [pattern("fs:write", "/workspace/readme.md")]
          }))).message
        ).toContain("patterns[0] is outside the capability ceiling")
        yield* view.grantEnvelope({ planDigest: "p", patterns: [pattern("fs:read", "/workspace/readme.md")] })
        expect(envelopes).toHaveLength(1)

        // Composing the fallback wrapper via attenuated narrows further
        const narrower = GrantStore.attenuated(view, CapabilitySet.fromPatterns(readmeOnly))
        expectOutsideCeiling(yield* Effect.flip(narrower.check(readSecret)))
        yield* narrower.check(readReadme)
      }))

    it.effect("GrantStore.bindCeiling replaces the ambient store with a view bound to the current ceiling", () =>
      Effect.scoped(Effect.gen(function*() {
        const store = yield* makeStore()
        const attack = Effect.gen(function*() {
          const captured = yield* GrantStore.GrantStore
          yield* captured.check(readReadme)
          return yield* Effect.flatMap(
            Effect.forkDetach(Effect.flip(emptied(captured.check(writeReadme)))),
            Fiber.join
          )
        })
        const error = yield* attack.pipe(
          GrantStore.bindCeiling,
          CapabilitySet.attenuate(workspaceReads),
          Effect.provideService(GrantStore.GrantStore, store)
        )
        expectOutsideCeiling(error)

        yield* Effect.flatMap(GrantStore.GrantStore, (ambient) => ambient.check(writeReadme)).pipe(
          GrantStore.bindCeiling,
          Effect.provideService(GrantStore.GrantStore, store)
        )
      })))
  })
})
