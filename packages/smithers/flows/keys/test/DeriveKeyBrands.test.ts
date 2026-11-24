import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Effect } from "effect"
import type * as EffectDigest from "effect/crypto/Digest"
import { createHash } from "node:crypto"
import { isMap } from "node:util/types"
import { describe, expect, it } from "vitest"
import * as Keys from "../src/index.ts"

const provideCrypto = <A, E>(
  effect: Effect.Effect<A, E, EffectDigest.Digest>
): Effect.Effect<A, E> => Effect.provide(effect, NodeCrypto.layer)

const derive = (input: unknown): Keys.KeyV1 => Effect.runSync(provideCrypto(Keys.deriveKey(input)))

const refusal = (input: unknown): Keys.KeyDerivationError =>
  Effect.runSync(Effect.flip(provideCrypto(Keys.deriveKey(input))))

const stripped = (address: string, prototype: object | null): URL => Object.setPrototypeOf(new URL(address), prototype)

/**
 * Counts the slot probes `run` made on a value that lacks the slot.
 *
 * `Map.prototype.has` is the first portable probe, so a call whose receiver is
 * not a map is one object paying for the thrown probes.
 */
const failedSlotProbes = (run: () => void): number => {
  const real = Map.prototype.has
  let count = 0
  Map.prototype.has = function(this: unknown, key: unknown): boolean {
    if (!isMap(this)) count += 1
    return Reflect.apply(real, this, [key])
  }
  try {
    run()
  } finally {
    Map.prototype.has = real
  }
  return count
}

describe("deriveKey brand checks (R2-Astra-D1-019, R2-Fable-D1-013)", () => {
  it("keys 10,000 fresh records without a thrown slot probe, to unchanged bytes", () => {
    const records = (): ReadonlyArray<object> => Array.from({ length: 10_000 }, (_, i) => ({ i, text: "ok" }))
    let key = ""
    expect(failedSlotProbes(() => {
      key = derive(records())
    })).toBe(0)
    // Each record's keys are already sorted, so the canonical bytes are JSON's.
    expect(key).toBe(`key1_${createHash("sha256").update(JSON.stringify(records())).digest("hex")}`)
  })

  it("still counts a probe that does run", () => {
    expect(failedSlotProbes(() => {
      expect(() => Map.prototype.has.call({}, 1)).toThrow(TypeError)
    })).toBe(1)
  })
})

describe("deriveKey and a URL without its prototype (R2-Astra-D1-020)", () => {
  it.each(
    [
      ["a null prototype", null],
      ["Object.prototype", Object.prototype]
    ] as const
  )("refuses two different URLs under %s instead of keying both as {}", (_name, prototype) => {
    for (const address of ["https://example.test/a", "https://example.test/b"]) {
      for (
        const input of [stripped(address, prototype), { link: stripped(address, prototype) }, [
          stripped(address, prototype)
        ]]
      ) {
        expect(refusal(input)).toMatchObject({
          code: "canonicalization_failed",
          message: "URL without a serializer cannot be keyed"
        })
      }
    }
  })

  it("refuses a null-prototype URL that gained an own key", () => {
    const url = Object.assign(stripped("https://example.test/a", null), { note: 1 })
    expect(refusal(url).message).toBe("URL without a serializer cannot be keyed")
  })

  it("keeps empty records valid and distinct from a URL", () => {
    const empty = derive({})
    expect(derive(Object.create(null))).toBe(empty)
    expect(empty).toBe(`key1_${createHash("sha256").update("{}").digest("hex")}`)
    expect(derive({ a: {}, b: Object.create(null) })).toBe(
      `key1_${createHash("sha256").update("{\"a\":{},\"b\":{}}").digest("hex")}`
    )
  })

  it("keeps an ordinary URL's encoding, and its address in the key", () => {
    const key = derive({ link: new URL("https://example.test/a?b=1") })
    expect(key).toBe(
      `key1_${createHash("sha256").update("{\"link\":\"https://example.test/a?b=1\"}").digest("hex")}`
    )
    expect(derive({ link: new URL("https://example.test/b") })).not.toBe(key)
  })

  it("refuses a null-prototype URL even when it carries its own serializer", () => {
    const url = Object.assign(stripped("https://example.test/a", null), { toJSON: () => "mine" })
    expect(refusal(url).message).toBe("URL without a serializer cannot be keyed")
  })
})
