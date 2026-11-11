/**
 * Rule policy table: an explicit row per native rule, cache eligibility across
 * every mode and repository state, and the capabilities each rule implies.
 */
import { describe, expect, it } from "vitest"
import type { Mode, PlannedRule } from "../src/internal/RuleContract.ts"
import * as RulePolicy from "../src/internal/RulePolicy.ts"

const modes: ReadonlyArray<Mode> = ["execute", "check", "write"]
const dirtyStates: ReadonlyArray<boolean | undefined> = [true, false, undefined]

const cacheableIn = (rule: string): ReadonlyArray<string> =>
  modes.flatMap((mode) =>
    dirtyStates.filter((dirty) => RulePolicy.cacheable(rule, mode, dirty)).map((dirty) => `${mode}/${String(dirty)}`)
  )

describe("rule policy rows", () => {
  it.each([
    ["Cargo.Build", { writes: true }],
    ["Cargo.Doc", { writes: true }],
    ["Cargo.Fetch", { writes: true }],
    ["Cargo.Test", { writes: true, cache: "read" }],
    ["Cargo.Fmt", { check: true, cache: "read" }],
    ["Cargo.AppSet", { reads: "declared" }],
    ["Alias", { reads: "declared" }],
    ["Filegroup", { reads: "declared" }],
    ["Go.Packages", { reads: "declared" }],
    ["ImportClosure", {}],
    ["Install", {}],
    ["Suite", { reads: "declared" }]
  ])("states %s explicitly instead of defaulting", (rule, policy) => {
    expect(RulePolicy.of(rule)).toEqual(policy)
  })

  it("leaves declaration bodies without an intrinsic policy", () => {
    expect(RulePolicy.of("Some.Declared.Rule")).toEqual({})
  })
})

describe("rule cache eligibility", () => {
  it("caches an always rule in every mode and repository state", () => {
    expect(cacheableIn("Test")).toEqual([
      "execute/true",
      "execute/false",
      "execute/undefined",
      "check/true",
      "check/false",
      "check/undefined",
      "write/true",
      "write/false",
      "write/undefined"
    ])
  })

  it("caches a mode-scoped rule only in its own mode", () => {
    expect(cacheableIn("Foundry.Test")).toEqual(["execute/true", "execute/false", "execute/undefined"])
    expect(cacheableIn("Generate")).toEqual(["check/true", "check/false", "check/undefined"])
  })

  it("refuses a read rule in write mode", () => {
    expect(RulePolicy.cacheable("Cargo.Clippy", "execute", undefined)).toBe(true)
    expect(RulePolicy.cacheable("Cargo.Clippy", "check", undefined)).toBe(true)
    expect(RulePolicy.cacheable("Cargo.Clippy", "write", undefined)).toBe(false)
  })

  it("caches a clean-repository rule only against a proven clean tree", () => {
    expect(cacheableIn("Repo.Target")).toEqual(["execute/false", "check/false", "write/false"])
    expect(RulePolicy.cacheable("Repo.Target", "execute", true)).toBe(false)
    expect(RulePolicy.cacheable("Repo.Target", "execute", undefined)).toBe(false)
  })

  it("never caches a rule without a cache policy", () => {
    expect(cacheableIn("Shell.Run")).toEqual([])
    expect(cacheableIn("Some.Declared.Rule")).toEqual([])
  })
})

describe("rule capabilities", () => {
  const sandbox: PlannedRule["sandbox"] = undefined

  it("always reads the filesystem and spawns processes", () => {
    expect(RulePolicy.capabilities("Suite", "execute", sandbox)).toEqual(["fs:read", "proc:spawn"])
  })

  it("writes in write mode, for a writing rule, and for a cargo rule that builds", () => {
    expect(RulePolicy.capabilities("Suite", "write", sandbox)).toContain("fs:write")
    expect(RulePolicy.capabilities("Copy", "execute", sandbox)).toContain("fs:write")
    expect(RulePolicy.capabilities("Cargo.Build", "execute", sandbox)).toContain("fs:write")
    expect(RulePolicy.capabilities("Cargo.Test", "check", sandbox)).toContain("fs:write")
  })

  it("keeps cargo rules that only read out of the write set", () => {
    expect(RulePolicy.capabilities("Cargo.Fmt", "check", sandbox)).toEqual(["fs:read", "proc:spawn"])
    expect(RulePolicy.capabilities("Cargo.AppSet", "check", sandbox)).toEqual(["fs:read", "proc:spawn"])
  })

  it("denies a declaration body the write set on the strength of its name", () => {
    expect(RulePolicy.capabilities("Cargo.Homegrown", "execute", sandbox)).toEqual(["fs:read", "proc:spawn"])
  })

  it("opens the network exactly as the sandbox allows", () => {
    expect(RulePolicy.capabilities("Suite", "execute", "none")).toContain("net:open")
    expect(RulePolicy.capabilities("Suite", "execute", { network: true })).toContain("net:open")
    expect(RulePolicy.capabilities("Suite", "execute", { network: "loopback" })).toContain("net:loopback")
    expect(RulePolicy.capabilities("Suite", "execute", { network: false })).toEqual(["fs:read", "proc:spawn"])
  })
})
