/** A package `smthrs generate package` writes is a package the workspace lists. */
import { scaffold } from "@smthrs/targets/NewPackage"
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const workspace = async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-new-package-targets-")))
  roots.push(root)
  await write(root, "package.json", "{\"name\":\"new-package\",\"private\":true,\"packageManager\":\"pnpm@11.25.0\"}\n")
  await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  await write(
    root,
    "PACKAGE.ts",
    "import { Smithers as S } from \"@smthrs/targets\"\nexport const Package = S.Package({ targets: {} })\n"
  )
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("new-package", {
  repository: "git+https://example.invalid/new-package.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  host: S.Host({ bins: ["node"] }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})
`
  )
  return root
}

const indexOf = async (root: string) =>
  PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))

describe("a generated package", () => {
  it("lists a test target that runs vitest in the package directory", async () => {
    const root = await workspace()
    await Effect.runPromise(scaffold({ workspaceRoot: root, packageName: "@acme/widget" }, {
      directory: "packages",
      version: "0.1.0",
      license: "MIT",
      fields: {}
    }))

    const index = await indexOf(root)
    expect(index.targets().map((row) => row.label)).toEqual(["//packages/widget:test"])
    const planned = await PackageExec.plan({
      index,
      patterns: ["//packages/widget:test"],
      cacheDirectory: ".flows",
      verb: "test"
    })
    const test = planned.workList.find((node) => node.label === "//packages/widget:test")
    expect(test?.rule).toBe("Vitest")
    const inputs = test?.keyMaterial.inputs as {
      readonly declared: ReadonlyArray<{ readonly files: ReadonlyArray<{ readonly path: string }> }>
    }
    const declared = inputs.declared
    expect(declared.flatMap((input) => input.files.map((file) => file.path)).sort()).toEqual([
      "packages/widget/src/index.ts",
      "packages/widget/test/index.test.ts"
    ])
  })
})
