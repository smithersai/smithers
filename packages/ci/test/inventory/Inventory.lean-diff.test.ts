/**
 * Differential tests: the Lean 4 reference in `spec/lean/inventory` against `Expression.ts`, the `settled` verdict
 * of `Runner.ts`, `Matrix.vibe` and `Glob.vibe`.
 *
 * The reference is a program (`inventory-spec`) that answers one JSON question a line. It is started once, and every
 * generated case asks it the question the implementation was just asked. A host without Lean (no `lake`, no built
 * program) skips the suite; a host with `lake` builds the program first, so the answers are those of the sources.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll } from "vitest"
import { expand, jobTemporaryVariable, script, shell } from "../../src/contract/Inventory.vibe"
import { quote } from "../../src/decompose/Shell.vibe"
import * as Expression from "../../src/inventory/Expression.ts"
import { filesOf, regexOf } from "../../src/inventory/Glob.vibe"
import { startedIn } from "../../src/inventory/MachineChanges.vibe"
import { expandMatrix } from "../../src/inventory/Matrix.vibe"
import { settled, write } from "../../src/inventory/Runner.ts"
import { isLiteralSecret } from "../../src/inventory/Secrets.vibe"
import { asScalar, isRecord } from "../../src/inventory/Values.vibe"

const specDir = fileURLToPath(new URL("../../spec/lean/inventory", import.meta.url))
const binary = join(specDir, ".lake", "build", "bin", "inventory-spec")
const leanEnv = { ...process.env, PATH: [join(homedir(), ".elan", "bin"), process.env["PATH"] ?? ""].join(delimiter) }
const hasLake = spawnSync("lake", ["--version"], { env: leanEnv, stdio: "ignore" }).status === 0
const oracleReady = hasLake || existsSync(binary)

interface Waiting {
  readonly resolve: (answer: unknown) => void
  readonly reject: (why: Error) => void
}

let child: ChildProcessWithoutNullStreams | undefined
const waiting: Array<Waiting> = []
let asked = 0

/** Asks the reference one question. Answers come back in the order of the questions. */
const ask = (request: Readonly<Record<string, unknown>>): Promise<unknown> =>
  new Promise((resolve, reject) => {
    asked += 1
    waiting.push({ resolve, reject })
    ;(child as ChildProcessWithoutNullStreams).stdin.write(`${JSON.stringify(request)}\n`)
  })

beforeAll(() => {
  if (!oracleReady) return
  if (hasLake) {
    const built = spawnSync("lake", ["build"], { cwd: specDir, env: leanEnv, encoding: "utf8" })
    if (built.status !== 0) throw new Error(`lake build failed:\n${built.stdout}\n${built.stderr}`)
  }
  const started = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] })
  child = started
  let buffered = ""
  started.stdout.setEncoding("utf8")
  // Lines are split here on "\n" alone: `readline` also splits on U+2028, which an answer may hold.
  started.stdout.on("data", (chunk: string) => {
    buffered += chunk
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const reply = JSON.parse(buffered.slice(0, end)) as { readonly ok?: unknown; readonly error?: string }
      buffered = buffered.slice(end + 1)
      const next = waiting.shift() as Waiting
      if (reply.error === undefined) next.resolve(reply.ok)
      else next.reject(new Error(`the reference refused the question: ${reply.error}`))
    }
  })
  started.on("exit", (code) => {
    for (const next of waiting.splice(0)) next.reject(new Error(`the reference stopped with status ${code}`))
  })
})

afterAll(() => {
  child?.stdin.end()
})

// ---------------------------------------------------------------------------------------------------------------
// Values on the wire. JSON drops NaN, -0, the order of a mapping's fields and which list is which, so a number
// travels as its bits, a mapping as its fields in order, and a list or mapping with the identity it was given.
// ---------------------------------------------------------------------------------------------------------------

type Wire =
  | null
  | boolean
  | string
  | { readonly n: string }
  | { readonly a: ReadonlyArray<Wire>; readonly i: number }
  | { readonly o: ReadonlyArray<readonly [string, Wire]>; readonly i: number }

const identities = new WeakMap<object, number>()
let lastIdentity = 0

/** Gives a list or mapping an identity, as one a context holds has. One an expression makes has none (0). */
const known = <A extends object>(held: A): A => {
  lastIdentity += 1
  identities.set(held, lastIdentity)
  return held
}

const bits = (held: number): string => {
  if (Number.isNaN(held)) return "7ff8000000000000"
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, held)
  return view.getBigUint64(0).toString(16).padStart(16, "0")
}

const wire = (held: unknown): Wire => {
  if (held === null || typeof held === "boolean" || typeof held === "string") return held
  if (typeof held === "number") return { n: bits(held) }
  if (Array.isArray(held)) return { a: held.map(wire), i: identities.get(held) ?? 0 }
  const fields = held as Readonly<Record<string, unknown>>
  return { o: Object.entries(fields).map(([key, item]) => [key, wire(item)] as const), i: identities.get(fields) ?? 0 }
}

const wireResidual = (node: Expression.Residual): unknown => {
  if (node.kind === "literal") return { kind: "literal", value: wire(node.value) }
  if (node.kind === "variable") return node
  if (node.kind === "not") return { kind: "not", operand: wireResidual(node.operand) }
  if (node.kind === "call") return { kind: "call", name: node.name, args: node.args.map(wireResidual) }
  return { kind: "binary", operator: node.operator, left: wireResidual(node.left), right: wireResidual(node.right) }
}

const wireEvaluated = (result: Expression.Evaluated): unknown =>
  result.kind === "ok" ? { kind: "ok", residual: wireResidual(result.residual) } : result

const wireFinished = (result: Expression.Finished): unknown =>
  result.kind === "ok" ? { kind: "ok", value: wire(result.value) } : result

// ---------------------------------------------------------------------------------------------------------------
// Generation. Every case is built from a tape of small numbers, which `effect/Arbitrary` generates from a fixed
// seed and shrinks: a shorter tape or smaller numbers give a simpler case of the same kind.
// ---------------------------------------------------------------------------------------------------------------

const tape = Arbitrary.array(Arbitrary.schema(Schema.Literals(Array.from({ length: 240 }, (_, n) => n))), {
  minLength: 24,
  maxLength: 160
})

interface Dice {
  readonly next: (bound: number) => number
  readonly pick: <A>(items: ReadonlyArray<A>) => A
  readonly chance: (oneIn: number) => boolean
}

/** Reads a tape. Past its end it starts over with every number moved on, so a short tape still varies. */
const diceOf = (numbers: ReadonlyArray<number>): Dice => {
  let at = 0
  const next = (bound: number): number => {
    const turn = Math.floor(at / numbers.length)
    const raw = (numbers[at % numbers.length] as number) + 37 * turn
    at += 1
    return raw % bound
  }
  return {
    next,
    pick: (items) => items[next(items.length)] as (typeof items)[number],
    chance: (oneIn) => next(oneIn) === 0
  }
}

/** How many cases were compared, and how they came out: a suite whose cases all end one way would prove little. */
const counts = {
  expressions: 0,
  literal: 0,
  residual: 0,
  problem: 0,
  secret: 0,
  finished: 0,
  verdicts: 0,
  matrices: 0,
  expanded: 0,
  refused: 0,
  globs: 0,
  named: 0,
  missed: 0,
  outside: 0
}

const property = (seed: number, runs: number, check: (dice: Dice) => Promise<void>) =>
  Effect.gen(function*() {
    const result = yield* Arbitrary.checkEffect(
      tape,
      (numbers) => Effect.promise(() => check(diceOf(numbers)).then(() => true)),
      { seed, runs }
    )
    if (result._tag !== "Passed") expect.fail(Arbitrary.formatCheckFailure(result))
  })

const many = <A>(dice: Dice, most: number, make: () => A): Array<A> => Array.from({ length: dice.next(most + 1) }, make)

