/**
 * The native rule table: which rules it pairs, how each caches, and the
 * refusal `prepare` gives a planned node its executor cannot run.
 *
 * `prepare` runs before a cache hit can bypass execution, so a node whose plan
 * was refused must fail there with a sentence naming the rule, not reach a
 * family executor with fields it never planned.
 */
import { describe, expect, it } from "vitest"
import type * as Rule from "../src/internal/RuleContract.ts"
import * as NativeRules from "../src/internal/rules/NativeRules.ts"

const refused = (rule: string): Rule.PlannedRule =>
  ({
    label: `//:${rule}`,
    rule,
    family: "refused",
    lane: undefined,
    refusal: "planned refusal",
    outFiles: []
  }) as unknown as Rule.PlannedRule

const context = { root: "/nonexistent-native-rules-root", signal: undefined, nodes: new Map() }

describe("native rules", () => {
  it("pairs exactly the native rules, each with its cache kind", () => {
    expect(NativeRules.get("Fetch")?.cache).toBe("artifacts")
    expect(NativeRules.get("Copy")?.cache).toBe("artifacts")
    expect(NativeRules.get("Literal")?.cache).toBe("artifacts")
    expect(NativeRules.get("Docs.Check")?.cache).toBe("result")
    expect(NativeRules.get("Shell.Test")).toBeUndefined()
    // Only own keys name a rule; an inherited property is not one.
    expect(NativeRules.get("toString")).toBeUndefined()
  })

  it.each([
    ["Fetch", "Fetch planned no single output file"],
    ["Copy", "Copy planned no single output file"],
    ["Literal", "Literal planned no single output file"],
    ["Docs.Check", "Docs.Check planned no closure"]
  ])("refuses to prepare a refused %s node", (rule, message) => {
    expect(() => NativeRules.get(rule)!.prepare(refused(rule), context)).toThrow(message)
  })
})
