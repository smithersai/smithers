import { describe, expect, it } from "vitest"
import * as Barrel from "../src/index.ts"
import { Smithers } from "../src/index.ts"
import * as Flat from "../src/Smithers.ts"

/**
 * The package entry point is the PACKAGE.ts authoring contract. A PACKAGE.ts file
 * writes one import line and reaches the whole catalog through the namespace,
 * so anything that escapes the namespace, or anything the namespace stops
 * carrying, is a break in that contract rather than an internal detail.
 */
describe("the package entry point", () => {
  it("exports the Smithers namespace and nothing else", () => {
    expect(Object.keys(Barrel)).toEqual(["Smithers"])
  })

  it("carries every member of the authoring surface", () => {
    expect(Object.keys(Smithers).sort()).toEqual(Object.keys(Flat).sort())
  })
})

describe("the Smithers namespace", () => {
  it("declares a runtime, and the namespace name is also the type", () => {
    // The annotation is the assertion: `Smithers.Runtime` resolves in type
    // position as well as value position, so a PACKAGE.ts author never writes
    // `Smithers.Runtime.Runtime`.
    const runtime: Smithers.Runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })

    expect(runtime).toEqual({
      name: "node",
      version: ">=22.19.0",
      executable: "node"
    })
  })

  it("declares a package manager over that runtime", () => {
    const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
    const packageManager: Smithers.PackageManager = Smithers.PackageManager.Pnpm({
      version: "11.21.0",
      runtime
    })

    expect(packageManager.name).toBe("pnpm")
    expect(packageManager.runtime).toEqual(runtime)
  })

  it("declares a secret by variable name, never by value", () => {
    const secret = Smithers.Secret("SMITHERS_CACHE_TOKEN")

    expect(secret).toEqual({ _tag: "Secret", env: "SMITHERS_CACHE_TOKEN" })
  })

  it("declares inputs and targets through the same namespace", () => {
    expect(Smithers.file("package.json")).toEqual({ _tag: "File", path: "package.json" })
    expect(Smithers.Target.isTarget(Smithers.Filegroup({ srcs: [Smithers.glob("src/**/*.ts")] })))
      .toBe(true)
  })
})
