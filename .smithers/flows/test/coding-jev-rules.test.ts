import assert from "node:assert/strict"
import { test } from "node:test"
import { clip } from "../coding/clip.ts"
import { batches, bounded, hunks, MAX_HUNK_BYTES, MAX_STATES, type RuleComparison } from "../coding/jev-rules.ts"

const lines = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => `const ${prefix}${index + 1} = ${index + 1}`).join("\n") + "\n"
const sourceA = lines(30, "a"), sourceB = lines(12, "b")

/** Two files, three hunks: one at the top of a.ts, one deeper in a.ts, one in b.ts. */
const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a1 = 1
+const added = 2
 const a2 = 2
 const a3 = 3
 const a4 = 4
@@ -20,3 +21,4 @@ context
 const a20 = 20
 const a21 = 21
+const twelfth = 12
 const a22 = 22
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -7,2 +7,3 @@
 const b7 = 7
+const beta = 2
 const b8 = 8
`

const comparison: RuleComparison = {
  diff,
  paths: ["src/a.ts", "src/b.ts"],
  files: [{ path: "src/a.ts", text: sourceA }, { path: "src/b.ts", text: sourceB }],
  changes: [{ path: "src/a.ts", before: "old", after: sourceA }, { path: "src/b.ts", before: "old", after: sourceB }]
}

test("hunk extraction reports every changed hunk and its first candidate line", () => {
  assert.deepEqual(hunks(comparison).map((hunk) => ({ path: hunk.path, line: hunk.line })), [
    { path: "src/a.ts", line: 2 },
    { path: "src/a.ts", line: 23 },
    { path: "src/b.ts", line: 8 }
  ])
  const [first, second, third] = hunks(comparison)
  assert.ok(first!.hunk.startsWith("@@ -1,4 +1,5 @@") && first!.hunk.includes("+const added = 2"))
  assert.ok(!first!.hunk.includes("twelfth"), "a hunk carries its own lines, not the next hunk's")
  assert.ok(second!.hunk.includes("+const twelfth = 12"))
  assert.ok(third!.hunk.startsWith("@@ -7,2 +7,3 @@") && !third!.hunk.includes("diff --git"))
  assert.deepEqual(hunks({ ...comparison, diff: "" }), [], "no diff is no hunk, never a silent clean sweep")
})

test("a batch carries at most 64 states and keeps every one", () => {
  const seventy = Array.from({ length: 70 }, (_, index) => index)
  assert.equal(MAX_STATES, 64)
  assert.deepEqual(batches(seventy).map((batch) => batch.length), [64, 6])
  assert.deepEqual(batches(seventy).flat(), seventy)
  assert.deepEqual(batches([]), [])
})

test("byte clipping never splits an astral character at the boundary", () => {
  assert.equal(clip("😀", 3), "")
  assert.equal(clip("a😀", 4), "a")
  assert.equal(clip("a😀", 5), "a😀")
  assert.equal(clip("😀x", 4), "😀")
  assert.equal(clip("ab😀z", 5), "ab")
  assert.equal(clip("ab😀z", 6), "ab😀")
})

test("byte clipping keeps the longest whole-code-point prefix at every budget", () => {
  const encoder = new TextEncoder()
  const alphabet = [
    "",
    "a",
    "\u007f",
    "\u0080",
    "é",
    "\u07ff",
    "\u0800",
    "\ud7ff",
    "\ue000",
    "\uffff",
    "𐀀",
    "😀",
    "𠮷",
    "\u{10ffff}"
  ]
  for (const first of alphabet) {
    for (const second of alphabet) {
      const text = first + second + "z"
      for (let budget = -1; budget <= encoder.encode(text).length + 1; budget++) {
        let expected = "", remaining = budget
        for (const character of text) {
          const size = encoder.encode(character).length
          if (size > remaining) break
          expected += character
          remaining -= size
        }
        const actual = clip(text, budget)
        assert.equal(actual, expected, JSON.stringify({ text, budget }))
        assert.ok(actual.isWellFormed())
        assert.ok(encoder.encode(actual).length <= Math.max(0, budget))
      }
    }
  }
  assert.equal(clip("", 1), "")
})

test("bounded hunks retain whole Unicode characters and report a clipped change", () => {
  const prefix = "a".repeat(MAX_HUNK_BYTES - 3)
  const text = prefix + "😀"
  const clipped = bounded(text)
  assert.deepEqual(clipped, { hunk: prefix, complete: false })
  assert.ok(clipped.hunk.isWellFormed())
  assert.deepEqual(bounded(prefix + "é"), { hunk: prefix + "é", complete: true })
})
