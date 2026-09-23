import { NodePath } from "@effect/platform-node"
import * as Path from "@smthrs/kernel/Path"
import { Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import { describe, expect, it } from "vitest"
import * as Std from "../src/index.ts"
import * as Internal from "../src/internal/SearchContract.ts"
import * as SearchContract from "../src/SearchContract.ts"
import { fileInfo } from "./TestLayers.ts"

describe("SearchContract", () => {
  it("publishes the shared validation and matching surface from the package root", () => {
    expect(Std.SearchContract).toBe(SearchContract)
    expect(Object.keys(SearchContract).sort()).toEqual([
      "canonicalGlob",
      "expression",
      "includedByGlobs",
      "isContractRejection",
      "matchesGlob",
      "unsatisfiableNotice",
      "validateGlob",
      "validatePattern"
    ])
  })

  it("keeps only the failure constructors, their prefix, the root-failure mapping, and the literal escape internal", () => {
    expect(Object.keys(Internal).sort()).toEqual([
      "escapeRegex",
      "invalidInput",
      "invalidPattern",
      "notFound",
      "rejectionPrefix",
      "rootFailure"
    ])
  })

  it("compiles fixed strings as literal expressions", () => {
    const expression = SearchContract.expression("foo?", true, false)
    expect(expression.test("foo?")).toBe(true)
    expect(expression.test("foo")).toBe(false)
  })

  it.each([
    { name: "POSIX", layer: NodePath.layerPosix, root: "/repo/src", glob: "/repo/src/*.ts", relative: true },
    {
      name: "Windows drive",
      layer: NodePath.layerWin32,
      root: "C:\\repo\\src",
      glob: "C:/repo/src/*.ts",
      relative: true
    },
    {
      name: "Windows UNC",
      layer: NodePath.layerWin32,
      root: "\\\\server\\share\\src",
      glob: "//server/share/src/*.ts",
      relative: true
    },
    { name: "POSIX backslash", layer: NodePath.layerPosix, root: "/repo\\src", glob: "/repo/src/*.ts", relative: false }
  ])("explains an absolute glob against a $name search root", async ({ layer, root, glob, relative }) => {
    const notice = await Effect.runPromise(
      Effect.gen(function*() {
        const path = yield* Path.Path
        return yield* SearchContract.unsatisfiableNotice({
          path,
          fileSystem: FileSystem.makeNoop({
            stat: (candidate) => Effect.succeed(fileInfo({ type: candidate === root ? "Directory" : "File" }))
          }),
          root,
          globs: [glob],
          hidden: true,
          noIgnore: true
        })
      }).pipe(Effect.provide(layer))
    )
    expect(notice).toContain(`No file under ${root} can match "${glob}"`)
    if (relative) expect(notice).toContain("glob patterns are relative to the search root, so use \"*.ts\" instead.")
    else expect(notice).not.toContain("glob patterns are relative to the search root")
  })
})
