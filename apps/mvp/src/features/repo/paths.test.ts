import { describe, expect, test } from "vitest"
import {
  blobKey,
  canonicalRepoHref,
  copyPayloadOf,
  encodePath,
  editHrefFor,
  hrefFor,
  isMarkdownPath,
  lineSearch,
  parseLines,
  parseLineHash,
  readmeOf,
  refsKey,
  resolveRef,
  targetOf,
  treeKey,
  viewHrefFor,
} from "./paths"

// Where things are in a repository and in the app's URLs: the pure functions the actions, queries and views share.

const SHA = "a".repeat(40)
const OTHER = "b".repeat(40)
const repo = { owner: "octocat", name: "Spoon-Knife", defaultBranch: "main" }

describe("keys", () => {
  test("name a file list and a file by repository, commit and path", () => {
    expect(treeKey("github/o/n", SHA)).toBe(`github/o/n@${SHA}`)
    expect(blobKey("github/o/n", SHA, "docs/a.md")).toBe(`github/o/n@${SHA}:docs/a.md`)
    expect(refsKey("github/o/n", SHA)).toBe(`github/o/n@${SHA}@`)
    expect(refsKey("github/o/n", SHA, null)).toBe(`github/o/n@${SHA}@`)
    expect(refsKey("github/o/n", SHA, "2026-10-21T20:00:00Z")).toBe(`github/o/n@${SHA}@2026-10-21T20:00:00Z`)
  })
})

describe("readmeOf", () => {
  const paths = ["README.md", "docs/readme.MD", "docs/guide.md", "docs/deep/README.md", "src/index.ts"]
  test("finds the directory's own README in any case, never a deeper one", () => {
    expect(readmeOf(paths, "")).toBe("README.md")
    expect(readmeOf(paths, "docs")).toBe("docs/readme.MD")
    expect(readmeOf(paths, "docs/deep")).toBe("docs/deep/README.md")
    expect(readmeOf(paths, "src")).toBeUndefined()
    expect(readmeOf(["docs/README.md"], "")).toBeUndefined()
  })
})

describe("resolveRef", () => {
  const ready = { defaultBranch: "main", headSha: SHA }
  test("the default branch, or no ref, reads at the head commit", () => {
    expect(resolveRef(ready, null, "")).toEqual({ revision: "main", sha: SHA, path: "" })
    expect(resolveRef(ready, "main", "docs/a.md")).toEqual({ revision: "main", sha: SHA, path: "docs/a.md" })
  })

  test("a full SHA reads at itself, even before the repository has a head", () => {
    expect(resolveRef(ready, OTHER, "a.md")).toEqual({ revision: OTHER, sha: OTHER, path: "a.md" })
    expect(resolveRef({ defaultBranch: null, headSha: null }, OTHER, "")).toEqual({
      revision: OTHER,
      sha: OTHER,
      path: "",
    })
  })

  test("a default branch with a slash is matched across the ref and the path", () => {
    const slashed = { defaultBranch: "release/1.x", headSha: SHA }
    expect(resolveRef(slashed, "release", "1.x/docs/a.md")).toEqual({
      revision: "release/1.x",
      sha: SHA,
      path: "docs/a.md",
    })
    expect(resolveRef(slashed, "release", "1.x")).toEqual({ revision: "release/1.x", sha: SHA, path: "" })
    expect(resolveRef(slashed, "release", "2.x/a.md")).toBeUndefined()
    expect(resolveRef(slashed, "release/1.x", "")).toEqual({ revision: "release/1.x", sha: SHA, path: "" })
  })

  test("with the refs, a branch or tag reads at its commit; the longest name leads, and a branch wins over a tag", () => {
    const refs = {
      branches: [{ name: "test-branch", sha: OTHER }, { name: "feature", sha: "c".repeat(40) }, { name: "feature/x", sha: "d".repeat(40) }],
      tags: [{ name: "v1.0.0", sha: "e".repeat(40) }, { name: "test-branch", sha: "f".repeat(40) }],
    }
    expect(resolveRef(ready, "test-branch", "a.md", refs)).toEqual({ revision: "test-branch", sha: OTHER, path: "a.md" })
    expect(resolveRef(ready, "v1.0.0", "", refs)).toEqual({ revision: "v1.0.0", sha: "e".repeat(40), path: "" })
    expect(resolveRef(ready, "feature", "x/docs/a.md", refs)).toEqual({
      revision: "feature/x",
      sha: "d".repeat(40),
      path: "docs/a.md",
    })
    expect(resolveRef(ready, "feature", "y/a.md", refs)).toEqual({ revision: "feature", sha: "c".repeat(40), path: "y/a.md" })
    expect(resolveRef(ready, "main", "a.md", refs)).toEqual({ revision: "main", sha: SHA, path: "a.md" })
    expect(resolveRef(ready, "dev", "a.md", refs)).toBeUndefined()
  })

  test("any other ref, or a repository without a head, names nothing", () => {
    expect(resolveRef(ready, "dev", "a.md")).toBeUndefined()
    expect(resolveRef(ready, "mainline", "")).toBeUndefined()
    expect(resolveRef({ defaultBranch: null, headSha: null }, null, "")).toBeUndefined()
    expect(resolveRef({ defaultBranch: "main", headSha: null }, "main", "")).toBeUndefined()
  })
})

