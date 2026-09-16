import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { makeDigestPartsSync } from "../src/Sha256.ts"

test("cached prefixes preserve SHA-256 across padding, Unicode, edits and truncation", () => {
  const hash = makeDigestPartsSync()
  for (let length = 0; length < 140; length++) {
    for (const parts of [["a".repeat(length), "🙂", "tail"], ["a".repeat(length), "🙂", "changed"], ["a".repeat(length)], [], ["different", "prefix"]]) {
      expect(hash(parts)).toBe(createHash("sha256").update(parts.join("")).digest("hex"))
    }
  }
})
