import { ApplyPatch } from "@smthrs/std"
import { parsePatch, seekSequence, StreamingPatchParser } from "../packages/smithers/agent/std/src/internal/ApplyPatch.ts"
import { it } from "@smthrs/testing/Vitest"
import { Schema } from "effect"
import { describe, expect } from "vitest"

const SafeLine = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_ .:=+-]{0,24}$/))
const SafePath = Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,8}\/[a-z0-9]{1,8}\.ts$/))

describe("@smthrs/std ApplyPatch & Match fuzz", () => {
  it.fuzz(
    "ApplyPatch.paths and parsePatch never throw unhandled non-ParseError exceptions on arbitrary text",
    [Schema.String],
    ([raw]) => {
      const paths = ApplyPatch.paths(raw)
      if (paths !== undefined) {
        expect(Array.isArray(paths)).toBe(true)
      }
      try {
        const parsed = parsePatch(raw)
        expect(Array.isArray(parsed.hunks)).toBe(true)
      } catch (err: any) {
        expect(err?._tag).toBe("@smthrs/std/ParseError")
      }
      return true
    }
  )

  it.fuzz(
    "StreamingPatchParser fed at any arbitrary chunk boundary matches single-shot parsePatch exactly",
    [
      SafePath,
      SafeLine,
      SafeLine,
      SafeLine,
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 19 }))
    ],
    ([filePath, ctxLine, oldLine, newLine, chunkSize]) => {
      const patch = [
        "*** Begin Patch",
        `*** Update File: ${filePath}`,
        "@@",
        ` ${ctxLine}`,
        `-${oldLine}`,
        `+${newLine}`,
        "*** End Patch"
      ].join("\n")

      const single = parsePatch(patch)
      expect(ApplyPatch.paths(patch)).toEqual([filePath])

      const parser = new StreamingPatchParser()
      for (let i = 0; i < patch.length; i += chunkSize) {
        parser.pushDelta(patch.slice(i, i + chunkSize))
      }
      const hunks = parser.finish()
      expect(hunks).toEqual(single.hunks)
      return true
    }
  )

  it.fuzz(
    "seekSequence locates any exact contiguous slice of lines without throwing",
    [
      Schema.Array(SafeLine).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 })),
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 }))
    ],
    ([lines, rawStart, rawLen]) => {
      const start = rawStart % lines.length
      const end = Math.min(lines.length, start + rawLen)
      const needle = lines.slice(start, end)
      const found = seekSequence(lines, needle, 0, false)
      expect(found).not.toBeUndefined()
      if (found !== undefined) {
        expect(found).toBeLessThanOrEqual(start)
        expect(lines.slice(found, found + needle.length)).toEqual(needle)
      }
      return true
    }
  )
})
