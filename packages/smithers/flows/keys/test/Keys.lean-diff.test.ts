/**
 * `deriveKey`, `KeyV1`, `StoredKey` and `digest` against their Lean 4 reference specification (`spec/lean/keys`),
 * generated: every case is answered by the implementation and by the specification's compiled oracle, and the two
 * answers must be equal. The oracle answers with the text that is hashed; the test hashes it and compares keys, so
 * agreement is agreement on every byte of the preimage. A refusal must carry the oracle's message.
 *
 * The oracle is one process for the whole file. It reads one JSON request per line and writes one JSON response per
 * line. A text crosses as its UTF-16 code units, so a lone surrogate arrives as it left. A number crosses as text: a
 * whole number in decimal, or `-0`, `nan`, `inf`, `-inf`. The specification covers no other double, so none is
 * generated. A value JSON has no form for crosses as its name.
 *
 * A machine with neither the built oracle nor `lake` skips the file; a machine with `lake` builds the oracle first,
 * and builds it again when a source of the specification is newer than it.
 */
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Redacted, Result, Schema } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DerivedKey, deriveKey, digest, KeyDerivationError, KeyV1, StoredKey } from "../src/index.ts"

// --- the oracle -----------------------------------------------------------------------------------------------------

const specDir = join(import.meta.dirname, "..", "spec", "lean", "keys")
const binary = join(specDir, ".lake", "build", "bin", "keys-spec")
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
    "KeysSpec.lean",
    "lakefile.toml",
    "lean-toolchain",
    ...readdirSync(join(specDir, "KeysSpec")).map((name) => join("KeysSpec", name))
  ]
  return sources.some((source) => statSync(join(specDir, source)).mtimeMs > built)
}

interface Oracle {
  readonly ask: (op: string, request: Readonly<Record<string, unknown>>) => Promise<unknown>
  /** Asks with a request already written as one line of JSON, for a value nested too deep to walk recursively. */
  readonly askLine: (line: string) => Promise<unknown>
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
  const askLine = (line: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
      asked++
      waiting.push({ resolve, reject })
      child.stdin.write(`${line}\n`)
    })
  return {
    ask: (op, request) => askLine(JSON.stringify({ op, ...request })),
    askLine,
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
      timeout: 120_000,
      env: { ...process.env, PATH: `${elan}${delimiter}${process.env["PATH"] ?? ""}` }
    })
    if (built.status !== 0) throw new Error(`lake build failed in ${specDir}:\n${built.stdout}\n${built.stderr}`)
  }
  oracle = start()
}, 120_000)

afterAll(() => {
  if (oracleReady) oracle.close()
})

// --- the wire -------------------------------------------------------------------------------------------------------

type Units = ReadonlyArray<number>

/** A text as its UTF-16 code units. */
const units = (text: string): Array<number> => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))

/** The text of code units. */
const textOf = (codes: Units): string => codes.map((unit) => String.fromCharCode(unit)).join("")

type Wire =
  | null
  | boolean
  | { readonly n: string }
  | { readonly s: Units }
  | { readonly x: string }
  | ReadonlyArray<
    Wire
  >
  | {
    readonly o: ReadonlyArray<readonly [Units, Wire]>
  }

const numberWire = (value: number): string => {
  if (Number.isNaN(value)) return "nan"
  if (value === Infinity) return "inf"
  if (value === -Infinity) return "-inf"
  if (Object.is(value, -0)) return "-0"
  return String(value)
}

/** Collections whose prototype the generator replaced so they pass for plain records. */
const masked = new WeakSet<object>()

/**
 * The value as the oracle reads it, taken from the built JavaScript value itself: an object's members cross in the
 * engine's own-key order, which puts index-like keys first and keeps one member per key; a hole in an array crosses
 * as the `undefined` reading it gives.
 */
const wire = (value: unknown): Wire => {
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return { n: numberWire(value) }
  if (typeof value === "string") return { s: units(value) }
  if (typeof value === "undefined" || typeof value === "symbol" || typeof value === "function") {
    return { x: typeof value }
  }
  if (typeof value === "bigint") return { x: "bigint" }
  if (Redacted.isRedacted(value)) return { x: "redacted" }
  if (masked.has(value)) return { x: "maskedCollection" }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? { x: "invalidDate" } : { s: units(value.toJSON()) }
  if (Array.isArray(value)) return Array.from({ length: value.length }, (_, index) => wire(value[index]))
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) return { x: "unsupported" }
  const record = value as Record<string, unknown>
  return { o: Object.keys(record).map((key) => [units(key), wire(record[key])] as const) }
}

// --- the implementation's answers, in the oracle's shapes ------------------------------------------------------------

type Derived = { readonly key: string } | { readonly refused: string }

