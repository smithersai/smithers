/** The text-only path helpers agree with `node:path` on every path the package hands them. */
import { posix, win32 } from "node:path"
import { describe, expect, it } from "vitest"
import * as PathText from "../../src/internal/PathText.ts"

const names = ["a", "state.json", ".smithers", "..b", "c d"]
/** Every relative path of one to three plain segments. */
const tails = (separator: string): ReadonlyArray<string> => {
  const one = names.map((name) => [name])
  const two = one.flatMap((path) => names.map((name) => [...path, name]))
  const three = two.flatMap((path) => names.slice(0, 2).map((name) => [...path, name]))
  return [...one, ...two, ...three].map((path) => path.join(separator))
}

describe("PathText.dirname", () => {
  it("matches posix.dirname for absolute and relative normalized paths", () => {
    for (const tail of tails("/")) {
      for (const file of [`/${tail}`, tail]) expect(PathText.dirname(file), file).toBe(posix.dirname(file))
    }
    expect(PathText.dirname("/")).toBe("/")
    expect(PathText.dirname("/tmp/gateway/")).toBe(posix.dirname("/tmp/gateway/"))
  })

  it("matches win32.dirname under a drive, a share, and with forward separators", () => {
    for (const root of ["C:\\", "z:\\", "\\\\server\\share\\", "C:/"]) {
      for (const tail of tails(root.endsWith("/") ? "/" : "\\")) {
        const file = `${root}${tail}`
        expect(PathText.dirname(file), file).toBe(win32.dirname(file))
      }
      expect(PathText.dirname(root), root).toBe(win32.dirname(root))
    }
    expect(PathText.dirname("C:\\state\\gateway\\")).toBe(win32.dirname("C:\\state\\gateway\\"))
    expect(PathText.dirname("\\\\server")).toBe(win32.dirname("\\\\server"))
  })
})

describe("PathText.absoluteIssue", () => {
  /** What `Options.layoutIssue` asked `node:path` before it became portable. */
  const reference = (path: typeof posix, root: string): "relative" | "unnormalized" | undefined =>
    !path.isAbsolute(root)
      ? "relative"
      : path.normalize(root) !== root || (root !== path.parse(root).root && root.endsWith(path.sep))
      ? "unnormalized"
      : undefined

  const dirty = (separator: string): ReadonlyArray<string> => [
    ...tails(separator),
    `a${separator}`,
    `a${separator}${separator}b`,
    `a${separator}.${separator}b`,
    `a${separator}..${separator}b`,
    `..${separator}a`,
    ".",
    ".."
  ]

  it("agrees with posix isAbsolute and normalize", () => {
    for (const tail of dirty("/")) {
      for (const root of [`/${tail}`, tail, `//${tail}`]) {
        expect(PathText.absoluteIssue(root), root).toBe(reference(posix, root))
      }
    }
    expect(PathText.absoluteIssue("/")).toBeUndefined()
    expect(PathText.absoluteIssue("")).toBe("relative")
  })

  it("agrees with win32 isAbsolute and normalize for drive and share roots", () => {
    for (const prefix of ["C:\\", "c:\\", "\\\\server\\share\\", "C:/", "C:", "\\\\server\\share", "\\\\server\\"]) {
      for (const tail of ["", ...dirty("\\"), "a/b"]) {
        const root = `${prefix}${tail}`
        expect(PathText.absoluteIssue(root), root).toBe(reference(win32, root))
      }
    }
  })
})
