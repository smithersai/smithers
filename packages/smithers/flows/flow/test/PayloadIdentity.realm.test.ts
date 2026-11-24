/**
 * R2-Astra-D1-015: a `Set` or `Map` made in another JavaScript realm is the
 * same collection for durable identity. `instanceof` misses it, so the sort
 * used to skip it and equal payloads kept their insertion order.
 */
import { describe, expect, it } from "@effect/vitest"
import { nativeBrand } from "@smthrs/canonical"
import { Action, Flow } from "@smthrs/flow"
import { Effect, Schema, SchemaTransformation } from "effect"
import { runInNewContext } from "node:vm"
import { withCrypto } from "./Crypto.ts"

/** Evaluates `source` in a new realm, with its own `Set`, `Map` and `Object`. */
const foreign = <A>(source: string): A => runInNewContext(`(${source})`) as A

const setEntries = (value: object): Array<unknown> => {
  const out: Array<unknown> = []
  Set.prototype.forEach.call(value, (entry) => out.push(entry))
  return out
}

const mapEntries = (value: object): Array<readonly [unknown, unknown]> => {
  const out: Array<readonly [unknown, unknown]> = []
  Map.prototype.forEach.call(value, (entry, key) => out.push([key, entry]))
  return out
}

// `Schema.ReadonlySet` accepts this realm's `Set` only, so these codecs read
// the collection's slots instead, as a host that crosses realms would.
const AnySet = Schema.declare((value): value is object =>
  typeof value === "object" && value !== null
  && nativeBrand(value) === "Set"
)
const AnyMap = Schema.declare((value): value is object =>
  typeof value === "object" && value !== null
  && nativeBrand(value) === "Map"
)

const Tags = Schema.Array(Schema.String).pipe(Schema.decodeTo(
  AnySet,
  SchemaTransformation.transform({
    decode: (entries): object => new Set(entries),
    encode: (set) => setEntries(set) as Array<string>
  })
))

const Groups = Schema.Array(Schema.Tuple([Schema.String, Tags])).pipe(Schema.decodeTo(
  AnyMap,
  SchemaTransformation.transform({
    decode: (entries): object => new Map(entries),
    encode: (map) => mapEntries(map) as Array<readonly [string, object]>
  })
))

const payload = { tags: Tags, groups: Groups }
const Release = Schema.Struct(payload)
const Echo = Action.make("PayloadIdentityRealm/echo", { payload: { value: Schema.String }, success: Schema.String })
const Ship = Flow.make("PayloadIdentityRealm/ship", {
  payload,
  success: Schema.String,
  body: () => Echo.call({ value: "shipped" })
})

const local = (): unknown => ({
  tags: new Set(["b", "a", "c"]),
  groups: new Map([["y", new Set(["2", "1"])], ["x", new Set(["4", "3"])]])
})
const sameOrder = (): unknown =>
  foreign(
    "{ tags: new Set(['b', 'a', 'c']), groups: new Map([['y', new Set(['2', '1'])], ['x', new Set(['4', '3'])]]) }"
  )
const opposite = (): unknown =>
  foreign(
    "{ tags: new Set(['c', 'a', 'b']), groups: new Map([['x', new Set(['3', '4'])], ['y', new Set(['1', '2'])]]) }"
  )

const sorted = { tags: ["a", "b", "c"], groups: [["x", ["3", "4"]], ["y", ["1", "2"]]] }

describe("payload identity across realms", () => {
  it.effect("gives equal collections one snapshot, whatever realm made them and in whatever order", () =>
    Effect.gen(function*() {
      expect(yield* Flow.payloadSnapshot(Release, local())).toEqual(sorted)
      expect(yield* Flow.payloadSnapshot(Release, sameOrder())).toEqual(sorted)
      expect(yield* Flow.payloadSnapshot(Release, opposite())).toEqual(sorted)
    }))

  it.effect("hashes a foreign collection as its sorted snapshot, never as written", () =>
    Effect.gen(function*() {
      const written = sameOrder()
      const preimage = yield* Flow.payloadPreimage(Release, written)
      expect(preimage === written).toBe(false)
      expect(preimage).toEqual(["snapshot", sorted])
      expect(yield* Flow.payloadPreimage(Release, opposite())).toEqual(preimage)
      expect(yield* Flow.payloadPreimage(Release, local())).toEqual(preimage)
    }))

  it.effect("derives one execution id for equal payloads from two realms", () =>
    withCrypto(Effect.gen(function*() {
      const id = yield* Flow.derived.mint(Ship, local())
      expect(yield* Flow.derived.mint(Ship, sameOrder())).toBe(id)
      expect(yield* Flow.derived.mint(Ship, opposite())).toBe(id)
      const other = foreign("{ tags: new Set(['a', 'b']), groups: new Map() }")
      expect(yield* Flow.derived.mint(Ship, other)).not.toBe(id)
    })))
})
