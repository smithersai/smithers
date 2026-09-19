#!/usr/bin/env node
/**
 * check-release-evidence-tags.mjs
 *
 * Checks the evidence-tag guarantee that `docs/mvp/implementation/release-20260916.md`
 * states about its own release-state section, so the guarantee is re-runnable instead
 * of asserted.
 *
 * The section states one absolute property and one measured figure:
 *
 *   A. Every `[Dn]` entry inside the section's fenced evidence block holds at least one
 *      `$ ` command line and at least one line of that command's output.
 *   B. Every `` `[Dn]` `` reference in the section's prose names an entry the block defines.
 *   C. The entries are D1..Dn, in order, each declared once.
 *   D. (measured, not a pass/fail) How many number-bearing sentences in the prose after
 *      the block carry no `[Dn]` reference. That count is what the section's opening
 *      paragraph reports; the guarantee above does not reach those sentences.
 *   E. The entry titled "this section's own form" pastes exactly what a passing run of
 *      this script prints, so the document cannot carry a stale copy of its own check.
 *
 * A, B, C and E fail the run (exit 1). D is printed as a number and, with --list, as the
 * sentences themselves, so the section can state it and a reader can re-derive it.
 *
 * Usage: node scripts/check-release-evidence-tags.mjs [--list]
 *        node scripts/check-release-evidence-tags.mjs <file> [--list]
 *        node scripts/check-release-evidence-tags.mjs --refresh   (rewrite E's paste)
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"

const argv = process.argv.slice(2)
const list = argv.includes("--list")
const root = resolve(import.meta.dirname, "..")
const target = argv.find((a) => !a.startsWith("--"))
const path = target ?? join(root, "docs/mvp/implementation/release-20260916.md")

/** Reported repository-relative, so the output is the same from any checkout. */
const file = relative(root, resolve(path)).split(sep).join("/")

const lines = readFileSync(path, "utf8").split("\n")

/** The section runs from its own `## ` heading to the next `## ` heading. */
const start = lines.findIndex((l) => /^## Release state as of /.test(l))
if (start < 0) fail(`no "## Release state as of " heading in ${file}`)
const after = lines.findIndex((l, i) => i > start && /^## /.test(l))
const end = after < 0 ? lines.length : after
const section = lines.slice(start, end)

/** The fenced evidence block is the first ``` fence in the section. */
const fenceOpen = section.findIndex((l) => l.trim() === "```")
if (fenceOpen < 0) fail("the section has no fenced evidence block")
const fenceClose = section.findIndex((l, i) => i > fenceOpen && l.trim() === "```")
if (fenceClose < 0) fail("the section's fenced evidence block is never closed")
const block = section.slice(fenceOpen + 1, fenceClose)
const prose = section.map((l, i) => (i > fenceOpen && i < fenceClose ? "" : l))

const errors = []

/** A + C: the entries the block declares. */
const entries = []
for (const [i, line] of block.entries()) {
  const m = /^\[D(\d+)\]/.exec(line)
  if (m) entries.push({ n: Number(m[1]), tag: `[D${m[1]}]`, at: i })
}
if (entries.length === 0) fail("the fenced evidence block declares no [Dn] entry")

for (const [i, entry] of entries.entries()) {
  const body = block.slice(entry.at + 1, i + 1 < entries.length ? entries[i + 1].at : block.length)
  const cmd = body.findIndex((l) => l.startsWith("$ "))
  if (cmd < 0) errors.push(`${entry.tag} holds no "$ " command line`)
  else if (!body.slice(cmd + 1).some((l) => l.trim() !== "" && !l.startsWith("$ ")))
    errors.push(`${entry.tag}'s last command has no output line under it`)
}

const seen = new Set()
for (const [i, entry] of entries.entries()) {
  if (seen.has(entry.n)) errors.push(`${entry.tag} is declared more than once`)
  seen.add(entry.n)
  if (entry.n !== i + 1) errors.push(`${entry.tag} is declared where [D${i + 1}] was expected`)
}

/** B: every reference in the prose names an entry the block declares. */
let references = 0
let referencesAfter = 0
for (const [i, line] of prose.entries()) {
  for (const m of line.matchAll(/\[D(\d+)\]/g)) {
    references += 1
    if (i > fenceClose) referencesAfter += 1
    if (!seen.has(Number(m[1])))
      errors.push(`${file}:${start + i + 1} references [D${m[1]}], which the block does not declare`)
  }
}

/**
 * D: number-bearing sentences in the prose after the block that carry no reference.
 *
 * A sentence ends at `.`, `!` or `?` followed by whitespace and an opening character, or
 * at the end of a line; a table row's cells are sentences of their own. A sentence bears
 * a number when it contains a digit outside a backticked span — shas, line numbers and
 * file names inside backticks are citations, which `[D21]` covers, not figures.
 */
const tail = prose.slice(fenceClose + 1)
const untagged = []
for (const [i, line] of tail.entries()) {
  if (/^\s*\|\s*-+/.test(line)) continue
  const cells = /^\s*\|/.test(line) ? line.split("|").slice(1, -1) : [line]
  for (const cell of cells) {
    for (const sentence of cell.split(/(?<=[.!?])\s+(?=[A-Z`*"(\[])/)) {
      const text = sentence.trim()
      if (text === "" || /^#{1,6}\s/.test(text)) continue
      if (/\[D\d+\]/.test(text)) continue
      if (!/\d/.test(text.replace(/`[^`]*`/g, ""))) continue
      untagged.push({ line: start + fenceClose + i + 2, text })
    }
  }
}

const report = [
  `check-release-evidence-tags: ${file}`,
  `  section: lines ${start + 1}-${end}; evidence block: lines ${start + fenceOpen + 1}-${start + fenceClose + 1}`,
  `  A/C: ${entries.length} entries declared, [D1]..[D${entries.length}], each with a command and its output`,
  `  B: ${references} references in the prose (${referencesAfter} after the block), all declared`,
  `  D: ${untagged.length} number-bearing sentences after the block carry no [Dn] reference`,
  "check-release-evidence-tags: 0 violations"
]

/**
 * E: the entry that pastes this report must paste what this run prints, so the
 * document cannot keep a stale copy of its own form check. The expected body is a
 * passing run invoked with no argument; `refresh` rewrites it to that.
 */
const self = entries.find((e) => /^\[D\d+\] this section's own form\b/.test(block[e.at]))
if (self) {
  const at = fenceOpen + 1 + self.at
  let stop = at + 1
  while (stop < section.length && section[stop] !== "") stop += 1
  const body = ["$ node scripts/check-release-evidence-tags.mjs", ...report, "$ echo $?", "0"]
  const found = section.slice(at + 1, stop)
  if (found.join("\n") !== body.join("\n")) {
    if (argv.includes("--refresh")) {
      const out = [...lines.slice(0, start + at + 1), ...body, ...lines.slice(start + stop)]
      writeFileSync(path, out.join("\n"))
      console.log(`check-release-evidence-tags: refreshed ${self.tag}; run again to confirm it is stable`)
      process.exit(0)
    }
    errors.push(`${self.tag} pastes a report this run does not produce; re-run with --refresh`)
  }
}

for (const line of report.slice(0, -1)) console.log(line)
if (list) for (const u of untagged) console.log(`    ${file}:${u.line}: ${u.text}`)

if (errors.length > 0) {
  for (const e of errors) console.error(`  violation: ${e}`)
  console.error(`check-release-evidence-tags: ${errors.length} violation(s)`)
  process.exit(1)
}
console.log(report.at(-1))

function fail(message) {
  console.error(`check-release-evidence-tags: ${message}`)
  process.exit(1)
}
