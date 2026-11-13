import * as Path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { getCallSites } from "node:util"
import * as Vm from "node:vm"
import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as Source from "../src/internal/DeclarationSource.ts"

const host: Source.Host = {
  callSites: getCallSites,
  fromFileUrl: fileURLToPath,
  basename: Path.basename,
  resolve: Path.resolve,
  isDeclaration: Input.isDeclarationFileName
}

describe("declaration-source capture policy", () => {
  it("captures a real VM declaration and its native position", () => {
    const declare = Vm.compileFunction("return capture(host)", ["capture", "host"], { filename: "/virtual/PACKAGE.ts" })
    expect(declare(Source.capture, host)).toMatchObject({
      path: Path.resolve("/virtual/PACKAGE.ts"),
      line: 1,
      column: expect.any(Number)
    })
  })

  it("converts a real file URL declaration", () => {
    const path = Path.resolve("/virtual/WORKSPACE.ts")
    const declare = Vm.compileFunction("return capture(host)", ["capture", "host"], {
      filename: pathToFileURL(path).href
    })
    expect(declare(Source.capture, host)).toMatchObject({ path, line: 1 })
  })

  it("survives an unavailable host stack without inventing a source", () => {
    expect(Source.capture({
      ...host,
      callSites: () => {
        throw new Error("host stack unavailable")
      }
    })).toBeUndefined()
  })

  it("skips invalid URLs and drops unavailable positions from a faulty host's source data", () => {
    expect(Source.capture({
      ...host,
      callSites: () => [
        { scriptName: "node:internal/unrelated", lineNumber: 1, columnNumber: 1 },
        { scriptName: "file:///invalid%ZZ/PACKAGE.ts", lineNumber: 1, columnNumber: 1 },
        { scriptName: "/virtual/PACKAGE.ts", lineNumber: 0, columnNumber: "unavailable" }
      ]
    })).toEqual({ path: Path.resolve("/virtual/PACKAGE.ts"), line: undefined, column: undefined })
    expect(Source.capture({ ...host, callSites: () => [] })).toBeUndefined()
  })
})
