/**
 * Comprehensive adversarial security suite for smithersai/smithers#4531
 * (Unbreakable Capability Attenuation) synthesized from the 5-panelist review.
 */
import { describe, expect, it } from "@effect/vitest"
import { Capability, CapabilitySet } from "@smthrs/capability"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Latch, Layer } from "effect"

const { Capability: CapabilityValue, CapabilityPattern } = Capability

const LEGACY_KEY = "@smthrs/kernel/CurrentCapabilities"
const NEW_KEY = "@smthrs/capability/CurrentCapabilities"
const ATTENUATE_SERVICE_SYMBOL = Symbol.for("@smthrs/capability/attenuateService")

const ForgedLegacyRef = Context.Reference<unknown>(LEGACY_KEY, { defaultValue: () => ({ groups: [] }) })
const ForgedNewRef = Context.Reference<unknown>(NEW_KEY, { defaultValue: () => ({ groups: [] }) })
const ForgedSvc = Context.Service<unknown>(LEGACY_KEY)

const readSrc = new CapabilityPattern({ action: "fs:read", resource: "src/**" })
const readSrcA = new CapabilityPattern({ action: "fs:read", resource: "src/a/**" })
const writeAll = new CapabilityPattern({ action: "fs:write", resource: "**" })
const universal = new CapabilityPattern({ action: "*", resource: "**" })

const inside = new CapabilityValue({ action: "fs:read", resource: "src/index.ts" })
const insideA = new CapabilityValue({ action: "fs:read", resource: "src/a/file.ts" })
const outside = new CapabilityValue({ action: "fs:write", resource: "/etc/passwd" })
const shadow = new CapabilityValue({ action: "fs:read", resource: "/etc/shadow" })

const unrestricted = CapabilitySet.fromGroups([])
const narrow = CapabilitySet.fromPatterns([readSrc])

const confined = <A, E, R>(effect: Effect.Effect<A, E, R>) => CapabilitySet.attenuate([readSrc])(effect)

const emptied = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.updateContext(effect, (_: Context.Context<R>) => Context.empty() as Context.Context<R>)

