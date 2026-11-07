import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { compileKey, decodeIdentity, example, readIdentity } from "../examples/identities.ts"

const run = <A, E>(program: Effect.Effect<A, E, import("effect/crypto/Digest").Digest>) =>
  Effect.runPromise(Effect.provide(program, NodeCrypto.layer))

describe("runnable identity examples", () => {
  it("round-trips a derived identity without rehashing stored text", async () => {
    const result = await run(example)
    const document = "{\"domain\":\"example/compile\",\"flags\":[\"--minify\"],\"target\":\"web\",\"version\":1}"
    const expected = `key1_${createHash("sha256").update(document, "utf8").digest("hex")}`
    expect(result.key).toBe(expected)
    expect(result.digest).toBe(result.key.slice(5))
    expect(readIdentity(result.key)).toEqual(result)
    expect(await run(decodeIdentity(result.key))).not.toBe(result.key)
    expect(() => readIdentity(result.key.toUpperCase())).toThrow()
  })

  it("preserves ordered flags and separates the compile namespace", async () => {
    const key = await run(compileKey("web", ["--minify", "--sourcemap"]))
    expect(await run(compileKey("web", ["--minify", "--sourcemap"]))).toBe(key)
    expect(await run(compileKey("web", ["--sourcemap", "--minify"]))).not.toBe(key)
    expect(
      await run(decodeIdentity({
        flags: ["--minify", "--sourcemap"],
        target: "web",
        version: 1,
        domain: "example/compile"
      }))
    ).toBe(key)
    expect(
      await run(decodeIdentity({
        flags: ["--minify", "--sourcemap"],
        target: "web",
        version: 1,
        domain: "example/link"
      }))
    ).not.toBe(key)
  })

  it("hashes Unicode material as UTF-8 without normalizing distinct text", async () => {
    const targets = ["café", "cafe\u0301", "web/🚀", "web\u0000target"]
    const keys = []
    for (const target of targets) {
      const document = JSON.stringify({ domain: "example/compile", flags: [], target, version: 1 })
      const expected = `key1_${createHash("sha256").update(document, "utf8").digest("hex")}`
      const key = await run(compileKey(target, []))
      expect(key).toBe(expected)
      expect(readIdentity(key).key).toBe(key)
      keys.push(key)
    }
    expect(new Set(keys).size).toBe(targets.length)
  })

  it("rejects unsupported material and malformed stored input", async () => {
    await expect(run(decodeIdentity(1n))).rejects.toThrow()
    await expect(run(compileKey("\ud800", []))).rejects.toThrow()
    await expect(run(compileKey("\udc00", []))).rejects.toThrow()
    expect(() => readIdentity({ key: "key1_" })).toThrow()
  })
})
