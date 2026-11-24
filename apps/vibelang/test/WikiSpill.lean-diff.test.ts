// @vitest-environment node
/**
 * The wiki's journal encoding against its Lean 4 reference specification (`spec/lean/wiki_spill`), generated: every
 * case is answered by `worker/Wiki.vibe` over real object storage and by the specification's compiled oracle, and the
 * two answers must be equal, to the code unit for a text and to the byte for a budget.
 *
 * Stays .ts: it starts the oracle with node:child_process and reads the specification's sources with node:fs, host
 * code VibeLang rejects (EK4402).
 *
 * The oracle is one process for the whole file. It reads one JSON request per line and writes one JSON response per
 * line. A text crosses as its UTF-16 code units, a run of one unit as `[unit, count]`, so a lone surrogate arrives as
 * it left and a megabyte of filler stays short.
 *
 * A machine with neither the built oracle nor `lake` skips the file; a machine with `lake` builds the oracle first,
 * and builds it again when a source of the specification is newer than it.
 */
import { Fuzz } from "@smthrs/fuzz"
import { TestNodeRuntime } from "@smthrs/platform-node"
import { Arbitrary, Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { API, fakeClient, seed as seedGitHub } from "../fuzz/issues-node-fake.vibe"
import { wikiExecutionId, WikiHost } from "../src/core/wikiFlows.vibe"
import type { WikiRequest, WikiState } from "../src/core/wikiSchemas.vibe"
import type { Storage } from "../worker/Objects.vibe"
import {
  decodeWikiText,
  dehydrateWikiState,
  encodeWikiText,
  executeWiki,
  hydrateWikiState,
  jsonBytes,
  WikiAuthority
} from "../worker/Wiki.vibe"

// --- the oracle -----------------------------------------------------------------------------------------------------

const specDir = join(import.meta.dirname, "..", "spec", "lean", "wiki_spill")
const binary = join(specDir, ".lake", "build", "bin", "wiki-spill-spec")
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
    "WikiSpillSpec.lean",
    "lakefile.toml",
    "lean-toolchain",
    ...readdirSync(join(specDir, "WikiSpillSpec")).map((name) => join("WikiSpillSpec", name))
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
let raw: ReturnType<typeof TestNodeRuntime.sqliteObjectStorage>
let storage: Storage

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
  raw = TestNodeRuntime.sqliteObjectStorage()
  storage = raw as unknown as Storage
}, 150_000)

afterAll(() => {
  if (!oracleReady) return
  oracle.close()
  raw.close()
})

// --- the wire -------------------------------------------------------------------------------------------------------

type Wire = Array<number | [number, number]>

/** A text as its UTF-16 code units, a run of one unit as `[unit, count]`. */
const units = (text: string): Wire => {
  const wire: Wire = []
  let at = 0
  while (at < text.length) {
    const unit = text.charCodeAt(at)
    let end = at + 1
    while (end < text.length && text.charCodeAt(end) === unit) end++
    wire.push(end - at === 1 ? unit : [unit, end - at])
    at = end
  }
  return wire
}

/** The text a wire holds. */
const textOf = (wire: Wire): string =>
  wire.map((entry) =>
    typeof entry === "number" ? String.fromCharCode(entry) : String.fromCharCode(entry[0]).repeat(entry[1])
  ).join("")

/** Fails unless `actual` is, to the code unit, the text the oracle answered. */
const sameText = (actual: string, expected: Wire, what: string): void => {
  const wanted = textOf(expected)
  if (actual === wanted) return
  let at = 0
  while (at < actual.length && at < wanted.length && actual.charCodeAt(at) === wanted.charCodeAt(at)) at++
  expect.fail(
    `${what}: lengths ${actual.length} and ${wanted.length} differ at unit ${at}: ` +
      `${JSON.stringify(units(actual.slice(at, at + 8)))} against ${JSON.stringify(units(wanted.slice(at, at + 8)))}`
  )
}

type State = typeof WikiState.Type

