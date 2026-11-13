/**
 * The one structural canonicalizer four modules used to each carry a private,
 * subtly wrong copy of.
 */
import { describe, expect, it } from "vitest"
import { canonical, compare, same, snapshot } from "../src/internal/Structural.ts"
import * as ModelLike from "../src/ModelLike.ts"

const deeplyNested = (depth: number): Record<string, unknown> => {
  let value: Record<string, unknown> = { leaf: 1 }
  for (let level = 0; level < depth; level++) value = { nested: value }
  return value
}

describe("same", () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const accessor = Object.defineProperty({}, "answer", { enumerable: true, get: () => 1 })
  class Ticket {}
  it.each([
    ["undefined", undefined],
    ["NaN", NaN],
    ["positive infinity", Infinity],
    ["negative infinity", -Infinity],
    ["negative zero", -0],
    ["bigint", 1n],
    ["symbol", Symbol("marker")],
    ["function", () => 1],
    ["date", new Date(0)],
    ["invalid date", new Date(NaN)],
    ["regexp", /a/g],
    ["map", new Map([["a", 1]])],
    ["set", new Set([1])],
    ["error", new Error("failure")],
    ["foreign", new Ticket()],
    ["accessor", accessor],
    ["cycle", cyclic],
    ["depth limit", deeplyNested(130)],
    ["array hole", new Array(1)],
    [
      "opaque",
      new Proxy({}, {
        ownKeys: () => {
          throw new Error("opaque")
        }
      })
    ]
  ])("separates %s from an ordinary record containing its markers", (_name, value) => {
    const ordinary: unknown = JSON.parse(canonical(value).replaceAll("!{", "{"))
    expect(same(value, ordinary)).toBe(false)
  })

  it("separates the values Object.keys collapsed to an empty record", () => {
    expect(same(new Date(0), new Date(1))).toBe(false)
    expect(same(new Map([["a", 1]]), new Set([1]))).toBe(false)
    expect(same(-0, 0)).toBe(false)
    expect(same(Number.NaN, Number.POSITIVE_INFINITY)).toBe(false)
  })

  it("still answers true for the values it always compared correctly", () => {
    expect(same({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(true)
    expect(same([1, [2, 3]], [1, [2, 3]])).toBe(true)
    expect(same("a", "a")).toBe(true)
    expect(same(undefined, undefined)).toBe(true)
  })

  it("separates a missing key from an undefined one, and arrays from records", () => {
    expect(same({ a: undefined }, {})).toBe(false)
    expect(same([1], { 0: 1 })).toBe(false)
  })

  it("uses symbol reference identity instead of collapsing equal descriptions", () => {
    const shared = Symbol("x")
    expect(same(shared, shared)).toBe(true)
    expect(same({ a: shared }, { a: shared })).toBe(true)
    expect(same(Symbol("x"), Symbol("x"))).toBe(false)
    expect(same({ a: Symbol("x") }, { a: Symbol("x") })).toBe(false)
  })

  it.each([127, 128, 130, 50_000])("compares distinct equal values at depth %i", (depth) => {
    expect(same(deeplyNested(depth), deeplyNested(depth))).toBe(true)
    const different = deeplyNested(depth)
    let tail = different
    for (let level = 0; level < depth; level++) tail = tail.nested as Record<string, unknown>
    tail.leaf = 2
    expect(same(deeplyNested(depth), different)).toBe(false)
  })

  it("compares symbol-keyed fields by identity and value without invoking getters", () => {
    const key = Symbol("field")
    const other = Symbol("field")
    expect(same({ [key]: 1 }, { [key]: 2 })).toBe(false)
    expect(same({ [key]: 1 }, {})).toBe(false)
    expect(same({ [key]: 1 }, { [other]: 1 })).toBe(false)
    expect(same({ a: 1, [key]: 2 }, { [key]: 2, a: 1 })).toBe(true)
    expect(same({ [key]: 1, [other]: 2 }, { [other]: 2, [key]: 1 })).toBe(true)
    expect(same({ [key]: 1 }, { [String(key)]: 1 })).toBe(false)
    class Ticket {
      [key] = 1
    }
    expect(same(new Ticket(), new Ticket())).toBe(true)
    expect(same(Object.assign(new Error("x"), { [key]: 1 }), Object.assign(new Error("x"), { [key]: 2 }))).toBe(false)
    const getter = () => {
      throw new Error("must not run")
    }
    const accessor = () => Object.defineProperty({}, key, { enumerable: true, get: getter })
    expect(same(accessor(), accessor())).toBe(true)
    expect(same(accessor(), { [key]: 1 })).toBe(false)
  })

  it("compares deeply nested unordered collections and cycles without losing their contents", () => {
    const left = new Map([["a", new Set([deeplyNested(130), deeplyNested(131)])], ["b", new Set([deeplyNested(132)])]])
    const right = new Map([["b", new Set([deeplyNested(132)])], ["a", new Set([deeplyNested(131), deeplyNested(130)])]])
    expect(same(left, right)).toBe(true)
    const cycle = deeplyNested(130)
    cycle.self = cycle
    const other = deeplyNested(130)
    other.self = other
    expect(same(cycle, other)).toBe(true)
  })

  it("keeps callable proxies total when their name cannot be read", () => {
    const opaque = new Proxy(() => 1, {
      get: () => {
        throw new Error("opaque")
      }
    })
    expect(canonical(opaque)).toContain("Opaque")
    expect(same([opaque], [opaque])).toBe(true)
    expect(same(opaque, () => 1)).toBe(false)
  })

  it("uses function reference identity instead of collapsing equal names", () => {
    const shared = () => 1
    expect(same(shared, shared)).toBe(true)
    expect(same([shared], [shared])).toBe(true)
    expect(same(() => 1, () => 1)).toBe(false)
  })
})

describe("compare", () => {
  it("orders by code unit, so a rendering is byte-identical under any locale", () => {
    expect(["zebra", "äpple", "banana"].sort(compare)).toEqual(["banana", "zebra", "äpple"])
    // Matches the bare `.sort()` the effects list already uses.
    expect(["step-a", "stepa", "Step"].sort(compare)).toEqual(["step-a", "stepa", "Step"].sort())
  })
})

describe("canonical", () => {
  it("compares failed inspection by stable reference identity", () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const other = new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error("opaque")
      }
    })
    expect(canonical(revoked.proxy)).toContain("\"_tag\":\"Opaque\"")
    expect(canonical(revoked.proxy)).toBe(canonical(revoked.proxy))
    expect(same(revoked.proxy, other)).toBe(false)
    expect(same([revoked.proxy], [revoked.proxy])).toBe(true)
  })

  it("separates holes, undefined, and accessor elements without reading inherited values", () => {
    let reads = 0
    const getter = () => {
      reads++
      throw new Error("must not run")
    }
    const left = Object.defineProperty([], "0", { get: getter })
    const right = Object.defineProperty([], "0", { get: getter })
    expect(same(left, right)).toBe(true)
    expect(same(left, [undefined])).toBe(false)
    expect(same(new Array(1), [])).toBe(false)
    expect(same(new Array(1), [undefined])).toBe(false)
    const inherited = Object.setPrototypeOf(
      new Array(1),
      Object.create(Array.prototype, {
        0: { get: getter }
      })
    )
    expect(canonical(inherited)).toBe(canonical(new Array(1)))
    expect(reads).toBe(0)
  })

  it("tags every value JSON cannot express instead of dropping it", () => {
    expect(canonical(undefined)).toContain("Undefined")
    expect(canonical(1n)).toContain("BigInt")
    expect(canonical(Symbol("s"))).toContain("Symbol")
    expect(canonical(() => 1)).toContain("Function")
    expect(canonical(/a/g)).toContain("RegExp")
    expect(canonical(new Date(Number.NaN))).toContain("Invalid Date")
  })

  it("separates two symbols by description, and names an anonymous one null", () => {
    expect(canonical(Symbol("left"))).not.toBe(canonical(Symbol("right")))
    expect(canonical(Symbol())).toContain("null")
  })

  it("keeps a foreign object's constructor name so two classes never look alike", () => {
    class Ticket {}
    class Invoice {}
    expect(canonical(new Ticket())).toContain("Ticket")
    expect(same(new Ticket(), new Invoice())).toBe(false)
  })

  it("falls back to Object for a prototype that names no constructor", () => {
    // A prototype chain built by hand: not `Object.prototype`, not `null`, and
    // with no `constructor` to read a name from. Rendering it as `{}` is the
    // collapse this whole module exists to stop.
    const nameless = Object.create(Object.create(null) as object) as Record<string, unknown>
    nameless.a = 1
    expect(canonical(nameless)).toContain(`"constructor":"Object"`)
    expect(same(nameless, { a: 1 })).toBe(false)
  })

  it("renders a null-prototype record as a plain record", () => {
    const bare = Object.create(null) as Record<string, unknown>
    bare.a = 1
    expect(canonical(bare)).toBe(canonical({ a: 1 }))
  })

  it("describes a throwing accessor without invoking it", () => {
    let reads = 0
    const value = Object.defineProperty({}, "answer", {
      enumerable: true,
      get: () => {
        reads += 1
        throw new Error("must not run")
      }
    })
    expect(canonical(value)).toContain(`"_tag":"Accessor"`)
    expect(reads).toBe(0)
  })

  it("bounds deeply nested diagnostic rendering without limiting equality", () => {
    expect(canonical(deeplyNested(50_000))).toContain("TooDeep")
  })
})

