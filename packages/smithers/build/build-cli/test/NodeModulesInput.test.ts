/**
 * `S.nodeModules`: a declared install, end to end, on the host's own
 * confinement.
 *
 * A tool that resolves modules from a directory that is not above its own
 * reads an install the sandbox does not admit by default. These cases spawn
 * real tools under the real mechanism (bubblewrap on Linux, seatbelt on
 * macOS) and assert the kernel's answer and the planner's key: the declared
 * tree is readable and nothing beside it is, the manifest and lockfile are the
 * key and the installed files are not, and an install with no identity is
 * refused.
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { openPackageIndex } from "../src/Cli.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const workspaceModule = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

const commitAll = (root: string): void => {
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
}

/** A workspace whose `deps/` holds an install the root targets are not below. */
const installWorkspace = async (packageModule: string): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-node-modules-")))
  temporaryDirectories.push(root)
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write(root, "yarn.lock", "")
  await write(root, ".gitignore", "node_modules/\n.flows/\n")
  await write(root, "WORKSPACE.ts", workspaceModule)
  await write(root, "deps/package.json", `${JSON.stringify({ name: "deps", private: true })}\n`)
  await write(root, "deps/bun.lock", "lock-1\n")
  await write(root, "deps/notes.txt", "beside the install\n")
  await write(root, "deps/node_modules/dep/index.js", "module.exports = 'dep-1'\n")
  await write(root, "PACKAGE.ts", packageModule)
  commitAll(root)
  return root
}

const reads = "cat deps/node_modules/dep/index.js"

const run = async (root: string, label: string, readCache = true) => {
  const index = await openPackageIndex({ workspace: root })
  const options = { index, cacheDirectory: ".flows", verb: "auto" as const, patterns: [label], readCache }
  const planned = await PackageExec.plan(options)
  const summary = await PackageExec.execute(planned, options)
  return { node: planned.nodes.get(label)!, row: summary.results.find((entry) => entry.label === label)! }
}

const native = process.platform === "darwin" || process.platform === "linux"

describe.runIf(native)("S.nodeModules under confinement", () => {
  it("opens the declared install and nothing beside it", async () => {
    const root = await installWorkspace(`import { Smithers as S } from "@smthrs/targets"
const undeclared = S.Shell.Run({ shell: ${JSON.stringify(reads)} })
const declared = S.Shell.Run({ shell: ${JSON.stringify(reads)}, data: [S.nodeModules("//deps")] })
const beside = S.Shell.Run({ shell: "cat deps/notes.txt", data: [S.nodeModules("//deps")] })
export const Package = S.Package({ targets: { undeclared, declared, beside } })
`)
    const refused = await run(root, "//:undeclared", false)
    expect(refused.row.status).toBe("failed")
    const admitted = await run(root, "//:declared", false)
    expect(admitted.row.error).toBeUndefined()
    expect(admitted.row.status).toBe("ran")
    expect(admitted.node.readSet).toContain("deps/node_modules")
    const closed = await run(root, "//:beside", false)
    expect(closed.row.status).toBe("failed")
  })

  it("admits a tree linked to a shared install, and refuses a link to any other directory", async () => {
    const root = await installWorkspace(`import { Smithers as S } from "@smthrs/targets"
const declared = S.Shell.Run({ shell: ${JSON.stringify(reads)}, data: [S.nodeModules("//deps")] })
export const Package = S.Package({ targets: { declared } })
`)
    const shared = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-shared-install-")))
    temporaryDirectories.push(shared)
    await write(shared, "node_modules/dep/index.js", "module.exports = 'shared'\n")
    await write(shared, "elsewhere/dep/index.js", "module.exports = 'not an install'\n")
    await Fs.rm(NodePath.join(root, "deps/node_modules"), { recursive: true })
    await Fs.symlink(NodePath.join(shared, "node_modules"), NodePath.join(root, "deps/node_modules"), "dir")
    const linked = await run(root, "//:declared", false)
    expect(linked.row.error).toBeUndefined()
    expect(linked.row.status).toBe("ran")
    expect(linked.node.externalReads).toContain(NodePath.join(shared, "node_modules"))

    await Fs.rm(NodePath.join(root, "deps/node_modules"))
    await Fs.symlink(NodePath.join(shared, "elsewhere"), NodePath.join(root, "deps/node_modules"), "dir")
    const stray = await run(root, "//:declared", false)
    expect(stray.row.status).toBe("failed")
    expect(stray.row.error).toContain("resolves outside")
    expect(stray.node.externalReads).not.toContain(NodePath.join(shared, "elsewhere"))
  })
})

describe("S.nodeModules key", () => {
  const packageModule = `import { Smithers as S } from "@smthrs/targets"
const declared = S.Shell.Run({ shell: "true", sandbox: "none", data: [S.nodeModules("//deps")] })
export const Package = S.Package({ targets: { declared } })
`

  const keyOf = async (root: string): Promise<string> => {
    const index = await openPackageIndex({ workspace: root })
    const planned = await PackageExec.plan({
      index,
      cacheDirectory: ".flows",
      verb: "auto" as const,
      patterns: ["//:declared"]
    })
    return planned.nodes.get("//:declared")!.keyPreview
  }

  it("keys the manifest and every lockfile, and never the installed files", async () => {
    const root = await installWorkspace(packageModule)
    const first = await keyOf(root)
    await write(root, "deps/node_modules/dep/index.js", "module.exports = 'dep-2'\n")
    await write(root, "deps/node_modules/added/index.js", "module.exports = 'added'\n")
    expect(await keyOf(root)).toBe(first)
    await write(root, "deps/bun.lock", "lock-2\n")
    const relocked = await keyOf(root)
    expect(relocked).not.toBe(first)
    await write(root, "deps/package.json", `${JSON.stringify({ name: "deps", private: true, version: "2.0.0" })}\n`)
    const remanifested = await keyOf(root)
    expect(remanifested).not.toBe(relocked)
    await write(root, "deps/package-lock.json", "{}\n")
    expect(await keyOf(root)).not.toBe(remanifested)
  })

  it("refuses an install with no manifest", async () => {
    const root = await installWorkspace(packageModule)
    await Fs.rm(NodePath.join(root, "deps/package.json"))
    await expect(keyOf(root)).rejects.toMatchObject({
      _tag: "smithers-build/PackageError",
      code: "install_identity_missing",
      path: "deps/package.json",
      message: expect.stringContaining("S.nodeModules(\"//deps\"): deps has no package.json")
    })
  })

  it("refuses an install with no lockfile, naming the lockfiles it looked for", async () => {
    const root = await installWorkspace(packageModule)
    await Fs.rm(NodePath.join(root, "deps/bun.lock"))
    await expect(keyOf(root)).rejects.toMatchObject({
      _tag: "smithers-build/PackageError",
      code: "install_identity_missing",
      path: "deps",
      message: expect.stringMatching(/deps has no lockfile \(bun\.lock, bun\.lockb, .*yarn\.lock\)/)
    })
  })
})