const stateWire = (state: State) => ({
  seq: state.seq,
  pages: state.pages.map((page) => [units(page.id), units(page.source), units(page.revision)]),
  review: state.review === undefined ? null : units(state.review),
  draft: state.draft === undefined ? null : [units(state.draft.page), units(state.draft.text)],
  role: state.role === undefined ? null : units(state.role),
  stale: state.stale ?? null
})

// --- the implementation ---------------------------------------------------------------------------------------------

const KiB = 1024
const chunk = 32 * KiB
const entryCap = 2_031_616
const nul = "\u0000"
const lit = "\u0000lit:"
const blob = "\u0000blob:"
const high = "\ud83d"
const low = "\ude42"
const hostId = "wiki-spill-lean"
const actor = { id: "7", login: "lean", role: "maintainer" } as const
const authority = { current: () => Effect.succeed(actor) }
const read: WikiRequest = { op: "read", page: "roadmap", base: "", text: "", key: "read" }

const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff
const isLow = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff

/** An effect's success, or `undefined` for the refusal `unavailable`. */
const settled = async <A>(effect: Effect.Effect<A, { readonly reason: string }>): Promise<A | undefined> => {
  const result = await Effect.runPromise(Effect.result(effect))
  if (result._tag === "Success") return result.success
  expect(result.failure.reason).toBe("unavailable")
  return undefined
}

/** The chunks stored under a reference, in order, and the count its marker records. */
const stored = async (reference: string): Promise<{ readonly count: unknown; readonly chunks: Array<string> }> => {
  const root = `wiki/blob/${reference.slice(blob.length)}`
  const parts = await raw.list({ prefix: `${root}/` })
  return {
    count: await raw.get(root),
    chunks: [...parts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, part]) => part as string)
  }
}

interface Encoded {
  readonly value: Wire
  readonly encoded: boolean
  readonly bytes: number
  readonly chunks: ReadonlyArray<Wire> | null
}

/**
 * `encodeWikiText` at `threshold` by the implementation and by the oracle: the same journaled text and flag, the same
 * chunks in storage, and the text back from both.
 *
 * A reference names the SHA-256 of `TextEncoder`'s bytes, which writes every lone surrogate as U+FFFD. So two
 * ill-formed texts with one well-formed reading share a reference, in the specification as in the implementation, and
 * storage keeps the chunks of the first. `DurableText` refuses ill-formed text before `executeWiki` journals anything
 * (proved below), so only this direct call can meet such a pair; it then checks the shared reading and stops.
 */
const encodeAgrees = async (text: string, threshold?: number): Promise<{ readonly value: string; readonly spilled: boolean }> => {
  const actual = await Effect.runPromise(encodeWikiText(storage, text, true, threshold))
  const expected = await oracle.ask("encode", { text: units(text), threshold: threshold ?? null }) as Encoded
  sameText(actual.value, expected.value, "the journaled text")
  expect(actual.encoded).toBe(expected.encoded)
  expect(jsonBytes(text)).toBe(expected.bytes)
  let store: ReadonlyArray<unknown> = []
  if (expected.chunks !== null) {
    const kept = await stored(actual.value)
    if (kept.chunks.join("") !== text) {
      expect(text.isWellFormed()).toBe(false)
      expect(kept.chunks.join("").toWellFormed()).toBe(text.toWellFormed())
      return { value: actual.value, spilled: true }
    }
    expect(kept.count).toBe(expected.chunks.length)
    expect(kept.chunks.length).toBe(expected.chunks.length)
    for (const [index, part] of kept.chunks.entries()) sameText(part, expected.chunks[index]!, `chunk ${index}`)
    for (const [index, part] of kept.chunks.entries()) {
      expect(part.length).toBeGreaterThan(0)
      expect(part.length).toBeLessThanOrEqual(chunk + 1)
      const next = kept.chunks[index + 1]
      // The specification proves this for well-formed text (`splitChunks_noPairSplit`).
      if (next !== undefined && text.isWellFormed()) {
        expect(isHigh(part.charCodeAt(part.length - 1)) && isLow(next.charCodeAt(0))).toBe(false)
        expect(part.isWellFormed()).toBe(true)
      }
    }
    store = [[units(actual.value.slice(blob.length)), kept.chunks.map(units)]]
  }
  expect(await Effect.runPromise(decodeWikiText(storage, actual.value))).toBe(text)
  sameText(text, await oracle.ask("decode", { wire: expected.value, store }) as Wire, "the oracle's reading")
  return { value: actual.value, spilled: expected.chunks !== null }
}

