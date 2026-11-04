// Deep reviewed and polished by a human on 2026-08-31.

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Crypto } from "@smthrs/crypto"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, PlatformError, Schema, SchemaIssue } from "effect"
import { inspect } from "node:util"
import { describe, expect, it } from "vitest"
import * as Keys from "../src/index.ts"

const provideCrypto = <A, E>(
  effect: Effect.Effect<A, E, Crypto.Crypto>
): Effect.Effect<A, E> => Effect.provide(effect, Crypto.layerFromDigest(NodeCrypto.layerDigest))

const derive = (input: unknown): Keys.KeyV1 => Effect.runSync(provideCrypto(Keys.deriveKey(input)))

const decodeDerivedKey = (input: unknown): Keys.StoredKey =>
  Effect.runSync(provideCrypto(Schema.decodeUnknownEffect(Keys.DerivedKey)(input)))

const derivations: ReadonlyArray<
  readonly [string, (input: unknown) => Effect.Effect<Keys.KeyV1, unknown, Crypto.Crypto>]
> = [
  ["deriveKey", Keys.deriveKey],
  ["DerivedKey", Schema.decodeUnknownEffect(Keys.DerivedKey)]
]

const failingCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: () =>
      Effect.fail(PlatformError.systemError({
        _tag: "Unknown",
        module: "test-host",
        method: "digest"
      }))
  })
)

// Include issues in annotations/causes and inspect input fields, not just messages.
const collectIssues = (root: unknown): Array<SchemaIssue.Issue> => {
  const issues: Array<SchemaIssue.Issue> = []
  const seen = new Set<object>()
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return
    seen.add(value)
    if (SchemaIssue.isIssue(value)) issues.push(value)
    for (const child of Object.values(value)) visit(child)
  }
  visit(root)
  return issues
}

describe("stored key validation", () => {
  const stored = `key1_${"a".repeat(64)}`

  it("parses a supported stored key unchanged without Crypto", () => {
    expect(Schema.decodeUnknownSync(Keys.StoredKey)(stored)).toBe(stored)
    expect(Schema.decodeUnknownSync(Keys.KeyV1)(stored)).toBe(stored)
    expect(Keys.digest(Schema.decodeUnknownSync(Keys.StoredKey)(stored))).toBe("a".repeat(64))
  })

  it.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])(
    "rejects a stored key followed by line terminator %j",
    (terminator) => {
      for (const schema of [Keys.StoredKey, Keys.KeyV1]) {
        expect(() => Schema.decodeUnknownSync(schema)(stored + terminator)).toThrow()
        expect(() => Schema.encodeUnknownSync(schema)(stored + terminator)).toThrow()
      }
    }
  )

  it("keeps parsing separate from deriving a key from key-shaped text", () => {
    const parsed = Schema.decodeUnknownSync(Keys.StoredKey)(stored)
    expect(parsed).toBe(stored)
    expect(derive(stored)).not.toBe(parsed)
    expect(decodeDerivedKey(stored)).toBe(derive(stored))
  })

  it("rejects unsupported versions and malformed wire values", () => {
    for (
      const value of [
        `key2_${"a".repeat(64)}`,
        `key0_${"a".repeat(64)}`,
        `key01_${"a".repeat(64)}`,
        `key1_${"A".repeat(64)}`,
        `key1_${"a".repeat(63)}`,
        `key1_${"a".repeat(65)}`,
        "key1_invalid",
        "",
        null,
        1,
        {}
      ]
    ) {
      expect(() => Schema.decodeUnknownSync(Keys.StoredKey)(value)).toThrow()
    }
  })
})