// U+03A3 (capital sigma) is left out everywhere: its lower case depends on the letters around it, which the
// reference does not model. A lone surrogate is left out too: a Lean string cannot hold one.
// dprint-ignore
const texts = [
  "", "a", "A", "abc", "ABC", "aBc", "é", "É", "ß", "SS", "ǆ", "Ǆ", "ǅ", "😀", "0", "1", " 1 ", "0x1F", "0X1f", "0o17",
  "0o19", "0O7", "1e3", "1E-2", "-.5", "+5", "1.", ".", "+", "Infinity", "-Infinity", "NaN", "true", "false", "null",
  "x'y", "a\nb", "{0}", "İ", "ı", "\u212A", "k", "ſ", "\u00A0 12\uFEFF", "0b11", "1_000", "１", "ﬁ", "FI", "\t", "é", "É",
  "1e999", "-1e-999", "0.1", "1,5", "0x", "0xg", "--1", "1e", ".e1", "12abc", "Array", "Object", "ή", "Ή", "я", "Я",
  "\u2028", "a\u0000b", "\\", "\"", "}}", "${{", "z", "Z", "ab", "b", "B"
]

// dprint-ignore
const numbers = [
  0, -0, 1, -1, 2, 10, 0.1, 1.5, -1.5, 1e21, 1e-7, 123456789012345680000, 5e-324, Number.NaN, Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY, 2 ** 53, 1e15, 999999999999999, 999999999999999.9, 0.000001, 0.00001234, 0.0000123456789,
  123456.789, 1 / 3, -2.5e-9, 1e16, 4.35, 255, 1e100, 1.7976931348623157e308, 0.1 + 0.2, 100, 1e5, 123456789012345.67,
  0.000099999999999999995, 1.0000000000000002, 2.5, 3.5, 1e14 + 0.5, 12345678901234567, 1.25e-5, 9.5e-6, 4294967295
]

const genNumber = (dice: Dice): number => {
  if (!dice.chance(3)) return dice.pick(numbers)
  const digits = Array.from({ length: 1 + dice.next(17) }, () => dice.next(10)).join("")
  return Number(`${dice.chance(4) ? "-" : ""}${digits}e${dice.next(50) - 30}`)
}

// dprint-ignore
const keys = [
  "a", "A", "b", "Key", "KEY", "key", "0", "1", "2", "10", "01", "constructor", "__proto__", "prototype", "toString",
  "length", "É", "é", "x y", "", "name", "outputs", "x-y", "_z"
]

const genValue = (dice: Dice, depth: number): Expression.Value => {
  const kind = dice.next(depth > 0 ? 9 : 6)
  if (kind === 0) return null
  if (kind === 1) return dice.chance(2)
  if (kind <= 3) return genNumber(dice)
  if (kind <= 5) return dice.pick(texts)
  if (kind <= 7) return known(many(dice, 4, () => genValue(dice, depth - 1)))
  return known(Object.fromEntries(many(dice, 4, () => [dice.pick(keys), genValue(dice, depth - 1)] as const)))
}

interface Built {
  readonly context: Expression.Context
  readonly wire: unknown
}

const builtValue = (held: Expression.Value): Built => ({
  context: Expression.value(held),
  wire: { k: "value", v: wire(held) }
})

const builtResidual = (residual: Expression.Residual): Built => ({
  context: { kind: "residual", residual },
  wire: { k: "residual", r: wireResidual(residual) }
})

const builtVariable = (id: string, name: string, nullable: boolean, typed: boolean): Built => ({
  context: Expression.variable(id, name, nullable, typed),
  wire: { k: "residual", r: { kind: "variable", variable: { id, name, nullable, typed } } }
})

const builtFields = (entries: ReadonlyArray<readonly [string, Built]>, exact: boolean): Built => {
  const byName = new Map(entries)
  return {
    context: Expression.fields((name) => byName.get(name)?.context, exact),
    wire: { k: "fields", exact, entries: [...byName].map(([name, built]) => [name, built.wire]) }
  }
}

const builtUnknown = (why: string): Built => ({ context: Expression.unknown(why), wire: { k: "unknown", why } })
const builtSecret = (name: string): Built => ({ context: { kind: "secret", name }, wire: { k: "secret", name } })

interface BuiltScope {
  readonly scope: Expression.Scope
  readonly wire: unknown
}

const genScope = (dice: Dice): BuiltScope => {
  const shared = genValue(dice, 2)
  const contexts = new Map<string, Built>([
    [
      "github",
      builtValue(
        known({
          Event: shared,
          ref: "refs/heads/Main",
          list: known([shared, shared, known({ name: "É" })]),
          1: "one",
          A: 1,
          a: 2,
          sha: null
        })
      )
    ],
    [
      "env",
      builtFields([["CI", builtValue("true")], ["ci", builtValue("lower")], [
        "HOME",
        builtVariable("env:HOME", "env.HOME", false, false)
      ]], true)
    ],
    [
      "steps",
      builtFields([
        [
          "build",
          builtFields([
            [
              "outputs",
              builtFields([["x", builtVariable("step:build:x", "steps.build.outputs.x", true, false)], [
                "k",
                builtValue(genValue(dice, 1))
              ]], false)
            ],
            ["outcome", builtVariable("step:build:outcome", "steps.build.outcome", false, false)]
          ], false)
        ],
        ["Mixed", builtValue("unreachable")]
      ], false)
    ],
    [
      "matrix",
      builtFields([["os", builtVariable("matrix:os", "matrix.os", true, false)], [
        "node",
        builtVariable("matrix:node", "matrix.node", true, true)
      ]], false)
    ],
    ["secrets", builtFields([["token", builtSecret("TOKEN")]], false)],
    ["vault", builtSecret("VAULT")],
    ["inputs", builtUnknown("inputs are given when the workflow is called")],
    ["lit", builtResidual({ kind: "literal", value: genValue(dice, 2) })],
    [
      "res",
      builtResidual({
        kind: "not",
        operand: { kind: "variable", variable: { id: "v", name: "v", nullable: true, typed: false } }
      })
    ],
    ["v", builtVariable("v", "v", true, false)],
    ["w", builtVariable("w", "w", false, false)],
    ["val", builtValue(genValue(dice, 3))]
  ])
  const status = dice.chance(3)
    ? undefined
    : { success: dice.chance(2), always: true, cancelled: dice.chance(2), failure: dice.chance(2) }
  const hash = dice.pick<Built | "echo" | undefined>([
    undefined,
    "echo",
    "echo",
    builtVariable("hash", "hashFiles(...)", false, false),
    builtUnknown("no files here"),
    builtSecret("HASH"),
    builtFields([], false)
  ])
  return {
    scope: {
      context: (name) => contexts.get(name)?.context,
      status,
      hashFiles: hash === undefined
        ? undefined
        : hash === "echo"
        ? (patterns) => Expression.value([...patterns])
        : () => hash.context
    },
    wire: {
      contexts: [...contexts].map(([name, built]) => [name, built.wire]),
      status: status === undefined ? null : [status.success, status.always, status.cancelled, status.failure],
      hash: hash === undefined ? null : hash === "echo" ? "echo" : hash.wire
    }
  }
}

const quoted = (text: string): string => `'${text.replaceAll("'", "''")}'`

// dprint-ignore
const numberLiterals = [
  "0", "-0", "1", "-1", "1.5", ".5", "-.5", "1.", "0x1F", "-0xff", "0X0", "-0x0", "1e3", "1E-2", "1e+2", "NaN", "nan",
  "Infinity", "INFINITY", "null", "Null", "true", "TRUE", "false", "0.1", "123456789012345678", "1e21", "1e-7", "1e999",
  "0.000001", "0xfffffffffffffffff", "1e", "1.e2", "00", "007", "0x", "1.5.2", "1_0", "-", "1e-400", "2.5e-324",
  "9007199254740993", "0.30000000000000004", "4.35", "1.7976931348623159e308", "5e-324", "1e15", "999999999999999.9"
]

