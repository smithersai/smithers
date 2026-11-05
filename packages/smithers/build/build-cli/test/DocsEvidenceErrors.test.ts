import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import * as DocsCheckRule from "../src/internal/rules/DocsCheckRule.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

it("reports missing and unplanned documentation evidence as typed failures", async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "docs-evidence-errors-")))
  try {
    await Fs.writeFile(Path.join(root, "package.json"), "{\"name\":\"docs-evidence-errors\",\"private\":true}\n")
    await Fs.writeFile(Path.join(root, "yarn.lock"), "")
    await Fs.writeFile(
      Path.join(root, "WORKSPACE.ts"),
      `import { Smithers as S } from "@smthrs/targets"
const manifest = S.file("//package.json")
export const Workspace = S.Workspace("evidence-errors", {
 repository: "git+https://example.invalid/evidence-errors.git", cache: S.Cache({ directory: ".flows" }),
 runtime: S.Runtime.Node({ version: "26" }),
 packageManager: S.PackageManager.Yarn({ manifest, lockfile: S.file("//yarn.lock") }),
 nodeModules: S.Npm.NodeModules({ packageJson: manifest })
})`
    )
    await Fs.writeFile(
      Path.join(root, "PACKAGE.ts"),
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { fresh: S.Docs.Check({
  stamp: S.file("stamp.json"), output: S.file("guide.md"), inputs: [], producer: "reviewer",
  evidence: [{ file: S.file("evidence.json"), dependency: "service", ttlMs: 60000 }]
}) } })`
    )
    await Fs.writeFile(Path.join(root, "guide.md"), "A reviewed guide.\n")
    const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)
    const plan = await PackageExec.plan({ index, cacheDirectory: ".flows", verb: "docs", patterns: ["//:fresh"] })
    const node = plan.nodes.get("//:fresh")!
    if (!DocsCheckRule.accepts(node)) throw new Error("expected a documentation check")

    await expect(DocsCheckRule.contract.execute(node, { root, signal: undefined })).rejects.toMatchObject({
      _tag: "smithers-build/DocsEvidenceError",
      code: "unavailable",
      path: "evidence.json",
      message:
        "unknown: guide.md needs current evidence at evidence.json; collect the dependency observation before re-verifying"
    })

    await Fs.writeFile(
      Path.join(root, "evidence.json"),
      JSON.stringify({
        format: 1,
        dependency: "service",
        digest: "current",
        observedAt: Date.now()
      })
    )
    await expect(DocsCheckRule.contract.execute({ ...node, lane: { ...node.lane, files: [] } }, {
      root,
      signal: undefined
    })).rejects.toMatchObject({
      _tag: "smithers-build/DocsEvidenceError",
      code: "unplanned",
      path: "evidence.json",
      message: "unknown: evidence evidence.json was not included in the planned closure"
    })
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})
