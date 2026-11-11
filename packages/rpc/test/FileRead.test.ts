import { describe, expect, test } from "vitest"
import {
  CARD_CONTENT_CAP,
  decodeFilePage,
  fileArgs,
  fileReadCard,
  FILES_READ_COMMAND,
  fileValue,
  parseFileArgs,
  parseFileReadArgs
} from "../src/FileRead.ts"

describe("the file flow every host binds", () => {
  test("distinct repository, path and revision tuples have distinct stable card IDs", () => {
    const reads = [
      { repo: "acme/app", path: "a@v1" },
      { repo: "acme/app", path: "a", ref: "v1" },
      { repo: "acme/app", path: "a@b", ref: "c" },
      { repo: "acme/app", path: "a", ref: "b@c" },
      { repo: "acme/app", path: "a" },
      { repo: "acme/app", path: "a", ref: "" },
      { repo: "acme/app-a", path: "b" },
      { repo: "acme/app", path: "a-b" },
      { repo: "acme/app%2Da", path: "b" },
      { repo: "acme/app", path: "a%40v1" },
      { repo: "acme/app", path: "a%25" },
      { repo: "acme/app", path: "a%" }
    ]
    const ids = reads.map((read) => fileReadCard({ ...read, content: "", binary: false }, 0, 0).card.id)
    // Escape only identity delimiters: ordinary host IDs stay stable; ambiguous names need escapes.
    expect(ids.slice(0, 4)).toEqual([
      "file-acme/app-a%40v1",
      "file-acme/app-a@v1",
      "file-acme/app-a%40b@c",
      "file-acme/app-a@b@c"
    ])
    expect(new Set(ids).size).toBe(reads.length)
    for (const [index, read] of reads.entries()) {
      expect(fileReadCard({ ...read, content: "edited", binary: false, line: 2 }, 1, 1).card.id).toBe(ids[index])
    }
  })

  test("is named and described once", () => {
    expect(FILES_READ_COMMAND).toEqual({
      name: "file",
      summary: "Open and co-edit a file",
      args: "<path>[:<line>[:<col>]] [owner/repo] [--ref <revision>]",
      agent: "run"
    })
    expect(CARD_CONTENT_CAP).toBe(16_384)
  })

  test("file tokens round-trip spaces, quotes, backslashes and Unicode", () => {
    for (
      const path of [
        "docs/Meeting Notes.md",
        "docs/a \"quote\".md",
        "docs/it's here.md",
        "docs/a\\b.md",
        "docs/你好 world.md",
        "docs/line\nbreak.md",
        ""
      ]
    ) {
      expect(parseFileArgs(fileArgs(path, "repo-2"))).toEqual({ tokens: [path, "repo-2"] })
    }
    expect(fileArgs("plain", undefined, "x y")).toBe("plain \"x y\"")
    expect(parseFileArgs("'docs/Meeting Notes.md' repo-2")).toEqual({ tokens: ["docs/Meeting Notes.md", "repo-2"] })
    expect(parseFileArgs("docs/a\\b.md   repo-2  ")).toEqual({ tokens: ["docs/a\\b.md", "repo-2"] })
    expect(parseFileArgs(undefined)).toEqual({ tokens: [] })
    expect(parseFileArgs("\"unfinished")).toEqual({ error: "Close the quoted file argument before the next argument." })
    expect(parseFileArgs("\"closed\"extra")).toEqual({
      error: "Close the quoted file argument before the next argument."
    })
    expect(parseFileArgs("\"bad \\q escape\"")).toEqual({
      error: "The quoted file argument contains an invalid escape."
    })
  })

  test("the grammar reads a path, its line anchor, a repository and a revision", () => {
    expect(parseFileReadArgs("src/answer.ts:2:5 org/repo --ref abc")).toEqual({
      payload: { path: "src/answer.ts", line: 2, column: 5, ref: "abc", repo: "org/repo" }
    })
    expect(parseFileReadArgs("\"docs/Meeting Notes.md\"")).toEqual({ payload: { path: "docs/Meeting Notes.md" } })
    expect(parseFileReadArgs("a:b:3")).toEqual({ payload: { path: "a:b", line: 3 } })
    for (
      const [args, error] of [
        [undefined, "file needs a file path"],
        [":3", "file needs a file path"],
        ["a b c", "file takes a path and optionally an owner/repo"],
        ["a --ref", "file --ref needs a revision"],
        ["a --ref x b", "file --ref needs a revision"],
        ["a:0", "file lines and columns count from 1: /file <path>[:<line>[:<col>]]"],
        ["a:1:0", "file lines and columns count from 1: /file <path>[:<line>[:<col>]]"],
        ["\"open", "Close the quoted file argument before the next argument."]
      ] as const
    ) {
      expect(parseFileReadArgs(args)).toEqual({ error })
    }
  })

  test("the model reads the card's text, its truncation and binary stated", () => {
    expect(fileValue("acme/app", "JOURNEY.md", { content: "Add a greeting\n", truncated: false }))
      .toBe("JOURNEY.md in acme/app:\nAdd a greeting\n")
    expect(fileValue("acme/app", "big.ts", { content: "head", truncated: true }))
      .toBe("big.ts in acme/app (truncated at the card cap; the rest stays in the repository):\nhead")
    expect(fileValue("acme/app", "logo.png", { content: "", truncated: false, binary: true }))
      .toBe("logo.png in acme/app is a binary file; its bytes are not shown.")
  })

  test("a read's File card: addressed, cut at the cap, binary stated without an anchor", () => {
    const readAt = { changeId: null, commitId: "c".repeat(40), source: "head" as const }
    expect(
      fileReadCard({ repo: "acme/app", path: "JOURNEY.md", content: "hi\n", binary: false, readAt, line: 1 }, 3, 7)
    )
      .toEqual({
        card: {
          id: "file-acme/app-JOURNEY.md",
          kind: "file",
          title: "File · acme/app · JOURNEY.md",
          status: "active",
          createdAt: 7,
          ordinal: 3,
          payload: {
            repo: "acme/app",
            path: "JOURNEY.md",
            content: "hi\n",
            truncated: false,
            address: "/acme/app/JOURNEY.md",
            readAt,
            line: 1
          }
        },
        value: "JOURNEY.md in acme/app:\nhi\n"
      })
    const long = fileReadCard(
      {
        repo: "acme/app",
        path: "big.txt",
        content: "x".repeat(CARD_CONTENT_CAP + 1),
        binary: false,
        ref: "v1",
        line: 2,
        column: 4
      },
      0,
      0
    )
    expect(long.card.id).toBe("file-acme/app-big.txt@v1")
    expect(long.card.payload).toEqual({
      repo: "acme/app",
      path: "big.txt",
      content: "x".repeat(CARD_CONTENT_CAP),
      truncated: true,
      address: "/acme/app/big.txt",
      ref: "v1",
      line: 2,
      column: 4
    })
    expect(
      long.value.startsWith("big.txt in acme/app (truncated at the card cap; the rest stays in the repository):\nxxx")
    ).toBe(true)
    const binary = fileReadCard({ repo: "acme/app", path: "logo.png", content: "ignored", binary: true, line: 9 }, 0, 0)
    expect(binary.card.payload).toEqual({
      repo: "acme/app",
      path: "logo.png",
      content: "",
      truncated: false,
      binary: true,
      address: "/acme/app/logo.png"
    })
    expect(binary.value).toBe("logo.png in acme/app is a binary file; its bytes are not shown.")
  })
})

describe("decodeFilePage", () => {
  const wire = {
    type: "file",
    content: "plain text",
    size: 10,
    encoding: "utf8",
    commit_sha: "a".repeat(40),
    raw_url: "/api/repos/a/b/contents/x?raw=1"
  }

  test("text sent as UTF-8 is kept as it came", () => {
    expect(decodeFilePage(wire)).toEqual({
      content: "plain text",
      binary: false,
      size: 10,
      commitSha: "a".repeat(40),
      rawUrl: "/api/repos/a/b/contents/x?raw=1",
      tooLarge: false
    })
  })

  test.each(["utf8", "utf-8"])("UTF-8 text (%s) carrying a NUL is binary and its bytes stay opaque", (encoding) => {
    expect(decodeFilePage({ ...wire, encoding, content: "head\u0000tail" })).toMatchObject({
      content: null,
      binary: true,
      tooLarge: false
    })
  })
})