interface Dehydrated {
  readonly tier: "first" | "compact" | "minimal" | "unavailable"
  readonly encoded: boolean
  readonly bytes: number
  readonly state: ReturnType<typeof stateWire>
}

/** `dehydrateWikiState` by the implementation and by the oracle: the same pass, state, flag and bytes, or refusal. */
const dehydrateAgrees = async (state: State): Promise<Dehydrated["tier"]> => {
  const actual = await settled(dehydrateWikiState(storage, state))
  const expected = await oracle.ask("dehydrate", { state: stateWire(state) }) as Dehydrated
  if (actual === undefined || expected.tier === "unavailable") {
    expect([actual, expected.tier]).toEqual([undefined, "unavailable"])
    return "unavailable"
  }
  expect(stateWire(actual.value)).toEqual(expected.state)
  expect(actual.encoded).toBe(expected.encoded)
  expect(jsonBytes(actual.value)).toBe(expected.bytes)
  expect(await oracle.ask("stateBytes", { state: stateWire(actual.value) })).toBe(expected.bytes)
  expect(expected.bytes).toBeLessThanOrEqual(1024 * KiB)
  expect(expected.bytes).toBeLessThan(entryCap)
  expect(await Effect.runPromise(hydrateWikiState(storage, actual.value))).toEqual(state)
  return expected.tier
}

/** `executeWiki` over the flow engine, the host's answer supplied. */
const act = (request: WikiRequest, host: WikiHost["Service"]) =>
  executeWiki(hostId, storage, request).pipe(
    Effect.provideService(WikiAuthority, authority),
    Effect.provideService(WikiHost, host),
    Effect.provide(FetchHttpClient.layer)
  )

/** The largest journal entry in storage, as SqlJournal budgets it: both JSON columns in bytes. */
const largestEntry = (): number => {
  const row = raw.sql.exec(
    "SELECT max(length(CAST(payload_json AS BLOB)) + length(CAST(meta_json AS BLOB))) AS largest FROM flows_journal_events"
  ).toArray()[0] as { readonly largest: number } | undefined
  return row?.largest ?? 0
}

// --- generators -----------------------------------------------------------------------------------------------------

const baseExecutions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "100"))
const executions = Math.max(25, Math.min(baseExecutions, 150))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261123")

const Int = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))
const hex = "0123456789abcdef".repeat(4)

/** Pieces of a hostile text: every JSON escape class, every UTF-8 width, both lone surrogates and the sentinels. */
const Piece = Schema.Literals([
  "a", "é", "界", "🙂", high, low, nul, "\u0001", "\u001f", "\b", "\t", "\n", "\f", "\r", "\"", "\\", "\u007f",
  "\u0080", "߿", "ࠀ", "￿", "lit:", "blob:", lit, blob, hex
])
const Pieces = Schema.Array(Piece).check(Schema.isMaxLength(12))
/** What a text starts with: nothing, NUL, a literal sentinel, a reference to nothing. */
const Head = Schema.Literals(["", nul, lit, blob, lit + lit, lit + blob + hex, blob + hex, nul + "x"])

/** Runs `property` on generated samples under @smthrs/fuzz and fails with the shrunk counterexample. */
const holds = async <A>(schema: Schema.Schema<A>, runs: number, property: (sample: A) => Promise<void>): Promise<void> => {
  const report = await Effect.runPromise(
    Fuzz.run(
      Arbitrary.schema(schema),
      (sample: A) => Effect.tryPromise({ try: async () => (await property(sample), true), catch: (error) => error }),
      { executions: runs, seed }
    )
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) expect.fail(failure)
  expect(report._tag).toBe("Passed")
}

