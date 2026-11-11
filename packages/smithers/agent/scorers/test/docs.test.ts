import * as Effect from "effect/Effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Sampling from "../src/Sampling.vibe"
import * as Scorer from "../src/Scorer.ts"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

// The JSDoc scanner must not run past the end of a comment block, so the body
// pattern excludes a closing delimiter rather than matching lazily.
const documented = /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*export\s+(?:effect\s+)?(const|function|class|interface|type)\s+([A-Za-z0-9_$]+)/g

// `index.ts` is a barrel, so every namespace names a sibling module.
const namespaces = (): ReadonlyArray<readonly [string, string]> =>
  [...read("../src/index.ts").matchAll(/export \* as (\w+) from "\.\/(\w+)\.(ts|vibe)"/g)]
    .map(([, namespace, file, extension]) => [namespace!, `${file}.${extension}`] as const)

const exported = (): ReadonlyArray<string> => {
  const names = new Set<string>()
  for (const [namespace, file] of namespaces()) {
    for (const [, block, , name] of read(`../src/${file}`).matchAll(documented)) {
      if (block!.includes("@category")) names.add(`${namespace}.${name!}`)
    }
  }
  return [...names]
}

/**
 * Every categorized export as the member index spells it: the qualified name
 * and the declaration kind, because a name is documented once per kind and
 * two rows legitimately share one name (`ScorerError.ScorerErrorCode` is both
 * a `const` and a `type`).
 */
const members = (): ReadonlyArray<string> => {
  const rows: Array<string> = []
  for (const [namespace, file] of namespaces()) {
    for (const [, block, kind, name] of read(`../src/${file}`).matchAll(documented)) {
      if (block!.includes("@category")) rows.push(`${namespace}.${name!} ${kind!}`)
    }
  }
  return rows
}

/** The same pairs as the index records them. */
const indexed = (): ReadonlyArray<string> =>
  [...read("../docs/exports.md").matchAll(/^\| `([A-Za-z0-9_$.]+)` +\| (\w+) +\|/gmu)]
    .map(([, name, kind]) => `${name!} ${kind!}`)

const tabled = (): ReadonlyArray<string> =>
  [...read("../docs/api.md").matchAll(/^\| `([A-Za-z]+\.[A-Za-z0-9_$]+)` *\| /gmu)].map(([, name]) => name!)

/** The namespace column of a page's "exports these namespaces" table, in row order. */
const listed = (path: string): ReadonlyArray<string> =>
  [...read(path).matchAll(/^\| `(\w+)` *\| /gmu)].map(([, name]) => name!)

describe("documentation", () => {
  it("requires a shared selection for paired scorer comparisons", async () => {
    const sampling = { ratio: 0.5, seed: "same" }
    const decisions = await Promise.all(["judge-a", "judge-b"].map((id) => {
      const scorer = Scorer.make({ id, version: "1", score: () => Effect.succeed({ score: 1 }) })
      return Effect.runPromise(Sampling.decide(sampling, "step-3", scorer.scorerKey))
    }))
    expect(decisions).toEqual([false, true])

    const page = read("../docs/concepts/sampling.md").replace(/\s+/g, " ")
    expect(page).toContain("target, ratio, seed, and `scorerKey` all match")
    expect(page).toContain("one host-owned selection reused for both scorers")
    expect(page).toContain("sample everything with `\"all\"`")
  })

  it("tables every documented export exactly once", () => {
    const rows = tabled()
    expect(rows.length).toBeGreaterThan(0)
    expect([...new Set(rows)]).toEqual(rows)
    expect([...rows].sort()).toEqual([...exported()].sort())
  })

  it("points the README at the published documentation instead of repeating it", () => {
    const readme = read("../README.md")
    // npm renders this file, so its references have to resolve for a reader
    // who has only the tarball. A relative `docs/` path does not.
    expect(readme).toContain("https://github.com/smithersai/smithers/tree/main/packages/smithers/agent/scorers/docs")
    expect(readme).not.toMatch(/\]\(\.\/docs\//)
    // The package is on npm under `next`, where `latest` is an older release.
    expect(readme).toContain("npm install @smthrs/scorers@next effect")
    expect(readme).not.toMatch(/not on npm/i)
  })

  // `docs/exports.md` was written by `scripts/docs.mjs`, and this case ran that
  // generator with `--check`. The rc.0 docs-tooling dissolution deleted the
  // generator and `docs/Manifest.ts`, so the index is hand-maintained and the
  // drift check has to be the assertion itself rather than a spawn: the pairs
  // the sources document and the pairs the table records are the same list, in
  // the same order, so adding a member without adding its row fails here.
  it("keeps the member index current", () => {
    const rows = indexed()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows).toEqual(members())
    // The header states the size, and a stale count is the first thing a
    // reader trusts.
    expect(read("../docs/exports.md")).toContain(
      `${namespaces().length} namespaces, ${rows.length} documented members.`
    )
  })

  it("keeps repository-only install instructions out of the reader-facing docs", () => {
    // The changelog is where a version belongs, and it belongs under its own
    // release heading: a substring match also passes on prose that merely
    // mentions the version, including prose that denies the release.
    const version = (JSON.parse(read("../package.json")) as { readonly version: string }).version
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    expect(read("../CHANGELOG.md")).toMatch(new RegExp(`^## \\[${escaped}\\]`, "mu"))
    for (const path of ["../README.md", "../docs/README.md", "../docs/installation.md"]) {
      const page = read(path)
      expect(page).not.toContain("1.0.0-rc.0")
      // `workspace:*` resolves only inside the source tree, so it is not an
      // install instruction anyone reading the package can follow.
      expect(page).not.toContain("workspace:*")
    }
  })

  // Both READMEs hand-maintain a copy of the namespace table, and the copies
  // have drifted from the barrel before.
  it("lists every root namespace in both namespace tables", () => {
    const roots = [...namespaces().map(([namespace]) => namespace)].sort()
    expect(roots.length).toBeGreaterThan(0)
    for (const path of ["../README.md", "../docs/README.md"]) {
      const rows = listed(path)
      expect([...new Set(rows)]).toEqual(rows)
      expect([...rows].sort()).toEqual(roots)
    }
  })

  it("keeps every `@since` tag on the package's own version", () => {
    for (const [, file] of namespaces()) {
      expect(read(`../src/${file}`)).not.toContain("@since 1.0.0")
    }
  })
})
