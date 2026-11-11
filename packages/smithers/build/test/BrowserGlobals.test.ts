/**
 * The seams documented as browser-bundleable run without Node's globals.
 *
 * `Runtime.makeNoop`, `PackageManager.makeNoop` and the store manifest are what
 * a browser or Worker composition reaches. The repository's browser gate loads
 * bundles inside a Node worker, where `Buffer` exists, so this suite removes
 * `Buffer` for the duration of each call and checks the seams still answer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { utf8ByteLength } from "../src/internal/validate.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"

const platform = { os: "linux", arch: "x64", libc: null } as const

describe("browser-bundleable seams without the Node Buffer global", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "Buffer")
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, "Buffer")
  })
  afterEach(() => {
    if (saved !== undefined) Object.defineProperty(globalThis, "Buffer", saved)
  })

  it("builds a noop runtime with an environment", () => {
    expect("Buffer" in globalThis).toBe(false)
    const runtime = Runtime.makeNoop("node", {
      requirement: ">=22.19.0",
      version: "24.9.0",
      platform,
      environment: { PATH: "/bin" }
    })
    expect(runtime.requirement).toBe(">=22.19.0")
  })

  it("builds a noop package manager and renders a store manifest", () => {
    const manager = PackageManager.makeNoop("pnpm", {
      requirement: "11.21.0",
      projectRoot: "/workspace",
      executable: "pnpm",
      storeDirectory: "/store"
    }, platform)
    expect(manager.storeDirectory).toBe("/store")
    expect(PackageManager.storeManifestText({
      manager: "pnpm",
      managerVersion: "11.21.0",
      platform,
      lockfileDigest: "a".repeat(64),
      npmrcDigest: null
    })).toContain("\"11.21.0\"")
  })
})

describe("utf8ByteLength", () => {
  it("counts what TextEncoder encodes, lone surrogates as U+FFFD", () => {
    const encoder = new TextEncoder()
    for (
      const value of [
        "",
        "ascii",
        "\u007f\u0080߿ࠀ￿",
        "café 中文",
        "😀 emoji",
        "\ud800",
        "\udc00",
        "\ud800x",
        "x\ud800",
        "\ud800𐀀"
      ]
    ) {
      expect(utf8ByteLength(value), JSON.stringify(value)).toBe(encoder.encode(value).byteLength)
    }
  })
})