// --- bytes and escaping ---------------------------------------------------------------------------------------------

describe("wiki text bytes and escaping against the Lean specification", () => {
  differential("jsonBytes counts the specification's JSON-escaped UTF-8 bytes of any code units", async () => {
    await holds(Schema.Struct({ head: Head, pieces: Pieces }), executions, async ({ head, pieces }) => {
      const text = head + pieces.join("")
      expect(await oracle.ask("jsonBytes", { text: units(text) })).toBe(jsonBytes(text))
      expect(await oracle.ask("wellFormed", { text: units(text) })).toBe(text.isWellFormed())
    })
    for (const unit of [0, 7, 8, 9, 10, 11, 12, 13, 14, 31, 32, 34, 92, 127, 128, 2047, 2048, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff]) {
      const text = String.fromCharCode(unit)
      expect(await oracle.ask("jsonBytes", { text: [unit] })).toBe(jsonBytes(text))
    }
    expect(await oracle.ask("jsonBytes", { text: units(high + low + low + high + high + low) })).toBe(2 + 4 + 6 + 6 + 4)
  })

  differential("a short text is journaled verbatim or as a literal, and reads back, as the specification says", async () => {
    await holds(Schema.Struct({ head: Head, pieces: Pieces }), executions, async ({ head, pieces }) => {
      const text = head + pieces.join("")
      const { value } = await encodeAgrees(text)
      sameText(value, await oracle.ask("escape", { text: units(text) }) as Wire, "the escaped text")
      sameText(text, await oracle.ask("unescape", { wire: units(value) }) as Wire, "the unescaped text")
      expect(value.startsWith(blob)).toBe(false)
      expect(value).toBe(text.startsWith(nul) ? lit + text : text)
    })
  })

  differential("any text read as a journaled text gives the specification's text or its refusal", async () => {
    await holds(Schema.Struct({ head: Head, pieces: Pieces }), executions, async ({ head, pieces }) => {
      const wire = head + pieces.join("")
      const actual = await settled(decodeWikiText(storage, wire))
      const expected = await oracle.ask("decode", { wire: units(wire), store: [] }) as Wire | null
      if (actual === undefined || expected === null) expect([actual, expected]).toEqual([undefined, null])
      else sameText(actual, expected, "the decoded text")
    })
  })
})

// --- spilling and chunks --------------------------------------------------------------------------------------------

