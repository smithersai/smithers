import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { TestClock } from "effect/testing"
import type { BranchId } from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as WorkspaceShare from "../src/WorkspaceShare.ts"

const keyring = {
  activeKid: "primary",
  keys: [{ kid: "primary", secret: Redacted.make("expiry-boundary-secret-0123456789abcdef") }]
}
const branchId = "expiry-boundary" as BranchId
const maximum = Number.MAX_SAFE_INTEGER
const boundaries = [
  [100, 1_100],
  [maximum - 1_001, maximum - 1],
  [maximum - 1_000, maximum],
  [maximum - 999, maximum],
  [maximum, maximum]
] as const

describe("share expiry arithmetic", () => {
  for (const [ttlMs, expiresAtMs] of boundaries) {
    it.effect(`mints and verifies a workspace capability with TTL ${ttlMs}`, () =>
      Effect.gen(function*() {
        yield* TestClock.adjust(1_000)
        const authority = yield* WorkspaceShare.makeHmac(keyring)
        const capability = yield* authority.mint({ capabilityId: "workspace", access: "read", ttlMs })
        expect(capability.claims.issuedAtMs).toBe(1_000)
        expect(capability.claims.expiresAtMs).toBe(expiresAtMs)
        expect(yield* authority.verify(capability, { access: "read" })).toEqual(capability.claims)
      }).pipe(Effect.provide(TestClock.layer())))

    for (const ceiling of [undefined, 2_000, maximum]) {
      it.effect(`mints and verifies a branch capability with TTL ${ttlMs} and ceiling ${ceiling}`, () =>
        Effect.gen(function*() {
          yield* TestClock.adjust(1_000)
          const authority = yield* BranchShare.makeHmac(keyring)
          const capability = yield* authority.mint({
            branchId,
            capabilityId: "branch",
            access: "write",
            ttlMs,
            ...(ceiling === undefined ? {} : { maxExpiresAtMs: ceiling })
          })
          expect(capability.claims.issuedAtMs).toBe(1_000)
          expect(capability.claims.expiresAtMs).toBe(ceiling === 2_000 && expiresAtMs > 2_000 ? 2_000 : expiresAtMs)
          expect(yield* authority.verify(capability, { branchId, access: "write" })).toEqual(capability.claims)
        }).pipe(Effect.provide(TestClock.layer())))
    }
  }
})
