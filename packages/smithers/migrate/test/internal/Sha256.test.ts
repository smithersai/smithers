/**
 * The checks' SHA-256 gives the digest `node:crypto` gives.
 *
 * A checkpoint records run-state digests with `node:crypto` (`flow/Checkpoint.ts`)
 * and `Checks.run` compares them with this implementation, so any difference
 * reports untouched run state as rewritten.
 */
import { describe, expect, it } from "@effect/vitest"
import { createHash } from "node:crypto"
import * as Sha256 from "../../src/internal/Sha256.ts"

const node = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

describe("Sha256.hex", () => {
  it("gives the FIPS 180-4 digests of the empty message and of abc", () => {
    expect(Sha256.hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(Sha256.hex(utf8("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })

  it("gives the FIPS 180-4 digest of a message that spans two blocks", () => {
    const message = utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")
    expect(message.length).toBe(56)
    expect(Sha256.hex(message)).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
  })

  it("gives the digest of a message longer than one block", () => {
    const message = utf8("a".repeat(1_000))
    expect(Sha256.hex(message)).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3")
    expect(Sha256.hex(message)).toBe(node(message))
  })

  it("hashes the UTF-8 bytes of multibyte text", () => {
    const message = utf8("héllo, 世界 🌍")
    expect(Sha256.hex(message)).toBe(node(message))
    expect(Sha256.hex(message)).not.toBe(Sha256.hex(utf8("hello, 世界 🌍")))
  })

  it("matches node:crypto at every length around the padding boundaries", () => {
    // 55 bytes is the last length whose padding fits one block; 56 to 64 need a second.
    for (let length = 0; length <= 200; length++) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 131 + length * 17) & 0xff)
      expect(Sha256.hex(bytes), `length ${length}`).toBe(node(bytes))
    }
  })

  it("keeps leading zeros in every word and reads a view at its own offset", () => {
    // Its digest starts 00: an unpadded word would shorten it.
    const zeroLed = utf8("286")
    expect(node(zeroLed).startsWith("00")).toBe(true)
    expect(Sha256.hex(zeroLed)).toBe(node(zeroLed))
    const backing = Uint8Array.from({ length: 300 }, (_, index) => index & 0xff)
    const view = backing.subarray(37, 37 + 150)
    expect(Sha256.hex(view)).toBe(node(view))
  })
})
