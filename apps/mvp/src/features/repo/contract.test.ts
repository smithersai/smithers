// The repository contract's pure helpers (src/features/repo/contract.ts): names, paths, routes and the text check
// RepoApi and the browser share.
import { describe, expect, test } from "vitest"
import {
  blobRoute,
  cloneExecutionId,
  cloneUrl,
  clipboardChannel,
  githubRawUrl,
  formatBytes,
  rawRoute,
  refsRoute,
  isFilePath,
  isRepository,
  MAX_PATH_LENGTH,
  NOT_CLONED,
  repoId,
  textOf,
  treeRoute,
} from "./contract"

describe("the repository contract", () => {
  test("a repository is a GitHub owner and name, outside the app's own first segments", () => {
    expect(isRepository("octocat", "Spoon-Knife")).toBe(true)
    expect(isRepository("smithersai", "repo.view_fixture-2")).toBe(true)
    for (const [owner, name] of [["-octocat", "x"], ["octocat", "."], ["octocat", ".."], ["octocat", "a/b"], ["App", "x"], ["api", "x"], ["assets", "x"], ["a".repeat(40), "x"], ["octocat", "x".repeat(101)]]) {
      expect(isRepository(owner!, name!)).toBe(false)
    }
    expect(repoId("OctoCat", "Spoon-Knife")).toBe("github/octocat/spoon-knife")
    const cloneId = "0b6c1d2e-3f40-4a51-8b62-7c83d94ea5f6"
    expect(cloneExecutionId("github/a/b", cloneId)).toBe(`repo-clone:github/a/b:${cloneId}`)
  })

  test("a file path is relative and bounded, with no empty or dot segments", () => {
    expect(isFilePath("docs/guide.md")).toBe(true)
    for (const path of ["", "/a", "a/", "a//b", "./a", "a/../b", "x".repeat(MAX_PATH_LENGTH + 1), "a/".repeat(64) + "b"]) {
      expect(isFilePath(path)).toBe(false)
    }
  })

  test("routes encode each part, keeping a path's slashes", () => {
    expect(treeRoute("o", "n", "a".repeat(40))).toBe(`/api/repos/o/n/tree/${"a".repeat(40)}`)
    expect(blobRoute("o", "n.x", "b".repeat(40), "docs/a b#.md")).toBe(`/api/repos/o/n.x/blob/${"b".repeat(40)}/docs/a%20b%23.md`)
    expect(rawRoute("o", "n.x", "b".repeat(40), "docs/a b#.md")).toBe(`/api/repos/o/n.x/raw/${"b".repeat(40)}/docs/a%20b%23.md`)
    expect(refsRoute("o", "n.x")).toBe("/api/repos/o/n.x/refs")
  })

  test("a clone's URL and a large file's raw bytes are GitHub's", () => {
    expect(cloneUrl("octocat", "Spoon-Knife")).toBe("https://github.com/octocat/Spoon-Knife.git")
    expect(githubRawUrl("octocat", "Spoon-Knife", "c".repeat(40), "big file.txt")).toBe(
      `https://github.com/octocat/Spoon-Knife/raw/${"c".repeat(40)}/big%20file.txt`,
    )
  })

  test("text is UTF-8 with no NUL in its first 8 KiB; anything else is binary", () => {
    expect(textOf(new TextEncoder().encode("héllo"))).toBe("héllo")
    expect(textOf(new Uint8Array([0x68, 0x00, 0x69]))).toBeUndefined()
    expect(textOf(new Uint8Array([0xff, 0xfe, 0x41]))).toBeUndefined()
    const lateNul = new Uint8Array(9 * 1024).fill(0x61)
    lateNul[9 * 1024 - 1] = 0
    expect(textOf(lateNul)).toBe(new TextDecoder().decode(lateNul))
  })
})

describe("the clone's feed row and what GitHub says", () => {
  test("a clone's ref carries its stage, with the size once known; its detail says it in words", async () => {
    const { cloneDetail, cloneRef, cloneSubject } = await import("./contract")
    expect(cloneSubject("github/a/b")).toBe("clone:github/a/b")
    expect(cloneRef("requested", 10)).toBe("requested")
    expect(cloneRef("fetching")).toBe("fetching")
    expect(cloneRef("fetching", 2048)).toBe("fetching:2048")
    expect(cloneRef("indexing", 0)).toBe("indexing:0")
    expect(cloneDetail("requested")).toBe("Requested")
    expect(cloneDetail("fetching:2048")).toBe("Fetching 2.0 KB")
    expect(cloneDetail("fetching:abc")).toBe("Fetching")
    expect(cloneDetail("indexing:-1")).toBe("Indexing")
    expect(cloneDetail("failed:empty")).toBe("Empty repository")
    expect(cloneDetail("failed:whatever")).toBe("Couldn't clone")
    expect(cloneDetail("capacity:too_large")).toBe("Too large to import")
    expect(cloneDetail("capacity:size_unknown")).toBe("Can't check its size")
    expect(cloneDetail("capacity:whatever")).toBe("Imports paused")
    expect(cloneDetail("ready")).toBeNull()
    expect(cloneDetail(null)).toBeNull()
  })

  test("the about route and the App's installation path", async () => {
    const { aboutRoute, installUrl } = await import("./contract")
    expect(aboutRoute("octo cat", "a/b")).toBe("/api/repos/octo%20cat/a%2Fb/about")
    expect(installUrl("smithers")).toBe("https://github.com/apps/smithers/installations/new")
  })
})

test("uncloned code explains what Clone unlocks", () => {
  expect(NOT_CLONED).toBe("Clone to browse files")
})

test("clone sizes retain bytes below a kilobyte and stop at terabytes", () => {
  expect(formatBytes(0)).toBe("0 B")
  expect(formatBytes(512)).toBe("512 B")
  expect(formatBytes(1024)).toBe("1.0 KB")
  expect(formatBytes(1024 ** 5)).toBe("1024.0 TB")
})

test("copy requests stay on the requesting engine channel", () => {
  expect(clipboardChannel("tab-a")).toBe("tab-a/clipboard")
  expect(clipboardChannel("tab-b")).not.toBe(clipboardChannel("tab-a"))
})
