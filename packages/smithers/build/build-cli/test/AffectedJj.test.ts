import { Smithers as S } from "@smthrs/targets"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const hasJj = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasJj)("Affected.changedPaths in Jujutsu workspaces", () => {
  it("discovers changed files in a non-colocated jj repository", async () => {
    const root = await tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-affected-jj-"))))
    execFileSync("jj", ["git", "init", "--no-colocate", root], { stdio: "ignore" })
    await write(root, "src/a.zig", "pub const a = 1;\n")
    const oldName = process.platform === "win32" ? "src/old name" : " src/old\nname "
    const newName = process.platform === "win32" ? "dest/new name" : "dest/new\n\u001bname "
    await write(root, oldName, "rename me")
    execFileSync("jj", ["--no-pager", "commit", "-m", "initial"], { cwd: root, stdio: "ignore" })

    await write(root, "src/a.zig", "pub const a = 42;\n")
    await write(root, "src/c.zig", "pub const c = 3;\n")

    await Fs.mkdir(NodePath.join(root, "dest"))
    await Fs.rename(NodePath.join(root, oldName), NodePath.join(root, newName))
    const paths = await Affected.changedPaths(root, { base: "HEAD" })
    expect(paths).toEqual([oldName, newName, "src/a.zig", "src/c.zig"].sort())
  })

  it.skipIf(process.platform === "win32")(
    "selects for a changed file whose name holds a literal backslash",
    async () => {
      const root = await tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-affected-jj-"))))
      execFileSync("jj", ["git", "init", "--no-colocate", root], { stdio: "ignore" })
      await write(root, "\\notes", "one\n")
      await write(root, "src/a\\b.zig", "pub const a = 1;\n")
      execFileSync("jj", ["--no-pager", "commit", "-m", "initial"], { cwd: root, stdio: "ignore" })
      await write(root, "\\notes", "two\n")
      await write(root, "src/a\\b.zig", "pub const a = 2;\n")

      const paths = await Affected.changedPaths(root, { base: "HEAD" })
      expect(paths).toEqual(["\\notes", "src/a\\b.zig"])
      const index = PackageIndex.make({
        root,
        workspace: S.Workspace("backslash", {
          repository: "git+https://example.invalid/backslash.git",
          cache: S.Cache({ directory: ".flows" })
        }),
        factory: undefined,
        packages: [{
          file: "PACKAGE.ts",
          packagePath: "",
          value: S.Package({
            targets: { zig: S.Shell.Run({ shell: "true", sandbox: "none", data: [S.glob("src/**")] }) }
          })
        }]
      })
      // A backslash is a filename character here: `\notes` read as `/notes` was refused as absolute.
      const selection = Affected.select(index, ["//..."], paths, { toolSources: false })
      expect(selection.files).toEqual(["\\notes", "src/a\\b.zig"])
      // The root file is a global input, so it alone is the reason; the nested name matches its glob as written.
      expect(selection.targets).toEqual([{ label: "//:zig", reasons: ["\\notes"] }])
      expect(Affected.select(index, ["//..."], ["src/a\\b.zig"], { toolSources: false }).targets).toEqual([
        { label: "//:zig", reasons: ["src/a\\b.zig"] }
      ])
    }
  )
})
