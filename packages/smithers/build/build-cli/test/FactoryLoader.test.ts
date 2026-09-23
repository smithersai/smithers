/**
 * `validateFactoryModule` in isolation: every export shape a FACTORY.ts
 * namespace can carry, and the routing code each one produces.
 */
import { Smithers as S } from "@smthrs/targets"
import { describe, expect, it } from "vitest"
import { factoryFileBeside, validateFactoryModule } from "../src/FactoryLoader.ts"
import { isPackageError } from "../src/PackageError.ts"

const review = S.Flow({ flow: "review", summary: "Review the change.", featured: true })
const factory = S.Factory({ summary: "How unit develops itself.", flows: [review], on: { "issue.opened": "issue" } })
const home = S.Factory.Home({ blocks: [S.Home.Flows()] })
const check = S.Shell.Test({ shell: "true" })
const workspace = S.Workspace("unit", {
  repository: "git+https://example.invalid/unit.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Pnpm({ version: "11.21.0", runtime: S.Runtime.Node({ version: ">=26.4.0" }) }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})

/** Runs the validator and returns the routing code it throws. */
const thrownCode = (namespace: unknown): string => {
  try {
    validateFactoryModule(namespace, ".smithers/FACTORY.ts")
  } catch (cause) {
    if (isPackageError(cause)) return cause.code
    throw cause
  }
  throw new Error("validateFactoryModule did not throw")
}

describe("FactoryLoader.factoryFileBeside", () => {
  it("names the FACTORY.ts beside the workspace declaration", () => {
    expect(factoryFileBeside(".smithers/WORKSPACE.ts")).toBe(".smithers/FACTORY.ts")
    expect(factoryFileBeside("WORKSPACE.ts")).toBe("FACTORY.ts")
  })
})

describe("FactoryLoader.validateFactoryModule", () => {
  it("returns the factory and home exports and passes flow declarations and plain values through", () => {
    expect(validateFactoryModule({ review, factory, home, version: "1" }, ".smithers/FACTORY.ts")).toEqual({
      file: ".smithers/FACTORY.ts",
      factory,
      home
    })
    expect(validateFactoryModule({ factory }, ".smithers/FACTORY.ts").home).toBeUndefined()
  })

  it("refuses a namespace that is not an object", () => {
    expect(thrownCode(undefined)).toBe("module_import_failed")
    expect(thrownCode("FACTORY")).toBe("module_import_failed")
  })

  it("refuses a factory or home exported under any other name, or twice", () => {
    expect(thrownCode({ Factory: factory })).toBe("factory_export_duplicate")
    expect(thrownCode({ factory, second: factory })).toBe("factory_export_duplicate")
    expect(thrownCode({ factory, Home: home })).toBe("factory_export_duplicate")
    expect(thrownCode({ factory, home, pane: home })).toBe("factory_export_duplicate")
  })

  it("refuses factory and home exports that are not declarations", () => {
    expect(thrownCode({ factory: { summary: "x" } })).toBe("factory_export_missing")
    expect(thrownCode({ factory, home: { blocks: [] } })).toBe("factory_export_missing")
  })

  it("refuses a naked target, a Package, and a workspace declaration", () => {
    expect(thrownCode({ factory, check })).toBe("naked_target_export")
    expect(thrownCode({ factory, Package: S.Package({ targets: { check } }) })).toBe("factory_export_duplicate")
    expect(thrownCode({ factory, Workspace: workspace })).toBe("factory_export_duplicate")
  })

  it("refuses a module with no factory export and reports the module path", () => {
    expect(thrownCode({})).toBe("factory_export_missing")
    expect(thrownCode({ home })).toBe("factory_export_missing")
    try {
      validateFactoryModule({}, ".smithers/FACTORY.ts")
    } catch (cause) {
      expect(isPackageError(cause) ? cause.path : undefined).toBe(".smithers/FACTORY.ts")
      return
    }
    throw new Error("validateFactoryModule did not throw")
  })
})
