/**
 * FIPS 180-4 SHA-256 for the package's explicit synchronous entry point.
 *
 * This module owns the only handwritten SHA-256 implementation in Smithers.
 * It accepts an immutable byte snapshot and returns a fresh 32-byte digest.
 * Public input policy and hexadecimal representation live in `Sha256.ts`.
 *
 * @since 1.0.0
 * @private
 */

const rounds = new Uint32Array([
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

const initial = new Uint32Array([
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19
])

const rotateRight = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))

const compress = (hash: Uint32Array, view: DataView, offset: number, schedule: Uint32Array): void => {
  for (let index = 0; index < 16; index++) schedule[index] = view.getUint32(offset + index * 4, false)
  for (let index = 16; index < 64; index++) {
    const previous = schedule[index - 15]!
    const recent = schedule[index - 2]!
    const sigma0 = rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3)
    const sigma1 = rotateRight(recent, 17) ^ rotateRight(recent, 19) ^ (recent >>> 10)
    schedule[index] = (schedule[index - 16]! + sigma0 + schedule[index - 7]! + sigma1) >>> 0
  }

  let a = hash[0]!
  let b = hash[1]!
  let c = hash[2]!
  let d = hash[3]!
  let e = hash[4]!
  let f = hash[5]!
  let g = hash[6]!
  let h = hash[7]!
  for (let index = 0; index < 64; index++) {
    const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
    const choose = (e & f) ^ (~e & g)
    const temporary1 = (h + sigma1 + choose + rounds[index]! + schedule[index]!) >>> 0
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
  hash[0] = (hash[0]! + a) >>> 0
  hash[1] = (hash[1]! + b) >>> 0
  hash[2] = (hash[2]! + c) >>> 0
  hash[3] = (hash[3]! + d) >>> 0
  hash[4] = (hash[4]! + e) >>> 0
  hash[5] = (hash[5]! + f) >>> 0
  hash[6] = (hash[6]! + g) >>> 0
  hash[7] = (hash[7]! + h) >>> 0
}

/**
 * Returns a fresh 32-byte SHA-256 digest.
 *
 * @since 1.0.0
 * @private
 */
export const sha256 = (message: Uint8Array): Uint8Array => {
  const blocks = Math.floor((message.length + 8) / 64) + 1
  const padded = new Uint8Array(blocks * 64)
  padded.set(message)
  padded[message.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(message.length / 0x20000000), false)
  view.setUint32(padded.length - 4, (message.length << 3) >>> 0, false)

  const hash = initial.slice()
  const schedule = new Uint32Array(64)
  for (let block = 0; block < blocks; block++) {
    const offset = block * 64
    compress(hash, view, offset, schedule)
  }

  const digest = new Uint8Array(32)
  const digestView = new DataView(digest.buffer)
  for (let word = 0; word < 8; word++) digestView.setUint32(word * 4, hash[word]!, false)
  return digest
}

/**
 * Cloneable prefix state; the same compression routine as the one-shot digest.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export class Sha256Prefix {
  private hash = initial.slice()
  private tail = new Uint8Array(0)
  private length = 0
  clone(): Sha256Prefix {
    const copy = new Sha256Prefix()
    copy.hash = this.hash.slice()
    copy.tail = this.tail.slice()
    copy.length = this.length
    return copy
  }
  update(bytes: Uint8Array): this {
    this.length += bytes.length
    const data = new Uint8Array(this.tail.length + bytes.length)
    data.set(this.tail)
    data.set(bytes, this.tail.length)
    const complete = data.length - data.length % 64
    const view = new DataView(data.buffer), schedule = new Uint32Array(64)
    for (let offset = 0; offset < complete; offset += 64) compress(this.hash, view, offset, schedule)
    this.tail = data.slice(complete)
    return this
  }
  finish(): Uint8Array {
    const copy = this.clone(), padding = new Uint8Array((this.tail.length < 56 ? 64 : 128) - this.tail.length)
    padding[0] = 0x80
    const view = new DataView(padding.buffer)
    view.setUint32(padding.length - 8, Math.floor(this.length / 0x20000000), false)
    view.setUint32(padding.length - 4, (this.length << 3) >>> 0, false)
    copy.update(padding)
    const result = new Uint8Array(32), output = new DataView(result.buffer)
    for (let word = 0; word < 8; word++) output.setUint32(word * 4, copy.hash[word]!, false)
    return result
  }
}
