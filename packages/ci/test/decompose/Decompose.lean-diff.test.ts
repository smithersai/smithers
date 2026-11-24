/**
 * Differential tests of the decompose part against its Lean 4 reference specification (`spec/lean/decompose`):
 * the shell reader and quoter, the package script splitter, the workspace wildcard matcher, path join and reach,
 * the Turborepo walk, and the order the jobs of one working tree run in.
 *
 * The specification is compiled once to a program that answers one JSON request per line. Each property builds an
 * input, asks the implementation and the program, and holds when the two answers are the same. A host with neither
 * the built program nor `lake` skips every case here.
 */
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Job, Step } from "../../src/contract/Inventory.vibe"
import { treeOrder } from "../../src/contract/Inventory.vibe"
import * as Plan from "../../src/decompose/Plan.vibe"
import { pnpmCommands, yarnCommands } from "../../src/decompose/Runners.vibe"
import * as Script from "../../src/decompose/Script.vibe"
import { type Command, commands, quote } from "../../src/decompose/Shell.vibe"
import * as Turbo from "../../src/decompose/Turbo.vibe"
import * as Workspace from "../../src/decompose/Workspace.vibe"

// ---------------------------------------------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------------------------------------------

const specDirectory = fileURLToPath(new URL("../../spec/lean/decompose", import.meta.url))
const program = join(specDirectory, ".lake", "build", "bin", "decompose-spec")
const elanBin = join(homedir(), ".elan", "bin")

/** `lake`, from the path or from where `elan` installs it. */
const lake = ((): string | undefined => {
  const found = spawnSync("which", ["lake"], { encoding: "utf8" })
  if (found.status === 0 && found.stdout.trim() !== "") return found.stdout.trim()
  const installed = join(elanBin, "lake")
  return existsSync(installed) ? installed : undefined
})()

/** True when the specification's program is built, or its sources are here with `lake` to build them. */
const oracleReady = existsSync(program) || (lake !== undefined && existsSync(join(specDirectory, "lakefile.toml")))

interface Waiting {
  readonly resolve: (answer: unknown) => void
  readonly reject: (problem: Error) => void
}

let oracle: ChildProcessWithoutNullStreams | undefined
const waiting: Array<Waiting> = []
let asked = 0

/** Asks the specification one question and gives its answer. The program answers in the order it is asked. */
const ask = (request: Readonly<Record<string, unknown>>): Promise<unknown> =>
  new Promise((resolve, reject) => {
    asked += 1
    waiting.push({ resolve, reject })
    ;(oracle as ChildProcessWithoutNullStreams).stdin.write(`${JSON.stringify(request)}\n`)
  })

beforeAll(() => {
  if (!oracleReady) return
  if (lake !== undefined && existsSync(join(specDirectory, "lakefile.toml"))) {
    const built = spawnSync(lake, ["build"], {
      cwd: specDirectory,
      encoding: "utf8",
      env: { ...process.env, PATH: `${elanBin}${delimiter}${process.env["PATH"] ?? ""}` }
    })
    if (built.status !== 0) throw new Error(`lake build failed:\n${built.stdout}\n${built.stderr}`)
  }
  const child = spawn(program, [], { stdio: ["pipe", "pipe", "pipe"] })
  let pending = Buffer.alloc(0)
  // A response is one line. Only a line feed ends it: a string may hold U+2028, which a line reader would split at.
  child.stdout.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    for (let end = pending.indexOf(10); end >= 0; end = pending.indexOf(10)) {
      const response = JSON.parse(pending.subarray(0, end).toString("utf8")) as { ok?: unknown; error?: string }
      pending = pending.subarray(end + 1)
      const next = waiting.shift() as Waiting
      if (response.error === undefined) next.resolve(response.ok)
      else next.reject(new Error(`the specification refused the request: ${response.error}`))
    }
  })
  child.on("close", () => {
    for (const next of waiting.splice(0)) next.reject(new Error("the specification's program stopped"))
  })
  oracle = child
})

afterAll(() => {
  oracle?.stdin.end()
})

// ---------------------------------------------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------------------------------------------

interface Runs {
  readonly runs: number
  readonly seed: number
}

/** A value with its object keys in order, so two answers that say the same are written the same. */
const ordered = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(ordered)
    : typeof value === "object" && value !== null
    ? Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map((
        [key, held]
      ) => [key, ordered(held)])
    )
    : value

/** How two answers differ, or nothing when they are the same. `undefined` is written `null`, as JSON has it. */
const differs = (label: string, implementation: unknown, specification: unknown): ReadonlyArray<string> => {
  const left = JSON.stringify(ordered(implementation ?? null), (_, held: unknown) => held === undefined ? null : held)
  const right = JSON.stringify(ordered(specification ?? null))
  return left === right ? [] : [`${label}\n  implementation: ${left}\n  specification:  ${right}`]
}

/** Holds when `problems` names none for every generated value. */
const assertHolds = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  problems: (value: A) => Promise<ReadonlyArray<string>>,
  options: Runs
): Promise<void> => {
  const outcome = await Effect.runPromise(
    Arbitrary.checkEffect(
      arbitrary,
      (value) =>
        Effect.tryPromise(async () => {
          const found = await problems(value)
          if (found.length > 0) expect.fail(found.join("\n"))
          return true
        }),
      options
    )
  )
  if (outcome._tag !== "Passed") expect.fail(Arbitrary.formatCheckFailure(outcome))
  expect(outcome._tag).toBe("Passed")
}

/** Runs every case of a corpus, and names each case that has a problem. */
const assertCorpus = async <A>(
  cases: ReadonlyArray<A>,
  problems: (value: A) => Promise<ReadonlyArray<string>>
): Promise<void> => {
  const found: Array<string> = []
  for (const value of cases) {
    for (const problem of await problems(value)) found.push(`${JSON.stringify(value)}: ${problem}`)
  }
  expect(found).toEqual([])
}

/** A source of choices: each `next(bound)` is below `bound`, and zero once the tape ends. */
interface Tape {
  readonly next: (bound: number) => number
  readonly pick: <A>(values: ReadonlyArray<A>) => A
  readonly chance: (outOf: number) => boolean
}

const tapeOf = (bytes: ReadonlyArray<number>): Tape => {
  let at = 0
  const next = (bound: number): number => {
    const value = bytes[at] ?? 0
    at += 1
    return value % bound
  }
  return {
    next,
    pick: (values) => values[next(values.length)] as (typeof values)[number],
    chance: (outOf) => next(outOf) === 0
  }
}

const byte = Arbitrary.schema(Schema.Literals(Array.from({ length: 256 }, (_, index) => index)))

/** A value built from a tape of at least `length` bytes. */
const built = <A>(build: (tape: Tape) => A, length = 96): Arbitrary.Arbitrary<A> =>
  Arbitrary.map(Arbitrary.array(byte, { minLength: length, maxLength: length * 2 }), (bytes) => build(tapeOf(bytes)))

/** Text with each lone surrogate replaced: JSON carries no lone surrogate to the specification. */
const wellFormed = (text: string): string =>
  Array.from(text, (character) => /^[\ud800-\udfff]$/.test(character) ? "�" : character).join("")

const anyString = Arbitrary.map(Arbitrary.schema(Schema.String), wellFormed)

/** Text made of the given pieces, which reaches syntax a string of any characters rarely does. */
const soup = (pieces: ReadonlyArray<string>, length = 14): Arbitrary.Arbitrary<string> =>
  built((tape) => Array.from({ length: tape.next(length) + 1 }, () => tape.pick(pieces)).join(""), length + 1)

