import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as JsonBoundary from "../src/JsonBoundary.ts"

describe("JsonBoundary", () => {
  it("decodes only the three outcomes", () => {
    expect(JsonBoundary.decodeOutcome({ _tag: "Done", value: 1 })._tag).toBe("Some")
    expect(JsonBoundary.decodeOutcome({ nope: true })._tag).toBe("None")
  })

  it("refuses non-JSON values at the boundary and copies the rest", () => {
    expect(JsonBoundary.jsonBoundary(undefined)).toEqual({ _tag: "Ok", value: null })
    const source = { deep: { list: [1, "two", true, null] } }
    const crossed = JsonBoundary.jsonBoundary(source)
    expect(crossed).toEqual({ _tag: "Ok", value: source })
    if (crossed._tag === "Ok") expect(crossed.value).not.toBe(source)

    expect(JsonBoundary.jsonBoundary(Number.NaN)._tag).toBe("Refused")
    expect(JsonBoundary.jsonBoundary(10n)._tag).toBe("Refused")
    expect(JsonBoundary.jsonBoundary(() => null)._tag).toBe("Refused")
    expect(JsonBoundary.jsonBoundary(new Date())._tag).toBe("Refused")
    expect(JsonBoundary.jsonBoundary({ meta: undefined })._tag).toBe("Refused")
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    expect(JsonBoundary.jsonBoundary(cycle)._tag).toBe("Refused")
  })

  it("normalizes the one value JSON cannot represent, and refuses array holes", () => {
    // The QuickJS binding encodes in-realm, so it hands the host `0` for a
    // script's `-0`. The in-process binding must agree, or the two runners
    // journal different payloads for the same script.
    const crossed = JsonBoundary.jsonBoundary(-0)
    expect(crossed._tag).toBe("Ok")
    if (crossed._tag === "Ok") expect(Object.is(crossed.value, 0)).toBe(true)

    // A hole is not a value. `JSON.stringify` would rewrite it to null; this
    // boundary refuses rather than change a value it accepts.
    expect(JsonBoundary.jsonBoundary([1, , 3])._tag).toBe("Refused")
  })

  it("copies an own __proto__ key as an own key, never as the copy's prototype", () => {
    // `Object.create(null)` passes the prototype check by design, and such a
    // value can carry an own `__proto__`. Plain assignment into the copy
    // would invoke Object.prototype's setter: the key would vanish and the
    // copy's prototype would become an object the walk validated as data.
    const source = Object.create(null) as Record<string, unknown>
    source["__proto__"] = { polluted: true }
    const crossed = JsonBoundary.jsonBoundary(source)
    expect(crossed._tag).toBe("Ok")
    if (crossed._tag === "Ok") {
      const copied = crossed.value as Record<string, unknown>
      expect(Object.keys(copied)).toEqual(["__proto__"])
      expect(Object.getPrototypeOf(copied)).toBe(Object.prototype)
      expect(Object.getOwnPropertyDescriptor(copied, "__proto__")?.value).toEqual({ polluted: true })
    }
  })

  it("refuses rather than throws on depth and size", () => {
    // Both bounds exist so a pathological value is a REFUSAL the script can
    // observe. Overflowing the walk's own stack, or handing a value on to a
    // `JSON.stringify` that throws `Invalid string length`, would be an
    // untyped defect that kills the run instead.
    let deep: unknown = null
    for (let index = 0; index <= JsonBoundary.maxJsonDepth; index = index + 1) deep = { deep }
    expect(JsonBoundary.jsonBoundary(deep)._tag).toBe("Refused")
    let shallow: unknown = null
    for (let index = 0; index < JsonBoundary.maxJsonDepth - 1; index = index + 1) shallow = { shallow }
    expect(JsonBoundary.jsonBoundary(shallow)._tag).toBe("Ok")

    expect(JsonBoundary.jsonBoundary("x".repeat(JsonBoundary.maxJsonSize))._tag).toBe("Refused")
    expect(JsonBoundary.jsonBoundary({ [`k`.repeat(JsonBoundary.maxJsonSize)]: 1 })._tag).toBe("Refused")
  })

  it("accepts the last value inside each bound and refuses the first outside it", () => {
    // The bounds are inclusive limits, so what pins them is the pair either
    // side of the edge: the value that spends the budget exactly and the one
    // that spends a single unit more. Assert only the far side and
    // `depth > maxJsonDepth` may become `>=`, or `budget < 0` may become
    // `<= 0`, and every other assertion here still passes while documented
    // values are refused.
    const nest = (links: number): unknown => {
      let value: unknown = null
      for (let index = 0; index < links; index = index + 1) value = { value }
      return value
    }
    expect(JsonBoundary.jsonBoundary(nest(JsonBoundary.maxJsonDepth))._tag).toBe("Ok")
    expect(JsonBoundary.jsonBoundary(nest(JsonBoundary.maxJsonDepth + 1))._tag).toBe("Refused")

    // The budget spends one unit per node plus one per code unit of every
    // string and key, so a root string costs `1 + length`.
    expect(JsonBoundary.jsonBoundary("x".repeat(JsonBoundary.maxJsonSize - 1))._tag).toBe("Ok")
    expect(JsonBoundary.jsonBoundary("x".repeat(JsonBoundary.maxJsonSize))._tag).toBe("Refused")

    // A one-key object costs one unit for itself, one for the value, and the
    // key's length. The key is charged; only the value's node was before.
    expect(JsonBoundary.jsonBoundary({ ["k".repeat(JsonBoundary.maxJsonSize - 2)]: 1 })._tag).toBe("Ok")
    expect(JsonBoundary.jsonBoundary({ ["k".repeat(JsonBoundary.maxJsonSize - 1)]: 1 })._tag).toBe("Refused")

    // Nodes are charged even when they carry no characters, so a wide value
    // cannot walk past the budget the way a long string cannot: an array of
    // N nulls costs N + 1.
    expect(JsonBoundary.jsonBoundary(new Array(JsonBoundary.maxJsonSize - 1).fill(null))._tag).toBe("Ok")
    expect(JsonBoundary.jsonBoundary(new Array(JsonBoundary.maxJsonSize).fill(null))._tag).toBe("Refused")

    // Length is CODE UNITS, not code points: an astral character costs two.
    // Charging code points would let a value twice the budget's worth of
    // UTF-16 through, which is the size `JSON.stringify` actually works in.
    const astral = "\u{1F600}".repeat((JsonBoundary.maxJsonSize - 2) / 2)
    expect(astral.length).toBe(JsonBoundary.maxJsonSize - 2)
    expect(JsonBoundary.jsonBoundary(astral + "x")._tag).toBe("Ok")
    expect(JsonBoundary.jsonBoundary(astral + "xx")._tag).toBe("Refused")
  })

  it("reads every property exactly once, so a changing accessor cannot smuggle a subtree", () => {
    // The old boundary validated one read and then serialized a SECOND, so a
    // getter that answered differently the second time crossed unvalidated.
    let reads = 0
    const shifty = {
      get a() {
        reads = reads + 1
        return reads === 1 ? 1 : { nested: "never validated" }
      }
    }
    expect(JsonBoundary.jsonBoundary(shifty)).toEqual({ _tag: "Ok", value: { a: 1 } })
    expect(reads).toBe(1)
  })

  it("converts a throwing accessor or trap into a refusal, never a throw", () => {
    const exploding = Object.defineProperty({}, "boom", {
      enumerable: true,
      get: () => {
        throw new Error("getter blew up")
      }
    })
    expect(JsonBoundary.jsonBoundary(exploding)._tag).toBe("Refused")

    const hostile = new Proxy({}, {
      ownKeys: () => {
        throw new Error("ownKeys blew up")
      }
    })
    expect(JsonBoundary.jsonBoundary(hostile)._tag).toBe("Refused")
  })

  it("renders failure values the way the realm dump renders them", () => {
    expect(JsonBoundary.failureMessage(new Error("kaput"))).toBe("kaput")
    expect(JsonBoundary.failureMessage({ message: "dumped" })).toBe("dumped")
    expect(JsonBoundary.failureMessage("bare")).toBe("bare")
  })

  // Every message below is answered by BOTH bindings: the host walk in
  // `ScriptRunner.ts` and the in-realm prelude in `QuickJsRunner.ts`. Each
  // used to be spelled out at its use site, two to four times over, and the
  // conformance suite could only catch the drift after it shipped. One
  // literal per message is what makes that drift impossible: the prelude
  // interpolates these constants the way it interpolates `maxJsonDepth`.
  it("spells every shared bridge message exactly once across the sources", () => {
    const sourceRoot = join(dirname(dirname(fileURLToPath(import.meta.url))), "src")
    const walk = (directory: string): ReadonlyArray<string> =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(directory, entry.name))
          : entry.name.endsWith(".ts")
          ? [join(directory, entry.name)]
          : []
      )
    const sources = walk(sourceRoot).map((file) => readFileSync(file, "utf8"))
    const occurrences = (message: string): number =>
      sources.reduce((total, source) => total + source.split(JSON.stringify(message)).length - 1, 0)

    const shared = {
      abortedLink: JsonBoundary.abortedLink,
      missingCallName: JsonBoundary.missingCallName,
      neverSettles: JsonBoundary.neverSettles,
      notAnOutcome: JsonBoundary.notAnOutcome,
      unserializableInput: JsonBoundary.unserializableInput,
      unserializableOutcome: JsonBoundary.unserializableOutcome
    }
    const counted = Object.fromEntries(
      Object.entries(shared).map(([name, message]) => [name, occurrences(message)])
    )
    expect(counted).toEqual({
      abortedLink: 1,
      missingCallName: 1,
      neverSettles: 1,
      notAnOutcome: 1,
      unserializableInput: 1,
      unserializableOutcome: 1
    })
  })
})
