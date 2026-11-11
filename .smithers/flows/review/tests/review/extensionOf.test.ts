import { describe, expect, test } from "bun:test"
import { posix } from "node:path"
import { whyExcluded } from "../../src/review/whyExcluded.ts"
import { diffRecordFixture } from "../support/diffRecordFixture.ts"

/** Names whose extension decides the reason, with what POSIX `extname` reads in each. */
const CASES = [
  { name: "a.ts", extname: ".ts", reason: "" },
  { name: "A.TS", extname: ".TS", reason: "" },
  { name: "Makefile", extname: "", reason: "" },
  { name: ".bashrc", extname: "", reason: "" },
  { name: "..", extname: "", reason: "" },
  { name: "...", extname: ".", reason: "unsupported_ext" },
  { name: "a.", extname: ".", reason: "unsupported_ext" },
  { name: "..ts", extname: ".ts", reason: "" },
  { name: ".icon.png", extname: ".png", reason: "unsupported_ext" },
  { name: "a.b.png", extname: ".png", reason: "unsupported_ext" }
]

describe("the file filter's extension", () => {
  test("reads each name as POSIX extname does, without a platform path module", () => {
    for (const { extname, name, reason } of CASES) {
      expect(posix.extname(name)).toBe(extname)
      const path = `src/${name}`
      expect([name, whyExcluded(diffRecordFixture({ oldPath: path, newPath: path }), null)]).toEqual([name, reason])
    }
  })
})
