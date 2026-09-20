/**
 * Why this package exists, as a gate.
 *
 * `PlanStore` and `Migrations` were modules of `@smthrs/plan`, so every caller
 * that merely compiled a plan installed `@smthrs/database` through it, and
 * `@smthrs/core` and `@smthrs/patterns` inherited the database in turn. The
 * split is only worth its manifest if that stays untrue, and a manifest edit
 * three packages away is exactly the kind of change nothing else here would
 * notice.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const flowsRoot = fileURLToPath(new URL("../../", import.meta.url))

/** The workspace directory each name lives in, for the packages this walk reaches. */
const directories: Readonly<Record<string, string>> = {
  "@smthrs/canonical": "canonical",
  "@smthrs/core": "core",
  "@smthrs/crypto": "crypto",
  "@smthrs/database": "database",
  "@smthrs/keys": "keys",
  "@smthrs/patterns": "patterns",
  "@smthrs/plan": "plan",
  "@smthrs/plan-store": "plan-store"
}

const dependencies = (name: string): ReadonlyArray<string> => {
  const directory = directories[name]
  if (directory === undefined) return []
  const manifest = JSON.parse(
    readFileSync(new URL(`${directory}/package.json`, `file://${flowsRoot}`), "utf8")
  ) as { readonly dependencies?: Readonly<Record<string, string>> }
  return Object.keys(manifest.dependencies ?? {})
}

/** Every workspace package reachable through runtime `dependencies`. */
const closure = (name: string): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const walk = (current: string) => {
    for (const dependency of dependencies(current)) {
      if (seen.has(dependency)) continue
      seen.add(dependency)
      walk(dependency)
    }
  }
  walk(name)
  return [...seen].sort()
}

describe("the plan/plan-store split", () => {
  it("keeps the database out of the closure of plan, core and patterns", () => {
    for (const name of ["@smthrs/plan", "@smthrs/core", "@smthrs/patterns"]) {
      expect(closure(name), name).not.toContain("@smthrs/database")
    }
  })

  it("puts the database in this package's closure, where the SQL is", () => {
    expect(closure("@smthrs/plan-store")).toContain("@smthrs/database")
  })

  it("walks far enough to see a transitive edge", () => {
    // Without this the first case could pass by reaching nothing at all.
    expect(closure("@smthrs/core")).toContain("@smthrs/plan")
    expect(closure("@smthrs/patterns")).toContain("@smthrs/plan")
    expect(closure("@smthrs/plan")).toContain("@smthrs/keys")
  })
})
