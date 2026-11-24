import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { CanonicalError, canonicalize, isNativeUrl, nativeBrand, slotlessProxy } from "../src/index.ts"
import { type BuiltinSource, makeNativeBrands, missedProbes } from "../src/internal/nativeBrand.ts"

const stripped = <A extends object>(value: A, prototype: object | null = null): A =>
  Object.setPrototypeOf(value, prototype)

const refusal = (value: unknown): CanonicalError => {
  try {
    canonicalize(value)
  } catch (error) {
    if (error instanceof CanonicalError) return error
    throw error
  }
  throw new Error("expected a refusal")
}

/** Counts the slot probes `run` made that threw. */
const missed = (run: () => void): number => {
  const before = missedProbes.count
  run()
  return missedProbes.count - before
}

const records = (count: number): Array<{ readonly i: number; readonly text: string }> =>
  Array.from({ length: count }, (_, i) => ({ i, text: "ok" }))

// One of every brand, in this realm, in another, and without its prototype,
// with the ordinary objects a probe must not mistake for one.
const samples = (): ReadonlyArray<readonly [string, object]> => [
  ["Map", new Map([[1, 2]])],
  ["Set", new Set([1])],
  ["WeakMap", new WeakMap()],
  ["WeakSet", new WeakSet()],
  ["ArrayBuffer", new ArrayBuffer(2)],
  ["SharedArrayBuffer", new SharedArrayBuffer(2)],
  ["Date", new Date(0)],
  ["RegExp", /a/g],
  ["Number", new Number(1)],
  ["String", new String("s")],
  ["Boolean", new Boolean(true)],
  ["BigInt", Object(1n) as object],
  ["Symbol", Object(Symbol("s")) as object],
  ["ArrayBufferView", new Uint8Array(1)],
  ["ArrayBufferView", new DataView(new ArrayBuffer(1))],
  ["Error", new RangeError("r")],
  ["foreign Map", runInNewContext("new Map([[1, 2]])") as object],
  ["foreign Set", runInNewContext("new Set([1])") as object],
  ["foreign Date", runInNewContext("new Date(0)") as object],
  ["foreign RegExp", runInNewContext("/a/g") as object],
  ["foreign String", runInNewContext("new String('s')") as object],
  ["foreign record", runInNewContext("({ a: 1 })") as object],
  ["null-prototype Map", stripped(new Map())],
  ["plain-prototype Set", stripped(new Set(), Object.prototype)],
  ["null-prototype Date", stripped(new Date(0))],
  ["null-prototype ArrayBuffer", stripped(new ArrayBuffer(4))],
  ["record", { a: 1 }],
  ["null-prototype record", Object.create(null) as object],
  ["array", [1]],
  ["function", () => 1],
  ["forged Number", Object.create(Number.prototype) as object],
  ["RegExp.prototype", RegExp.prototype],
  ["proxied Map", new Proxy(new Map(), {})],
  ["URL", new URL("https://example.test/a")]
]

describe("native brands on a host with slot predicates (#R2-Astra-D1-019)", () => {
  it("canonicalizes 10,000 fresh records without one thrown probe, to unchanged bytes", () => {
    const input = records(10_000)
    let bytes = ""
    expect(missed(() => {
      bytes = canonicalize(input)
    })).toBe(0)
    // Each record's keys are already sorted, so RFC 8785 gives JSON's bytes.
    expect(bytes).toBe(JSON.stringify(records(10_000)))
    expect(bytes.length).toBe(228_891)
  })

  it("answers ordinary objects, proxies and foreign records without throwing", () => {
    for (const [name, value] of samples()) {
      if (name === "URL") continue
      expect(missed(() => nativeBrand(value)), name).toBe(0)
    }
  })
})

