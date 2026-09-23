/**
 * AES-256-GCM credential encryption over the Web Crypto API.
 *
 * These run on Node without a shim, which is the point: the same adapter is
 * what a browser host uses.
 */
import { Cause, Effect, Exit, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import * as CredentialCipher from "../src/CredentialCipher.ts"
import * as WebCryptoCipher from "../src/WebCryptoCipher.ts"

const key = Redacted.make(btoa("0123456789abcdef0123456789abcdef"))
const other = Redacted.make(btoa("fedcba9876543210fedcba9876543210"))
const context = { id: "credential-a", name: "Credential A", version: 1 }

/** The typed error an effect failed with, asserted field by field. */
const failureOf = async <A, E>(effect: Effect.Effect<A, E>): Promise<Record<string, unknown>> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a typed failure")
  return Cause.squash(exit.cause) as Record<string, unknown>
}

const expectUnavailable = (error: Record<string, unknown>): void => {
  expect(error._tag).toBe("/control/Unavailable")
  expect(error.feature).toBe("credential encryption")
  expect(error.ticket).toBe("control-credential-storage")
}

/** An open that failed authentication: the key, the metadata, or the bytes changed. */
const expectAuthenticationFailure = (error: Record<string, unknown>): void => {
  expect(error._tag).toBe("/control/PersistenceError")
  expect(error.operation).toBe("credential.open")
  expect(error.message).toContain("failed authentication")
}

const expectInvalidKey = (error: Record<string, unknown>): void => {
  expect(error._tag).toBe("/control/InvalidInput")
  expect(error.issue).toContain("32 base64-encoded bytes")
}

describe("WebCryptoCipher", () => {
  it("round-trips a secret without ever holding it in the clear", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const cipher = yield* WebCryptoCipher.make({ key })
        const sealed = yield* cipher.seal(Redacted.make("sk-live-42"), context)
        const opened = yield* cipher.open(sealed, context)
        return { sealed, opened: Redacted.value(opened) }
      }).pipe(Effect.orDie)
    )

    expect(result.opened).toBe("sk-live-42")
    expect(atob(result.sealed.ciphertext)).not.toContain("sk-live-42")
  })

  it("uses a fresh nonce for every seal", async () => {
    const nonces = await Effect.runPromise(
      Effect.gen(function*() {
        const cipher = yield* WebCryptoCipher.make({ key })
        const first = yield* cipher.seal(Redacted.make("same"), context)
        const second = yield* cipher.seal(Redacted.make("same"), context)
        return [first, second]
      }).pipe(Effect.orDie)
    )

    expect(nonces[0]!.nonce).not.toBe(nonces[1]!.nonce)
    expect(nonces[0]!.ciphertext).not.toBe(nonces[1]!.ciphertext)
  })

  it("refuses ciphertext sealed under a different host key", async () => {
    expectAuthenticationFailure(
      await failureOf(Effect.gen(function*() {
        const mine = yield* WebCryptoCipher.make({ key })
        const theirs = yield* WebCryptoCipher.make({ key: other })
        return yield* theirs.open(yield* mine.seal(Redacted.make("sk-live-42"), context), context)
      }))
    )
  })

  it("refuses a blob opened under another credential id", async () => {
    expectAuthenticationFailure(
      await failureOf(Effect.gen(function*() {
        const cipher = yield* WebCryptoCipher.make({ key })
        const sealed = yield* cipher.seal(Redacted.make("secret-a"), context)
        return yield* cipher.open(sealed, { ...context, id: "credential-b" })
      }))
    )
  })

  it("refuses a blob opened under a renamed credential", async () => {
    expectAuthenticationFailure(
      await failureOf(Effect.gen(function*() {
        const cipher = yield* WebCryptoCipher.make({ key })
        const sealed = yield* cipher.seal(Redacted.make("secret-a"), context)
        return yield* cipher.open(sealed, { ...context, name: "Renamed credential" })
      }))
    )
  })

  it("refuses a blob opened under another credential version", async () => {
    expectAuthenticationFailure(
      await failureOf(Effect.gen(function*() {
        const cipher = yield* WebCryptoCipher.make({ key })
        const sealed = yield* cipher.seal(Redacted.make("secret-a"), context)
        return yield* cipher.open(sealed, { ...context, version: 2 })
      }))
    )
  })

  it("keeps delimiter-bearing contexts unambiguous", async () => {
    expectAuthenticationFailure(
      await failureOf(Effect.gen(function*() {
        const cipher = yield* WebCryptoCipher.make({ key })
        const sealed = yield* cipher.seal(
          Redacted.make("secret-a"),
          { id: "a|b", name: "c", version: 1 }
        )
        return yield* cipher.open(sealed, { id: "a", name: "b|c", version: 1 })
      }))
    )
  })

  it("refuses tampered ciphertext", async () => {
    expectAuthenticationFailure(
      await failureOf(Effect.gen(function*() {
        const cipher = yield* WebCryptoCipher.make({ key })
        const sealed = yield* cipher.seal(Redacted.make("sk-live-42"), context)
        return yield* cipher.open({ ...sealed, ciphertext: btoa("tampered payload bytes") }, context)
      }))
    )
  })

  it("refuses a key that is not 32 bytes as invalid input", async () => {
    expectInvalidKey(await failureOf(WebCryptoCipher.make({ key: Redacted.make(btoa("short")) })))
  })

  it("refuses a key that is not base64 as invalid input", async () => {
    expectInvalidKey(await failureOf(WebCryptoCipher.make({ key: Redacted.make("not base64!!!") })))
  })

  it("refuses a stored nonce that is not base64 as a malformed record", async () => {
    const error = await failureOf(Effect.gen(function*() {
      const cipher = yield* WebCryptoCipher.make({ key })
      const sealed = yield* cipher.seal(Redacted.make("sk-live-42"), context)
      return yield* cipher.open({ ...sealed, nonce: "not base64!!!" }, context)
    }))
    expect(error._tag).toBe("/control/PersistenceError")
    expect(error.operation).toBe("credential.open")
    expect(error.message).toContain("malformed")
  })

  it("reports unavailable key material on a host without Web Crypto", async () => {
    const present = globalThis.crypto
    try {
      Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true })
      expectUnavailable(await failureOf(WebCryptoCipher.make({ key })))
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: present, configurable: true })
    }
  })

  it("reports unavailable key material on a host without a secure random source", async () => {
    const present = globalThis.crypto
    try {
      const cipher = await Effect.runPromise(WebCryptoCipher.make({ key }).pipe(Effect.orDie))
      Object.defineProperty(globalThis, "crypto", {
        value: { subtle: present.subtle },
        configurable: true
      })
      expectUnavailable(await failureOf(cipher.seal(Redacted.make("x"), context)))
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: present, configurable: true })
    }
  })

  it("provides the cipher as a layer", async () => {
    const opened = await Effect.runPromise(
      Effect.gen(function*() {
        const cipher = yield* CredentialCipher.CredentialCipher
        const sealed = yield* cipher.seal(Redacted.make("layered"), context)
        return Redacted.value(yield* cipher.open(sealed, context))
      }).pipe(Effect.provide(WebCryptoCipher.layer({ key })), Effect.orDie)
    )

    expect(opened).toBe("layered")
  })
})
