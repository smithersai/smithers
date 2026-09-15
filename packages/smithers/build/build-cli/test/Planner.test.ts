/**
 * Cache-key encoding and implementation identity.
 *
 * The planner's content key is what the local and remote caches address on, so
 * two properties are correctness properties rather than niceties:
 *
 * 1. It is INJECTIVE. Two different pieces of key material must never hash to
 *    one key, or one action answers for another.
 * 2. It is HOST STABLE. Two machines with the same sources and the same tree
 *    must agree on the key, or they cannot share a cache.
 */
import * as SafeFs from "@smthrs/targets/SafeFs"
import * as Target from "@smthrs/targets/Target"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  encodeKeyMaterial,
  EXECUTION_FORMAT,
  fingerprintSources,
  implementationFingerprint,
  type KeyMaterial,
  KeyMaterialError,
  keyOf,
  maximumSourceFileBytes,
  productionSourceRoots,
  targetKeyBody
} from "../src/Planner.ts"

const material = (body: unknown): KeyMaterial => ({ body, inputs: null, layers: [], capabilities: [] })

type RandomValue =
  | undefined
  | null
  | boolean
  | number
  | string
  | Array<RandomValue>
  | { readonly [key: string]: RandomValue }

/** Advances one deterministic 32-bit linear congruential generator state. */
const nextRandom = (state: number): number => (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0

/** Compares generated plain data without consulting the key encoder. */
const sameValue = (left: RandomValue, right: RandomValue): boolean => {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameValue(value, right[index]))
  }
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
}

const temporaries: Array<string> = []

const scratch = async (): Promise<string> => {
  const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-fingerprint-"))
  temporaries.push(directory)
  return directory
}

/** Copies one source tree, so a test can mutate a copy of the real thing. */
const copyTree = async (from: string, to: string): Promise<void> => {
  await Fs.cp(from, to, { recursive: true, dereference: false })
}

afterEach(async () => {
  for (const directory of temporaries.splice(0)) {
    await Fs.rm(directory, { recursive: true, force: true })
  }
})

