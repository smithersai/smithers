import { describe, expect, it } from "vitest"
import { budgetExceeded, compareText, encode, maxBytes, maxDepth, stringify } from "../src/internal/canonical.ts"

describe("canonical", () => {
  it("orders text by code unit and reports equality", () => {
    expect(compareText("a", "b")).toBe(-1)
    expect(compareText("b", "a")).toBe(1)
    expect(compareText("a", "a")).toBe(0)
  })

  it("sorts keys by code unit and normalises minus zero", () => {
    expect(stringify({ z: 1, "é": 2, a: -0, b: undefined })).toBe("{\"a\":0,\"z\":1,\"é\":2}\n")
  })

  it("marks a cycle instead of overflowing the stack", () => {
    const value: { self?: unknown; name: string } = { name: "root" }
    value.self = value
    expect(encode(value)).toEqual({ name: "root", self: "[circular]" })
  })

  it("keeps a value referenced twice without a cycle", () => {
    const shared = { a: 1 }
    expect(encode({ left: shared, right: shared })).toEqual({ left: { a: 1 }, right: { a: 1 } })
  })

  it("marks nesting past the declared depth", () => {
    let value: unknown = "leaf"
    for (let index = 0; index <= maxDepth + 1; index++) value = { next: value }
    expect(JSON.stringify(encode(value))).toContain("[depth exceeded]")
  })

  it("names every value JSON cannot express", () => {
    expect(encode({
      nan: Number.NaN,
      positive: Number.POSITIVE_INFINITY,
      negative: Number.NEGATIVE_INFINITY,
      big: 1n,
      fn: () => 1,
      sym: Symbol("s"),
      date: new Date("2026-01-01T00:00:00.000Z"),
      invalidDate: new Date(Number.NaN),
      error: new TypeError("boom"),
      set: new Set([1, 2]),
      map: new Map([["k", 1]]),
      list: [1, "two"]
    })).toEqual({
      big: "[bigint 1]",
      date: "2026-01-01T00:00:00.000Z",
      error: { message: "boom", name: "TypeError" },
      fn: "[function]",
      invalidDate: "[invalid Date]",
      list: [1, "two"],
      map: [["k", 1]],
      nan: "[NaN]",
      negative: "[-Infinity]",
      positive: "[Infinity]",
      set: [1, 2],
      sym: "[symbol]"
    })
  })

  it("reports a getter that threw instead of throwing out of the encoder", () => {
    const value = {
      get boom(): string {
        throw new TypeError("no")
      }
    }
    expect(encode(value)).toEqual({ boom: "[unreadable: TypeError: no]" })
  })

  it("reports proxies whose keys or collection iteration cannot be read", () => {
    const keys = new Proxy({}, {
      ownKeys: () => {
        throw new TypeError("keys unavailable")
      }
    })
    const iteration = new Proxy(new Set([1]), {
      get: (target, property, receiver) => {
        if (property === Symbol.iterator) throw new TypeError("iteration unavailable")
        return Reflect.get(target, property, receiver)
      }
    })
    const date = new Proxy(new Date("2026-01-01T00:00:00.000Z"), {
      get: () => {
        throw new TypeError("date unavailable")
      }
    })

    for (const value of [keys, iteration, date]) {
      expect(stringify(value)).toContain("[unreadable:")
    }

    const cause = new Proxy(new Error("hidden"), {
      get: () => {
        throw new Error("cause unavailable")
      }
    })
    const causeCannotBeRead = new Proxy({}, {
      ownKeys: () => {
        throw cause
      }
    })
    expect(stringify(causeCannotBeRead)).toBe("\"[unreadable]\"\n")
  })

  it("caps an embedded string and says how much it dropped", () => {
    expect(encode({ text: "abcdef" }, { maxStringLength: 3 })).toEqual({ text: "abc[truncated 3 chars]" })
    expect(encode({ text: "abc" }, { maxStringLength: 3 })).toEqual({ text: "abc" })
    expect(encode({ error: new TypeError("abcdef") }, { maxStringLength: 3 })).toEqual({
      error: { message: "abc[truncated 3 chars]", name: "Typ[truncated 6 chars]" }
    })
  })

  it("stops at the declared node budget", () => {
    // The array itself is the first node, so two entries survive a budget of 3.
    expect(encode([1, 2, 3, 4], { maxNodes: 3 })).toEqual([1, 2, budgetExceeded, budgetExceeded])
  })

  it("stops at the declared output byte budget", () => {
    expect(encode(["aaaa", "bbbb", "cccc"], { maxBytes: 12 })).toEqual(["aaaa", "bbbb", budgetExceeded])
  })

  it("bounds a shared acyclic graph instead of expanding it exponentially", () => {
    // Twenty-four two-child wrappers over one shared leaf are 25 distinct
    // objects at depth 24, far below maxDepth, that expand to 2^24 values.
    let shared: unknown = { leaf: 1 }
    for (let index = 0; index < 24; index++) shared = { left: shared, right: shared }
    const started = performance.now()
    const encoded = stringify(shared)
    expect(performance.now() - started).toBeLessThan(30_000)
    expect(encoded).toContain(budgetExceeded)
    expect(encoded.length).toBeLessThan(maxBytes)
    // The budget is spent in traversal order, so it truncates in one place.
    expect(stringify(shared)).toBe(encoded)
  })

  it("bounds a wide collection of long keys", () => {
    const wide = Object.fromEntries(Array.from({ length: 4096 }, (_, index) => [`${"k".repeat(64)}${index}`, index]))
    expect(stringify(wide, { maxBytes: 4096 })).toContain(budgetExceeded)
  })

  it("passes null and booleans through untouched", () => {
    expect(encode({ nothing: null, yes: true })).toEqual({ nothing: null, yes: true })
  })
})
