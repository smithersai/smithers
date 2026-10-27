import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

it.each([
  { shell: "echo quietly-does-nothing", outDirs: ["out"], outFiles: [], missing: ["out"] },
  { shell: "mkdir -p out", outDirs: ["out"], outFiles: [], missing: ["out"] },
  { shell: "echo quietly-does-nothing", outDirs: [], outFiles: ["a.txt", "b.txt"], missing: ["a.txt", "b.txt"] },
  {
    shell: "echo quietly-does-nothing",
    outDirs: ["out", "other"],
    outFiles: ["missing.txt"],
    missing: ["out", "other", "missing.txt"]
  },
  { shell: "mkdir -p out; touch out/result missing.txt", outDirs: ["out"], outFiles: ["missing.txt"], missing: [] }
])("validates declared outputs: $shell $outDirs $outFiles", async ({ shell, outDirs, outFiles, missing }) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-prepared-output-")))
  try {
    await Fs.writeFile(Path.join(root, "package.json"), "{\"name\":\"prepared-output\",\"private\":true}\n")
    await Fs.writeFile(Path.join(root, "yarn.lock"), "# yarn lockfile v1\n")
    await Fs.writeFile(
      Path.join(root, "WORKSPACE.ts"),
      `import { Smithers as S } from "@smthrs/targets"
const manifest = S.file("//package.json")
export const Workspace = S.Workspace("prepared-output", {
  repository: "git+https://example.invalid/prepared-output.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson: manifest })
})`
    )
    await Fs.writeFile(
      Path.join(root, "PACKAGE.ts"),
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  noop: S.Shell.Build({ shell: ${JSON.stringify(shell)}, outDirs: ${JSON.stringify(outDirs)}, outFiles: ${
        JSON.stringify(outFiles)
      } })
} })`
    )
    await expect(Fs.stat(Path.join(root, "out"))).rejects.toMatchObject({ code: "ENOENT" })
    const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)
    const result = await PackageExec.run({ index, cacheDirectory: ".flows", verb: "auto", patterns: ["//:noop"] })
    expect(result.results).toMatchObject([{ status: missing.length > 0 ? "failed" : "ran" }])
    expect(result.ok).toBe(missing.length === 0)
    if (missing.length === 0) {
      const cached = await PackageExec.run({ index, cacheDirectory: ".flows", verb: "auto", patterns: ["//:noop"] })
      expect(cached.results).toMatchObject([{ status: "hit" }])
      expect(cached.ok).toBe(true)
      const cacheRoot = Path.join(root, ".flows/cache")
      let changed = 0
      for (const shard of await Fs.readdir(cacheRoot)) {
        const directory = Path.join(cacheRoot, shard)
        if (!(await Fs.stat(directory)).isDirectory()) continue
        for (const name of await Fs.readdir(directory)) {
          const path = Path.join(directory, name)
          const entry = JSON.parse(await Fs.readFile(path, "utf8")) as {
            output?: { kind?: string; manifests: Array<{ entries: Array<unknown> }> }
          }
          if (entry.output?.kind !== "build") continue
          for (const manifest of entry.output.manifests) manifest.entries = []
          await Fs.writeFile(path, JSON.stringify(entry))
          changed += 1
        }
      }
      expect(changed).toBe(1)
      await Fs.rm(Path.join(root, "out"), { recursive: true })
      const restored = await PackageExec.run({ index, cacheDirectory: ".flows", verb: "auto", patterns: ["//:noop"] })
      expect(restored.ok).toBe(true)
      expect(restored.results).toMatchObject([{ status: "ran" }])
      await expect(Fs.stat(Path.join(root, "out/result"))).resolves.toMatchObject({ size: 0 })
    }
    if (missing.length > 0) {
      expect(result.results[0]?.error).toContain("//:noop")
      for (const path of missing) expect(result.results[0]?.error).toContain(path)
    }
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})
