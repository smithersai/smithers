/**
 * A line-anchored edit keeps the line endings of the lines it replaces.
 *
 * A line range ends before its last line's `\n`, so it takes that line's `\r`
 * with it; a replacement written with bare `\n` left an LF-only line in a CRLF
 * file. `apply_patch` has always kept the endings.
 */
import { Effect, FileSystem } from "effect"
import { describe, expect, it } from "vitest"
import * as Edit from "../src/Edit.ts"
import { layer } from "./TestLayers.ts"

const edit = (content: string, input: Omit<Parameters<typeof Edit.run>[0], "path">) =>
  Effect.runPromise(Effect.provide(
    Effect.gen(function*() {
      const result = yield* Edit.run({ path: "/f.txt", ...input })
      const fileSystem = yield* FileSystem.FileSystem
      return { result, content: yield* fileSystem.readFileString("/f.txt") }
    }),
    layer({ files: { "/f.txt": content } })
  ))

describe("a line-anchored edit of CRLF lines", () => {
  it("gives a replacement written without \\r the ending of the line it replaces", async () => {
    const { content, result } = await edit("one\r\ntwo\r\nthree\r\n", { startLine: 2, endLine: 2, newString: "TWO" })
    expect(content).toBe("one\r\nTWO\r\nthree\r\n")
    expect(result).toMatchObject({ replacements: 1, startLine: 1, endLine: 3 })
    expect(result.hunk).toContain("TWO\r")
  })

  it("gives every line of a multi-line replacement the CRLF ending", async () => {
    const { content } = await edit("one\r\ntwo\r\nthree\r\nfour\r\n", {
      startLine: 2,
      endLine: 3,
      newString: "TWO\nTHREE\nextra"
    })
    expect(content).toBe("one\r\nTWO\r\nTHREE\r\nextra\r\nfour\r\n")
  })

  it("leaves a replacement that already carries its \\r bytes as it is", async () => {
    const { content } = await edit("one\r\ntwo\r\nthree\r\n", {
      startLine: 1,
      endLine: 2,
      newString: "ONE\r\nTWO\r"
    })
    expect(content).toBe("ONE\r\nTWO\r\nthree\r\n")
  })

  it("accepts the raw page as expect and still keeps the endings", async () => {
    const { content } = await edit("one\r\ntwo\r\nthree\r\n", {
      startLine: 2,
      endLine: 3,
      expect: "two\r\nthree\r",
      newString: "2\n3"
    })
    expect(content).toBe("one\r\n2\r\n3\r\n")
  })

  it("keeps the last line's ending when the file has no final newline", async () => {
    const { content } = await edit("one\r\ntwo\r", { startLine: 2, endLine: 2, newString: "TWO" })
    expect(content).toBe("one\r\nTWO\r")
  })

  it("adds no \\r to an LF file, or to a range whose lines do not all end in \\r", async () => {
    expect((await edit("one\ntwo\nthree\n", { startLine: 2, endLine: 2, newString: "TWO" })).content).toBe(
      "one\nTWO\nthree\n"
    )
    expect((await edit("one\r\ntwo\nthree\r\n", { startLine: 1, endLine: 2, newString: "A\nB" })).content).toBe(
      "A\nB\nthree\r\n"
    )
  })
})
