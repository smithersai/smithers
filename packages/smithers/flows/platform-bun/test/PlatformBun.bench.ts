import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import { describe, test } from "vitest"
import { BunHost } from "../src/index.ts"

const encoder = new TextEncoder()
const sampleBytes = encoder.encode("smithers-platform-bun-benchmark-payload-".repeat(64))
const liveness = BunHost.HostLiveness.isAlive({ hostId: "bench-bun-host" })
const ownOwner = { hostId: "bench-bun-host", pid: process.pid }
const foreignOwner = { hostId: "remote-host", pid: 999_999 }

describe("@smthrs/platform-bun", () => {
  test("BunHost.layerAt root validation + layer construction", async ({ bench }) => {
    await bench("BunHost.layerAt valid", () => {
      BunHost.layerAt("/workspace/repo")
    }).run({ time: 120, warmupTime: 30 })
  })

  test("BunHost.layerAt invalid root refusal (BunHostError)", async ({ bench }) => {
    await bench("BunHost.layerAt invalid refusal", () => {
      try {
        BunHost.layerAt("relative/path/\u0000bad")
      } catch {
        // expected BunHostError
      }
    }).run({ time: 120, warmupTime: 30 })
  })

  test("BunHost.HostLiveness.isAlive (own + foreign host)", async ({ bench }) => {
    const program = Effect.gen(function*() {
      yield* liveness(ownOwner)
      yield* liveness(foreignOwner)
    })
    await bench("HostLiveness.isAlive", async () => {
      await Effect.runPromise(program)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("BunCrypto SHA-256 digest (2.5 KiB payload)", async ({ bench }) => {
    const program = Effect.flatMap(Digest.Digest, (digest) => digest.digest(Digest.sha256, sampleBytes)).pipe(
      Effect.provide(BunHost.BunCrypto.layer)
    )
    await bench("BunCrypto SHA-256", async () => {
      await Effect.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })

  test("Path.layer resolution", async ({ bench }) => {
    const program = Effect.flatMap(
      Path.Path,
      (path) => Effect.sync(() => path.resolve("/workspace/repo", "packages/smithers/flows/platform-bun/src/index.ts"))
    ).pipe(Effect.provide(Path.layer))
    await bench("Path.resolve", () => {
      Effect.runSync(program)
    }).run({ time: 120, warmupTime: 30 })
  })
})
