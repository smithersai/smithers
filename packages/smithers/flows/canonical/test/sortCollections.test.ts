import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as FastCheck from "fast-check"
import { describe, expect, it } from "vitest"
import { Canonical, sortCollections } from "../src/index.vibe"

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

/** VIP-44's identity pipeline up to the digest: sort, encode, canonicalize. */
const identity = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: S["Type"]): string =>
  Effect.runSync(
    Schema.encodeEffect(Schema.toCodecJson(schema))(sortCollections(value)).pipe(
      Effect.flatMap((encoded) => Schema.decodeUnknownEffect(Canonical)(encoded))
    )
  )

/** The same pipeline without the sort, as `ExecutionIds` hashed before VIP-44. */
const unsortedIdentity = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  value: S["Type"]
): string =>
  Effect.runSync(
    Schema.encodeEffect(Schema.toCodecJson(schema))(value).pipe(
      Effect.flatMap((encoded) => Schema.decodeUnknownEffect(Canonical)(encoded))
    )
  )

/** What a durable body receives: the value decoded from the sorted snapshot. */
const snapshot = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: S["Type"]): S["Type"] => {
  const codec = Schema.toCodecJson(schema)
  return Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(sortCollections(value)))
}

describe("sortCollections", () => {
  it("makes equal sets and maps encode to equal bytes, which the codec alone does not", () => {
    const Tags = Schema.ReadonlySet(Schema.String)
    const Prices = Schema.ReadonlyMap(Schema.String, Schema.Number)

    expect(unsortedIdentity(Tags, new Set(["a", "b"]))).not.toBe(unsortedIdentity(Tags, new Set(["b", "a"])))
    expect(identity(Tags, new Set(["a", "b"]))).toBe(identity(Tags, new Set(["b", "a"])))
    expect(identity(Tags, new Set(["b", "a"]))).toBe(`["a","b"]`)

    expect(identity(Prices, new Map([["b", 2], ["a", 1]]))).toBe(`[["a",1],["b",2]]`)
    expect(identity(Prices, new Map([["a", 1], ["b", 2]]))).toBe(identity(Prices, new Map([["b", 2], ["a", 1]])))
  })

  it("sorts at every depth: in a struct, an array, a map key and value, and a set of sets", () => {
    const Order = Schema.Struct({
      tags: Schema.ReadonlySet(Schema.String),
      lines: Schema.Array(Schema.ReadonlySet(Schema.Number)),
      index: Schema.ReadonlyMap(Schema.ReadonlySet(Schema.String), Schema.ReadonlySet(Schema.String)),
      groups: Schema.ReadonlySet(Schema.ReadonlySet(Schema.String))
    })
    const first = {
      tags: new Set(["y", "x"]),
      lines: [new Set([2, 1]), new Set([4, 3])],
      index: new Map([[new Set(["k2", "k1"]), new Set(["v2", "v1"])]]),
      groups: new Set([new Set(["d", "c"]), new Set(["b", "a"])])
    }
    const second = {
      tags: new Set(["x", "y"]),
      lines: [new Set([1, 2]), new Set([3, 4])],
      index: new Map([[new Set(["k1", "k2"]), new Set(["v1", "v2"])]]),
      groups: new Set([new Set(["a", "b"]), new Set(["c", "d"])])
    }

    expect(identity(Order, first)).toBe(identity(Order, second))
    expect(JSON.parse(identity(Order, first))).toEqual({
      groups: [["a", "b"], ["c", "d"]],
      index: [[["k1", "k2"], ["v1", "v2"]]],
      lines: [[1, 2], [3, 4]],
      tags: ["x", "y"]
    })
  })

  it("keeps array order, because array order is meaningful", () => {
    const Steps = Schema.Array(Schema.String)
    expect(identity(Steps, ["b", "a"])).toBe(`["b","a"]`)
    expect(identity(Steps, ["a", "b"])).not.toBe(identity(Steps, ["b", "a"]))
  })

  it("hands the body the order that was hashed", () => {
    const Order = Schema.Struct({ tags: Schema.ReadonlySet(Schema.String) })
    const body = snapshot(Order, { tags: new Set(["c", "a", "b"]) })
    expect([...body.tags]).toEqual(["a", "b", "c"])
  })

  it("orders a map by key, then by value when two keys rank the same", () => {
    const Point = Schema.Struct({ x: Schema.Number })
    const Labels = Schema.ReadonlyMap(Point, Schema.String)
    const left = new Map([[{ x: 1 }, "b"], [{ x: 1 }, "a"], [{ x: 0 }, "c"]])
    const right = new Map([[{ x: 1 }, "a"], [{ x: 0 }, "c"], [{ x: 1 }, "b"]])
    expect(identity(Labels, left)).toBe(identity(Labels, right))
    expect(identity(Labels, left)).toBe(`[[{"x":0},"c"],[{"x":1},"a"],[{"x":1},"b"]]`)
  })

  it("ranks each kind of value apart, so encodings never tie on insertion order", () => {
    const values: Array<unknown> = [
      "1",
      1,
      -0,
      0,
      1n,
      true,
      false,
      null,
      undefined,
      Symbol.for("s"),
      Symbol(),
      new Date(1),
      new Date(Number.NaN),
      /a.b/gi,
      new URL("https://x.dev/a"),
      Uint8Array.of(1, 2),
      Uint16Array.of(1, 2),
      new Uint8Array([9, 8, 7]).subarray(1),
      new ArrayBuffer(2),
      [1],
      { "1": 1 },
      Object.create(null),
      new Set([1]),
      new Map([[1, 1]]),
      new Error("boom"),
      function named() {}
    ]
    const shuffled = [...values].reverse()
    expect([...sortCollections(new Set(values))]).toEqual([...sortCollections(new Set(shuffled))])
    const sorted = [...sortCollections(new Set(values))]
    // -0 encodes as 0, so it must rank as 0: otherwise these equal encodings order apart.
    const Points = Schema.ReadonlySet(Schema.Struct({ x: Schema.Number, y: Schema.Number }))
    expect(identity(Points, new Set([{ x: -0, y: 2 }, { x: 0, y: 1 }]))).toBe(
      identity(Points, new Set([{ x: 0, y: 2 }, { x: 0, y: 1 }]))
    )
    // A subarray ranks by the bytes it views, not by its whole buffer.
    expect(sorted).toContain(values[16])
  })

  it("treats an object it cannot inspect as an unranked leaf, and never throws", () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const overSet = new Proxy(new Set(["b", "a"]), {})
    const value = { revoked: revoked.proxy, overSet }
    expect(sortCollections(value)).toBe(value)
    const sorted = sortCollections(new Set<unknown>(["b", revoked.proxy, "a"]))
    const out = [...sorted]
    expect(out.slice(0, 2)).toEqual(["a", "b"])
    expect(out[2] === revoked.proxy).toBe(true)
    const callable = Proxy.revocable(() => 1, {})
    callable.revoke()
    expect(() => sortCollections(new Set<unknown>([callable.proxy, "a"]))).not.toThrow()
  })

  it("returns the value itself when it reaches no collection", () => {
    const value = { a: [1, { b: new Date(0) }], c: "d" }
    expect(sortCollections(value)).toBe(value)
    expect(sortCollections("text")).toBe("text")
    expect(sortCollections(null)).toBe(null)
    const fn = () => 1
    expect(sortCollections(fn)).toBe(fn)
  })

  it("copies only the path to a collection and never mutates its input", () => {
    const untouched = { deep: { n: 1 } }
    const tags = new Set(["b", "a"])
    const value = { untouched, holder: { tags } }
    const sorted = sortCollections(value)
    expect(sorted).not.toBe(value)
    expect(sorted.untouched).toBe(untouched)
    expect(sorted.holder).not.toBe(value.holder)
    expect([...sorted.holder.tags]).toEqual(["a", "b"])
    expect([...tags]).toEqual(["b", "a"])
  })

  it("keeps cycles and shared references", () => {
    const shared = { tags: new Set(["b", "a"]) }
    const cyclic: { self?: unknown; left: typeof shared; right: typeof shared } = { left: shared, right: shared }
    cyclic.self = cyclic
    const sorted = sortCollections(cyclic)
    expect(sorted.self).toBe(sorted)
    expect(sorted.left).toBe(sorted.right)
    expect([...sorted.left.tags]).toEqual(["a", "b"])

    const loop: { self?: unknown; n: number } = { n: 1 }
    loop.self = loop
    const looped = sortCollections(new Set<unknown>([{ n: 2 }, loop]))
    expect([...looped][0]).toBe(loop)

    const ring = new Set<unknown>(["z"])
    ring.add(ring)
    const sortedRing = sortCollections(ring)
    expect(sortedRing.has(sortedRing)).toBe(true)
    expect(sortedRing.has("z")).toBe(true)
  })

  it("keeps prototypes, descriptors and integrity, and never invokes an accessor", () => {
    class Bag extends Set<string> {}
    class Ledger extends Map<string, number> {}
    class Lines extends Array<number> {}
    let reads = 0
    const frozen = Object.freeze({ tags: new Set(["b", "a"]) })
    const sealed = Object.seal({ tags: new Set(["b", "a"]) })
    const fixed = Object.preventExtensions({ tags: new Set(["b", "a"]) })
    const withAccessor = Object.defineProperty({ tags: new Set(["b", "a"]) }, "computed", {
      get: () => ++reads,
      enumerable: true
    })
    const lines = Lines.from([2, 1]) as Lines
    const sorted = sortCollections({
      bag: new Bag(["b", "a"]),
      ledger: new Ledger([["b", 2], ["a", 1]]),
      lines: Object.assign(lines, { extra: new Set([2, 1]) }),
      frozen,
      sealed,
      fixed,
      withAccessor
    })

    expect(sorted.bag).toBeInstanceOf(Bag)
    expect([...sorted.bag]).toEqual(["a", "b"])
    expect(sorted.ledger).toBeInstanceOf(Ledger)
    expect([...sorted.ledger.keys()]).toEqual(["a", "b"])
    expect(sorted.lines).toBeInstanceOf(Lines)
    expect(Array.isArray(sorted.lines)).toBe(true)
    expect([...sorted.lines]).toEqual([2, 1])
    expect([...sorted.lines.extra]).toEqual([1, 2])
    expect(Object.isFrozen(sorted.frozen)).toBe(true)
    expect(Object.isSealed(sorted.sealed) && !Object.isFrozen(sorted.sealed)).toBe(true)
    expect(Object.isExtensible(sorted.fixed) || Object.isSealed(sorted.fixed)).toBe(false)
    expect(reads).toBe(0)
    expect(Object.getOwnPropertyDescriptor(sorted.withAccessor, "computed")?.get).toBeTypeOf("function")
    expect([...sorted.withAccessor.tags]).toEqual(["a", "b"])
  })

  it("ranks accessors, null prototypes and class instances by their own data", () => {
    class Point {
      readonly x: number
      constructor(x: number) {
        this.x = x
      }
    }
    const nameless = Object.create({ constructor: 1 })
    nameless.v = 1
    const accessor = Object.defineProperty({}, "v", { get: () => 1, enumerable: true })
    const sorted = [...sortCollections(new Set<unknown>([new Point(2), new Point(1), accessor, nameless]))]
    expect(sortCollections(new Set<unknown>([nameless, accessor, new Point(1), new Point(2)]))).toEqual(
      new Set(sorted)
    )
    expect(sorted.indexOf(accessor)).toBeLessThan(sorted.findIndex((value) => value instanceof Point))
  })
})

