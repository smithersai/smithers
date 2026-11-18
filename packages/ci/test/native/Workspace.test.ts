import { describe, expect, it } from "vitest"
import { applyRefuses } from "../../src/contract/Command.ts"
import { type Inventory, ownWorkspace, smithersBuild } from "../../src/contract/Inventory.ts"
import { found, generatedMark, isBuildFile, isGenerated, overwriteRefusal, refusal } from "../../src/native/index.ts"

const inventory = (unsupported?: Inventory["unsupported"]): Inventory => ({
  version: 1,
  repository: "test/native",
  commit: "0000000",
  toolchains: [],
  jobs: [],
  ...(unsupported === undefined ? {} : { unsupported })
})

describe("a repository that already builds with Smithers build", () => {
  it("is named in the inventory by its workspace file", () => {
    expect(found("WORKSPACE.ts")).toEqual({ feature: "smithers-build", detail: "WORKSPACE.ts" })
    expect(ownWorkspace(inventory([{ feature: "unreadable-file", detail: "x" }, found(".smithers/WORKSPACE.ts")])))
      .toBe(".smithers/WORKSPACE.ts")
    expect(ownWorkspace(inventory([{ feature: "unreadable-file", detail: "x" }]))).toBeUndefined()
    expect(ownWorkspace(inventory())).toBeUndefined()
    expect(found("WORKSPACE.ts").feature).toBe(smithersBuild)
  })

  it("is refused in one line that names the file", () => {
    expect(refusal(inventory([found("WORKSPACE.ts")]))).toBe(
      "the repository already builds with Smithers build (WORKSPACE.ts); there is nothing to convert"
    )
    expect(refusal(inventory())).toBeUndefined()
  })

  it("is found where the contract says apply refuses", () => {
    expect(applyRefuses.map((file) => ownWorkspace(inventory([found(file)])))).toEqual([...applyRefuses])
  })

  it("tells a file smithers-ci generated from one an owner wrote", () => {
    expect(isGenerated(`${generatedMark} Do not edit.\nimport x from "y"\n`)).toBe(true)
    expect(isGenerated(`import x from "y"\n${generatedMark}\n`)).toBe(false)
    expect(isGenerated("")).toBe(false)
  })

  it("counts a workspace or a package file in any directory as a build file", () => {
    const paths = [
      "PACKAGE.ts",
      "WORKSPACE.ts",
      ".smithers/WORKSPACE.ts",
      "packages/a/PACKAGE.vibe",
      "packages/a/PACKAGE.ts.md",
      "MYPACKAGE.ts",
      ".github/workflows/smithers-ci.yml"
    ]
    expect(paths.filter((path) => isBuildFile({ path, content: "" }))).toEqual(paths.slice(0, 4))
  })

  it("names every file that would be replaced", () => {
    expect(overwriteRefusal(["PACKAGE.ts"])).toBe("PACKAGE.ts was not written by smithers-ci and would be replaced")
    expect(overwriteRefusal(["PACKAGE.ts", "a/PACKAGE.ts"])).toBe(
      "PACKAGE.ts, a/PACKAGE.ts were not written by smithers-ci and would be replaced"
    )
  })
})
