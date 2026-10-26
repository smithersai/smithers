/**
 * Temporary upstream fixes are declared in the workspace manifest. Install inputs
 * follow that declaration, so every patch changes the install key automatically.
 */
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"

const repositoryRoot = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "../../../../..")
const read = (path: string) => Fs.readFile(NodePath.join(repositoryRoot, path), "utf8")

describe("the repository's dependency patches", () => {
  it("declares the upstream fixes and includes every patch in install inputs", async () => {
    const manifest = await read("pnpm-workspace.yaml")
    const patches = [
      "patches/@vitest__coverage-v8@5.0.0.patch"
    ]
    const inputs = await Input.expandPnpmWorkspace(repositoryRoot, "", Input.pnpmWorkspace("//pnpm-workspace.yaml"))
    for (const patch of patches) {
      expect(manifest).toContain(patch)
      expect(await read(patch)).toContain("diff --git")
      expect(inputs).toContain(patch)
    }
    expect(JSON.parse(await read("package.json"))).not.toHaveProperty("patchedDependencies")
    expect(await read("pnpm-lock.yaml")).toMatch(/^patchedDependencies:/m)
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
