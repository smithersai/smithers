import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as ArtifactStore from "../src/ArtifactStore.vibe"
import { bytes, sha256 } from "./Crypto.ts"

const errorOf = (exit: Exit.Exit<unknown, unknown>): ArtifactStore.ArtifactStoreError => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: ArtifactStore.ArtifactStoreError }).error
}

describe("artifact digest boundary", () => {
  it.effect("accepts exactly the canonical SHA-256 representation", () =>
    Effect.gen(function*() {
      const digest = sha256(bytes("canonical"))
      expect(yield* ArtifactStore.validateDigest(digest)).toBe(digest)
    }))

  it.effect("rejects malformed and adversarial values with one bounded message", () =>
    Effect.gen(function*() {
      const canonical = sha256(bytes("canonical"))
      const candidates = [
        "",
        "0".repeat(63),
        "0".repeat(65),
        canonical.toUpperCase(),
        ` ${canonical}`,
        `${canonical}\n`,
        `${canonical.slice(0, 63)}é`,
        `${canonical}?query=secret`,
        `${canonical}#fragment`,
        `${canonical.slice(0, 62)}%2f`,
        "x".repeat(1_000_000)
      ]
      for (const candidate of candidates) {
        const exit = yield* ArtifactStore.validateDigest(candidate).pipe(Effect.exit)
        const failure = errorOf(exit)
        expect(failure.code).toBe("invalid_digest")
        expect(failure.message).toBe("artifact digest must be exactly 64 lowercase hexadecimal characters")
        expect(failure.message.length).toBeLessThan(100)
        if (candidate.length > 0) expect(JSON.stringify(failure)).not.toContain(candidate.slice(0, 128))
      }
    }))
})
