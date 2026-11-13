import { describe, expect, it } from "vitest"
import * as Install from "../src/Install.ts"
import * as NewPackage from "../src/NewPackage.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Pnpm from "../src/PnpmWorkspaceFile.ts"
import * as Runtime from "../src/Runtime.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import { packageManager } from "./toolchain.ts"

describe("public authoring boundary defaults", () => {
  it("defaults omitted shell args and environment without mutating caller data", () => {
    expect(Shell.execPayload({ shell: "echo okay" })).toEqual({
      cwd: ".",
      argv: ["/bin/sh", "-c", "echo okay"],
      env: {},
      timeoutMs: Shell.packageExecTimeoutMs
    })
  })

  it("retains the write form of a workspace manifest in its build view", () => {
    const target = Pnpm.PnpmWorkspace({ packageManager, packages: ["packages/*"], mode: "write" })
    const metadata = Target.metadata(target)
    expect(metadata.forKind("build").attrs).toBe(metadata.attrs)
    expect(metadata.forKind("lint").attrs).toMatchObject({ mode: "check" })
  })

  it("keeps the implementation-side Bun refusal when attrs are supplied at planning time", () => {
    const target = Install.Install({ packageManager })
    const bun = PackageManager.BunPackages({ runtime: Runtime.Bun({ version: ">=1.4.0" }) })
    expect(() => Target.plan(target, { packageManager: bun }))
      .toThrow(Install.bunInstallUnsupportedMessage)
  })

  it("renders the empty component identifier fallback through the boilerplate boundary", () => {
    const files = new Map(NewPackage.boilerplate("", {
      directory: ".",
      version: "0.1.0",
      license: "MIT",
      fields: {}
    }))
    expect(files.get("src/index.ts")).toContain("export const packageName = \"\"")
    expect(files.get("test/index.test.ts")).toContain("expect(packageName).toBe(\"\")")
  })
})
