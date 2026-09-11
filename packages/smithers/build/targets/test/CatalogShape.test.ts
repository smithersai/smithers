/**
 * One shape for the whole catalog.
 *
 * Every rule a PACKAGE.ts file can declare exposes the same three things: the
 * rule id, the attrs schema, and the verbs it participates in. Half the
 * catalog used to export a hand-written wrapper annotated `Target.AnyTarget`
 * that carried none of them, so a tool reading a rule's attrs schema for
 * validation, documentation, or editor support worked for one arbitrary half.
 *
 * The check starts from the `Target.make` declarations in `src/` rather than
 * from what the namespace happens to expose. An earlier version of this file
 * collected namespace members that already had the shape and then asserted
 * they had it, so a rule that lost its shape dropped out of the collection
 * instead of failing: exactly the regression this file exists to catch could
 * not turn it red.
 */
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Smithers } from "../src/index.ts"
import * as Target from "../src/Target.ts"

const sourceDirectory = join(dirname(dirname(fileURLToPath(import.meta.url))), "src")

/**
 * Sugar and combinators, which take something other than one rule's attrs and
 * are therefore not reachable as the rule itself: `Alias` and `Materialize`
 * take a target, `Github.Ci` expands to a `Github.CiGen` declaration, and the
 * two `Bundler.Rspack` methods take named options a configured bundler
 * rebuilds its attrs from. Publishing an `attrs` schema on any of them would
 * describe an input the callable does not accept.
 */
const sugar = new Set([
  "Alias",
  "Materialize",
  "Github.Ci",
  "Bundler.Rspack.resolve",
  "Bundler.Rspack.build"
])

/** Reads the rule id one `Target.make` call names, literal or module constant. */
const ruleId = (text: string, head: string): string | undefined => {
  const literal = /^"([^"]+)"$/.exec(head)
  if (literal !== null) return literal[1]
  const binding = new RegExp(`\\bconst ${head} = "([^"]+)"`).exec(text)
  return binding === null ? undefined : binding[1]
}

/** Every rule id declared in `src/`, read from the sources rather than the namespace. */
const declaredRuleIds = (): ReadonlyArray<string> => {
  const ids: Array<string> = []
  for (const entry of readdirSync(sourceDirectory).sort()) {
    if (!entry.endsWith(".ts")) continue
    const text = readFileSync(join(sourceDirectory, entry), "utf8")
    for (const match of text.matchAll(/Target\.make\(\s*("[^"]+"|[A-Za-z_$][\w$]*)\s*,/g)) {
      const id = ruleId(text, match[1]!)
      expect(id, `${entry} declares a rule whose id this scan cannot read: ${match[1]}`).toBeDefined()
      ids.push(id!)
    }
  }
  return ids
}

const isDefinitionLike = (value: unknown): boolean =>
  typeof value === "function" && "id" in value && "attrs" in value && "kinds" in value

/** Every namespace member that claims a rule id, indexed by the id it claims. */
const exportedRules = (): ReadonlyMap<string, { readonly path: string; readonly value: unknown }> => {
  const found = new Map<string, { readonly path: string; readonly value: unknown }>()
  const seen = new Set<unknown>()
  const walk = (namespace: Readonly<Record<string, unknown>>, prefix: string, depth: number): void => {
    if (depth > 2) return
    for (const [key, value] of Object.entries(namespace)) {
      if (key.startsWith("_") || value === null || seen.has(value)) continue
      if (typeof value !== "function" && typeof value !== "object") continue
      const path = prefix === "" ? key : `${prefix}.${key}`
      const id = (value as { readonly id?: unknown }).id
      if (typeof id === "string" && !found.has(id)) {
        found.set(id, { path, value })
        continue
      }
      if (typeof value === "object") {
        seen.add(value)
        walk(value as Record<string, unknown>, path, depth + 1)
      }
    }
  }
  walk(Smithers as unknown as Record<string, unknown>, "", 0)
  return found
}

describe("every catalog rule exports one shape", () => {
  const declared = declaredRuleIds()
  const exported = exportedRules()

  it("declares a rule id exactly once", () => {
    const byId = new Map<string, number>()
    for (const id of declared) byId.set(id, (byId.get(id) ?? 0) + 1)
    expect([...byId].filter(([, count]) => count > 1)).toEqual([])
  })

  it("finds the whole catalog rather than a handful", () => {
    expect(declared.length).toBeGreaterThan(100)
  })

  it.each(declared.filter((id) => !sugar.has(id)))("%s is reachable on the namespace", (id) => {
    const entry = exported.get(id)
    expect(entry, `no Smithers member reports the rule id ${id}`).toBeDefined()
    const value = entry!.value as { id: unknown; attrs: unknown; kinds: unknown }
    expect(isDefinitionLike(value), `${entry!.path} carries no attrs or kinds`).toBe(true)
    expect(value.id).toBe(id)
    expect(typeof (value.attrs as { readonly make?: unknown }).make).toBe("function")
    expect(Array.isArray(value.kinds)).toBe(true)
  })

  it("names only sugar and combinators as exceptions", () => {
    for (const id of sugar) {
      expect(declared, `${id} is named an exception but is not a declared rule`).toContain(id)
      expect(exported.has(id), `${id} is named an exception but reports a rule id`).toBe(false)
    }
  })

  it("keeps the guarded rules callable and still refusing", () => {
    expect(Smithers.Cargo.Build.id).toBe("Cargo.Build")
    expect(() => Smithers.Cargo.Build({ locked: true } as never))
      .toThrow(/Cargo\.Build requires exactly one of/)
  })

  it("reports the rule id of a rule that was a bare wrapper", () => {
    expect(Smithers.Docker.Build.id).toBe("Docker.Build")
    expect(Smithers.Generate.id).toBe("Generate")
    expect(Smithers.Github.Pr.id).toBe("Github.Pr")
    expect(Smithers.Typecheck.id).toBe("Typecheck")
    expect(Smithers.Cargo.Clippy.id).toBe("Cargo.Clippy")
    expect(Smithers.Cargo.Fmt.id).toBe("Cargo.Fmt")
    expect(Smithers.Cargo.Test.id).toBe("Cargo.Test")
    expect(Smithers.Go.Packages.id).toBe("Go.Packages")
    expect(Smithers.ImportClosure.id).toBe("ImportClosure")
  })

  it("constructs each cargo gate as a target", () => {
    expect(Target.metadata(Smithers.Cargo.Fmt({ workspace: true, data: [], changes: [] })).target)
      .toBe("Cargo.Fmt")
    expect(Target.metadata(Smithers.Cargo.Clippy({ workspace: true, data: [] })).target)
      .toBe("Cargo.Clippy")
    expect(Target.metadata(Smithers.Cargo.Test({ workspace: true, data: [] })).target)
      .toBe("Cargo.Test")
  })

  it("still constructs a target from a guarded rule", () => {
    const target = Smithers.Cargo.Deny({
      config: Smithers.file("//deny.toml")
    })
    expect(Target.metadata(target).target).toBe("Cargo.Deny")
  })
})
