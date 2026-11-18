/**
 * Reads a Zig cache manifest: the list of files one cached step read.
 *
 * Zig writes a manifest per cached step to `<cache>/h/<name>`, and the step's
 * output to `<cache>/o/<digest>/`. The digest is a hash of the manifest's name
 * and of each listed file's digest, so {@link outputDigest} tells which output
 * a manifest belongs to with no guess. The layout is `Manifest.File` in Zig
 * 0.17.1's `lib/std/Build/Cache.zig`.
 *
 * @since 0.1.0
 */

/**
 * Where a manifest path starts. Zig's compiler registers these five
 * directories in this order (`Compilation.create`).
 *
 * @category models
 * @since 0.1.0
 */
export const prefixes = ["cwd", "zig-lib", "local-cache", "global-cache", "build-root"] as const

/**
 * The name of a path prefix, or `"unknown"` for an index Zig 0.17.1 never
 * writes.
 *
 * @category models
 * @since 0.1.0
 */
export type Prefix = (typeof prefixes)[number] | "unknown"

/**
 * One file or directory a step read.
 *
 * @category models
 * @since 0.1.0
 */
export interface Input {
  readonly prefix: Prefix
  readonly path: string
  readonly directory: boolean
  /** Zig's own 16-byte digest of the content. */
  readonly digest: Uint8Array
}

const recordHead = 8 + 8 + 8 + 16 + 1
const text = new TextDecoder()

/**
 * The name of prefix `index`.
 *
 * @throws {never}
 *
 * @category accessors
 * @since 0.1.0
 */
export const prefix = (index: number): Prefix => prefixes[index] ?? "unknown"

/**
 * Decodes a manifest file.
 *
 * @param bytes - The whole manifest file.
 * @returns The inputs in the order Zig listed them, or `undefined` when the
 * bytes are not a finished manifest. Zig leaves an empty file behind when a
 * step fails.
 * @throws {never}
 *
 * @category parsing
 * @since 0.1.0
 */
export const decode = (bytes: Uint8Array): ReadonlyArray<Input> | undefined => {
  const end = bytes.length - 1
  if (end < 0 || bytes[end] !== 0) return undefined
  const inputs: Array<Input> = []
  let at = 0
  while (at < end) {
    const pathStart = at + recordHead
    if (pathStart >= end) return undefined
    // The last byte is zero, so a terminator is always found.
    const pathEnd = bytes.indexOf(0, pathStart)
    if (pathEnd === pathStart) return undefined
    const flags = bytes[pathStart - 1] as number
    inputs.push({
      prefix: prefix(flags >> 2),
      path: text.decode(bytes.subarray(pathStart, pathEnd)),
      directory: (flags & 1) === 1,
      digest: bytes.slice(at + 24, at + 40)
    })
    at = pathEnd + 1
  }
  return at === end ? inputs : undefined
}

const mask = (1n << 64n) - 1n
const rotate = (value: bigint, bits: bigint): bigint => ((value << bits) | (value >> (64n - bits))) & mask

/**
 * SipHash-1-3 with a 128-bit result, the hash Zig's cache uses
 * (`std.crypto.auth.siphash.SipHash128(1, 3)`).
 *
 * @param key - 16 bytes.
 * @param data - The bytes to hash.
 * @returns 16 bytes.
 * @throws {never}
 *
 * @category hashing
 * @since 0.1.0
 */
export const sipHash128 = (key: Uint8Array, data: Uint8Array): Uint8Array => {
  const keys = new DataView(key.buffer, key.byteOffset, 16)
  const k0 = keys.getBigUint64(0, true)
  const k1 = keys.getBigUint64(8, true)
  let v0 = k0 ^ 0x736f6d6570736575n
  let v1 = k1 ^ 0x646f72616e646f6dn ^ 0xeen
  let v2 = k0 ^ 0x6c7967656e657261n
  let v3 = k1 ^ 0x7465646279746573n
  const round = (): void => {
    v0 = (v0 + v1) & mask
    v1 = rotate(v1, 13n) ^ v0
    v0 = rotate(v0, 32n)
    v2 = (v2 + v3) & mask
    v3 = rotate(v3, 16n) ^ v2
    v0 = (v0 + v3) & mask
    v3 = rotate(v3, 21n) ^ v0
    v2 = (v2 + v1) & mask
    v1 = rotate(v1, 17n) ^ v2
    v2 = rotate(v2, 32n)
  }
  const absorb = (word: bigint): void => {
    v3 ^= word
    round()
    v0 ^= word
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const whole = data.length - (data.length % 8)
  for (let at = 0; at < whole; at += 8) absorb(view.getBigUint64(at, true))
  let last = BigInt(data.length & 0xff) << 56n
  for (let at = whole; at < data.length; at += 1) last |= BigInt(data[at] as number) << BigInt(8 * (at - whole))
  absorb(last)
  const out = new Uint8Array(16)
  const result = new DataView(out.buffer)
  v2 ^= 0xeen
  round()
  round()
  round()
  result.setBigUint64(0, v0 ^ v1 ^ v2 ^ v3, true)
  v1 ^= 0xddn
  round()
  round()
  round()
  result.setBigUint64(8, v0 ^ v1 ^ v2 ^ v3, true)
  return out
}

/** `hasher_init` in Zig 0.17.1's `lib/std/Build/Cache.zig`. */
const cacheKey = Uint8Array.of(
  0x02,
  0xe9,
  0xfa,
  0xfe,
  0xe0,
  0x95,
  0x81,
  0x55,
  0xf5,
  0x5a,
  0x15,
  0xcb,
  0x4a,
  0xf4,
  0x00,
  0x09
)

const hexPattern = /^[0-9a-f]{32}$/

/**
 * True when `name` can be a manifest's file name: 32 lowercase hex digits.
 *
 * @throws {never}
 *
 * @category accessors
 * @since 0.1.0
 */
export const isName = (name: string): boolean => hexPattern.test(name)

/**
 * The name of the output directory a manifest belongs to, as Zig derives it
 * (`Manifest.finalDigest`): the hash of the manifest's name bytes followed by
 * every input's digest.
 *
 * @param name - The manifest's file name; {@link isName} must hold.
 * @param inputs - The manifest's inputs, in order.
 * @returns 32 lowercase hex digits.
 * @throws {never}
 *
 * @category hashing
 * @since 0.1.0
 */
export const outputDigest = (name: string, inputs: ReadonlyArray<Input>): string => {
  const data = new Uint8Array(16 + 16 * inputs.length)
  for (let at = 0; at < 16; at += 1) data[at] = Number.parseInt(name.slice(2 * at, 2 * at + 2), 16)
  inputs.forEach((input, index) => data.set(input.digest, 16 + 16 * index))
  return Array.from(sipHash128(cacheKey, data), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
