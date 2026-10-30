/**
 * The Bazel label grammar the CLI accepts: `:name` relative labels, `//pkg`,
 * `//pkg:name`, and `...` subtree patterns, plus the current-package
 * derivation from a working directory.
 */
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Label from "../src/Label.ts"

describe("nonrecursive package wildcards", () => {
  it.each(["//pkg:*", "//:*", "//pkg/...", "//..."])("recognizes %s as an automatic selection", (pattern) => {
    expect(Label.isWildcard(Label.parse(pattern, ""))).toBe(true)
  })
  it.each(["//pkg", "//pkg:test", "//pkg/...:test", "//...:test"])("keeps %s an explicit selection", (pattern) => {
    expect(Label.isWildcard(Label.parse(pattern, ""))).toBe(false)
  })
})

describe("Label.parse", () => {
  it("resolves a :name label against the normalized current package", () => {
    expect(Label.parse(":lint", "apps/web")).toEqual({ _tag: "Exact", packagePath: "apps/web", target: "lint" })
    expect(Label.parse(":lint", "")).toEqual({ _tag: "Exact", packagePath: "", target: "lint" })
    expect(Label.parse(":lint", ".")).toEqual({ _tag: "Exact", packagePath: "", target: "lint" })
    expect(Label.parse(":lint", "/apps\\web/")).toEqual({ _tag: "Exact", packagePath: "apps/web", target: "lint" })
  })

  it("refuses an empty or nested :name label", () => {
    expect(() => Label.parse(":", "")).toThrow(/invalid target label/)
    expect(() => Label.parse(":a:b", "")).toThrow(/invalid target label/)
  })

  it("parses subtree patterns", () => {
    expect(Label.parse("//...", "")).toEqual({ _tag: "Subtree", packagePath: "", target: undefined })
    expect(Label.parse("//apps/web/...", "")).toEqual({
      _tag: "Subtree",
      packagePath: "apps/web",
      target: undefined
    })
  })

  it("parses a recursive pattern narrowed to one target name", () => {
    // `//pkg/...:name` is the Bazel spelling for "this target in every package
    // under here". Before it existed the head parsed as a package literally
    // named `pkg/...`, which resolved to nothing and reported an unknown label.
    expect(Label.parse("//packages/...:bunTest", "")).toEqual({
      _tag: "Subtree",
      packagePath: "packages",
      target: "bunTest"
    })
    expect(Label.parse("//...:bunTest", "")).toEqual({ _tag: "Subtree", packagePath: "", target: "bunTest" })
  })

  it("refuses a narrowed recursive pattern outside the grammar", () => {
    expect(() => Label.parse("//packages/...:", "")).toThrow(/target name is empty/)
    expect(() => Label.parse("//packages/...:a:b", "")).toThrow(/invalid target label/)
    expect(() => Label.parse("//packages/./...:bunTest", "")).toThrow(/invalid package path/)
  })

  it("parses exact labels with and without a target name", () => {
    expect(Label.parse("//apps/web", "")).toEqual({ _tag: "Exact", packagePath: "apps/web", target: undefined })
    expect(Label.parse("//apps/web:lint", "")).toEqual({ _tag: "Exact", packagePath: "apps/web", target: "lint" })
    expect(Label.parse("//:lint", "")).toEqual({ _tag: "Exact", packagePath: "", target: "lint" })
    expect(Label.parse("//", "")).toEqual({ _tag: "Exact", packagePath: "", target: undefined })
  })

  it("refuses labels outside the grammar", () => {
    expect(() => Label.parse("apps/web:lint", "")).toThrow(/label must start with/)
    expect(() => Label.parse("//apps:web:lint", "")).toThrow(/invalid target label/)
    expect(() => Label.parse("//apps:", "")).toThrow(/target name is empty/)
  })

  it("refuses package paths with empty, dot, or parent segments", () => {
    expect(() => Label.parse("//apps//web:lint", "")).toThrow(/invalid package path/)
    expect(() => Label.parse("//apps/../web:lint", "")).toThrow(/invalid package path/)
    expect(() => Label.parse("//apps/./web/...", "")).toThrow(/invalid package path/)
    expect(() => Label.parse(":lint", "apps/..")).toThrow(/invalid package path/)
  })
})

describe("Label.format", () => {
  it("normalizes the package path", () => {
    expect(Label.format("", "lint")).toBe("//:lint")
    expect(Label.format(".", "lint")).toBe("//:lint")
    expect(Label.format("/apps/web/", "lint")).toBe("//apps/web:lint")
  })
})

describe("Label.currentPackage", () => {
  const root = NodePath.resolve("/workspace")

  it("maps the root and nested directories to package paths", () => {
    expect(Label.currentPackageOrUndefined(root, root)).toBe("")
    expect(Label.currentPackageOrUndefined(root, NodePath.join(root, "apps", "web"))).toBe("apps/web")
    expect(Label.currentPackage(root, root)).toBe("")
    expect(Label.currentPackage(root, NodePath.join(root, "apps"))).toBe("apps")
  })

  it("reports directories outside the workspace", () => {
    const outside = NodePath.resolve("/elsewhere")
    expect(Label.currentPackageOrUndefined(root, outside)).toBeUndefined()
    expect(Label.currentPackageOrUndefined(root, NodePath.dirname(root))).toBeUndefined()
    expect(() => Label.currentPackage(root, outside)).toThrow(/outside workspace/)
  })
})

describe("containment is judged by path segment", () => {
  const root = NodePath.resolve("/workspace")

  /**
   * The check used to be `relative.startsWith("..")`, which reads the rendered
   * text rather than the first segment: a workspace child literally named
   * `..foo` renders as `..foo/pkg` and was reported as outside the workspace it
   * is plainly inside, so no relative label could resolve from it.
   */
  it("keeps a directory whose name begins with two dots inside the workspace", () => {
    expect(Label.currentPackageOrUndefined(root, NodePath.join(root, "..foo"))).toBe("..foo")
    expect(Label.currentPackageOrUndefined(root, NodePath.join(root, "..foo", "pkg"))).toBe("..foo/pkg")
  })

  it("still reports a genuine escape and the exact parent", () => {
    expect(Label.currentPackageOrUndefined(root, NodePath.join(root, "..", "sibling"))).toBeUndefined()
    expect(Label.currentPackageOrUndefined(root, NodePath.dirname(root))).toBeUndefined()
  })
})