// dprint-ignore
const jsonTexts = [
  "[1,]", "{\"a\":1,\"a\":2}", "{\"2\":1,\"1\":2,\"b\":0,\"01\":3,\"a\":4}", "01", "1.", "-", "\"\\u00e9\"",
  "\"\\ud83d\\ude00\"", " [ ] ", "{\"__proto__\":{\"x\":1}}", "1e999", "-0", "[1e-7,1E+2,0.5e1,-1.5E-3]", "nul",
  "\"a\\qb\"", "\"\t\"", "tru", "[[[[[]]]]]", "{\"a\":{\"b\":{\"c\":[1,{\"d\":null}]}}}", "\uFEFF1", "1 2", "",
  "\"\\u0000\\u001f\\b\\f\\n\\r\\t\\/\\\\\\\"\"", "{\"4294967294\":1,\"4294967295\":2,\"0\":3,\"-1\":4}", "{ \"a\" : [ ] }",
  "[1 ,2\n,\t3\r]", "{\"a\":1,}", "{a:1}", "'a'", "[", "{", "\"", "+1", ".5", "0x10", "1e", "1e+", "-0.0e-0", "true ",
  " null", "[null,true,false]", "\"\u2028\"", "{\"A\":1,\"a\":2}", "{\"constructor\":1,\"toString\":2}", "1E400",
  "123456789012345678901234567890", "0.000000000000000000000000000001", "{\"x\":\"é\",\"X\":\"É\"}", "\"\\u00E9\\u00e9\""
]

// dprint-ignore
const templates = [
  "{0}", "{0}-{1}", "{{{0}}}", "{{0}}", "{", "}", "{}", "{a}", "{0", "0}", "{1}{0}{1}", "{007}", "{2}", "}}{{", "{ 0}",
  "{0 }", "{-1}", "{99999999999999999999999}", "é{0}😀", "{0}{{", "a{{b}}c", "{{}", "{}}", "{10}", "", "{0}{0}", "{1"
]

// dprint-ignore
const pathNames = [
  "event", "Event", "EVENT", "ref", "list", "name", "a", "A", "1", "sha", "CI", "ci", "Ci", "HOME", "build", "outputs",
  "x", "k", "outcome", "os", "node", "token", "TOKEN", "constructor", "__proto__", "prototype", "toString", "length",
  "missing", "Mixed", "mixed", "key", "true", "null", "x-y", "_z", "é"
]

// dprint-ignore
const roots = [
  "github", "GitHub", "env", "steps", "matrix", "secrets", "vault", "inputs", "lit", "res", "v", "w", "val", "runner",
  "Val", "LIT"
]

const spaces = ["", " ", "  ", "\t", "\n", "\u00A0", "\u2028", "\uFEFF"]

const genExpression = (dice: Dice, depth: number): string => {
  const sub = (): string => genExpression(dice, depth - 1)
  const pad = (): string => (dice.chance(3) ? dice.pick(spaces) : " ")
  const path = (): string => {
    let text = dice.pick(roots)
    for (let hops = dice.next(4); hops > 0; hops -= 1) {
      const how = dice.next(8)
      const name = dice.pick(pathNames)
      if (how <= 2) text += `.${name}`
      else if (how === 3) text += `[${quoted(name)}]`
      else if (how === 4) {
        text += `[${dice.pick(["0", "1", "2", "-1", "1.5", "0x1", "-0", "1e0", "NaN", "'0'", "true"])}]`
      } else if (how === 5) text += ".*"
      else if (how === 6 && depth > 0) text += `[${sub()}]`
      else text += `${pad()}.${pad()}${name}`
    }
    return text
  }
  const atom = (): string => {
    if (dice.chance(12)) {
      return dice.pick(["secrets.token", "vault", "secrets.TOKEN", "secrets['Token']", "hashFiles(vault)"])
    }
    if (dice.chance(6)) return dice.pick(runtime)
    const how = dice.next(10)
    if (how <= 2) return path()
    if (how <= 4) return dice.pick(numberLiterals)
    if (how <= 7) return quoted(dice.pick(texts))
    if (how === 8) return quoted(dice.pick(jsonTexts))
    return quoted(dice.pick(templates))
  }
  if (depth <= 0) return atom()
  const how = dice.next(16)
  if (how === 0) return `!${pad()}${sub()}`
  if (how === 1) return `(${pad()}${sub()}${pad()})`
  if (how <= 5) {
    return `${sub()}${pad()}${dice.pick(["==", "!=", "<", "<=", ">", ">=", "&&", "||", "&&", "||"])}${pad()}${sub()}`
  }
  if (how === 6) {
    const name = dice.pick(["contains", "startsWith", "endsWith", "CONTAINS", "startswith", "EndsWith"])
    return `${name}(${sub()},${pad()}${sub()}${dice.chance(12) ? `, ${sub()}` : ""})`
  }
  if (how === 7) return `format(${quoted(dice.pick(templates))}${many(dice, 3, () => `, ${sub()}`).join("")})`
  if (how === 8) return `join(${sub()}${dice.chance(2) ? `, ${sub()}` : ""}${dice.chance(12) ? ", 1, 2" : ""})`
  if (how === 9) return `toJSON(${dice.chance(12) ? "" : sub()})`
  if (how === 10) {
    return `fromJSON(${dice.chance(3) ? sub() : quoted(dice.pick(jsonTexts))})${
      dice.chance(2) ? `.${dice.pick(pathNames)}` : ""
    }`
  }
  if (how === 11) {
    return `${dice.pick(["success", "always", "cancelled", "failure", "Success", "ALWAYS"])}(${
      dice.chance(6) ? sub() : ""
    })`
  }
  if (how === 12) return `hashFiles(${many(dice, 3, sub).join(", ")})`
  if (how === 13) return `${dice.pick(["nosuch", "tojson2", "hash-files", "_f"])}(${many(dice, 2, sub).join(",")})`
  if (how === 14) {
    return `fromJSON(${quoted(JSON.stringify(genValue(dice, 2)) ?? "null")})${
      dice.pick(["", ".*", "[0]", ".a", ".KEY", "['constructor']"])
    }`
  }
  return atom()
}

/** Expressions that read what is only known while the job runs. */
const runtime = [
  "v",
  "w",
  "steps.build.outputs.x",
  "steps.build.outcome",
  "matrix.os",
  "matrix.node",
  "env.HOME",
  "res",
  "V",
  "Steps.Build.Outputs.X",
  "hashFiles('a')"
]

/** An expression over values known only while the job runs, which mostly stays unfinished. */
const genOpen = (dice: Dice, depth: number): string => {
  const sub = (): string => genOpen(dice, depth - 1)
  const leaf = (): string => {
    const how = dice.next(6)
    if (how <= 1) return dice.pick(runtime)
    if (how <= 3) return quoted(dice.pick(texts))
    return dice.pick(["true", "false", "null", "0", "1", "''", "'x'", "val", "lit", "github.ref", "github.sha", "1.5"])
  }
  if (depth <= 0) return leaf()
  const how = dice.next(13)
  if (how === 0) return `!${sub()}`
  if (how === 1) return `(${sub()})`
  if (how <= 5) return `${sub()} ${dice.pick(["&&", "||"])} ${sub()}`
  if (how === 6) return `${sub()} ${dice.pick(["==", "!=", "<", "<=", ">", ">="])} ${sub()}`
  if (how === 7) return `${dice.pick(["contains", "startsWith", "endsWith"])}(${sub()}, ${sub()})`
  if (how === 8) return `format(${quoted(dice.pick(templates))}, ${sub()}, ${sub()})`
  if (how === 9) return `join(${sub()}, ${sub()})`
  if (how === 10) return `${dice.pick(["toJSON", "fromJSON"])}(${sub()})`
  if (how === 11) {
    return `${dice.pick(["false", "true", "''", "'x'", "v"])} ${dice.pick(["&&", "||"])} ${
      dice.pick(["secrets.token", "vault", "inputs.x"])
    }`
  }
  return leaf()
}

// dprint-ignore
const fragments = [
  "(", ")", "[", "]", "!", "x", "true", ".", "0", "==", "!=", "<=", ">=", "<", ">", "||", "&&", "'", "''", "${{", "}}",
  "\n", "\u0000", "雪", "😀", ",", "*", ".*", "-", "-1", "1.", ".5", "0x", "0xF", "1e", "1e5", "e", "_a-b", "a.b", "é",
  " ", "\u00A0", "\u2028", "\"", "#", "=", "&", "|", "contains(", "format(", "success(", "github", "val", "v", "@", "\\",
  "null", "NaN", "'a'", "'it''s'", "{", "}", "+", "/", "~", "`", "\r", "\uFEFF", "１", "ª", "-.", "..", "0x-1", "1e+"
]

