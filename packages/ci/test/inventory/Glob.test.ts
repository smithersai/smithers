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
