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
 *   A. Every command in every `[Dn]` entry of the section's fenced evidence block is
 *      written out in full — no `…`, `...` or `<placeholder>` standing in for a command
 *      or an argument — and carries, under it, either the output it returned or the
 *      marker `(no output)` for a command that returned nothing. Every command, not the
 *      first: an entry whose last command pastes nothing is the drift this rule exists
 *      to catch. An output line that carries a `…` is elided, not pasted, and fails too.
 *      The `(no output)` markers are counted in the report, so the one class
 *      of entry that cannot paste output cannot pass unseen. A line beginning `#` is the
 *      section's own note about a command; it is counted as a note and never as output,
 *      so prose cannot stand in for a result.
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
 * What this script cannot decide: whether a pasted output is the one that command really
 * returned. It checks that a command is runnable as written and that its output is there;
 * a reader who doubts a figure re-runs the line above it. Every count in the report below
 * is derived from the findings, so a failing run never prints a summary that contradicts
 * the violations under it.
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

/** Document line number, 1-based, of `block[i]`. */
const at = (i) => start + fenceOpen + i + 2

const errors = []

/** The marker a command that returned nothing carries in place of output. */
const NO_OUTPUT = "(no output)"

/** A `#` line inside the block is this section's own note about a command, not its output. */
const NOTE = /^\s*#/

/** A `…`, a bare `...`, or an `<angle-bracket>` metavariable: the command is not runnable. */
const PLACEHOLDER = /…|(?:^|\s)\.\.\.(?:\s|$)|<[A-Za-z][A-Za-z0-9_-]*>/

/** A + C: the entries the block declares. */
const entries = []
for (const [i, line] of block.entries()) {
  const m = /^\[D(\d+)\]/.exec(line)
  if (m) entries.push({ n: Number(m[1]), tag: `[D${m[1]}]`, at: i })
}
if (entries.length === 0) fail("the fenced evidence block declares no [Dn] entry")

/**
 * A shell command is its `$ ` line plus the lines that continue it: a trailing `\`, `|`,
 * `&&` or `||`, an unclosed `do`/`then`, or an open here-document. Splitting on the `$ `
 * lines alone would read a `for` loop's body as that command's output.
 */
function continues(text) {
  const rows = text.split("\n")
  const heredoc = /<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?/.exec(text)
  if (heredoc && !rows.slice(1).some((l) => l.trim() === heredoc[1])) return true
  if (/(\\|\||&&|\|\|)$/.test(rows.at(-1).trimEnd())) return true
  const count = (re) => (text.match(re) ?? []).length
  if (count(/\bdo\b/g) > count(/\bdone\b/g)) return true
  if (count(/\bthen\b/g) > count(/\bfi\b/g)) return true
  return false
}

/** Every command in `body`, each with the lines pasted under it. */
function commandsOf(body) {
  const found = []
  let i = 0
  while (i < body.length) {
    if (!body[i].startsWith("$ ")) {
      i += 1
      continue
    }
    const from = i
    let text = body[i].slice(2)
    i += 1
    while (i < body.length && continues(text)) {
      text += `\n${body[i]}`
      i += 1
    }
    const outFrom = i
    while (i < body.length && !body[i].startsWith("$ ")) i += 1
    const under = body.slice(outFrom, i).filter((l) => l.trim() !== "")
    found.push({ from, text, notes: under.filter((l) => NOTE.test(l)), output: under.filter((l) => !NOTE.test(l)) })
  }
  return found
}

let commands = 0
let pasted = 0
let empty = 0
let placeholders = 0
let notes = 0
for (const [i, entry] of entries.entries()) {
  const body = block.slice(entry.at + 1, i + 1 < entries.length ? entries[i + 1].at : block.length)
  const found = commandsOf(body)
  if (found.length === 0) errors.push(`${entry.tag} holds no "$ " command line`)
  commands += found.length
  for (const command of found) {
    const line = at(entry.at + 1 + command.from)
    notes += command.notes.length
    if (PLACEHOLDER.test(command.text)) {
      placeholders += 1
      errors.push(`${file}:${line}: ${entry.tag} has a placeholder where a runnable command belongs`)
    }
    for (const [j, out] of command.output.entries())
      if (out.includes("…"))
        errors.push(
          `${file}:${line}: ${entry.tag} pastes an elided output line ("…"), not what the command returned (output line ${j + 1})`
        )
    if (command.output.length === 0)
      errors.push(`${file}:${line}: ${entry.tag}'s command has nothing under it, and does not say "${NO_OUTPUT}"`)
    else if (command.output.some((l) => l.trim() === NO_OUTPUT)) {
      if (command.output.length > 1)
        errors.push(`${file}:${line}: ${entry.tag}'s command says "${NO_OUTPUT}" and also pastes output`)
      else empty += 1
    } else pasted += 1
  }
}

const seen = new Set()
let duplicated = 0
let misordered = 0
for (const [i, entry] of entries.entries()) {
  if (seen.has(entry.n)) {
    duplicated += 1
    errors.push(`${entry.tag} is declared more than once`)
  }
  seen.add(entry.n)
  if (entry.n !== i + 1) {
    misordered += 1
    errors.push(`${entry.tag} is declared where [D${i + 1}] was expected`)
  }
}

/** B: every reference in the prose names an entry the block declares. */
let references = 0
let referencesAfter = 0
let dangling = 0
for (const [i, line] of prose.entries()) {
  for (const m of line.matchAll(/\[D(\d+)\]/g)) {
    references += 1
    if (i > fenceClose) referencesAfter += 1
    if (!seen.has(Number(m[1]))) {
      dangling += 1
      errors.push(`${file}:${start + i + 1} references [D${m[1]}], which the block does not declare`)
    }
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

/**
 * Every figure below is counted from the findings, never asserted: a run with violations
 * prints the numbers that carry them, not a summary that contradicts them.
 */
const report = [
  `check-release-evidence-tags: ${file}`,
  `  section: lines ${start + 1}-${end}; evidence block: lines ${start + fenceOpen + 1}-${start + fenceClose + 1}`,
  `  A: ${entries.length} entries hold ${commands} commands: ${placeholders} with a placeholder, ${pasted} with output pasted under them, ${empty} marked "${NO_OUTPUT}"; ${notes} "#" note lines, which are not output`,
  `  C: ${entries.length} entry tags, [D1]..[D${entries.length}]; ${misordered} out of order, ${duplicated} declared twice`,
  `  B: ${references} references in the prose (${referencesAfter} after the block), ${dangling} naming no declared entry`,
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
  const from = fenceOpen + 1 + self.at
  let stop = from + 1
  while (stop < section.length && section[stop] !== "") stop += 1
  const body = ["$ node scripts/check-release-evidence-tags.mjs", ...report, "$ echo $?", "0"]
  const found = section.slice(from + 1, stop)
  if (found.join("\n") !== body.join("\n")) {
    if (argv.includes("--refresh")) {
      const out = [...lines.slice(0, start + from + 1), ...body, ...lines.slice(start + stop)]
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