const compareEvaluate = async (text: string, built: BuiltScope): Promise<Expression.Evaluated> => {
  counts.expressions += 1
  const mine = Expression.evaluate(text, built.scope)
  expect({ text, result: wireEvaluated(mine) }).toEqual({
    text,
    result: await ask({ op: "evaluate", text, scope: built.wire })
  })
  counts[mine.kind !== "ok" ? mine.kind : mine.residual.kind === "literal" ? "literal" : "residual"] += 1
  return mine
}

const knownValues = (dice: Dice): ReadonlyArray<Expression.Value> => [
  null,
  "",
  "x",
  "0",
  "true",
  "é",
  dice.pick(texts),
  dice.pick(texts),
  genNumber(dice),
  dice.chance(2),
  genValue(dice, 2)
]

/** Finishes an unfinished expression under generated values, and compares that, the variables and the verdict. */
const compareResidual = async (residual: Expression.Residual, dice: Dice): Promise<void> => {
  const node = wireResidual(residual)
  const read = Expression.variablesOf(residual)
  expect(read.map((found) => found.id)).toEqual(await ask({ op: "variablesOf", residual: node }))
  const verdict = settled(residual)
  expect({ node, verdict: verdict ?? null }).toEqual({ node, verdict: await ask({ op: "settled", residual: node }) })
  if (verdict !== undefined) counts.verdicts += 1
  for (let round = 0; round < 3; round += 1) {
    const pool = knownValues(dice)
    const values = new Map(
      read.map((found) => [found.id, found.nullable ? dice.pick(pool) : dice.pick(texts)] as const)
    )
    const mine = Expression.finish(residual, (found) => values.get(found.id) ?? null)
    const theirs = await ask({ op: "finish", residual: node, known: [...values].map(([id, held]) => [id, wire(held)]) })
    expect({ node, result: wireFinished(mine) }).toEqual({ node, result: theirs })
    counts.finished += 1
    // A verdict holds whatever text the variables hold, when none of them is a number or a boolean on GitHub.
    if (
      verdict !== undefined && mine.kind === "ok" &&
      [...values.values()].every((held) => held === null || typeof held === "string")
    ) {
      expect({ node, truthy: Expression.truthy(mine.value) }).toEqual({ node, truthy: verdict })
    }
  }
}

const genResidual = (dice: Dice, depth: number): Expression.Residual => {
  const sub = (): Expression.Residual => genResidual(dice, depth - 1)
  const how = dice.next(depth > 0 ? 12 : 4)
  if (how <= 1) return { kind: "literal", value: genValue(dice, 1) }
  if (how <= 3) {
    const id = dice.pick(["a", "b", "matrix:os", "c"])
    return { kind: "variable", variable: { id, name: id, nullable: id !== "b", typed: id === "c" } }
  }
  if (how === 4) return { kind: "not", operand: sub() }
  if (how <= 7) return { kind: "binary", operator: dice.pick(["&&", "||"]), left: sub(), right: sub() }
  if (how === 8) {
    return { kind: "binary", operator: dice.pick(["==", "!=", "<", "<=", ">", ">="]), left: sub(), right: sub() }
  }
  if (how === 9) {
    return { kind: "call", name: "format", args: [{ kind: "literal", value: dice.pick(templates) }, sub(), sub()] }
  }
  if (how === 10) return { kind: "call", name: dice.pick(["contains", "startswith", "endswith"]), args: [sub(), sub()] }
  return { kind: "call", name: dice.pick(["join", "tojson", "fromjson"]), args: [sub()] }
}

// dprint-ignore
const expressionCorpus: ReadonlyArray<string> = [
  "", " ", "'", "''", "'''", "''''", "'a''", "x[", "((true)", "true)", "a..b", "a.0", "a.*.*", "a[0][1]", ".5.5",
  "1 2", "-", "--1", "-0 == 0", "-0x0 == 0", "0x10 == 16", "1e2 == 100", "NaN == NaN", "NaN != NaN",
  "null == 0", "null == ''", "'' == 0", "'0' == false", "true == 1", "'true' == true", "' 1 ' == 1",
  "'0x10' == 16", "'0o17' == 15", "'0o19' == 19", "'1e3' == 1000", "'abc' == 'ABC'", "'ß' == 'SS'", "'é' == 'É'",
  "'ǆ' == 'Ǆ'", "'\u212A' == 'k'", "'ı' == 'I'", "'a' < 'B'", "'B' < 'a'", "'😀' < '\uFFFF'", "'a' < 1",
  "null < 1", "true > false", "'x' >= 'X'", "github == github", "github.list == github.list",
  "github.list[0] == github.event", "github.list[0] == github.list[1]", "fromJSON('[1]') == fromJSON('[1]')",
  "contains(github.list, github.event)", "contains(github.list.*.name, 'é')", "github.list.*.name",
  "github.*", "github.event.*", "val.*.*", "github.1", "github['1']", "github[1]", "github.a", "github.A",
  "github.constructor", "github.__proto__", "github['toString']", "github.list.length", "github.list[-1]",
  "github.list[0.5]", "github.list[1e0]", "github.list['0']", "github.list[true]", "github.ref.length",
  "env.CI", "env.ci", "env.Ci", "env.HOME", "env.HOME.x", "env", "steps", "steps.build", "steps.build.outputs.x",
  "steps.BUILD.Outputs.X", "steps.mixed", "steps.Mixed", "steps.build.outputs.x.y", "steps.build.outputs.k.*",
  "matrix.os == 'linux'", "matrix.node > 16", "!matrix.os", "secrets.token", "secrets.TOKEN", "secrets.other",
  "secrets", "vault", "vault.x", "vault[inputs]", "inputs", "inputs.x", "inputs[secrets.token]", "runner.os",
  "res", "res.x", "lit.a", "v && false", "v || true", "false && secrets.token", "true || secrets.token",
  "true && secrets.token", "v && secrets.token", "github[v]", "github[secrets.token]", "github.*[v]",
  "success()", "always()", "cancelled()", "failure()", "success(1)", "SUCCESS()", "always(secrets.token)",
  "hashFiles()", "hashFiles('a', 'b')", "hashFiles(1, null, true)", "hashFiles(v)", "hashFiles(v, secrets.token)",
  "hashFiles(secrets.token, v)", "hashfiles('x')", "contains()", "contains(1)", "contains(1, 2, 3)", "format()",
  "format('{0}')", "format('{0}', 1)", "format('{1}', 1)", "format('{', 1)", "format('{0}{', secrets.token)",
  "format(v, 1)", "format('{0}', v)", "join()", "join(1)", "join(github.list)", "join(github.list, ' ', 1)",
  "join(fromJSON('[1,null,true,[2],{}]'))", "join(fromJSON('[1,2]'), null)", "toJSON(github)", "toJSON(1e21)",
  "toJSON(NaN)", "toJSON(-0)", "toJSON('a\nb')", "toJSON(fromJSON('{}'))", "toJSON(fromJSON('[]'))",
  "fromJSON('')", "fromJSON(null)", "fromJSON(1)", "fromJSON(true)", "fromJSON('{\"A\":1,\"a\":2}').a",
  "fromJSON('{\"a\":1,\"A\":2}').A", "fromJSON('{\"__proto__\":1}').__proto__", "fromJSON('{}').constructor",
  "fromJSON('[]').length", "fromJSON('\"x\"').length", "nosuch()", "nosuch(secrets.token)", "a-b", "a_b", "_",
  "true.x", "null.x", "'a'.b", "1.x", "(1).x", "(github).ref", "!github", "!!github.sha", "!'0'", "!0", "!NaN",
  "1 < 2 < 3", "1 == 1 == 1", "1 || 2 && 3", "0 || '' || null", "'a' && 'b'", "1 == 2 || 3 == 3 && 4 != 4",
  "😀", "'😀", "\u2028true\u2028", "true\uFEFF", "\u0000", "#", "$", "@x", "${{ true }}", "1e999 == Infinity",
  "-1e999", "1e-999", "0.1 + 0.2", "1.7976931348623159e308", "123456789012345678", "0.000001", "0.0000001",
  "format('{0}', 0.000001)", "format('{0}', 1e15)", "format('{0}', 123456789012345678)", "format('{0}', 0.1)",
  "format('{0}', 1e-7)", "format('{0}', -1e21)", "format('{0}', 100)", "format('{0}', 1.5e-5)",
  "(".repeat(40) + "true" + ")".repeat(40), "val" + "['a']".repeat(40), "!".repeat(40) + "v"
]