const derived = async (input: unknown): Promise<Derived> => {
  const result = await Effect.runPromise(
    Effect.result(deriveKey(input)).pipe(Effect.provide(EffectDigest.layerWebCrypto))
  )
  if (Result.isSuccess(result)) return { key: result.success }
  expect(result.failure).toBeInstanceOf(KeyDerivationError)
  expect(result.failure.code).toBe("canonicalization_failed")
  return { refused: result.failure.message }
}

/** The oracle's answer as the implementation would give it: the key of the text it would hash, or its refusal. */
const keyed = (answer: unknown): Derived => {
  const preimage = answer as { readonly text: Units } | { readonly refused: string }
  if ("refused" in preimage) return preimage
  return { key: `key1_${createHash("sha256").update(textOf(preimage.text), "utf8").digest("hex")}` }
}

/** The specification's answer. */
const specified = async (input: unknown): Promise<Derived> =>
  keyed(await oracle.ask("preimage", { value: wire(input) }))

/** Both answers, which must be equal; returns the one answer. */
const agreed = async (input: unknown): Promise<Derived> => {
  const actual = await derived(input)
  expect(actual).toEqual(await specified(input))
  return actual
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

const bit: Arbitrary.Arbitrary<boolean> = Arbitrary.schema(Schema.Boolean)

const list = <A>(item: Arbitrary.Arbitrary<A>, maxLength: number): Arbitrary.Arbitrary<Array<A>> =>
  Arbitrary.array(item, { maxLength })

/**
 * Pieces a hostile text is built from: every escape class, the boundaries of the one-, two- and three-byte ranges,
 * both halves of a surrogate pair, the reserved keys, and keys the engine orders as indices.
 */
const fragments = [
  "a",
  "b",
  "Z",
  "_",
  "0",
  "10",
  "\"",
  "\\",
  "\b",
  "\t",
  "\n",
  "\f",
  "\r",
  "\u0000",
  "\u001f",
  " ",
  "\u007f",
  "\u0080",
  "é",
  "߿",
  "ࠀ",
  "퟿",
  "",
  "￿",
  "😺",
  "\ud83d",
  "\ude3a",
  "__proto__",
  "constructor",
  "toJSON",
  "key1_"
] as const

const text: Arbitrary.Arbitrary<string> = Arbitrary.map(list(pick(fragments), 4), (parts) => parts.join(""))

/** Whole numbers at every digit count and sign the serializer writes plainly, and the four special doubles. */
const numbers = [
  0,
  1,
  -1,
  -0,
  9,
  10,
  -10,
  99,
  100,
  255,
  65_536,
  2_147_483_648,
  -4_294_967_296,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  100_000_000_000_000_000_000,
  -100_000_000_000_000_000_000,
  Number.NaN,
  Infinity,
  -Infinity
] as const

class Box {
  readonly held = 1
}

/** Marks a collection as one that passes for a plain record: its prototype is `Object.prototype` or `null`. */
const mask = <A extends object>(collection: A, prototype: object | null): A => {
  Object.setPrototypeOf(collection, prototype)
  masked.add(collection)
  return collection
}

/** Makers of the values JSON has no form for; each call makes a fresh value. */
const opaques: ReadonlyArray<() => unknown> = [
  () => undefined,
  () => Symbol("made"),
  () => () => 1,
  () => Redacted.make("alice-secret"),
  () => 10n,
  () => new Date(Number.NaN),
  () => new Date(86_400_000),
  () => new Map([["a", 1]]),
  () => new Set([1]),
  () => new Uint8Array(2),
  () => /pattern/,
  () => new Box(),
  () => mask(new Map([["a", 1]]), Object.prototype),
  () => mask(new Set([1]), null),
  () => mask(new Uint8Array(2), Object.prototype)
]

/** Hostile leaves are rare so most trees reach the walk past them. */
const leaf: Arbitrary.Arbitrary<unknown> = Arbitrary.map(
  Arbitrary.all([int(0, 15), bit, pick(numbers), int(-1000, 1000), text, pick(opaques)]),
  ([choice, flag, special, whole, made, opaque]) =>
    choice === 0
      ? null
      : choice <= 2
      ? flag
      : choice === 3
      ? special
      : choice <= 7
      ? whole
      : choice <= 13
      ? made
      : opaque()
)

/** An object with exactly the generated own keys, `__proto__` included. */
const record = (entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> => {
  const made: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    Object.defineProperty(made, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return made
}

/** A tree at most `depth` containers deep. */
const tree = (depth: number): Arbitrary.Arbitrary<unknown> => {
  if (depth === 0) return leaf
  const below = tree(depth - 1)
  return Arbitrary.map(
    Arbitrary.all([int(0, 5), leaf, list(below, 3), list(Arbitrary.all([text, below]), 4)]),
    ([choice, plain, items, entries]) => (choice <= 1 ? plain : choice <= 3 ? items : record(entries))
  )
}

const value = tree(3)

/** A tree JSON has a form for everywhere: no special double, no opaque value, no lone surrogate. */
const plainLeaf: Arbitrary.Arbitrary<unknown> = Arbitrary.map(
  Arbitrary.all([int(0, 5), bit, int(-1000, 1000), list(pick(["a", "b", "\"", "\n", "é", "😺", "0", "10"]), 3)]),
  ([choice, flag, whole, parts]) => (choice === 0 ? null : choice === 1 ? flag : choice <= 3 ? whole : parts.join(""))
)

const plainTree = (depth: number): Arbitrary.Arbitrary<unknown> => {
  if (depth === 0) return plainLeaf
  const below = plainTree(depth - 1)
  return Arbitrary.map(
    Arbitrary.all([
      int(0, 3),
      plainLeaf,
      list(below, 3),
      list(Arbitrary.all([pick(["a", "b", "c", "0", "10", "é", ""]), below]), 4)
    ]),
    ([choice, plain, items, entries]) => (choice === 0 ? plain : choice === 1 ? items : record(entries))
  )
}

/** Fails the test with the shrunk counterexample unless the property holds for every generated value. */
const agrees = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  offset: number,
  property: (value: A) => Promise<void>
): Promise<void> => {
  const report = await Effect.runPromise(
    Fuzz.run(arbitrary, (generated) => Effect.as(Effect.tryPromise(() => property(generated)), true), {
      seed: seed + offset,
      executions
    })
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

/** The same members in the opposite insertion order, at every depth. */
const reversed = (input: unknown): unknown => {
  if (Array.isArray(input)) return input.map(reversed)
  if (typeof input !== "object" || input === null) return input
  const members = input as Record<string, unknown>
  return record(Object.keys(members).reverse().map((key) => [key, reversed(members[key])] as const))
}

/** `count` arrays around `inner`. */
const nest = (count: number, inner: unknown): unknown => {
  let made = inner
  for (let index = 0; index < count; index++) made = [made]
  return made
}

// --- the tests ------------------------------------------------------------------------------------------------------

describe("deriveKey against the Lean specification", () => {
  differential("hashes the specification's preimage, or refuses with its message", async () => {
    await agrees(value, 0, async (input) => {
      const actual = await agreed(input)
      // The schema form derives the same key and refuses the same inputs.
      const viaSchema = await Effect.runPromise(
        Effect.result(Schema.decodeUnknownEffect(DerivedKey)(input)).pipe(Effect.provide(EffectDigest.layerWebCrypto))
      )
      if ("key" in actual) expect(Result.isSuccess(viaSchema) && viaSchema.success).toBe(actual.key)
      else expect(Result.isFailure(viaSchema)).toBe(true)
    })
  })

  differential("keys a plain tree, and keys it the same in any member order", async () => {
    await agrees(plainTree(3), 1, async (input) => {
      const forward = await agreed(input)
      expect("key" in forward).toBe(true)
      expect(await agreed(reversed(input))).toEqual(forward)
    })
  })

  differential("tells apart plain trees the specification writes differently", async () => {
    await agrees(Arbitrary.all([plainTree(2), plainTree(2)]), 2, async ([first, second]) => {
      const [a, b] = [
        await oracle.ask("preimage", { value: wire(first) }),
        await oracle.ask("preimage", {
          value: wire(second)
        })
      ]
      const [keyA, keyB] = [await derived(first), await derived(second)]
      // Injectivity, observed: the keys agree exactly when the preimages do.
      expect(JSON.stringify(keyA) === JSON.stringify(keyB)).toBe(JSON.stringify(a) === JSON.stringify(b))
    })
  })

  differential("refuses each value JSON has no form for where the specification does", async () => {
    for (const make of opaques) {
      for (
        const place of [(inner: unknown) => inner, (inner: unknown) => [inner], (inner: unknown) => ({ a: inner })]
      ) {
        await agreed(place(make()))
        await agreed({ before: 1, held: place(make()), "\ud800": 1 })
        await agreed([Number.NaN, place(make())])
        await agreed([place(make()), Number.NaN])
      }
    }
    // A hole reads as `undefined`, which an array cannot hold.
    // eslint-disable-next-line no-sparse-arrays
    expect(await agreed([1, , 3])).toEqual({ refused: "undefined cannot be keyed" })
    expect(await agreed({ a: undefined, b: Symbol("s"), c: () => 1 })).toEqual(await agreed({}))
    expect(await agreed(-0)).toEqual(await agreed(0))
  })

  differential("refuses a collection that passes for a plain record (#4530)", async () => {
    const refused = { refused: "unsupported collection cannot be keyed" }
    expect(await agreed(mask(new Map([["a", 1]]), Object.prototype))).toEqual(refused)
    expect(await agreed(mask(new Map(), null))).toEqual(refused)
    expect(await agreed({ held: mask(new Set([1]), Object.prototype) })).toEqual(refused)
    expect(await agreed([mask(new Uint8Array(1), null)])).toEqual(refused)
    // An intact collection is refused by the serializer, without the name.
    expect(await agreed(new Map())).toEqual({ refused: "Key input could not be canonicalized" })
  })

  differential("keys nesting up to the limit and refuses one level more", async () => {
    // The request is written by hand: neither `wire` nor `JSON.stringify` walks ten thousand levels.
    const deep = async (count: number, inner: unknown): Promise<Derived> => {
      const actual = await derived(nest(count, inner))
      const line = `{"op":"preimage","value":${"[".repeat(count)}${JSON.stringify(wire(inner))}${"]".repeat(count)}}`
      expect(actual).toEqual(keyed(await oracle.askLine(line)))
      return actual
    }
    expect("key" in (await deep(10_000, null))).toBe(true)
    expect(await deep(10_001, null)).toEqual({ refused: "Key input could not be canonicalized" })
    // A value is checked as it is read, before its depth is.
    expect(await deep(10_001, Number.NaN)).toEqual({ refused: "NaN cannot be keyed" })
    expect(await deep(10_001, Redacted.make("alice-secret"))).toEqual({ refused: "redacted value cannot be keyed" })
    // A member that is left out is still read, and it is read one level too deep.
    expect("key" in (await deep(9999, { a: undefined }))).toBe(true)
    expect(await deep(10_000, { a: undefined })).toEqual({ refused: "Key input could not be canonicalized" })
  })
})

describe("stored keys against the Lean specification", () => {
  const digits = ["0", "9", "a", "f", "g", "A", "F", "/", ":", "`", "é", "\n"] as const
  const candidate: Arbitrary.Arbitrary<string> = Arbitrary.map(
    Arbitrary.all([
      pick(["key1_", "key1", "key2_", "Key1_", "", " key1_", "key1__"]),
      int(0, 9),
      pick([64, 64, 64, 63, 65, 0, 32]),
      pick(digits),
      list(Arbitrary.all([int(0, 70), pick(digits)]), 3),
      pick(["", "", "", "\n", " ", "0"])
    ]),
    ([prefix, choice, length, fill, edits, suffix]) => {
      const body = Array.from({ length }, (_, index) => (choice <= 5 ? "0123456789abcdef"[index % 16]! : fill))
      for (const [at, unit] of edits) if (at < body.length) body[at] = unit
      return `${prefix}${body.join("")}${suffix}`
    }
  )

  differential("KeyV1 and StoredKey accept exactly what the specification accepts", async () => {
    await agrees(candidate, 3, async (made) => {
      const valid = await oracle.ask("isKey", { text: units(made) })
      expect(Schema.is(KeyV1)(made)).toBe(valid)
      expect(Schema.is(StoredKey)(made)).toBe(valid)
      if (valid !== true) return
      expect(units(digest(Schema.decodeUnknownSync(StoredKey)(made)))).toEqual(
        await oracle.ask("digestOf", { text: units(made) })
      )
    })
  })

  differential("a derived key is a stored key whose digest is the preimage's hash", async () => {
    const key = await agreed({ domain: "test", version: 1 })
    if (!("key" in key)) throw new Error("a plain record has a key")
    expect(await oracle.ask("isKey", { text: units(key.key) })).toBe(true)
    expect(textOf((await oracle.ask("digestOf", { text: units(key.key) })) as Units)).toBe(
      digest(Schema.decodeUnknownSync(StoredKey)(key.key))
    )
  })
})

describe("key order against the Lean specification", () => {
  differential("orders keys by code unit, as the specification does", async () => {
    await agrees(Arbitrary.all([text, text]), 4, async ([a, b]) => {
      expect(await oracle.ask("lt", { a: units(a), b: units(b) })).toBe(a < b)
    })
  })
})

describe("the oracle", () => {
  differential("refuses a request it does not know, and keeps answering", async () => {
    await expect(oracle.ask("nope", {})).rejects.toThrow("unknown op nope")
    await expect(oracle.ask("preimage", { value: { n: "half" } })).rejects.toThrow("the oracle refused")
    expect(await oracle.ask("preimage", { value: null })).toEqual({ text: units("null") })
  })

  differential("answered every differential case of this file", () => {
    expect(oracle.asked()).toBeGreaterThan(executions * 6)
  })
})
