/**
 * Mutation testing for the merge queue.
 *
 * `mutants/catalog.json` lists deliberate bugs. Each is planted twice:
 *
 * - in a copy of the Lean reference, where `lake build` must fail (a proof
 *   catches it) or, when every proof still holds, the differential fuzz against
 *   this package's kernel must differ;
 * - in a copy of this package's kernel, where the recorded reference digests or
 *   the theorem checks must notice (`scripts/mutant-check.ts`).
 *
 * A mutant nothing notices is a hole in the proofs and tests, and fails the run.
 *
 *   node scripts/mutants.ts            every mutant
 *   node scripts/mutants.ts --write    every mutant, and rewrite mutants/RESULTS.md
 *   node scripts/mutants.ts <name>...  some mutants
 *
 * Needs the Lean toolchain (`lake`) and a built reference (`cd lean && lake build`).
 */

import { spawn } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

interface Edit {
  readonly file: string
  readonly original: string
  readonly mutated: string
}

interface Mutant {
  readonly name: string
  readonly what: string
  readonly lean: Edit | null
  readonly ts: Edit | null
}

const root = fileURLToPath(new URL("../", import.meta.url))
const catalog: ReadonlyArray<Mutant> = JSON.parse(readFileSync(join(root, "mutants/catalog.json"), "utf8"))
const args = process.argv.slice(2)
const write = args.includes("--write")
const names = args.filter((arg) => !arg.startsWith("--"))
const chosen = names.length === 0 ? catalog : catalog.filter((mutant) => names.includes(mutant.name))

const run = (
  command: string,
  argv: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env?: Record<string, string> }
): Promise<{ readonly code: number; readonly output: string }> =>
  new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd: options.cwd,
      env: { ...process.env, PATH: `${join(homedir(), ".elan/bin")}:${process.env["PATH"]}`, ...options.env }
    })
    let output = ""
    child.stdout.on("data", (chunk) => (output += String(chunk)))
    child.stderr.on("data", (chunk) => (output += String(chunk)))
    child.on("close", (code) => resolve({ code: code ?? 1, output }))
  })

const plant = (directory: string, edit: Edit, strip: string): void => {
  const path = join(directory, edit.file.slice(strip.length))
  const source = readFileSync(path, "utf8")
  if (source.split(edit.original).length !== 2) throw new Error(`${edit.file}: the original text must occur once`)
  writeFileSync(path, source.replace(edit.original, () => edit.mutated))
}

/** The theorems whose proofs a failed build names, from its error positions. */
const casualties = (directory: string, output: string): ReadonlyArray<string> => {
  const found = new Set<string>()
  for (const match of output.matchAll(/error: (MergeQueue\/[A-Za-z]+\.lean):(\d+):/g)) {
    const lines = readFileSync(join(directory, match[1]!), "utf8").split("\n")
    for (let at = Number(match[2]) - 1; at >= 0; at--) {
      const declared = /^(theorem|def|structure|inductive|abbrev)\s+([^\s:({[]+)/.exec(lines[at]!)
      if (declared !== null) {
        if (declared[1] === "theorem") found.add(declared[2]!)
        break
      }
    }
  }
  return [...found]
}

interface Outcome {
  readonly lean: string
  readonly ts: string
  readonly survived: boolean
}

const leanSide = async (mutant: Mutant): Promise<{ readonly text: string; readonly survived: boolean }> => {
  if (mutant.lean === null) return { text: "no Lean mutant: the reference cannot express it", survived: false }
  const directory = mkdtempSync(join(tmpdir(), `merge-queue-mutant-lean-`))
  try {
    cpSync(join(root, "lean"), directory, { recursive: true })
    plant(directory, mutant.lean, "lean/")
    const build = await run("lake", ["build"], { cwd: directory })
    if (build.code !== 0) {
      // Only a theorem that no longer proves counts. A mutant whose own
      // definition does not compile (an unused variable, a type error) proves
      // nothing about the proofs, so it is reported as a broken mutant.
      const broken = casualties(directory, build.output)
      if (broken.length === 0) {
        const first = /error: .*/.exec(build.output)?.[0] ?? "the build fails"
        return { text: `INVALID MUTANT, no theorem broke: ${first}`, survived: true }
      }
      const shown = broken.slice(0, 6).map((name) => `\`${name}\``).join(", ")
      return { text: `proof: ${shown}${broken.length > 6 ? ` and ${broken.length - 6} more` : ""}`, survived: false }
    }
    const differential = await run("node", ["scripts/differential.ts", "400", "120", "1"], {
      cwd: root,
      env: { MERGE_QUEUE_REFERENCE: join(directory, ".lake/build/bin/reference") }
    })
    return differential.code === 0
      ? { text: "SURVIVED: every proof holds and the differential agrees", survived: true }
      : { text: "differential: every proof still holds; the kernel and the mutated reference differ", survived: false }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const tsSide = async (mutant: Mutant): Promise<{ readonly text: string; readonly survived: boolean }> => {
  if (mutant.ts === null) return { text: "no TypeScript mutant: the types refuse it", survived: false }
  const directory = mkdtempSync(join(tmpdir(), `merge-queue-mutant-ts-`))
  try {
    cpSync(join(root, "src"), join(directory, "src"), { recursive: true })
    plant(join(directory, "src"), mutant.ts, "src/")
    const check = await run("node", ["scripts/mutant-check.ts", join(directory, "src")], { cwd: root })
    return check.code === 0
      ? { text: "SURVIVED: no detector noticed", survived: true }
      : { text: check.output.trim().split("\n").at(-1) ?? "noticed", survived: false }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const outcomes = new Map<string, Outcome>()
const queue = [...chosen]
const worker = async (): Promise<void> => {
  for (let mutant = queue.shift(); mutant !== undefined; mutant = queue.shift()) {
    const [lean, ts] = await Promise.all([leanSide(mutant), tsSide(mutant)])
    outcomes.set(mutant.name, { lean: lean.text, ts: ts.text, survived: lean.survived || ts.survived })
    process.stdout.write(`${lean.survived || ts.survived ? "SURVIVED" : "killed  "} ${mutant.name}\n`)
  }
}
await Promise.all(Array.from({ length: 4 }, worker))

const survivors = chosen.filter((mutant) => outcomes.get(mutant.name)!.survived)
const table = [
  "# Mutation results",
  "",
  "Written by `node scripts/mutants.ts --write`. Do not edit: run it again.",
  "",
  `${chosen.length} planted bugs; ${chosen.length - survivors.length} caught on both sides.`,
  "",
  "Each bug is planted in the Lean reference and in the TypeScript kernel. In Lean it must break a proof, or, when",
  "every proof still holds (the bug changes the policy, not a guarantee), make the differential fuzz differ. In",
  "TypeScript the recorded reference digests or the theorem checks must notice.",
  "",
  "| Mutant | The bug | Lean reference | TypeScript kernel |",
  "| --- | --- | --- | --- |",
  ...chosen.map((mutant) => {
    const outcome = outcomes.get(mutant.name)!
    return `| \`${mutant.name}\` | ${mutant.what} | ${outcome.lean} | ${outcome.ts} |`
  }),
  ""
].join("\n")
if (write) writeFileSync(join(root, "mutants/RESULTS.md"), table)
process.stdout.write(
  `mutants: ${chosen.length} planted, ${chosen.length - survivors.length} caught, ${survivors.length} survived\n`
)
if (survivors.length > 0) {
  process.stdout.write(
    survivors.map((mutant) => `  ${mutant.name}: ${JSON.stringify(outcomes.get(mutant.name))}\n`).join("")
  )
  process.exit(1)
}