describe("the Lean reference and Expression.ts agree", () => {
  it.live.skipIf(!oracleReady)(
    "on structured expressions over every kind of context, and on finishing what is left",
    () =>
      property(4101, 450, async (dice) => {
        const built = genScope(dice)
        const result = await compareEvaluate(genExpression(dice, 1 + dice.next(4)), built)
        if (result.kind === "ok" && result.residual.kind !== "literal") await compareResidual(result.residual, dice)
      })
  )

  it.live.skipIf(!oracleReady)(
    "on expressions that stay unfinished, their variables, their verdict and every way they finish",
    () =>
      property(4107, 300, async (dice) => {
        const built = genScope(dice)
        const result = await compareEvaluate(genOpen(dice, 1 + dice.next(4)), built)
        if (result.kind === "ok" && result.residual.kind !== "literal") await compareResidual(result.residual, dice)
      })
  )

  it.live.skipIf(!oracleReady)(
    "on hostile text: token fragments, stray quotes, odd spaces and unfinished numbers",
    () =>
      property(4102, 450, async (dice) => {
        const built = genScope(dice)
        await compareEvaluate(many(dice, 14, () => dice.pick(fragments)).join(""), built)
        await compareEvaluate(
          many(dice, 5, () => dice.pick([...fragments, ...numberLiterals, ...roots])).join(dice.pick(spaces)),
          built
        )
      })
  )

  it.live.skipIf(!oracleReady)(
    "on what a value is as a number, as text and as a truth",
    () =>
      property(4103, 300, async (dice) => {
        for (
          const held of [
            genValue(dice, 2),
            dice.pick(texts),
            genNumber(dice),
            `${dice.pick(spaces)}${dice.pick(numberLiterals)}${dice.pick(spaces)}`
          ]
        ) {
          const value = wire(held)
          counts.expressions += 1
          expect({ held, number: wire(Expression.toNumber(held)) }).toEqual({
            held,
            number: await ask({ op: "toNumber", value })
          })
          expect({ held, text: Expression.toText(held) }).toEqual({ held, text: await ask({ op: "toText", value }) })
          expect({ held, truthy: Expression.truthy(held) }).toEqual({
            held,
            truthy: await ask({ op: "truthy", value })
          })
        }
      })
  )

  it.live.skipIf(!oracleReady)(
    "on the functions: comparison without case, format, join and JSON both ways",
    () =>
      property(4104, 300, async (dice) => {
        const built = genScope(dice)
        const a = dice.chance(2) ? quoted(dice.pick(texts)) : dice.pick(numberLiterals)
        const b = dice.chance(2)
          ? quoted(dice.pick(texts))
          : dice.pick([...numberLiterals, "val", "lit", "github.list"])
        const json = quoted(dice.chance(2) ? dice.pick(jsonTexts) : JSON.stringify(genValue(dice, 3)) ?? "")
        for (
          const text of [
            `${a} ${dice.pick(["==", "!=", "<", "<=", ">", ">="])} ${b}`,
            `contains(${a}, ${b})`,
            `startsWith(${a}, ${b}) || endsWith(${a}, ${b})`,
            `contains(fromJSON(${json}), ${a})`,
            `toJSON(fromJSON(${json}))`,
            `join(fromJSON(${json}), ${a})`,
            `format(${
              quoted(many(dice, 4, () => dice.pick(templates)).join(dice.pick(texts)))
            }, ${a}, ${b}, fromJSON(${json}))`,
            `toJSON(${b})`,
            `format('{0}|{1}|{2}', ${dice.pick(numberLiterals)}, ${a}, ${b})`
          ]
        ) await compareEvaluate(text, built)
        const template = many(dice, 5, () => dice.pick([...templates, ...texts])).join("")
        const pieces = Expression.formatPieces(template)
        expect({ template, pieces: pieces === undefined ? null : pieces.map(wire) }).toEqual({
          template,
          pieces: await ask({ op: "formatPieces", text: template })
        })
      })
  )

  it.live.skipIf(!oracleReady)(
    "on text with expressions in it: where each starts and ends, and what filling gives",
    () =>
      property(4105, 300, async (dice) => {
        const built = genScope(dice)
        const piece = (): string =>
          dice.pick([
            () => `\${{ ${genExpression(dice, 2)} }}`,
            () => `\${{${dice.pick(fragments)}}}`,
            () => dice.pick(fragments),
            () =>
              dice.pick([
                "${{",
                "}}",
                "'",
                "$",
                "{",
                "}",
                " ",
                "text",
                "${{ 'a}}b' }}",
                "${{ v }}",
                "${{ '' }}",
                "${{ val }}"
              ])
          ])()
        const text = many(dice, 6, piece).join("")
        counts.expressions += 1
        const { pieces, rest } = Expression.split(text)
        expect({ text, split: { pieces, rest } }).toEqual({ text, split: await ask({ op: "split", text }) })
        for (const bare of [false, true]) {
          expect({ text, bare, whole: Expression.whole(text, bare) ?? null }).toEqual({
            text,
            bare,
            whole: await ask({ op: "whole", text, bare })
          })
        }
        const filled = Expression.fill(text, built.scope)
        const mine = filled.kind !== "ok" ? filled : {
          kind: "ok",
          parts: filled.parts.map((part) =>
            typeof part === "string" ? part : { residual: wireResidual(part.residual), written: part.written }
          )
        }
        expect({ text, filled: mine }).toEqual({ text, filled: await ask({ op: "fill", text, scope: built.wire }) })
      })
  )

  it.live.skipIf(!oracleReady)(
    "on the runner's verdict for conditions put together by hand",
    () =>
      property(4106, 300, async (dice) => {
        counts.expressions += 1
        await compareResidual(genResidual(dice, 1 + dice.next(4)), dice)
      })
  )

  it.live.skipIf(!oracleReady)(
    "on decisions made by the emitted runner for concrete matrix legs",
    () =>
      Effect.promise(async () => {
        const axis = "matrix:axis"
        const input = "process:CONTROL"
        const variable = (id: string, typed: boolean): Expression.Residual => ({
          kind: "variable",
          variable: { id, name: id, nullable: false, typed }
        })
        const selected = variable(axis, true)
        const conditions: ReadonlyArray<Expression.Residual> = [
          selected,
          { kind: "binary", operator: "==", left: selected, right: variable(input, false) },
          { kind: "binary", operator: "==", left: selected, right: { kind: "literal", value: "é" } }
        ]
        const values = [Number.NaN, -0, Infinity, -Infinity, "É", "雪"]
        const typedVariants = values.map((axis) => ({ axis }))
        const variants = values.map((value) => ({ axis: String(value) }))
        const job = { id: "compare", event: "{}", variables: {}, matrixKeys: ["axis"], variants, typedVariants }
        const command = "printf ran"
        const root = mkdtempSync(join(tmpdir(), "ci-inventory-oracle-"))
        try {
          for (const condition of conditions) {
            const written = write(job, {
              key: "CHECK",
              after: undefined,
              second: false,
              apart: false,
              job: job.id,
              before: [],
              cwd: "",
              directory: undefined,
              start: ["bash", "-e"],
              own: [],
              keeps: [],
              condition,
              outer: [],
              env: [],
              fills: [],
              commit: false
            }, command)
            if ("problem" in written) throw new Error(written.problem)
            const runner = script({ command, runner: written.alone })
            for (const [index, value] of values.entries()) {
              const control = typeof value === "number" ? "1e999" : value
              const expected = await ask({
                op: "runnerCondition",
                residual: wireResidual(condition),
                known: [[axis, wire(value)], [input, control]]
              })
              const actual = spawnSync(shell[0], [...shell.slice(1), expand(runner, variants[index]!)], {
                cwd: root,
                encoding: "utf8",
                env: {
                  PATH: process.env["PATH"],
                  HOME: root,
                  GITHUB_SHA: "0".repeat(40),
                  [jobTemporaryVariable]: root,
                  CONTROL: control
                }
              })
              expect({ value, status: actual.status, stderr: actual.stderr, output: actual.stdout }).toEqual({
                value,
                status: 0,
                stderr: "",
                output: expected ? "ran" : "smithers-ci: not run, its condition is false\n"
              })
            }
          }
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      })
  )

  it.live.skipIf(!oracleReady)("on a corpus of corner cases", () =>
    Effect.promise(async () => {
      const built = genScope(diceOf([3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9]))
      for (const text of expressionCorpus) {
        const result = await compareEvaluate(text, built)
        if (result.kind === "ok" && result.residual.kind !== "literal") {
          await compareResidual(result.residual, diceOf([text.length, 7, 1, 8, 2, 8]))
        }
      }
    }))
})

// ---------------------------------------------------------------------------------------------------------------
// Matrices
// ---------------------------------------------------------------------------------------------------------------

// dprint-ignore
const axisNames = [
  "os", "node", "a", "b", "a.b", "a.c", "", "1", "0", "__proto__", "constructor", "TOKEN", "api_key", "x.y.z", "a.b.c",
  "É", "password", "token_file"
]

// dprint-ignore
const scalars: ReadonlyArray<unknown> = [
  "a", "b", "linux", "macos", "18", "20", "1.0", 1, 1.5, 18, 20, true, false, null, "", "x${{ y }}", -0, 1e21, 0.1,
  "true", "é", "ghp_abcdefghijklmnopqrstuvwx", "hunter2", "${{ secrets.x }}", Number.NaN, "https://hooks.example/abcdefghijklmnopqrstuvwxyz"
]

const genMatrixValue = (dice: Dice, depth: number): unknown => {
  const how = dice.next(depth > 0 ? 14 : 10)
  if (how < 10) return dice.pick(scalars)
  if (how < 13) {
    return Object.fromEntries(
      many(
        dice,
        3,
        () => [dice.pick(["b", "c", "b.c", "", "password", "x", "1"]), genMatrixValue(dice, depth - 1)] as const
      )
    )
  }
  return many(dice, 2, () => dice.pick(scalars))
}

const genMatrix = (dice: Dice): unknown => {
  if (dice.chance(40)) return dice.pick([undefined, null, "${{ fromJSON(x) }}", [], 1, {}])
  const axes = many(
    dice,
    4,
    () =>
      [
        dice.pick(axisNames),
        dice.chance(15) ? dice.pick(scalars) : many(dice, 4, () => genMatrixValue(dice, 2))
      ] as const
  )
  const fromAxis = (): readonly [string, unknown] => {
    const [name, values] = dice.pick(axes.length > 0 ? axes : [["os", ["linux"]] as const])
    return [
      name,
      Array.isArray(values) && values.length > 0 && !dice.chance(5) ? dice.pick(values) : genMatrixValue(dice, 1)
    ]
  }
  const entry = (): unknown => {
    if (dice.chance(12)) return dice.pick([{}, "x", null, [], 1])
    return Object.fromEntries([
      ...many(dice, 3, fromAxis),
      ...many(
        dice,
        2,
        () => [dice.pick(["extra", "os", "a.b", "a", "TOKEN", "e.f", "e"]), genMatrixValue(dice, 2)] as const
      )
    ])
  }
  const lists = (): unknown => (dice.chance(15) ? dice.pick([null, "x", {}, 1]) : many(dice, 4, entry))
  return {
    ...Object.fromEntries(axes),
    ...(dice.chance(2) ? { exclude: lists() } : {}),
    ...(dice.chance(4) ? {} : { include: lists() })
  }
}

/** A matrix near the limit of 256 variants: lists whose sizes multiply to about that, with a few left out and added. */
const genLimitMatrix = (dice: Dice): unknown => {
  const sizes = dice.pick([
    [16, 16],
    [16, 17],
    [256],
    [257],
    [2, 128],
    [2, 129],
    [4, 8, 8],
    [4, 8, 9],
    [1, 256, 1],
    [300, 0],
    [0, 300],
    [255],
    [254],
    [3, 85],
    [3, 86],
    [2, 2, 2, 2, 2, 2, 2, 2],
    [2, 2, 2, 2, 2, 2, 2, 2, 2],
    [17, 15],
    [256, 0, 2],
    [128]
  ])
  const axes = sizes.map((size, at) => [`k${at}`, Array.from({ length: size }, (_, n) => n)] as const)
  const first = (): Record<string, unknown> =>
    Object.fromEntries(
      axes.map((
        [name],
        at
      ) => [name, dice.chance(3) ? dice.next(4) : at === 0 ? dice.next(Math.max(1, sizes[0] as number)) : 0])
    )
  return {
    ...Object.fromEntries(axes),
    exclude: many(dice, 3, first),
    include: many(
      dice,
      4,
      () => (dice.chance(3) ? { ...first(), extra: dice.next(3) } : { k0: `new${dice.next(3)}`, extra: dice.next(3) })
    )
  }
}

/** The names a value can have where it is used, and the texts it can hold: what `isLiteralSecret` may be asked. */
const secretsOf = (raw: unknown): ReadonlyArray<readonly [string, string]> => {
  const names = new Set<string>()
  const held = new Set<string>()
  const read = (value: unknown): void => {
    const scalar = asScalar(value)
    if (scalar !== undefined) held.add(scalar)
    else if (Array.isArray(value)) value.forEach(read)
    else if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        names.add(key.slice(key.lastIndexOf(".") + 1))
        read(item)
      }
    }
  }
  read(raw)
  return [...names].flatMap((name) =>
    [...held].filter((text) => isLiteralSecret(name, text)).map((text) => [name, text] as const)
  )
}

