import NodeFs from "node:fs"
import fsPromises, * as Fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

const roots: Array<string> = []

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const workspace = async (targets: number): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-plan-host-lookups-")))
  roots.push(root)
  const files: Record<string, string> = {
    "package.json": "{\"name\":\"plan-host-lookups\",\"private\":true,\"type\":\"module\"}\n",
    "WORKSPACE.ts": `import { Smithers as S } from "@smthrs/targets"
const runtime = S.Runtime.Node({ version: ">=26.4.0" })
export const Workspace = S.Workspace("plan-host-lookups", {
  repository: "git+https://example.invalid/plan-host-lookups.git",
  cache: S.Cache({ directory: ".flows" }), runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.25.0", runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})\n`,
    "PACKAGE.ts": `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
${
      Array.from({ length: targets }, (_, i) =>
        `  t${i}: S.Shell.Test({ summary: "Runs node.", shell: "node -e ${i}", sandbox: "none" })`).join(",\n")
    }
} })\n`
  }
  for (const [relative, contents] of Object.entries(files)) {
    const path = Path.join(root, relative)
    await Fs.mkdir(Path.dirname(path), { recursive: true })
    await Fs.writeFile(path, contents)
  }
  return root
}

/** Plans every target and counts opens of the node binary and executable probes of PATH entries named node. */
const lookups = async (targets: number) => {
  const root = await workspace(targets)
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
  const node = await Fs.realpath(process.execPath)
  let opens = 0
  let probes = 0
  const open = fsPromises.open
  vi.spyOn(fsPromises, "open").mockImplementation((path, ...rest) => {
    if (String(path) === node) opens += 1
    return open(path, ...rest)
  })
  const access = NodeFs.accessSync
  vi.spyOn(NodeFs, "accessSync").mockImplementation((path, mode) => {
    if (Path.basename(String(path)) === "node") probes += 1
    return access(path, mode)
  })
  syncBuiltinESMExports()
  try {
    const plan = await PackageExec.plan({ index, patterns: ["//..."], cacheDirectory: ".flows", verb: "test" })
    expect(plan.roots).toHaveLength(targets)
    expect(new Set(plan.roots.map((label) => plan.nodes.get(label)!.keyPreview)).size).toBe(targets)
    return { opens, probes }
  } finally {
    vi.restoreAllMocks()
    syncBuiltinESMExports()
  }
}

describe("one plan asks the host about an executable once", () => {
  it.skipIf(process.platform === "win32")(
    "searches PATH for node and opens its binary as often for five targets as for one",
    async () => {
      const one = await lookups(1)
      const five = await lookups(5)
      expect(one.opens).toBeGreaterThan(0)
      expect(five).toEqual(one)
    }
  )
})
