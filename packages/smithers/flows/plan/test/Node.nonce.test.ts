/**
 * The node authoring API uses the real identity implementation and its lazy,
 * realm-shared nonce. Observe that state without replacing global crypto.
 */
import * as Identity from "@smthrs/crypto/Identity"
import { describe, expect, it } from "vitest"

describe("Node ephemeral nonce", () => {
  it("imports without entropy, captures without entropy, and memoizes the real nonce", async () => {
    const internal = await import("../src/internal/node.ts")
    const shared = Reflect.get(globalThis, Symbol.for("@smthrs/crypto/Identity/state/v5")) as {
      nonce: string | undefined
      ordinal: number
    }
    expect(shared.nonce).toBeUndefined()
    expect(shared.ordinal).toBe(0)
    expect(internal.functionIdentity).toBe(Identity.functionIdentity)

    const captured = internal.capture({ step: 1 }, (value: number) => value + 1)
    expect(internal.functionIdentity(captured).algorithm).toBe("sha256-source-captures/v5")
    expect(shared.nonce).toBeUndefined()

    const first = internal.functionIdentity((value: number) => value + 1)
    expect(first.algorithm).toBe("sha256-source-ephemeral/v4")
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
    const nonce = shared.nonce
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)

    const second = internal.functionIdentity((value: number) => value * 2)
    expect(second.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(second.digest).not.toBe(first.digest)
    expect(internal.functionIdentity(captured)).toEqual(Identity.functionIdentity(captured))
    expect(shared.nonce).toBe(nonce)
    expect(shared.ordinal).toBe(2)
  })
})
