import { describe, expect, it } from "vitest"
import * as BoundedJson from "../src/BoundedJson.ts"

const limits: BoundedJson.Limits = {
  maxBytes: 1_024,
  maxDepth: 8,
  maxMembers: 8,
  maxNodes: 32,
  maxStringBytes: 128,
  maxKeyBytes: 64
}

const accepted = (value: unknown, overrides: Partial<BoundedJson.Limits> = {}) =>
  BoundedJson.admit(value, { ...limits, ...overrides })

describe("bounded JSON admission", () => {
  it("counts encoded bytes exactly, including empty strings and all control escapes", () => {
    const controls = String.fromCharCode(...Array.from({ length: 32 }, (_, unit) => unit))
    for (const value of ["", controls, "\"\\é€😀"]) {
      const bytes = Buffer.byteLength(JSON.stringify(value))
      expect(BoundedJson.encodedStringBytes(value)).toBe(bytes)
      expect(BoundedJson.encodedStringBytes(value, bytes)).toBe(bytes)
      expect(BoundedJson.encodedStringBytes(value, bytes - 1)).toBeUndefined()
    }
    const value = { key: [null, true, false, -0, 1.5, "\n"] }
    expect(BoundedJson.admit(value, { maxDepth: 8, maxNodes: 32, maxMembers: 8 }))
      .toMatchObject({ ok: true, bytes: Buffer.byteLength(JSON.stringify(value)) })
  })

  it("keeps per-container and cumulative member budgets distinct", () => {
    const value = { left: [1, 2], right: [3, 4] }
    expect(accepted(value, { maxMembers: 2 })).toMatchObject({ ok: true })
    expect(accepted(value, { maxMembers: 2, maxTotalMembers: 5 })).toMatchObject({ ok: false, path: ["right"] })
    expect(accepted([{ a: 1 }, { b: 2 }], { maxTotalMembers: 3 })).toMatchObject({ ok: false, path: ["1"] })
  })

  const wideObject = () => {
    const input = Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => [`k${index}`, 0]))
    let descriptorsInspected = 0
    const value = new Proxy(input, {
      getOwnPropertyDescriptor: (target, key) => {
        descriptorsInspected++
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    return { value, inspections: () => descriptorsInspected }
  }

  it("stops collecting object descriptors at the per-container member limit", () => {
    const observed = wideObject()
    expect(accepted(observed.value, { maxMembers: 3 }))
      .toMatchObject({ ok: false, code: "members", path: [] })
    expect(observed.inspections()).toBeLessThanOrEqual(4)
  })

  it("stops collecting nested object descriptors at the remaining total member limit", () => {
    const observed = wideObject()
    // Two root members and one member in left leave room for two in right.
    expect(accepted({ left: { a: 0 }, right: observed.value }, { maxTotalMembers: 5 }))
      .toMatchObject({ ok: false, code: "members", path: ["right"] })
    expect(observed.inspections()).toBeLessThanOrEqual(3)
  })

  it("stops collecting object descriptors at the remaining node limit", () => {
    const observed = wideObject()
    // The root, left, its value, and right have already consumed four nodes.
    expect(accepted({ left: { a: 0 }, right: observed.value }, { maxNodes: 7 }))
      .toMatchObject({ ok: false, code: "nodes", path: ["right"] })
    expect(observed.inspections()).toBeLessThanOrEqual(4)
  })

  it("stops collecting object descriptors when minimum encoded bytes exceed the budget", () => {
    for (const nested of [false, true]) {
      const observed = wideObject()
      const value = nested ? { left: { a: 0 }, right: observed.value } : observed.value
      // Four members need at least 21 bytes. The nested case has spent 25 already.
      expect(accepted(value, { maxBytes: nested ? 41 : 16 }))
        .toMatchObject({ ok: false, code: "bytes", path: nested ? ["right"] : [] })
      expect(observed.inspections()).toBeLessThanOrEqual(4)
    }
  })

  it("can preserve traversal-order diagnostics without relaxing admission limits", () => {
    const check = (value: unknown, maxBytes = limits.maxBytes) =>
      BoundedJson.admit(value, { ...limits, maxMembers: 2, maxNodes: 2, maxBytes }, { preflightObjects: false })
    expect(check({ a: 0, b: 0, c: 0 }))
      .toMatchObject({ ok: false, code: "members", path: [] })
    expect(check({ a: 0, b: 0 }))
      .toMatchObject({ ok: false, code: "nodes", path: ["b"] })
    expect(check({ a: 0 })).toMatchObject({ ok: true })
    expect(check({ a: 0 }, 6))
      .toMatchObject({ ok: false, code: "bytes", path: ["a"] })
  })

  it("admits objects exactly at their member, node, and encoded byte limits", () => {
    for (const value of [{}, { "": 0 }, { a: 0, b: { "": 0 } }]) {
      const members = Object.keys(value).length
      const totalMembers = members + ("b" in value ? 1 : 0)
      const bytes = Buffer.byteLength(JSON.stringify(value))
      expect(accepted(value, {
        maxMembers: members,
        maxTotalMembers: totalMembers,
        maxNodes: totalMembers + 1,
        maxBytes: bytes
      })).toMatchObject({ ok: true, bytes, value })
    }
  })

  const encoded = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

  it("admits trees exactly at the depth limit and refuses the level below it", () => {
    const cases: ReadonlyArray<readonly [number, unknown, ReadonlyArray<string>]> = [
      [0, true, []],
      [1, { child: true }, ["child"]],
      [1, [true], ["0"]],
      [2, { child: [true] }, ["child", "0"]],
      [3, [{ child: [true] }], ["0", "child", "0"]]
    ]
    for (const [depth, value, path] of cases) {
      expect(accepted(value, { maxDepth: depth })).toMatchObject({ ok: true, value, bytes: encoded(value) })
      expect(accepted(value, { maxDepth: depth - 1 })).toMatchObject({ ok: false, code: "depth", path })
    }
  })

  it("admits trees exactly at the node limit and refuses one node more", () => {
    const cases: ReadonlyArray<readonly [number, unknown, ReadonlyArray<string>]> = [
      [1, true, []],
      [1, {}, []],
      [3, [1, 2], ["1"]],
      [2, { a: 0 }, []],
      [3, { left: { a: 0 } }, ["left"]],
      [4, [{ a: 0 }, 1], ["1"]]
    ]
    for (const [nodes, value, path] of cases) {
      expect(accepted(value, { maxNodes: nodes })).toMatchObject({ ok: true, value, bytes: encoded(value) })
      expect(accepted(value, { maxNodes: nodes - 1 })).toMatchObject({ ok: false, code: "nodes", path })
    }
  })

  it("admits object keys exactly at the key byte limit and refuses one byte more", () => {
    for (const key of ["", "a", "\n", "é", "€", "😀"]) {
      const value = { [key]: 1 }
      expect(accepted(value, { maxKeyBytes: encoded(key) }))
        .toMatchObject({ ok: true, value, bytes: encoded(value) })
      expect(accepted(value, { maxKeyBytes: encoded(key) - 1 }))
        .toMatchObject({ ok: false, code: "key", path: [key] })
    }
    // A nested key is measured against the same limit as the key holding it.
    expect(accepted({ a: { é: 1 } }, { maxKeyBytes: 4 })).toMatchObject({ ok: true })
    expect(accepted({ a: { é: 1 } }, { maxKeyBytes: 3 })).toMatchObject({ ok: false, code: "key", path: ["a", "é"] })
  })

  it("admits mixed containers exactly at the cumulative member limit and refuses one member more", () => {
    const cases: ReadonlyArray<readonly [number, unknown, ReadonlyArray<string>]> = [
      [0, {}, []],
      [0, [], []],
      [3, [1, 2, 3], []],
      [2, { empty: [], nested: {} }, []],
      [5, { left: [1, 2], right: { a: 1 } }, ["right"]],
      [5, [{ a: 1 }, [2, 3]], ["1"]]
    ]
    for (const [total, value, path] of cases) {
      expect(accepted(value, { maxTotalMembers: total })).toMatchObject({ ok: true, value, bytes: encoded(value) })
      expect(accepted(value, { maxTotalMembers: total - 1 })).toMatchObject({ ok: false, code: "members", path })
    }
  })

  it("refuses impossible array lengths before they can reduce the cumulative member count", () => {
    const withLength = (length: number) =>
      new Proxy([], {
        getOwnPropertyDescriptor: (target, key) =>
          key === "length"
            ? { ...Object.getOwnPropertyDescriptor(target, key)!, value: length }
            : Object.getOwnPropertyDescriptor(target, key)
      })

    for (const length of [-1, -100, 0x100000000, Number.MAX_SAFE_INTEGER]) {
      expect(accepted(withLength(length))).toMatchObject({ ok: false, code: "arrayLength" })
    }
    // The largest valid array length still reaches the ordinary member bound.
    expect(accepted(withLength(0xffffffff))).toMatchObject({ ok: false, code: "members" })

    // Two object fields plus three array entries exceed a total budget of three.
    // A negative descriptor used to subtract from that total and admit all five.
    expect(accepted({ empty: [], values: [1, 2, 3] }, { maxTotalMembers: 3 }))
      .toMatchObject({ ok: false, code: "members", path: ["values"] })
    expect(accepted({ empty: withLength(-100), values: [1, 2, 3] }, { maxTotalMembers: 3 }))
      .toMatchObject({ ok: false, code: "arrayLength", path: ["empty"] })
  })

  it("identifies invalid fields without reading accessors", () => {
    const value = {
      nested: Object.defineProperty({}, "secret", {
        enumerable: true,
        get: () => {
          throw new Error("read")
        }
      })
    }
    expect(accepted(value)).toMatchObject({ ok: false, path: ["nested", "secret"] })
    expect(accepted({ nested: { long: true } }, { maxKeyBytes: 7 })).toMatchObject({ ok: false, path: ["nested"] })
  })

  it("copies every JSON scalar and UTF-8 width without approximation", () => {
    for (const value of [null, true, false, 0, -1.5, "ascii", "\"\\\n", "é", "€", "😀"]) {
      expect(accepted(value)).toMatchObject({ ok: true })
    }
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, 1n, Symbol("x"), () => 1]) {
      expect(accepted(value)).toMatchObject({ ok: false })
    }
  })

  it("rejects ill-formed and over-budget strings and keys", () => {
    for (const value of ["\ud800", "\udc00", "x".repeat(128)]) {
      expect(accepted(value, { maxStringBytes: 4 })).toMatchObject({ ok: false })
    }
    expect(accepted({ ["x".repeat(65)]: 1 })).toMatchObject({ ok: false })
    expect(accepted({ "\ud800": 1 })).toMatchObject({ ok: false })
    expect(accepted({ long: 1 }, { maxBytes: 4 })).toMatchObject({ ok: false })
    // The minimum member cost fits, but the actual key exhausts the byte budget.
    expect(accepted({ long: 1 }, { maxBytes: 6 })).toMatchObject({ ok: false, code: "bytes" })
  })

  it("enforces depth, node, member, and structural byte budgets", () => {
    expect(accepted({ child: { child: true } }, { maxDepth: 1 })).toMatchObject({ ok: false })
    expect(accepted([1, 2], { maxNodes: 2 })).toMatchObject({ ok: false })
    expect(accepted([1, 2], { maxMembers: 1 })).toMatchObject({ ok: false })
    expect(accepted({ a: 1, b: 2 }, { maxMembers: 1 })).toMatchObject({ ok: false })
    expect(accepted([], { maxBytes: 1 })).toMatchObject({ ok: false })
    expect(accepted({}, { maxBytes: 1 })).toMatchObject({ ok: false })
    expect(accepted({}, { maxMembers: -1 })).toMatchObject({ ok: false, code: "members" })
    expect(accepted({}, { maxTotalMembers: -1 })).toMatchObject({ ok: false, code: "members" })
    expect(accepted(null, { maxBytes: 3 })).toMatchObject({ ok: false })
    expect(accepted(true, { maxBytes: 3 })).toMatchObject({ ok: false })
    expect(accepted(false, { maxBytes: 4 })).toMatchObject({ ok: false })
    expect(accepted(123, { maxBytes: 2 })).toMatchObject({ ok: false })
    expect(accepted("a", { maxBytes: 2 })).toMatchObject({ ok: false })
  })

  // The byte budget models what the canonical encoder emits, and canonical
  // JSON escapes backspace, tab, newline, form feed, and carriage return as two
  // characters rather than as `\u00XX`. Charging six for them refused values
  // whose encoded form sat well inside the advertised bound, which is exactly
  // the shape a newline-heavy step result takes.
  it("charges a control character what its canonical escape actually costs", () => {
    const shortEscaped = "\b\t\n\f\r"
    const shortBytes = JSON.stringify(shortEscaped).length
    expect(shortBytes).toBe(12)
    expect(accepted(shortEscaped, { maxBytes: shortBytes, maxStringBytes: shortBytes }))
      .toMatchObject({ ok: true })
    expect(accepted(shortEscaped, { maxBytes: shortBytes - 1, maxStringBytes: shortBytes - 1 }))
      .toMatchObject({ ok: false })

    const longEscaped = "\u0001"
    const longBytes = JSON.stringify(longEscaped).length
    expect(longBytes).toBe(8)
    expect(accepted(longEscaped, { maxBytes: longBytes, maxStringBytes: longBytes }))
      .toMatchObject({ ok: true })
    expect(accepted(longEscaped, { maxBytes: longBytes - 1, maxStringBytes: longBytes - 1 }))
      .toMatchObject({ ok: false })
  })

  it("rejects cyclic, sparse, accessor-backed, and augmented arrays", () => {
    const cycle: Array<unknown> = []
    cycle.push(cycle)
    expect(accepted(cycle)).toMatchObject({ ok: false })
    expect(accepted(Array(1))).toMatchObject({ ok: false })
    const accessor: Array<unknown> = [1]
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => 1 })
    expect(accepted(accessor)).toMatchObject({ ok: false })
    const augmented = [1] as Array<unknown> & { extra?: number }
    augmented.extra = 2
    expect(accepted(augmented)).toMatchObject({ ok: false })
    const symbol = [1] as Array<unknown>
    Object.defineProperty(symbol, Symbol("extra"), { value: 2, enumerable: true })
    expect(accepted(symbol)).toMatchObject({ ok: false })
    const invalidLength = new Proxy([1], {
      getOwnPropertyDescriptor: (target, key) =>
        key === "length"
          ? { ...Object.getOwnPropertyDescriptor(target, key)!, value: "invalid" }
          : Object.getOwnPropertyDescriptor(target, key)
    })
    expect(accepted(invalidLength)).toMatchObject({ ok: false })
    const phantomIndex = new Proxy([1], {
      ownKeys: (target) => [...Reflect.ownKeys(target), "2"],
      getOwnPropertyDescriptor: (target, key) =>
        key === "2"
          ? { value: 2, enumerable: true, configurable: true, writable: true }
          : Object.getOwnPropertyDescriptor(target, key)
    })
    expect(accepted(phantomIndex)).toMatchObject({ ok: false })
    const hidden = Object.defineProperty([1], "extra", { value: 2, enumerable: false })
    expect(accepted(hidden)).toMatchObject({ ok: true })
  })

  it("rejects non-plain, accessor, symbol, and hostile objects without invoking getters", () => {
    expect(accepted(new Date())).toMatchObject({ ok: false })
    let reads = 0
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        reads++
        return 1
      }
    })
    expect(accepted(accessor)).toMatchObject({ ok: false })
    expect(reads).toBe(0)
    const symbol = Object.defineProperty({}, Symbol("value"), { value: 1, enumerable: true })
    expect(accepted(symbol)).toMatchObject({ ok: false })
    const hostile = new Proxy({}, {
      ownKeys: () => {
        throw new Error("hostile")
      }
    })
    expect(accepted(hostile)).toMatchObject({ ok: false })
    const phantom = new Proxy({}, {
      ownKeys: () => ["phantom"],
      getOwnPropertyDescriptor: () => undefined
    })
    expect(accepted(phantom)).toMatchObject({ ok: true })
  })

  it("returns detached deeply frozen arrays and null-prototype objects", () => {
    const input = { array: [{ value: 1 }] }
    const result = accepted(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(input)
    expect(result.value).not.toBe(input)
    expect(Object.isFrozen(result.value)).toBe(true)
    const array = (result.value as { readonly array: ReadonlyArray<object> }).array
    expect(Object.isFrozen(array)).toBe(true)
    expect(Object.isFrozen(array[0])).toBe(true)
  })
})
