import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { decodePermissionError } from "../src/decodePermissionError.ts"
import { Capability, CapabilitySet, Permission } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const validResource = Schema.Literals([
  "src/index.ts",
  "src/a/b.ts",
  "api.example.com",
  "10.0.0.1",
  "node",
  "git",
  "/abs/path/file.ts",
  "/abs/../escape",
  "a/./b",
  "a/../b"
])
const validPatternResource = Schema.Literals([
  "*",
  "src/*",
  "src/**",
  "*.example.com",
  "api.example.com",
  "node",
  "src/index.ts",
  "/abs/**"
])

describe("@smthrs/capability comprehensive fuzz security invariants", () => {
  it("parse/format, parsePattern/patternFromCapability, subsumes, matches, mayOverlap, and tierOf are sound across all actions", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        action: Capability.Action,
        patAction1: Capability.PatternAction,
        patAction2: Capability.PatternAction,
        resource: validResource,
        patRes1: validPatternResource,
        patRes2: validPatternResource
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ action, patAction1, patAction2, resource, patRes1, patRes2 }) =>
          Effect.sync(() => {
            const cap = Capability.make(action, resource)
            const formatted = Capability.format(cap)
            const reparsed = Capability.parse(formatted)
            if (Option.isNone(reparsed)) return false
            if (reparsed.value.action !== action || reparsed.value.resource !== resource) return false

            // patternFromCapability ALWAYS matches its own capability
            const exactPat = Capability.patternFromCapability(cap)
            if (Option.isSome(exactPat)) {
              if (!Capability.matches(exactPat.value, cap)) return false
              if (!Capability.subsumes(exactPat.value, exactPat.value)) return false
            }

            // tierOf & requiresIdempotencyKey always return valid values
            const tier = Capability.tierOf(cap, { workspaceRoot: "/abs" })
            if (tier !== "sealed" && tier !== "compensable" && tier !== "irreversible") return false
            if (typeof Capability.requiresIdempotencyKey(tier) !== "boolean") return false

            const p1 = Capability.parsePattern(`${patAction1}:${patRes1}`)
            const p2 = Capability.parsePattern(`${patAction2}:${patRes2}`)
            if (Option.isSome(p1) && Option.isSome(p2)) {
              // Subsumption soundness: subsumes(p1, p2) && matches(p2, cap) => matches(p1, cap)
              if (Capability.subsumes(p1.value, p2.value) && Capability.matches(p2.value, cap)) {
                if (!Capability.matches(p1.value, cap)) return false
              }
              // Overlap soundness: if BOTH p1 and p2 match cap, mayOverlap(p1, p2) MUST be true!
              if (Capability.matches(p1.value, cap) && Capability.matches(p2.value, cap)) {
                if (!Capability.mayOverlap(p1.value, p2.value)) return false
              }
              // Wildcard *:* NEVER grants net:private
              if (patAction1 === "*" && patRes1 === "*" && action === "net:private") {
                if (Capability.matches(p1.value, cap)) return false
              }
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("CapabilitySet intersect/within/equals/attenuate satisfy monotone lattice laws", async () => {
    const patListArb = Schema.Array(
      Schema.Struct({
        action: Capability.PatternAction,
        res: validPatternResource
      })
    ).pipe(Schema.check(Schema.isMaxLength(4)))
    const arb = Arbitrary.schema(
      Schema.Struct({
        g1: patListArb,
        g2: patListArb,
        probeAction: Capability.Action,
        probeRes: validResource
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ g1, g2, probeAction, probeRes }) =>
          Effect.gen(function*() {
            const toPats = (list: ReadonlyArray<{ action: Capability.PatternAction; res: string }>) =>
              list.flatMap((x) => {
                const p = Capability.parsePattern(`${x.action}:${x.res}`)
                return Option.isSome(p) ? [p.value] : []
              })
            const s1 = CapabilitySet.fromPatterns(toPats(g1))
            const s2 = CapabilitySet.fromPatterns(toPats(g2))
            const inter = CapabilitySet.intersect(s1, s2)
            const cap = Capability.make(probeAction, probeRes)

            // none allows nothing
            if (CapabilitySet.allows(CapabilitySet.none, cap)) return false
            // Intersection semantics: allows(s1 ∩ s2, c) <=> allows(s1, c) && allows(s2, c)
            const expected = CapabilitySet.allows(s1, cap) && CapabilitySet.allows(s2, cap)
            if (CapabilitySet.allows(inter, cap) !== expected) return false
            // Commutativity & idempotence of equals
            if (!CapabilitySet.equals(s1, s1)) return false
            if (!CapabilitySet.equals(inter, CapabilitySet.intersect(s2, s1))) return false
            // Soundness of within: if within(inner, outer), then allows(inner, cap) => allows(outer, cap)
            if (CapabilitySet.within(inter, s1) && CapabilitySet.allows(inter, cap)) {
              if (!CapabilitySet.allows(s1, cap)) return false
            }
            // Effect attenuation narrows current ambient authority
            const afterAttenuate = yield* CapabilitySet.current.pipe(
              CapabilitySet.attenuate(toPats(g1)),
              CapabilitySet.attenuate(toPats(g2))
            )
            return CapabilitySet.allows(afterAttenuate, cap) === expected
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Permission.evaluate, PermissionError, decodePermissionError, and formatError uphold deny-veto & fail-closed traversal", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        action: Capability.Action,
        resource: validResource,
        allowAll: Schema.Boolean,
        denyThis: Schema.Boolean,
        mode: Schema.Literals(["attended", "unattended"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ action, resource, allowAll, denyThis, mode }) =>
          Effect.sync(() => {
            const cap = Capability.make(action, resource)
            const allowRules = allowAll
              ? [Capability.parsePattern("*:*"), Capability.parsePattern("net:private:*")].flatMap((o) =>
                Option.isSome(o) ? [{ pattern: o.value, effect: "allow" as const }] : []
              )
              : []
            const exactOpt = Capability.patternFromCapability(cap)
            const denyRules = denyThis && Option.isSome(exactOpt)
              ? [{ pattern: exactOpt.value, effect: "deny" as const }]
              : []
            const verdict = Permission.evaluate([allowRules, denyRules], cap)
            if (denyThis && Option.isSome(exactOpt) && verdict !== "deny") return false
            if (verdict === "deny") {
              const err = Permission.permissionDenied(cap, "denied_by_policy")
              const formatted = Permission.formatError(err)
              if (formatted.length === 0) return false
              const decoded = decodePermissionError(err)
              if (Option.isNone(decoded)) return false
            }
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})

describe("@smthrs/capability PermissionRequired, GrantStoreError, PlatformError projection & metadata snapshot fuzz invariants", () => {
  it("permissionRequired, permissionDenied, GrantStoreError, toPlatformError/fromPlatformError round-trip & freeze metadata safely", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        action: Capability.Action,
        resource: validResource,
        requestId: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9_-]{1,20}$/))),
        runId: Schema.OptionFromUndefinedOr(Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9_-]{1,16}$/)))),
        tier: Capability.EffectTier,
        errKind: Schema.Literals(["required", "denied", "grantStore"]),
        grantCode: Permission.GrantStoreErrorCode,
        metaKey: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z]{1,8}$/))),
        metaVal: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(24))),
          Schema.Int,
          Schema.Boolean,
          Schema.Null,
          Schema.Array(Schema.Int).pipe(Schema.check(Schema.isMaxLength(4)))
        ]),
        pathOrFd: Schema.Union([Schema.String.pipe(Schema.check(Schema.isMaxLength(32))), Schema.Int])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ action, resource, requestId, runId, tier, errKind, grantCode, metaKey, metaVal, pathOrFd }) =>
          Effect.sync(() => {
            const cap = Capability.make(action, resource)
            const rId = Option.isSome(runId) ? runId.value : undefined
            let err: Permission.PermissionError
            if (errKind === "required") {
              const rawMeta: Record<string, unknown> = { [metaKey]: metaVal, nested: { ok: true } }
              const req = Permission.permissionRequired({
                requestId,
                runId: rId,
                capability: cap,
                tier,
                meta: rawMeta
              })
              // Mutating caller's rawMeta MUST NOT affect req.meta!
              rawMeta[metaKey] = "MUTATED"
              if (req.meta[metaKey] === "MUTATED" && metaVal !== "MUTATED") return false
              if (!Object.isFrozen(req.meta)) return false
              err = req
            } else if (errKind === "denied") {
              err = Permission.permissionDenied(cap, "denied_by_policy")
            } else {
              err = new Permission.GrantStoreError({ code: grantCode, message: "store fault" })
            }

            if (!Permission.isPermissionError(err)) return false
            if (Permission.isPermissionError(null) || Permission.isPermissionError({})) return false
            const formatted = Permission.formatError(err)
            if (formatted.length === 0) return false
            const decoded = decodePermissionError(err)
            if (Option.isNone(decoded)) return false

            // PlatformError projection round-trip
            const plat = Permission.toPlatformError({
              module: "FileSystem",
              method: "readFile",
              pathOrDescriptor: pathOrFd,
              error: err
            })
            const back = Permission.fromPlatformError(plat)
            if (Option.isNone(back)) return false
            if (back.value.code !== err.code) return false
            return true
          }),
        { seed: seed + 10, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