describe("wiki text spilling against the Lean specification", () => {
  differential("a text above the threshold becomes the specification's reference and chunks, at any threshold", async () => {
    let spilled = 0
    await holds(
      Schema.Struct({ head: Head, pieces: Pieces, threshold: Int(0, 90) }),
      executions,
      async ({ head, pieces, threshold }) => {
        const text = head + pieces.join("")
        const result = await encodeAgrees(text, threshold)
        if (!result.spilled) return
        spilled++
        expect(result.value).toMatch(/^\u0000blob:[0-9a-f]{64}$/)
        sameText(result.value.slice(blob.length), await oracle.ask("digest", { text: units(text) }) as Wire, "the digest")
      }
    )
    expect(spilled).toBeGreaterThan(executions / 10)
  })

  differential("texts share a reference exactly when the specification's digest reads them alike", async () => {
    await holds(
      Schema.Struct({ before: Pieces, after: Pieces, first: Int(0xd7fe, 0xe001), second: Int(0xd7fe, 0xe001) }),
      executions,
      async ({ before, after, first, second }) => {
        const one = `${before.join("")}x${String.fromCharCode(first)}x${after.join("")}`
        const other = `${before.join("")}x${String.fromCharCode(second)}x${after.join("")}`
        const [a, b] = [await encodeAgrees(one, 0), await encodeAgrees(other, 0)]
        expect(a.value === b.value).toBe(one.toWellFormed() === other.toWellFormed())
        if (one.isWellFormed() && other.isWellFormed()) expect(a.value === b.value).toBe(one === other)
      }
    )
  })

  differential("chunks are the specification's at every 32 KiB boundary, and never split a surrogate pair", async () => {
    const Boundary = Schema.Literals(["🙂", high, low, high + high + low, high + "🙂" + low, "é", low + high, "a", high + "a"])
    await holds(
      Schema.Struct({
        head: Head,
        fill: Schema.Literals(["x", "\u0001", "界"]),
        offsets: Schema.Array(Int(-2, 2)).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
        boundary: Boundary,
        tail: Pieces
      }),
      Math.min(executions, 60),
      async ({ head, fill, offsets, boundary, tail }) => {
        let text = head
        for (const [index, offset] of offsets.entries()) {
          // The boundary's first unit lands on, or beside, the last unit of chunk `index`.
          text = text.padEnd(Math.max(text.length, (index + 1) * chunk - 1 + offset), fill) + boundary
        }
        text += tail.join("")
        const result = await encodeAgrees(text, 64)
        expect(result.spilled).toBe(true)
        if (!text.isWellFormed()) return
        const count = (await stored(result.value)).chunks.length
        expect(count).toBeGreaterThanOrEqual(Math.ceil(text.length / (chunk + 1)))
        expect(count).toBeLessThanOrEqual(Math.ceil(text.length / chunk))
      }
    )
  })

  differential("chunks agree at the boundary cases: a pair on, before and after the cut, and lone surrogates", async () => {
    const lengths = async (text: string) => (await stored((await encodeAgrees(text, 0)).value)).chunks.map((part) => part.length)
    expect(await lengths(`${"x".repeat(chunk - 1)}🙂tail`)).toEqual([chunk + 1, 4])
    expect(await lengths(`${"x".repeat(chunk - 2)}🙂tail`)).toEqual([chunk, 4])
    expect(await lengths(`${"x".repeat(chunk)}🙂tail`)).toEqual([chunk, 6])
    expect(await lengths("x".repeat(chunk))).toEqual([chunk])
    expect(await lengths(`${"x".repeat(chunk - 1)}🙂`)).toEqual([chunk + 1])
    expect(await lengths("🙂".repeat(chunk))).toEqual([chunk, chunk])
    expect(await lengths(`x${"🙂".repeat(chunk)}`)).toEqual([chunk + 1, chunk])
    expect(await lengths("")).toEqual([])
    // Ill-formed text never reaches the journal; the cut still follows the specification's rule, unit for unit.
    expect(await lengths(`${"x".repeat(chunk - 1)}${high}`)).toEqual([chunk])
    expect(await lengths(`${"x".repeat(chunk - 1)}${high}a`)).toEqual([chunk + 1])
    expect(await lengths(`${"y".repeat(chunk - 1)}${low}a`)).toEqual([chunk, 1])
    expect(await lengths(`${"z".repeat(chunk - 1)}${high}🙂`)).toEqual([chunk + 1, 1])
    // Two ill-formed texts with one well-formed reading share a reference; storage keeps the first.
    const [first, second] = [await encodeAgrees("\ud800", 0), await encodeAgrees("\ud801", 0)]
    expect(first.value).toBe(second.value)
    expect(await Effect.runPromise(decodeWikiText(storage, second.value))).toBe("\ud800")
    // SHA-256 of the UTF-8 bytes, as journaled receipts already record.
    expect((await encodeAgrees("abc", 0)).value).toBe(`${blob}ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`)
  })
})

// --- compaction -----------------------------------------------------------------------------------------------------

const Layout = Schema.Literals(["small", "small", "literals", "one large", "medium", "many", "edge", "refused"])
const StateSample = Schema.Struct({
  layout: Layout,
  pieces: Pieces,
  seq: Int(0, 1_000_000),
  delta: Int(-1, 1),
  extra: Int(0, 40),
  draft: Schema.Boolean,
  review: Schema.Boolean,
  stale: Schema.Boolean
})

