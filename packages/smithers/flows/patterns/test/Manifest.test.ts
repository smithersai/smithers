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
// `@smthrs/plan` is here for ONE module, `@smthrs/plan/Effects`: the single
// effect envelope model, which `@smthrs/core` re-exports and `@smthrs/flow`
// enforces. Reading it through core's alias would hide which package owns it,
// and the import is already in the install graph through core either way.
// `@smthrs/plan` brings no database: its store lives in `@smthrs/plan-store`.
const declared = ["@smthrs/core", "@smthrs/plan"]

describe("package manifest", () => {
  it("declares exactly the workspace packages it composes", () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual(declared)
  })

  it("says what it composes", () => {
    expect(manifest.description).toContain("composes @smthrs/core and the one effect model in @smthrs/plan/Effects")
  })

  it("imports no workspace package it did not declare", () => {
    // Doc examples inside `src` import the package by its own name, which is
    // a self-reference rather than a dependency.
    const workspaceImports = [...importedPackages()]
      .filter((name) => name.startsWith("@smthrs/") && name !== manifest.name)
      .sort()

    expect(workspaceImports).toEqual(declared)
  })

  // `@smthrs/plan` no longer HAS a SQL surface: `PlanStore` and `Migrations`
  // moved to `@smthrs/plan-store`, which is why neither this package nor
  // `@smthrs/core` carries `@smthrs/database` in its dependency closure any
  // more. This case keeps the import narrow anyway, so a future plan module
  // cannot arrive here unnoticed.
  it("takes only the effect model from @smthrs/plan", () => {
    const specifiers = new Set<string>()
    for (const file of sourceFiles(sourceDirectory)) {
      for (const match of readFileSync(file, "utf8").matchAll(/from\s+"(@smthrs\/plan[^"]*)"/g)) {
        specifiers.add(match[1]!)
      }
    }

    expect([...specifiers]).toEqual(["@smthrs/plan/Effects"])
  })
})
