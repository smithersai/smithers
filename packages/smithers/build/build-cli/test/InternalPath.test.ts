import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Path from "../src/internal/Path.ts"

const parent = NodePath.resolve("internal-path-fixture")
const root = NodePath.join(parent, "workspace")

describe("internal path containment", () => {
  it("contains the root itself and its dot spelling", () => {
    const dot = `${root}${NodePath.sep}.`
    expect(Path.contains(root, root)).toBe(true)
    expect(Path.contains(root, dot)).toBe(true)
    expect(Path.containedRelative(root, root)).toBe("")
    expect(Path.containedRelative(root, dot)).toBe("")
  })

  it("contains normal, nested, two-dot-prefixed, and dot-prefixed children", () => {
    const cases = [
      ["child", "child"],
      [NodePath.join("child", "nested"), NodePath.join("child", "nested")],
      ["..foo", "..foo"],
      [".hidden", ".hidden"]
    ] as const
    for (const [candidate, relative] of cases) {
      const absolute = NodePath.join(root, candidate)
      expect(Path.contains(root, absolute), candidate).toBe(true)
      expect(Path.containedRelative(root, absolute), candidate).toBe(relative)
    }
  })

  it("refuses a genuine parent escape and an unrelated sibling tree", () => {
    const escape = NodePath.join(root, "..", "escape")
    const sibling = NodePath.join(parent, "sibling", "file.txt")
    expect(Path.contains(root, escape)).toBe(false)
    expect(Path.containedRelative(root, escape)).toBeUndefined()
    expect(Path.contains(root, sibling)).toBe(false)
    expect(Path.containedRelative(root, sibling)).toBeUndefined()
  })

  it("refuses the exact parent, whose whole relative text is two dots", () => {
    // The one input that separates the segment rule from the text rule in the
    // other direction: `..foo` must be inside and `..` must not.
    expect(Path.contains(root, parent)).toBe(false)
    expect(Path.containedRelative(root, parent)).toBeUndefined()
  })

  it("refuses a path on another Windows volume, whose relative form is absolute", () => {
    expect(Path.contains("C:\\work\\repo", "D:\\work\\repo\\file.txt", NodePath.win32)).toBe(false)
    expect(Path.contains("C:\\work\\repo", "C:\\work\\repo\\file.txt", NodePath.win32)).toBe(true)
  })
})