const several = <A>(tape: Tape, most: number, make: () => A): Array<A> =>
  Array.from({ length: tape.next(most + 1) }, make)

const subsetOf = <A>(tape: Tape, values: ReadonlyArray<A>): Array<A> => values.filter(() => tape.chance(2))

const nbsp = String.fromCharCode(0xa0)
const lineSeparator = String.fromCharCode(0x2028)

// ---------------------------------------------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------------------------------------------

const shellPieces = [
  "a",
  "b1",
  "pnpm",
  "run",
  " ",
  "\t",
  "\n",
  ";",
  "&&",
  "||",
  "|",
  "&",
  ">",
  ">>",
  "<",
  "2>&1",
  "'",
  "\"",
  "\\",
  "$",
  "$X",
  "${Y}",
  "$(",
  "`",
  "(",
  ")",
  "{",
  "}",
  "*",
  "?",
  "~",
  "[",
  "]",
  "#",
  "=",
  "A=",
  "if ",
  "then ",
  "elif ",
  "else ",
  "fi",
  "for ",
  "-n",
  "!",
  "\r",
  nbsp,
  lineSeparator,
  "é",
  "😀",
  "0",
  "\\\n"
]

const shellNames = [
  "pnpm",
  "npm",
  "run",
  "test",
  "build",
  "echo",
  "a",
  "b1",
  "x-y",
  "FOO",
  "é",
  "😀",
  "[",
  "]",
  "!",
  "-n"
]

/** One word. A `wild` word may hold syntax the reader refuses. */
const shellWord = (tape: Tape, wild: boolean): string => {
  switch (tape.next(wild ? 14 : 12)) {
    case 0:
      return `'${tape.pick(["a b", "", "it", "$x", "\\", "a\nb", "*", "if"])}'`
    case 1:
      return `"${tape.pick(["a b", "", "$HOME", "${X}", "\\\"", "\\$x", "a\\\nb", "\\n", "$1", "$?", "é😀", "x\\\\"])}"`
    case 2:
      return `\\${tape.pick([" ", "\n", "$", "a", "'", "\"", ";", "😀"])}${tape.pick(shellNames)}`
    case 3:
      return `$${tape.pick(["HOME", "{X}", "1", "?", "#", "$", "!", "x_1", "10"])}`
    case 4:
      return `${tape.pick(["A", "_b", "PATH"])}=${tape.pick(["", "1", "'a b'", "$x", "\"q\"", "a=b"])}`
    case 5:
      return tape.pick(["a'b'\"c\"d", "x\\\ny", "a#b", "2", "a=b=c", nbsp, "\r", `a${lineSeparator}b`, "i\\\nf"])
    case 12:
    case 13:
      return tape.pick([
        "$(x)",
        "`x`",
        "*.ts",
        "a?",
        "~",
        "{a,b}",
        "(",
        ")",
        "a[1]",
        "$'x'",
        "${x:-y}",
        "$@",
        "\"$(x)\"",
        "'open",
        "\"open",
        "\\",
        "\"`\"",
        "$"
      ])
    default:
      return tape.pick(shellNames)
  }
}

const shellRedirect = (tape: Tape, wild: boolean): string =>
  tape.pick([
    " > out",
    " 2>&1",
    " >> log",
    " 2> err",
    " >&2",
    " > 'a b'",
    " 1>out",
    " > $f",
    " >\t\tspaced",
    " 2>&1 >/dev/null",
    " 10>x",
    ...(wild ? [" >", " < in", " &> x", " >| f"] : [])
  ])

const shellSimple = (tape: Tape, wild: boolean): string => {
  let text = tape.chance(6) ? shellRedirect(tape, wild).trimStart() + " " : ""
  const count = tape.next(4) + 1
  for (let index = 0; index < count; index += 1) {
    text += `${index === 0 ? "" : tape.pick([" ", " ", "  ", "\t", " \\\n "])}${shellWord(tape, wild)}`
    if (tape.chance(8)) text += shellRedirect(tape, wild)
  }
  return text
}

const shellTest = (tape: Tape, wild: boolean): string =>
  tape.pick([
    "[ -n \"\" ]",
    "[ -z \"\" ]",
    "[ a = a ]",
    "[ a != a ]",
    "test a == b",
    "[ ! -n x ]",
    "[ -n $x ]",
    "[ -f x ]",
    "true",
    "[ a = a ] && true",
    "A=1 [ a = a ]",
    "[ ! = ! ]",
    "[ -n ]",
    "test",
    "[ a = a ] > f",
    "[ ! a != b ]",
    "[ -z x ]",
    "'[' a = a ']'",
    ...(wild ? ["[ a = a ] |", ""] : [])
  ])

const shellList = (tape: Tape, depth: number, wild: boolean): string => {
  const count = tape.next(3) + 1
  let text = ""
  for (let index = 0; index < count; index += 1) {
    const structured = depth > 0 && tape.chance(4)
    // An `if` stands alone: only a separator may come before it.
    if (index > 0) {
      text += structured && !wild
        ? tape.pick(["; ", "\n"])
        : tape.pick([
          " && ",
          " || ",
          "; ",
          "\n",
          " | ",
          " & ",
          " &&\n",
          " |\n ",
          ...(wild ? [";;", " |& ", " ; ; "] : [])
        ])
    }
    text += structured ? shellIf(tape, depth - 1, wild) : shellSimple(tape, wild)
    if (structured && !wild && index < count - 1) text += tape.pick(["; :", "\n:"])
  }
  return text
}

const shellIf = (tape: Tape, depth: number, wild: boolean): string => {
  const end = (): string => tape.pick(wild ? ["; ", "\n", " ; ", " "] : ["; ", "\n", " ; "])
  let text = `if ${shellTest(tape, wild)}${end()}then ${shellList(tape, depth, wild)}${end()}`
  for (let more = 0; more < 2 && tape.chance(4); more += 1) {
    text += `elif ${shellTest(tape, wild)}${end()}then ${shellList(tape, depth, wild)}${end()}`
  }
  if (tape.chance(2)) text += `else ${shellList(tape, depth, wild)}${end()}`
  return `${text}${wild ? tape.pick(["fi", "fi", "fi", "", "fi fi", "done"]) : "fi"}`
}

/** A program. Half are tame, of syntax the reader accepts, so that what it reads is compared and not only refused. */
const shellProgram = (tape: Tape): string => {
  const wild = tape.chance(2)
  return `${tape.pick(["", "", "", " ", "\n", "# c\n", "; "])}${shellList(tape, 2, wild)}${
    tape.pick([
      "",
      "",
      "",
      ";",
      "\n",
      " # c",
      " &",
      ...(wild ? [" &&", " ||", " |", " #&&", "\\", " && # c", " | \n"] : [])
    ])
  }`
}

const commandView = (command: Command): unknown => ({
  assignments: command.assignments,
  words: command.words,
  start: command.start ?? null,
  end: command.end ?? null,
  joint: command.joint,
  piped: command.piped,
  background: command.background,
  conditional: command.conditional
})

/** What the generated cases came to, by a label: a property that only ever sees one outcome shows little. */
const census = new Map<string, number>()
const count = (label: string): void => void census.set(label, (census.get(label) ?? 0) + 1)

const commandsProblems = async (script: string): Promise<ReadonlyArray<string>> => {
  const read = commands(script)
  count(
    read === undefined
      ? "shell:refused"
      : read.some((command) => command.conditional)
      ? "shell:conditional"
      : "shell:read"
  )
  return differs(
    `commands(${JSON.stringify(script)})`,
    read?.map(commandView),
    await ask({ op: "shell.commands", script })
  )
}

