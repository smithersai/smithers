/**
 * SHA-256 with nothing behind it: no Effect, no Node built-in, no injected host.
 *
 * `@smthrs/rpc` is decoded by the browser, by the Cloudflare Worker and by the
 * native host, so `test/NativeAgent.test.ts` holds every module here to the
 * runtime-free entry points of the Smithers boundary. `@smthrs/crypto/Sha256`
 * is the package that owns hashing for Smithers, but reaching it from a
 * contract module pulls `effect/Crypto`, `effect/Schema` and their transitive
 * runtime into all three bundles for the sake of one synchronous digest.
 *
 * This is the same FIPS 180-4 function over the same UTF-8 encoding, so a
 * digest computed here equals the one `@smthrs/crypto` computes for the same
 * text; `test/Sha256.test.ts` pins that against `node:crypto`. Use this only
 * for the content identities these contracts carry, and use `@smthrs/crypto`
 * anywhere an Effect runtime is already present.
 *
 * @since 1.0.0
 */

/** The 64 round constants of FIPS 180-4: the cube roots of the first 64 primes. */
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2
])

/** The initial state of FIPS 180-4: the square roots of the first eight primes. */
const INITIAL_STATE = new Uint32Array([
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19
])

const HEX_DIGITS = "0123456789abcdef"
const UTF8 = new TextEncoder()

const rotateRight = (word: number, bits: number): number => ((word >>> bits) | (word << (32 - bits))) >>> 0

/**
 * Whether UTF-8 can carry this string without substituting a replacement
 * character. An unpaired surrogate would hash as U+FFFD and two different
 * drafts would share one identity, so the caller is told instead.
 */
const isWellFormed = (text: string): boolean => {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (index + 1 >= text.length || next < 0xdc00 || next > 0xdfff) return false
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

/** One 64-byte block, folded into the running state. */
const compress = (state: Uint32Array, view: DataView, offset: number, schedule: Uint32Array): void => {
  for (let index = 0; index < 16; index++) schedule[index] = view.getUint32(offset + index * 4, false)
  for (let index = 16; index < 64; index++) {
    const previous = schedule[index - 15]!
    const recent = schedule[index - 2]!
    const sigma0 = rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3)
    const sigma1 = rotateRight(recent, 17) ^ rotateRight(recent, 19) ^ (recent >>> 10)
    schedule[index] = (schedule[index - 16]! + sigma0 + schedule[index - 7]! + sigma1) >>> 0
  }

  let a = state[0]!
  let b = state[1]!
  let c = state[2]!
  let d = state[3]!
  let e = state[4]!
  let f = state[5]!
  let g = state[6]!
  let h = state[7]!
  for (let index = 0; index < 64; index++) {
    const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
    const choose = (e & f) ^ (~e & g)
    const temporary1 = (h + sigma1 + choose + ROUND_CONSTANTS[index]! + schedule[index]!) >>> 0
    const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
    const majority = (a & b) ^ (a & c) ^ (b & c)
    const temporary2 = (sigma0 + majority) >>> 0
    h = g
    g = f
    f = e
    e = (d + temporary1) >>> 0
    d = c
    c = b
    b = a
    a = (temporary1 + temporary2) >>> 0
  }
  state[0] = (state[0]! + a) >>> 0
  state[1] = (state[1]! + b) >>> 0
  state[2] = (state[2]! + c) >>> 0
  state[3] = (state[3]! + d) >>> 0
  state[4] = (state[4]! + e) >>> 0
  state[5] = (state[5]! + f) >>> 0
  state[6] = (state[6]! + g) >>> 0
  state[7] = (state[7]! + h) >>> 0
}

/** The 32 digest bytes of a byte message, padded as FIPS 180-4 states. */
const sha256 = (message: Uint8Array): Uint8Array => {
  const blocks = Math.floor((message.length + 8) / 64) + 1
  const padded = new Uint8Array(blocks * 64)
  padded.set(message)
  padded[message.length] = 0x80
  const view = new DataView(padded.buffer)
  // The length is a 64-bit big-endian bit count; JavaScript splits it in two.
  view.setUint32(padded.length - 8, Math.floor(message.length / 0x20000000), false)
  view.setUint32(padded.length - 4, (message.length << 3) >>> 0, false)

  const state = INITIAL_STATE.slice()
  const schedule = new Uint32Array(64)
  for (let block = 0; block < blocks; block++) compress(state, view, block * 64, schedule)

  const digest = new Uint8Array(32)
  const digestView = new DataView(digest.buffer)
  for (let word = 0; word < 8; word++) digestView.setUint32(word * 4, state[word]!, false)
  return digest
}

/**
 * The SHA-256 of well-formed UTF-8 text, as 64 lowercase hexadecimal characters.
 *
 * Throws a `TypeError` when the text carries an unpaired UTF-16 surrogate,
 * which UTF-8 cannot represent.
 *
 * @since 1.0.0
 * @category conversions
 */
export const digestSync = (text: string): string => {
  if (!isWellFormed(text)) throw new TypeError("SHA-256 text input contains an unpaired UTF-16 surrogate")
  const bytes = sha256(UTF8.encode(text))
  let output = ""
  for (const byte of bytes) output += `${HEX_DIGITS[byte >>> 4]}${HEX_DIGITS[byte & 0x0f]}`
  return output
}