describe("native brands on a host without slot predicates", () => {
  const portable = makeNativeBrands(undefined)
  const probeCount = 13

  it("names every value exactly as the host predicates do", () => {
    for (const [name, value] of samples()) {
      expect(String(portable.nativeBrand(value)), name).toBe(String(nativeBrand(value)))
      expect(portable.isNativeUrl(value), name).toBe(isNativeUrl(value))
    }
    expect(samples().map(([, value]) => String(nativeBrand(value)))).toEqual([
      "Map",
      "Set",
      "WeakMap",
      "WeakSet",
      "ArrayBuffer",
      "SharedArrayBuffer",
      "Date",
      "RegExp",
      "Number",
      "String",
      "Boolean",
      "BigInt",
      "Symbol",
      "ArrayBufferView",
      "ArrayBufferView",
      "Error",
      "Map",
      "Set",
      "Date",
      "RegExp",
      "String",
      "undefined",
      "Map",
      "Set",
      "Date",
      "ArrayBuffer",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined"
    ])
  })

  it("pays every probe once for a fresh record and never again", () => {
    const fresh = records(100)
    expect(missed(() => fresh.forEach((record) => portable.nativeBrand(record)))).toBe(100 * probeCount)
    expect(missed(() => fresh.forEach((record) => portable.nativeBrand(record)))).toBe(0)
  })

  it("answers for a slotless proxy without probing it", () => {
    const view = portable.slotlessProxy(new Map(), {})
    expect(missed(() => {
      expect(portable.nativeBrand(view)).toBeUndefined()
      expect(portable.isNativeUrl(view)).toBe(false)
    })).toBe(0)
    // A Proxy made any other way is probed, and has no slots either.
    expect(missed(() => expect(portable.nativeBrand(new Proxy(new Map(), {}))).toBeUndefined())).toBe(probeCount)
  })

  const lacking: ReadonlyArray<readonly [string, BuiltinSource]> = [
    ["an accessor that throws", {
      getBuiltinModule: (): unknown => {
        throw new Error("no such builtin")
      }
    }],
    ["a module that is not an object", { getBuiltinModule: (): unknown => "types" }],
    ["a null module", { getBuiltinModule: (): unknown => null }],
    ["a partial shim", { getBuiltinModule: (): unknown => ({ isMap: () => true, isSet: () => true }) }],
    ["no accessor", {}]
  ]

  it.each(
    lacking
  )("falls back to the probes when the host offers %s", (_name, source) => {
    const brands = makeNativeBrands(source)
    expect(brands.nativeBrand({ a: 1 })).toBeUndefined()
    expect(brands.nativeBrand(new Set())).toBe("Set")
    expect(brands.nativeBrand(stripped(new Date(0)))).toBe("Date")
  })

  it("lets a failure that is not a missing slot escape, and does not cache it", () => {
    const real = Map.prototype.has
    const cause = new RangeError("Maximum call stack size exceeded")
    const value = {}
    Map.prototype.has = () => {
      throw cause
    }
    try {
      expect(() => portable.nativeBrand(value)).toThrow(cause)
    } finally {
      Map.prototype.has = real
    }
    expect(missed(() => expect(portable.nativeBrand(value)).toBeUndefined())).toBe(probeCount)
  })
})

describe("slotlessProxy", () => {
  it("is an ordinary Proxy over its target", () => {
    const view = slotlessProxy({ a: 1 } as Record<string, number>, {
      get: (target, key) => typeof key === "string" && key in target ? target[key]! * 2 : undefined
    })
    expect(view["a"]).toBe(2)
    expect(nativeBrand(view)).toBeUndefined()
    expect(missed(() => expect(isNativeUrl(view)).toBe(false))).toBe(0)
  })
})

describe("a URL without its prototype (#R2-Astra-D1-020)", () => {
  it("is recognized by its slot, whatever its prototype", () => {
    expect(isNativeUrl(new URL("https://example.test/a"))).toBe(true)
    expect(isNativeUrl(stripped(new URL("https://example.test/a")))).toBe(true)
    expect(isNativeUrl(new Proxy(new URL("https://example.test/a"), {}))).toBe(false)
    expect(isNativeUrl(Object.create(URL.prototype) as object)).toBe(false)
    const plain = {}
    expect(missed(() => expect(isNativeUrl(plain)).toBe(false))).toBe(1)
    expect(missed(() => expect(isNativeUrl(plain)).toBe(false))).toBe(0)
  })

  it.each(
    [
      ["a null prototype", null],
      ["Object.prototype", Object.prototype]
    ] as const
  )("refuses two different URLs under %s instead of serializing both as {}", (_name, prototype) => {
    for (const address of ["https://example.test/a", "https://example.test/b"]) {
      const error = refusal({ link: stripped(new URL(address), prototype) })
      expect(error.code).toBe("canonical_unsupported_value")
      expect(error.message).toBe("canonical_unsupported_value: URL at $.link")
    }
  })

  it("refuses a null-prototype URL that gained an own key", () => {
    const url = Object.assign(stripped(new URL("https://example.test/a")), { note: 1 })
    expect(refusal(url).message).toBe("canonical_unsupported_value: URL at $")
  })

  it("keeps empty records valid and an ordinary URL's encoding", () => {
    expect(canonicalize({})).toBe("{}")
    expect(canonicalize(Object.create(null))).toBe("{}")
    expect(canonicalize({ a: Object.create(null), b: {} })).toBe("{\"a\":{},\"b\":{}}")
    expect(canonicalize({ link: new URL("https://example.test/a?b=1") })).toBe(
      "{\"link\":\"https://example.test/a?b=1\"}"
    )
  })

  it("answers no on a host without URL", () => {
    const brands = makeNativeBrands(undefined, {})
    expect(brands.isNativeUrl(new URL("https://example.test/a"))).toBe(false)
    expect(brands.nativeBrand(new Map())).toBe("Map")
  })
})

describe("a host without the newer intrinsics", () => {
  const bare = makeNativeBrands(undefined, {})

  it("has no SharedArrayBuffer brand to probe for", () => {
    expect(bare.nativeBrand(new SharedArrayBuffer(2))).toBeUndefined()
    expect(missed(() => bare.nativeBrand({}))).toBe(12)
  })

  it("reads an error from its prototype chain when Error.isError is absent", () => {
    expect(bare.nativeBrand(new TypeError("t"))).toBe("Error")
    expect(bare.nativeBrand({ message: "t" })).toBeUndefined()
    expect(makeNativeBrands(undefined, { Error: {} }).nativeBrand(new TypeError("t"))).toBe("Error")
  })
})