/** A multi-page state that lands in the pass its layout names. */
const stateOf = (sample: typeof StateSample.Type): State => {
  const mix = sample.pieces.join("")
  const page = (index: number, source: string) => ({ id: `page-${index}`, source, revision: `rev-${index}${Array.from(mix).slice(0, 3).join("")}` })
  let pages: Array<State["pages"][number]>
  switch (sample.layout) {
    case "small":
      pages = Array.from({ length: sample.extra % 5 }, (_, index) => page(index, (index % 2 ? nul : "") + mix + index))
      break
    case "literals":
      pages = [nul, lit, lit + lit, blob + hex, lit + blob + hex, mix].map((source, index) => page(index, source))
      break
    case "one large":
      // 45,000 control characters are 270,000 bytes of JSON in well under 256 KiB of UTF-8.
      pages = [page(0, mix), page(1, lit + mix + "\u0001".repeat(45_000 + sample.extra)), page(2, nul + mix)]
      break
    case "medium":
      // Eight pages of 140 KiB pass the first pass whole and exceed 1 MiB together.
      pages = Array.from({ length: 8 }, (_, index) => page(index, (index % 2 ? lit : nul) + index + mix + "a".repeat(140 * KiB + sample.extra)))
      break
    case "many":
      // Eighty-four pages of 13 KiB stay inline at 16 KiB and exceed 1 MiB together.
      pages = Array.from({ length: 84 }, (_, index) => page(index, (index % 2 ? lit : "") + index + mix + "a".repeat(13 * KiB + sample.extra)))
      break
    case "edge":
      // No text starts with NUL, so the journaled state is the state itself.
      pages = Array.from({ length: 5 }, (_, index) => page(index, "e" + mix + "a".repeat(200 * KiB)))
      break
    case "refused":
      // Nothing spills an id: no pass can bring this state under 1 MiB.
      pages = [{ id: "i".repeat(1024 * KiB + sample.extra), source: mix, revision: "r" }, page(1, nul + mix)]
      break
  }
  const state: State = {
    seq: sample.seq,
    pages,
    ...(sample.review ? { review: `review ${mix}` } : {}),
    ...(sample.draft ? { draft: { page: read.page, text: sample.layout === "medium" ? lit + mix + "\u0001".repeat(45_000) : (sample.layout === "edge" ? "d" : nul) + mix } } : {}),
    ...(sample.stale ? { stale: sample.seq + sample.extra, role: "maintainer" as const } : {})
  }
  if (sample.layout !== "edge") return state
  // Exactly at, one under and one over the 1 MiB limit before anything spills.
  const edge = (source: string): State => ({ ...state, pages: [...pages, { id: "edge", source, revision: "r" }] })
  return edge("b".repeat(1024 * KiB + sample.delta - jsonBytes(edge(""))))
}

describe("wiki state compaction against the Lean specification", () => {
  differential("a state is journaled by the specification's pass, under the entry cap, and reads back whole", async () => {
    const tiers = new Map<string, number>()
    await holds(StateSample, Math.min(executions, 40), async (sample) => {
      const tier = await dehydrateAgrees(stateOf(sample))
      tiers.set(tier, (tiers.get(tier) ?? 0) + 1)
      if (sample.layout === "edge") expect(tier).toBe(sample.delta === 1 ? "compact" : "first")
    })
    expect([...tiers.keys()].sort()).toEqual(["compact", "first", "minimal", "unavailable"])
  })

  differential("every pass and the refusal are reached at their boundaries", async () => {
    const sample = { pieces: ["é", "\u0001"], seq: 7, delta: 0, extra: 3, draft: true, review: true, stale: true } as const
    const tierOf = async (layout: typeof Layout.Type, delta = 0) => await dehydrateAgrees(stateOf({ ...sample, layout, delta }))
    expect(await tierOf("small")).toBe("first")
    expect(await tierOf("literals")).toBe("first")
    expect(await tierOf("one large")).toBe("first")
    expect(await tierOf("edge", -1)).toBe("first")
    expect(await tierOf("edge", 0)).toBe("first")
    expect(await tierOf("edge", 1)).toBe("compact")
    expect(await tierOf("medium")).toBe("compact")
    expect(await tierOf("many")).toBe("minimal")
    expect(await tierOf("refused")).toBe("unavailable")
    expect(await dehydrateAgrees({ seq: 0, pages: [] })).toBe("first")
    expect(await oracle.ask("limits", {})).toEqual({
      blobThreshold: 256 * KiB,
      compactThreshold: 16 * KiB,
      stateTotalLimit: 1024 * KiB,
      draftInlineLimit: 64 * KiB,
      chunkSize: chunk,
      maxEntryBytes: entryCap
    })
  })
})