const quoteProblems = async (word: string): Promise<ReadonlyArray<string>> =>
  differs(`quote(${JSON.stringify(word)})`, quote(word), await ask({ op: "shell.quote", word }))

const shellCorpus = [
  "",
  " ",
  "a",
  "a b",
  "a && b",
  "a &&",
  "a ||",
  "a |",
  "a &",
  "a ;",
  "&& a",
  "a && && b",
  "a\n&& b",
  "a &&\nb",
  "a |\n\n b",
  "a ; ; b",
  "a ;; b",
  "a;\n;b",
  "a # b && c",
  "a#b",
  "#",
  "a \\\n b",
  "a\\\nb",
  "\"a\\\nb\"",
  "\"pn\\\npm\" run \"te\\\nst\"",
  "\"\\\n\"",
  "\"a\\\\\nb\"",
  "'a\\\nb'",
  "\"a\\nb\"",
  "\"\\\"\\\\\\$\\`\"",
  "\"$\"",
  "\"${X}$Y$1$?$$$!$#\"",
  "pnpm -r run test -- '${{ inputs.test_path }}'",
  "echo '${HOME}'",
  "\"${}\"",
  "$",
  "$10",
  "${X",
  "${X}y",
  "A=1",
  "A=1 B='x y' c d",
  "A=$x b",
  "\"A\"=1 b",
  "a A=1",
  "A+=1 b",
  "> out a",
  "a > out b",
  "a b > out",
  "a 2>&1 b",
  "a >& b",
  "a >&",
  "a >",
  "a 2>",
  "a >> 'x y' && b",
  "a 10>x",
  "a>b",
  "> out A=1 b c",
  "A=1 > out",
  "> out",
  "a < b",
  "a &> b",
  "a |& b",
  "[ a = b ]",
  "[[ a = b ]]",
  "a [",
  "a[",
  "a ]]",
  "a [x]",
  "if [ -n \"\" ]; then a; else b; fi",
  "if [ -z \"\" ]; then a; else b; fi",
  "if [ -n $x ]; then a; else b; fi",
  "if [ -n $x ]; then a; elif [ a = a ]; then b; else c; fi",
  "if [ a != a ]; then a; elif [ -n $x ]; then b; elif true; then c; else d; fi",
  "if [ a = a ]; then a; fi; b",
  "if [ a = a ]; then a; fi && b",
  "a && if true; then b; fi",
  "a; if true; then b; fi | c",
  "if true; then if false; then a; fi; fi",
  ...[63, 64, 65].map((depth) => "if test -n x; then ".repeat(depth) + "pnpm test; " + "fi; ".repeat(depth)),
  "if test -z x; then a; " + "elif test -z x; then a; ".repeat(65) + "else b; fi",
  "if true; then if [ a = a ]; then a; else b; fi fi",
  "if then a; fi",
  "if true; then fi",
  "if true; then a",
  "if true; a; fi",
  "if true\nthen\na\nfi\n",
  "'if' true; then a; fi",
  "i\\\nf true; then a; fi",
  "echo if then fi",
  "then",
  "fi",
  "for x in a; do b; done",
  "time a",
  "A=1 if",
  "if test a = a; then a; fi",
  "if [ ! -z \"\" ]; then a; fi",
  "if [ ! a = b ]; then a; fi",
  "if A=1 [ a = a ]; then a; fi",
  "if [ a = a ] | cat; then a; fi",
  "if [ a = a ] &\nthen a; fi",
  "if [ a ]; then a; fi",
  "if [ ]; then a; fi",
  "if [ a = a ]; then a &&\nfi",
  "é 😀 '😀' \"😀\" \\😀",
  "😀=1 a",
  `a${nbsp}b`,
  `a\rb`,
  `a${lineSeparator}b`,
  "a\tb\t",
  "a *",
  "a ~",
  "a {b}",
  "a (b)",
  "a `b`",
  "a $(b)",
  "a 'b",
  "a \"b",
  "a \\",
  `${"if true; then ".repeat(40)}a${"; fi".repeat(40)}`,
  `${"a && ".repeat(200)}b`,
  `${"'x' ".repeat(300)}`
]

const quoteCorpus = [
  "",
  "a",
  "a b",
  "it's",
  "''",
  "'",
  "a'b'c",
  "@%+=:,./-",
  "a\nb",
  "é",
  "😀",
  "$x",
  "\\",
  "a\tb",
  "~",
  "*",
  "x_1"
]

