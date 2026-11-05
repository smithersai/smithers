import { Smithers as S } from "@smthrs/targets"
import { describe, expect, it } from "vitest"
import { selectInstallTarget } from "../src/Cli.ts"
import type { IndexedTarget } from "../src/PackageIndex.ts"

const install = (packagePath: string, key = "install"): IndexedTarget => ({
  packagePath,
  key,
  label: `//${packagePath}:${key}`,
  target: S.Install({ lockfilePath: "pnpm-lock.yaml" })
})

describe("Install selection", () => {
  it("selects an overlay's unique non-root Install", () => {
    const overlay = install(".smithers/upstream")
    expect(selectInstallTarget([overlay])).toBe(overlay)
  })

  it("retains the root Install's precedence over nested installs", () => {
    const root = install("")
    expect(selectInstallTarget([install(".smithers/upstream"), root, install("tools")])).toBe(root)
  })

  it("ignores non-install targets", () => {
    const overlay = install(".smithers/upstream")
    expect(selectInstallTarget([
      { ...install(""), target: S.Shell.Run({ shell: "true" }) },
      overlay
    ])).toBe(overlay)
  })

  it("refuses an absent install declaration", () => {
    expect(() => selectInstallTarget([])).toThrow("declares no Install target")
  })

  it("refuses ambiguous workspace installs and names the candidates", () => {
    expect(() => selectInstallTarget([install("one"), install("two")]))
      .toThrow("//one:install, //two:install")
  })

  it("refuses ambiguous root installs even with a unique nested install", () => {
    expect(() => selectInstallTarget([install("", "one"), install("", "two"), install("nested")]))
      .toThrow("root PACKAGE.ts declares more than one Install target")
  })
})
