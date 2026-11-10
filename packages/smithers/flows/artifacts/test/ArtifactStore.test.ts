/**
 * The `ArtifactStore` module is the compatibility surface: the contract and its
 * layers are defined there, and every error, helper, and backend it exports is
 * defined in the module named for it and re-exported unchanged.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as ArtifactStore from "../src/ArtifactStore.vibe"
import * as ArtifactStoreError from "../src/ArtifactStoreError.vibe"
import * as FileSystemArtifactStore from "../src/FileSystemArtifactStore.vibe"
import * as Artifacts from "../src/index.vibe"
import { measureBytes } from "../src/measureBytes.vibe"
import * as MemoryArtifactStore from "../src/MemoryArtifactStore.vibe"
import * as NoopArtifactStore from "../src/NoopArtifactStore.vibe"
import { snapshotBytes } from "../src/snapshotBytes.vibe"
import { validateDigest } from "../src/validateDigest.vibe"
import { withCrypto } from "./Crypto.ts"

const surface = [
  "ArtifactCorruption",
  "ArtifactMissing",
  "ArtifactStore",
  "ArtifactStoreError",
  "ArtifactStoreErrorCode",
  "Digest",
  "defaultDirectory",
  "layerFileSystem",
  "layerMemory",
  "layerNoop",
  "makeFileSystem",
  "makeMemory",
  "makeNoop",
  "measureBytes",
  "snapshotBytes",
  "validateDigest"
]

describe("the ArtifactStore module", () => {
  it("keeps exactly its published runtime surface, from its subpath and from the root", () => {
    expect(Object.keys(ArtifactStore).sort()).toEqual(surface)
    expect(Object.keys(Artifacts.ArtifactStore).sort()).toEqual(surface)
    for (const name of surface) {
      expect(Artifacts.ArtifactStore[name as keyof typeof ArtifactStore]).toBe(
        ArtifactStore[name as keyof typeof ArtifactStore]
      )
    }
  })

  it("re-exports each definition from the module named for it, not a copy", () => {
    expect(ArtifactStore.ArtifactStoreErrorCode).toBe(ArtifactStoreError.ArtifactStoreErrorCode)
    expect(ArtifactStore.ArtifactStoreError).toBe(ArtifactStoreError.ArtifactStoreError)
    expect(ArtifactStore.ArtifactMissing).toBe(ArtifactStoreError.ArtifactMissing)
    expect(ArtifactStore.ArtifactCorruption).toBe(ArtifactStoreError.ArtifactCorruption)
    expect(ArtifactStore.measureBytes).toBe(measureBytes)
    expect(ArtifactStore.snapshotBytes).toBe(snapshotBytes)
    expect(ArtifactStore.validateDigest).toBe(validateDigest)
    expect(ArtifactStore.defaultDirectory).toBe(FileSystemArtifactStore.defaultDirectory)
    expect(ArtifactStore.makeFileSystem).toBe(FileSystemArtifactStore.makeFileSystem)
    expect(ArtifactStore.makeMemory).toBe(MemoryArtifactStore.makeMemory)
    expect(ArtifactStore.makeNoop).toBe(NoopArtifactStore.makeNoop)
  })

  it.effect("fails a backend's miss and refusal with the classes the compatibility surface exports", () =>
    Effect.gen(function*() {
      const miss = yield* Effect.flip(withCrypto(MemoryArtifactStore.makeMemory().get("0".repeat(64))))
      expect(miss).toBeInstanceOf(ArtifactStore.ArtifactMissing)
      const refusal = yield* Effect.flip(NoopArtifactStore.makeNoop().has("0".repeat(64)))
      expect(refusal).toBeInstanceOf(ArtifactStore.ArtifactStoreError)
      expect(refusal.code).toBe("unavailable")
    }))

  it("keeps the contract's types addressable through the compatibility surface", () => {
    const options: ArtifactStore.FileSystemOptions = { directory: ArtifactStore.defaultDirectory }
    const service: ArtifactStore.Service = ArtifactStore.makeNoop()
    const code: ArtifactStore.ArtifactStoreErrorCode = "invalid_digest"
    expect([options.directory, typeof service.put, code]).toEqual([".flows/objects", "function", "invalid_digest"])
  })
})
