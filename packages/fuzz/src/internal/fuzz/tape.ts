import * as Base64Url from "effect/encoding/Base64Url"
import type * as Model from "../arbitrary/model.ts"

/** @internal */
export function mix32(value: number): number {
  // MurmurHash3 fmix32 by Austin Appleby, dedicated to the public domain.
  value ^= value >>> 16
  value = Math.imul(value, 0x85ebca6b)
  value ^= value >>> 13
  value = Math.imul(value, 0xc2b2ae35)
  return (value ^ value >>> 16) >>> 0
}

/** @internal */
export function hashString(text: string, salt: number): number {
  let hash = 0x811c9dc5 ^ salt
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
  }
  return mix32(hash ^ text.length)
}

/** @internal */
export function hashHex(text: string): string {
  return hashString(text, 1).toString(16).padStart(8, "0") + hashString(text, 2).toString(16).padStart(8, "0")
}

/**
 * The word a tape returns past its explicit prefix. It is a pure function of position, so clones that read past the end
 * in any order agree, and a stored tape plus its key reproduces every lazy shrink pull.
 *
 * @internal
 */
export function filler(key: number, position: number): number {
  return mix32(key ^ Math.imul(position + 1, 0x9e3779b9))
}

/** @internal */
export interface Used {
  max: number
}

/**
 * A `GenerationRandom` that reads a fixed word tape. Clones are cursors over the same immutable words, so `flatMap`
 * checkpoints replay the same choices. The snapshot is `[cursor, 0, 0, 0]`, which fits the existing internal type.
 *
 * @internal
 */
export function makeTapeRandom(
  words: ReadonlyArray<number>,
  key: number,
  used: Used,
  start: number
): Model.GenerationRandom {
  let cursor = start
  const nextUint32 = () => {
    const position = cursor++
    if (cursor > used.max) used.max = cursor
    return position < words.length ? words[position] : filler(key, position)
  }
  return {
    nextUint32,
    // The same two-word construction as the seeded generation random.
    nextDoubleUnsafe: () => {
      const high = nextUint32() >>> 5
      const low = nextUint32() >>> 6
      return (high * 0x4000000 + low) / 0x20000000000000
    },
    clone: () => makeTapeRandom(words, key, used, cursor),
    copyFrom: (source) => {
      cursor = source.snapshot()[0]
    },
    snapshot: () => [cursor, 0, 0, 0]
  }
}

/** @internal */
export function materialize(words: ReadonlyArray<number>, key: number, length: number): Array<number> {
  const out = new Array<number>(length)
  for (let index = 0; index < length; index++) out[index] = index < words.length ? words[index] : filler(key, index)
  return out
}

/** @internal */
export interface Rng {
  readonly next: () => number
  readonly below: (bound: number) => number
}

function rotateLeft(value: number, shift: number): number {
  return (value << shift | value >>> (32 - shift)) >>> 0
}

/**
 * The coordinator random: it chooses parents, mutations and positions, and never feeds generation directly.
 *
 * @internal
 */
export function makeRng(seed: string | number): Rng {
  const text = `${typeof seed}:${seed}`
  // The low bit keeps the xoshiro state nonzero.
  let state0 = hashString(text, 3) | 1
  let state1 = hashString(text, 4)
  let state2 = hashString(text, 5)
  let state3 = hashString(text, 6)
  // xoshiro128** 1.1 by David Blackman and Sebastiano Vigna, dedicated to the public domain.
  const next = () => {
    const result = Math.imul(rotateLeft(Math.imul(state1, 5), 7), 9) >>> 0
    const temporary = state1 << 9
    state2 ^= state0
    state3 ^= state1
    state1 ^= state2
    state0 ^= state3
    state2 ^= temporary
    state3 = rotateLeft(state3, 11)
    return result
  }
  return { next, below: (bound) => Math.floor(next() / 0x100000000 * bound) }
}

/** @internal */
export function encodeWords(words: ReadonlyArray<number>): string {
  const bytes = new Uint8Array(words.length * 4)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < words.length; index++) view.setUint32(index * 4, words[index], true)
  return Base64Url.encode(bytes)
}

/** @internal */
export function decodeWords(text: string): Array<number> {
  const decoded = Base64Url.decode(text)
  if (decoded._tag === "Failure" || decoded.success.length % 4 !== 0) throw new Error(`invalid tape "${text}"`)
  const bytes = decoded.success
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Array<number>(bytes.length / 4)
  for (let index = 0; index < out.length; index++) out[index] = view.getUint32(index * 4, true)
  return out
}


/** Replaces a mutation's tail, including a full corpus tape. @internal */
export function spliceTail(tape: Array<number>, at: number, tail: ReadonlyArray<number>): void {
  tape.splice(at, tape.length - at)
  for (const word of tail) tape.push(word)
}
