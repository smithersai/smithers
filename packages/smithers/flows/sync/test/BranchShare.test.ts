import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Redacted, Tracer } from "effect"
import { TestClock } from "effect/testing"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as ShareSigner from "../src/internal/ShareSigner.ts"
import { SyncError } from "../src/SyncError.ts"
import * as WorkspaceShare from "../src/WorkspaceShare.ts"
import { died, refusalOf } from "./refusal.ts"

const branchId = "live-branch" as BranchProtocol.BranchId
const otherBranchId = "other-branch" as BranchProtocol.BranchId

const authority = BranchShare.makeHmac({
  activeKid: "primary",
  keys: [{ kid: "primary", secret: Redacted.make("share-secret-0123456789abcdefghi") }]
})

const run = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.provide(TestClock.layer()))

const mintWrite = Effect.flatMap(
  authority,
  (share) => share.mint({ branchId, capabilityId: "cap-1", access: "write", ttlMs: 60_000 })
)

describe("BranchShare", () => {
  it.effect("refuses a signing secret shorter than 32 bytes and accepts one of exactly 32", () =>
    Effect.gen(function*() {
      const crypto = yield* ShareSigner.Crypto
      const refusedImport = {
        ...crypto,
        importKey: () => Effect.fail(new Error("import must not run for an invalid secret"))
      }
      const [empty, short, workspaceShort, exactClaims] = yield* run(
        Effect.gen(function*() {
          const empty = yield* Effect.exit(
            BranchShare.makeHmac({ activeKid: "primary", keys: [{ kid: "primary", secret: Redacted.make("") }] })
              .pipe(Effect.provideService(ShareSigner.Crypto, refusedImport))
          )
          // One observed capability is an offline oracle for its secret, so a
          // one-byte secret let anyone brute-force the key and forge links.
          const short = yield* Effect.exit(
            BranchShare.makeHmac({ activeKid: "primary", keys: [{ kid: "primary", secret: Redacted.make("a") }] })
              .pipe(Effect.provideService(ShareSigner.Crypto, refusedImport))
          )
          const workspaceShort = yield* Effect.exit(
            WorkspaceShare.makeHmac({
              activeKid: "primary",
              keys: [{ kid: "primary", secret: Redacted.make("a".repeat(31)) }]
            }).pipe(Effect.provideService(ShareSigner.Crypto, refusedImport))
          )
          const exact = yield* BranchShare.makeHmac({
            activeKid: "primary",
            keys: [{ kid: "primary", secret: Redacted.make("b".repeat(32)) }]
          })
          const capability = yield* exact.mint({ branchId, capabilityId: "exact-key", access: "read", ttlMs: 1_000 })
          return [empty, short, workspaceShort, yield* exact.verify(capability, { branchId, access: "read" })] as const
        })
      )
      const refusals = [refusalOf(empty), refusalOf(short), refusalOf(workspaceShort)]
      expect([died(empty), died(short), died(workspaceShort)]).toEqual([false, false, false])
      for (const refusal of refusals) {
        expect(refusal?.code).toBe("invalid_request")
        expect(refusal?.message).toBe("The HMAC signing secret must be at least 32 bytes of UTF-8")
      }
      expect(exactClaims.capabilityId).toBe("exact-key")
    }))

  it.effect("mints a capability whose claims are scoped, timed, and verifiable", () =>
    Effect.gen(function*() {
      const [capability, claims] = yield* run(
        Effect.gen(function*() {
          const share = yield* authority
          const minted = yield* share.mint({ branchId, capabilityId: "cap-1", access: "write", ttlMs: 60_000 })
          return [minted, yield* share.verify(minted, { branchId, access: "write" })] as const
        })
      )

      expect(capability.claims.branchId).toBe(branchId)
      expect(capability.claims.expiresAtMs - capability.claims.issuedAtMs).toBe(60_000)
      expect(capability.signature).toMatch(/^[0-9a-f]{64}$/)
      expect(claims.capabilityId).toBe("cap-1")
    }))

  it.effect("keeps a shorter requested TTL within an absolute expiry limit", () =>
    run(Effect.gen(function*() {
      const share = yield* authority
      yield* TestClock.adjust(100)
      const capability = yield* share.mint({
        branchId,
        capabilityId: "short-child",
        access: "read",
        ttlMs: 200,
        maxExpiresAtMs: 1_000
      })
      expect(capability.claims.issuedAtMs).toBe(100)
      expect(capability.claims.expiresAtMs).toBe(300)
    })))

  it.effect("refuses an absolute expiry limit elapsed by the signing clock read", () =>
    run(Effect.gen(function*() {
      const share = yield* authority
      yield* TestClock.adjust(1_000)
      const failure = yield* Effect.flip(share.mint({
        branchId,
        capabilityId: "expired-child",
        access: "read",
        ttlMs: 60_000,
        maxExpiresAtMs: 1_000
      }))
      expect(failure).toMatchObject({ code: "unauthorized" })
      expect(failure.message).toContain("expired")
    })))

  it.effect("rejects a tampered signature without leaking its length", () =>
    Effect.gen(function*() {
      const failures = yield* run(
        Effect.gen(function*() {
          const share = yield* authority
          const capability = yield* mintWrite
          const flipped = new BranchProtocol.ShareCapability({
            claims: capability.claims,
            signature: `0${capability.signature.slice(1)}`
          })
          const truncated = new BranchProtocol.ShareCapability({ claims: capability.claims, signature: "" })
          return [
            yield* Effect.flip(share.verify(flipped, { branchId, access: "read" })),
            yield* Effect.flip(share.verify(truncated, { branchId, access: "read" }))
          ]
        })
      )

      for (const failure of failures) {
        expect(failure.code).toBe("unauthorized")
        expect(failure.message).toBe("The share capability signature is invalid")
      }
    }))

  it.effect("rejects a capability replayed against another branch", () =>
    Effect.gen(function*() {
      const failure = yield* run(
        Effect.gen(function*() {
          const share = yield* authority
          const capability = yield* mintWrite
          return yield* Effect.flip(share.verify(capability, { branchId: otherBranchId, access: "read" }))
        })
      )

      expect(failure.code).toBe("unauthorized")
      expect(failure.message).toContain(branchId)
    }))

  it.effect("rejects an expired capability at the instant the lease runs out", () =>
    Effect.gen(function*() {
      const outcome = yield* run(
        Effect.gen(function*() {
          const share = yield* authority
          const capability = yield* share.mint({
            branchId,
            capabilityId: "cap-short",
            access: "write",
            ttlMs: 1_000
          })
          yield* TestClock.adjust(Duration.millis(999))
          const stillValid = yield* share.verify(capability, { branchId, access: "write" })
          yield* TestClock.adjust(Duration.millis(1))
          return [
            stillValid.capabilityId,
            yield* Effect.flip(share.verify(capability, { branchId, access: "read" }))
          ] as const
        })
      )

      expect(outcome[0]).toBe("cap-short")
      expect(outcome[1].message).toBe("The share capability has expired")
    }))

  it.effect("refuses to widen a read capability into write access", () =>
    Effect.gen(function*() {
      const outcome = yield* run(
        Effect.gen(function*() {
          const share = yield* authority
          const capability = yield* share.mint({
            branchId,
            capabilityId: "cap-read",
            access: "read",
            ttlMs: 60_000
          })
          return [
            (yield* share.verify(capability, { branchId, access: "read" })).access,
            yield* Effect.flip(share.verify(capability, { branchId, access: "write" }))
          ] as const
        })
      )

      expect(outcome[0]).toBe("read")
      expect(outcome[1].message).toBe("The share capability is read-only")
    }))

  it.effect("distinguishes claim sets whose fields would concatenate identically", () =>
    Effect.gen(function*() {
      const signatures = yield* run(
        Effect.gen(function*() {
          const share = yield* authority
          const left = yield* share.mint({
            branchId: "ab" as BranchProtocol.BranchId,
            capabilityId: "c",
            access: "read",
            ttlMs: 1_000
          })
          const right = yield* share.mint({
            branchId: "a" as BranchProtocol.BranchId,
            capabilityId: "bc",
            access: "read",
            ttlMs: 1_000
          })
          return [left.signature, right.signature]
        })
      )

      expect(signatures[0]).not.toBe(signatures[1])
    }))

  it.effect("verifies through the provided layer", () =>
    Effect.gen(function*() {
      const access = yield* run(
        Effect.gen(function*() {
          const share = yield* BranchShare.BranchShare
          const capability = yield* share.mint({ branchId, capabilityId: "cap-l", access: "write", ttlMs: 1_000 })
          return (yield* share.verify(capability, { branchId, access: "write" })).access
        }).pipe(
          Effect.provide(
            BranchShare.layerHmac({
              activeKid: "primary",
              keys: [{ kid: "primary", secret: Redacted.make("layer-secret-0123456789abcdefghi") }]
            })
          )
        )
      )

      expect(access).toBe("write")
    }))

  it.effect("refuses everything through the noop layer, and honours overrides", () =>
    Effect.gen(function*() {
      const mintExit = yield* Effect.exit(
        Effect.flatMap(
          BranchShare.BranchShare,
          (share) => share.mint({ branchId, capabilityId: "cap", access: "read", ttlMs: 1 })
        ).pipe(
          Effect.provide(BranchShare.layerNoop)
        )
      )
      const verifyFailure = yield* (
        Effect.flatMap(BranchShare.BranchShare, (share) =>
          Effect.flip(
            share.verify(
              new BranchProtocol.ShareCapability({
                claims: new BranchProtocol.ShareClaims({
                  kid: "primary",
                  branchId,
                  capabilityId: "cap",
                  access: "read",
                  issuedAtMs: 0,
                  expiresAtMs: 1
                }),
                signature: ""
              }),
              { branchId, access: "read" }
            )
          )).pipe(Effect.provide(BranchShare.layerNoop))
      )
      const overridden = BranchShare.makeNoop({
        verify: () => Effect.fail(new SyncError({ code: "unauthorized", message: "overridden" }))
      })

      // A Die satisfies `Exit.isFailure` exactly as a Fail does, which is how
      // a `mint` that died where its type promises a `SyncError` stayed green.
      const mintRefusal = refusalOf(mintExit)
      expect(died(mintExit)).toBe(false)
      expect(SyncError.is(mintRefusal)).toBe(true)
      expect(mintRefusal?.code).toBe("unauthorized")
      expect(mintRefusal?.message).toBe("Branch sharing is unavailable")
      expect(verifyFailure.message).toBe("Branch sharing is unavailable")
      expect(
        (yield* (
          Effect.flip(
            overridden.verify(
              new BranchProtocol.ShareCapability({
                claims: new BranchProtocol.ShareClaims({
                  kid: "primary",
                  branchId,
                  capabilityId: "cap",
                  access: "read",
                  issuedAtMs: 0,
                  expiresAtMs: 1
                }),
                signature: ""
              }),
              { branchId, access: "read" }
            )
          )
        )).message
      ).toBe("overridden")
    }))

  it.effect("preserves real Web Crypto failures for invalid keys", () =>
    Effect.gen(function*() {
      const native = yield* ShareSigner.Crypto
      const emptyKey = yield* Effect.flip(native.importKey(new Uint8Array(0)))
      const encryptionKey = yield* Effect.promise(() =>
        crypto.subtle.importKey("raw", new Uint8Array(16), "AES-GCM", false, ["encrypt"])
      )
      const wrongUsage = yield* Effect.flip(native.sign(encryptionKey, new Uint8Array([1])))
      expect(emptyKey).toMatchObject({ name: "DataError" })
      expect(wrongUsage).toMatchObject({ name: "InvalidAccessError" })
    }))

  it.effect("maps a Web Crypto rejection into a typed SyncError carrying the cause", () =>
    Effect.gen(function*() {
      const importFailure = new Error("import refused")
      const crypto = yield* ShareSigner.Crypto
      const importExit = yield* run(
        Effect.exit(
          BranchShare.makeHmac({
            activeKid: "primary",
            keys: [{ kid: "primary", secret: Redacted.make("broken-0123456789abcdefghijklmnopqrstuv") }]
          }).pipe(Effect.provideService(ShareSigner.Crypto, {
            ...crypto,
            importKey: () => Effect.fail(importFailure)
          }))
        )
      )

      const [share, capability] = yield* run(
        Effect.gen(function*() {
          const built = yield* authority
          return [
            built,
            yield* built.mint({ branchId, capabilityId: "cap-x", access: "write", ttlMs: 60_000 })
          ] as const
        })
      )
      const signFailure = new Error("sign refused")
      const refusedSign = { ...crypto, sign: () => Effect.fail(signFailure) }
      const mintExit = yield* run(
        Effect.exit(
          share.mint({ branchId, capabilityId: "cap-failed", access: "write", ttlMs: 60_000 }).pipe(Effect.asVoid)
        )
          .pipe(Effect.provideService(ShareSigner.Crypto, refusedSign))
      )
      const verifyExit = yield* run(
        Effect.exit(share.verify(capability, { branchId, access: "write" }).pipe(Effect.asVoid))
          .pipe(Effect.provideService(ShareSigner.Crypto, refusedSign))
      )

      // The cause is a bounded RENDERING, not the host object: `SyncError` is
      // the declared error schema of every RPC in both groups, so an
      // arbitrary `unknown` here had no defined wire form and no ceiling.
      const importError = refusalOf(importExit)
      expect(died(importExit)).toBe(false)
      expect(importError).toBeInstanceOf(SyncError)
      expect(importError?.code).toBe("unknown")
      expect(importError?.cause).toBe(`Error: ${importFailure.message}`)
      expect(importError?.message).toBe("Web Crypto could not import the HMAC signing key")
      for (const exit of [mintExit, verifyExit]) {
        const error = refusalOf(exit)
        expect(died(exit)).toBe(false)
        expect(error).toBeInstanceOf(SyncError)
        expect(error?.code).toBe("unknown")
        expect(error?.message).toBe("Web Crypto could not sign the share claims")
        expect(error?.cause).toBe(`Error: ${signFailure.message}`)
      }
    }))

  it.effect("annotates mint and verify spans with the branch identity, never the capability material", () =>
    Effect.gen(function*() {
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        }
      })

      yield* run(
        Effect.gen(function*() {
          const share = yield* authority
          const capability = yield* share.mint({ branchId, capabilityId: "cap-span", access: "write", ttlMs: 60_000 })
          return yield* share.verify(capability, { branchId, access: "write" })
        }).pipe(Effect.provideService(Tracer.Tracer, tracer))
      )

      const mintSpan = spans.find((span) => span.name === "BranchShare.mint")
      const verifySpan = spans.find((span) => span.name === "BranchShare.verify")
      expect(mintSpan?.attributes.get("branchId")).toBe(branchId)
      expect(mintSpan?.attributes.get("access")).toBe("write")
      expect(verifySpan?.attributes.get("branchId")).toBe(branchId)
      expect(verifySpan?.attributes.get("access")).toBe("write")
      for (const span of spans) {
        const keys = [...span.attributes.keys()]
        expect(keys).not.toContain("secret")
        expect(keys).not.toContain("signature")
        expect(keys).not.toContain("key")
      }
    }))
})
