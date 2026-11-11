import * as FastCheck from "fast-check"
import { describe, expect, it } from "vitest"
import * as BoundedJson from "../src/BoundedJson.ts"

const limits: BoundedJson.StrictLimits = {
  maxBytes: 1_000_000,
  maxDepth: 100,
  maxMembers: 10_000,
  maxNodes: 10_000,
  maxStringBytes: 1_000_000,
  maxKeyBytes: 1_000_000
}

describe("bounded JSON encoding properties", () => {
  it("strict admission checks the remaining member budget before enumerating arrays", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.integer({ min: 1, max: 256 }), (maxMembers) => {
        const inspected: Array<PropertyKey> = []
        let enumerations = 0
        const input = new Proxy(Array.from({ length: maxMembers }, () => 0), {
          ownKeys: (object) => {
            enumerations++
            return Reflect.ownKeys(object)
          },
          getOwnPropertyDescriptor: (object, key) => {
            inspected.push(key)
            return Reflect.getOwnPropertyDescriptor(object, key)
          }
        })
        // The enclosing record consumes one member, leaving too little for the array.
        expect(BoundedJson.admitStrict({ values: input }, { ...limits, maxMembers })).toEqual({
          ok: false,
          path: "$.values",
          complaint: `exceeds the ${maxMembers}-member limit`
        })
        expect(enumerations).toBe(0)
        expect(inspected).toEqual(["length"])
      }),
      {
        numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
        ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
        examples: [[1], [32], [256]]
      }
    )
  })

  it("admits generated JSON exactly at its encoded byte budget and refuses one byte less", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.jsonValue(), (value) => {
        const encoded = JSON.stringify(value)
        const bytes = Buffer.byteLength(encoded)
        const admitted = BoundedJson.admit(value, { ...limits, maxBytes: bytes })

        expect(admitted).toMatchObject({ ok: true, bytes })
        if (!admitted.ok) return
        expect(JSON.stringify(admitted.value)).toBe(encoded)
        expect(BoundedJson.admit(value, { ...limits, maxBytes: bytes - 1 })).toMatchObject({
          ok: false,
          code: "bytes"
        })
      }),
      {
        numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
        ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
        examples: [[null], ["\n\"\\😀"], [[null, true, { nested: ["é", 1e21, -0] }]]]
      }
    )
  })
})
