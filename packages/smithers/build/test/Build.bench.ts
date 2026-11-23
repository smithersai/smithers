import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Effect from "effect/Effect"
import { describe, test } from "vitest"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"

const opts = { time: 120, warmupTime: 30 }

const versionPairs: ReadonlyArray<readonly [string, string]> = [
  [">=26.4.0", "26.10.0"],
  [">=22.19.0", "22.19.0"],
  ["<=27.0.0", "26.10.0"],
  [">1.4.0", "1.4.1"],
  ["26.10.0", "26.10.0"],
  [">=1.0.0-rc.1", "1.0.0-rc.18"]
]

const digestA = "a".repeat(64)
const digestB = "b".repeat(64)
const digestC = "c".repeat(64)

const manifestInput: PackageManager.StoreManifestInput = {
  manager: "pnpm",
  managerVersion: "11.25.0",
  platform: { os: "darwin", arch: "arm64", libc: null },
  lockfileDigest: digestA,
  npmrcDigest: digestB,
  pnpmfileDigest: digestC,
  workspaceDigest: digestA
}

const bunManifestInput: PackageManager.StoreManifestInput = {
  manager: "bun",
  managerVersion: "1.4.1",
  platform: { os: "linux", arch: "x64", libc: "glibc" },
  lockfileDigest: digestA,
  npmrcDigest: null,
  bunfigDigest: digestB,
  patches: Array.from({ length: 12 }, (_, index) => ({
    path: `patches/pkg-${index}@1.0.0.patch`,
    digest: `${index.toString(16).padStart(2, "0")}${"f".repeat(62)}`
  }))
}

describe("@smthrs/build", () => {
  test("Runtime.satisfies across 6 semver checks", async ({ bench }) => {
    await bench("Runtime.satisfies (6 pairs)", () => {
      for (const [requirement, version] of versionPairs) {
        Runtime.satisfies(requirement, version)
      }
    }).run(opts)
  })

  test("PackageManager.storeManifestText (pnpm)", async ({ bench }) => {
    await bench("storeManifestText (pnpm)", () => {
      PackageManager.storeManifestText(manifestInput)
    }).run(opts)
  })

  test("PackageManager.storeManifestText (bun + 12 patches)", async ({ bench }) => {
    await bench("storeManifestText (bun + 12 patches)", () => {
      PackageManager.storeManifestText(bunManifestInput)
    }).run(opts)
  })

  test("PackageManager.storeManifest SHA-256 digest", async ({ bench }) => {
    await bench("storeManifest (SHA-256)", async () => {
      await Effect.runPromise(
        PackageManager.storeManifest(manifestInput).pipe(Effect.provide(NodeCrypto.layer))
      )
    }).run(opts)
  })
})
