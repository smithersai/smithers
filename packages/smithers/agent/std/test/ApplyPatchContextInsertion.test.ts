/**
 * A chunk that only adds lines goes where its `@@` line says. It used to find
 * the context, discard it, and append at the end of the file, and the tool
 * reported success with the line in the wrong place.
 */
import { describe, expect, it } from "vitest"
import { deriveNewContents, parsePatch } from "../src/internal/ApplyPatch.ts"

const updated = (original: string, body: string): string => {
  const hunk = parsePatch(`*** Begin Patch\n*** Update File: f.py\n${body}\n*** End Patch`).hunks[0]!
  if (hunk.kind !== "update") throw new Error("expected an update hunk")
  return deriveNewContents(original, "f.py", hunk.chunks)
}

describe("a pure-addition chunk", () => {
  it("inserts after its @@ context line", () => {
    expect(updated("a\ndef foo():\n    pass\nz\n", "@@ def foo():\n+    x = 1")).toBe(
      "a\ndef foo():\n    x = 1\n    pass\nz\n"
    )
  })

  it("inserts after the context on the last line of a file", () => {
    expect(updated("a\nlast\n", "@@ last\n+after")).toBe("a\nlast\nafter\n")
  })

  it("places each of two contextual additions at its own context, in order", () => {
    expect(updated("one\ntwo\nthree\n", "@@ one\n+1.5\n@@ two\n+2.5")).toBe("one\n1.5\ntwo\n2.5\nthree\n")
  })

  it("keeps a CRLF file's endings on the inserted line", () => {
    expect(updated("a\r\nb\r\n", "@@ a\n+mid")).toBe("a\r\nmid\r\nb\r\n")
  })

  it("still appends at the end of the file when it has no context", () => {
    expect(updated("a\nb\n", "@@\n+tail")).toBe("a\nb\ntail\n")
  })
})
