import { Smithers as S } from "@smthrs/targets"
import * as Target from "@smthrs/targets/Target"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import { inputPackage } from "../src/internal/InputPackage.ts"
import { plan } from "../src/internal/PackagePlanner.vibe"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as TargetIndex from "../src/TargetIndex.ts"

it("keeps the existing default and explicit root cwd while refusing workspace escapes", () => {
  const anchor = (cwd: string) => inputPackage(Target.metadata(S.Filegroup({ cwd, srcs: [] })), "flows")
  expect(anchor(".")).toBe("flows")
  expect(anchor("//")).toBe("")
  expect(anchor("lib/./src/..")).toBe("lib")
  for (const cwd of ["../outside", "/outside", "lib\\outside"]) expect(() => anchor(cwd)).toThrow()
})

it("plans an explicit Filegroup cwd without crossing nested packages or changing its label", async () => {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-filegroup-cwd-"))
  const write = async (name: string, contents: string) => {
    await Fs.mkdir(Path.dirname(Path.join(root, name)), { recursive: true })
    await Fs.writeFile(Path.join(root, name), contents)
  }
  try {
    for (
      const [name, contents] of Object.entries({
        "package.json": "{}",
        "yarn.lock": "",
        "flows/PACKAGE.ts": "",
        "lib/PACKAGE.ts": "",
        "lib/src/value.ts": "export const value = 1",
        "lib/src/generated.ts": "excluded",
        "lib/.gitignore": "ignored.ts\n",
        "lib/src/ignored.ts": "ignored",
        "lib/src/nested/PACKAGE.ts": "",
        "lib/src/nested/child.ts": "nested package",
        "other/PACKAGE.ts": "",
        "other/src/value.ts": "export const other = 2",
        "flows/local.txt": "default cwd"
      })
    ) await write(name, contents)
    await Fs.symlink(Path.join(root, "other/src"), Path.join(root, "lib/src/link"))
    const external = S.Filegroup({ cwd: "lib", srcs: [S.glob("src/**/*.ts", { exclude: ["**/generated.ts"] })] })
    const other = S.Filegroup({ cwd: "other", srcs: [S.glob("src/**/*.ts")] })
    const consumer = S.Filegroup({ srcs: [external, other, S.file("local.txt")] })
    const packageJson = S.file("//package.json")
    const workspace = S.Workspace("fixture", {
      repository: "git+https://example.invalid/fixture.git",
      cache: S.Cache({ directory: ".flows" }),
      runtime: S.Runtime.Node({ version: ">=26.4.0" }),
      packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
      nodeModules: S.Npm.NodeModules({ packageJson })
    })
    const index = PackageIndex.make({
      root,
      workspace,
      factory: undefined,
      packages: [
        { file: "flows/PACKAGE.ts", packagePath: "flows", value: S.Package({ targets: { consumer, external } }) },
        {
          file: "lib/PACKAGE.ts",
          packagePath: "lib",
          value: S.Package({ targets: { owned: S.Filegroup({ srcs: [] }) } })
        }
      ]
    })
    const inspect = () => plan({ index, cacheDirectory: ".flows", verb: "auto", patterns: ["//flows:consumer"] })
    const first = await inspect()
    const group = first.nodes.get("//flows:external")!
    expect(group.declaredInputs.flatMap((input) => input.files.map((file) => file.path))).toEqual(["lib/src/value.ts"])
    expect(first.nodes.get("//flows:consumer")!.declaredInputs[0]!.files[0]!.path).toBe("flows/local.txt")
    expect(
      first.workList.find((node) => (node.attrs as { cwd?: string }).cwd === "other")!
        .declaredInputs[0]!.files[0]!.path
    ).toBe("other/src/value.ts")
    expect((await TargetIndex.build(index, "//flows:external", process.env)).targets[0]!.inputs).toEqual([
      { kind: "glob", pattern: "lib/src/**/*.ts", exclude: ["lib/**/generated.ts"] }
    ])
    expect(Affected.select(index, ["//flows:consumer"], ["lib/src/value.ts"])).toMatchObject({
      conservative: false,
      targets: [{ label: "//flows:consumer", reasons: ["lib/src/value.ts"] }]
    })
    await write("lib/src/value.ts", "export const value = 3")
    const changed = await inspect()
    expect(changed.nodes.get("//flows:consumer")!.keyPreview).not.toBe(first.nodes.get("//flows:consumer")!.keyPreview)
    await write("lib/src/nested/child.ts", "still belongs to the nested package")
    const nested = await inspect()
    expect(nested.nodes.get("//flows:consumer")!.keyPreview).toBe(changed.nodes.get("//flows:consumer")!.keyPreview)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
}, 180_000)

it("keys backend access and proof inputs through their owning cwd", async () => {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-cross-package-inputs-"))
  const files = [
    "packages/backend/internal/compose/access_test.go",
    "packages/backend/internal/services/access_test.go",
    "packages/backend/internal/identity/access_test.go",
    "packages/backend/internal/middleware/access_test.go",
    ".specs/product/mvp.md",
    ".specs/design/mock/src/index.ts"
  ]
  try {
    for (const name of ["package.json", "yarn.lock", "packages/backend/PACKAGE.ts", "apps/app/PACKAGE.ts", ...files]) {
      await Fs.mkdir(Path.dirname(Path.join(root, name)), { recursive: true })
      await Fs.writeFile(Path.join(root, name), name === "package.json" ? "{}" : "before")
    }
    const backend = [
      S.Filegroup({
        cwd: "packages/backend",
        srcs: ["compose", "services", "identity", "middleware"].map((directory) =>
          S.glob(`internal/${directory}/*_test.go`)
        )
      })
    ]
    const product = S.Filegroup({ cwd: ".specs/product", srcs: [S.glob("**/*")] })
    const mock = S.Filegroup({ cwd: ".specs/design/mock", srcs: [S.glob("src/**/*")] })
    const packageJson = S.file("//package.json")
    const workspace = S.Workspace("fixture", {
      repository: "git+https://example.invalid/fixture.git",
      cache: S.Cache({ directory: ".flows" }),
      runtime: S.Runtime.Node({ version: ">=26.4.0" }),
      packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
      nodeModules: S.Npm.NodeModules({ packageJson })
    })
    const index = PackageIndex.make({
      root,
      workspace,
      factory: undefined,
      packages: [
        {
          file: "PACKAGE.ts",
          packagePath: "",
          value: S.Package({
            targets: {
              backendAccessTests: S.Shell.Diff({ shell: "true", data: backend, changes: [] }),
              backendGoAccess: S.Shell.Test({ shell: "true", data: backend })
            }
          })
        },
        {
          file: "apps/app/PACKAGE.ts",
          packagePath: "apps/app",
          value: S.Package({
            targets: {
              proofRecord: S.Shell.Build({ shell: "true", data: [product], outDirs: ["record"] }),
              proofPage: S.Shell.Build({ shell: "true", data: [product, mock], outDirs: ["page"] })
            }
          })
        },
        { file: "packages/backend/PACKAGE.ts", packagePath: "packages/backend", value: S.Package({ targets: {} }) }
      ]
    })
    const inspect = () =>
      plan({
        index,
        cacheDirectory: ".flows",
        verb: "auto",
        patterns: ["//:backendAccessTests", "//:backendGoAccess", "//apps/app:proofRecord", "//apps/app:proofPage"]
      })
    const before = await inspect()
    for (const file of files) {
      await Fs.writeFile(Path.join(root, file), "after")
      const after = await inspect()
      const affected = file.startsWith("packages/backend") ?
        ["//:backendAccessTests", "//:backendGoAccess"]
        : file.startsWith(".specs/product")
        ? ["//apps/app:proofRecord", "//apps/app:proofPage"]
        : ["//apps/app:proofPage"]
      for (const label of affected) {
        expect(after.nodes.get(label)!.keyPreview, `${label}: ${file}`).not.toBe(before.nodes.get(label)!.keyPreview)
      }
      await Fs.writeFile(Path.join(root, file), "before")
    }
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
}, 180_000)
