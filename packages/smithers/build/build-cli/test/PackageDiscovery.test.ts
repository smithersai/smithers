import * as SafeFs from "@smthrs/targets/SafeFs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const temporaryWorkspace = async (): Promise<string> => {
  const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-discovery-"))
  temporaryDirectories.push(directory)
  await write(directory, "WORKSPACE.ts", "export const Workspace = 1\n")
  await write(directory, "PACKAGE.ts", "export const Package = 1\n")
  return directory
}

const workspaceModule = (options: string): string =>
  `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("discovery", {
  repository: "git+https://example.invalid/discovery.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: S.file("//package.json"), lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  ${options}
})
`

describe("PackageDiscovery.discover boundaries", () => {
  it("never enters a cache tagged with CACHEDIR.TAG", async () => {
    const root = await temporaryWorkspace()
    await write(root, "target/CACHEDIR.TAG", "Signature: 8a477f597d28d172789f06886806bc55\n")
    await write(root, "target/debug/build/PACKAGE.ts", "export const Package = 1\n")
    const discovery = await PackageDiscovery.discover(root)
    expect(discovery.packageFiles).toEqual(["PACKAGE.ts"])
    expect(discovery.pruned).toEqual(["target"])
  })

  it("never enters a nested checkout: a clone, a linked worktree, or a jj workspace", async () => {
    const root = await temporaryWorkspace()
    await write(root, "vendor/clone/.git/HEAD", "ref: refs/heads/main\n")
    await write(root, "vendor/clone/WORKSPACE.ts", "export const Workspace = 1\n")
    await write(root, "scratch/worktree/.git", "gitdir: /elsewhere/.git/worktrees/worktree\n")
    await write(root, "scratch/worktree/BUILD.ts", "export const stale = 1\n")
    await write(root, "lanes/jj/.jj/repo", "/elsewhere\n")
    await write(root, "lanes/jj/pkg/PACKAGE.ts", "export const Package = 1\n")
    const discovery = await PackageDiscovery.discover(root)
    expect(discovery.packageFiles).toEqual(["PACKAGE.ts"])
    expect(discovery.pruned).toEqual(["lanes/jj", "scratch/worktree", "vendor/clone"])
  })

  it("never enters a declared discovery.prune path and reports it", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(`discovery: { prune: ["./scratch", "deep/store/"] },`))
    await write(root, "scratch/PACKAGE.ts", "export const Package = 1\n")
    await write(root, "deep/store/pkg/PACKAGE.ts", "export const Package = 1\n")
    await write(root, "deep/kept/PACKAGE.ts", "export const Package = 1\n")
    const declaration = await PackageLoader.loadWorkspaceDeclaration(root, "WORKSPACE.ts")
    expect(declaration.discovery?.prune).toEqual(["scratch", "deep/store"])
    const discovery = await PackageDiscovery.discover(root, { prune: declaration.discovery?.prune })
    expect(discovery.packageFiles).toEqual(["PACKAGE.ts", "deep/kept/PACKAGE.ts"])
    expect(discovery.pruned).toEqual(["deep/store", "scratch"])
  })

  it.each(["../outside", "/absolute", ""])("refuses the discovery.prune path %j", async (path) => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(`discovery: { prune: [${JSON.stringify(path)}] },`))
    await expect(PackageLoader.loadWorkspaceDeclaration(root, "WORKSPACE.ts"))
      .rejects.toThrow(/discovery prune path must (be relative|remain inside the workspace)/)
  })

  it.each([
    ["nested/WORKSPACE.ts", "nested/WORKSPACE.ts"],
    ["nested/.smithers/WORKSPACE.ts", "nested/.smithers/WORKSPACE.ts"]
  ])("still refuses an undeclared nested workspace marked by %s", async (file, marker) => {
    const root = await temporaryWorkspace()
    await write(root, file, "export const Workspace = 1\n")
    await write(root, "nested/BUILD.ts", "export const stale = 1\n")
    await expect(PackageDiscovery.discover(root)).rejects.toMatchObject({
      code: "nested_workspace_undeclared",
      path: marker
    })
  })

  /**
   * The falsifiable statement of the walk's cost: one confined resolve and
   * one confined listing per directory (lstat + realpath, then lstat +
   * readdir + lstat), and no per-child probes. The walk used to spend ten
   * calls per directory, which on a checkout with 17,599 directories was
   * 177,000 calls and 88 to 127 seconds of `smthrs targets`.
   */
  it("spends at most five filesystem calls per directory", async () => {
    const root = await temporaryWorkspace()
    const width = 12
    for (let outer = 0; outer < width; outer += 1) {
      for (let inner = 0; inner < width; inner += 1) {
        await write(root, `tree/d${outer}/d${inner}/file.txt`, "x\n")
      }
    }
    let calls = 0
    const counted = <A extends Array<unknown>, R>(call: (...args: A) => Promise<R>) => (...args: A): Promise<R> => {
      calls += 1
      return call(...args)
    }
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      lstat: counted(SafeFs.defaultIo.lstat),
      realpath: counted(SafeFs.defaultIo.realpath),
      readdir: counted(SafeFs.defaultIo.readdir)
    }
    const discovery = await PackageDiscovery.discover(root, { io })
    // root, tree, 12 outer, 144 inner.
    expect(discovery.directories).toBe(1 + 1 + width + width * width)
    // The lower bound proves the seam saw the walk; the upper bound is the budget.
    expect(calls).toBeGreaterThanOrEqual(3 * discovery.directories)
    expect(calls).toBeLessThanOrEqual(5 * discovery.directories)
  })
})
