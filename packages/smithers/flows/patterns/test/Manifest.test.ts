import { describe, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const sourceDirectory = join(packageRoot, "src")

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  readonly name: string
  readonly description: string
  readonly dependencies: Readonly<Record<string, string>>
}

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : []
  })

const importedPackages = (): ReadonlySet<string> => {
  const specifiers = new Set<string>()
  for (const file of sourceFiles(sourceDirectory)) {
    for (const match of readFileSync(file, "utf8").matchAll(/from\s+"([^".][^"]*)"/g)) {
      const specifier = match[1]
      if (specifier === undefined || specifier.startsWith(".")) continue
      const segments = specifier.split("/")
      specifiers.add(specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!)
    }
  }
  return specifiers
}

// The package description, the `src/index.ts` header, `README.md`, and
// `docs/README.md` all name the exact workspace packages this one composes. A
// dependency none of them mentions contradicts every one of them at once, so
// the manifest is pinned here rather than in prose.
//
// `@smthrs/flow` is the library every pattern declares onto: a pattern IS a
// flow, and it calls the members a caller hands it through their own `.call`.
// `@smthrs/plan` carries the shared vocabularies the case below pins, starting
// with `@smthrs/plan/Effects`, the single effect envelope model `@smthrs/flow`
// enforces. `@smthrs/plan` brings no database: its store lives in
// `@smthrs/plan-store`.
const declared = ["@smthrs/flow", "@smthrs/plan"]

describe("package manifest", () => {
  it("declares exactly the workspace packages it composes", () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual(declared)
  })

  it("says what it composes", () => {
    expect(manifest.description).toContain("composes @smthrs/flow and the one effect model")
  })

  it("imports no workspace package it did not declare", () => {
    // Doc examples inside `src` import the package by its own name, which is
    // a self-reference rather than a dependency.
    const workspaceImports = [...importedPackages()]
      .filter((name) => name.startsWith("@smthrs/") && name !== manifest.name)
      .sort()

    expect(workspaceImports).toEqual(declared)
  })

  // `@smthrs/plan` has no SQL surface: `PlanStore` and `Migrations` live in
  // `@smthrs/plan-store`, which is why neither this package nor `@smthrs/core`
  // carries `@smthrs/database` in its dependency closure. This case keeps the
  // import narrow anyway, so a future plan module
  // cannot arrive here unnoticed. Five are named: the authoring vocabulary the
  // ported patterns build their bodies from, the planned reference those
  // bodies thread, the effect model, the cache policy `WithCache` declares and
  // the engine reads, and the ceiling vocabulary `Loop` shares with
  // `@smthrs/flow`'s `Poll`.
  it("takes only shared vocabularies from @smthrs/plan", () => {
    const specifiers = new Set<string>()
    for (const file of sourceFiles(sourceDirectory)) {
      for (const match of readFileSync(file, "utf8").matchAll(/from\s+"(@smthrs\/plan[^"]*)"/g)) {
        specifiers.add(match[1]!)
      }
    }

    expect([...specifiers].sort()).toEqual([
      "@smthrs/plan/CachePolicy",
      "@smthrs/plan/Effects",
      "@smthrs/plan/Node",
      "@smthrs/plan/Planned",
      "@smthrs/plan/Repetition"
    ])
  })
})
