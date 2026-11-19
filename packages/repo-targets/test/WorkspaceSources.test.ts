import * as Filegroup from "@smthrs/targets/Filegroup"
import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { repoRoot } from "../scripts/workspace-packages.mjs"
import { WorkspaceSources } from "../src/WorkspaceSources.ts"

const context: Target.ImplementationContext = { sourceFile: undefined, packageDirectory: undefined }
const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A workspace of packages under `packages/`, each a manifest, with a `src/` and a `bin/` unless `without` names it. */
const workspace = (
  manifests: Readonly<Record<string, Record<string, unknown>>>,
  without: Readonly<Record<string, ReadonlyArray<string>>> = {}
): string => {
  const root = mkdtempSync(join(tmpdir(), "repo-targets-workspace-sources-"))
  roots.push(root)
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
  for (const [dir, manifest] of Object.entries(manifests)) {
    for (const directory of ["src", "bin"].filter((name) => !(without[dir] ?? []).includes(name))) {
      mkdirSync(join(root, "packages", dir, directory), { recursive: true })
      writeFileSync(join(root, "packages", dir, directory, "index.js"), "\n")
    }
    mkdirSync(join(root, "packages", dir), { recursive: true })
    writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify({ name: `@w/${dir}`, ...manifest }))
  }
  return root
}

const sourcesOf = (group: Target.AnyTarget) => Filegroup.sources(Target.metadata(group).attrs as Filegroup.Attrs, context)

describe("WorkspaceSources", () => {
  it("names every package reached through the manifests, once each, and not the package itself", () => {
    const root = workspace({
      own: {
        dependencies: { "@w/runtime": "workspace:*", "left-pad": "1.3.0" },
        devDependencies: { "@w/tooling": "workspace:*" },
        peerDependencies: { "@w/peer": "workspace:*" }
      },
      runtime: { dependencies: { "@w/shared": "workspace:*", "@w/own": "workspace:*" } },
      tooling: { dependencies: { "@w/shared": "workspace:*" }, devDependencies: { "@w/unreached": "workspace:*" } },
      shared: { peerDependencies: { "@w/peerofshared": "workspace:*" } },
      peerofshared: {},
      peer: {},
      unreached: {}
    })
    const groups = WorkspaceSources({ cwd: "packages/own", root })
    expect(Object.keys(groups)).toEqual([
      "sources-packages-peer",
      "sources-packages-peerofshared",
      "sources-packages-runtime",
      "sources-packages-shared",
      "sources-packages-tooling"
    ])
    expect(sourcesOf(groups["sources-packages-runtime"]!)).toEqual([
      { base: "", source: Input.glob("packages/runtime/src/**") },
      { base: "", source: Input.glob("packages/runtime/bin/**") },
      { base: "", source: Input.file("packages/runtime/package.json") },
      { base: "", source: Input.glob("packages/runtime/{tsconfig,jsconfig,vibe.config}.json") }
    ])
  })

  it("takes the files a run reads of each package", () => {
    const root = workspace({ own: { dependencies: { "@w/runtime": "workspace:*" } }, runtime: {} })
    const groups = WorkspaceSources({ cwd: "packages/own", root, files: ["lib/*.js", "tsconfig.json"] })
    expect(sourcesOf(groups["sources-packages-runtime"]!)).toEqual([
      { base: "", source: Input.glob("packages/runtime/lib/*.js") },
      { base: "", source: Input.file("packages/runtime/tsconfig.json") }
    ])
  })

  it("leaves out a directory pattern for a package without that directory", () => {
    const root = workspace({ own: { dependencies: { "@w/runtime": "workspace:*" } }, runtime: {} }, { runtime: ["bin"] })
    expect(sourcesOf(WorkspaceSources({ cwd: "packages/own", root })["sources-packages-runtime"]!)).toEqual([
      { base: "", source: Input.glob("packages/runtime/src/**") },
      { base: "", source: Input.file("packages/runtime/package.json") },
      { base: "", source: Input.glob("packages/runtime/{tsconfig,jsconfig,vibe.config}.json") }
    ])
  })

  it("names no missing directory among this repository's groups for packages/ci", () => {
    // `smthrs target //:targetIndex --write`, which a release cut runs, refused 46 `bin/**` patterns of these groups.
    const named = Object.values(WorkspaceSources({ cwd: "packages/ci" })).flatMap((group) =>
      sourcesOf(group).flatMap(({ source }) => /^(.+)\/\*\*$/.exec("pattern" in source ? source.pattern : "")?.[1] ?? [])
    )
    expect(named.length).toBeGreaterThan(40)
    expect(named.filter((directory) => !existsSync(join(repoRoot, directory)))).toEqual([])
  })

  it("refuses a directory that is not a workspace package", () => {
    const root = workspace({ own: {} })
    expect(() => WorkspaceSources({ cwd: "packages/missing", root })).toThrow(
      "WorkspaceSources: packages/missing is not a workspace package"
    )
  })

  it("reads this repository when no root is given", () => {
    const groups = WorkspaceSources({ cwd: "packages/ci" })
    expect(Object.keys(groups)).toContain("sources-packages-smithers-build-targets")
    expect(Object.keys(groups)).not.toContain("sources-packages-ci")
  })
})