const sorted = (entries: ReadonlyArray<readonly [string, string]>): ReadonlyArray<readonly [string, string]> =>
  [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

const compareMatrix = async (raw: unknown): Promise<void> => {
  counts.matrices += 1
  const mine = expandMatrix(raw)
  const theirs = await ask({
    op: "matrix",
    ...(raw === undefined ? {} : { raw: wire(raw) }),
    secrets: secretsOf(raw)
  }) as {
    readonly types: ReadonlyArray<ReadonlyArray<readonly [string, string]>>
    readonly variants: ReadonlyArray<ReadonlyArray<readonly [string, string]>>
    readonly keys: ReadonlyArray<string>
    readonly problem: string | null
  }
  expect({
    raw,
    types: (mine.typedVariants ?? []).map((variant) =>
      sorted(Object.entries(variant).map(([key, held]) => [key, held === null ? "null" : typeof held]))
    ),
    variants: mine.variants.map((variant) => sorted(Object.entries(variant))),
    keys: [...mine.keys],
    problem: mine.problem ?? null
  })
    .toEqual({
      raw,
      types: theirs.types.map(sorted),
      variants: theirs.variants.map(sorted),
      keys: theirs.keys,
      problem: theirs.problem
    })
  expect(mine.variants.length).toBeLessThanOrEqual(256)
  counts[mine.problem === undefined ? "expanded" : "refused"] += 1
}

const upTo = (length: number): ReadonlyArray<number> => Array.from({ length }, (_, n) => n)

// dprint-ignore
const matrixCorpus: ReadonlyArray<unknown> = [
  undefined, null, {}, [], "text", { include: [] }, { exclude: [] }, { include: [{}] }, { include: [{}, {}] },
  { os: [] }, { os: [], include: [{ os: "a" }] }, { os: ["a"], exclude: [{}] }, { os: ["a", "a"] },
  { os: ["a"], exclude: [{ os: "a" }], include: [{ os: "a", x: 1 }, { os: "a", x: 2 }] },
  { os: ["a", "b"], include: [{ x: 1 }, { x: 2 }, { os: "a", x: 3 }, { os: "c" }] },
  { os: [{ name: "a", v: 1 }, { name: "b" }], include: [{ os: { name: "a", v: 1 }, x: 1 }, { os: { name: "a" }, y: 2 }] },
  { a: [{ b: 1 }], "a.b": [2] }, { "a.b": [2], a: [{ b: 1 }] }, { a: [{}] }, { a: [{}, {}], b: [1] },
  { a: [1], include: [{ b: { c: 1 } }, { b: 2 }, { "b.c": 3 }] }, { a: [1], include: [{ "": 1 }, { ".x": 2 }] },
  { a: [1, 1.0, "1"], exclude: [{ a: 1 }] }, { a: [true], exclude: [{ a: "true" }] }, { a: [null], exclude: [{ a: "" }] },
  { 2: ["x"], 1: ["y"], b: ["z"], 10: ["w"] }, { a: [[1]] }, { a: "x" }, { a: ["${{ x }}"] }, { a: [{ b: "${{ x }}" }] },
  { a: [1], exclude: "x" }, { a: [1], include: [1] }, { a: [1], include: [{ b: [1] }] }, { a: [1], exclude: null },
  { a: [1], exclude: [{ b: "${{ x }}" }] }, { include: [{ a: 1 }, { a: 1 }] }, { TOKEN: ["abc"] }, { TOKEN: [""] },
  { TOKEN: ["${{ secrets.T }}"] }, { a: [{ password: "p" }] }, { token_file: ["x"] }, { a: ["ghp_abcdefghijklmnopqrstuvwx"] },
  { a: upTo(256) }, { a: upTo(257) },
  { a: upTo(256), include: [{ b: 1 }] },
  { a: upTo(256), include: [{ a: "new" }] },
  { a: upTo(256), exclude: [{ a: 0 }], include: [{ a: "new" }] },
  { a: upTo(256), exclude: [{ a: 0 }], include: [{ a: "new" }, { a: "newer" }] },
  { a: upTo(300), b: [] }, { b: [], a: upTo(300) },
  { include: Array.from({ length: 256 }, (_, n) => ({ a: n })) }, { include: Array.from({ length: 257 }, (_, n) => ({ a: n })) },
  { a: [1], __proto__: [2] }, Object.fromEntries([["__proto__", [1, 2]], ["a", [3]]]),
  { a: [-0, 1e21, 0.1, Number.NaN] }, { a: [1], include: [{ a: 1, b: null }, { a: "1", c: true }] }
]

describe("the Lean reference and Matrix.vibe agree", () => {
  it.live.skipIf(!oracleReady)(
    "on generated matrices: lists, repeats, empty lists, exclude, and include that joins or stands alone",
    () => property(4201, 350, (dice) => compareMatrix(genMatrix(dice)))
  )

  it.live.skipIf(!oracleReady)(
    "on matrices at the limit of 256 variants",
    () => property(4202, 200, (dice) => compareMatrix(genLimitMatrix(dice)))
  )

  it.live.skipIf(!oracleReady)("on a corpus of corner cases", () =>
    Effect.promise(async () => {
      for (const raw of matrixCorpus) await compareMatrix(raw)
    }))
})

// ---------------------------------------------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------------------------------------------

interface GlobPiece {
  readonly pattern: string
  /** A text the piece is likely to name, so that generated paths match as well as miss. */
  readonly sample: (dice: Dice) => string
}

// dprint-ignore
const nameUnits = ["a", "b", "c", "x", "0", "5", "9", "-", "+", ",", ".", "é", "😀", "_", " ", "\\", "[", "]", "!", "^", "z", ":"]
const same = (pattern: string): GlobPiece => ({ pattern, sample: () => pattern })
const within = (pattern: string, choices: ReadonlyArray<string>): GlobPiece => ({
  pattern,
  sample: (dice) => dice.pick(choices)
})
const name = (dice: Dice): string => many(dice, 3, () => dice.pick(nameUnits)).join("")
const deep = (dice: Dice): string => many(dice, 3, () => name(dice)).join("/")

// dprint-ignore
const globPieces: ReadonlyArray<GlobPiece> = [
  ...["a", "b", "lock", "src", ".txt", "é", "😀", "+", "(", ")", "{", "}", "|", "^", "$", "\\", "]", "[", "-", "!", "#", " ", ".", "/", "/", "/"].map(same),
  { pattern: "*", sample: name }, { pattern: "*", sample: name }, { pattern: "**", sample: deep }, { pattern: "***", sample: deep },
  { pattern: "****", sample: deep }, { pattern: "**/", sample: (dice) => (dice.chance(2) ? "" : `${deep(dice)}/`) },
  { pattern: "***/", sample: (dice) => (dice.chance(2) ? "" : `${deep(dice)}/`) }, { pattern: "?", sample: (dice) => dice.pick(nameUnits) },
  { pattern: "/**/", sample: (dice) => (dice.chance(2) ? "/" : `/${deep(dice)}/`) }, { pattern: "/*", sample: (dice) => `/${name(dice)}` },
  ...["[abc]", "[a-c]", "[!a-c]", "[^x]", "[!-]", "[a-]", "[-a]", "[!+--]", "[+--]", "[!a-]", "[a-c-e]", "[9-0]", "[]", "[!]", "[^]",
    "[[:alpha:]]", "[[.a.]]", "[[=a=]]", "[\\]", "[\\-z]", "[!\\-z]", "[a/b]", "[!a/b]", "[ -0]", "[!.-0]", "[!,-.]", "[😀]", "[é-ë]",
    "[a-b-]", "[!a-b-]", "[--a]", "[!--a]", "[*?]", "[!*]", "[ab", "[!]a]", "[^^]", "[!!]", "[a^]", "[0-9a-c]", "[!0-9-]", "[!--]",
    "[---]", "[!---]", "[+--x]", "[!+--x]", "[!a-c+--]", "[x-]", "[!x-z-]"].map((pattern) => within(pattern, nameUnits)),
  ...["./", "./", "..", "~", "../", "/.."].map(same)
]

const genClass = (dice: Dice): GlobPiece =>
  within(
    `[${dice.pick(["", "", "!", "^"])}${
      Array.from(
        { length: 1 + dice.next(5) },
        () => dice.pick(["a", "b", "c", "-", "-", "/", "\\", "^", "!", ".", "0", "9", "[", ":", "é", "+", ",", "z"])
      ).join("")
    }]`,
    nameUnits
  )

interface BuiltGlob {
  readonly pattern: string
  readonly paths: ReadonlyArray<string>
}

const mutations: ReadonlyArray<(path: string, dice: Dice) => string> = [
  (path) => path,
  (path) => path,
  (path, dice) => `${path}/${name(dice)}`,
  (path, dice) => `${path}${dice.pick(nameUnits)}`,
  (path, dice) => `${name(dice)}/${path}`,
  (path) => [...path].slice(1).join(""),
  (path) => [...path].slice(0, -1).join(""),
  (path) => `${path}/`,
  (path, dice) => path.replace("/", dice.pick(["", "//", "/x/"])),
  (path, dice) => `${path}/a\n${name(dice)}`,
  (path) => path.toUpperCase()
]

const genGlob = (dice: Dice): BuiltGlob => {
  const pieces = Array.from(
    { length: 1 + dice.next(6) },
    () => (dice.chance(5) ? genClass(dice) : dice.pick(globPieces))
  )
  const pattern = pieces.map((piece) => piece.pattern).join("")
  const instance = (): string =>
    pieces.map((piece) => piece.sample(dice)).join("").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "")
  return {
    pattern,
    paths: [...Array.from({ length: 4 }, () => dice.pick(mutations)(instance(), dice)), deep(dice), ""]
  }
}