describe("parseLines", () => {
  test("reads a line or a range, as a string or the number the router parsed", () => {
    expect(parseLines("3")).toEqual({ line: 3, lineEnd: null })
    expect(parseLines(3)).toEqual({ line: 3, lineEnd: null })
    expect(parseLines("3-7")).toEqual({ line: 3, lineEnd: 7 })
  })

  test("a range that doesn't go forward is its first line; anything else anchors nothing", () => {
    expect(parseLines("7-3")).toEqual({ line: 7, lineEnd: null })
    expect(parseLines("3-3")).toEqual({ line: 3, lineEnd: null })
    for (const value of [undefined, null, "", "0", "-3", "a", "3-", "3-x", 1.5, "1234567890"]) {
      expect(parseLines(value)).toEqual({ line: null, lineEnd: null })
    }
  })
})

describe("lineSearch", () => {
  test("keeps only the line anchor, as the router parsed it", () => {
    expect(lineSearch({ L: 3, tab: "x" })).toEqual({ L: 3 })
    expect(lineSearch({ L: "3-5" })).toEqual({ L: "3-5" })
    expect(lineSearch({ tab: "x" })).toEqual({})
    expect(lineSearch({})).toEqual({})
  })
})

describe("hrefFor", () => {
  test("the root at the default branch is the repository's own path", () => {
    expect(hrefFor(repo, "main", { kind: "tree", path: "" })).toBe("/octocat/Spoon-Knife")
  })

  test("anything else names its kind, revision and path, each segment encoded", () => {
    expect(hrefFor(repo, SHA, { kind: "tree", path: "" })).toBe(`/octocat/Spoon-Knife/tree/${SHA}`)
    expect(hrefFor(repo, "main", { kind: "tree", path: "docs" })).toBe("/octocat/Spoon-Knife/tree/main/docs")
    expect(hrefFor(repo, "release/1.x", { kind: "blob", path: "a b/c#.md" })).toBe(
      "/octocat/Spoon-Knife/blob/release/1.x/a%20b/c%23.md",
    )
    expect(encodePath("a b/c")).toBe("a%20b/c")
  })

  test("a file's line anchor is a line or a forward range; a directory has none", () => {
    expect(hrefFor(repo, "main", { kind: "blob", path: "a.ts", line: 3 })).toBe(
      "/octocat/Spoon-Knife/blob/main/a.ts?L=3",
    )
    expect(hrefFor(repo, "main", { kind: "blob", path: "a.ts", line: 3, lineEnd: 9 })).toBe(
      "/octocat/Spoon-Knife/blob/main/a.ts?L=3-9",
    )
    expect(hrefFor(repo, "main", { kind: "blob", path: "a.ts", line: 3, lineEnd: 3 })).toBe(
      "/octocat/Spoon-Knife/blob/main/a.ts?L=3",
    )
    expect(hrefFor(repo, "main", { kind: "tree", path: "src", line: 3 })).toBe("/octocat/Spoon-Knife/tree/main/src")
  })
})

describe("targetOf", () => {
  test("a repository's root, a directory, and a file with its line anchor", () => {
    expect(targetOf("tree", { owner: "o", repo: "n" }, {})).toEqual({
      owner: "o",
      name: "n",
      kind: "tree",
      ref: null,
      path: "",
      line: null,
      lineEnd: null,
    })
    expect(targetOf("tree", { owner: "o", repo: "n", ref: "main", _splat: "docs/" }, { L: "3" })).toMatchObject({
      ref: "main",
      path: "docs",
      line: null,
    })
    expect(targetOf("blob", { owner: "o", repo: "n", ref: "main", _splat: "a.ts" }, { L: "2-4" })).toMatchObject({
      kind: "blob",
      path: "a.ts",
      line: 2,
      lineEnd: 4,
    })
    expect(targetOf("blob", {}, {})).toMatchObject({ owner: "", name: "", path: "", line: null })
  })
})

