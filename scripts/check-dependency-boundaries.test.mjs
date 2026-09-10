import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { blankLiteralRanges } from "./check-dependency-boundaries.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * The blanking the gate shipped before the single pass: rebuild the whole
 * string once per literal. Kept here as the reference the linear pass must
 * match byte for byte.
 * @param {string} text @param {[number, number][]} ranges
 */
const blankByReduce = (text, ranges) =>
  ranges.reduce((acc, [start, end]) => acc.slice(0, start) + " ".repeat(end - start) + acc.slice(end), text)

/** @param {string} name @param {string} text */
const literalRangesOf = (name, text) => {
  const kind = name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind)
  /** @type {[number, number][]} */
  const ranges = []
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteral(node)) ranges.push([node.getStart(sourceFile), node.getEnd()])
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return ranges
}

test("single-pass blanking matches the reduce on nested template and string literals", () => {
  const text = [
    'import a from "a"',
    'const s = "import(\\"needle\\")"',
    "const t = `outer ${\"inner\"} ${`deep ${'deeper'}`} tail`",
    'const u = import("real")',
    "const v = `${x}${y}`",
    'const w = ""',
  ].join("\n")
  const ranges = literalRangesOf("fixture.ts", text)
  assert.ok(ranges.some(([start], index) => index > 0 && start < ranges[index - 1][1]), "fixture nests literals")
  const blanked = blankLiteralRanges(text, ranges)
  assert.equal(blanked, blankByReduce(text, ranges))
  assert.equal(blanked.length, text.length)
  assert.doesNotMatch(blanked, /needle|inner|deeper/)
  assert.match(blanked, /import\(\s{6}\)/)
})

test("single-pass blanking matches the reduce on a real source with many literals", () => {
  const file = "scripts/check-dependency-boundaries.mjs"
  const text = readFileSync(join(repoRoot, file), "utf8")
  const ranges = literalRangesOf(file, text)
  assert.ok(ranges.length > 50, `${file} has ${ranges.length} literals`)
  assert.equal(blankLiteralRanges(text, ranges), blankByReduce(text, ranges))
})

test("single-pass blanking matches the reduce on unsorted and overlapping ranges", () => {
  const text = "abcdefghijklmnopqrstuvwxyz0123456789"
  /** @type {[number, number][][]} */
  const cases = [
    [[10, 14], [2, 5]],
    [[3, 9], [6, 12]],
    [[4, 20], [6, 8], [18, 25]],
    [[7, 7], [0, 0], [35, 36]],
    [[5, 9], [5, 9], [5, 30]],
  ]
  for (const ranges of cases) {
    assert.equal(blankLiteralRanges(text, ranges), blankByReduce(text, ranges), JSON.stringify(ranges))
  }
})

test("blanking a source with tens of thousands of literals stays linear in the file size", () => {
  // 40,000 literals in ~0.9 MB. The reduce copied the whole text per literal
  // (tens of GB here, seconds of CPU); one pass takes milliseconds. The bound
  // is on CPU time, not wall clock, so a loaded machine that deschedules this
  // process cannot red it.
  const line = 'export const k = ["import(\\"x\\")", `t ${"n"}`, "padding padding padding padding padding"]\n'
  const text = line.repeat(10_000)
  const ranges = literalRangesOf("big.ts", text)
  assert.ok(ranges.length >= 40_000, `${ranges.length} literals`)
  const started = process.cpuUsage()
  const blanked = blankLiteralRanges(text, ranges)
  const { user, system } = process.cpuUsage(started)
  const cpuMs = (user + system) / 1_000
  assert.equal(blanked.length, text.length)
  assert.doesNotMatch(blanked, /padding/)
  assert.ok(cpuMs < 1_000, `blanking took ${cpuMs.toFixed(1)} ms of CPU`)
})
