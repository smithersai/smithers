/**
 * The chain's boundary, authorization seam and replay rules against their Lean 4 reference specification
 * (`spec/lean/chain`), generated: every case is answered by the implementation and by the specification's compiled
 * oracle, and the two answers must be equal.
 *
 * The oracle is one process for the whole file. It reads one JSON request per line and writes one JSON response per
 * line. A text crosses as its UTF-16 code units and a number as the decimal text of its 64 bits, so a lone surrogate,
 * an infinity and a negative zero all arrive as they left. A JavaScript value crosses as a tagged tree that names
 * what JSON cannot say: `"u"` is undefined, `"x"` a function, symbol or bigint, `"c"` a reference to a container the
 * walk is inside.
 *
 * A machine with neither the built oracle nor `lake` skips the file; a machine with `lake` builds the oracle first,
 * and builds it again when a source of the specification is newer than it.
 */
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Option, Result, Schema } from "effect"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Author from "../src/Author.ts"
import * as AuthorDeclaration from "../src/AuthorDeclaration.ts"
import * as Authorize from "../src/Authorize.ts"
import * as CallKey from "../src/CallKey.ts"
import * as Catalog from "../src/Catalog.ts"
import * as Chain from "../src/Chain.ts"
import * as Event from "../src/Event.ts"
import { childRun } from "../src/internal/childRun.ts"
import { isWellFormed } from "../src/internal/unicode.ts"
import * as Journal from "../src/Journal.ts"
import * as JsonBoundary from "../src/JsonBoundary.ts"
import * as Observation from "../src/Observation.ts"
import * as Outcome from "../src/Outcome.ts"
import * as Script from "../src/Script.ts"
import * as ScriptRunner from "../src/ScriptRunner.ts"
import * as Steering from "../src/Steering.ts"
import * as SubChains from "../src/SubChains.ts"
import { flow, runOn } from "./harness.ts"

// --- the oracle -----------------------------------------------------------------------------------------------------

const specDir = join(import.meta.dirname, "..", "spec", "lean", "chain")
const binary = join(specDir, ".lake", "build", "bin", "chain-spec")
const elan = join(homedir(), ".elan", "bin")
const lake = [...(process.env["PATH"] ?? "").split(delimiter).filter((directory) => directory !== ""), elan]
  .map((directory) => join(directory, "lake"))
  .find((path) => existsSync(path))
/** The specification's sources are here and `lake` can build them. A confined run may be shown neither. */
const buildable = lake !== undefined && existsSync(join(specDir, "lakefile.toml"))
const oracleReady = existsSync(binary) || buildable
const differential = it.skipIf(!oracleReady)

/** True when a source of the specification is newer than the built oracle, or there is no built oracle. */
const stale = (): boolean => {
  if (!existsSync(binary)) return true
  const built = statSync(binary).mtimeMs
  const sources = [
    "Main.lean",
    "ChainSpec.lean",
    "lakefile.toml",
    "lean-toolchain",
    ...readdirSync(join(specDir, "ChainSpec")).map((name) => join("ChainSpec", name))
  ]
  return sources.some((source) => statSync(join(specDir, source)).mtimeMs > built)
}

interface Oracle {
  readonly ask: (op: string, request: Readonly<Record<string, unknown>>) => Promise<unknown>
  readonly asked: () => number
  readonly close: () => void
}

const start = (): Oracle => {
  const child: ChildProcessWithoutNullStreams = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] })
  const waiting: Array<{ readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }> = []
  let asked = 0
  createInterface({ input: child.stdout }).on("line", (line) => {
    const next = waiting.shift()
    const response = JSON.parse(line) as { readonly ok?: unknown; readonly error?: string }
    if (response.error === undefined) next?.resolve(response.ok)
    else next?.reject(new Error(`the oracle refused: ${response.error}`))
  })
  child.on("close", () => {
    for (const each of waiting.splice(0)) each.reject(new Error("the oracle exited before it answered"))
  })
  return {
    ask: (op, request) =>
      new Promise((resolve, reject) => {
        asked++
        waiting.push({ resolve, reject })
        child.stdin.write(`${JSON.stringify({ op, ...request })}\n`)
      }),
    asked: () => asked,
    close: () => child.stdin.end()
  }
}

let oracle: Oracle

