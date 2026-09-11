import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

/** Temp directories this file created; removed after the suite so a run leaves nothing in the OS temp dir. */
const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const workspaceModule = (cacheDirectory: string): string =>
  `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ${JSON.stringify(cacheDirectory)} }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`

const packageModule = `import { Smithers as S } from "@smthrs/targets"
const runtime = S.Runtime.Node({ version: ">=22.19.0" })
const packageManager = S.PackageManager.Pnpm({ version: "11.21.0", runtime })
const install = S.Install({ packageManager })
export const Package = S.Package({ targets: { run: S.Shell.Run({ shell: "echo hi" }), install } })
`

const temporaryWorkspace = async (): Promise<string> =>
  tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-package-cli-"))))

describe("PACKAGE.ts CLI", () => {
  // The vitest process cwd is the build-cli package, which is outside every
  // temporary workspace, so each query here also proves the outside-cwd
  // path: absolute patterns never need a current package.
  it("answers query '//...' from a cwd outside the workspace", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(".flows"))
    await write(root, "PACKAGE.ts", packageModule)
    const { exitCode, output } = await serve(root, ["query", "//..."])
    expect(exitCode).toBe(0)
    expect(output).toContain("//:run")
  })

  it("runs the root Install target", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(".flows"))
    await write(root, "PACKAGE.ts", packageModule)
    await write(
      root,
      "package.json",
      `${
        JSON.stringify(
          {
            name: "fixture",
            private: true,
            packageManager: "pnpm@11.21.0",
            dependencies: { "fixture-dep": "link:dep" }
          },
          undefined,
          2
        )
      }\n`
    )
    await write(
      root,
      "dep/package.json",
      `${JSON.stringify({ name: "fixture-dep", version: "1.0.0" }, undefined, 2)}\n`
    )
    await write(
      root,
      "pnpm-lock.yaml",
      "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    dependencies:\n      fixture-dep:\n        specifier: link:dep\n        version: link:dep\n"
    )
    const { exitCode, output } = await serve(root, ["install"])
    expect(exitCode).toBe(0)
    expect(output).toContain("ok: true")
  })

  it("prunes the WORKSPACE-declared cache directory from discovery", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(".mycache"))
    await write(root, "PACKAGE.ts", packageModule)
    await write(
      root,
      ".mycache/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { ghost: S.Shell.Run({ shell: "echo ghost" }) } })
`
    )
    const { exitCode, output } = await serve(root, ["query", "//..."])
    expect(exitCode).toBe(0)
    expect(output).toContain("//:run")
    expect(output).not.toContain(".mycache")
    expect(output).not.toContain("ghost")
  })

  it("keeps the --cache-dir flag override ahead of the declaration", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(".mycache"))
    await write(root, "PACKAGE.ts", packageModule)
    await write(
      root,
      ".flagcache/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { ghost: S.Shell.Run({ shell: "echo ghost" }) } })
`
    )
    const { exitCode, output } = await serve(root, ["query", "//...", "--cache-dir", ".flagcache"])
    expect(exitCode).toBe(0)
    expect(output).toContain("//:run")
    expect(output).not.toContain("ghost")
  })
})
