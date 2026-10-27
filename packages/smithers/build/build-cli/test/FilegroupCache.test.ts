import { Smithers as S } from "@smthrs/targets"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { openCache } from "../src/Cache.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

it("stores Filegroup successes, reads them on reuse, and misses when member bytes change", async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-filegroup-cache-"))
  try {
    for (
      const [file, value] of Object.entries({
        "package.json": "{}",
        "yarn.lock": "",
        "PACKAGE.ts": "",
        "input.txt": "first"
      })
    ) {
      await writeFile(join(root, file), value)
    }
    const packageJson = S.file("//package.json")
    const index = PackageIndex.make({
      root,
      factory: undefined,
      workspace: S.Workspace("filegroup-cache", {
        repository: "git+https://example.invalid/fixture.git",
        cache: S.Cache({ directory: ".flows" }),
        runtime: S.Runtime.Node({ version: "26" }),
        packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
        nodeModules: S.Npm.NodeModules({ packageJson })
      }),
      packages: [{
        file: "PACKAGE.ts",
        packagePath: "",
        value: S.Package({
          targets: {
            sources: S.Filegroup({ srcs: [S.file("input.txt")] })
          }
        })
      }]
    })
    const options = { index, cacheDirectory: ".flows", verb: "auto" as const, patterns: ["//:sources"] }
    const plan = await PackageExec.plan(options)
    expect(plan.nodes.get("//:sources")!.cacheable).toBe(true)
    expect((await PackageExec.execute(plan, options)).results).toMatchObject([{ label: "//:sources", status: "ran" }])
    const cache = await openCache({ workspaceRoot: root, cacheDirectory: ".flows" })
    expect(await cache.get(plan.nodes.get("//:sources")!.keyPreview)).toMatchObject({
      label: "//:sources",
      exitOk: true
    })
    expect((await PackageExec.run(options)).results).toMatchObject([{ label: "//:sources", status: "hit" }])
    await writeFile(join(root, "input.txt"), "second")
    const changed = await PackageExec.plan(options)
    expect(changed.nodes.get("//:sources")!.keyPreview).not.toBe(plan.nodes.get("//:sources")!.keyPreview)
    expect((await PackageExec.execute(changed, options)).results).toMatchObject([{ status: "ran" }])
    expect((await PackageExec.run(options)).results).toMatchObject([{ status: "hit" }])
    expect((await PackageExec.run({ ...options, readCache: false })).results).toMatchObject([{ status: "ran" }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
