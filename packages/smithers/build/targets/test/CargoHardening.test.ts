import { describe, expect, it } from "vitest"
import * as Cargo from "../src/Cargo.ts"
import * as Target from "../src/Target.ts"

describe("Cargo.manifestFacts prototype safety", () => {
  it("refuses __proto__ as a metadata table segment without polluting Object.prototype", () => {
    expect(() =>
      Cargo.manifestFacts("[package]\nname = \"a\"\n[package.metadata.__proto__]\nsmithersPolluted = true\n")
    ).toThrow(/reserved/)
    expect(({} as Record<string, unknown>)["smithersPolluted"]).toBeUndefined()
  })

  it("refuses constructor and prototype as table segments", () => {
    for (const segment of ["constructor", "prototype"]) {
      expect(() => Cargo.manifestFacts(`[package.metadata.${segment}]\nx = 1\n`)).toThrow(/reserved/)
    }
  })

  it("refuses a reserved bare key inside a metadata table", () => {
    expect(() => Cargo.manifestFacts("[package.metadata.smithers]\n__proto__ = 1\n")).toThrow(/reserved/)
    expect(({} as Record<string, unknown>)["__proto__"]).toBe(Object.prototype)
  })

  it("returns a null-prototype metadata table", () => {
    const facts = Cargo.manifestFacts("[package]\nname = \"a\"\n[package.metadata.smithers]\ngroup = \"tooling\"\n")
    expect(facts.name).toBe("a")
    expect(Object.getPrototypeOf(facts.metadata)).toBeNull()
    expect(Object.getPrototypeOf(facts.metadata["smithers"] as object)).toBeNull()
    expect((facts.metadata["smithers"] as Record<string, unknown>)["group"]).toBe("tooling")
  })
})

describe("Cargo.metadataMatches own-property discipline", () => {
  it("does not match an inherited property", () => {
    const filter = { toString: "anything" }
    expect(Cargo.metadataMatches({}, filter)).toBe(false)
  })

  it("refuses a structure nested deeper than the bound", () => {
    let filter: Record<string, unknown> = { leaf: 1 }
    for (let depth = 0; depth < 40; depth += 1) filter = { nested: filter }
    expect(() => Cargo.metadataMatches(filter, filter)).toThrow(/too deep/)
  })

  it("refuses a manifest whose metadata table nests deeper than the bound", () => {
    const header = ["package", "metadata", ...Array.from({ length: 40 }, (_, index) => `t${index}`)].join(".")
    expect(() => Cargo.manifestFacts(`[${header}]\nx = 1\n`)).toThrow(/too deep/)
  })

  it("matches a subset of own properties", () => {
    expect(Cargo.metadataMatches({ a: 1, b: { c: 2 } }, { b: { c: 2 } })).toBe(true)
    expect(Cargo.metadataMatches({ a: 1 }, { a: 2 })).toBe(false)
  })

  // The depth bound alone leaves a wide filter unbounded: it is shallow, so it
  // never trips the depth check, and every manifest in a crate set is walked
  // against all of it.
  it("refuses a filter that compares more keys than the bound, however shallow", () => {
    const wide: Record<string, unknown> = {}
    for (let index = 0; index <= Cargo.maximumMetadataMembers; index += 1) wide[`k${index}`] = index
    expect(() => Cargo.metadataMatches(wide, wide)).toThrow(/more keys than the declaration bound/)
  })

  it("spends the member budget across the whole tree, not per level", () => {
    const level = (): Record<string, unknown> => {
      const table: Record<string, unknown> = {}
      for (let index = 0; index < 1000; index += 1) table[`k${index}`] = index
      return table
    }
    const wide: Record<string, unknown> = {}
    for (let index = 0; index < 12; index += 1) wide[`n${index}`] = level()
    expect(() => Cargo.metadataMatches(wide, wide)).toThrow(/more keys than the declaration bound/)
  })

  it("still matches a filter inside the bound", () => {
    const table: Record<string, unknown> = {}
    for (let index = 0; index < 100; index += 1) table[`k${index}`] = index
    expect(Cargo.metadataMatches(table, table)).toBe(true)
  })
})