describe("#4531: CapabilitySet unbreakable attenuation", () => {
  describe("1. Forged Context.Reference / Context.Service & current-as-key attacks", () => {
    it("verbatim #4531 repro returns [false, false], never [false, true]", () => {
      const forgedAny = Context.Reference<unknown>(LEGACY_KEY, {
        defaultValue: () => ({ groups: [] })
      })
      const inner = Effect.gen(function*() {
        const before = yield* CapabilitySet.current
        const after = yield* Effect.provideService(CapabilitySet.current, forgedAny, { groups: [] })
        return [CapabilitySet.allows(before, shadow), CapabilitySet.allows(after, shadow)]
      })
      expect(Effect.runSync(CapabilitySet.attenuate([])(inner))).toEqual([false, false])
    })

    it.effect("exported current is not a Context.Reference and cannot be provided as a service", () =>
      Effect.gen(function*() {
        expect(Context.isReference(CapabilitySet.current as never)).toBe(false)
        const seen = yield* confined(
          CapabilitySet.current.pipe(
            Effect.provideService(CapabilitySet.current as never as Context.Reference<unknown>, unrestricted)
          )
        )
        expect(CapabilitySet.allows(seen, outside)).toBe(false)
        expect(CapabilitySet.allows(seen, inside)).toBe(true)
      }))

    const brand = Symbol.for("@smthrs/kernel/CapabilitySet")
    const forgeries: ReadonlyArray<readonly [string, unknown]> = [
      ["genuine unrestricted set", unrestricted],
      ["unbranded { groups: [] }", { groups: [] }],
      ["Symbol.for look-alike", { [brand]: brand, groups: [] }],
      ["frozen look-alike", Object.freeze({ [brand]: brand, groups: Object.freeze([]) })],
      ["string", "unrestricted"],
      ["undefined", undefined],
      ["null", null],
      ["function", () => unrestricted]
    ]

    type Writer = (value: unknown) => (victim: Effect.Effect<CapabilitySet.CapabilitySet>) => Effect.Effect<
      CapabilitySet.CapabilitySet
    >
    const writers: ReadonlyArray<readonly [string, Writer]> = [
      ["provideService(legacy)", (v) => (eff) => Effect.provideService(eff, ForgedLegacyRef, v)],
      ["provideService(new)", (v) => (eff) => Effect.provideService(eff, ForgedNewRef, v)],
      ["provide(Context.make)", (v) => (eff) => Effect.provide(eff, Context.make(ForgedLegacyRef, v))],
      ["provide(Layer.succeed)", (v) => (eff) => Effect.provide(eff, Layer.succeed(ForgedLegacyRef)(v))],
      ["provideServiceEffect", (v) => (eff) => Effect.provideServiceEffect(eff, ForgedSvc, Effect.succeed(v))],
      ["provideContext", (v) => (eff) => Effect.provideContext(eff, Context.make(ForgedSvc, v))],
      ["updateService", (v) => (eff) => Effect.updateService(eff, ForgedLegacyRef, () => v)],
      [
        "updateServiceScoped",
        (v) => (eff) => Effect.scoped(Effect.updateServiceScoped(ForgedLegacyRef, () => v).pipe(Effect.andThen(eff)))
      ],
      [
        "updateContext(Context.addUnsafe)",
        (v) => (eff) =>
          Effect.updateContext(eff, (ctx: Context.Context<never>) => Context.addUnsafe(ctx, LEGACY_KEY, v))
      ]
    ]

    for (const [writerName, write] of writers) {
      for (const [forgeryName, payload] of forgeries) {
        it.effect(`${writerName} with ${forgeryName} never widens`, () =>
          Effect.gen(function*() {
            const seen = yield* confined(write(payload)(CapabilitySet.current))
            expect(CapabilitySet.allows(seen, outside)).toBe(false)
            expect(CapabilitySet.allows(seen, inside)).toBe(true)
          }))
      }
    }
  })

  describe("2. Value integrity: unbranded, Symbol.for, stolen symbols, Proxy, unreadable getters, and array-like inputs", () => {
    it("all operations fail closed on every forged or copied value without reading .groups", () => {
      const legit = CapabilitySet.fromPatterns([readSrc])
      const oldBrand = Symbol.for("@smthrs/kernel/CapabilitySet")
      const stolen: Record<PropertyKey, unknown> = { groups: [] }
      for (const sym of Object.getOwnPropertySymbols(legit)) {
        stolen[sym] = (legit as unknown as Record<PropertyKey, unknown>)[sym]
      }
      const proxy = new Proxy(unrestricted, {
        get(target, prop, receiver) {
          if (prop === "groups") return []
          return Reflect.get(target, prop, receiver)
        }
      })
      const spreadCopy = Object.freeze({ ...unrestricted })
      const unreadable = Object.defineProperty({}, "groups", {
        get() {
          throw new Error("unauthenticated object must never be inspected")
        }
      })

      const fakes: ReadonlyArray<CapabilitySet.CapabilitySet> = [
        { groups: [] } as unknown as CapabilitySet.CapabilitySet,
        { [oldBrand]: oldBrand, groups: [] } as unknown as CapabilitySet.CapabilitySet,
        stolen as unknown as CapabilitySet.CapabilitySet,
        proxy,
        spreadCopy,
        unreadable as CapabilitySet.CapabilitySet,
        null as unknown as CapabilitySet.CapabilitySet,
        undefined as unknown as CapabilitySet.CapabilitySet,
        42 as unknown as CapabilitySet.CapabilitySet
      ]

      for (const fake of fakes) {
        expect(CapabilitySet.allows(fake, inside)).toBe(false)
        expect(CapabilitySet.allows(fake, outside)).toBe(false)
        // Must return false even against `none` and against itself!
        expect(CapabilitySet.equals(fake, unrestricted)).toBe(false)
        expect(CapabilitySet.equals(unrestricted, fake)).toBe(false)
        expect(CapabilitySet.equals(fake, CapabilitySet.none)).toBe(false)
        expect(CapabilitySet.equals(CapabilitySet.none, fake)).toBe(false)
        expect(CapabilitySet.equals(fake, fake)).toBe(false)
        expect(CapabilitySet.within(fake, unrestricted)).toBe(false)
        expect(CapabilitySet.within(fake, legit)).toBe(false)
        expect(CapabilitySet.within(legit, fake)).toBe(false)
        expect(CapabilitySet.within(CapabilitySet.none, fake)).toBe(false)
        expect(CapabilitySet.intersect(fake, legit)).toBe(CapabilitySet.none)
        expect(CapabilitySet.intersect(legit, fake)).toBe(CapabilitySet.none)
      }
    })

    it("rejects non-array inputs to fromGroups and fromPatterns", () => {
      expect(() => CapabilitySet.fromGroups({ length: 0 } as never)).toThrow(TypeError)
      expect(() => CapabilitySet.fromGroups([{} as never])).toThrow(TypeError)
      expect(() => CapabilitySet.fromPatterns({ length: 0 } as never)).toThrow(TypeError)
    })

    it("preserves reference identity across intersect fast paths and repeated current reads", () => {
      const a = CapabilitySet.fromPatterns([readSrc])
      const b = CapabilitySet.fromPatterns([readSrcA])
      const ab = CapabilitySet.intersect(a, b)
      expect(CapabilitySet.intersect(a, a)).toBe(a)
      expect(CapabilitySet.intersect(a, unrestricted)).toBe(a)
      expect(CapabilitySet.intersect(unrestricted, a)).toBe(a)
      expect(CapabilitySet.intersect(ab, a)).toBe(ab)
      expect(CapabilitySet.intersect(a, ab)).toBe(ab)
      expect(CapabilitySet.intersect(a, b)).not.toBe(a)
      expect(CapabilitySet.intersect(a, b)).not.toBe(b)

      const [first, second, nested1, nested2] = Effect.runSync(
        confined(
          Effect.gen(function*() {
            const first = yield* CapabilitySet.current
            const second = yield* CapabilitySet.current
            const [nested1, nested2] = yield* CapabilitySet.attenuate([readSrcA])(
              Effect.all([CapabilitySet.current, CapabilitySet.current])
            )
            return [first, second, nested1, nested2] as const
          })
        )
      )
      expect(first).toBe(second)
      expect(nested1).toBe(nested2)
    })
  })

  describe("3. Mutation & TOCTOU getter resistance", () => {
    it.effect("eagerly snapshots patterns and groups at attenuate() / attenuateGroups() call time", () =>
      Effect.gen(function*() {
        const pattern = new CapabilityPattern({ action: "fs:read", resource: "src/**" })
        const patterns = [pattern]
        const single = CapabilitySet.attenuate(patterns)(CapabilitySet.current)
        const group = [new CapabilityPattern({ action: "fs:read", resource: "src/**" })]
        const groups = [group]
        const many = CapabilitySet.attenuateGroups(groups)(CapabilitySet.current)

        // Mutate both the arrays and the pattern instances before running the effects
        Reflect.set(pattern, "action", "*")
        Reflect.set(pattern, "resource", "**")
        patterns.push(universal)
        Reflect.set(group[0]!, "resource", "**")
        group.push(universal)
        groups.length = 0

        const seenSingle = yield* single
        const seenMany = yield* many
        expect(CapabilitySet.allows(seenSingle, inside)).toBe(true)
        expect(CapabilitySet.allows(seenSingle, outside)).toBe(false)
        expect(CapabilitySet.allows(seenMany, inside)).toBe(true)
        expect(CapabilitySet.allows(seenMany, outside)).toBe(false)
      }))

    it("deeply freezes sets, groups, and patterns", () => {
      const set = CapabilitySet.fromPatterns([readSrc])
      expect(Object.isFrozen(set)).toBe(true)
      expect(Object.isFrozen(set.groups)).toBe(true)
      expect(Object.isFrozen(set.groups[0])).toBe(true)
      expect(Object.isFrozen(set.groups[0]![0])).toBe(true)
      expect(Reflect.set(set, "groups", [])).toBe(false)
      expect(Reflect.set(set.groups, "length", 0)).toBe(false)
      expect(Reflect.set(set.groups[0]!, "0", universal)).toBe(false)
      expect(Reflect.set(set.groups[0]![0]!, "action", "*")).toBe(false)
      expect(Reflect.set(set.groups[0]![0]!, "resource", "**")).toBe(false)
    })

    it("reads each pattern property exactly once to defeat shifting-getter TOCTOU", () => {
      let actionReads = 0
      let resourceReads = 0
      const tricky = {
        get action() {
          actionReads += 1
          return actionReads === 1 ? "fs:read" : "*"
        },
        get resource() {
          resourceReads += 1
          return resourceReads === 1 ? "src/**" : "**"
        }
      } as unknown as Capability.CapabilityPattern

      const set = CapabilitySet.fromPatterns([tricky])
      expect(actionReads).toBe(1)
      expect(resourceReads).toBe(1)
      expect(CapabilitySet.allows(set, inside)).toBe(true)
      expect(CapabilitySet.allows(set, outside)).toBe(false)
    })
  })

  describe("4. Context stripping & ctx.mapUnsafe tampering", () => {
    it.effect("survives Context.empty(), Context.omit, Context.makeUnsafe, captured root context, and fiber.setContext", () =>
      Effect.gen(function*() {
        const rootCtx = yield* Effect.context<never>()
        const attacks = [
          emptied(CapabilitySet.current),
          Effect.updateContext(
            CapabilitySet.current,
            (ctx: Context.Context<never>) => Context.omit(ForgedLegacyRef)(ctx as never)
          ),
          Effect.updateContext(CapabilitySet.current, (_: Context.Context<never>) => Context.makeUnsafe(new Map())),
          Effect.provideContext(CapabilitySet.current, rootCtx),
          Effect.provide(CapabilitySet.current, rootCtx),
          Effect.withFiber((fiber) => {
            fiber.setContext(Context.empty())
            return CapabilitySet.current
          })
        ]

        for (const attack of attacks) {
          const seen = yield* confined(attack)
          expect(CapabilitySet.allows(seen, outside)).toBe(false)
          expect(CapabilitySet.equals(seen, narrow)).toBe(true)
        }
      }))

    it.effect("collapses to none when ctx.mapUnsafe overwrites the private Symbol slot", () =>
      Effect.gen(function*() {
        const payloads: ReadonlyArray<unknown> = [
          { groups: [] },
          unrestricted,
          undefined,
          null,
          "unrestricted",
          Object.freeze(Object.create(null))
        ]

        for (const payload of payloads) {
          const seen = yield* confined(
            Effect.contextWith((ctx: Context.Context<never>) => {
              const tampered = new Map(ctx.mapUnsafe as unknown as ReadonlyMap<PropertyKey, unknown>)
              let found = false
              for (const key of tampered.keys()) {
                if (typeof key === "symbol") {
                  found = true
                  tampered.set(key, payload)
                }
              }
              expect(found).toBe(true)
              return Effect.setContext(
                CapabilitySet.current,
                Context.makeUnsafe(tampered as unknown as ReadonlyMap<string, unknown>)
              )
            })
          )
          expect(CapabilitySet.equals(seen, CapabilitySet.none)).toBe(true)
          expect(CapabilitySet.allows(seen, inside)).toBe(false)
          expect(CapabilitySet.allows(seen, outside)).toBe(false)
        }
      }))

    it.effect("retains active fiber frame when ctx.mapUnsafe deletes the private Symbol slot", () =>
      Effect.gen(function*() {
        const seen = yield* confined(
          Effect.contextWith((ctx: Context.Context<never>) => {
            const stripped = new Map(ctx.mapUnsafe as unknown as ReadonlyMap<PropertyKey, unknown>)
            for (const key of [...stripped.keys()]) {
              if (typeof key === "symbol") {
                stripped.delete(key)
              }
            }
            return Effect.setContext(
              CapabilitySet.current,
              Context.makeUnsafe(stripped as unknown as ReadonlyMap<string, unknown>)
            )
          })
        )
        expect(CapabilitySet.equals(seen, narrow)).toBe(true)
        expect(CapabilitySet.allows(seen, outside)).toBe(false)
      }))

    it.effect("replaying an outer context inside a nested scope stays bounded by the inner scope", () =>
      Effect.gen(function*() {
        const seen = yield* confined(
          Effect.gen(function*() {
            const outerCtx = yield* Effect.context<never>()
            return yield* CapabilitySet.attenuate([readSrcA])(
              Effect.setContext(CapabilitySet.current, outerCtx)
            )
          })
        )
        expect(CapabilitySet.allows(seen, insideA)).toBe(true)
        expect(CapabilitySet.allows(seen, inside)).toBe(false)
        expect(CapabilitySet.allows(seen, outside)).toBe(false)
      }))
  })

  describe("5. Forking, grandchildren, pre-existing siblings, and region lifecycle", () => {
    it.effect("blocks context stripping in forked children and grandchildren", () =>
      Effect.gen(function*() {
        const fromChild = yield* confined(
          Effect.flatMap(Effect.forkChild(emptied(CapabilitySet.current)), Fiber.join)
        )
        expect(CapabilitySet.allows(fromChild, outside)).toBe(false)
        expect(CapabilitySet.equals(fromChild, narrow)).toBe(true)

        const fromGrandchild = yield* confined(
          Effect.flatMap(
            Effect.forkChild(
              Effect.flatMap(Effect.forkChild(emptied(CapabilitySet.current)), Fiber.join)
            ),
            Fiber.join
          )
        )
        expect(CapabilitySet.allows(fromGrandchild, outside)).toBe(false)
        expect(CapabilitySet.equals(fromGrandchild, narrow)).toBe(true)
      }))

    it.effect("does not retroactively narrow pre-existing children while still confining newly forked children", () =>
      Effect.gen(function*() {
        const barrier = yield* Latch.make(false)
        const earlyChild = yield* Effect.forkChild(
          Effect.gen(function*() {
            yield* Latch.await(barrier)
            return yield* CapabilitySet.current
          }),
          { startImmediately: true }
        )

        const { early, innerChild, insideSelf } = yield* confined(
          Effect.gen(function*() {
            const insideSelf = yield* CapabilitySet.current
            const innerChild = yield* Effect.flatMap(
              Effect.forkChild(emptied(CapabilitySet.current)),
              Fiber.join
            )
            yield* Latch.open(barrier)
            const early = yield* Fiber.join(earlyChild)
            return { early, innerChild, insideSelf }
          })
        )

        expect(CapabilitySet.allows(insideSelf, outside)).toBe(false)
        expect(CapabilitySet.allows(innerChild, outside)).toBe(false)
        expect(CapabilitySet.allows(early, outside)).toBe(true)
      }))

    it.effect("restores outer ceiling on success, failure, defect, and interruption", () =>
      Effect.gen(function*() {
        yield* confined(Effect.void)
        expect(CapabilitySet.equals(yield* CapabilitySet.current, unrestricted)).toBe(true)

        expect(yield* Effect.exit(confined(Effect.fail("boom")))).toEqual(Exit.fail("boom"))
        expect(CapabilitySet.equals(yield* CapabilitySet.current, unrestricted)).toBe(true)

        const dieExit = yield* Effect.exit(confined(Effect.die("crash")))
        expect(Exit.isFailure(dieExit) && Cause.hasDies(dieExit.cause)).toBe(true)
        expect(CapabilitySet.equals(yield* CapabilitySet.current, unrestricted)).toBe(true)

        const started = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(
          confined(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
          { startImmediately: true }
        )
        yield* Deferred.await(started)
        const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
        expect(Exit.hasInterrupts(interrupted)).toBe(true)
        expect(CapabilitySet.equals(yield* CapabilitySet.current, unrestricted)).toBe(true)

        // Nested scope restores outer scope, not root
        const afterInner = yield* confined(
          Effect.gen(function*() {
            yield* CapabilitySet.attenuate([readSrcA])(Effect.fail("inner")).pipe(Effect.ignore)
            return yield* emptied(CapabilitySet.current)
          })
        )
        expect(CapabilitySet.equals(afterInner, narrow)).toBe(true)
      }))
  })

  describe("6. Monotone Context service attenuation hook & nesting invariants", () => {
    it.effect("attenuates compliant services in Context and safely ignores non-compliant entries", () =>
      Effect.gen(function*() {
        interface Guarded {
          readonly ceiling: CapabilitySet.CapabilitySet
        }
        const GuardedSvc = Context.Service<Guarded>("test/GuardedSvc")
        const NullSvc = Context.Service<null>("test/NullSvc")
        const PrimitiveSvc = Context.Service<number>("test/PrimitiveSvc")
        const FnSvc = Context.Service<() => string>("test/FnSvc")
        const PlainObjSvc = Context.Service<{ readonly ok: boolean }>("test/PlainObjSvc")
        const WritableHookSvc = Context.Service<Record<PropertyKey, unknown>>("test/WritableHookSvc")
        const NonFnHookSvc = Context.Service<Record<PropertyKey, unknown>>("test/NonFnHookSvc")

        const makeGuarded = (ceiling: CapabilitySet.CapabilitySet): Guarded => {
          const svc: Guarded = { ceiling }
          Object.defineProperty(svc, ATTENUATE_SERVICE_SYMBOL, {
            value: (next: CapabilitySet.CapabilitySet) => makeGuarded(CapabilitySet.intersect(ceiling, next)),
            enumerable: false,
            writable: false,
            configurable: false
          })
          return Object.freeze(svc)
        }

        const writableHook: Record<PropertyKey, unknown> = {
          [ATTENUATE_SERVICE_SYMBOL]: () => {
            throw new Error("writable hook must never be invoked")
          }
        }
        const nonFnHook: Record<PropertyKey, unknown> = {}
        Object.defineProperty(nonFnHook, ATTENUATE_SERVICE_SYMBOL, {
          value: "not-a-function",
          writable: false,
          configurable: false
        })

        const fn = () => "ok"
        const plain = { ok: true }

        const observed = yield* confined(
          CapabilitySet.attenuate([readSrcA])(
            Effect.gen(function*() {
              expect(yield* NullSvc).toBeNull()
              expect(yield* PrimitiveSvc).toBe(7)
              expect(yield* FnSvc).toBe(fn)
              expect(yield* PlainObjSvc).toBe(plain)
              expect(yield* WritableHookSvc).toBe(writableHook)
              expect(yield* NonFnHookSvc).toBe(nonFnHook)
              return (yield* GuardedSvc).ceiling
            })
          )
        ).pipe(
          Effect.provideService(GuardedSvc, makeGuarded(unrestricted)),
          Effect.provideService(NullSvc, null),
          Effect.provideService(PrimitiveSvc, 7),
          Effect.provideService(FnSvc, fn),
          Effect.provideService(PlainObjSvc, plain),
          Effect.provideService(WritableHookSvc, writableHook),
          Effect.provideService(NonFnHookSvc, nonFnHook)
        )

        expect(CapabilitySet.allows(observed, insideA)).toBe(true)
        expect(CapabilitySet.allows(observed, inside)).toBe(false)
        expect(CapabilitySet.allows(observed, outside)).toBe(false)
      }))

    it.effect("nested universal, disjoint, and empty attenuations never widen", () =>
      Effect.gen(function*() {
        const nestedUniversal = yield* confined(CapabilitySet.attenuate([universal])(CapabilitySet.current))
        const nestedEmptyGroups = yield* confined(CapabilitySet.attenuateGroups([])(CapabilitySet.current))
        const nestedDisjoint = yield* confined(CapabilitySet.attenuate([writeAll])(CapabilitySet.current))
        const nestedNone = yield* confined(CapabilitySet.attenuate([])(CapabilitySet.current))

        expect(CapabilitySet.allows(nestedUniversal, inside)).toBe(true)
        expect(CapabilitySet.allows(nestedUniversal, outside)).toBe(false)
        expect(CapabilitySet.equals(nestedEmptyGroups, narrow)).toBe(true)
        expect(CapabilitySet.allows(nestedDisjoint, inside)).toBe(false)
        expect(CapabilitySet.allows(nestedDisjoint, outside)).toBe(false)
        expect(CapabilitySet.equals(nestedNone, CapabilitySet.none)).toBe(true)
      }))

    it("preserves B8 unrestricted default and exact 10 non-widening exports", () => {
      const root = Effect.runSync(CapabilitySet.current)
      expect(CapabilitySet.allows(root, inside)).toBe(true)
      expect(CapabilitySet.allows(root, outside)).toBe(true)
      expect(Object.keys(CapabilitySet).sort()).toEqual([
        "allows",
        "attenuate",
        "attenuateGroups",
        "current",
        "equals",
        "fromGroups",
        "fromPatterns",
        "intersect",
        "none",
        "within"
      ])
    })
  })
})