/**
 * VIP-44 open question 1: must `sortCollections` walk the Schema instead of the
 * value, for a class that keeps fields out of its own enumerable properties?
 *
 * Answer: no. The value walk visits every own data property, enumerable or
 * not, and keeps the instance's prototype, so a declared class whose codec
 * reads a hidden field derives one identity. State a value walk cannot reach,
 * a private `#field`, is state a Schema walk cannot reach either: the Schema
 * only sees the codec's output, so such a class sorts in its own encoder.
 */
describe("open question 1: a class with fields outside its enumerable properties", () => {
  class Hidden {
    declare readonly tags: ReadonlySet<string>
    constructor(tags: ReadonlySet<string>) {
      Object.defineProperty(this, "tags", { value: tags, enumerable: false })
    }
    first(): string | undefined {
      return [...this.tags][0]
    }
  }
  const HiddenSchema = Schema.declare((u): u is Hidden => u instanceof Hidden, {
    toCodecJson: () =>
      Schema.link<Hidden>()(
        Schema.ReadonlySet(Schema.String),
        SchemaTransformation.transform({
          decode: (tags) => new Hidden(tags),
          encode: (hidden) => hidden.tags
        })
      )
  })

  it("derives one identity for equal hidden sets, and the body sees the sorted order", () => {
    expect(Object.keys(new Hidden(new Set(["a"])))).toEqual([])
    const ab = new Hidden(new Set(["a", "b"]))
    const ba = new Hidden(new Set(["b", "a"]))
    expect(unsortedIdentity(HiddenSchema, ab)).not.toBe(unsortedIdentity(HiddenSchema, ba))
    expect(identity(HiddenSchema, ab)).toBe(identity(HiddenSchema, ba))

    const sorted = sortCollections(ba)
    expect(sorted).toBeInstanceOf(Hidden)
    expect(Object.getOwnPropertyDescriptor(sorted, "tags")?.enumerable).toBe(false)
    expect(sorted.first()).toBe("a")
    expect(snapshot(HiddenSchema, ba).first()).toBe("a")
  })

  it("derives one identity for a Schema.Class holding a set", () => {
    class Release extends Schema.Class<Release>("Release")({ tags: Schema.ReadonlySet(Schema.String) }) {}
    const left = new Release({ tags: new Set(["b", "a"]) })
    const right = new Release({ tags: new Set(["a", "b"]) })
    expect(identity(Release, left)).toBe(identity(Release, right))
    expect(sortCollections(left)).toBeInstanceOf(Release)
  })

  it("leaves a private field alone; that class orders its collection in its own encoder", () => {
    class Private {
      readonly #tags: ReadonlySet<string>
      constructor(tags: ReadonlySet<string>) {
        this.#tags = tags
      }
      tags(): ReadonlySet<string> {
        return this.#tags
      }
    }
    const PrivateSchema = Schema.declare((u): u is Private => u instanceof Private, {
      toCodecJson: () =>
        Schema.link<Private>()(
          Schema.Array(Schema.String),
          SchemaTransformation.transform({
            decode: (tags) => new Private(new Set(tags)),
            encode: (value) => [...value.tags()].sort()
          })
        )
    })
    const ba = new Private(new Set(["b", "a"]))
    expect(sortCollections(ba)).toBe(ba)
    expect(sortCollections(ba).tags()).toBe(ba.tags())
    expect(identity(PrivateSchema, ba)).toBe(identity(PrivateSchema, new Private(new Set(["a", "b"]))))
  })
})