beforeAll(() => {
  if (!oracleReady) return
  if (lake !== undefined && buildable && stale()) {
    const built = spawnSync(lake, ["build"], {
      cwd: specDir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${elan}${delimiter}${process.env["PATH"] ?? ""}` },
      timeout: 120_000
    })
    if (built.status !== 0) throw new Error(`lake build failed in ${specDir}:\n${built.stdout}\n${built.stderr}`)
  }
  oracle = start()
}, 150_000)

afterAll(() => {
  if (oracleReady) oracle.close()
})

// --- the wire -------------------------------------------------------------------------------------------------------

type Units = ReadonlyArray<number>

/** A text as its UTF-16 code units. */
const units = (text: string): Array<number> => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))

/** The text a run of code units spells. */
const textOf = (codes: Units): string => codes.map((code) => String.fromCharCode(code)).join("")

const cell = new DataView(new ArrayBuffer(8))

/** A double as the decimal text of its 64 bits. */
const bitsOf = (value: number): string => {
  cell.setFloat64(0, value)
  return cell.getBigUint64(0).toString()
}

/** The double a decimal text of 64 bits names. */
const numberOf = (bits: string): number => {
  cell.setBigUint64(0, BigInt(bits))
  return cell.getFloat64(0)
}

/**
 * A JavaScript value as the specification holds it. `["r", unit, count]` is a string of one repeated code unit, so a
 * string as large as the whole budget costs a few bytes to send.
 */
type Model =
  | null
  | boolean
  | "u"
  | "x"
  | "c"
  | readonly ["n", string]
  | readonly ["s", Units]
  | readonly ["r", number, number]
  | readonly ["a", ReadonlyArray<Model>]
  | readonly ["o", boolean, ReadonlyArray<readonly [Units, Model]>]

/** A value the boundary let through, as the specification would hold it. */
const modelOf = (value: unknown): Model => {
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return ["n", bitsOf(value)]
  if (typeof value === "string") return ["s", units(value)]
  if (Array.isArray(value)) return ["a", value.map(modelOf)]
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return [
      "o",
      Object.getPrototypeOf(value) === Object.prototype,
      Object.keys(record).map((key) => [units(key), modelOf(record[key])] as const)
    ]
  }
  return value === undefined ? "u" : "x"
}

// --- generators -----------------------------------------------------------------------------------------------------

const baseExecutions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "100"))
const executions = Math.max(25, Math.min(baseExecutions, 150))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261123")

const int = (minimum: number, maximum: number): Arbitrary.Arbitrary<number> =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))

/** One of `values`; a failing case shrinks toward the first. */
const pick = <A>(values: ReadonlyArray<A>): Arbitrary.Arbitrary<A> =>
  Arbitrary.map(int(0, values.length - 1), (index) => values[index]!)

const list = <A>(item: Arbitrary.Arbitrary<A>, maxLength: number): Arbitrary.Arbitrary<Array<A>> =>
  Arbitrary.array(item, { maxLength })

/** A run of choices a builder reads from left to right; a builder that runs out reads zeros. */
const tape = (maxLength: number): Arbitrary.Arbitrary<Array<number>> => list(int(0, 0xffff), maxLength)

/** Fails the test with the shrunk counterexample unless the property holds for every generated value. */
const holds = async <A>(arbitrary: Arbitrary.Arbitrary<A>, property: (value: A) => Promise<void>): Promise<void> => {
  const report = await Effect.runPromise(
    Fuzz.run(arbitrary, (value) => Effect.promise(async () => (await property(value), true)), { executions, seed })
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

/** Pieces a hostile text is built from: both halves of a surrogate pair, a pair, the edges of the surrogate range. */
const fragments = [
  "a",
  "b",
  "/",
  ":",
  "é",
  "😺",
  "\ud83d",
  "\ude3a",
  "\ud800",
  "\udbff",
  "\udc00",
  "\udfff",
  "퟿",
  "",
  "\u0000",
  "￿",
  "__proto__",
  " "
] as const

const built: Arbitrary.Arbitrary<string> = Arbitrary.map(list(pick(fragments), 6), (parts) => parts.join(""))

/** A text: a built one, or any string the schema generator makes. */
const anyText: Arbitrary.Arbitrary<string> = Arbitrary.map(
  Arbitrary.all([int(0, 3), built, Arbitrary.schema(Schema.String)]),
  ([choice, made, free]) => (choice === 0 ? free : made)
)

// --- values ---------------------------------------------------------------------------------------------------------

const numbers = [
  0,
  -0,
  1,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  2 ** 53,
  -(2 ** 31)
] as const

const strings = ["", "a", "hello", "é", "😺", "\ud83d", "\ude3a", "\ude3a\ud83d", "a\u0000b", "__proto__"] as const

const keys = [
  "a",
  "b",
  "_tag",
  "value",
  "__proto__",
  "constructor",
  "toString",
  "length",
  "10",
  "2",
  "0",
  "",
  "é",
  "😺",
  "\ud800"
] as const

/** A value tree read off a tape: scalars, the unsayable, arrays and objects four levels deep. */
const grow = (choices: ReadonlyArray<number>): Model => {
  let at = 0
  const next = (): number => choices[at++] ?? 0
  const node = (depth: number, inside: boolean): Model => {
    const choice = next() % (depth >= 4 ? 9 : 14)
    if (choice === 0) return null
    if (choice === 1) return true
    if (choice === 2) return false
    if (choice === 3) return ["n", bitsOf(numbers[next() % numbers.length]!)]
    if (choice === 4 || choice === 5) return ["s", units(strings[next() % strings.length]!)]
    if (choice === 6) return "u"
    if (choice === 7) return "x"
    if (choice === 8) return inside ? "c" : null
    if (choice === 9 || choice === 10) {
      return ["a", Array.from({ length: next() % 4 }, () => node(depth + 1, true))]
    }
    const repeats = next() % 8 === 0
    const fields: Array<readonly [Units, Model]> = []
    const used = new Set<string>()
    for (let remaining = next() % 4; remaining > 0; remaining = remaining - 1) {
      const key = keys[next() % keys.length]!
      if (used.has(key) && !repeats) continue
      used.add(key)
      fields.push([units(key), node(depth + 1, true)])
    }
    return ["o", choice !== 13, fields]
  }
  return node(0, false)
}

class Instance {}

/**
 * A real value the model describes, and the model as the boundary will read it: fields in `Object.keys` order. Every
 * guise a model allows is used in turn: a hole or an explicit `undefined`, a plain or a null-prototype object, a data
 * property or a getter, and symbol-keyed and non-enumerable properties the boundary must not see. An object offering
 * one key twice is a proxy, the only thing that can.
 */
const realize = (model: Model): { readonly value: unknown; readonly sent: Model } => {
  let turn = 0
  const go = (current: Model, ancestors: ReadonlyArray<object>): { readonly value: unknown; readonly sent: Model } => {
    turn = turn + 1
    const guise = turn
    if (current === null || typeof current === "boolean") return { sent: current, value: current }
    if (current === "u") return { sent: current, value: undefined }
    if (current === "x") {
      return { sent: current, value: guise % 3 === 0 ? () => 1 : guise % 3 === 1 ? Symbol("x") : 10n }
    }
    if (current === "c") return { sent: current, value: ancestors[guise % ancestors.length] }
    if (current[0] === "n") return { sent: current, value: numberOf(current[1]) }
    if (current[0] === "s") return { sent: current, value: textOf(current[1]) }
    if (current[0] === "r") return { sent: current, value: String.fromCharCode(current[1]).repeat(current[2]) }
    if (current[0] === "a") {
      const array: Array<unknown> = []
      const sent: Array<Model> = []
      current[1].forEach((item, index) => {
        // The same reference twice is not a cycle: the walk forgets a container it has left.
        if (index === 1 && guise % 5 === 0 && typeof array[0] === "object") {
          array[1] = array[0]
          sent.push(sent[0]!)
          return
        }
        const made = go(item, [...ancestors, array])
        sent.push(made.sent)
        if (item === "u" && guise % 2 === 0) array.length = index + 1
        else array[index] = made.value
      })
      if (guise % 4 === 1) Object.defineProperty(array, "extra", { enumerable: true, value: () => 1 })
      return { sent: ["a", sent], value: array }
    }
    const fields = current[2]
    const names = fields.map(([key]) => textOf(key))
    if (!current[1]) {
      const exotic: object = guise % 3 === 0
        ? new Instance()
        : guise % 3 === 1
        ? Object.create({ inherited: 1 }) as object
        : new Map()
      for (const [index, [, item]] of fields.entries()) {
        Object.defineProperty(exotic, names[index]!, {
          configurable: true,
          enumerable: true,
          value: go(item, [...ancestors, exotic]).value
        })
      }
      return { sent: current, value: exotic }
    }
    if (new Set(names).size !== names.length) {
      const target = {}
      const values = fields.map(([, item]) => go(item, [...ancestors, target]).value)
      const proxy: object = new Proxy(target, {
        get: (_, key) => values[names.indexOf(String(key))],
        getOwnPropertyDescriptor: (_, key) => ({
          configurable: true,
          enumerable: true,
          value: values[names.indexOf(String(key))]
        }),
        ownKeys: () => names
      })
      return { sent: current, value: proxy }
    }
    const object = (guise % 3 === 0 ? Object.create(null) : {}) as Record<string, unknown>
    const sent = new Map<string, Model>()
    for (const [index, [, item]] of fields.entries()) {
      const made = go(item, [...ancestors, object])
      sent.set(names[index]!, made.sent)
      Object.defineProperty(
        object,
        names[index]!,
        guise % 5 === 1
          ? { configurable: true, enumerable: true, get: () => made.value }
          : { configurable: true, enumerable: true, value: made.value, writable: true }
      )
    }
    if (guise % 4 === 2) {
      Object.defineProperty(object, Symbol("hidden"), { enumerable: true, value: () => 1 })
      Object.defineProperty(object, "unlisted", { enumerable: false, value: () => 1 })
    }
    return { sent: ["o", true, Object.keys(object).map((key) => [units(key), sent.get(key)!] as const)], value: object }
  }
  return go(model, [])
}

/** What the boundary answered, as the oracle answers: `null` is `Refused`. */
const crossed = (value: unknown): { readonly copy: Model } | null => {
  const result = JsonBoundary.jsonBoundary(value)
  return result._tag === "Ok" ? { copy: modelOf(result.value) } : null
}

/** What `decodeOutcome` answered, as the oracle answers. A successor's digest must be the digest of its text. */
const decoded = (value: unknown): unknown => {
  const outcome = JsonBoundary.decodeOutcome(value)
  if (Option.isNone(outcome)) return null
  const some = outcome.value
  if (some._tag === "Done") return ["Done", modelOf(some.value)]
  if (some._tag === "Park") return ["Park", units(some.reason.code), units(some.reason.message)]
  expect(some.script.digest).toBe(Script.make(some.script.text).digest)
  return ["To", units(some.script.text)]
}

/** `value` under `count` arrays, or under `count` objects. */
const nested = (count: number, inArrays: boolean, value: unknown): unknown => {
  let current = value
  for (let level = 0; level < count; level = level + 1) current = inArrays ? [current] : { next: current }
  return current
}

const nestedModel = (count: number, inArrays: boolean, value: Model): Model => {
  let current = value
  for (let level = 0; level < count; level = level + 1) {
    current = inArrays ? ["a", [current]] : ["o", true, [[units("next"), current]]]
  }
  return current
}

describe("the JSON boundary against the Lean specification", () => {
  differential("isWellFormed agrees on every text, built from surrogate halves or free", async () => {
    await holds(anyText, async (text) => {
      expect(await oracle.ask("isWellFormed", { text: units(text) })).toBe(isWellFormed(text))
    })
  })

  differential("jsonBoundary agrees on every generated value, and so does decodeOutcome on what crossed", async () => {
    await holds(tape(48), async (choices) => {
      const { sent, value } = realize(grow(choices))
      const answer = crossed(value)
      expect(answer).toEqual(await oracle.ask("jsonBoundary", { value: sent }))
      if (answer === null) return
      const copy = (JsonBoundary.jsonBoundary(value) as { readonly value: unknown }).value
      // What crossed crosses again unchanged, and is decoded the way the specification decodes it.
      expect(crossed(copy)).toEqual(answer)
      expect(decoded(copy)).toEqual(await oracle.ask("decodeOutcome", { value: answer.copy }))
    })
  })

  differential("jsonBoundary agrees at the depth cap, in arrays and in objects", async () => {
    for (const inArrays of [true, false]) {
      for (const count of [0, 1, 127, 128, 129, 130, 200]) {
        for (const leaf of [1, "leaf", [], {}]) {
          const answer = crossed(nested(count, inArrays, leaf))
          expect(answer === null).toBe(count > JsonBoundary.maxJsonDepth)
          expect(answer).toEqual(
            await oracle.ask("jsonBoundary", { value: nestedModel(count, inArrays, modelOf(leaf)) })
          )
        }
      }
    }
  })

  differential("jsonBoundary agrees at the size budget, to the unit", async () => {
    const verdict = async (model: Model): Promise<boolean> => {
      const answer = JsonBoundary.jsonBoundary(realize(model).value)._tag === "Ok"
      const said = await oracle.ask("jsonBoundary", { value: model, verdictOnly: true })
      expect(said === null ? false : true).toBe(answer)
      return answer
    }
    // One node and every code unit of the string: exactly the budget, then one over.
    expect(await verdict(["r", 97, JsonBoundary.maxJsonSize - 1])).toBe(true)
    expect(await verdict(["r", 97, JsonBoundary.maxJsonSize])).toBe(false)
    // 1 + 47 * (1 + 178480) is the budget: 47 nodes, their strings, and the array.
    const filled = (length: number): Model => ["a", Array.from({ length: 47 }, () => ["r", 97, length] as const)]
    expect(1 + 47 * (1 + 178_480)).toBe(JsonBoundary.maxJsonSize)
    expect(await verdict(filled(178_480))).toBe(true)
    expect(await verdict(filled(178_481))).toBe(false)
    // A key is charged like a string: per object one node, its key, and the node and code units of its value.
    const keyed = (length: number): Model => [
      "a",
      Array.from(
        { length: 47 },
        () => ["o", true, [[Array.from({ length: 1000 }, () => 97), ["r", 97, length]]]] as const
      )
    ]
    expect(1 + 47 * (1 + 1000 + 1 + 177_479)).toBe(JsonBoundary.maxJsonSize)
    expect(await verdict(keyed(177_479))).toBe(true)
    expect(await verdict(keyed(177_480))).toBe(false)
  })

  differential("jsonBoundary agrees on the values that have one answer worth pinning", async () => {
    const cyclic: Array<unknown> = []
    cyclic.push([cyclic])
    const shared = { a: 1 }
    const cases: ReadonlyArray<readonly [unknown, Model]> = [
      [undefined, "u"],
      [-0, ["n", bitsOf(-0)]],
      [[-0, { z: -0 }], ["a", [["n", bitsOf(-0)], ["o", true, [[units("z"), ["n", bitsOf(-0)]]]]]]],
      [[undefined], ["a", ["u"]]],
      [new Array(2), ["a", ["u", "u"]]],
      [cyclic, ["a", [["a", ["c"]]]]],
      [[shared, shared], ["a", [modelOf(shared), modelOf(shared)]]],
      [JSON.parse(`{"__proto__":{"polluted":true}}`), ["o", true, [[units("__proto__"), modelOf({ polluted: true })]]]],
      [new Date(0), ["o", false, []]],
      ["\ud83d", ["s", [0xd83d]]],
      [{ "\ude3a": 1 }, ["o", true, [[[0xde3a], ["n", bitsOf(1)]]]]]
    ]
    for (const [value, model] of cases) {
      expect(crossed(value)).toEqual(await oracle.ask("jsonBoundary", { value: model }))
    }
    expect(crossed(-0)).toEqual({ copy: ["n", "0"] })
    expect(crossed(undefined)).toEqual({ copy: null })
  })

  differential("decodeOutcome agrees on every outcome-shaped value that crossed the boundary", async () => {
    const texts = ["", "x", "return done(1)", "é😺", "\ud83d"] as const
    const codes = ["approval", "event", "timer", "quota", "plugin", "nope", "Approval", ""] as const
    const candidate = Arbitrary.map(
      Arbitrary.all([tape(24), tape(12)]),
      ([choices, inner]): unknown => {
        let at = 0
        const next = (): number => choices[at++] ?? 0
        const text = (): string => texts[next() % texts.length]!
        const free = (): unknown => realize(grow(inner)).value
        const scripts: ReadonlyArray<() => unknown> = [
          text,
          () => ({ text: text() }),
          () => ({ digest: "forged", text: text() }),
          () => ({ digest: "forged" }),
          () => ({ text: 3 }),
          () => [text()],
          () => null,
          free
        ]
        const reasons: ReadonlyArray<() => unknown> = [
          () => ({ code: codes[next() % codes.length], message: text() }),
          () => ({ code: codes[next() % codes.length], extra: 1, message: text() }),
          () => ({ code: codes[next() % 5] }),
          () => ({ message: text() }),
          () => ({ code: 1, message: text() }),
          () => ({ code: codes[next() % 5], message: null }),
          () => [],
          () => null,
          free
        ]
        // A well-shaped outcome of one of the three kinds, then at most one thing wrong with it.
        const kind = next() % 3
        const outcome: Record<string, unknown> = kind === 0
          ? { _tag: "Done", value: next() % 2 === 0 ? text() : free() }
          : kind === 1
          ? { _tag: "To", script: scripts[next() % scripts.length]!() }
          : { _tag: "Park", reason: reasons[next() % reasons.length]!() }
        const flaw = next() % 8
        if (flaw === 0) outcome["_tag"] = ["done", "", 1, null, "Park", "To", "Done"][next() % 7]
        if (flaw === 1) delete outcome[["_tag", "value", "script", "reason"][next() % 4]!]
        if (flaw === 2) outcome["value"] = free()
        if (flaw === 3) outcome["extra"] = text()
        return next() % 16 === 0 ? [outcome] : outcome
      }
    )
    let decodedSome = 0
    await holds(candidate, async (value) => {
      const result = JsonBoundary.jsonBoundary(value)
      if (result._tag === "Refused") return
      const answer = decoded(result.value)
      if (answer !== null) decodedSome = decodedSome + 1
      expect(answer).toEqual(await oracle.ask("decodeOutcome", { value: modelOf(result.value) }))
    })
    expect(decodedSome).toBeGreaterThan(0)
  })
})

// --- authorization --------------------------------------------------------------------------------------------------

const patternActions = [
  "*",
  "fs:read",
  "fs:write",
  "fs:*",
  "net:get",
  "net:private",
  "net:*",
  "model:call",
  "model:*",
  "proc:spawn",
  "proc:*",
  "jj:diff",
  "jj:workspace-add",
  "jj:*",
  "memory:read",
  "remote:acquire"
] as const

const resources = [
  "**",
  "*",
  "",
  "a",
  "a/b",
  "a/**",
  "a/*",
  "a/b/c",
  "?",
  "a?",
  "*/b",
  "./a",
  "a/./b",
  "a/../b",
  "../a",
  "*/../a",
  "a//b",
  "a/",
  "/",
  "/abs",
  "~a",
  "C:a/..",
  "a\\..",
  ".",
  "..",
  "npm *",
  "npm",
  "npm run",
  "a:b",
  "é",
  "😺",
  "??",
  "\ud83d",
  "author",
  "agent"
] as const

const effects = ["allow", "deny", "ask"] as const

const ruleSpec = Arbitrary.all([pick(effects), pick(patternActions), pick(resources)])

/** A declared claim: an action and a resource, a bare action, the sentinel, or something that does not parse. */
const claim: Arbitrary.Arbitrary<string> = Arbitrary.map(
  Arbitrary.all([int(0, 9), pick(patternActions), pick(resources), anyText]),
  ([choice, action, resource, free]) =>
    choice === 0
      ? action
      : choice === 1
      ? ["", "fs", "a:b", "x:y:z", "fs:nope:a", ":", "fs:", "*:", `fs:read:${"a".repeat(4097)}`][resource.length % 9]!
      : choice === 2
      ? free
      : `${action}:${resource}`
)

const slot = { chain: "", link: 0, ordinal: 0 } as const

/** What the rules-backed seam answers, as the oracle answers: the code, and the claim the message names. */
const authorized = async (
  rules: ReadonlyArray<readonly [(typeof effects)[number], (typeof patternActions)[number], string]>,
  claims: ReadonlyArray<string>
): Promise<unknown> => {
  const layer = Authorize.layerRules(
    rules.map(([effect, action, resource]) =>
      new Rule({ effect, pattern: new CapabilityPattern({ action, resource }) })
    )
  )
  const result = await runOn(
    layer,
    Effect.gen(function*() {
      const seam = yield* Authorize.Authorize
      return yield* Effect.result(seam.authorize({ capabilities: claims, name: "n", slot }))
    })
  )
  if (Result.isSuccess(result)) return ["allowed"]
  const { code, message } = result.failure
  const lead = code === "denied" ? `"n" is denied for ` : `"n" needs approval for `
  expect(message.startsWith(lead)).toBe(true)
  return [code, units(message.slice(lead.length))]
}

describe("the authorization seam against the Lean specification", () => {
  differential("claimPattern agrees on every declared claim", async () => {
    await holds(claim, async (declared) => {
      const parsed = Authorize.claimPattern(declared)
      expect(Option.isNone(parsed) ? null : [units(parsed.value.action), units(parsed.value.resource)]).toEqual(
        await oracle.ask("claimPattern", { claim: units(declared) })
      )
    })
  })

  differential("layerRules agrees on the verdict and on the claim it names", async () => {
    const verdicts = new Set<string>()
    const policy = Arbitrary.all([list(ruleSpec, 5), list(claim, 4), int(0, 2)])
    await holds(policy, async ([generated, claims, grant]) => {
      // One policy in three ends by allowing everything, so that whole requests are allowed often enough to compare.
      const rules = grant === 0 ? [...generated, ["allow", "*", "**"] as const] : generated
      const answer = await authorized(rules, claims)
      verdicts.add((answer as ReadonlyArray<string>)[0]!)
      expect(answer).toEqual(
        await oracle.ask("authorize", {
          claims: claims.map(units),
          rules: rules.map(([effect, action, resource]) => [effect, units(action), units(resource)])
        })
      )
    })
    expect([...verdicts].sort()).toEqual(["allowed", "approval_required", "denied"])
  })

  differential("layerRules agrees when the last rule denies everything", async () => {
    await holds(Arbitrary.all([list(ruleSpec, 4), list(claim, 3)]), async ([rules, claims]) => {
      const all = [...rules, ["deny", "*", "**"] as const]
      const answer = await authorized(all, claims)
      expect(answer).toEqual(
        await oracle.ask("authorize", {
          claims: claims.map(units),
          rules: all.map(([effect, action, resource]) => [effect, units(action), units(resource)])
        })
      )
      // Proved in the specification: under a trailing deny-all nothing is allowed, and a claim that parses is denied.
      expect((answer as ReadonlyArray<string>)[0]).not.toBe("allowed")
      if (claims.length === 0 || claims.some((declared) => Option.isSome(Authorize.claimPattern(declared)))) {
        expect((answer as ReadonlyArray<string>)[0]).toBe("denied")
      }
    })
  })
})

// --- journals -------------------------------------------------------------------------------------------------------

const scopes = ["", "a", "ab", "a/0.1", "0.1", "a b"] as const

/** A journal event as the oracle reads it. Replay compares payloads, results and envelopes as texts. */
const wireOf = (event: Event.Event): ReadonlyArray<unknown> => {
  const scope = units(event.chain ?? "")
  switch (event._tag) {
    case "ChainStarted":
      return ["started", scope, units(event.goal), event.envelope === null ? null : units(String(event.envelope))]
    case "LinkAuthored":
      return ["authored", scope, event.link, units(event.script.digest)]
    case "CallSettled":
      return [
        "settled",
        scope,
        event.link,
        keyWire(event.key),
        units(event.name),
        units(String(event.payload)),
        units(String(event.result))
      ]
    case "GateRejected":
      return ["rejected", scope, event.link, event.ordinal]
    case "LinkEnded":
      return ["ended", scope, event.link, event.outcome._tag !== "To"]
    case "SteeringDrained":
      return ["steered", scope, event.link, event.ordinal]
  }
}

const keyWire = (key: CallKey.CallKey): ReadonlyArray<unknown> => [
  key.link,
  units(key.scriptDigest),
  key.ordinal,
  units(key.entryDigest)
]

/** An event with its scope: a root event carries no `chain`, or carries the empty one. */
const scopedTo = (scope: string, bare: boolean, event: Event.Event): Event.Event =>
  scope === "" && bare ? event : { ...event, chain: scope }

const anyEvent: Arbitrary.Arbitrary<Event.Event> = Arbitrary.map(
  Arbitrary.all([pick(scopes), int(0, 5), int(0, 2), int(0, 3), int(0, 2), int(0, 3), pick(["x", "y"])]),
  ([scope, kind, link, ordinal, keyLink, variant, mark]) => {
    const bare = variant % 2 === 0
    if (kind === 0) return scopedTo(scope, bare, { _tag: "ChainStarted", envelope: null, goal: mark })
    if (kind === 1) return scopedTo(scope, bare, { _tag: "LinkAuthored", link, script: Script.make(mark) })
    if (kind === 2) {
      return scopedTo(scope, bare, {
        _tag: "GateRejected",
        link,
        observation: Observation.make("shape", mark),
        ordinal
      })
    }
    if (kind === 3) {
      const outcome = variant === 0
        ? Outcome.to(mark)
        : variant === 1
        ? Outcome.park("timer", mark)
        : Outcome.done(mark)
      return scopedTo(scope, bare, { _tag: "LinkEnded", link, outcome })
    }
    return scopedTo(scope, bare, {
      _tag: "CallSettled",
      key: CallKey.make(keyLink, mark, ordinal, "entry"),
      link,
      name: mark,
      payload: `${mark}${variant}`,
      result: `${mark}${link}${ordinal}${variant}`
    })
  }
)

describe("the journal folds against the Lean specification", () => {
  differential("settled, rejected, started, linkCount, authored and terminal agree in every scope", async () => {
    await holds(Arbitrary.all([list(anyEvent, 14), pick(scopes), int(0, 2)]), async ([events, scope, link]) => {
      const answer = {
        authored: Option.getOrNull(Option.fromNullishOr(Event.authored(events, link, scope)?.digest)),
        linkCount: Event.linkCount(events, scope),
        rejected: [...Event.rejected(events, link, scope).keys()],
        settled: [...Event.settled(events, link, scope)].map(([ordinal, call]) => [
          ordinal,
          [keyWire(call.key), units(call.name), units(String(call.payload)), units(String(call.result))]
        ]),
        started: Event.started(events, scope),
        terminal: Event.terminal(events, scope) !== undefined
      }
      const said = await oracle.ask("settled", { chain: units(scope), events: events.map(wireOf), link }) as {
        readonly authored: Units | null
        readonly rejected: ReadonlyArray<number>
      }
      expect({ ...answer, authored: answer.authored === null ? null : units(answer.authored) }).toEqual(said)
    })
  })
})

// --- keys -----------------------------------------------------------------------------------------------------------

const succeeding = Author.layerFn(() => flow("return done(1)"))

describe("call keys and derived names against the Lean specification", () => {
  differential("a live call slot is keyed, steered and scoped the way the specification names it", async () => {
    const rootScopes = ["", "a", "ab", "a b", "é", "0", "1.x"] as const
    await holds(Arbitrary.all([pick(rootScopes), int(0, 3), int(0, 3)]), async ([scope, link, ordinal]) => {
      const said = await oracle.ask("callKey", {
        chain: units(scope),
        entryDigest: units(AuthorDeclaration.authorDigest),
        link,
        ordinal,
        scriptDigest: units(CallKey.harnessDigest)
      }) as { readonly boundary: Units; readonly child: Units; readonly key: ReadonlyArray<unknown> }
      expect(keyWire(CallKey.make(link, CallKey.harnessDigest, ordinal, AuthorDeclaration.authorDigest))).toEqual(
        said.key
      )
      // A journal that ended `link` links and rejected `ordinal` author attempts: the next live call is the slot.
      const initial: Array<Event.Event> = [{ _tag: "ChainStarted", envelope: null, goal: "g" }]
      for (let ended = 0; ended < link; ended = ended + 1) {
        initial.push({ _tag: "LinkEnded", link: ended, outcome: Outcome.to(`return ${ended}`) })
      }
      for (let attempt = 0; attempt < ordinal; attempt = attempt + 1) {
        initial.push({ _tag: "GateRejected", link, observation: Observation.make("shape", "no"), ordinal: attempt })
      }
      const journal = initial.map((event) => scopedTo(scope, false, event))
      const boundaries: Array<string> = []
      const slots: Array<Catalog.CallSlot> = []
      const steering = Layer.succeed(Steering.Steering)(
        Steering.make({
          admit: () => Effect.void,
          drain: (boundary) => Effect.sync(() => (boundaries.push(boundary), []))
        })
      )
      const authorize = Layer.succeed(Authorize.Authorize)(
        Authorize.make({ authorize: (request) => Effect.sync(() => void slots.push(request.slot)) })
      )
      const events = await runOn(
        Layer.mergeAll(
          Journal.layerMemory(journal),
          succeeding,
          ScriptRunner.layerInProcess,
          Catalog.layer([]),
          steering,
          authorize
        ),
        Effect.gen(function*() {
          yield* Chain.run({ chain: scope, goal: "g" })
          return yield* (yield* Journal.Journal).read
        })
      )
      expect(units(boundaries[0]!)).toEqual(said.boundary)
      expect(slots[0]).toEqual({ chain: scope, link, ordinal })
      const first = events.slice(journal.length).find((event) => event._tag === "CallSettled")
      expect(first === undefined ? undefined : keyWire(first.key)).toEqual(said.key)
    })
  })

  differential("a spawning call slot derives the child scope the specification names", async () => {
    await holds(Arbitrary.all([pick(scopes), int(0, 12), int(0, 12)]), async ([scope, link, ordinal]) => {
      const said = await oracle.ask("callKey", {
        chain: units(scope),
        entryDigest: [],
        link,
        ordinal,
        scriptDigest: []
      }) as {
        readonly child: Units
      }
      const base = Layer.mergeAll(Journal.layerMemory(), succeeding, ScriptRunner.layerInProcess)
      const events = await runOn(
        base,
        Effect.gen(function*() {
          const catalog = yield* SubChains.make({ entries: [], maxDepth: 64 })
          yield* catalog.lookup(SubChains.agentName)!.handler({ goal: "g" }, { chain: scope, link, ordinal })
          return yield* (yield* Journal.Journal).read
        })
      )
      expect(events.length).toBeGreaterThan(0)
      for (const event of events) expect(units(event.chain ?? "")).toEqual(said.child)
    })
  })
})

// --- replay ---------------------------------------------------------------------------------------------------------

const names = ["a", "b", "c"] as const
const payloads = ["p", "q", ""] as const
const tampers = [
  "none",
  "none",
  "none",
  "none",
  "keyLink",
  "scriptDigest",
  "harnessDigest",
  "name",
  "unknownName",
  "payload",
  "entryDigest",
  "otherScope",
  "otherLink",
  "keyOrdinal"
] as const

const scenario = Arbitrary.all([
  Arbitrary.all([pick(scopes), pick(scopes), int(0, 2)]),
  list(Arbitrary.all([pick(names), pick(payloads)]), 4),
  list(Arbitrary.all([int(0, 4), pick(tampers), int(0, 2)]), 7),
  list(Arbitrary.all([int(0, 3), int(0, 3)]), 4),
  Arbitrary.all([
    pick(["same", "same", "fresh", "goal", "envelope", "noEnvelope"] as const),
    pick([undefined, "e1"] as const),
    pick(["open", "open", "open", "done", "park"] as const)
  ])
])

const reasons: ReadonlyArray<readonly [string, string]> = [
  ["identity", "settled under a different link or script"],
  ["name", "but the journal settled"],
  ["payload", "received a different payload"],
  ["declaration", "settled under a different declaration"]
]

interface Ran {
  readonly dispatched: ReadonlyArray<readonly [number, ReadonlyArray<unknown>]>
  readonly events: ReadonlyArray<Event.Event>
  readonly result: Result.Result<Outcome.RunResult, unknown>
}

/** The typed error a run failed with; nothing when it did not fail. */
const failureOf = (result: Ran["result"]): { readonly code?: string; readonly message?: string } =>
  Result.isFailure(result) ? result.failure as { readonly code?: string; readonly message?: string } : {}

describe("replay against the Lean specification", () => {
  const entries = (dispatched: Array<readonly [number, ReadonlyArray<unknown>]>): Array<Catalog.Entry> =>
    names.map((name) => ({
      description: `entry ${name}`,
      handler: (_, at) =>
        Effect.sync(() => {
          dispatched.push([at?.ordinal ?? -1, at?.key === undefined ? [] : keyWire(at.key)])
          return `live:${at?.ordinal}`
        }),
      name
    }))
  const digests = entries([]).map((entry) => [units(entry.name), units(Catalog.entryDigest(entry))])

  const ran = (
    journal: ReadonlyArray<Event.Event>,
    scope: string,
    envelope: string | undefined
  ): Promise<Ran> => {
    const dispatched: Array<readonly [number, ReadonlyArray<unknown>]> = []
    return runOn(
      Layer.mergeAll(
        Journal.layerMemory(journal),
        Author.layerMock([]),
        ScriptRunner.layerInProcess,
        Catalog.layer(entries(dispatched))
      ),
      Effect.gen(function*() {
        const result = yield* Effect.result(
          Chain.run({
            chain: scope,
            envelope,
            goal: "g",
            ...(scope.includes("/") || scope === "0.1" ? { [childRun]: true } : {})
          })
        )
        return { dispatched, events: yield* (yield* Journal.Journal).read, result }
      })
    )
  }

  differential("a resumed link replays, dispatches and diverges exactly as the specification says", async () => {
    const seen = new Set<string>()
    await holds(scenario, async ([[scope, other, link], calls, priors, noise, [started, envelope, ending]]) => {
      const script = Script.make(
        [
          "const out = []",
          ...calls.map(([name, payload]) =>
            `out.push(await ctx.call(${JSON.stringify(name)}, ${JSON.stringify(payload)}))`
          ),
          "return done(out)"
        ].join("\n")
      )
      const foreign = other === scope ? `${scope}x` : other
      const digestOf = (name: string): string =>
        Catalog.entryDigest({ description: `entry ${name}`, handler: () => Effect.void, name })
      const inScope = (event: Event.Event): Event.Event => scopedTo(scope, false, event)
      const journal: Array<Event.Event> = []
      if (started !== "fresh") {
        journal.push(inScope({
          _tag: "ChainStarted",
          envelope: started === "envelope" ? "e2" : started === "noEnvelope" ? null : envelope ?? null,
          goal: started === "goal" ? "another goal" : "g"
        }))
      }
      journal.push({ _tag: "ChainStarted", chain: foreign, envelope: "theirs", goal: "theirs" })
      for (let ended = 0; ended < link; ended = ended + 1) {
        journal.push(inScope({ _tag: "LinkEnded", link: ended, outcome: Outcome.to(`return ${ended}`) }))
      }
      journal.push({ _tag: "LinkAuthored", chain: foreign, link, script: Script.make("return done(0)") })
      journal.push(inScope({ _tag: "LinkAuthored", link, script }))
      for (const [index, [ordinal, tamper, variant]] of priors.entries()) {
        const [name, payload] = calls[ordinal] ?? ["a", "p"]
        const settledName = tamper === "name"
          ? names[(names.indexOf(name) + 1) % 3]!
          : tamper === "unknownName"
          ? "zz"
          : name
        journal.push({
          _tag: "CallSettled",
          chain: tamper === "otherScope" ? foreign : scope,
          key: CallKey.make(
            tamper === "keyLink" ? link + 1 : link,
            tamper === "scriptDigest" ? Script.make("other").digest : tamper === "harnessDigest" ? "" : script.digest,
            tamper === "keyOrdinal" ? ordinal + 1 : ordinal,
            tamper === "entryDigest" ? "stale" : digestOf(name)
          ),
          link: tamper === "otherLink" ? link + 1 : link,
          name: settledName,
          payload: tamper === "payload" ? `${payload}!` : payload,
          result: `r${index}v${variant}`
        })
      }
      // Another scope settles the same ordinals, ends its own chain and is rejected: none of it is this scope's.
      for (const [ordinal, kind] of noise) {
        journal.push(
          kind === 0
            ? {
              _tag: "CallSettled",
              chain: foreign,
              key: CallKey.make(link, script.digest, ordinal, digestOf("a")),
              link,
              name: "a",
              payload: "p",
              result: "theirs"
            }
            : kind === 1
            ? { _tag: "LinkEnded", chain: foreign, link, outcome: Outcome.done("theirs") }
            : kind === 2
            ? { _tag: "GateRejected", chain: foreign, link, observation: Observation.make("shape", "no"), ordinal }
            : { _tag: "LinkEnded", chain: foreign, link, outcome: Outcome.to("return 1") }
        )
      }
      const terminal = ending === "done" ? Outcome.done("was done") : Outcome.park("timer", "was parked")
      if (ending !== "open") journal.push(inScope({ _tag: "LinkEnded", link, outcome: terminal }))

      const ask = (events: ReadonlyArray<Event.Event>): Promise<unknown> =>
        oracle.ask("replay", {
          calls: calls.map(([name, payload]) => [units(name), units(payload)]),
          catalog: digests,
          chain: units(scope),
          envelope: envelope === undefined ? null : units(envelope),
          events: events.map(wireOf),
          goal: units("g")
        })
      const said = await ask(journal) as ReadonlyArray<unknown>
      const { dispatched, events, result } = await ran(journal, scope, envelope)
      seen.add(String(said[0]))

      if (said[0] === "startDiverged") {
        const failure = failureOf(result)
        expect(failure.code).toBe("replay_divergence")
        expect(failure.message).toContain("was started with a different goal or envelope")
        expect(dispatched).toEqual([])
        expect(events).toEqual(journal)
        return
      }
      const fresh = said[1] as boolean
      expect(fresh).toBe(started === "fresh")
      if (said[0] === "finished") {
        expect(Result.isSuccess(result) && result.success).toEqual(terminal)
        expect(dispatched).toEqual([])
        expect(events.length).toBe(journal.length + (fresh ? 1 : 0))
        return
      }
      expect(said.slice(0, 4)).toEqual(["scripted", fresh, link, units(script.digest)])
      const steps = said[4] as ReadonlyArray<readonly [string, unknown]>
      const results: Array<string> = []
      const live: Array<readonly [number, unknown]> = []
      let diverged: string | undefined
      for (const [ordinal, [kind, detail]] of steps.entries()) {
        seen.add(kind)
        expect(kind).not.toBe("unlisted")
        if (kind === "replayed") results.push(textOf(detail as Units))
        else if (kind === "live") {
          live.push([ordinal, detail])
          results.push(`live:${ordinal}`)
        } else diverged = String(detail)
      }
      expect(dispatched).toEqual(live)
      if (diverged !== undefined) {
        seen.add(diverged)
        const failure = failureOf(result)
        expect(failure.code).toBe("replay_divergence")
        expect(failure.message).toContain(reasons.find(([reason]) => reason === diverged)![1])
        return
      }
      expect(steps.length).toBe(calls.length)
      expect(Result.isSuccess(result) && result.success).toEqual(Outcome.done(results))
      expect(events.length).toBe(journal.length + (fresh ? 1 : 0) + live.length + 1)

      // The link crashed before it ended: read again, every slot replays and nothing is dispatched.
      const resumed = events.slice(0, -1)
      const again = await ask(resumed) as ReadonlyArray<unknown>
      expect(again).toEqual([
        "scripted",
        false,
        link,
        units(script.digest),
        results.map((value) => ["replayed", units(value)])
      ])
      const second = await ran(resumed, scope, envelope)
      expect(second.dispatched).toEqual([])
      expect(Result.isSuccess(second.result) && second.result.success).toEqual(Outcome.done(results))
      expect(second.events).toEqual(events)
    })
    for (
      const kind of [
        "startDiverged",
        "finished",
        "scripted",
        "replayed",
        "live",
        ...reasons.map(([reason]) => reason)
      ]
    ) {
      expect(seen).toContain(kind)
    }
  })

  differential("the oracle was asked", () => {
    expect(oracle.asked()).toBeGreaterThan(0)
  })
})
