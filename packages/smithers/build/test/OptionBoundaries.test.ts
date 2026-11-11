import { describe, expect, it } from "vitest"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"

const platform = { os: "linux", arch: "x64", libc: null }
const options = { requirement: "1.0.0", projectRoot: "/workspace" }
const nul = String.fromCharCode(0)
const surrogate = String.fromCharCode(0xd800)

describe("package-manager option boundaries", () => {
  for (
    const [key, invalid] of [
      ["projectRoot", [7, "", nul, surrogate, "/".repeat(32 * 1024 + 1), "relative"]],
      ["requirement", [7, "", nul, surrogate, "é".repeat(129)]],
      ["executable", [7, "", nul, surrogate, "x".repeat(32 * 1024 + 1)]],
      ["storeDirectory", [7, "", nul, surrogate, "/".repeat(32 * 1024 + 1), "relative"]]
    ] as const
  ) {
    it(`refuses unusable ${key} values`, () => {
      for (const value of invalid) {
        expect(() => PackageManager.makeNoop("pnpm", { ...options, [key]: value }, platform))
          .toThrow(new RegExp(key))
      }
    })
  }

  it("accepts text at the UTF-8 byte boundary", () => {
    const projectRoot = "/" + "x".repeat(32 * 1024 - 1)
    const executable = "é".repeat(16 * 1024)
    const service = PackageManager.makeNoop("pnpm", {
      projectRoot,
      executable,
      requirement: "é".repeat(128),
      storeDirectory: "/store"
    }, platform)
    expect(service.projectRoot).toBe(projectRoot)
    expect(service.requirement).toBe("é".repeat(128))
    expect(service.storeDirectory).toBe("/store")
  })

  it("bounds credential hosts and rejects holes and accessors without invoking them", () => {
    let reads = 0
    const accessor = Object.defineProperty(["registry.example"], "0", {
      get: () => {
        reads += 1
        return "registry.example"
      }
    })
    for (const credentialHosts of [Array(1), accessor, [7], Array(65).fill("registry.example")]) {
      expect(() => PackageManager.makeNoop("pnpm", { ...options, credentialHosts }, platform))
        .toThrow(/credentialHosts/)
    }
    expect(reads).toBe(0)
    expect(
      PackageManager.makeNoop("pnpm", {
        ...options,
        credentialHosts: Array(64).fill("registry.example")
      }, platform).name
    ).toBe("pnpm")
  })
})

describe("store-manifest input boundaries", () => {
  const input = {
    manager: "pnpm" as const,
    managerVersion: "1.0.0",
    platform,
    lockfileDigest: "a".repeat(64),
    npmrcDigest: null
  }

  it("refuses unusable versions without serializing them into store identity", () => {
    for (const managerVersion of [7, "", surrogate, "x".repeat(65_537), nul]) {
      expect(() => PackageManager.storeManifestText({ ...input, managerVersion } as never))
        .toThrow(/managerVersion/)
    }
    expect(PackageManager.storeManifestText({ ...input, managerVersion: "x".repeat(65_536) }))
      .toContain("x".repeat(65_536))
  })

  it("refuses missing and non-text digests while retaining explicit null optional inputs", () => {
    for (const key of ["lockfileDigest", "npmrcDigest", "pnpmfileDigest", "workspaceDigest"] as const) {
      for (const value of [undefined, 7]) {
        expect(() => PackageManager.storeManifestText({ ...input, [key]: value }))
          .toThrow(new RegExp(key))
      }
    }
    expect(PackageManager.storeManifestText({ ...input, pnpmfileDigest: null, workspaceDigest: null }))
      .toBe(PackageManager.storeManifestText(input))
  })
})

describe("runtime option boundaries", () => {
  it("accepts a null-prototype option record and rejects hidden fields", () => {
    const options = { requirement: "1.0.0", version: "1.0.0", platform }
    expect(Runtime.makeNoop("node", Object.assign(Object.create(null), options)).requirement).toBe("1.0.0")
    expect(() =>
      Runtime.makeNoop(
        "node",
        Object.defineProperty({ ...options }, "version", {
          enumerable: false,
          value: "1.0.0"
        })
      )
    ).toThrow(/enumerable data property/)
  })
})
