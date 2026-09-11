import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { SyncError } from "../src/SyncError.ts"
import * as WorkspaceShare from "../src/WorkspaceShare.ts"
import { died, refusalOf } from "./refusal.ts"

const key = (kid: string, secret: string): WorkspaceShare.Key => ({ kid, secret: Redacted.make(secret) })

const keyring: WorkspaceShare.Keyring = { activeKid: "k1", keys: [key("k1", "workspace-secret")] }

const run = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.provide(TestClock.layer()))

const fromEnvironment = (environment: Record<string, string>) =>
  WorkspaceShare.layerConfig.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment)))
  )

/** The key name a configured authority mints under. */
const mintedKid = (environment: Record<string, string>) =>
  Effect.gen(function*() {
    const share = yield* WorkspaceShare.WorkspaceShare
    const minted = yield* share.mint({ capabilityId: "cap-config", access: "read", ttlMs: 60_000 })
    yield* share.verify(minted, { access: "read" })
    return minted.claims.kid
  }).pipe(Effect.provide(fromEnvironment(environment)))

describe("WorkspaceShare", () => {
  it.effect("mints a capability whose claims are keyed, timed, and verifiable", () =>
    Effect.gen(function*() {
      const [capability, claims] = yield* run(
        Effect.gen(function*() {
          const share = yield* WorkspaceShare.makeHmac(keyring)
          const minted = yield* share.mint({ capabilityId: "cap-1", access: "read", ttlMs: 60_000 })
          return [minted, yield* share.verify(minted, { access: "read" })] as const
        })
      )

      expect(capability.claims.kid).toBe("k1")
      expect(capability.claims.expiresAtMs - capability.claims.issuedAtMs).toBe(60_000)
      expect(capability.signature).toMatch(/^[0-9a-f]{64}$/)
      expect(claims.capabilityId).toBe("cap-1")
    }))

  it.effect("rejects tampered signatures and tampered claims", () =>
    Effect.gen(function*() {
      const [wrongSignature, wrongClaims] = yield* run(
        Effect.gen(function*() {
          const share = yield* WorkspaceShare.makeHmac(keyring)
          const minted = yield* share.mint({ capabilityId: "cap-1", access: "read", ttlMs: 60_000 })
          const resigned = new WorkspaceShare.WorkspaceCapability({
            claims: minted.claims,
            signature: minted.signature.slice(0, -1) + (minted.signature.endsWith("0") ? "1" : "0")
          })
          const widened = new WorkspaceShare.WorkspaceCapability({
            claims: new WorkspaceShare.WorkspaceClaims({ ...minted.claims, access: "write" }),
            signature: minted.signature
          })
          return [
            yield* Effect.flip(share.verify(resigned, { access: "read" })),
            yield* Effect.flip(share.verify(widened, { access: "write" }))
          ] as const
        })
      )

      expect(wrongSignature.code).toBe("unauthorized")
      expect(wrongSignature.message).toBe("The workspace capability signature is invalid")
      expect(wrongClaims.code).toBe("unauthorized")
    }))

  it.effect("expires a capability and keeps write claims covering read requests", () =>
    Effect.gen(function*() {
      const [expired, readWithWrite, writeWithRead] = yield* run(
        Effect.gen(function*() {
          const share = yield* WorkspaceShare.makeHmac(keyring)
          const readOnly = yield* share.mint({ capabilityId: "cap-read", access: "read", ttlMs: 1_000 })
          const writable = yield* share.mint({ capabilityId: "cap-write", access: "write", ttlMs: 60_000 })
          const covering = yield* share.verify(writable, { access: "read" })
          const refused = yield* Effect.flip(share.verify(readOnly, { access: "write" }))
          yield* TestClock.adjust(1_000)
          return [yield* Effect.flip(share.verify(readOnly, { access: "read" })), covering, refused] as const
        })
      )

      expect(expired.code).toBe("unauthorized")
      expect(expired.message).toBe("The workspace capability has expired")
      expect(readWithWrite.capabilityId).toBe("cap-write")
      expect(writeWithRead.message).toBe("The workspace capability is read-only")
    }))

  it.effect("rotates keys: a retired key still verifies while the active key signs new mints", () =>
    Effect.gen(function*() {
      const [oldClaims, freshKid, unknownKid] = yield* run(
        Effect.gen(function*() {
          const before = yield* WorkspaceShare.makeHmac(keyring)
          const minted = yield* before.mint({ capabilityId: "cap-old", access: "read", ttlMs: 60_000 })
          const rotated = yield* WorkspaceShare.makeHmac({
            activeKid: "k2",
            keys: [key("k1", "workspace-secret"), key("k2", "next-secret")]
          })
          const still = yield* rotated.verify(minted, { access: "read" })
          const fresh = yield* rotated.mint({ capabilityId: "cap-new", access: "read", ttlMs: 60_000 })
          // A keyring that dropped k1 entirely refuses the old capability.
          const dropped = yield* WorkspaceShare.makeHmac({ activeKid: "k2", keys: [key("k2", "next-secret")] })
          const refused = yield* Effect.flip(dropped.verify(minted, { access: "read" }))
          return [still, fresh.claims.kid, refused] as const
        })
      )

      expect(oldClaims.capabilityId).toBe("cap-old")
      expect(freshKid).toBe("k2")
      expect(unknownKid.code).toBe("unauthorized")
      expect(unknownKid.message).toBe("The workspace capability names an unknown signing key")
    }))

  it.effect("fails construction for a duplicate kid and for an active kid outside the ring", () =>
    Effect.gen(function*() {
      const [duplicate, missing] = yield* run(
        Effect.gen(function*() {
          return [
            yield* Effect.flip(
              WorkspaceShare.makeHmac({ activeKid: "k1", keys: [key("k1", "a"), key("k1", "b")] })
            ),
            yield* Effect.flip(WorkspaceShare.makeHmac({ activeKid: "k9", keys: [key("k1", "a")] }))
          ] as const
        })
      )

      expect(duplicate.code).toBe("invalid_request")
      expect(duplicate.message).toBe("The workspace keyring names kid k1 twice")
      expect(missing.code).toBe("invalid_request")
      expect(missing.message).toBe("The workspace keyring's active kid names no key in the ring")
    }))

  it.effect("keeps the noop authority refusing on mint as well as verify, and overridable", () =>
    Effect.gen(function*() {
      const noop = WorkspaceShare.makeNoop()
      const mintExit = yield* Effect.exit(noop.mint({ capabilityId: "cap", access: "read", ttlMs: 1 }))
      const refused = yield* Effect.flip(
        Effect.flatMap(WorkspaceShare.WorkspaceShare, (share) =>
          share.verify(
            new WorkspaceShare.WorkspaceCapability({
              claims: new WorkspaceShare.WorkspaceClaims({
                kid: "k1",
                capabilityId: "cap",
                access: "read",
                issuedAtMs: 0,
                expiresAtMs: 1
              }),
              signature: ""
            }),
            { access: "read" }
          )).pipe(Effect.provide(WorkspaceShare.layerNoop))
      )
      const overridden = WorkspaceShare.makeNoop({
        verify: () => Effect.fail(new SyncError({ code: "unauthorized", message: "overridden" }))
      })
      const overriddenFailure = yield* Effect.flip(
        overridden.verify(
          new WorkspaceShare.WorkspaceCapability({
            claims: new WorkspaceShare.WorkspaceClaims({
              kid: "k1",
              capabilityId: "cap",
              access: "read",
              issuedAtMs: 0,
              expiresAtMs: 1
            }),
            signature: ""
          }),
          { access: "read" }
        )
      )

      // The CATEGORY, not just that it failed: `mint` used to `Effect.die`
      // where its declared type promises a `SyncError`, and a Die satisfies
      // `Exit.isFailure` exactly as a Fail does.
      const mintRefusal = refusalOf(mintExit)
      expect(died(mintExit)).toBe(false)
      expect(SyncError.is(mintRefusal)).toBe(true)
      expect(mintRefusal?.code).toBe("unauthorized")
      expect(mintRefusal?.message).toBe("Workspace sharing is unavailable")
      expect(refused.message).toBe("Workspace sharing is unavailable")
      expect(overriddenFailure.message).toBe("overridden")
    }))

  it.effect("layerHmac provides a working authority", () =>
    Effect.gen(function*() {
      const claims = yield* run(
        Effect.gen(function*() {
          const share = yield* WorkspaceShare.WorkspaceShare
          const minted = yield* share.mint({ capabilityId: "cap-layer", access: "read", ttlMs: 60_000 })
          return yield* share.verify(minted, { access: "read" })
        }).pipe(Effect.provide(WorkspaceShare.layerHmac(keyring)))
      )

      expect(claims.capabilityId).toBe("cap-layer")
    }))

  it.effect("layerConfig reads the redacted secret and key id from configuration", () =>
    Effect.gen(function*() {
      const [defaultKid, namedKid] = yield* run(
        Effect.gen(function*() {
          const first = yield* mintedKid({ SMITHERS_SYNC_SECRET: "configured-secret" })
          const second = yield* mintedKid({
            SMITHERS_SYNC_SECRET: "configured-secret",
            SMITHERS_SYNC_KEY_ID: "2026-08"
          })
          return [first, second] as const
        })
      )

      expect(defaultKid).toBe("primary")
      expect(namedKid).toBe("2026-08")
    }))

  it.effect("layerConfig fails closed when no secret is configured", () =>
    Effect.gen(function*() {
      const exit = yield* run(
        Effect.exit(
          Effect.provide(
            Effect.service(WorkspaceShare.WorkspaceShare),
            WorkspaceShare.layerConfig.pipe(
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))
            )
          )
        )
      )

      // A missing secret is a typed configuration refusal, not a defect: the
      // layer must be composable in a host that reports the misconfiguration
      // rather than crashing on it.
      expect(died(exit)).toBe(false)
      expect(refusalOf(exit)).toBeDefined()
    }))
})