describe("key derivation", () => {
  it.each([
    [null, "key1_74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"],
    [{ b: 2, a: 1 }, "key1_43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"],
    [{ text: "λ" }, "key1_195d9a15927fe2bd86e32921e890c4a06362e93114b6aba2188499350682611f"],
    ["", "key1_12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126"]
  ])("matches the frozen key1 wire vector for %#", (input, expected) => {
    expect(derive(input)).toBe(expected)
    expect(decodeDerivedKey(input)).toBe(expected)
  })

  it("derives the same key from canonically equivalent JSON", () => {
    expect(derive({ b: 2, a: 1 })).toBe(derive({ a: 1, b: 2 }))
  })

  it("keeps known distinct canonical values distinct", () => {
    expect(derive({ value: 1 })).not.toBe(derive({ value: "1" }))
    expect(derive([1, 2])).not.toBe(derive([2, 1]))
  })

  it("returns a typed canonicalization failure with its cause", () => {
    const error = Effect.runSync(Effect.flip(provideCrypto(
      Keys.deriveKey({ value: 1n })
    )))
    expect(error).toBeInstanceOf(Keys.KeyDerivationError)
    expect(error).toMatchObject({
      _tag: "@smthrs/keys/KeyDerivationError",
      code: "canonicalization_failed",
      message: "Key input could not be canonicalized",
      cause: expect.objectContaining({ _tag: "SchemaError" })
    })
  })

  it("keeps the diagnostic cause out of every serialized form", () => {
    const material = {
      get credentials(): string {
        throw new Error("password=hunter2")
      }
    }
    const error = Effect.runSync(Effect.flip(provideCrypto(Keys.deriveKey(material))))
    expect(String(error.cause)).toContain("password=hunter2")
    const encoded = Schema.encodeUnknownSync(Keys.KeyDerivationError)(error)
    const json = Schema.encodeUnknownSync(Schema.toCodecJson(Keys.KeyDerivationError))(error)
    for (const form of [encoded, json, error]) {
      expect(JSON.stringify(form)).not.toContain("hunter2")
    }
    expect(json).toEqual({
      _tag: "@smthrs/keys/KeyDerivationError",
      code: "canonicalization_failed",
      message: "Key input could not be canonicalized"
    })
  })

  it("returns a typed digest failure with the crypto cause chain", () => {
    const error = Effect.runSync(Effect.flip(
      Effect.provide(Keys.deriveKey({ operation: "compile" }), failingCrypto)
    ))
    expect(error).toBeInstanceOf(Keys.KeyDerivationError)
    expect(error).toMatchObject({
      code: "digest_failed",
      message: "Canonical key material could not be hashed",
      cause: expect.objectContaining({
        _tag: "@smthrs/crypto/Sha256Error",
        code: "digest_failed"
      })
    })
  })

  it("redacts key material from schema failures", () => {
    const secret = "key-material-that-must-not-appear"
    const error = Effect.runSync(Effect.flip(
      Schema.decodeUnknownEffect(Keys.DerivedKey)({ secret }).pipe(
        Effect.provide(failingCrypto)
      )
    ))
    expect(error.message).toContain("[digest_failed] Canonical key material could not be hashed")
    expect(error.message).not.toContain(secret)
    expect(error.issue).not.toHaveProperty("actual")
    expect(error.issue).toMatchObject({
      issue: {
        annotations: {
          code: "digest_failed",
          cause: expect.objectContaining({
            _tag: "@smthrs/keys/KeyDerivationError"
          })
        }
      }
    })
  })

  it("redacts non-canonical key material even when input reporting is requested", () => {
    const secret = "canonical-secret-that-must-not-appear"
    const error = Effect.runSync(Effect.flip(
      provideCrypto(
        Schema.decodeUnknownEffect(Keys.DerivedKey)({ [secret]: 1n }, { reportInput: true })
      )
    ))
    expect(error.message).toContain("[canonicalization_failed] Key input could not be canonicalized")
    expect(error.message).not.toContain(secret)
    expect(error.issue).not.toHaveProperty("actual")
    expect(error.issue).toMatchObject({
      issue: {
        annotations: {
          code: "canonicalization_failed",
          cause: expect.objectContaining({
            _tag: "@smthrs/keys/KeyDerivationError",
            cause: expect.objectContaining({ _tag: "SchemaError" })
          })
        }
      }
    })
  })

  describe.each(["digest_failed", "canonicalization_failed"] as const)("%s input reporting", (code) => {
    const secret = "enclosing-key-material-sentinel"
    const material = code === "digest_failed" ? { secret } : { secret, bad: 1n }

    it("omits input throughout a direct DerivedKey failure despite reportInput: true", () => {
      const error = Effect.runSync(Effect.flip(
        Schema.decodeUnknownEffect(Keys.DerivedKey)(material, { reportInput: true }).pipe(
          Effect.provide(failingCrypto)
        )
      ))
      const issues = collectIssues(error.issue)
      expect(issues.map((issue) => issue._tag)).toEqual(expect.arrayContaining(["Encoding", "InvalidValue"]))
      expect(issues.filter(SchemaIssue.hasInput)).toEqual([])
      expect(error.message).toContain(`[${code}]`)
      expect(inspect(error.issue, { depth: null })).not.toContain(secret)
    })

    it.each(
      [
        ["Struct", Schema.Struct({ id: Schema.String, key: Keys.DerivedKey }), { id: "r1", key: material }],
        ["Array", Schema.Array(Keys.DerivedKey), [material]]
      ] as const
    )("retains only the enclosing %s input when its boundary enables reporting", (_name, schema, input) => {
      for (const mode of ["enabled", "disabled", "default"] as const) {
        const options = mode === "default" ? undefined : { reportInput: mode !== "disabled" }
        const error = Effect.runSync(Effect.flip(
          Schema.decodeUnknownEffect(schema)(input, options).pipe(Effect.provide(failingCrypto))
        ))
        expect(error.issue._tag).toBe("Composite")
        const issues = collectIssues(error.issue)
        expect(issues.map((issue) => issue._tag)).toEqual(
          expect.arrayContaining(["Pointer", "Encoding", "InvalidValue"])
        )
        expect(issues.filter(SchemaIssue.hasInput)).toEqual(mode === "enabled" ? [error.issue] : [])
        if (mode === "enabled") {
          expect(error.issue.input).toBe(input)
          expect(inspect(error.issue, { depth: null })).toContain(secret)
        } else {
          expect(inspect(error.issue, { depth: null })).not.toContain(secret)
        }
        const derivedIssue = issues.find((issue) => issue._tag === "Encoding")!
        expect(inspect(derivedIssue, { depth: null })).not.toContain(secret)
        expect(error.message).toContain(`[${code}]`)
        expect(error.message).not.toContain(secret)
      }
    })
  })

  it("does not invoke Crypto for input that cannot be canonicalized", () => {
    let calls = 0
    // An instrumented host proves ordering without invoking any external service.
    const host = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: () => {
        calls++
        return Effect.succeed(new Uint8Array(32))
      }
    })
    const error = Effect.runSync(Effect.flip(
      Keys.deriveKey(1n).pipe(Effect.provideService(Crypto.Crypto, host))
    ))
    expect(error.code).toBe("canonicalization_failed")
    expect(calls).toBe(0)
  })

  it.each(derivations)("%s normalizes throwing and defective hosts and recovers on retry", (_name, decode) => {
    for (const mode of ["throw", "defect"] as const) {
      let calls = 0
      const failure = new Error("host diagnostic")
      // Deliberately broken hosts exercise failures a real platform should never produce.
      const host = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () => {
          calls++
          if (calls === 1) {
            if (mode === "throw") throw failure
            return Effect.die(failure)
          }
          return Effect.succeed(new Uint8Array(32))
        }
      })
      const operation = decode({ domain: "test/host-recovery", version: 1 }).pipe(
        Effect.provideService(Crypto.Crypto, host)
      )
      const error = Effect.runSync(Effect.flip(operation))
      expect(error).toMatchObject(
        _name === "deriveKey"
          ? { code: "digest_failed", cause: { code: "digest_failed", cause: failure } }
          : { _tag: "SchemaError", message: expect.stringContaining("[digest_failed]") }
      )
      expect(Effect.runSync(operation)).toBe(`key1_${"0".repeat(64)}`)
      expect(calls).toBe(2)
    }
  })

  it.each([0, 31, 33, 64])("rejects a host digest of %i bytes and allows a subsequent valid derivation", (size) => {
    // Malformed host output cannot be produced by a conforming platform service.
    const host = Crypto.make({
      randomBytes: (length) => new Uint8Array(length),
      digest: () => Effect.succeed(new Uint8Array(size))
    })
    const error = Effect.runSync(Effect.flip(
      Keys.deriveKey({ domain: "test/host-output", version: 1 }).pipe(
        Effect.provideService(Crypto.Crypto, host)
      )
    ))
    expect(error).toBeInstanceOf(Keys.KeyDerivationError)
    expect(error.code).toBe("digest_failed")
    expect(error.cause).toMatchObject({ code: "invalid_digest" })
    const recovered = derive({ domain: "test/host-output", version: 1 })
    expect(Schema.decodeUnknownSync(Keys.StoredKey)(recovered)).toBe(recovered)
  })

  it.each(derivations)(
    "%s interrupts a pending digest, runs host cleanup, and permits recovery",
    async (_name, decode) => {
      let cleaned = false
      const exit = await Effect.runPromise(Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        // A suspended host gives deterministic cancellation with no wall-clock sleeps.
        const host = Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.sync(() => {
                cleaned = true
              }))
            )
        })
        const fiber = yield* Effect.forkChild(
          decode({ domain: "test/cancellation", version: 1 }).pipe(
            Effect.provideService(Crypto.Crypto, host)
          )
        )
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(Cause.hasFails(exit.cause)).toBe(false)
      }
      expect(cleaned).toBe(true)
      const recovered = derive({ domain: "test/cancellation", version: 1 })
      expect(Schema.decodeUnknownSync(Keys.StoredKey)(recovered)).toBe(recovered)
    }
  )

  it.each(derivations)("%s reads mutable input only when run and rereads it on each execution", (_name, decode) => {
    let reads = 0
    let value = 1
    const input = {
      get value(): number {
        reads++
        return value
      }
    }
    const pending = provideCrypto(decode(input))
    expect(reads).toBe(0)
    value = 2
    expect(Effect.runSync(pending)).toBe(derive({ value: 2 }))
    expect(reads).toBe(1)
    value = 3
    expect(Effect.runSync(pending)).toBe(derive({ value: 3 }))
    expect(reads).toBe(2)
  })

  it("reports a missing Crypto service as an Effect configuration defect", () => {
    const exit = Effect.runSyncExit(Keys.deriveKey({ operation: "compile" }) as Effect.Effect<never, never>)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("Service not found: effect/Crypto")
    }
  })

  it("cannot reconstruct its input", () => {
    const key = derive({ operation: "compile" })
    const typed = Effect.runSync(Effect.flip(Schema.encodeEffect(Keys.DerivedKey)(key)))
    expect(typed._tag).toBe("SchemaError")
    expect(typed.message).toContain("A key cannot be converted back into its input")

    const raw = Effect.runSync(
      Effect.flip(Schema.encodeUnknownEffect(Keys.DerivedKey)(`key1_${"a".repeat(64)}`))
    )
    expect(raw._tag).toBe("SchemaError")
  })

  it.each(derivations)(
    "%s isolates concurrent successes and failures while preserving input order",
    async (_name, decode) => {
      const inputs = Array.from(
        { length: 32 },
        (_, index) => index % 5 === 0 ? { invalid: BigInt(index) } : { domain: "test/concurrent", version: 1, index }
      )
      const exits = await Effect.runPromise(provideCrypto(
        Effect.all(
          inputs.map((input) => Effect.exit(decode(input))),
          { concurrency: 2 }
        )
      ))
      expect(exits).toHaveLength(inputs.length)
      for (const [index, exit] of exits.entries()) {
        if (index % 5 === 0) {
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.hasFails(exit.cause)).toBe(true)
            expect(Cause.hasDies(exit.cause)).toBe(false)
            expect(Cause.hasInterrupts(exit.cause)).toBe(false)
            expect(Cause.pretty(exit.cause)).toContain("Key input could not be canonicalized")
          }
        } else {
          expect(exit).toEqual(Exit.succeed(derive(inputs[index])))
        }
      }
      const successes = exits.filter(Exit.isSuccess).map((exit) => exit.value)
      expect(new Set(successes).size).toBe(successes.length)
    }
  )

  it("always emits the fixed key1 width", () => {
    for (const input of [null, "", false, 0, [], {}, { nested: [1, 2, 3] }]) {
      const key = derive(input)
      expect(key).toMatch(/^key1_[0-9a-f]{64}$/)
      expect(key).toHaveLength(69)
    }
  })

  describe("canonical erasure inherited from Canonical", () => {
    it("collapses negative zero into zero", () => {
      expect(derive(-0)).toBe(derive(0))
    })

    it("collapses an undefined-valued member into an absent member", () => {
      expect(derive({ a: 1, b: undefined })).toBe(derive({ a: 1 }))
    })

    it("collapses an undefined array element into null", () => {
      expect(derive([undefined])).toBe(derive([null]))
    })

    it("omits function- and symbol-valued members, as JSON does", () => {
      expect(derive({ a: 1, f: () => 1 })).toBe(derive({ a: 1 }))
      expect(derive({ a: 1, s: Symbol("s") })).toBe(derive({ a: 1 }))
    })
  })

  describe("structural separation", () => {
    it.each([
      ["a split moved between array elements", ["a", "bc"], ["ab", "c"]],
      ["quotes and commas spelled inside one element", ["a\",\"b"], ["a", "b"]],
      ["a character moved from an object value into its key", { a: "b" }, { ab: "" }],
      ["nesting flattened into a dotted key", { a: { b: 1 } }, { "a.b": 1 }]
    ])("keeps %s distinct", (_name, left, right) => {
      expect(derive(left)).not.toBe(derive(right))
    })

    it("keeps degenerate canonical documents pairwise distinct", () => {
      const keys = [derive(""), derive({}), derive([]), derive(null), derive(0), derive(false)]
      expect(new Set(keys).size).toBe(keys.length)
    })
  })
})
