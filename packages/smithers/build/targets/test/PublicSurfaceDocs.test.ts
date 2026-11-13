import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as S from "../src/Smithers.ts"

const readDoc = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

describe("public surface documentation", () => {
  it("uses configurable LlmLint instead of removed repository review macros", () => {
    const api = readDoc("docs/api.md")
    expect(api).toContain("`LlmLint` with explicit instructions")
    expect(api).not.toMatch(/DurableIdentityGuard|DocsReferenceSync|JsdocTruthfulness/)
  })

  it.each(["README.md", "docs/reference/targets.md"])(
    "%s documents Cargo target selectors without legacy check overloads",
    (path) => {
      const doc = readDoc(path)
      expect(doc).toMatch(/workspace: true/)
      expect(doc).toMatch(/package: /)
      expect(doc).toMatch(/crates: /)
      expect(doc).not.toMatch(/CargoLint|CargoTest|Cargo\.Clippy\(\)|check values?/)
    }
  )

  it.each(["README.md", "docs/api.md", "docs/reference/targets.md"])(
    "%s describes opaque Target declarations and explicit execution",
    (path) => {
      const doc = readDoc(path)
      expect(doc).not.toMatch(
        /returns a Flow|Flow declarations with planner metadata|whose declarations every rule returns/
      )
      expect(doc).toMatch(/opaque `Target` declaration/)
      expect(doc).toContain("package executor")
      expect(doc).toContain("Target.plan(target)")
    }
  )

  it.each(["README.md", "docs/reference/targets.md", "docs/reference/cheat-sheet.md"])(
    "%s names the Rust toolchain facade Rust, not the removed RustToolchain alias",
    (path) => {
      const doc = readDoc(path)
      expect(doc).not.toMatch(/\b(?:S|Smithers)\.RustToolchain\b|BUILD-era/)
      expect(doc).toContain("Rust.Toolchain")
    }
  )
})

const fencedBlocks = (doc: string): Array<string> =>
  [...doc.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? "")

describe("documented examples construct", () => {
  it("README runtime overrides name a Bun requirement the constructor accepts", () => {
    const readme = readDoc("README.md")
    const requirements = [...readme.matchAll(/Runtime\.Bun\(\{\s*version:\s*"([^"]+)"/g)].map((match) => match[1])
    expect(requirements.length).toBeGreaterThan(0)
    for (const version of requirements) expect(() => S.Runtime.Bun({ version: version as never })).not.toThrow()
  })

  it("README examples declare each import binding once", () => {
    for (const block of fencedBlocks(readDoc("README.md"))) {
      const bindings = [...block.matchAll(/^import\s+\{([^}]*)\}/gm)]
        .flatMap((match) => (match[1] ?? "").split(",").map((name) => name.trim().split(/\s+as\s+/).pop() ?? ""))
        .filter((name) => name !== "")
      expect(bindings).toEqual([...new Set(bindings)])
    }
  })

  it("api.md documents the attrs refusal instead of an opaque-handle pass-through", () => {
    const api = readDoc("docs/api.md")
    expect(api).not.toMatch(/non-plain prototype passes through/)
    expect(api).toMatch(/a target, and a\s+dependency selector/)
    expect(api).toMatch(/refused before the schema/)
  })
})

describe("catalog and reference accuracy", () => {
  it("counts every table row and includes cross-repository targets", () => {
    const rules = readDoc("docs/rules.md")
    const rows = [...rules.matchAll(/^\| `([^`]+)`/gm)]
    expect(new Set(rows.map((row) => row[1])).size).toBe(rows.length)
    expect(rows.map((row) => row[1])).toContain("Repo.Target")
    expect(rules).toContain(`${rows.length} rules.`)
    const overview = readDoc("docs/README.md")
    expect(overview).toContain(`catalog holds ${rows.length} rules`)
    expect(overview).toContain(`lists all ${rows.length}`)
  })

  it("states native cache replay modes and the explicit opt-out", () => {
    const rows = new Map(
      readDoc("docs/rules.md").split("\n")
        .filter((line) => line.startsWith("| `"))
        .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
        .map((cells) => [cells[0]?.replaceAll("`", ""), cells[3]])
    )
    for (const rule of ["Cargo.Clippy", "Cargo.Deny", "Cargo.Fmt", "Cargo.Nextest", "Cargo.Test"]) {
      expect(rows.get(rule), rule).toBe("read")
    }
    for (const rule of ["Fetch", "Go.Binary", "Go.Fuzz", "Go.ModDownload", "Go.Test", "Shell.Build", "Test"]) {
      expect(rows.get(rule), rule).toBe("yes")
    }
    for (const rule of ["Go.Generate", "Go.Lint"]) expect(rows.get(rule), rule).toBe("no")
    expect(rows.get("Generate")).toBe("check")
    expect(rows.get("Shell.Test")).toBe("execute")
    expect(rows.get("Repo.Target")).toBe("clean repository")
    expect(readDoc("docs/rules.md")).toContain("`cache: false`")
  })

  it("documents the accepted Cargo.Fetch selector and explicit module exports", () => {
    const reference = readDoc("docs/reference/targets.md")
    expect(reference).toContain("`Cargo.Fetch` accepts at most one of `workspace` or `crates`")
    expect(reference).not.toContain("every module under `src` through the `./*` subpath")
    expect(reference).toContain("explicit")
    const cheatSheet = readDoc("docs/reference/cheat-sheet.md")
    expect(cheatSheet).toContain("Shell rules require exactly one of bin, bun, shell, or script")
    const cargoBuild = /S\.Cargo\.Build\(\{([\s\S]*?)\n\}\)/.exec(cheatSheet)?.[1]
    expect(cargoBuild).toBeDefined()
    expect(cargoBuild).not.toContain("container:")
  })
})