describe("Cargo selector validation", () => {
  it("refuses a package-only Clippy key with no crate selector", () => {
    expect(() => Cargo.Clippy({ offline: true } as never)).toThrow(
      /Cargo\.Clippy requires exactly one of workspace, package, crates/
    )
  })

  it("refuses a package-only Test key with no crate selector", () => {
    expect(() => Cargo.Test({ noRun: true } as never)).toThrow(
      /Cargo\.Test requires exactly one of workspace, package, crates/
    )
  })

  it("builds a target when a selector is named", () => {
    expect(Target.isTarget(Cargo.Clippy({ workspace: true, offline: true, data: [] }) as never)).toBe(true)
    expect(Target.isTarget(Cargo.Test({ package: "aomi-sdk", noRun: true, data: [] }) as never)).toBe(true)
  })
})

describe("Cargo manifest TOML metadata safety", () => {
  it.each(["__proto__", "constructor", "prototype"])("refuses reserved %s keys in every table form", (key) => {
    for (
      const declaration of [
        "[package.metadata]\n" + key + " = 1",
        "[package]\nmetadata." + key + " = 1",
        "[package]\nmetadata = { " + key + " = 1 }",
        "[package.metadata]\naomi = { " + key + " = true }",
        "[package.metadata]\nentries = [{ " + key + " = true }]",
        "[[package.metadata.entries]]\n" + key + " = true"
      ]
    ) {
      expect(() => Cargo.manifestFacts(declaration)).toThrow(/reserved/)
    }
    expect(({} as Record<string, unknown>)["smithersPolluted"]).toBeUndefined()
  })

  it("copies arrays of tables to null-prototype records and preserves date values", () => {
    const facts = Cargo.manifestFacts([
      "[package.metadata]",
      "released = 2026-01-02",
      "values = [1, [true], { skip = false }]",
      "[[package.metadata.entries]]",
      "name = \"first\"",
      "[[package.metadata.entries]]",
      "name = \"second\""
    ].join("\n"))
    expect(facts.metadata["released"]).toBeInstanceOf(Date)
    expect((facts.metadata["released"] as Date).toISOString()).toBe("2026-01-02")
    expect(facts.metadata["values"]).toEqual([1, [true], { skip: false }])
    expect(facts.metadata["entries"]).toEqual([{ name: "first" }, { name: "second" }])
    for (const entry of facts.metadata["entries"] as Array<object>) expect(Object.getPrototypeOf(entry)).toBeNull()
    expect(Object.getPrototypeOf((facts.metadata["values"] as Array<unknown>)[2] as object)).toBeNull()
  })

  it.each(["", "package = 1", "[[package]]\nname = 'array'", "[package]\nname = 1\nmetadata = false"])(
    "returns no invented facts for %s",
    (manifest) => {
      const facts = Cargo.manifestFacts(manifest)
      expect(facts).toEqual({ name: undefined, metadata: {} })
      expect(Object.getPrototypeOf(facts.metadata)).toBeNull()
    }
  )

  it("accepts metadata tables at the nesting bound", () => {
    const path = Array.from({ length: Cargo.maximumMetadataDepth }, () => "nested")
    const facts = Cargo.manifestFacts("[package.metadata." + path.join(".") + "]\nleaf = true")
    let table = facts.metadata
    for (const key of path) {
      table = table[key] as Record<string, unknown>
      expect(Object.getPrototypeOf(table)).toBeNull()
    }
    expect(table["leaf"]).toBe(true)
  })

  it("bounds nested inline tables and arrays before walking them", () => {
    const depth = Cargo.maximumMetadataDepth + 5
    for (
      const value of [
        "{ n = ".repeat(depth) + "true" + " }".repeat(depth),
        "[".repeat(depth) + "true" + "]".repeat(depth)
      ]
    ) {
      expect(() => Cargo.manifestFacts("[package.metadata]\nvalue = " + value)).toThrow(/excessively nested/)
    }
  })
})
