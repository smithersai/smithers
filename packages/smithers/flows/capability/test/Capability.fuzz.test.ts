import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Capability, Permission } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "2000" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const seg = Schema.Literals(["src", "lib", "secrets", "config", "a.ts", "b.ts", "key", "env"])
const patSeg = Schema.Literals(["src", "lib", "secrets", "*", "**", "*.ts", "key"])

describe("@smthrs/capability fuzz invariants", () => {
  it("subsumption and overlap are sound: subsumes(p1, p2) && matches(p2, c) => matches(p1, c)", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        a1: Capability.PatternAction,
        a2: Capability.PatternAction,
        ac: Capability.Action,
        p1: Schema.Array(patSeg),
        p2: Schema.Array(patSeg),
        rc: Schema.Array(seg)
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ a1, a2, ac, p1, p2, rc }) => {
          const r1 = "/" + (p1.slice(0, 4).join("/") || "src")
          const r2 = "/" + (p2.slice(0, 4).join("/") || "src")
          const res = "/" + (rc.slice(0, 4).join("/") || "src")
          const pat1Opt = Capability.parsePattern(`${a1}:${r1}`)
          const pat2Opt = Capability.parsePattern(`${a2}:${r2}`)
          const cap = Capability.make(ac, res)
          if (Option.isNone(pat1Opt) || Option.isNone(pat2Opt)) return true
          const pat1 = pat1Opt.value
          const pat2 = pat2Opt.value

          // Format -> parse round-trip.
          const rt = Capability.parse(Capability.format(cap))
          if (Option.isNone(rt) || rt.value.action !== cap.action || rt.value.resource !== cap.resource) return false

          const m1 = Capability.matches(pat1, cap)
          const m2 = Capability.matches(pat2, cap)

          // Subsumption soundness: attenuation MUST NEVER widen privilege.
          if (Capability.subsumes(pat1, pat2) && m2 && !m1) return false

          // Overlap soundness: common match implies mayOverlap.
          if (m1 && m2 && !Capability.mayOverlap(pat1, pat2)) return false
          return true
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("security invariants: wildcard allow never grants net:private; configured deny vetoes later allows; traversal denies", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        host: Schema.Literals(["127.0.0.1", "10.0.0.1", "169.254.169.254", "localhost", "api.example.com"]),
        pathParts: Schema.Array(seg),
        traversal: Schema.Literals(["/../secrets/key", "//secrets/key", "/secrets/key/", "/./secrets/key"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ host, pathParts, traversal }) => {
          const wildcardAllow: ReadonlyArray<Permission.Rule> = [
            { effect: "allow", pattern: Option.getOrThrow(Capability.parsePattern("*:**")) }
          ]
          // Wildcard allow MUST NEVER allow net:private.
          const privDecision = Permission.evaluate([wildcardAllow], Capability.make("net:private", host))
          if (privDecision === "allow") return false

          // Configured deny in rulesets[0] MUST veto any allow in rulesets[1].
          const targetPath = "/" + (pathParts.slice(0, 3).join("/") || "secrets/key")
          const cap = Capability.make("fs:read", targetPath)
          const veto = Permission.evaluate(
            [
              [{ effect: "deny", pattern: Option.getOrThrow(Capability.parsePattern(`fs:read:${targetPath}`)) }],
              [{ effect: "allow", pattern: Option.getOrThrow(Capability.parsePattern("fs:read:/**")) }]
            ],
            cap
          )
          if (veto !== "deny") return false

          // Non-canonical absolute path with ., .., // or trailing / MUST fail closed to deny.
          const travDecision = Permission.evaluate([wildcardAllow], Capability.make("fs:read", traversal))
          return travDecision === "deny"
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("arbitrary adversarial strings never crash parse, parsePattern, or evaluate", async () => {
    const arb = Arbitrary.schema(Schema.Tuple([Schema.String, Schema.String]))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ([rawPat, rawRes]) => {
          const pat = Capability.parsePattern(rawPat)
          const cap = Capability.parse(rawRes)
          if (Option.isSome(pat) && Option.isSome(cap)) {
            const decision = Permission.evaluate([[{ effect: "allow", pattern: pat.value }]], cap.value)
            return decision === "allow" || decision === "deny" || decision === "ask"
          }
          return true
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
