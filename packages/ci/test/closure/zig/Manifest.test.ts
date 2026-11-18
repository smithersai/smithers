import { describe, expect, it } from "vitest"
import * as Manifest from "../../../src/closure/zig/Manifest.ts"

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
const unhex = (text: string): Uint8Array =>
  Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))

/** One manifest record as Zig 0.17.1 writes it: size, inode, mtime, digest, flags, path, zero. */
const record = (flags: number, path: string, digest = "00".repeat(16)): Uint8Array =>
  Uint8Array.from([...new Uint8Array(24), ...unhex(digest), flags, ...new TextEncoder().encode(path), 0])

const file = (...records: ReadonlyArray<Uint8Array>): Uint8Array =>
  Uint8Array.from([...records.flatMap((one) => [...one]), 0])

/** `hasher_init` in Zig 0.17.1's `lib/std/Build/Cache.zig`. */
const key = unhex("02e9fafee0958155f55a15cb4af40009")

describe("Manifest.decode", () => {
  it("reads each input's prefix, path, kind and digest", () => {
    const digest = "4b00175c9d58bd7fff971e267b91de33"
    expect(Manifest.decode(file(
      record(4 << 2, "src/alpha.zig", digest),
      record((0 << 2) | 1, "/abs/dir"),
      record(1 << 2, "std/std.zig"),
      record(2 << 2, "o/abc/words.zig"),
      record(3 << 2, "p/pkg/root.zig"),
      record(9 << 2, "odd")
    ))).toEqual([
      { prefix: "build-root", path: "src/alpha.zig", directory: false, digest: unhex(digest) },
      { prefix: "cwd", path: "/abs/dir", directory: true, digest: new Uint8Array(16) },
      { prefix: "zig-lib", path: "std/std.zig", directory: false, digest: new Uint8Array(16) },
      { prefix: "local-cache", path: "o/abc/words.zig", directory: false, digest: new Uint8Array(16) },
      { prefix: "global-cache", path: "p/pkg/root.zig", directory: false, digest: new Uint8Array(16) },
      { prefix: "unknown", path: "odd", directory: false, digest: new Uint8Array(16) }
    ])
  })

  it("reads a manifest with no inputs", () => {
    expect(Manifest.decode(Uint8Array.of(0))).toEqual([])
  })

  it("refuses bytes that are not a finished manifest", () => {
    // What Zig leaves behind when the step fails.
    expect(Manifest.decode(new Uint8Array())).toBeUndefined()
    // No final zero byte.
    expect(Manifest.decode(record(4 << 2, "a").subarray(0, -1))).toBeUndefined()
    // A record cut off inside its fixed part.
    expect(Manifest.decode(new Uint8Array(20))).toBeUndefined()
    // A record with an empty path.
    expect(Manifest.decode(file(record(4 << 2, "")))).toBeUndefined()
    // A record whose path runs into the final zero byte.
    expect(Manifest.decode(record(4 << 2, "a"))).toBeUndefined()
  })
})

describe("Manifest.sipHash128", () => {
  it("gives the digest Zig 0.17.1 recorded for two real files", () => {
    // From the manifests of a real build of the fixture project.
    expect(hex(Manifest.sipHash128(key, new TextEncoder().encode("alpha\n")))).toBe("6c0cba17da713563b337be02e1cc9371")
    expect(hex(Manifest.sipHash128(key, new TextEncoder().encode("pub const word = \"written\";\n"))))
      .toBe("4b00175c9d58bd7fff971e267b91de33")
  })
})

describe("Manifest.outputDigest", () => {
  it("names the output directory Zig 0.17.1 wrote for two real manifests", () => {
    // An options step: the manifest lists nothing.
    expect(Manifest.outputDigest("54522fa9d034548e4243e351b9b35e85", [])).toBe("b77d664db5222960d1531f875bc9554d")
    // A copy command: the manifest lists the one file it read.
    const inputs = Manifest.decode(file(record(0, "/x/data/words.zig.in", "4b00175c9d58bd7fff971e267b91de33")))
    expect(Manifest.outputDigest("e150ffdc4d92df7c9599590f53cd8ef8", inputs ?? [])).toBe(
      "516af202d06d7dfd678b6556fdb1fab0"
    )
  })

  it("accepts only 32 lowercase hex digits as a manifest name", () => {
    expect(Manifest.isName("54522fa9d034548e4243e351b9b35e85")).toBe(true)
    expect(Manifest.isName("timestamp")).toBe(false)
    expect(Manifest.isName("54522FA9D034548E4243E351B9B35E85")).toBe(false)
    expect(Manifest.isName("54522fa9d034548e4243e351b9b35e85.tmp")).toBe(false)
  })
})
