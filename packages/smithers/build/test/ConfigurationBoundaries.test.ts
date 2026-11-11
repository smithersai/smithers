import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as PackageManager from "../src/PackageManager.ts"

describe("npmrc parser boundaries", () => {
  it("ignores malformed lines and section headers while hashing the original bytes", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-npmrc-boundaries-")))
    try {
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "[section]\n=\nregistry=https://registry.example/")
      const digest = await Effect.runPromise(
        PackageManager.npmrcDigest(root).pipe(
          Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))
        )
      )
      expect(digest).toMatch(/^[0-9a-f]{64}$/)
      await Fs.writeFile(NodePath.join(root, ".npmrc"), "registry=https://registry.example/")
      const changed = await Effect.runPromise(
        PackageManager.npmrcDigest(root).pipe(
          Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))
        )
      )
      expect(changed).not.toBe(digest)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  it("decodes non-string JSON keys and preserves unknown and terminal escapes in refusal messages", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-npmrc-escapes-")))
    try {
      for (
        const [key, expected] of [
          ["'false'", "false"],
          ["some\\q", "some\\q"],
          ["some\\", "some\\"]
        ]
      ) {
        await Fs.writeFile(NodePath.join(root, ".npmrc"), key + "=${TOKEN}")
        const error = await Effect.runPromise(
          PackageManager.npmrcDigest(root).pipe(
            Effect.flip,
            Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))
          )
        )
        expect(error.code).toBe("unsafe_configuration")
        expect(error.message).toContain("setting " + expected + " uses an environment placeholder")
      }
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe("unsupported manager and filesystem-root options", () => {
  it("reports the documented Bun refusal", () => {
    const error = PackageManager.bunInstallUnsupported()
    expect(error.code).toBe("unsupported")
    expect(error.message).toBe(PackageManager.bunInstallUnsupportedMessage)
  })

  it("refuses a shared store contained by a filesystem root", () => {
    expect(() =>
      PackageManager.makeNoop("pnpm", {
        requirement: "1.0.0",
        projectRoot: "/",
        storeDirectory: "/store"
      }, { os: "linux", arch: "x64", libc: null })
    ).toThrow(/outside the project root/)
  })
})