const compareGlob = async ({ paths, pattern }: BuiltGlob): Promise<void> => {
  counts.globs += 1
  const mine = regexOf(pattern)
  expect({ pattern, regex: mine ?? null }).toEqual({ pattern, regex: await ask({ op: "regexOf", pattern }) })
  const theirs = await ask({ op: "globMatches", pattern, paths })
  const matcher = mine === undefined ? undefined : new RegExp(mine)
  const names = paths.map((path) => matcher?.test(path) ?? null)
  expect({ pattern, paths, names }).toEqual({ pattern, paths, names: theirs })
  for (const named of names) counts[named === null ? "outside" : named ? "named" : "missed"] += 1
}

const compareFiles = async (patterns: ReadonlyArray<string>, paths: ReadonlyArray<string>): Promise<void> => {
  counts.globs += 1
  const mine = filesOf(patterns)
  expect({ patterns, files: mine ?? null }).toEqual({ patterns, files: await ask({ op: "filesOf", patterns }) })
  const takes = mine?.take.map((regex) => new RegExp(regex))
  const leaves = mine?.leave.map((regex) => new RegExp(regex)) ?? []
  const names = paths.map((path) =>
    takes === undefined ? null : mine?.order === undefined
      ? takes.some((regex) => regex.test(path)) && !leaves.some((regex) => regex.test(path))
      : mine.order.reduce(
        (held, index) => (index >= 0 ? takes[index] : leaves[-index - 1])!.test(path) ? index >= 0 : held,
        false
      )
  )
  expect({ patterns, paths, names }).toEqual({
    patterns,
    paths,
    names: await ask({ op: "filesMatch", patterns, paths })
  })
}

