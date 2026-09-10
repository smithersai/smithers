/**
 * The barrels, and whether they still re-export what they claim.
 *
 * Ported from the Smithers 0.x `packages/smithers/tests/barrels` and
 * `umbrella-agent-exports` suites. Both existed for one defect: a symbol that is
 * *typed* as exported while the hand-maintained re-export list never got the
 * entry, so `import { thing } from "…"` typechecks and then throws at load. A
 * typecheck cannot catch it, because it reads the same source the declarations
 * are generated from. The only thing that catches it is importing the module.
 *
 * The 0.x umbrella is gone. `@smthrs/flows` is the barrel now, and it publishes
 * its own list of the namespaces it re-exports, which is what makes this
 * checkable rather than a hand-written roster that drifts.
 *
 * Run it with `node --test "scripts/repo-contract/*.test.mjs"`.
 */
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { libraryPackages } from "../workspace-packages.mjs"

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..")

/**
 * The barrel is imported by path rather than by name.
 *
 * `@smthrs/flows` is not a dependency of the repository root, and making it one
 * to satisfy a gate would put a runtime package in the root manifest for no
 * other reason. Node resolves the module's own `@smthrs/*` imports relative to
 * the file, so the workspace link does the rest.
 */
const barrel = () => import(pathToFileURL(join(root, "packages", "smithers", "flows", "src", "index.ts")).href)

describe("the @smthrs/flows barrel", () => {
  it("re-exports every namespace it says it does, at runtime", async () => {
    const flows = await barrel()
    assert.ok(Array.isArray(flows.namespaces), "the barrel must publish its namespace list")
    for (const name of flows.namespaces) {
      assert.ok(
        Object.hasOwn(flows, name),
        `@smthrs/flows lists ${name} in namespaces but does not export it; the list and the re-exports have drifted`
      )
    }
  })

  it("lists every namespace it exports, so the list cannot fall behind", async () => {
    const flows = await barrel()
    const listed = new Set(flows.namespaces)
    const exported = Object.keys(flows).filter((name) => name !== "namespaces")
    for (const name of exported) {
      assert.ok(
        listed.has(name),
        `@smthrs/flows exports ${name} without listing it in namespaces`
      )
    }
  })

  it("declares a dependency on every package it re-exports", () => {
    const manifest = JSON.parse(readFileSync(join(root, "packages", "smithers", "flows", "package.json"), "utf8"))
    const source = readFileSync(join(root, "packages", "smithers", "flows", "src", "index.ts"), "utf8")
    const dependencies = new Set(Object.keys(manifest.dependencies ?? {}))
    for (const match of source.matchAll(/^export \* (?:as \w+ )?from "(@smthrs\/[^"]+)"/gm)) {
      const name = match[1].split("/").slice(0, 2).join("/")
      assert.ok(
        dependencies.has(name),
        `packages/smithers/flows re-exports ${name} without declaring it as a dependency; the import resolves through the `
          + "workspace link and then fails for anyone who installs the tarball"
      )
    }
  })
})

describe("the 0.x umbrella", () => {
  it("is a migration notice that refuses to run rather than a compatibility shim", async () => {
    const manifest = JSON.parse(readFileSync(join(root, "packages", "smthrs-deprecation", "package.json"), "utf8"))
    assert.equal(manifest.name, "smthrs", "the unscoped name must still be claimed, or somebody else can take it")
    const source = readFileSync(join(root, "packages", "smthrs-deprecation", "src", "index.ts"), "utf8")
    assert.match(
      source,
      /throw|Error/,
      "importing the 0.x umbrella must fail loudly; a silent empty module reads as a working install"
    )
  })
})

describe("every package's declared root export", () => {
  const packages = libraryPackages(root).filter((entry) => entry.manifest.private !== true)

  it("points at a file that exists", () => {
    for (const entry of packages) {
      const root_ = entry.manifest.exports?.["."]
      const target = typeof root_ === "string" ? root_ : root_?.import
      assert.ok(typeof target === "string", `${entry.dir} has no resolvable root export`)
      assert.ok(
        existsSync(join(root, entry.dir, target)),
        `${entry.dir} points its root export at ${target}, which does not exist`
      )
    }
  })
})