describe("Shell against the Lean specification", () => {
  it.skipIf(!oracleReady)("the transport carries any text unchanged", async () => {
    await assertHolds(anyString, async (text) => differs("echo", text, await ask({ op: "echo", text })), {
      runs: 200,
      seed: 1
    })
  })

  it.skipIf(!oracleReady)("quotes any word as the specification does", async () => {
    await assertCorpus(quoteCorpus, quoteProblems)
    await assertHolds(anyString, quoteProblems, { runs: 300, seed: 2 })
    await assertHolds(
      soup(["a", "'", "\\", " ", "$", "-", "/", "é", "😀", "\n", "=", "\"", "_", "0"], 8),
      quoteProblems,
      {
        runs: 300,
        seed: 3
      }
    )
  })

  it.skipIf(!oracleReady)("reads the corner cases as the specification does", async () => {
    await assertCorpus(shellCorpus, commandsProblems)
  })

  it.skipIf(!oracleReady)("reads programs generated from the grammar as the specification does", async () => {
    await assertHolds(built(shellProgram, 160), commandsProblems, { runs: 500, seed: 4 })
  })

  it.skipIf(!oracleReady)("reads hostile text as the specification does", async () => {
    await assertHolds(soup(shellPieces, 16), commandsProblems, { runs: 500, seed: 5 })
    await assertHolds(anyString, commandsProblems, { runs: 300, seed: 6 })
  })

  it.skipIf(!oracleReady)("reads back every word it quotes", async () => {
    await assertHolds(
      Arbitrary.array(anyString, { minLength: 1, maxLength: 4 }),
      async (words) => commandsProblems(words.map(quote).join(" ")),
      { runs: 300, seed: 7 }
    )
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------------------------------------------

const managers = ["npm", "pnpm", "yarn", "bun"] as const

const scriptNames = [
  "build",
  "test",
  "lint",
  "check",
  "a",
  "b",
  "c",
  "prebuild",
  "posttest",
  "prea",
  "postc",
  "precheck",
  "__proto__",
  "constructor",
  "toString",
  "0",
  "x:y",
  "install",
  "run"
]

const stepOf = (command: string, extra: Partial<Step> = {}): Step => ({
  id: "ci.yml:test:1",
  command,
  cwd: "",
  env: {},
  secrets: [],
  ...extra
})

interface ScriptCase {
  readonly command: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly runner: string | undefined
  readonly leads: boolean
  readonly files: ReadonlyArray<readonly [path: string, text: string | null]>
}

/** One link of a chain. Most run a script by name with the chain's package manager; a few are anything else. */
const scriptLink = (tape: Tape, manager: string, names: ReadonlyArray<string>): string => {
  const name = tape.pick(names)
  switch (tape.next(40)) {
    case 0:
      return `${tape.pick(managers)} run ${name}`
    case 1:
      return `${manager} run ${name} --flag`
    case 2:
      return tape.pick([
        "tsc -p .",
        "echo hi",
        "node x.js",
        `${manager} install`,
        `${manager} run`,
        `${manager} run -x`,
        "npm test"
      ])
    case 3:
    case 4:
      return `${manager}  run\t${name}`
    case 5:
    case 6:
      return `${manager} run-script ${name}`
    case 7:
    case 8:
      return `${manager} ${name}`
    default:
      return `${manager} run ${name}`
  }
}

const strayBodies = [
  "tsc -p .",
  "echo 'a b'",
  "a || b",
  "a; b",
  "a | b",
  "a & b",
  "a > f",
  "(a)",
  "echo $x",
  `a${nbsp}b`,
  "a && ",
  "&& a",
  "a &&& b",
  "",
  "a\nb",
  "a\rb",
  "é",
  "a && b",
  "\"a\"",
  "a &&&& b"
]

/** A script's text: a chain of runs of the scripts in `inner`, or one command when there is none to run. */
const scriptBody = (tape: Tape, manager: string, inner: ReadonlyArray<string>): string => {
  if (inner.length === 0 || tape.chance(12)) return tape.pick(strayBodies)
  const count = tape.next(3) + 1
  let text = ""
  for (let index = 0; index < count; index += 1) {
    text += `${index === 0 ? "" : tape.pick([" && ", " && ", "&&", " &&  ", "\t&&\t"])}${
      scriptLink(tape, manager, inner)
    }`
  }
  return text
}

/** A manifest. A script mostly runs scripts listed after it, so most graphs end; a few run any, and may not. */
const manifestText = (tape: Tape, manager: string, names: ReadonlyArray<string>): string => {
  if (tape.chance(24)) return tape.pick(["", "{", "[]", "null", "{\"scripts\":null}", "{\"scripts\":\"x\"}", "1"])
  const bodyOf = (index: number, among: ReadonlyArray<string>): string =>
    scriptBody(tape, manager, tape.chance(10) ? among : among.slice(index + 1))
  const entries: Array<string> = names.map((name, index) =>
    `${JSON.stringify(name)}:${
      tape.chance(24) ? tape.pick(["1", "null", "[]", "{}"]) : JSON.stringify(bodyOf(index, names))
    }`
  )
  const field = tape.chance(6)
    ? `,"packageManager":${
      tape.pick([
        "\"npm@6.1.0\"",
        "\"npm@10.0.0\"",
        "\"pnpm@7.3\"",
        "\"pnpm@9.1.0\"",
        "\"yarn@1.22.0\"",
        "\"yarn@4.0.0\"",
        "\"bun@1.0\"",
        "\"npm@x\"",
        "\"yarn\"",
        "1",
        "\"pnpm@08\""
      ])
    }`
    : ""
  // A list of scripts is read by index, as `Object.entries` reads it.
  const indexes = names.map((_, index) => String(index))
  return tape.chance(20)
    ? `{"scripts":[${names.map((_, index) => JSON.stringify(bodyOf(index, indexes))).join(",")}]${field}}`
    : `{"name":"x","scripts":{${entries.join(",")}}${field}}`
}

const settingTexts: Readonly<Record<string, ReadonlyArray<string>>> = {
  ".npmrc": [
    "",
    "script-shell=/bin/sh",
    "  shell-emulator = true",
    "#script-shell\nfoo=1",
    `\n\tscript-shell${nbsp}=x`,
    "xscript-shell=1",
    "a=1\rshell-emulator=1",
    "script-shell"
  ],
  ".yarnrc": [
    "script-shell \"/bin/sh\"",
    "\"script-shell\" x",
    "script-shellx",
    " \"script-shell\"\tx",
    "script-shell",
    "x\n  script-shell\n"
  ],
  ".yarnrc.yml": ["", "nodeLinker: node-modules"],
  "bunfig.toml": ["shell = \"bash\"", "[run]\nshell=1", "shellx=1", ""],
  "package-lock.json": [
    "{\"lockfileVersion\": 1}",
    "{\"lockfileVersion\":3}",
    "{\"lockfileVersion\":\n2",
    "\"lockfileVersion\":x \"lockfileVersion\": 2",
    "{}",
    `${" ".repeat(1990)}"lockfileVersion":1`,
    `${"😀".repeat(990)}"lockfileVersion":123`
  ],
  "npm-shrinkwrap.json": ["{\"lockfileVersion\": 1}", "{\"lockfileVersion\": 2}", ""],
  "pnpm-lock.yaml": [
    "lockfileVersion: 5.4",
    "lockfileVersion: '9.0'",
    "x\nlockfileVersion: 6",
    " lockfileVersion: 5",
    "lockfileVersion:\n'6'",
    "",
    `${"a".repeat(1999)}\nlockfileVersion: 9`
  ],
  "pnpm-workspace.yaml": ["packages:\n - a", "scriptShell: bash", "  shellEmulator : true", "xscriptShell: 1"],
  "yarn.lock": ["# yarn lockfile v1", "__metadata:\n  version: 8", ""]
}

const scriptCase = (tape: Tape): ScriptCase => {
  const manager = tape.pick(managers)
  // A hook's name is seldom drawn, so that most scripts have none.
  const plain = scriptNames.filter((candidate) => !/^(?:pre|post)/.test(candidate))
  const names = [
    ...new Set(Array.from({ length: tape.next(6) + 2 }, () => tape.pick(tape.chance(8) ? scriptNames : plain)))
  ]
  const name = tape.chance(3) ? tape.pick(names) : names[0] as string
  const cwd = tape.pick([
    "",
    "",
    "",
    "packages/a",
    "./packages/a/",
    "/abs",
    "..",
    "a/../..",
    "${{ x }}",
    "a//b",
    "a/b/c"
  ])
  const directory = Workspace.join("", cwd) ?? ""
  const command = tape.chance(5)
    ? tape.pick([
      `${manager} run ${name} -- --x`,
      `${manager} ${name}`,
      `'${manager}' run "${name}"`,
      `${manager} run ${name} > log`,
      `X=1 ${manager} run ${name}`,
      `  ${manager} run ${name}  `,
      `${manager} run ${name} # c`,
      `${manager} run ${name} && echo`,
      "npm test",
      `${manager} run $X`,
      `${manager} run ${name}${nbsp}`,
      `${manager} run ${name} extra`,
      `${manager} run-script ${name}`,
      `\n${manager} run ${name}\n`,
      `${manager} run ${name} |`
    ])
    : `${manager} run ${name}`
  const files = new Map<string, string | null>()
  const inDirectory = (where: string, file: string): string => where === "" ? file : `${where}/${file}`
  files.set(inDirectory(directory, "package.json"), manifestText(tape, manager, names))
  if (directory !== "" && tape.chance(2)) files.set("package.json", manifestText(tape, manager, names))
  for (const [file, bodies] of Object.entries(settingTexts)) {
    for (const where of new Set([directory, ""])) {
      if (tape.chance(20)) files.set(inDirectory(where, file), tape.chance(8) ? null : tape.pick(bodies))
    }
  }
  if (tape.chance(30)) files.set(inDirectory(directory, "package.json"), null)
  return {
    command,
    cwd,
    env: Object.fromEntries(
      tape.chance(10)
        ? subsetOf(tape, [
          "npm_config_x",
          "NPM_CONFIG_Y",
          "YARN_ENABLE",
          "PATH",
          "pnpm_config_a",
          "BUN_CONFIG_REGISTRY",
          "xnpm_config_",
          "7"
        ]).map((key) => [key, "1"])
        : []
    ),
    runner: tape.chance(3)
      ? tape.pick([
        "bash -e {0}",
        "bash -e {0}",
        "bash -e {0}",
        "__limit=10\nbash",
        "x\n__limit=5",
        "x __limit=1",
        "a\r__limit=2",
        `a${lineSeparator}__limit=3`
      ])
      : undefined,
    leads: tape.chance(2),
    files: [...files]
  }
}

/** A file as the specification is given it: its text, and the JSON value it parses to when it does. */
const fileView = (text: string | null): unknown => {
  if (text === null) return null
  try {
    return { text, json: JSON.parse(text) as unknown }
  } catch {
    return { text }
  }
}

const decideProblems = async (input: ScriptCase): Promise<ReadonlyArray<string>> => {
  const held = new Map(input.files)
  const step = stepOf(input.command, {
    cwd: input.cwd,
    env: input.env,
    ...(input.runner === undefined ? {} : { runner: input.runner })
  })
  const request = { command: input.command, cwd: input.cwd }
  const decision = Script.decide(step, (path) => held.get(path), input.leads)
  count(`decide:${decision.kind === "whole" ? decision.why.feature : decision.kind}`)
  return [
    ...differs(
      "decide",
      decision,
      await ask({
        op: "script.decide",
        ...request,
        env: Object.keys(input.env),
        runner: input.runner ?? null,
        leads: input.leads,
        files: input.files.map(([path, text]) => [path, fileView(wellFormedOrNull(text))])
      })
    ),
    ...differs("filesOf", Script.filesOf(step), await ask({ op: "script.filesOf", ...request }))
  ]
}

const wellFormedOrNull = (text: string | null): string | null => text === null ? null : wellFormed(text)

const runOfProblems = async (words: ReadonlyArray<string>): Promise<ReadonlyArray<string>> =>
  differs(`runOf(${JSON.stringify(words)})`, Script.runOf(words), await ask({ op: "script.runOf", words }))

const decideCorpus: ReadonlyArray<ScriptCase> = [
  // A script that reaches itself.
  ["npm run a", { a: "npm run b && npm run c", b: "npm run a", c: "echo" }],
  ["npm run a", { a: "npm run a && npm run a" }],
  ["pnpm run a", { a: "pnpm run b && pnpm run b", b: "pnpm run c && pnpm run d", c: "pnpm run b", d: "x" }],
  // The same script twice is no cycle.
  ["npm run a", { a: "npm run b && npm run b", b: "npm run c && npm run c", c: "x" }],
  // Hooks: around the split script, and around a script inside it.
  ["npm run a", { a: "npm run b && npm run c", b: "x", c: "y", prea: "z" }],
  ["npm run a", { a: "npm run b && npm run c", b: "x", c: "y", posta: "z" }],
  ["npm run a", { a: "npm run b && npm run c", b: "npm run d && npm run d", c: "y", d: "x", preb: "z" }],
  ["npm run a", { a: "npm run b", b: "npm run c && npm run d", c: "x", d: "y", prea: "z" }],
  // Names an object has without being given them.
  ["npm run constructor", { build: "x" }],
  ["npm run __proto__", { __proto__: "npm run a && npm run b", a: "x", b: "y" }],
  ["npm run a", { a: "npm run toString && npm run b", b: "y" }],
  // Mixed package managers, options and arguments.
  ["yarn run a", { a: "yarn run b && npm run c", b: "x", c: "y" }],
  ["yarn a", { a: "yarn b && yarn c", b: "x", c: "y" }],
  ["yarn 'a b'", { "a b": "yarn b && yarn c", b: "x", c: "y" }],
  ["pnpm a x", { a: "pnpm b && pnpm c", b: "x", c: "y" }],
  ["bun run a", { a: "bun run b && bun run c", b: "x", c: "y" }],
  ["npm test", { test: "npm run b && npm run c", b: "x", c: "y" }],
  ["npm run a", { a: "npm run b && npm run c -- x", b: "x", c: "y" }],
  ["npm run a", { a: "npm run b &&", b: "x" }],
  ["npm run a", { a: "npm run b; npm run c", b: "x", c: "y" }],
  ["npm run a", { a: "npm run b && npm run b && npm run c", b: "x", c: "npm run b && npm run b" }]
].map(([command, scripts]) => ({
  command: command as string,
  cwd: "",
  env: {},
  runner: undefined,
  leads: false,
  files: [["package.json", JSON.stringify(scripts)]]
}))

/** A chain of two commands, with what of the step or the repository is meant for the script as a whole. */
const settingCorpus: ReadonlyArray<ScriptCase> = ([
  {},
  { runner: "bash -e {0}", leads: true },
  { runner: "bash -e {0}" },
  { runner: "set -e\n__limit=600\nbash -e {0}", leads: true },
  { env: { NPM_CONFIG_SCRIPT_SHELL: "zsh" } },
  { files: [[".npmrc", null]] },
  { files: [[".npmrc", "script-shell = zsh"]] },
  { files: [["package-lock.json", "{\"lockfileVersion\": 1}"]] },
  { files: [["package-lock.json", `${"😀".repeat(995)}"lockfileVersion": 1`]] },
  { files: [["package-lock.json", `${"😀".repeat(1000)}"lockfileVersion": 1`]] },
  { cwd: "packages/a", files: [["package.json", "{\"packageManager\":\"npm@6.14.0\"}"]] },
  { cwd: "packages/a", files: [["pnpm-workspace.yaml", "packages: []"]] }
] as ReadonlyArray<Partial<ScriptCase>>).map((extra) => {
  const cwd = extra.cwd ?? ""
  const manifest = JSON.stringify({ scripts: { a: "npm run b && npm run c", b: "x", c: "y" } })
  return {
    command: "npm run a",
    cwd,
    env: extra.env ?? {},
    runner: extra.runner,
    leads: extra.leads ?? false,
    files: [[cwd === "" ? "package.json" : `${cwd}/package.json`, manifest], ...(extra.files ?? [])]
  }
})

describe("Script against the Lean specification", () => {
  it.skipIf(!oracleReady)("lists the package managers' own commands the specification lists", async () => {
    const listed = await ask({ op: "script.commands" }) as Readonly<Record<string, ReadonlyArray<string>>>
    expect([...(listed["pnpm"] ?? [])].sort()).toEqual([...pnpmCommands].sort())
    expect([...(listed["yarn"] ?? [])].sort()).toEqual([...yarnCommands].sort())
    // Every word either list names is no script: `runOf` is asked of each.
    const own = [...(listed["pnpmOwn"] ?? []), ...(listed["yarnOwn"] ?? []), ...pnpmCommands, ...yarnCommands]
    await assertCorpus(
      managers.flatMap((manager) => own.map((word) => [manager, word, "x"])),
      runOfProblems
    )
  })

  it.skipIf(!oracleReady)("reads a script run as the specification does", async () => {
    await assertHolds(
      Arbitrary.array(
        soup([
          "npm",
          "pnpm",
          "yarn",
          "bun",
          "run",
          "run-script",
          "test",
          "-",
          "--",
          "x",
          "install",
          "constructor",
          " ",
          "=",
          "b",
          "workspace"
        ], 2),
        { maxLength: 6 }
      ),
      runOfProblems,
      { runs: 400, seed: 11 }
    )
    await assertHolds(Arbitrary.array(anyString, { maxLength: 4 }), runOfProblems, { runs: 200, seed: 12 })
  })

  it.skipIf(!oracleReady)(
    "decides the cycles, hooks and prototype names of the corpus as the specification does",
    async () => {
      await assertCorpus(decideCorpus, decideProblems)
      await assertCorpus(settingCorpus, decideProblems)
    }
  )

  it.skipIf(!oracleReady)("decides generated script graphs as the specification does", async () => {
    await assertHolds(built(scriptCase, 400), decideProblems, { runs: 500, seed: 13 })
  })

  it.skipIf(!oracleReady)("decides hostile commands and manifests as the specification does", async () => {
    await assertHolds(
      Arbitrary.all([
        soup([...shellPieces, "npm run ", "pnpm ", "yarn ", "bun run ", ...scriptNames]),
        soup([
          "{",
          "}",
          "\"scripts\"",
          ":",
          "\"a\"",
          "\"npm run a && npm run b\"",
          ",",
          "[",
          "]",
          "null",
          "1",
          "\"__proto__\"",
          "\"b\"",
          "\"x\"",
          " "
        ], 20),
        soup(["", "packages/a", "..", "/", "${{ x }}", "a/"], 1)
      ]),
      ([command, manifest, cwd]) =>
        decideProblems({
          command,
          cwd,
          env: {},
          runner: undefined,
          leads: false,
          files: [["package.json", manifest], [`${Workspace.join("", cwd) ?? ""}/package.json`, manifest]]
        }),
      { runs: 300, seed: 14 }
    )
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------------------------------------------

const patternSegments = [
  "packages",
  "apps",
  "*",
  "**",
  "a*",
  "*-ui",
  "p*s",
  "a",
  "b",
  "web",
  "a*b*c",
  "***",
  "",
  ".",
  "..",
  "x?",
  "{a,b}",
  "[ab]",
  "é*",
  "😀*",
  "*a*",
  "node_modules"
]
const directoryNames = [
  "packages",
  "apps",
  "a",
  "b",
  "web",
  "core-ui",
  "abc",
  "axbxc",
  "é1",
  "😀x",
  "node_modules",
  "aa",
  "p-s"
]

interface DirectoriesCase {
  readonly patterns: ReadonlyArray<string>
  readonly files: ReadonlyArray<string>
}

const directoriesCase = (tape: Tape): DirectoriesCase => ({
  patterns: several(
    tape,
    3,
    () =>
      `${tape.chance(5) ? "!" : ""}${tape.chance(8) ? "./" : ""}${
        Array.from({ length: tape.next(3) + 1 }, () => tape.pick(patternSegments)).join("/")
      }${tape.chance(8) ? "/" : ""}`
  ),
  files: [
    ...new Set(
      Array.from(
        { length: tape.next(10) + 1 },
        () =>
          `${Array.from({ length: tape.next(4) + 1 }, () => tape.pick(directoryNames)).join("/")}${
            tape.pick([
              "/package.json",
              "/package.json",
              "/package.json",
              "/index.ts",
              "package.json",
              "/package.json5"
            ])
          }`
      )
    )
  ]
})

const directoriesProblems = async (input: DirectoriesCase): Promise<ReadonlyArray<string>> =>
  differs(
    "packageDirectories",
    Workspace.packageDirectories(input.patterns, new Set(input.files)),
    await ask({ op: "workspace.packageDirectories", ...input })
  )

const joinProblems = async ([directory, relative]: readonly [string, string]): Promise<ReadonlyArray<string>> =>
  differs(
    `join(${JSON.stringify(directory)}, ${JSON.stringify(relative)})`,
    Workspace.join(directory, relative),
    await ask({ op: "workspace.join", directory, relative })
  )

const packagePlaces = ["packages/a", "packages/b", "apps/web", "libs/core", "packages/a/nested", "tools", "packages/c"]
const packageNames = ["a", "@s/b", "core", "ui", "x-y", "@s/c", "web"]
const packageFiles = [
  "package.json",
  "src/index.ts",
  "src/a.ts",
  "b.js",
  "lib/c.tsx",
  "src/util/index.ts",
  "src/d.mts",
  "e.json"
]
const relativePaths = [
  "./a",
  "./a.js",
  "../b",
  "../../packages/b/src/index",
  "./missing",
  "../ui",
  "..",
  "./util",
  "../../apps/web/b.js",
  "../../../out",
  "../../libs/core",
  "../src/a",
  "./src/d.mjs",
  "../../tools/e",
  "./nested/src/index.ts",
  "../.."
]
const rootedPaths = [
  "packages/a/src/a.ts",
  "packages/b",
  "apps/web/missing",
  "libs/core/src/index",
  "packages/a/nested/b",
  "tools/../apps/web/b.js",
  "packages/../..",
  "README.md",
  "packages/c/lib/c"
]

interface ReachCase {
  readonly unknown: ReadonlyArray<string>
  readonly packages: ReadonlyArray<Workspace.Package>
  readonly files: ReadonlyArray<string>
  readonly mentions: ReadonlyArray<readonly [file: string, mentions: Workspace.Mentions]>
  readonly start: { readonly package: string } | { readonly file: string }
  readonly owner: string
}

const workspacePackages = (tape: Tape): ReadonlyArray<Workspace.Package> => {
  const count = tape.next(5) + 1
  const names = packageNames.slice(0, count)
  return names.map((name, index) => ({
    name,
    directory: packagePlaces[index] as string,
    scripts: Object.fromEntries(
      ["build", "test", "lint", "dev"].filter(() => !tape.chance(3)).map((script) => [script, "x"])
    ),
    dependencies: names.filter((other) => (other !== name || tape.chance(6)) && tape.chance(4)).sort()
  }))
}

const reachCase = (tape: Tape): ReachCase => {
  const packages = workspacePackages(tape)
  const owned = packages.flatMap((owner) =>
    packageFiles.filter(() => !tape.chance(3)).map((file) => `${owner.directory}/${file}`)
  )
  const files = [...new Set([...owned, "README.md", "scripts/x.mjs", "packages/README.md"])]
  const names = packages.map((owner) => owner.name)
  const mentions = files.filter(() => tape.chance(2)).map((file) =>
    [file, {
      names: tape.chance(4) ? several(tape, 2, () => tape.pick(names)) : [],
      relative: several(tape, 3, () => tape.pick(relativePaths)),
      rooted: several(tape, 2, () => tape.pick(rootedPaths))
    }] as const
  )
  const start = owned.length > 0 && tape.chance(3)
    ? { file: tape.pick(owned) }
    : { package: tape.pick(names) }
  return {
    packages,
    files,
    mentions,
    unknown: files.filter(() => tape.chance(7)),
    start,
    owner: tape.pick([...files, ...rootedPaths, "", "packages", "packages/a/"])
  }
}

const workspaceOf = (packages: ReadonlyArray<Workspace.Package>): Workspace.Workspace => ({
  manager: "pnpm",
  rootName: undefined,
  rootScripts: {},
  packages,
  orchestrated: false
})

const packageView = (owner: Workspace.Package): unknown => ({
  name: owner.name,
  directory: owner.directory,
  dependencies: owner.dependencies,
  scripts: Object.keys(owner.scripts)
})

const reachProblems = async (input: ReachCase): Promise<ReadonlyArray<string>> => {
  const mentioned = new Map(input.mentions)
  const graph = Workspace.graph(
    workspaceOf(input.packages),
    new Set(input.files),
    (file) => mentioned.get(file) ?? { names: [], relative: [], rooted: [] },
    new Set(input.unknown)
  )
  const start = "file" in input.start
    ? input.start.file
    : input.packages.find((owner) =>
      "package" in input.start && owner.name === input.start.package
    ) as Workspace.Package
  const reach = graph.reachOf(start)
  count(`reach:${Math.min(reach.packages.size, 3)} packages, ${Math.min(reach.files.size, 2)} files`)
  return differs(
    "reachOf",
    { packages: [...reach.packages].sort(), files: [...reach.files].sort(), owner: graph.ownerOf(input.owner)?.name },
    await ask({
      op: "workspace.reach",
      packages: input.packages.map(packageView),
      files: input.files,
      mentions: input.mentions,
      unknown: input.unknown,
      start: input.start,
      owner: input.owner
    })
  )
}

const resolveProblems = async (
  [path, files]: readonly [string, ReadonlyArray<string>]
): Promise<ReadonlyArray<string>> =>
  differs(
    `resolveFile(${JSON.stringify(path)})`,
    Workspace.resolveFile(path, new Set(files)),
    await ask({ op: "workspace.resolveFile", path, files })
  )

describe("Workspace against the Lean specification", () => {
  it.skipIf(!oracleReady)("joins paths as the specification does", async () => {
    await assertHolds(
      Arbitrary.array(soup(["a", "b", "..", ".", "/", "c.d", "", "é", "😀"], 6), { minLength: 2, maxLength: 2 }),
      ([directory, relative]) => joinProblems([directory as string, relative as string]),
      { runs: 400, seed: 21 }
    )
    await assertHolds(Arbitrary.all([anyString, anyString]), joinProblems, { runs: 200, seed: 22 })
  })

  it.skipIf(!oracleReady)("matches workspace patterns as the specification does", async () => {
    await assertCorpus<DirectoriesCase>([
      {
        patterns: ["**", "packages/**/.kept/*", ".tools/**"],
        files: [".tools/task/package.json", "packages/x/.kept/y/package.json", "packages/.hidden/z/package.json"]
      },
      { patterns: ["packages/*"], files: ["packages/a/package.json", "packages/a/b/package.json", "package.json"] },
      { patterns: ["**"], files: ["a/package.json", "a/b/c/package.json", "node_modules/x/package.json"] },
      { patterns: ["a*a*a*z"], files: ["aaaaaaaaaaaa/package.json", "aaaz/package.json", "az/package.json"] },
      {
        patterns: ["packages/**", "!packages/**/test"],
        files: ["packages/a/package.json", "packages/a/test/package.json"]
      },
      {
        patterns: ["**/**/a"],
        files: ["a/package.json", "x/a/package.json", "x/y/z/a/package.json", "a/x/package.json"]
      },
      {
        patterns: ["**/src*/unit/**/test", "!**/src-old/unit/**"],
        files: [
          "src-old/integration/src-new/unit/test/package.json",
          "src-old/unit/src-new/unit/test/package.json",
          "src-new/tests/unit/test/package.json"
        ]
      },
      { patterns: ["*"], files: ["/package.json", "a/package.json", "a//package.json"] },
      { patterns: ["a/../b"], files: ["b/package.json"] },
      { patterns: [], files: ["b/package.json"] },
      { patterns: ["!a"], files: ["a/package.json"] },
      { patterns: ["./a/", "!!a"], files: ["a/package.json", "!a/package.json"] }
    ], directoriesProblems)
    await assertHolds(built(directoriesCase, 128), directoriesProblems, { runs: 400, seed: 23 })
  })

  it.skipIf(!oracleReady)("resolves a path to a file as the specification does", async () => {
    await assertHolds(
      built((tape): readonly [string, ReadonlyArray<string>] => [
        `${tape.pick(["a", "src/a", "b", "src", "x"])}${
          tape.pick(["", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".json", "/"])
        }`,
        subsetOf(tape, [
          "a",
          "a.ts",
          "a.tsx",
          "a.js",
          "a.mts",
          "a.cts",
          "a.json",
          "src/a.ts",
          "src/a.tsx",
          "src/index.ts",
          "src/index.json",
          "b.jsx",
          "b.tsx",
          "b/index.cjs",
          "x.mjs",
          "a.js.ts",
          "a/index.ts"
        ])
      ]),
      resolveProblems,
      { runs: 300, seed: 24 }
    )
  })

  it.skipIf(!oracleReady)("reaches the packages and files the specification reaches", async () => {
    await assertHolds(built(reachCase, 320), reachProblems, { runs: 400, seed: 25 })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Turbo
// ---------------------------------------------------------------------------------------------------------------

const taskNames = ["build", "test", "lint", "dev", "x#y"]

interface WalkCase {
  readonly packages: ReadonlyArray<Workspace.Package>
  readonly root: string
  readonly own: ReadonlyArray<readonly [name: string, text: string]>
  readonly start: string
  readonly tasks: ReadonlyArray<string>
}

const turboTasks = (tape: Tape, names: ReadonlyArray<string>, own: boolean): string => {
  const entry = (): string =>
    tape.pick([
      ...taskNames,
      ...taskNames.map((task) => `^${task}`),
      ...names.flatMap((name) => taskNames.slice(0, 3).map((task) => `${name}#${task}`)),
      "//#build",
      "^//#x",
      "missing#build",
      "#",
      ...(own ? ["$TURBO_EXTENDS$"] : [])
    ])
  const input = (): string =>
    tape.pick([
      "src/**",
      "$TURBO_ROOT$/tsconfig.json",
      "$TURBO_ROOT$/assets/**/*.json",
      "$TURBO_ROOT$/packages/*/../shared.json",
      "$TURBO_ROOT$/",
      "../shared/**",
      "!../shared/**",
      "./../shared/**",
      "$TURBO_ROOT$/shared/../assets",
      "../../x",
      "../../../out",
      "..",
      "../",
      "$TURBO_DEFAULT$",
      ...(own ? ["$TURBO_EXTENDS$"] : [])
    ])
  const keys = [
    ...new Set([
      ...taskNames.filter(() => !tape.chance(4)),
      ...subsetOf(tape, names.flatMap((name) => taskNames.slice(0, 2).map((task) => `${name}#${task}`))),
      ...(tape.chance(6) ? ["//#build"] : [])
    ])
  ]
  return JSON.stringify({
    tasks: Object.fromEntries(keys.map((key) => [
      key,
      tape.chance(10) ? null : {
        ...(tape.chance(4) ? {} : { dependsOn: several(tape, 3, entry) }),
        ...(tape.chance(3) ? { with: several(tape, 2, entry) } : {}),
        ...(tape.chance(2) ? {} : { inputs: several(tape, 3, input) })
      }
    ]))
  })
}

const walkCase = (tape: Tape): WalkCase => {
  const packages = workspacePackages(tape)
  const names = packages.map((owner) => owner.name)
  return {
    packages,
    root: turboTasks(tape, names, false),
    own: names.filter(() => tape.chance(3)).map((name) => [name, turboTasks(tape, names, true)] as const),
    start: tape.pick(names),
    tasks: Array.from({ length: tape.next(3) + 1 }, () => tape.pick(taskNames))
  }
}

const taskView = (tasks: ReadonlyMap<string, Turbo.Task>): unknown => [...tasks]

const walkProblems = async (input: WalkCase): Promise<ReadonlyArray<string>> => {
  const config = Turbo.readConfig(input.root, input.own)
  if (config === undefined) return ["the generated configuration is not read"]
  const start = input.packages.find((owner) => owner.name === input.start) as Workspace.Package
  const walked = Turbo.walk(config, workspaceOf(input.packages), start, input.tasks)
  count(
    `walk:${Math.min(walked.scripts.length, 3)} scripts${walked.root ? ", root" : ""}${
      walked.globs.length > 0 ? ", globs" : ""
    }`
  )
  return differs(
    "walk",
    {
      packages: walked.packages.map((owner) => owner.name),
      scripts: walked.scripts.map(([owner, script]) => [owner.name, script]),
      globs: walked.globs,
      root: walked.root
    },
    await ask({
      op: "turbo.walk",
      config: {
        tasks: taskView(config.tasks),
        packages: [...config.packages].map(([name, tasks]) => [name, taskView(tasks)])
      },
      packages: input.packages.map(packageView),
      start: input.start,
      tasks: input.tasks
    })
  )
}

describe("Turbo against the Lean specification", () => {
  it.skipIf(!oracleReady)("keeps two tasks apart that are spelled the same with `#`", async () => {
    // `a#x#y` names the task `x#y` of `a`, and `^y` the task `y` of the package `a#x`.
    const packages: ReadonlyArray<Workspace.Package> = [
      { name: "a", directory: "packages/a", scripts: { "x#y": "one" }, dependencies: [] },
      { name: "a#x", directory: "packages/ax", scripts: { y: "two" }, dependencies: [] },
      { name: "b", directory: "packages/b", scripts: { build: "tsc" }, dependencies: ["a#x"] }
    ]
    const root = JSON.stringify({ tasks: { build: { dependsOn: ["^y", "a#x#y"] }, y: {}, "x#y": {} } })
    await assertCorpus<WalkCase>([{ packages, root, own: [], start: "b", tasks: ["build"] }], walkProblems)
  })

  it.skipIf(!oracleReady)("walks generated task graphs to the fixed point the specification reaches", async () => {
    await assertHolds(built(walkCase, 320), walkProblems, { runs: 400, seed: 31 })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------------------------

const sources = ["github-actions", "justfile", "package-json"] as const

const jobsOf = (tape: Tape): ReadonlyArray<Job> => {
  const ids = Array.from({ length: tape.next(8) + 1 }, (_, index) => `j${index}`)
  return ids.map((id): Job => ({
    id,
    source: tape.pick(sources),
    file: tape.pick(["Justfile", "Justfile", "ci.yml", "package.json"]),
    name: id,
    needs: [...new Set(Array.from({ length: tape.next(4) }, () => tape.pick([...ids, "missing"])))],
    triggers: ["push"],
    matrix: [],
    steps: Array.from({ length: tape.next(4) }, (_, index) => stepOf("echo ok", { id: `${id}:${index}` })),
    unsupported: []
  }))
}

const jobView = (job: Job): unknown => ({
  id: job.id,
  needs: job.needs,
  github: job.source === "github-actions",
  file: job.file,
  steps: job.steps.length
})

const placesOf = (jobs: ReadonlyArray<Job>, steps: ReadonlySet<Step>): ReadonlyArray<readonly [number, number]> =>
  jobs.flatMap((job, at) => job.steps.flatMap((step, index) => steps.has(step) ? [[at, index] as const] : []))

const jobProblems = async (jobs: ReadonlyArray<Job>): Promise<ReadonlyArray<string>> => {
  const view = jobs.map(jobView)
  return [
    ...differs("treeOrder", [...treeOrder(jobs)], await ask({ op: "plan.treeOrder", jobs: view })),
    ...differs("followed", placesOf(jobs, Plan.followed(jobs)), await ask({ op: "plan.followed", jobs: view })),
    ...differs("preceded", placesOf(jobs, Plan.preceded(jobs)), await ask({ op: "plan.preceded", jobs: view }))
  ]
}

describe("Plan against the Lean specification", () => {
  it.skipIf(!oracleReady)("tracks directory changes through AND-OR lists as the specification does", async () => {
    await assertCorpus([
      "cd missing && true || pnpm run test",
      "cd a && echo ready && true || pnpm run test",
      "cd a && true | tee out.log || pnpm run test",
      "cd a && true && pnpm run test",
      "cd a && cd b && pnpm run test",
      "cd a && true && cd b && pnpm run test",
      "cd a && test x = y && cd b; pnpm test",
      "cd a && true; echo ready || pnpm run test",
      "cd a && true\necho ready || pnpm run test",
      "if test -n x; then cd a && true; fi; echo ready || pnpm run test",
      "if test -n \"$X\"; then cd a && true; fi; echo ready || pnpm run test"
    ], async (script) => {
      const cwd = ""
      const located = Plan.understand(stepOf(script, { cwd }), workspaceOf([]))?.runs.map(({ invocation }) =>
        invocation.selection.kind === "directory" ? invocation.selection.directory : null
      )
      return differs(
        "directories",
        located ?? null,
        await ask({ op: "plan.directories", script, cwd, program: "pnpm" })
      )
    })
  })

  it.skipIf(!oracleReady)("widens unsupported input globs as the specification does", async () => {
    const outside = ["*", "packages/*", "docs/**"]
    const reaches = [{ packages: ["packages/a"], files: ["packages/a/file", "packages/b/file"] }]
    const view = reaches.map(({ packages, files }) => ({ packages: new Set(packages), files: new Set(files) }))
    await assertCorpus(
      [
        ["*", "extras/*", "assets/**", "root.json", "docs/guide.md"],
        ["**", "file"],
        ...["", "/**", "!shared/**", "a/***", "a/*.json", "a/[a]", "a/{x,y}", "a/../b", "packages/a/**/*.json"].map((
          glob
        ) => [glob])
      ],
      async (globs) =>
        differs(
          "inputsOf",
          Plan.inputsOf(outside, view, globs),
          await ask({ op: "plan.inputsOf", outside, reaches, globs })
        )
    )
  })

  it.skipIf(!oracleReady)("orders the jobs of each tree as the specification does", async () => {
    await assertHolds(built(jobsOf, 128), jobProblems, { runs: 500, seed: 41 })
  })

  it.skipIf(!oracleReady)("orders a deep chain and a cycle as the specification does", async () => {
    const job = (id: string, needs: ReadonlyArray<string>): Job => ({
      id,
      source: "justfile",
      file: "Justfile",
      name: id,
      needs,
      triggers: [],
      matrix: [],
      steps: [stepOf("echo ok", { id: `${id}:0` })],
      unsupported: []
    })
    const chain = Array.from({ length: 300 }, (_, index) => job(`j${index}`, index === 0 ? [] : [`j${index - 1}`]))
    await assertCorpus([
      chain,
      [...chain].reverse(),
      [job("a", ["b"]), job("b", ["c"]), job("c", ["a"])],
      [job("a", ["a"])],
      [job("ci", ["build", "test"]), job("build", []), job("test", ["build"])],
      [job("a", []), job("a", ["b"]), job("b", [])]
    ], jobProblems)
  })
})

describe("the Lean specification", () => {
  it.skipIf(!oracleReady)("answered every question", () => {
    expect(waiting).toEqual([])
    // Every outcome was generated, so each of them was compared and none of the properties held for want of cases.
    expect([...census.keys()].filter((label) => /^(?:shell|decide):/.test(label)).sort()).toEqual([
      "decide:links",
      "decide:none",
      "decide:script-arguments",
      "decide:script-command",
      "decide:script-cycle",
      "decide:script-first",
      "decide:script-hook",
      "decide:script-limit",
      "decide:script-release",
      "decide:script-setting",
      "decide:script-syntax",
      "shell:conditional",
      "shell:read",
      "shell:refused"
    ])
    for (
      const label of ["decide:links", "shell:conditional", "reach:1 packages, 1 files", "walk:3 scripts, root, globs"]
    ) {
      expect(census.get(label) ?? 0, label).toBeGreaterThan(0)
    }
    expect(asked).toBeGreaterThan(5000)
  })
})
