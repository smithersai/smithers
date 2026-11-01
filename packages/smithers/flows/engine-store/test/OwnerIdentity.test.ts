/**
 * The owner identity port: what the default mints on a host with a process,
 * what it mints on one without (a browser tab), and that a composition can
 * pin the whole token instead.
 *
 * @since 0.1.0
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { Crypto } from "@smthrs/crypto"
import * as Effect from "effect/Effect"
import * as Random from "effect/Random"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Builds the incarnation source over the node `Crypto` implementation. */
const incarnation = (pid: number | undefined) =>
  Effect.map(Crypto.Crypto, (crypto) => OwnerIdentity.makeIncarnation(pid, crypto)).pipe(
    Effect.provide(Crypto.layerFromDigest(NodeCrypto.layerDigest))
  )

describe("OwnerIdentity", () => {
  it.effect("mints the reported process id and a fresh nonce per call", () =>
    Effect.gen(function*() {
      const identity = yield* incarnation(4242)
      const first = yield* (identity.ownerId("some-host"))
      const second = yield* (identity.ownerId("some-host"))

      expect(first.hostId).toBe("some-host")
      expect(first.pid).toBe(4242)
      expect(first.nonce).toMatch(uuid)
      // The nonce is what makes two incarnations on one host distinguishable,
      // so it must never repeat — that is the whole fencing guarantee.
      expect(second.nonce).not.toBe(first.nonce)
    }))

  it.effect("draws an incarnation number on a host with no process (a browser tab)", () =>
    Effect.gen(function*() {
      const identity = yield* incarnation(undefined)
      const owner = yield* (identity.ownerId("tab-host"))

      expect(Number.isSafeInteger(owner.pid)).toBe(true)
      expect(owner.pid).toBeGreaterThanOrEqual(0)
      expect(owner.nonce).toMatch(uuid)
    }))

  it.effect("provides the platform default through the layer", () =>
    Effect.gen(function*() {
      const owner = yield* (
        Effect.flatMap(OwnerIdentity.OwnerIdentity, (identity) => identity.ownerId("layer-host")).pipe(
          Effect.provide(OwnerIdentity.layer),
          Effect.provide(Crypto.layerFromDigest(NodeCrypto.layerDigest))
        )
      )

      // The suite runs on node, so the default reports this process.
      expect(owner).toEqual({ hostId: "layer-host", pid: process.pid, nonce: owner.nonce })
      expect(owner.nonce).toMatch(uuid)
    }))

  it.effect("draws the incarnation number on a host whose process id names no incarnation", () =>
    Effect.gen(function*() {
      const ownerUnder = (layer: typeof OwnerIdentity.layer) =>
        Effect.flatMap(OwnerIdentity.OwnerIdentity, (identity) => identity.ownerId("isolate-host")).pipe(
          Effect.provide(layer),
          Effect.provide(Crypto.layerFromDigest(NodeCrypto.layerDigest)),
          Random.withSeed("incarnation")
        )
      const drawn = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER, { halfOpen: true }).pipe(
        Random.withSeed("incarnation")
      )
      const withoutPid = yield* ownerUnder(OwnerIdentity.layerWithoutPid)
      const withPid = yield* ownerUnder(OwnerIdentity.layer)

      // Node reports a process id, and only the default layer reads it.
      expect(withPid.pid).toBe(process.pid)
      expect(withoutPid.pid).toBe(drawn)
      expect(withoutPid.pid).not.toBe(process.pid)
      expect(withoutPid.nonce).toMatch(uuid)
    }))

  it.effect("lets a composition pin the whole token", () =>
    Effect.gen(function*() {
      const pinned = { hostId: "pinned-host", pid: 7, nonce: "pinned-nonce" }
      const owner = yield* (
        Effect.flatMap(OwnerIdentity.OwnerIdentity, (identity) => identity.ownerId("ignored")).pipe(
          Effect.provide(OwnerIdentity.layerConstant(pinned))
        )
      )

      expect(owner).toEqual(pinned)
    }))
})
