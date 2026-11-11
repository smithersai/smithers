/**
 * `Input.nodeModules`: the declaration and the paths it names.
 *
 * The planner and the confinement both read these paths, so they are checked
 * as a law over directory depth: the manifest and lockfiles that key the
 * install and the tree a tool may read always sit inside the one declared
 * directory, wherever it is and whichever package declares it.
 */
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { Smithers as S } from "../src/index.ts"
import * as Input from "../src/Input.ts"

const segment = fc.stringMatching(/^[a-z][a-z0-9_-]{0,8}$/)

describe("Input.nodeModules", () => {
  it("is an inert declared input", () => {
    const declared = S.nodeModules("//experiments")
    expect(declared).toEqual({ _tag: "NodeModules", path: "//experiments" })
    expect(Input.isDeclared(declared)).toBe(true)
    expect(Input.isDeclared({ _tag: "NodeModules" })).toBe(false)
  })

  it("names the manifest, the lockfiles and the tree inside a workspace-rooted directory at any depth", () => {
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 5 }), fc.array(segment, { maxLength: 3 }), (directory, packageDir) => {
        const declared = Input.nodeModules(directory.length === 0 ? "//." : `//${directory.join("/")}`)
        const paths = Input.nodeModulesPaths(packageDir.join("/"), declared)
        const prefix = directory.length === 0 ? "" : `${directory.join("/")}/`
        expect(paths.directory).toBe(directory.join("/"))
        expect(paths.manifest).toBe(`${prefix}package.json`)
        expect(paths.tree).toBe(`${prefix}node_modules`)
        expect(paths.lockfiles).toEqual(Input.nodeModulesLockfiles.map((name) => `${prefix}${name}`))
      })
    )
  })

  it("resolves a package-relative directory against the declaring package", () => {
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 3 }), segment, (packageDir, child) => {
        const paths = Input.nodeModulesPaths(packageDir.join("/"), Input.nodeModules(child))
        expect(paths.manifest).toBe(`${packageDir.join("/")}/${child}/package.json`)
        expect(paths.tree).toBe(`${packageDir.join("/")}/${child}/node_modules`)
      })
    )
  })

  it("names the declaring package itself for `.`", () => {
    expect(Input.nodeModulesPaths("tools/gen", Input.nodeModules(".")).tree).toBe("tools/gen/node_modules")
    expect(Input.nodeModulesPaths("", Input.nodeModules(".")).tree).toBe("node_modules")
  })

  it("refuses a directory that escapes the workspace", () => {
    expect(() => Input.nodeModulesPaths("", Input.nodeModules("../outside"))).toThrow(/escapes the workspace/)
  })

  it("reads lockfiles in one fixed order", () => {
    expect([...Input.nodeModulesLockfiles]).toEqual([...Input.nodeModulesLockfiles].sort())
    expect(Object.isFrozen(Input.nodeModulesLockfiles)).toBe(true)
  })
})
