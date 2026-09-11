/**
 * Every bundled provider creates a file's parent before writing it, and every
 * one of them asks `parentOf` which parent that is. These cases pin the rule
 * once: a path directly under the root, like one with no separator, has no
 * parent to create.
 */
import { describe, expect, it } from "vitest"
import { parentOf } from "../src/internal/guestPath.ts"

describe("parentOf", () => {
  it("names the directory above a nested path and nothing for a root child or bare name", () => {
    expect(["/work/sub/file", "/work/file", "rel/file", "/leaf", "leaf", ""].map(parentOf)).toEqual([
      "/work/sub",
      "/work",
      "rel",
      undefined,
      undefined,
      undefined
    ])
  })
})