// dprint-ignore
const corpusPaths: ReadonlyArray<string> = [
  "", "a", "b", "lock", "lock.txt", "lock/", "a/b", "a/b/c", "src/a/b.ts", "src", "srcx/a", "/a", "a//b", ".", "..", "-", "+", ",",
  "/", "lock.", "lock-", "lock+", "lock,", "lock/x", "locka", "lock5", "lock\\", "lock[", "lock]", "lock^", "lock!", "lockz",
  "a\nb", "a/b\nc", "a/\u2028", "é", "😀", "lock😀", "x/y/lock.txt", "vendor/go.sum", "go.sum", "a.b", "ab"
]

// dprint-ignore
const globCorpus: ReadonlyArray<string> = [
  "", ".", "./", "././a", "./", "a/", "a//", "//", "/a", "~", "~/a", "a/~", "..", "../a", "a/..", "a/../b", "a/..b", "..a", "...",
  "./../a", ".//a", "*", "**", "***", "****", "**/", "**/a", "a/**", "a/**/b", "a**b", "a**/b", "a/***/b", "**a", "*/*", "*/**/*",
  "?", "??", "lock?", "lock[abc]", "lock[!abc]", "lock[^abc]", "lock[a-z]", "lock[!a-z]", "lock[!+--]", "lock[+--]", "lock[!--]",
  "lock[---]", "lock[!---]", "lock[!-]", "lock[-]", "lock[a-]", "lock[!a-]", "lock[-a]", "lock[!-a]", "lock[a-c-e]", "lock[a-c-]",
  "lock[!a-c-]", "lock[9-0]", "lock[]", "lock[!]", "lock[^]", "lock[]]", "lock[!]]", "lock[[:alpha:]]", "lock[\\]", "lock[\\-z]",
  "lock[!\\-z]", "lock[a/b]", "lock[!a/b]", "lock[ -0]", "lock[!.-0]", "lock[!,-.]", "lock[.-/]", "lock[/]", "lock[!/]", "lock[",
  "lock]", "lock[a", "[", "]", "[]", "[!]", "[a]", "[!a]/[!b]", "lock[😀]", "lock[😀-😂]", "lock[é-ë]", "lock[!^]", "lock[^^]",
  "lock[!!]", "a+b(1)|c{2}^$.txt", "a\\b", "a b", "#a", "!a", "a\nb", "lock[*]", "lock[?]", "lock[**]", "lock[a-b-c]", "lock[!+--x]"
]

// dprint-ignore
const filesCorpus: ReadonlyArray<ReadonlyArray<string>> = [
  [], [""], ["a"], ["!a"], ["a", "!a"], ["**/go.sum", "!vendor/**\n# a comment\n\n  go.work.sum  "], ["a", "/etc/hosts"],
  ["a\n../b"], ["#a"], [" # a"], ["!"], ["a", "!"], ["!!a"], ["a\r\nb"], ["\uFEFFa"], ["a", "!lock[!+--]"], ["**", "!**/*.txt"],
  ["lock[a/b]", "a"], ["a\n\n\n"], ["  "], ["a ", " !a "], ["!#a", "a"]
]

describe("the Lean reference and Glob.vibe agree", () => {
  it.live.skipIf(!oracleReady)(
    "on generated patterns: the regular expression itself, and which generated paths it names",
    () => property(4301, 450, (dice) => compareGlob(genGlob(dice)))
  )

  it.live.skipIf(!oracleReady)(
    "on lists of patterns: comments, space, patterns that leave files out and ones that leave the repository",
    () =>
      property(4302, 300, async (dice) => {
        const built = Array.from({ length: 1 + dice.next(4) }, () => genGlob(dice))
        const lines = built.flatMap(({ pattern }) => [
          `${dice.pick(["", "", "", "!", "!!", " ", "\t", "# ", " !", "#"])}${pattern}${
            dice.pick(["", "", " ", "\r", "\u00A0"])
          }`,
          ...(dice.chance(6) ? [dice.pick(["", "  ", "# a comment", "!", "!#x", "\uFEFF"])] : [])
        ])
        // Some lines travel together in one pattern, as a multi-line `hashFiles` argument holds them.
        const patterns = dice.chance(2)
          ? [lines.join("\n")]
          : dice.chance(2)
          ? lines
          : [lines.slice(0, 1).join("\n"), lines.slice(1).join("\n")]
        await compareFiles(patterns, built.flatMap(({ paths }) => paths.slice(0, 3)))
      })
  )

  it.live.skipIf(!oracleReady)("on a corpus of corner cases", () =>
    Effect.promise(async () => {
      for (const pattern of globCorpus) await compareGlob({ pattern, paths: corpusPaths })
      for (const patterns of filesCorpus) await compareFiles(patterns, corpusPaths)
    }))
})

describe("shell invocation options", () => {
  it.live.skipIf(!oracleReady)("chooses the same script as the Lean reference", () =>
    Effect.promise(async () => {
      expect.assertions(54)
      for (
        const option of [
          [],
          ["-e"],
          ["+u"],
          ["-o", "pipefail"],
          ["--init-file", "init"],
          ["+O", "extglob"],
          ["-eo", "pipefail"],
          ["-cO", "extglob"],
          ["--norc"]
        ]
      ) {
        for (
          const tail of [[], ["-c", "observe"], ["-c", "--", "observe"], ["--", "-c", "file"], ["-s", "arg"], ["file"]]
        ) {
          const args = [...option, ...tail]
          const expected = await ask({ op: "shellInput", input: "check", args })
          const programs = startedIn(["bash", ...args.map(quote), "<<< check"].join(" ")).slice(1)
          expect(programs.map(({ name }) => name), JSON.stringify(args)).toEqual(expected === null ? [] : [expected])
        }
      }
    }))
})

describe("the differential suite", () => {
  it.skipIf(!oracleReady)("asked the reference about enough cases of each kind", () => {
    if (process.env["LEAN_DIFF_REPORT"] !== undefined) console.log(JSON.stringify({ asked, ...counts }))
    expect(counts.expressions).toBeGreaterThanOrEqual(400)
    expect(counts.matrices).toBeGreaterThanOrEqual(300)
    expect(counts.globs).toBeGreaterThanOrEqual(400)
    expect(asked).toBeGreaterThanOrEqual(1000)
    for (const kind of ["literal", "residual", "problem", "secret", "finished", "verdicts"] as const) {
      expect([kind, counts[kind] >= 50]).toEqual([kind, true])
    }
    for (const kind of ["expanded", "refused", "named", "missed", "outside"] as const) {
      expect([kind, counts[kind] >= 100]).toEqual([kind, true])
    }
    expect(waiting).toEqual([])
  })
})