describe("snapshot", () => {
  it("passes failed proxy inspection through for the encoder to reject", () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(snapshot(revoked.proxy)).toBe(revoked.proxy)
  })

  it("preserves an own __proto__ data key without changing the prototype", () => {
    const source = JSON.parse("{\"__proto__\":{\"polluted\":true},\"type\":\"object\"}")
    const copied = snapshot(source)
    expect(Object.hasOwn(copied, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype)
    expect(copied.polluted).toBeUndefined()
    expect(copied.__proto__).toEqual({ polluted: true })
    expect(copied.__proto__).not.toBe(source.__proto__)
  })

  it("preserves accessors and enumerability without reading them", () => {
    let reads = 0
    const source = Object.defineProperties({}, {
      answer: {
        enumerable: true,
        get: () => {
          reads++
          throw new Error("must not run")
        }
      },
      hidden: { value: { nested: 1 }, enumerable: false }
    })
    const copied = snapshot(source)
    expect(reads).toBe(0)
    expect(Object.getOwnPropertyDescriptor(copied, "answer")).toEqual(
      Object.getOwnPropertyDescriptor(source, "answer")
    )
    expect(Object.keys(copied)).toEqual(["answer"])
    expect(Object.getOwnPropertyDescriptor(copied, "hidden")!.value).not.toBe(
      Object.getOwnPropertyDescriptor(source, "hidden")!.value
    )
  })

  it("deep-copies the plain spine", () => {
    const source = { a: { b: [1, { c: 2 }] } }
    const copied = snapshot(source)
    source.a.b.push(3)
    ;(source.a.b[1] as { c: number }).c = 99
    expect(copied).toEqual({ a: { b: [1, { c: 2 }] } })
  })

  it("passes a non-plain value through rather than throwing on it", () => {
    const when = new Date(0)
    expect(snapshot({ when }).when).toBe(when)
    const fn = () => 1
    expect(snapshot({ fn }).fn).toBe(fn)
  })

  it("terminates on a cycle in a record and in an array", () => {
    const cyclic: Record<string, unknown> = { name: "a" }
    cyclic.self = cyclic
    expect((snapshot(cyclic).self as Record<string, unknown>).name).toBe("a")
    const loop: Array<unknown> = [1]
    loop.push(loop)
    expect((snapshot(loop)[1] as Array<unknown>)[0]).toBe(1)
  })

  it("keeps a symbol-keyed property so the fixture encoder can still reject it", () => {
    const key = Symbol("s")
    expect(Object.getOwnPropertySymbols(snapshot({ [key]: 1 }))).toEqual([key])
  })

  it("copies to the depth cap and passes the remaining tail through by reference", () => {
    const source = deeplyNested(50_000)
    const copied = snapshot(source)
    let sourceTail: unknown = source
    let copiedTail: unknown = copied
    for (let depth = 0; depth < 128; depth++) {
      sourceTail = (sourceTail as Record<string, unknown>).nested
      copiedTail = (copiedTail as Record<string, unknown>).nested
    }
    expect(copied).not.toBe(source)
    expect(copiedTail).toBe(sourceTail)
  })
})

describe("ModelLike.make", () => {
  it("builds the seam from its one method", () => {
    const stream = () => null as never
    const model = ModelLike.make({ stream })
    expect(model.stream).toBeTypeOf("function")
  })
})
