import { describe, expect, it } from "vitest"
import { filesOf, regexOf } from "../../src/inventory/Glob.vibe"

/** True when the pattern names the path. */
const names = (pattern: string, path: string): boolean => new RegExp(regexOf(pattern) as string).test(path)

// "@actions/glob", "Patterns": `*` matches zero or more characters but not `/`, `?` one character, `**` any
// number of directories, `[]` a set of characters, and a leading `!` leaves matches out.
describe("regexOf", () => {
  it.each<[string, ReadonlyArray<string>, ReadonlyArray<string>]>([
    ["package-lock.json", ["package-lock.json"], ["a/package-lock.json", "package-lock.jsonx", "xpackage-lock.json"]],
    ["**/package-lock.json", ["package-lock.json", "a/package-lock.json", "a/b/package-lock.json"], [
      "a/package-lock.jsonc"
    ]],
    ["packages/*/go.sum", ["packages/a/go.sum"], ["packages/go.sum", "packages/a/b/go.sum"]],
    ["src/**", ["src/a", "src/a/b.ts"], ["srcx/a", "other/src/a"]],
    ["**/*.gradle*", ["build.gradle", "app/build.gradle.kts"], ["app/gradle/wrapper.jar"]],
    ["file?.txt", ["file1.txt"], ["file.txt", "file12.txt", "file/.txt"]],
    ["lock[0-9].txt", ["lock3.txt"], ["lockx.txt"]],
    ["lock[!0-9].txt", ["lockx.txt"], ["lock3.txt"]],
    // A negated set that ends in a range up to `-` keeps that range: `.` is outside `+` to `-`, and so is named.
    ["lock[!+--].txt", ["lock..txt", "locka.txt"], ["lock+.txt", "lock,.txt", "lock-.txt", "lock/.txt"]],
    ["lock[!a-].txt", ["lockb.txt"], ["locka.txt", "lock-.txt", "lock/.txt"]],
    ["a+b(1)|c{2}^$.txt", ["a+b(1)|c{2}^$.txt"], ["aab1c2.txt", "a+b(1)|c{2}^$xtxt"]],
    ["odd[name.txt", ["odd[name.txt"], ["oddn"]],
    ["odd]name.txt", ["odd]name.txt"], ["oddname.txt"]],
    ["./vendor/", ["vendor/a", "vendor/a/b"], ["vendors/a"]],
    // A directory names every file under it.
    ["docs", ["docs", "docs/a.md", "docs/a/b.md"], ["docs2/a.md"]]
  ])("reads %s", (pattern, taken, left) => {
    for (const path of taken) expect([path, names(pattern, path)]).toEqual([path, true])
    for (const path of left) expect([path, names(pattern, path)]).toEqual([path, false])
  })

  it("escapes malformed character classes instead of emitting invalid regular expressions", () => {
    for (
      const pattern of [
        "lock[9-0].txt",
        "lock[!].txt",
        "lock[^].txt",
        "lock[a-c-e].txt",
        "lock[[:alpha:]].txt",
        "lock[[.a.]].txt",
        "lock[[=a=]].txt",
        "lock[].txt",
        "lock[\\-z].txt",
        "lock[\\].txt"
      ]
    ) {
      const re = regexOf(pattern)
      expect(re).toBeTypeOf("string")
      expect(() => new RegExp(re as string)).not.toThrow()
    }
    expect(names("lock[9-0].txt", "lock[9-0].txt")).toBe(true)
    expect(names("lock[!].txt", "lock[!].txt")).toBe(true)
    expect(names("lock[a-z0-9].txt", "lock5.txt")).toBe(true)
  })

  it("reads no pattern that leaves the repository", () => {
    for (const pattern of ["/etc/hosts", "~/.npmrc", "../other/lock", "a/../../b", "", "./"]) {
      expect(regexOf(pattern)).toBeUndefined()
    }
  })
})

describe("filesOf", () => {
  it("takes the files of every pattern, and leaves out those a ! names", () => {
    expect(filesOf(["**/go.sum", "!vendor/**\n# a comment\n\n  go.work.sum  "])).toEqual({
      take: [regexOf("**/go.sum"), regexOf("go.work.sum")],
      leave: [regexOf("vendor/**")]
    })
  })

  it("reads nothing when a pattern leaves the repository, or none takes a file", () => {
    expect(filesOf(["**/go.sum", "/etc/hosts"])).toBeUndefined()
    expect(filesOf(["!vendor/**"])).toBeUndefined()
    expect(filesOf([])).toBeUndefined()
  })
})
