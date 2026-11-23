import * as Option from "effect/Option"
import { describe, test } from "vitest"
import { Capability, CapabilitySet, Permission } from "../src/index.ts"

const mustCap = (value: string) => Option.getOrThrow(Capability.parse(value))
const mustPat = (value: string) => Option.getOrThrow(Capability.parsePattern(value))

const rawCapability = "fs:read:/workspace/packages/smithers/flows/engine/src/Engine.ts"
const rawPattern = "fs:read:/workspace/packages/**/src/*.ts"

const parsedCapability = mustCap(rawCapability)
const parsedPattern = mustPat(rawPattern)
const broadPattern = mustPat("fs:read:/workspace/**")

const configuredRules: ReadonlyArray<Permission.Rule> = [
  new Permission.Rule({ pattern: mustPat("fs:read:/workspace/**"), effect: "allow" }),
  new Permission.Rule({ pattern: mustPat("fs:write:/workspace/packages/**"), effect: "allow" }),
  new Permission.Rule({ pattern: mustPat("fs:*:/workspace/**/.env*"), effect: "deny" }),
  new Permission.Rule({ pattern: mustPat("fs:*:/etc/**"), effect: "deny" }),
  new Permission.Rule({ pattern: mustPat("net:get:api.github.com/**"), effect: "allow" }),
  new Permission.Rule({ pattern: mustPat("net:private:*"), effect: "deny" }),
  new Permission.Rule({ pattern: mustPat("proc:spawn:pnpm"), effect: "allow" }),
  new Permission.Rule({ pattern: mustPat("proc:spawn:jj"), effect: "allow" })
]

const grantRules: ReadonlyArray<Permission.Rule> = Array.from({ length: 24 }, (_, index) =>
  new Permission.Rule({
    pattern: mustPat(`fs:read:/workspace/packages/pkg-${index}/**`),
    effect: index % 5 === 0 ? "ask" : "allow"
  }))

const rulesets = [configuredRules, grantRules] as const

const parentCeiling = CapabilitySet.fromPatterns([
  broadPattern,
  mustPat("fs:write:/workspace/packages/**"),
  mustPat("proc:spawn:*")
])
const childCeiling = CapabilitySet.fromPatterns([
  parsedPattern,
  mustPat("proc:spawn:pnpm")
])
const intersectedCeiling = CapabilitySet.intersect(parentCeiling, childCeiling)

const opts = { time: 120, warmupTime: 30 }

const parseCap = Capability.parse
const parsePat = Capability.parsePattern
const matchesCap = Capability.matches
const subsumesPat = Capability.subsumes
const evaluateRules = Permission.evaluate
const intersectSet = CapabilitySet.intersect
const allowsSet = CapabilitySet.allows
const withinSet = CapabilitySet.within

describe("@smthrs/capability", () => {
  test("Capability.parse and parsePattern", async ({ bench }) => {
    await bench("Capability.parse", () => {
      parseCap(rawCapability)
    }).run(opts)

    await bench("Capability.parsePattern", () => {
      parsePat(rawPattern)
    }).run(opts)
  })

  test("Capability.matches glob pattern", async ({ bench }) => {
    await bench("Capability.matches", () => {
      matchesCap(parsedPattern, parsedCapability)
    }).run(opts)
  })

  test("Capability.subsumes glob containment", async ({ bench }) => {
    await bench("Capability.subsumes", () => {
      subsumesPat(broadPattern, parsedPattern)
    }).run(opts)
  })

  test("Permission.evaluate across 32 rules", async ({ bench }) => {
    await bench("Permission.evaluate (32 rules)", () => {
      evaluateRules(rulesets, parsedCapability)
    }).run(opts)
  })

  test("CapabilitySet intersect, allows, and within", async ({ bench }) => {
    await bench("CapabilitySet.intersect", () => {
      intersectSet(parentCeiling, childCeiling)
    }).run(opts)

    await bench("CapabilitySet.allows", () => {
      allowsSet(intersectedCeiling, parsedCapability)
    }).run(opts)

    await bench("CapabilitySet.within", () => {
      withinSet(intersectedCeiling, parentCeiling)
    }).run(opts)
  })
})