describe("copyPayloadOf", () => {
  const view = {
    owner: "octocat",
    name: "Spoon-Knife",
    kind: "blob" as const,
    path: "src/a.ts",
    sha: SHA,
    line: 3,
    lineEnd: 5,
  }

  test("each Copy's payload for repo/copy, from where the view is", () => {
    expect(copyPayloadOf(view, "clone-url")).toEqual({ repo: "octocat/Spoon-Knife", what: "clone-url" })
    expect(copyPayloadOf(view, "path")).toEqual({ repo: "octocat/Spoon-Knife", what: "path", path: "src/a.ts" })
    expect(copyPayloadOf(view, "contents")).toEqual({
      repo: "octocat/Spoon-Knife",
      what: "contents",
      revision: SHA,
      path: "src/a.ts",
    })
    expect(copyPayloadOf(view, "permalink")).toEqual({
      repo: "octocat/Spoon-Knife",
      what: "permalink",
      revision: SHA,
      kind: "blob",
      path: "src/a.ts",
      line: 3,
      lineEnd: 5,
    })
    expect(copyPayloadOf({ ...view, kind: "tree", path: "", line: null, lineEnd: null }, "permalink")).toEqual({
      repo: "octocat/Spoon-Knife",
      what: "permalink",
      revision: SHA,
      kind: "tree",
    })
    expect(copyPayloadOf({ ...view, kind: "tree", path: "src" }, "permalink")).not.toHaveProperty("line")
    expect(copyPayloadOf({ ...view, lineEnd: null }, "permalink")).not.toHaveProperty("lineEnd")
  })

  test("nothing to copy: the root's path, a directory's contents, or anything at no commit yet", () => {
    expect(copyPayloadOf({ ...view, kind: "tree", path: "" }, "path")).toBeUndefined()
    expect(copyPayloadOf({ ...view, kind: "tree", path: "src" }, "contents")).toBeUndefined()
    expect(copyPayloadOf({ ...view, path: "" }, "contents")).toBeUndefined()
    expect(copyPayloadOf({ ...view, sha: null }, "permalink")).toBeUndefined()
    expect(copyPayloadOf({ ...view, sha: null }, "contents")).toBeUndefined()
  })
})


describe("editHrefFor", () => {
  test("opens root and nested files with a quoted search path, preserving numeric names and URL punctuation", () => {
    expect(editHrefFor(repo, "main", "123")).toBe('/octocat/Spoon-Knife/tree/main?edit=%22123%22')
    expect(editHrefFor({ owner: "a b", name: "c#d" }, "feature/docs", "docs/a b#.md")).toBe(
      '/a%20b/c%23d/tree/feature/docs/docs?edit=%22docs%2Fa%20b%23.md%22',
    )
  })
})


describe("Markdown edited in place", () => {
  test("Markdown is .md or .markdown in any case; anything else, MDX included, is not", () => {
    expect(["README.md", "docs/Guide.MD", "notes.markdown"].map(isMarkdownPath)).toEqual([true, true, true])
    expect(["page.mdx", "md", "README.md.txt", "src/app.ts", ""].map(isMarkdownPath)).toEqual([false, false, false, false, false])
  })

  test("a workspace that edits files opens a file's live editor, but a Markdown file's own page; without it, every page", () => {
    const at = { ...repo, defaultBranch: "main" }
    expect(viewHrefFor(at, "feature", { kind: "blob", path: "src/app.ts" }, true))
      .toBe('/octocat/Spoon-Knife/tree/feature/src?edit=%22src%2Fapp.ts%22')
    expect(viewHrefFor(at, "feature", { kind: "blob", path: "docs/guide.md" }, true))
      .toBe("/octocat/Spoon-Knife/blob/feature/docs/guide.md")
    expect(viewHrefFor(at, "feature", { kind: "tree", path: "docs" }, true)).toBe("/octocat/Spoon-Knife/tree/feature/docs")
    expect(viewHrefFor(at, "feature", { kind: "blob", path: "src/app.ts", line: 3 }, false))
      .toBe("/octocat/Spoon-Knife/blob/feature/src/app.ts?L=3")
  })
})

 test("GitHub fragments select a line or range and reject unrelated anchors", () => {
  expect(parseLineHash("L72")).toEqual({ line: 72, lineEnd: null })
  expect(parseLineHash("#L5-L12")).toEqual({ line: 5, lineEnd: 12 })
  expect(parseLineHash("L12-L5")).toEqual({ line: 12, lineEnd: null })
  for (const hash of ["", "overview", "L0", "L1-12", "L1-L0", "L1000000000"]) {
    expect(parseLineHash(hash)).toEqual({ line: null, lineEnd: null })
  }
})


test("canonical repository URLs preserve route, search and fragment with GitHub's casing", () => {
  const params = { owner: "SmithersAI", repo: "SMITHERS" }
  const location = { pathname: "/SmithersAI/SMITHERS/issues/12", searchStr: "?a=1", hash: "L3" }
  expect(canonicalRepoHref(location, params, "smithersai/smithers")).toBe("/smithersai/smithers/issues/12?a=1#L3")
  expect(canonicalRepoHref(location, params, undefined)).toBeUndefined()
  expect(canonicalRepoHref(location, params, "invalid")).toBeUndefined()
  expect(canonicalRepoHref({ ...location, hash: "#L3" }, params, "smithersai/smithers")).toBe("/smithersai/smithers/issues/12?a=1#L3")
  expect(canonicalRepoHref({ pathname: "/o/r/tree/main/a%20b.ts", searchStr: "", hash: "" }, { owner: "o", repo: "r" }, "o/r", true)).toBe("/o/r/blob/main/a%20b.ts")
  expect(canonicalRepoHref({ pathname: "/o/r/issues", searchStr: "", hash: "" }, { owner: "o", repo: "r" }, "o/r", true)).toBeUndefined()
})
