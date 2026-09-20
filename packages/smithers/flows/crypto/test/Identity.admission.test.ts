import { describe, expect, it, onTestFinished } from "vitest"
import { capture, functionIdentity } from "../src/Identity.ts"

describe("capture admission", () => {
  it.each([false, true])(
    "refuses a prototype-swapped Map before its hidden getter runs (frozen root: %s)",
    (frozen) => {
      const config = { value: 1 }
      let reads = 0
      const carrier = new Map([["slot", {
        get trigger() {
          reads++
          if (config.value === 1) config.value = 2
          Object.freeze(config)
          return 0
        }
      }]])
      Object.setPrototypeOf(carrier, Object.prototype)
      Object.freeze(carrier)
      const captures = { carrier, config }
      if (frozen) Object.freeze(captures)
      expect(() => capture(captures, () => captures.config.value))
        .toThrow(/capture at \$\.carrier has built-in internal slots/)
      expect(reads).toBe(0)
      expect(config.value).toBe(1)
      expect(Object.isFrozen(config)).toBe(false)
    }
  )

  it.each(
    [
      ["mutable", (value: object) => value],
      ["sealed", Object.seal],
      ["non-extensible", Object.preventExtensions],
      ["frozen", Object.freeze]
    ] as const
  )("accepts %s null-prototype children with mutable and frozen roots", (_name, lock) => {
    for (const frozen of [false, true]) {
      const config = Object.assign(Object.create(null), { nested: { value: 5 } })
      const applyState: (value: object) => object = lock
      applyState(config)
      const captures = { config }
      if (frozen) Object.freeze(captures)
      const operation = capture(captures, function() {
        return this
      })
      const copy = operation()
      expect(copy.config.nested.value).toBe(5)
      expect(copy).not.toBe(captures)
      expect(copy.config).not.toBe(config)
      expect(copy.config.nested).not.toBe(config.nested)
      expect(Object.isFrozen(copy)).toBe(true)
      expect(Object.isFrozen(copy.config)).toBe(true)
      expect(Object.isFrozen(copy.config.nested)).toBe(true)
      expect(Object.getPrototypeOf(copy.config)).toBe(Object.prototype)
      expect(Object.getPrototypeOf(config)).toBe(null)
      const identity = functionIdentity(operation)
      config.nested.value = 99
      expect(operation().config.nested.value).toBe(5)
      expect(functionIdentity(operation)).toEqual(identity)
    }
  })

  it("rejects internal-slot brands regardless of prototype without invoking caller code", () => {
    const factories = [
      () => new Map(),
      () => new Set(),
      () => new WeakMap(),
      () => new WeakSet(),
      () => new Date(),
      () => /pattern/,
      () => new ArrayBuffer(2),
      () => new SharedArrayBuffer(2),
      () => new DataView(new ArrayBuffer(2)),
      () => new Uint8Array(2),
      () => new BigInt64Array(2),
      () => Object(1),
      () => Object("text"),
      () => Object(true),
      () => Object(1n),
      () => Object(Symbol("x")),
      () => new WeakRef({}),
      () => new FinalizationRegistry(() => undefined)
    ]
    for (const make of factories) {
      for (const prototype of [Object.prototype, null]) {
        let reads = 0
        const value = make()
        Object.defineProperty(value, Symbol.toStringTag, {
          get: () => {
            reads++
            return "Object"
          }
        })
        Object.setPrototypeOf(value, prototype)
        expect(() => capture({ value }, () => undefined)).toThrow(
          /capture at \$\.value has built-in internal slots/
        )
        expect(reads).toBe(0)
      }
    }
  })

  it("refuses plain objects with a toStringTag accessor without reading it", () => {
    let reads = 0
    const value = Object.defineProperty({}, Symbol.toStringTag, {
      get: () => {
        reads++
        return "Map"
      }
    })
    expect(() => capture({ value }, () => undefined)).toThrow(/capture at \$\.value has symbol key/)
    expect(reads).toBe(0)
  })

  it("refuses Promise and Error brands that cannot be safely branded on the original", () => {
    const promise = Promise.resolve(1)
    expect(() => capture({ promise }, () => undefined)).toThrow(/capture at \$\.promise has a non-plain prototype/)
    Object.setPrototypeOf(promise, null)
    expect(() => capture({ promise }, () => undefined)).toThrow(
      /capture at \$\.promise cannot be structured-cloned/
    )
    // An Error's own properties differ by host: V8 gives it `stack`, Bun adds
    // `line`, `column`, and `sourceURL`. Stripping all of them leaves only the
    // internal brand, so both hosts reach the same refusal instead of stopping
    // one step earlier at a non-enumerable member.
    const error = new Error()
    for (const key of Reflect.ownKeys(error)) Reflect.deleteProperty(error, key)
    Object.setPrototypeOf(error, Object.prototype)
    expect(Reflect.ownKeys(error)).toEqual([])
    expect(() => capture({ error }, () => undefined)).toThrow(/capture at \$\.error clones as a built-in object/)
  })

  it("normalizes reflection and revoked Proxy failures to path-bearing TypeErrors", () => {
    const revocable = Proxy.revocable({}, {})
    revocable.revoke()
    for (
      const value of [
        revocable.proxy,
        new Proxy({}, {
          getPrototypeOf() {
            throw new Error("trap")
          }
        }),
        new Proxy({}, {
          ownKeys() {
            throw new Error("trap")
          }
        }),
        new Proxy({ key: 1 }, {
          getOwnPropertyDescriptor() {
            throw new Error("trap")
          }
        }),
        new Proxy({ key: 1 }, {
          getOwnPropertyDescriptor() {
            return undefined
          }
        })
      ]
    ) {
      expect(() => capture({ value }, () => undefined)).toThrow(
        /capture at \$\.value could not inspect its own data/
      )
    }
  })

  it("rejects a Proxy before cloning data its traps changed into an accessor", () => {
    for (const array of [false, true]) {
      let reads = 0
      const earlier = { value: 1 }
      const target = array ? [1] : { value: 1 }
      const proxy = new Proxy(target, {
        ownKeys(object) {
          Object.defineProperty(earlier, "value", { get: () => ++reads, configurable: true })
          return Reflect.ownKeys(object)
        }
      })
      expect(() => capture({ earlier, proxy }, () => undefined)).toThrow(
        /capture at \$\.proxy cannot be structured-cloned/
      )
      expect(reads).toBe(0)
    }
  })

  it("binds only the detached snapshot, preserves arguments and ignores later receivers", () => {
    const original = { config: { value: 2 } }
    const operation = capture(original, function(value: number, extra: number) {
      expect(Object.isFrozen(this)).toBe(true)
      expect(Object.isFrozen(this.config)).toBe(true)
      return this.config.value + value + extra
    })
    const identity = functionIdentity(operation)
    original.config.value = 99
    expect(operation(3, 4)).toBe(9)
    expect(operation.call({ config: { value: -1 } }, 3, 4)).toBe(9)
    expect(functionIdentity(operation)).toEqual(identity)
    const nested = capture({ outer: 9 }, operation)
    expect(nested(3, 4)).toBe(9)
    expect(functionIdentity(nested)).not.toEqual(identity)
  })

  it("selects the host clone before a Proxy trap can replace it", () => {
    const clone = globalThis.structuredClone
    onTestFinished(() => {
      globalThis.structuredClone = clone
    })
    let calls = 0
    const value = new Proxy({ value: 1 }, {
      ownKeys(target) {
        globalThis.structuredClone = (() => {
          calls++
          return {}
        }) as typeof structuredClone
        return Reflect.ownKeys(target)
      }
    })
    expect(() => capture({ value }, () => undefined)).toThrow(/capture at \$\.value cannot be structured-cloned/)
    expect(calls).toBe(0)
  })

  it("never invokes metadata accessors attached to the callback", () => {
    let reads = 0
    const operation = Object.defineProperty(() => 1, Symbol.for("@smthrs/core/Node/CapturedFunction"), {
      get: () => {
        reads++
        return undefined
      }
    })
    capture({}, operation)
    functionIdentity(operation)
    expect(reads).toBe(0)
  })

  it("gives equal identities the same canonical own-key order", () => {
    const read = function(this: Record<string, number>) {
      return Object.values(this).join(",")
    }
    const one = capture({ a: 1, b: 2 }, read)
    const two = capture({ b: 2, a: 1 }, read)
    expect(functionIdentity(one)).toEqual(functionIdentity(two))
    expect(one()).toBe("1,2")
    expect(two()).toBe(one())
  })
})
