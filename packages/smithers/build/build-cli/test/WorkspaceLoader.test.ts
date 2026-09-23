/**
 * `validateWorkspaceModule` in isolation: every export shape a WORKSPACE.ts
 * namespace can carry, and the routing code each one produces.
 */
import { Smithers as S } from "@smthrs/targets"
import { describe, expect, it } from "vitest"
import { isPackageError } from "../src/PackageError.ts"
import { validateWorkspaceModule } from "../src/WorkspaceLoader.ts"

/** A minimal workspace declaration for module validation unit tests. */
const workspace = S.Workspace("unit", {
  repository: "git+https://example.invalid/unit.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Pnpm({
    version: "11.21.0",
    runtime: S.Runtime.Node({ version: ">=26.4.0" })
  }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})

const check = S.Shell.Test({ shell: "true" })

/** Runs the validator and returns the routing code it throws. */
const thrownCode = (namespace: unknown): string => {
  try {
    validateWorkspaceModule(namespace, "WORKSPACE.ts")
  } catch (cause) {
    if (isPackageError(cause)) return cause.code
    throw cause
  }
  throw new Error("validateWorkspaceModule did not throw")
}

describe("WorkspaceLoader.validateWorkspaceModule", () => {
  it("returns the Workspace export and ignores plain values", () => {
    expect(validateWorkspaceModule({ version: "1", Workspace: workspace, agents: {} }, "WORKSPACE.ts")).toBe(
      workspace
    )
  })

  it("refuses a namespace that is not an object", () => {
    expect(thrownCode(undefined)).toBe("module_import_failed")
    expect(thrownCode(null)).toBe("module_import_failed")
    expect(thrownCode("WORKSPACE")).toBe("module_import_failed")
  })

  it("refuses a workspace exported under any other name", () => {
    expect(thrownCode({ Other: workspace })).toBe("workspace_export_duplicate")
    expect(thrownCode({ Workspace: workspace, Zeta: workspace })).toBe("workspace_export_duplicate")
  })

  it("refuses a naked target export", () => {
    expect(thrownCode({ Workspace: workspace, check })).toBe("naked_target_export")
  })

  it("refuses a Package export", () => {
    expect(thrownCode({ Package: S.Package({ targets: { check } }), Workspace: workspace })).toBe(
      "workspace_export_duplicate"
    )
  })

  it("refuses a module with no Workspace export", () => {
    expect(thrownCode({})).toBe("workspace_export_missing")
    expect(thrownCode({ version: "1" })).toBe("workspace_export_missing")
  })

  it("reports the module path on every diagnostic", () => {
    try {
      validateWorkspaceModule({}, ".smithers/WORKSPACE.ts")
    } catch (cause) {
      expect(isPackageError(cause) ? cause.path : undefined).toBe(".smithers/WORKSPACE.ts")
      return
    }
    throw new Error("validateWorkspaceModule did not throw")
  })
})