describe("keyOf", () => {
  /**
   * This wire-format golden pins the bytes that address every stored local and
   * remote cache entry. A tagging change invalidates that cache, so it must be
   * a deliberate edit to this literal and never a silent refactor.
   */
  it("pins every encodable form in one golden vector", () => {
    const golden: KeyMaterial = {
      body: {
        text: "é😀",
        zero: 0,
        negativeZero: -0,
        negative: -17,
        fractional: 1.25,
        truth: true,
        falsehood: false,
        nullable: null,
        undefinedMember: undefined,
        emptyArray: [],
        nestedArray: [1, ["inner", null]],
        emptyObject: {},
        nestedObject: { child: { value: "leaf" } },
        Z: "code-unit first",
        a: "locale first"
      },
      layers: ["layer:base", "layer:runtime"],
      capabilities: ["fs:read", "process:spawn"],
      inputs: { source: "src/input.ts", flags: [true, undefined] }
    }

    expect(encodeKeyMaterial(golden)).toBe(
      "smithers-build-key/1\u0000o4:s4:bodyo15:s1:Zs15:code-unit firsts1:as12:locale firsts10:emptyArraya0:s11:emptyObjecto0:s9:falsehoodfs10:fractionald1.25;s8:negatived-17;s12:negativeZerod-0;s11:nestedArraya2:d1;a2:s5:innerns12:nestedObjecto1:s5:childo1:s5:values4:leafs8:nullablens4:texts3:é😀s5:truthts15:undefinedMemberus4:zerod0;s12:capabilitiesa2:s7:fs:reads13:process:spawns6:inputso2:s5:flagsa2:tus6:sources12:src/input.tss6:layersa2:s10:layer:bases13:layer:runtime"
    )
    expect(keyOf(golden)).toBe("d0c04dc0dad69b4aa998bf992c47a6f1a89d726567d5db243a626d0495a342ee")
  })

  it("pins the execution cache format number", () => {
    // The number is part of every cache address. Bumping it declares a format
    // change, so this assertion forces that bump to be intentional.
    expect(EXECUTION_FORMAT).toBe(5)
  })

  it("hashes object keys in code-unit order, independent of the host locale", () => {
    // `localeCompare` answers differently under different host locales and ICU
    // versions: in an English locale `a` sorts before `Z`, by code unit `Z`
    // (0x5A) sorts before `a` (0x61). Equal material used to hash to different
    // keys on different machines.
    expect(encodeKeyMaterial(material({ a: 1, Z: 2 }))).toContain("s1:Zd2;s1:ad1;")
    expect(keyOf(material({ a: 1, Z: 2 }))).toBe(keyOf(material({ Z: 2, a: 1 })))
  })

  it("hashes equal material identically regardless of declaration order", () => {
    expect(keyOf({ body: { a: 1, Z: 2 }, inputs: null, layers: [], capabilities: [] }))
      .toBe(keyOf({ inputs: null, capabilities: [], layers: [], body: { Z: 2, a: 1 } }))
  })

  it("hashes the documented encoding, not a JSON rendering", () => {
    expect(keyOf(material(null))).toBe(
      createHash("sha256")
        .update("smithers-build-key/1\u0000o4:s4:bodyns12:capabilitiesa0:s6:inputsns6:layersa0:", "utf8")
        .digest("hex")
    )
  })

  /**
   * Every pair here collapsed to one key under `JSON.stringify` of the old
   * canonical form, or under the sentinel strings it substituted. Each is a
   * real confusion: a target attr that is the string `"1"` is not the number 1,
   * and an attr that literally holds `"@smthrs:undefined@"` is not an absent
   * one.
   */
  it.each([
    ["a number and its decimal string", 1, "1"],
    ["true and its string", true, "true"],
    ["null and its string", null, "null"],
    ["null and undefined", null, undefined],
    ["undefined and the old undefined sentinel", undefined, "@smthrs:undefined@"],
    ["an empty array and an empty object", [], {}],
    ["zero and negative zero", 0, -0],
    ["a nested array and its flattening", [["a"], ["b"]], [["a", "b"]]],
    ["two string splits", ["ab", "c"], ["a", "bc"]],
    ["an absent member and an undefined one", {}, { value: undefined }],
    ["an object and an array of its entries", { 0: "a" }, ["a"]]
  ])("keeps %s distinct", (_name, left, right) => {
    expect(keyOf(material(left))).not.toBe(keyOf(material(right)))
  })

  it("keeps a value that legitimately appears twice from reading as a cycle", () => {
    const shared = { path: "src/index.ts" }
    expect(() => keyOf(material({ first: shared, second: shared }))).not.toThrow()
    expect(keyOf(material({ first: shared, second: shared })))
      .toBe(keyOf(material({ first: { path: "src/index.ts" }, second: { path: "src/index.ts" } })))
  })

  /**
   * Fail closed. Every one of these used to hash to something: a cycle became
   * the string `"<cycle>"`, `NaN` and `Infinity` became `null`, and a class
   * instance became whatever its enumerable properties happened to be. A key
   * that two different actions can share is worse than no key at all, so the
   * plan fails instead.
   */
  it.each([
    ["a cycle", () => {
      const cyclic: Record<string, unknown> = {}
      cyclic["self"] = cyclic
      return cyclic
    }],
    ["NaN", () => ({ value: Number.NaN })],
    ["Infinity", () => ({ value: Number.POSITIVE_INFINITY })],
    ["a bigint", () => ({ value: 1n })],
    ["a symbol", () => ({ value: Symbol("s") })],
    ["a function", () => ({ value: () => 1 })],
    ["a Date", () => ({ value: new Date(0) })],
    ["a Map", () => ({ value: new Map() })],
    ["a class instance", () => ({
      value: new (class Holder {
        readonly a = 1
      })()
    })],
    ["a null-prototype value nested under an accessor", () => {
      const holder = {}
      Object.defineProperty(holder, "value", { get: () => 1, enumerable: true, configurable: true })
      return holder
    }],
    ["a sparse array", () => ({ value: [1, , 3] })],
    ["an array with an extra own property", () => {
      const list = [1]
      Object.assign(list, { extra: 2 })
      return list
    }],
    ["an array accessor", () => {
      const list = [1]
      Object.defineProperty(list, "0", { get: () => 1, enumerable: true, configurable: true })
      return list
    }],
    ["a sparse array whose extra property hides the hole by count", () => {
      const list = [1, 2]
      delete list[0]
      Object.assign(list, { extra: 3 })
      return list
    }],
    ["a symbol-keyed own property", () => ({ [Symbol.for("smthrs/test")]: 1 })],
    ["a non-enumerable own property", () => {
      const holder = { visible: 1 }
      Object.defineProperty(holder, "hidden", { value: 2, enumerable: false })
      return holder
    }],
    ["a Proxy", () => new Proxy({ value: 1 }, {})],
    ["an unpaired high surrogate", () => "\uD800"],
    ["an unpaired low surrogate", () => "\uDC00"],
    ["an unpaired surrogate in an object key", () => ({ ["\uD800"]: 1 })]
  ])("refuses %s", (_name, build) => {
    expect(() => keyOf(material(build()))).toThrow(KeyMaterialError)
  })

  it("accepts a null-prototype object as a plain one", () => {
    const holder = Object.create(null) as Record<string, unknown>
    holder["a"] = 1
    expect(keyOf(material(holder))).toBe(keyOf(material({ a: 1 })))
  })

  /**
   * This property uses a hand-written structural oracle because comparing the
   * encoder against itself would prove nothing. The oracle checks both that one
   * encoding never groups different values and that equal values never split
   * across encodings.
   */
  it("is injective across a deterministic generated corpus", () => {
    let state = 0x5eed_c0de
    const randomInt = (limit: number): number => {
      state = nextRandom(state)
      return state % limit
    }
    const stringAlphabet = ["a", "Z", "0", "é", "😀"]
    const objectKeys = ["a", "b", "c", "Z", "x", "y"]
    const randomString = (): string => {
      const length = randomInt(7)
      return Array.from({ length }, () => stringAlphabet[randomInt(stringAlphabet.length)]).join("")
    }
    const randomValue = (depth: number): RandomValue => {
      const form = randomInt(depth === 4 ? 5 : 7)
      switch (form) {
        case 0:
          return undefined
        case 1:
          return null
        case 2:
          return randomInt(2) === 0
        case 3:
          return randomInt(129) - 64
        case 4:
          return randomString()
        case 5:
          return Array.from({ length: randomInt(7) }, () => randomValue(depth + 1))
        default: {
          const value: Record<string, RandomValue> = {}
          const members = randomInt(7)
          for (let index = 0; index < members; index += 1) {
            value[objectKeys[randomInt(objectKeys.length)]!] = randomValue(depth + 1)
          }
          return value
        }
      }
    }

    const corpus = Array.from({ length: 8_192 }, () => randomValue(0))
    const groups = new Map<string, Array<RandomValue>>()
    for (const value of corpus) {
      const encoding = encodeKeyMaterial(material(value))
      const group = groups.get(encoding)
      if (group === undefined) groups.set(encoding, [value])
      else group.push(value)
    }

    expect(groups.size).toBeGreaterThanOrEqual(1_500)
    let collision: { readonly encoding: string; readonly left: RandomValue; readonly right: RandomValue } | undefined
    for (const [encoding, group] of groups) {
      const first = group[0]!
      const different = group.findIndex((value) => !sameValue(first, value))
      if (different !== -1) {
        collision = { encoding, left: first, right: group[different]! }
        break
      }
    }
    expect(collision).toBeUndefined()

    const representatives = [...groups.entries()].map(([encoding, values]) => ({ encoding, value: values[0]! }))
    let split: { readonly left: string; readonly right: string } | undefined
    findSplit: for (let left = 0; left < representatives.length; left += 1) {
      for (let right = left + 1; right < representatives.length; right += 1) {
        if (sameValue(representatives[left]!.value, representatives[right]!.value)) {
          split = { left: representatives[left]!.encoding, right: representatives[right]!.encoding }
          break findSplit
        }
      }
    }
    expect(split).toBeUndefined()
  })
})

