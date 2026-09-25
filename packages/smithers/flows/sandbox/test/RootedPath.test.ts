/**
 * The one rule every relative path a session sees goes through.
 *
 * `Sandbox.fileSystem` roots file paths with `rootedAt` and every bundled
 * provider roots a spawn `cwd` with it, so these cases pin what a relative path
 * names on every backend. The provider tests check that each spawn hands its
 * transport the rooted `cwd`; this file owns the rule itself.
 */
import { describe, expect, it } from "vitest"
import { rootedAt } from "../src/internal/rootedPath.ts"

describe("rootedAt", () => {
  it("roots dotted, empty, and relative paths without doubling or dropping a slash", () => {
    // The workdir's trailing slashes are gone, `.` and `""` name the workdir
    // itself, `./` prefixes are stripped together with the slashes around
    // them, and an absolute path is left alone.
    const resolve = rootedAt("/work//")
    expect([".", "", "./", "./x", ".//y", "./././deep/z", "..", "/absolute"].map(resolve)).toEqual([
      "/work",
      "/work",
      "/work",
      "/work/x",
      "/work/y",
      "/work/deep/z",
      "/work/..",
      "/absolute"
    ])
  })

  it("names the root, never the empty string, for a workspace that is the root", () => {
    // A shell reads `''` as its own directory, so a root workdir keeps its one
    // slash and a path under it never starts with two.
    for (const workdir of ["/", "///"]) {
      const resolve = rootedAt(workdir)
      expect([".", "", "etc", "./././deep/z", ".//x"].map(resolve)).toEqual(["/", "/", "/etc", "/deep/z", "/x"])
    }
  })

  it("strips only a `./` prefix, leaving dot-named entries and a trailing slash to the caller", () => {
    // `.hidden` and `..` are entries, not prefixes. A trailing slash is kept
    // because it changes what a link names: `dir/` resolves a link to its
    // target directory where `dir` names the link itself.
    const resolve = rootedAt("/work")
    expect([".hidden", "./.hidden", "../up", "sub/"].map(resolve)).toEqual([
      "/work/.hidden",
      "/work/.hidden",
      "/work/../up",
      "/work/sub/"
    ])
  })

  it.each(["C:/work/", String.raw`C:\work`])("keeps Windows absolute paths absolute under %s", (workdir) => {
    const resolve = rootedAt(workdir)
    expect(
      ["", ".", String.raw`.\nested\file`, String.raw`C:\work\file`, "D:/other/file", String.raw`\\server\share\file`]
        .map(resolve)
    ).toEqual([
      "C:/work",
      "C:/work",
      "C:/work/nested/file",
      "C:/work/file",
      "D:/other/file",
      "//server/share/file"
    ])
  })

  it("roots relative Windows paths under a UNC workspace", () => {
    const resolve = rootedAt(String.raw`\\server\share\work`)
    expect(resolve(String.raw`.\nested\file`)).toBe("//server/share/work/nested/file")
    expect(resolve(String.raw`\\other\share\file`)).toBe("//other/share/file")
  })

  it("preserves backslashes and drive-like names in POSIX guests", () => {
    const resolve = rootedAt("/work")
    expect(resolve(String.raw`C:\file`)).toBe(String.raw`/work/C:\file`)
    expect(resolve(String.raw`nested\file`)).toBe(String.raw`/work/nested\file`)
  })

  it("preserves a Windows drive root without turning it into a drive-relative path", () => {
    const resolve = rootedAt("C:/")
    expect(["", ".", "./", "nested/file", "C:/absolute"].map(resolve)).toEqual([
      "C:/",
      "C:/",
      "C:/",
      "C:/nested/file",
      "C:/absolute"
    ])
  })
})
