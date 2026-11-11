/**
 * The ephemeral-identity nonce must not be seeded while the module evaluates.
 *
 * Cloudflare Workers rejects an upload whose script calls
 * `crypto.getRandomValues` at global scope with error 10021, "Disallowed
 * operation called within global scope", so any bundle containing this module
 * would fail to deploy.
 *
 * The nonce is the module's only entropy read, and it lives in the realm-shared
 * state a compatible copy adopts. Each test hands a fresh module that state and
 * reads the nonce slot, so no global is patched.
 */
import { afterEach, describe, expect, it, vi } from "vitest"

const stateKey = Symbol.for("@smthrs/crypto/Identity/state/v5")

interface SharedState {
  readonly captured: WeakMap<object, never>
  readonly ephemeral: WeakMap<object, never>
  ordinal: number
  nonce: string | undefined
}

/** Evaluates a fresh copy of the module that adopts `shared` as its realm state. */
const importWith = async (shared: SharedState) => {
  vi.resetModules()
  vi.stubGlobal(stateKey, shared)
  return import("../src/Identity.ts")
}

const unseeded = (): SharedState => ({
  captured: new WeakMap(),
  ephemeral: new WeakMap(),
  ordinal: 0,
  nonce: undefined
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("ephemeral identity nonce", () => {
  it("evaluates the module without seeding the nonce", async () => {
    const shared = unseeded()

    await expect(importWith(shared)).resolves.toBeDefined()
    expect(shared.nonce).toBeUndefined()
  })

  it("seeds the nonce on the first unannotated identity and memoizes it", async () => {
    const shared = unseeded()
    const identity = await importWith(shared)

    const first = identity.functionIdentity((value: number) => value + 1)
    expect(first.algorithm).toBe("sha256-source-ephemeral/v4")
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
    const seeded = shared.nonce
    expect(seeded).toMatch(/^[0-9a-f]{32}$/)

    // A second identity folds in the same nonce with a new ordinal.
    const second = identity.functionIdentity((value: number) => value * 2)
    expect(second.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(second.digest).not.toBe(first.digest)
    expect(shared.nonce).toBe(seeded)
    expect(shared.ordinal).toBe(2)
  })

  it("shares one seeded nonce with every other ephemeral encoding", async () => {
    const shared = unseeded()
    const identity = await importWith(shared)

    const first = identity.processNonce()
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(shared.nonce).toBe(first)

    // A second reader folds in the same per-process value, so two encodings
    // cannot disagree about which process they were minted in.
    expect(identity.processNonce()).toBe(first)
    identity.functionIdentity((value: number) => value + 1)
    expect(shared.nonce).toBe(first)
  })

  it("digests a captured function without seeding the nonce", async () => {
    const shared = unseeded()
    const identity = await importWith(shared)

    const captured = identity.capture({ step: 1 }, (value: number) => value + 1)
    expect(identity.functionIdentity(captured).algorithm).toBe("sha256-source-captures/v5")
    expect(shared.nonce).toBeUndefined()
  })
})
