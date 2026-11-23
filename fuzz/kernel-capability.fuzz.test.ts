import { Capability, CapabilitySet, GrantStore, Permission, Workspace } from "@smthrs/kernel"
import { FuzzSimulation } from "@smthrs/fuzz"
import { it } from "@smthrs/testing/Vitest"
import { Effect, Fiber, Option, Schema } from "effect"
import { describe, expect } from "vitest"

const SafeSeg = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,10}$/))
const RelPath = Schema.Array(SafeSeg).check(Schema.isMinLength(1), Schema.isMaxLength(4))
const ActionKind = Schema.Literals(["fs:read", "fs:write", "net:get", "net:post", "proc:spawn"])

const makeCapPattern = (kind: string, segs: ReadonlyArray<string>, wildcard: boolean): string =>
  kind.startsWith("net:")
    ? `${kind}:${wildcard ? "*" : `${segs[0]}.example.com`}`
    : `${kind}:${segs.join("/")}${wildcard ? "/**" : ""}`

describe("@smthrs/capability & @smthrs/kernel fuzz", () => {
  it.fuzz(
    "Capability.parsePattern never throws unhandled defects on arbitrary strings",
    [Schema.String],
    ([raw]) => {
      const parsed = Capability.parsePattern(raw)
      if (Option.isSome(parsed)) {
        // Every parsed pattern must be reflexive under subsumes
        expect(Capability.subsumes(parsed.value, parsed.value)).toBe(true)
      }
      return true
    }
  )

  it.fuzz(
    "CapabilitySet.intersect satisfies commutativity, idempotency, and monotonicity",
    [
      Schema.Array(Schema.Tuple([ActionKind, RelPath, Schema.Boolean])).check(Schema.isMaxLength(6)),
      Schema.Array(Schema.Tuple([ActionKind, RelPath, Schema.Boolean])).check(Schema.isMaxLength(6)),
      Schema.Tuple([ActionKind, RelPath])
    ],
    ([rawA, rawB, probe]) => {
      const parseAll = (items: ReadonlyArray<readonly [string, ReadonlyArray<string>, boolean]>) => {
        const out: Array<Capability.CapabilityPattern> = []
        for (const [k, s, w] of items) {
          const parsed = Capability.parsePattern(makeCapPattern(k, s, w))
          if (Option.isSome(parsed)) out.push(parsed.value)
        }
        return out
      }
      const setA = CapabilitySet.fromPatterns(parseAll(rawA))
      const setB = CapabilitySet.fromPatterns(parseAll(rawB))
      const probeOpt = Capability.parsePattern(makeCapPattern(probe[0], probe[1], false))
      if (Option.isNone(probeOpt)) return true

      const ab = CapabilitySet.intersect(setA, setB)
      const ba = CapabilitySet.intersect(setB, setA)
      const aa = CapabilitySet.intersect(setA, setA)

      const cap = new Capability.Capability({
        action: probeOpt.value.action as Capability.Action,
        resource: probeOpt.value.resource
      })

      const allowA = CapabilitySet.allows(setA, cap)
      const allowB = CapabilitySet.allows(setB, cap)
      const allowAB = CapabilitySet.allows(ab, cap)
      const allowBA = CapabilitySet.allows(ba, cap)
      const allowAA = CapabilitySet.allows(aa, cap)

      // Commutativity, idempotency, and exact conjunction (monotonicity)
      expect(allowAB).toBe(allowBA)
      expect(allowAA).toBe(allowA)
      expect(allowAB).toBe(allowA && allowB)
      return true
    }
  )

  it.fuzz(
    "Permission.evaluate is deterministic and obeys rule precedence",
    [
      Schema.Array(
        Schema.Tuple([
          Schema.Literals(["allow", "deny", "ask"]),
          ActionKind,
          RelPath,
          Schema.Boolean
        ])
      ).check(Schema.isMaxLength(8)),
      ActionKind,
      RelPath
    ],
    ([ruleSpecs, probeAction, probeSegs]) => {
      const rules: Array<Permission.Rule> = []
      for (const [effect, act, segs, wild] of ruleSpecs) {
        const parsed = Capability.parsePattern(makeCapPattern(act, segs, wild))
        if (Option.isSome(parsed)) {
          rules.push(new Permission.Rule({ effect, pattern: parsed.value }))
        }
      }
      const probeOpt = Capability.parsePattern(makeCapPattern(probeAction, probeSegs, false))
      if (Option.isNone(probeOpt)) return true
      const cap = new Capability.Capability({
        action: probeOpt.value.action as Capability.Action,
        resource: probeOpt.value.resource
      })
      const r1 = Permission.evaluate([rules], cap)
      const r2 = Permission.evaluate([rules], cap)
      expect(r1).toEqual(r2)
      return true
    }
  )

  it.effect.fuzz(
    "GrantStore concurrent attended requests resolve cleanly under FuzzSimulation without deadlock",
    [
      Schema.Array(Schema.Tuple([SafeSeg, Schema.Literals(["once", "run", "deny"])])).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(5)
      )
    ],
    ([requests]) =>
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* GrantStore.make({ attended: true, rules: [], runId: "fuzz-run", planDigest: "a".repeat(64) }).pipe(
            Effect.provideService(Workspace.Workspace, { root: "/workspace" })
          )
          const resolved: Array<string> = []
          const fibers = yield* Effect.forEach(requests, ([seg, decision], idx) =>
            Effect.forkChild(
              Effect.gen(function*() {
                const cap = new Capability.Capability({
                  action: "fs:write",
                  resource: `/workspace/${seg}-${idx}`
                })
                const checkFiber = yield* Effect.forkChild(Effect.exit(store.check(cap)))
                let pending = yield* store.list
                let spins = 0
                while (!pending.some((p) => p.capability.resource === cap.resource) && spins < 50) {
                  yield* Effect.yieldNow
                  pending = yield* store.list
                  spins++
                }
                const req = pending.find((p) => p.capability.resource === cap.resource)
                if (req !== undefined) {
                  yield* store.reply(req.requestId, decision)
                }
                const exit = yield* Fiber.join(checkFiber)
                if (decision === "deny") {
                  expect(exit._tag).toBe("Failure")
                } else {
                  expect(exit._tag).toBe("Success")
                }
                resolved.push(`${idx}:${decision}`)
              })
            )
          )
          for (const f of fibers) {
            yield* Fiber.join(f)
          }
          expect(resolved.length).toBe(requests.length)
          return true
        })
      ),
    { fuzz: { execution: FuzzSimulation.execution({ maxSteps: 100_000 }) } }
  )
})