describe("known limits (TEST-5)", () => {
  // Ranks read own data properties only. Elements that differ only behind
  // accessors or private fields rank equal and keep their insertion order,
  // so a codec that reads those fields sees two orders. Expected to fail
  // until ranking can consult the element's schema encoding.
  it.fails("orders elements whose data lives only behind accessors", () => {
    const at = (n: number) =>
      Object.defineProperty({} as { readonly n: number }, "n", { get: () => n, enumerable: true })
    const one = at(1)
    const two = at(2)
    const forward = [...sortCollections(new Set([one, two]))].map((value) => value.n)
    const backward = [...sortCollections(new Set([two, one]))].map((value) => value.n)
    expect(backward).toEqual(forward)
  })
})

describe("sortCollections properties", () => {
  const shuffle = <A>(values: ReadonlyArray<A>, seed: number): Array<A> => {
    const out = [...values]
    let state = seed >>> 0
    for (let index = out.length - 1; index > 0; index--) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
      const other = state % (index + 1)
      ;[out[index], out[other]] = [out[other]!, out[index]!]
    }
    return out
  }

  /** Every element type VIP-44's schema mapping lists, with its schema. */
  const elements = [
    { name: "string", schema: Schema.String, arbitrary: FastCheck.string() },
    { name: "number", schema: Schema.Number, arbitrary: FastCheck.double({ noNaN: true, noDefaultInfinity: true }) },
    { name: "bigint", schema: Schema.BigInt, arbitrary: FastCheck.bigInt() },
    {
      name: "Date",
      schema: Schema.Date,
      arbitrary: FastCheck.date({ noInvalidDate: true, min: new Date(-8.64e15), max: new Date(8.64e15) })
    },
    {
      name: "URL",
      schema: Schema.URL,
      arbitrary: FastCheck.webUrl().map((href) => new URL(href))
    },
    {
      name: "RegExp",
      schema: Schema.RegExp,
      arbitrary: FastCheck.tuple(FastCheck.stringMatching(/^[a-z]{0,4}$/), FastCheck.constantFrom("", "g", "gi"))
        .map(([source, flags]) => new RegExp(source, flags))
    },
    { name: "Uint8Array", schema: Schema.Uint8Array, arbitrary: FastCheck.uint8Array({ maxLength: 6 }) },
    {
      name: "struct",
      schema: Schema.Struct({ id: Schema.String, n: Schema.Number }),
      arbitrary: FastCheck.record({ id: FastCheck.string(), n: FastCheck.integer() })
    }
  ] as const

  for (const element of elements) {
    it(`a ReadonlySet<${element.name}> has one identity under every insertion order`, () => {
      const Schema_ = Schema.ReadonlySet(element.schema as Schema.Codec<unknown, unknown, never, never>)
      FastCheck.assert(
        FastCheck.property(
          FastCheck.array(element.arbitrary as FastCheck.Arbitrary<unknown>, { maxLength: 8 }),
          FastCheck.nat(),
          (values, seed) => {
            const expected = identity(Schema_, new Set(values))
            expect(identity(Schema_, new Set(shuffle(values, seed)))).toBe(expected)
          }
        ),
        params
      )
    })

    it(`a ReadonlyMap keyed by ${element.name} has one identity under every insertion order`, () => {
      const Schema_ = Schema.ReadonlyMap(
        element.schema as Schema.Codec<unknown, unknown, never, never>,
        Schema.ReadonlySet(Schema.Number)
      )
      FastCheck.assert(
        FastCheck.property(
          FastCheck.uniqueArray(
            FastCheck.tuple(
              element.arbitrary as FastCheck.Arbitrary<unknown>,
              FastCheck.array(FastCheck.integer(), { maxLength: 4 })
            ),
            { maxLength: 8, selector: ([key]) => key, comparator: "SameValueZero" }
          ),
          FastCheck.nat(),
          (pairs, seed) => {
            const build = (entries: ReadonlyArray<readonly [unknown, ReadonlyArray<number>]>, salt: number) =>
              new Map(entries.map(([key, numbers]) => [key, new Set(shuffle(numbers, salt))] as const))
            expect(identity(Schema_, build(shuffle(pairs, seed), seed))).toBe(identity(Schema_, build(pairs, 0)))
          }
        ),
        params
      )
    })
  }

  it("never changes what an array-only value encodes to", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.jsonValue(), (value) => {
        expect(sortCollections(value)).toBe(value)
      }),
      params
    )
  })
})