// --- the durable execution ------------------------------------------------------------------------------------------

describe("executeWiki over object storage against the Lean specification", () => {
  differential("a read journals the specification's state, marks it, stores its chunks and answers the whole state", async () => {
    let run = 0
    await holds(StateSample, 25, async (sample) => {
      // The engine's journal is the costly part: most runs keep the state small, a few compact a megabyte.
      const formed = { ...sample, pieces: sample.pieces.filter((piece) => piece !== high && piece !== low) }
      const state = stateOf(run % 6 === 5 ? formed : { ...formed, layout: formed.layout === "refused" ? "refused" : run % 2 ? "literals" : "small" })
      const request: WikiRequest = { ...read, key: `read-${seed}-${run++}` }
      const expected = await oracle.ask("dehydrate", { state: stateWire(state) }) as Dehydrated
      const answer = await Effect.runPromise(Effect.result(act(request, { perform: () => Effect.succeed(state) })))
      const marker = await raw.get(`wiki/blob-res/${await Effect.runPromise(wikiExecutionId(actor.id, "read", request.key))}`)
      if (expected.tier === "unavailable") {
        expect(answer._tag === "Failure" ? answer.failure : "accepted").toMatchObject({ reason: "unavailable" })
        return
      }
      expect(answer._tag === "Success" ? answer.success : answer.failure).toEqual({ ...state, role: actor.role })
      expect(marker === 1).toBe(expected.encoded)
      for (const wire of [...expected.state.pages.map((page) => page[1]!), ...(expected.state.draft === null ? [] : [expected.state.draft[1]!])]) {
        const journaled = textOf(wire)
        if (!journaled.startsWith(blob)) continue
        const kept = await stored(journaled)
        const original = await oracle.ask("decode", { wire, store: [[units(journaled.slice(blob.length)), kept.chunks.map(units)]] }) as Wire
        expect(kept.count).toBe(kept.chunks.length)
        expect(await oracle.ask("chunk", { text: original, size: chunk })).toEqual(kept.chunks.map(units))
      }
      expect(largestEntry()).toBeGreaterThan(0)
      expect(largestEntry()).toBeLessThanOrEqual(entryCap)
    })
  })

  differential("a save journals the specification's request texts and the host receives the texts as sent", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["", "a"],
      [nul, lit],
      [lit + blob + hex, blob + hex],
      [`${lit}${"x".repeat(chunk - 6)}🙂🙂${"\u0001".repeat(45_000)}`, `${blob}${hex}${"\u0001".repeat(44_000)}`],
      [`${"é".repeat(chunk - 1)}🙂${"\n".repeat(140_000)}`, `${nul}${"a".repeat(256 * KiB - 8)}`]
    ]
    for (const [index, [base, text]] of cases.entries()) {
      const request: WikiRequest = { ...read, op: "save", base, text, key: `save-${seed}-${index}` }
      const received: Array<WikiRequest> = []
      const state: State = { seq: index, pages: [{ id: read.page, source: base, revision: "r" }] }
      const host = { perform: (sent: WikiRequest) => Effect.sync(() => (received.push(sent), state)) }
      const answer = await Effect.runPromise(act(request, host))
      const replay = await Effect.runPromise(act(request, host))
      const [journaledBase, journaledText] = [await encodeAgrees(base), await encodeAgrees(text)]
      const marker = await raw.get(`wiki/blob-req/${await Effect.runPromise(wikiExecutionId(actor.id, "save", request.key))}`)
      expect(received).toHaveLength(1)
      expect(received[0]!.base === base && received[0]!.text === text).toBe(true)
      expect(answer.pages[0]!.source === base).toBe(true)
      expect(replay).toEqual(answer)
      expect(marker === 1).toBe(journaledBase.value !== base || journaledText.value !== text)
      expect(largestEntry()).toBeLessThanOrEqual(entryCap)
    }
  })

  differential("executeWiki refuses a lone surrogate before it journals or stores anything", async () => {
    const blobs = async () => (await raw.list({ prefix: "wiki/blob" })).size
    const before = await blobs()
    const unreachable = { perform: () => Effect.die("an ill-formed request reached the host") }
    for (const [index, lone] of [high, low, `a${high}`, `${low}🙂`, `🙂${high}`].entries()) {
      const large = lone + "\u0001".repeat(45_000)
      for (const request of [{ ...read, op: "save" as const, base: large }, { ...read, op: "save" as const, text: large }]) {
        const failure = await Effect.runPromise(Effect.flip(act({ ...request, key: `lone-${seed}-${index}` }, unreachable)))
        expect(failure).toMatchObject({ reason: "invalid", unwritten: true })
      }
    }
    expect(await blobs()).toBe(before)
  })

  differential("a retained draft is kept as written to 64 KiB of JSON and as the specification's reference above it", async () => {
    const repo = { owner: "o", name: "r", api: API, agent: "", root: "wiki" }
    const github = seedGitHub()
    github.files["wiki/roadmap.md"] = "on main"
    const call = (request: WikiRequest) =>
      executeWiki(hostId, storage, request, repo).pipe(
        Effect.provideService(WikiAuthority, authority),
        Effect.provideService(HttpClient.HttpClient, fakeClient(github))
      )
    const prefix = `${lit}${blob}${hex}é界🙂\u0001\n"\\`
    for (const over of [-1, 0, 1]) {
      const text = prefix + "x".repeat(64 * KiB - jsonBytes(prefix) + over)
      const failure = await Effect.runPromise(Effect.flip(call({ ...read, op: "save", key: `draft-${seed}-${over}`, text })))
      const retained = await raw.get(`wiki/draft/${actor.id}/${read.page}`) as { readonly page: string; readonly text: string; readonly blob?: number }
      const expected = await oracle.ask("retain", { text: units(text) }) as { readonly text: Wire; readonly blob: boolean }
      const answer = await Effect.runPromise(call({ ...read, key: `draft-read-${seed}-${over}` }))
      expect(failure).toMatchObject({ reason: "connect" })
      expect(expected.blob).toBe(over === 1)
      sameText(retained.text, expected.text, "the retained draft")
      expect(retained.blob === 1).toBe(expected.blob)
      const store = expected.blob ? [[units(retained.text.slice(blob.length)), (await stored(retained.text)).chunks.map(units)]] : []
      sameText(text, await oracle.ask("recall", { text: expected.text, blob: expected.blob, store }) as Wire, "the recalled draft")
      expect(answer.draft?.text === text).toBe(true)
    }
  })
})

describe("the oracle", () => {
  differential("refuses a request it does not know, and keeps answering", async () => {
    await expect(oracle.ask("nope", {})).rejects.toThrow("unknown op nope")
    await expect(oracle.ask("jsonBytes", { text: [65536] })).rejects.toThrow("the oracle refused")
    expect(await oracle.ask("reassemble", { chunks: [[1, 2], [], [[3, 2]]] })).toEqual([1, 2, [3, 2]])
    expect(await oracle.ask("chunk", { text: [1, 2, 3], size: 0 })).toEqual([[1, 2, 3]])
  })

  differential("answered every differential case of this file", () => {
    expect(oracle.asked()).toBeGreaterThan(1_000)
  })
})
