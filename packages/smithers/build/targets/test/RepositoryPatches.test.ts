/**
 * Temporary upstream fixes are declared in the workspace manifest. Install inputs
 * follow that declaration, so every patch changes the install key automatically.
 *
 * Bun reads patches only from the root package.json, never from
 * pnpm-workspace.yaml. The release cut regenerates bun.lock with no lock present,
 * so Bun migrates the workspace's patches into package.json and bun.lock. Both
 * copies must equal the declaration: a patch missing from them installs unpatched
 * under Bun, and a frozen Bun install does not notice.
 */
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Yaml from "yaml"
import * as Input from "../src/Input.ts"

const repositoryRoot = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "../../../../..")
const read = (path: string) => Fs.readFile(NodePath.join(repositoryRoot, path), "utf8")

describe("the repository's dependency patches", () => {
  it("declares the upstream fixes and includes every patch in install inputs", async () => {
    const manifest = await read("pnpm-workspace.yaml")
    const declared: Record<string, string> = Yaml.parse(manifest).patchedDependencies
    const patches = Object.values(declared)
    expect(patches.length).toBeGreaterThan(0)
    const files = (await Fs.readdir(NodePath.join(repositoryRoot, "patches")))
      .filter((name) => name.endsWith(".patch"))
      .map((name) => `patches/${name}`)
    expect([...new Set(patches)].sort()).toEqual(files.sort())
    const inputs = await Input.expandPnpmWorkspace(repositoryRoot, "", Input.pnpmWorkspace("//pnpm-workspace.yaml"))
    for (const patch of patches) {
      expect(await read(patch)).toMatch(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m)
      expect(inputs).toContain(patch)
    }
    expect(await read("pnpm-lock.yaml")).toMatch(/^patchedDependencies:/m)
  })

  it("mirrors every declared patch, and only those, into Bun's manifest and lock", async () => {
    const declared: Record<string, string> = Yaml.parse(await read("pnpm-workspace.yaml")).patchedDependencies
    expect(Object.keys(declared).length).toBeGreaterThan(0)
    expect(JSON.parse(await read("package.json")).patchedDependencies).toEqual(declared)
    // bun.lock is JSON with trailing commas; read its one flat patch table.
    const lock = await read("bun.lock")
    const start = lock.indexOf(`\n  "patchedDependencies": {\n`)
    expect(start).toBeGreaterThanOrEqual(0)
    const table = lock.slice(start, lock.indexOf("\n  },", start))
    const entries = [...table.matchAll(/^ {4}"([^"]+)": "([^"]+)",$/gm)]
    expect(Object.fromEntries(entries.map(([, dependency, patch]) => [dependency, patch]))).toEqual(declared)
  })

  it("would come from the workspace definition the root install declares, not a hand-kept list", async () => {
    const declaration = await read("PACKAGE.ts")
    const install = declaration.slice(declaration.indexOf("const nodeModules = Smithers.Install({"))
    const body = install.slice(0, install.indexOf("\n})\n"))
    expect(declaration).toContain(`const workspace = Smithers.pnpmWorkspace("//pnpm-workspace.yaml")`)
    expect(body).toMatch(/\n {2}workspaceManifest: workspace,\n/)
    expect(body).not.toMatch(/\bpatches:/)
  })
})