describe("depth and shared references (#4493)", () => {
  const nest = (leaf: unknown, depth: number): unknown => {
    let value = leaf
    for (let level = 0; level < depth; level++) value = [value]
    return value
  }
  const leafOf = (value: unknown): unknown => {
    let current = value
    while (Array.isArray(current)) current = current[0]
    return current
  }
  /** `x = [y, y], y = [z, z], ...`: `depth` objects that expand to 2^depth leaves. */
  const shared = (leaf: unknown, depth: number): unknown => {
    let value: unknown = [leaf]
    for (let level = 0; level < depth; level++) value = [value, value]
    return value
  }

  it("orders set entries nested far past the call stack, under every insertion order", () => {
    // canonicalize accepts 10,000 levels; the recursive ranker overflowed near
    // 5,000 and fell back to insertion order.
    for (const depth of [1000, 5000, 9000, 10_000, 50_000]) {
      const forward = [...sortCollections(new Set([nest("a", depth), nest("b", depth)]))].map(leafOf)
      const backward = [...sortCollections(new Set([nest("b", depth), nest("a", depth)]))].map(leafOf)
      expect(forward, `depth ${depth}`).toEqual(["a", "b"])
      expect(backward, `depth ${depth}`).toEqual(["a", "b"])
    }
  })

  it("sorts a collection nested far past the call stack", () => {
    for (const depth of [3000, 10_000, 50_000]) {
      const sorted = sortCollections(nest(new Set(["b", "a"]), depth))
      expect([...leafOf(sorted) as Set<string>], `depth ${depth}`).toEqual(["a", "b"])
    }
    let sets: Set<unknown> = new Set(["b", "a"])
    for (let level = 0; level < 5000; level++) sets = new Set<unknown>(["c", sets])
    let inner: unknown = sortCollections(sets)
    for (let level = 0; level < 5000; level++) {
      const [next, text] = [...inner as Set<unknown>]
      expect(text).toBe("c")
      inner = next
    }
    expect([...inner as Set<string>]).toEqual(["a", "b"])
  })

  it("ranks an object once however often it is shared", () => {
    // 2^200 leaves when expanded. The unmemoized ranker took 13 s at depth 22.
    const forward = [...sortCollections(new Set([shared("b", 200), "x", shared("a", 200)]))].map(leafOf)
    const backward = [...sortCollections(new Set([shared("a", 200), "x", shared("b", 200)]))].map(leafOf)
    expect(forward).toEqual(["a", "b", "x"])
    expect(backward).toEqual(["a", "b", "x"])

    // Equal values built apart rank equal, so they keep their insertion order.
    const one = shared("a", 200)
    const two = shared("a", 200)
    expect([...sortCollections(new Set([one, two]))][0]).toBe(one)
    expect([...sortCollections(new Set([two, one]))][0]).toBe(two)

    // A shared object below a cycle is still ranked once; the cycle is not.
    const wide = shared("a", 200)
    const loop: Array<unknown> = [wide, wide]
    loop.push(loop)
    const other: Array<unknown> = [wide, wide]
    other.push(other, "after")
    const sorted = [...sortCollections(new Set([loop, other]))]
    expect(sorted[0]).toBe(other)
    expect(sorted[1]).toBe(loop)
    expect([...sortCollections(new Set([other, loop]))][0]).toBe(other)
  })

  it("orders a map by key, then by value, when the keys are too large to rank inline", () => {
    const key = (): ReadonlyArray<unknown> => ["k".repeat(2000), ["k".repeat(2000)]]
    const [first, second, third, fourth] = [key(), key(), key(), key()]
    const entries: ReadonlyArray<readonly [unknown, unknown]> = [
      [first, 12],
      [second, 1],
      [third, [1, "v".repeat(2000)]],
      [fourth, 1]
    ]
    const expected = [second, fourth, first, third]
    expect([...sortCollections(new Map(entries)).keys()]).toEqual(expected)
    expect([...sortCollections(new Map([...entries].reverse())).keys()]).toEqual([fourth, second, first, third])
    expect([...sortCollections(new Set<unknown>(["s", first, 3]))]).toEqual([3, first, "s"])
  })

  it("lets an engine RangeError through and never turns it into a rank", () => {
    const failing = (after: number): object => {
      let reads = 0
      return new Proxy({}, {
        ownKeys: () => {
          if (reads++ >= after) throw new RangeError("Maximum call stack size exceeded")
          return []
        }
      })
    }
    // Thrown while looking for collections, then while ranking.
    expect(() => sortCollections(new Set([failing(0), "a"]))).toThrow(RangeError)
    expect(() => sortCollections(new Set([failing(1), "a"]))).toThrow(RangeError)
    const unnamed = new Proxy(() => 1, {
      get: () => {
        throw new RangeError("Invalid string length")
      }
    })
    expect(() => sortCollections(new Set<unknown>([unnamed, "a"]))).toThrow(RangeError)
  })

  /** The rank text the recursive implementation built, for values that hold no cycle. */
  const textRank = (value: unknown): string => {
    if (typeof value === "string") return `s${JSON.stringify(value)}`
    if (typeof value === "number") return `n${value}`
    const object = value as object
    const prototype: unknown = Object.getPrototypeOf(object)
    const name = prototype === null ? "" : prototype === Array.prototype ? "Array" : "Object"
    const members = Object.getOwnPropertyNames(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${textRank((object as Record<string, unknown>)[key])}`)
    return `o${JSON.stringify(name)}{${members.join(",")}}`
  }
  const byText = <A>(values: ReadonlyArray<A>, rankOf: (value: A) => string): Array<A> =>
    values
      .map((value) => ({ value, rank: rankOf(value) }))
      .sort((left, right) => (left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : 0))
      .map(({ value }) => value)

  /** Trees with long equal prefixes and shared subtrees, so ranks split into shared parts. */
  const tree = FastCheck.letrec<{ tree: unknown; node: unknown }>((tie) => ({
    tree: FastCheck.oneof(
      { maxDepth: 6 },
      FastCheck.constantFrom<unknown>("a", "b", 1, 12, "p".repeat(700), `${"p".repeat(700)}a`, "q".repeat(1100)),
      tie("node")
    ),
    node: FastCheck.oneof(
      FastCheck.array(tie("tree"), { maxLength: 3 }),
      FastCheck.record({ a: tie("tree"), b: tie("tree") }, { requiredKeys: [] }),
      FastCheck.tuple(tie("tree"), tie("tree")).map(([key, entry]) => [key, key, [key, entry], entry])
    )
  })).tree

  it("orders entries exactly as their rank text orders, whatever the shape", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.array(tree, { maxLength: 6 }), FastCheck.boolean(), (values, asMap) => {
        if (asMap) {
          const pairs = values.map((value, index) => [[value], values[values.length - 1 - index]] as const)
          const expected = byText(pairs, ([key, entry]) => `${textRank(key)}\u0000${textRank(entry)}`)
          const sorted = [...sortCollections(new Map(pairs))]
          expect(sorted.map(([key]) => pairs.findIndex((pair) => pair[0] === key))).toEqual(
            expected.map((pair) => pairs.indexOf(pair))
          )
        } else {
          const entries = values.map((value) => [value])
          const sorted = [...sortCollections(new Set(entries))]
          expect(sorted.map((entry) => entries.indexOf(entry))).toEqual(
            byText(entries, textRank).map((entry) => entries.indexOf(entry))
          )
        }
      }),
      params
    )
  })
})
