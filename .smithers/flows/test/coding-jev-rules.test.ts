import assert from "node:assert/strict"
import { test } from "node:test"
import { batches, hunks, MAX_STATES, type RuleComparison } from "../coding/jev-rules.ts"

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