describe("implementationFingerprint", () => {
  it("digests the production source trees", async () => {
    await expect(implementationFingerprint()).resolves.toMatch(/^[0-9a-f]{64}$/)
  })

  /**
   * The regression this closes: `Target.make` digests only `String(implementation)`,
   * the text of the function a target declaration passes it. Every helper that
   * function calls, every action layer that implements the nodes it plans, and
   * the executor's own admission logic are invisible to it. Editing
   * `measureOutput` therefore left every stored entry addressable under an
   * unchanged key, and the next run answered from results the old
   * implementation produced. Nothing about attrs, the lockfile, or the
   * function text changes below — only a helper's bytes.
   */
  it("changes when a helper source changes, with no salt to remember", async () => {
    const roots = productionSourceRoots()
    const copies = await scratch()
    for (const root of roots) {
      await copyTree(root.directory, NodePath.join(copies, root.name)).catch(() => undefined)
    }
    const copied = roots.map((root) => ({ name: root.name, directory: NodePath.join(copies, root.name) }))

    // A faithful copy at a different absolute path fingerprints identically:
    // only logical names and bytes are digested, so two checkouts share a cache.
    const before = await fingerprintSources(copied)
    expect(before).toBe(await implementationFingerprint())

    const helper = NodePath.join(copies, "targets/Input.ts")
    const source = await Fs.readFile(helper, "utf8")
    await Fs.writeFile(helper, `${source}\n// one changed byte of a helper\n`, "utf8")

    expect(await fingerprintSources(copied)).not.toBe(before)
  })

  it("distinguishes an absent tree from an empty one", async () => {
    const present = await scratch()
    await Fs.mkdir(NodePath.join(present, "empty"), { recursive: true })
    const absent = await fingerprintSources([{ name: "x", directory: NodePath.join(present, "missing") }])
    const empty = await fingerprintSources([{ name: "x", directory: NodePath.join(present, "empty") }])
    expect(absent).not.toBe(empty)
  })

  it("digests file bytes, not names alone", async () => {
    const directory = await scratch()
    await Fs.writeFile(NodePath.join(directory, "a.ts"), "export const a = 1\n", "utf8")
    const before = await fingerprintSources([{ name: "x", directory }])
    await Fs.writeFile(NodePath.join(directory, "a.ts"), "export const a = 2\n", "utf8")
    expect(await fingerprintSources([{ name: "x", directory }])).not.toBe(before)
  })

  it("reports the first source failure even when a later concurrent read fails first", async () => {
    const directory = await scratch()
    await Fs.writeFile(NodePath.join(directory, "a.ts"), "a", "utf8")
    await Fs.writeFile(NodePath.join(directory, "b.ts"), "b", "utf8")
    const later = Promise.withResolvers<void>()
    const first = new Error("first source")
    const digest = vi.spyOn(SafeFs, "digestEntry")
      .mockImplementationOnce(async () => {
        await later.promise
        throw first
      })
      .mockImplementationOnce(async () => {
        later.resolve()
        throw new Error("later source")
      })
    try {
      await expect(fingerprintSources([{ name: "x", directory }])).rejects.toBe(first)
      expect(digest).toHaveBeenCalledTimes(2)
    } finally {
      digest.mockRestore()
    }
  })

  it("refuses an implementation source file over the scan ceiling", async () => {
    const directory = await scratch()
    const source = NodePath.join(directory, "oversized.ts")
    await Fs.writeFile(source, "x", "utf8")
    await Fs.truncate(source, maximumSourceFileBytes + 1)
    await expect(fingerprintSources([{ name: "x", directory }]))
      .rejects.toThrow(/implementation source file is larger/)
  })

  it("rejects a source root over its cumulative ceiling before reading source bytes", async () => {
    const directory = await scratch()
    // Sparse files give the inspection pass real, adversarial file metadata
    // without allocating 512 MiB. The spy makes the proof about reads rather
    // than timing: no digest may start once the cumulative admission fails.
    for (let index = 0; index <= 32; index += 1) {
      const source = NodePath.join(directory, `${String(index).padStart(3, "0")}.ts`)
      await Fs.writeFile(source, "x", "utf8")
      await Fs.truncate(source, maximumSourceFileBytes)
    }
    const digest = vi.spyOn(SafeFs, "digestEntry")
    try {
      await expect(fingerprintSources([{ name: "x", directory }]))
        .rejects.toThrow(/implementation source root exceeds/)
      expect(digest).not.toHaveBeenCalled()
    } finally {
      digest.mockRestore()
    }
  })

  it("rejects aggregate source bytes across roots before hashing any root", async () => {
    const roots = await Promise.all([scratch(), scratch(), scratch()])
    for (const directory of roots) {
      for (let index = 0; index < 22; index += 1) {
        const source = NodePath.join(directory, `${String(index).padStart(3, "0")}.ts`)
        await Fs.writeFile(source, "x", "utf8")
        await Fs.truncate(source, maximumSourceFileBytes)
      }
    }
    const digest = vi.spyOn(SafeFs, "digestEntry")
    try {
      await expect(fingerprintSources(roots.map((directory, index) => ({ name: `x${index}`, directory }))))
        .rejects.toThrow(/implementation sources exceed/)
      expect(digest).not.toHaveBeenCalled()
    } finally {
      digest.mockRestore()
    }
  })

  it("rejects a source that grows after admission before hashing it", async () => {
    const directory = await scratch()
    const source = NodePath.join(directory, "admitted.ts")
    await Fs.writeFile(source, "export const admitted = 1\n", "utf8")
    const digestEntry = SafeFs.digestEntry
    const digest = vi.spyOn(SafeFs, "digestEntry").mockImplementationOnce(async (entry, options) => {
      await Fs.appendFile(source, "// grew after admission\n", "utf8")
      return digestEntry(entry, options)
    })
    try {
      await expect(fingerprintSources([{ name: "x", directory }]))
        .rejects.toThrow(/changed while it was being opened/)
    } finally {
      digest.mockRestore()
    }
  })

  it.skipIf(process.platform === "win32")("does not follow symbolic links in a source tree", async () => {
    const directory = await scratch()
    const outside = await scratch()
    await Fs.writeFile(NodePath.join(outside, "secret.ts"), "export const secret = 1\n", "utf8")
    await Fs.symlink(NodePath.join(outside, "secret.ts"), NodePath.join(directory, "linked.ts"))

    const linked = await fingerprintSources([{ name: "x", directory }])
    await Fs.unlink(NodePath.join(directory, "linked.ts"))
    expect(linked).toBe(await fingerprintSources([{ name: "x", directory }]))
  })

  it("refuses a filename that may be the lossy decoding of invalid host bytes", async () => {
    const directory = await scratch()
    await Fs.writeFile(NodePath.join(directory, "bad\ufffd.ts"), "export const value = 1\n", "utf8")
    await expect(fingerprintSources([{ name: "x", directory }]))
      .rejects.toThrow(/invalid entry name/)
  })

  it("honors cancellation before walking source trees", async () => {
    const controller = new AbortController()
    controller.abort(new Error("fingerprint cancelled"))
    await expect(fingerprintSources([{ name: "x", directory: await scratch() }], {
      signal: controller.signal
    })).rejects.toThrow("fingerprint cancelled")
  })
})

describe("targetKeyBody", () => {
  it("omits the process-local Target.make implementation digest", () => {
    // Two implementations with different source text, so their digests differ
    // for a real reason (the digest is keyed on function source since the
    // process nonce was removed); the key body must still be identical.
    const first = Target.make("PlannerImplementationIdentity", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      implementation: () => Target.notImplemented("PlannerImplementationIdentity:first")
    })({})
    const second = Target.make("PlannerImplementationIdentity", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      implementation: () => Target.notImplemented("PlannerImplementationIdentity:second")
    })({})
    const firstMetadata = Target.metadata(first)
    const secondMetadata = Target.metadata(second)

    expect(firstMetadata.implementationDigest).not.toBe(secondMetadata.implementationDigest)
    expect(targetKeyBody(first, firstMetadata, undefined))
      .toEqual(targetKeyBody(second, secondMetadata, undefined))
    expect(targetKeyBody(first, firstMetadata, undefined)).not.toHaveProperty("implementation")
  })
})
