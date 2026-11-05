import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { runInstall } from "../src/engine.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { write } from "./helpers/WriteFile.ts"

const execFile = promisify(ChildProcess.execFile)
const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

// A real local package keeps the fresh-checkout regression independent of a registry.
// Its bin deliberately differs from its package name: resolution needs the installed manifest.
const fixture = async (source = "") => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "sm-b17-pnpm-")))
  roots.push(root)
  const version = (await execFile("pnpm", ["--version"])).stdout.trim()
  await write(root, "package.json", JSON.stringify({
    name: "fresh-pnpm-install", private: true, type: "module", packageManager: `pnpm@${version}`,
    dependencies: { "fixture-tool": "file:./fixture-tool-1.0.0.tgz" }
  }))
  await write(root, "tool/package.json", JSON.stringify({
    name: "fixture-tool", version: "1.0.0", bin: { "fixture-command": "bin.cjs" }
  }))
  await write(root, "tool/bin.cjs", `#!/usr/bin/env node
console.log("FRESH_PNPM_TOOL_EXECUTED")
`)
  await Fs.chmod(Path.join(root, "tool/bin.cjs"), 0o755)
  await write(root, "pnpm-workspace.yaml", `packages:
  - .
enableGlobalVirtualStore: false
verifyDepsBeforeRun: error
`)
  await execFile("pnpm", ["pack", "--pack-destination", root], { cwd: Path.join(root, "tool") })
  await execFile("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: root })
  await Fs.rm(Path.join(root, "node_modules"), { recursive: true, force: true })
  await write(root, "WORKSPACE.ts", `import { Smithers as S } from "@smthrs/targets"
const manifest = S.file("//package.json")
export const Workspace = S.Workspace("fresh-pnpm-install", {
  repository: "git+https://example.invalid/fresh-pnpm-install.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ${JSON.stringify(process.versions.node)} }),
  packageManager: S.PackageManager.Pnpm({ manifest, lockfile: S.file("//pnpm-lock.yaml"), workspaces: S.file("//pnpm-workspace.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})`)
  await write(root, "PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"
${source || 'export const Package = S.Package({ targets: { install: S.Install({ lockfilePath: "pnpm-lock.yaml" }) } })'}`)
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)
  const options = { index, cacheDirectory: ".flows", verb: "auto" as const, patterns: ["//:install"], jobs: 1 }
  const install = () => runInstall(root, { toolchain: {
    manager: "pnpm", managerVersion: version, runtime: "node", runtimeVersion: process.versions.node,
    runtimeExecutable: process.execPath
  } })
  return { root, options, install }
}

describe("fresh pnpm installations", () => {
  it("preserves an unchanged installed tree across fetch and link", async () => {
    const { root, install } = await fixture()
    await install()
    const bin = Path.join(root, "node_modules/.bin/fixture-command")
    const before = await Fs.stat(bin, { bigint: true })
    await install()
    const after = await Fs.stat(bin, { bigint: true })
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeNs).toBe(before.mtimeNs)
    expect((await execFile(bin)).stdout).toContain("FRESH_PNPM_TOOL_EXECUTED")
  })
})
