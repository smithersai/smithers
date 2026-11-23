import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Schema, Stream } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import { describe, expect, it } from "vitest"
import {
  Digest,
  digest,
  digestStream,
  digestSync,
  Identity,
  makeDigestPartsSync,
  Sha256,
  Sha256Error,
  syncCrypto,
  Uuid,
  WebCrypto
} from "../src/index.ts"
import { makeSnapshotSync } from "../src/internal/snapshot.ts"
import { sourceShape } from "../src/internal/sourceShape.ts"

const isWellFormed = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1500" : "200"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

type InertValue = null | boolean | number | string | ReadonlyArray<InertValue> | { readonly [k: string]: InertValue }

const buildInert = (
  spec: {
    readonly kind: number
    readonly num: number
    readonly bool: boolean
    readonly str: string
    readonly keys: ReadonlyArray<string>
    readonly depth: number
  },
  seedIdx = 0
): InertValue => {
  if (spec.depth <= 0) {
    const k = Math.abs(spec.kind + seedIdx) % 5
    if (k === 0) return null
    if (k === 1) return spec.bool
    if (k === 2) return Number.isFinite(spec.num) ? spec.num : 0
    if (k === 3) return -0
    return isWellFormed(spec.str) ? spec.str : "ok"
  }
  const branch = Math.abs(spec.kind + seedIdx) % 3
  if (branch === 0) {
    const len = (Math.abs(spec.kind) % 3) + 1
    const arr: Array<InertValue> = []
    for (let i = 0; i < len; i++) {
      arr.push(buildInert({ ...spec, depth: spec.depth - 1 }, seedIdx + i + 1))
    }
    return arr
  }
  if (branch === 1) {
    const obj: Record<string, InertValue> = {}
    const ks = spec.keys.slice(0, 3).map((k, i) => (isWellFormed(k) && k !== "__proto__" ? k : `k${i}`))
    for (let i = 0; i < ks.length; i++) {
      obj[ks[i]!] = buildInert({ ...spec, depth: spec.depth - 1 }, seedIdx + i + 2)
    }
    return obj
  }
  return buildInert({ ...spec, depth: 0 }, seedIdx + 3)
}

const permuteKeys = (val: InertValue): InertValue => {
  if (val === null || typeof val !== "object") return val
  if (Array.isArray(val)) return val.map(permuteKeys)
  const keys = Object.keys(val).reverse()
  const out: Record<string, InertValue> = {}
  for (const k of keys) out[k] = permuteKeys((val as Record<string, InertValue>)[k]!)
  return out
}

describe("@smthrs/crypto fuzz invariants", () => {
  it("digestSync, WebCrypto digest, syncCrypto, Sha256 schema, and chunked digestStream agree byte-for-byte", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        bytes: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
        chunkSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
        text: Schema.String
      })
    )
    const decodeSha256 = Schema.decodeUnknownEffect(Sha256)
    const encodeSha256 = Schema.encodeUnknownEffect(Sha256)
    const decodeDigest = Schema.decodeUnknownSync(Digest)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ bytes, chunkSize, text }) =>
          Effect.gen(function*() {
            const payload = new Uint8Array(bytes.slice(0, 256))
            const syncHash = digestSync(payload)
            const asyncHash = yield* digest(payload)
            if (syncHash !== asyncHash) return false
            if (decodeDigest(syncHash) !== syncHash) return false

            const schemaHash = yield* decodeSha256(payload)
            if (schemaHash !== syncHash) return false

            const encodeRes = yield* Effect.result(encodeSha256(syncHash))
            if (encodeRes._tag !== "Failure") return false

            const syncServiceHex = yield* syncCrypto.digestHex(EffectDigest.sha256, payload)
            if (syncServiceHex !== syncHash) return false

            const badAlgoExit = yield* Effect.exit(syncCrypto.digest(EffectDigest.sha1, payload))
            if (badAlgoExit._tag !== "Failure") return false

            const chunks: Array<Uint8Array> = []
            for (let i = 0; i < payload.length; i += chunkSize) {
              chunks.push(payload.subarray(i, i + chunkSize))
            }
            const streamHash = yield* digestStream(Stream.fromIterable(chunks))
            if (streamHash !== syncHash) return false

            if (isWellFormed(text)) {
              const strSync = digestSync(text)
              const strAsync = yield* digest(text)
              const strSchema = yield* decodeSha256(text)
              if (strSync !== strAsync || strSync !== strSchema) return false
            } else {
              const errRes = yield* Effect.result(digest(text))
              if (errRes._tag !== "Failure" || errRes.failure.code !== "invalid_text") return false
              const schemaErr = yield* Effect.result(decodeSha256(text))
              if (schemaErr._tag !== "Failure") return false
            }
            return true
          }),
        { seed, executions }
      ).pipe(Effect.provide(WebCrypto.layer))
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("digest, digestStream, makeSnapshotSync, and Uuid.v5 handle faulty hosts and invalid inputs cleanly", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        faultKind: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
        badLen: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 })),
        input: Schema.String
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ faultKind, badLen, input }) =>
          Effect.gen(function*() {
            const safeInput = isWellFormed(input) ? input : "fallback"
            const effectiveLen = badLen === 32 ? 31 : badLen
            const badService = EffectDigest.Digest.of({
              digest: () => {
                if (faultKind === 0) throw new Error("sync throw")
                if (faultKind === 1) return "not-an-effect" as unknown as Effect.Effect<Uint8Array>
                if (faultKind === 2) return Effect.fail("host fail") as unknown as Effect.Effect<Uint8Array>
                if (faultKind === 3) return Effect.die(new Error("host die"))
                if (faultKind === 4) return Effect.succeed("not-bytes" as unknown as Uint8Array)
                if (faultKind === 5) return Effect.succeed(new Uint8Array(effectiveLen))
                if (faultKind === 6) {
                  const broken = Object.create(Uint8Array.prototype) as Uint8Array
                  return Effect.succeed(broken)
                }
                return Effect.succeed(new Uint8Array(effectiveLen === 20 ? 19 : effectiveLen))
              },
              digestHex: () => Effect.succeed("")
            })

            const res = yield* Effect.result(
              digest(safeInput).pipe(Effect.provide(Layer.succeed(EffectDigest.Digest, badService)))
            )
            if (res._tag !== "Failure") return false
            const expectedCode = faultKind <= 3 ? "digest_failed" : "invalid_digest"
            if (res.failure.code !== expectedCode) return false
            if (safeInput.length > 8 && res.failure.message.includes(safeInput)) return false

            const streamRes = yield* Effect.result(
              digestStream(Stream.fromIterable([new Uint8Array([1]), "bad" as unknown as Uint8Array]))
            )
            if (streamRes._tag !== "Failure" || streamRes.failure.code !== "invalid_input") return false

            const snapFailEnc = makeSnapshotSync(
              {
                encode: () => {
                  throw new Error("enc boom")
                }
              },
              (code, message, cause) => new Sha256Error({ code, message, cause })
            )
            try {
              snapFailEnc(safeInput)
              return false
            } catch (err) {
              if (!(err instanceof Sha256Error) || err.code !== "text_encoding_failed") return false
            }
            try {
              snapFailEnc(123 as unknown as string)
              return false
            } catch (err) {
              if (!(err instanceof Sha256Error) || err.code !== "invalid_input") return false
            }
            try {
              snapFailEnc(Object.create(Uint8Array.prototype) as Uint8Array)
              return false
            } catch (err) {
              if (!(err instanceof Sha256Error) || err.code !== "invalid_input") return false
            }

            const badNsExit = yield* Effect.exit(Uuid.v5("not-a-uuid", safeInput).pipe(Effect.provide(WebCrypto.layer)))
            if (badNsExit._tag !== "Failure") return false
            const badUuidHost = EffectDigest.Digest.of({
              digest: () => Effect.succeed(new Uint8Array(19)),
              digestHex: () => Effect.succeed("")
            })
            const badUuidExit = yield* Effect.exit(
              Uuid.v5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", safeInput).pipe(
                Effect.provide(Layer.succeed(EffectDigest.Digest, badUuidHost))
              )
            )
            if (badUuidExit._tag !== "Failure") return false

            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("makeDigestPartsSync prefix cache matches digestSync and preserves cache across invalid calls", async () => {
    const digestParts = makeDigestPartsSync()
    const arb = Arbitrary.schema(
      Schema.Struct({
        parts: Schema.Array(Schema.String),
        second: Schema.Array(Schema.String),
        badKind: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ parts, second, badKind }) => {
          const a = parts.slice(0, 8)
          const b = [...a.slice(0, Math.min(2, a.length)), ...second.slice(0, 6)]
          if (!a.every((x) => isWellFormed(x))) {
            try {
              digestParts(a)
              return false
            } catch (err) {
              return err instanceof Sha256Error
            }
          }
          const expectedA = digestSync(a.join(""))
          if (digestParts(a) !== expectedA) return false

          try {
            if (badKind === 0) {
              digestParts("not-an-array" as unknown as ReadonlyArray<string>)
            } else if (badKind === 1) {
              const badLen = new Proxy([], {
                get(_t, prop) {
                  if (prop === "length") return -1
                  return undefined
                }
              })
              digestParts(badLen)
            } else if (badKind === 2) {
              const throwing: Array<string> = ["ok"]
              Object.defineProperty(throwing, 0, {
                get() {
                  throw new Error("boom")
                }
              })
              digestParts(throwing)
            } else if (badKind === 3) {
              digestParts([42 as unknown as string])
            } else {
              const proxyBoom = new Proxy([], {
                get(_t, prop) {
                  if (prop === "length") throw new Error("len boom")
                  return undefined
                }
              })
              digestParts(proxyBoom)
            }
            return false
          } catch (err) {
            if (!(err instanceof Sha256Error) || err.code !== "invalid_input") return false
          }

          if (digestParts(a) !== expectedA) return false
          if (!b.every((x) => isWellFormed(x))) {
            try {
              digestParts(b)
              return false
            } catch (err) {
              return err instanceof Sha256Error
            }
          }
          return digestParts(b) === digestSync(b.join(""))
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Uuid.v5 always produces deterministic RFC 4122 v5 UUIDs", async () => {
    const ns = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
    const arb = Arbitrary.schema(Schema.String)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (name) =>
          Effect.gen(function*() {
            const wellFormed = isWellFormed(name)
            if (!wellFormed) {
              const exit = yield* Effect.exit(Uuid.v5(ns, name))
              return exit._tag === "Failure"
            }
            const u1 = yield* Uuid.v5(ns, name)
            const u2 = yield* Uuid.v5(ns, name)
            const uAlt = yield* Uuid.v5(ns, `${name}!`)
            if (u1 !== u2 || u1 === uAlt) return false
            if (!Uuid.isUuid(u1)) return false
            return u1[14] === "5" && /[89ab]/.test(u1[19]!)
          }),
        { seed, executions }
      ).pipe(Effect.provide(WebCrypto.layer))
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Identity.capture preserves key-order invariance, DAG sharing topology, detachment, nesting, and strict admission", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })),
        num: Schema.Number,
        bool: Schema.Boolean,
        str: Schema.String,
        keys: Schema.Array(Schema.String),
        depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
        rejectKind: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 19 }))
      })
    )
    const nonce1 = Identity.processNonce()
    expect(/^[0-9a-f]{32}$/.test(nonce1)).toBe(true)
    expect(Identity.processNonce()).toBe(nonce1)

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (spec) => {
          const val = buildInert(spec)
          const recordA: Record<string, unknown> = { a: val, b: [spec.bool, null] }
          const recordB: Record<string, unknown> = { b: [spec.bool, null], a: permuteKeys(val) }
          const op = function(this: Readonly<Record<string, unknown>>, x: number) {
            return { seen: this.a, x }
          }

          const wrappedA = Identity.capture(recordA, op)
          const wrappedB = Identity.capture(recordB, op)
          const idA = Identity.functionIdentity(wrappedA)
          const idB = Identity.functionIdentity(wrappedB)
          if (idA.algorithm !== "sha256-source-captures/v5") return false
          if (idA.digest !== idB.digest || idA.resumeDigest !== idB.resumeDigest) return false

          recordA.a = "mutated"
          const resA = wrappedA.call({ a: "hijacked" } as unknown as never, 7)
          const resB = wrappedB(7)
          if (JSON.stringify(resA) !== JSON.stringify(resB)) return false

          const sharedLeaf = { v: spec.bool }
          const sharedWrap = Identity.capture({ x: sharedLeaf, y: sharedLeaf }, op)
          const splitWrap = Identity.capture({ x: { v: spec.bool }, y: { v: spec.bool } }, op)
          if (Identity.functionIdentity(sharedWrap).digest === Identity.functionIdentity(splitWrap).digest) {
            return false
          }

          const negZeroWrap = Identity.capture({ z: -0 }, op)
          const posZeroWrap = Identity.capture({ z: 0 }, op)
          if (Identity.functionIdentity(negZeroWrap).digest === Identity.functionIdentity(posZeroWrap).digest) {
            return false
          }

          const nested1 = Identity.capture({ outer: 1 }, wrappedA)
          const nested2 = Identity.capture({ outer: 2 }, wrappedA)
          if (Identity.functionIdentity(nested1).digest === Identity.functionIdentity(nested2).digest) {
            return false
          }

          const eph1 = (n: number) => n + 1
          const eph2 = (n: number) => n + 1
          const eId1a = Identity.functionIdentity(eph1)
          const eId1b = Identity.functionIdentity(eph1)
          const eId2 = Identity.functionIdentity(eph2)
          if (eId1a.algorithm !== "sha256-source-ephemeral/v4") return false
          if (eId1a.digest !== eId1b.digest || eId1a.digest === eId2.digest) return false
          if (eId1a.resumeDigest !== eId2.resumeDigest) return false
          const nativeId = Identity.functionIdentity(Math.max)
          if (nativeId.resumeDigest !== undefined) return false

          try {
            Identity.functionIdentity("nope")
            return false
          } catch (err) {
            if (!(err instanceof TypeError)) return false
          }

          const expectReject = (fn: () => unknown): boolean => {
            try {
              fn()
              return false
            } catch (err) {
              return err instanceof TypeError
            }
          }

          switch (spec.rejectKind) {
            case 0:
              return expectReject(() => Identity.capture({}, "not-fn" as unknown as () => void))
            case 1:
              return expectReject(() => Identity.capture(null as unknown as Record<string, unknown>, op))
            case 2:
              return expectReject(() => Identity.capture({}, op.bind({})))
            case 3:
              return expectReject(() => Identity.capture({ x: Number.NaN }, op))
            case 4:
              return expectReject(() => Identity.capture({ x: Number.POSITIVE_INFINITY }, op))
            case 5:
              return expectReject(() => Identity.capture({ x: undefined }, op))
            case 6:
              return expectReject(() => Identity.capture({ x: 1n }, op))
            case 7:
              return expectReject(() => Identity.capture({ x: Symbol("s") }, op))
            case 8:
              return expectReject(() => Identity.capture({ x: () => 1 }, op))
            case 9:
              return expectReject(() =>
                Identity.capture({ [Symbol("k")]: 1 } as unknown as Record<string, unknown>, op)
              )
            case 10:
              return expectReject(() =>
                Identity.capture({
                  get x() {
                    return 1
                  }
                }, op)
              )
            case 11: {
              const nonEnum = {}
              Object.defineProperty(nonEnum, "x", { value: 1, enumerable: false })
              return expectReject(() => Identity.capture(nonEnum, op))
            }
            case 12: {
              const sparse: Array<number> = []
              sparse[2] = 1
              return expectReject(() => Identity.capture({ a: sparse }, op))
            }
            case 13:
              return expectReject(() => Identity.capture({ d: new Date() }, op))
            case 14:
              return expectReject(() => Identity.capture({ m: new Map() }, op))
            case 15:
              return expectReject(() => Identity.capture({ e: new Error("e") }, op))
            case 16:
              return expectReject(() => Identity.capture({ p: new Proxy({ a: 1 }, {}) }, op))
            case 17: {
              const cyc: Record<string, unknown> = {}
              cyc.self = cyc
              return expectReject(() => Identity.capture(cyc, op))
            }
            case 18: {
              let deep: Record<string, unknown> = { leaf: 1 }
              for (let i = 0; i < 260; i++) deep = { next: deep }
              return expectReject(() => Identity.capture(deep, op))
            }
            default: {
              const customProto = Object.create({ inherited: 1 }) as Record<string, unknown>
              customProto.x = 1
              return expectReject(() => Identity.capture(customProto, op))
            }
          }
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("sourceShape and resumeDigest are alpha-equivalence invariant across diverse JS syntax constructs", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 })),
        v1: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
        v2: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
        num: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
        flag: Schema.Boolean
      })
    )
    const namesA = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]
    const namesB = ["p_0", "q_1", "r_2", "s_3", "t_4", "u_5"]

    const buildJs = (
      variant: number,
      n: ReadonlyArray<string>,
      num: number,
      flag: boolean
    ): string => {
      const [a, b, c, d, e, f] = n
      const sep = flag ? "\n" : " "
      switch (variant) {
        case 0:
          return `(${a}, { x: ${b} = ${num}, [${a}]: ${c} = [${d}, ...${e}] }) => { const ${f} = ${b} + ${d}; return ${f} ? { bx: ${b}, k: ${c} } : ${e} }`
        case 1:
          return `async function ${a}(${b}, ...${c}) { /* block comment */ let ${d} = await ${b}; // line comment\n if (${d}) { const ${e} = \`t\${${d} + ${num}}z\`; return ${e} } return ${c} }`
        case 2:
          return `function* ${a}(${b}) { for (const ${c} of ${b}) { yield ${c} / 2; } for (let ${d} in ${b}) { if (${d}) continue; } }`
        case 3:
          return `(${a}) => { try { const ${b} = /ab[c/d]\\/e/gi.test(${a}); return ${b} } catch (${c}) { throw ${c} } finally { void 0 } }`
        case 4:
          return `(${a}) => { class ${b} extends Array { static get tag() { return "${num}" } #p = ${num}; method(${c}) { return this.#p + ${c} } } return new ${b}(${a}) }`
        case 5:
          return `(${a}, ${b}) => { var ${c} = 0x1f + 0b101 + 0o77 + 1_000e+2 + .5 + ${num}n.toString().length; lbl: while (${c} > 0) { if (${a}) break lbl; ${c}-- } return ${b} }`
        case 6:
          return `(${a}) => { switch (${a}) { case 1: { const ${b} = Math.max(${a}, ${num}); return ${b} } default: return JSON.stringify({ key: ${a} }) } }`
        case 7:
          return `async (${a}) => { const ${b} = async ${c} => ${c} ?? ${a}; const ${d} = (${e}) => ({ val: ${e}, m(${f}) { return ${f} } }); return [await ${b}(${num}), ${d}(${a})] }`
        case 8:
          return `function ${a}(${b}) { const ${c} = ${b}?.x?.[${num}] ?? 'str\\'s\\n' + "dq\\"s"; return (${b}) => (${b} + ${c}) }`
        case 9:
          return `(${a}, ${b}) => { const [${c}, , ${d} = ${a}] = ${b}; function ${e}(${f}) { return ${f} + ${c} + ${d} } return ${e}(${num}) }`
        case 10:
          return `(${a}) => { try { return ${a}() } catch { return ${num} } }`
        case 11:
          return `(${a}) => { for (let ${b} = 0, ${c} = ${num}; ${b} < ${c}; ${b}++) { ${a} += ${b} } return ${a} }`
        case 12:
          return `(${a}, ${b}) => { const ${c} = class ${d} { static prop = ${num}; set val(${f}) { this._v = ${f} } }; return ${a} === ${b} ? ${c} : ({ a: ${a}, b: ${b} }) }`
        case 13:
          return `(${a}) => { return ${a} + ${sep} (${a} ? /foo/u.source : (${num}) / 2) + \\u0061 }`
        case 14:
          return `(${a}, ${b}) => { const { a: [${c} = ({ x: ${d} } = ${b})] } = ${a}; return typeof ${c} === "object" ? ${d} : ${b} }`
        default:
          return `(${a}, ${b}) => ({ get x() { return ${a} }, set x(${c}) { void ${c} }, async *g(${d}) { yield await ${d} + ${b} }, [${a}]: ${num} })`
      }
    }

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ variant, v1, v2, num, flag }) => {
          const rotA = [...namesA.slice(v1), ...namesA.slice(0, v1)]
          const rotB = [...namesB.slice(v2), ...namesB.slice(0, v2)]
          const srcA = buildJs(variant, rotA, num, flag)
          const srcB = buildJs(variant, rotB, num, !flag)
          const shapeA = sourceShape(srcA)
          const shapeB = sourceShape(srcB)
          if (shapeA !== shapeB) return false
          if (sourceShape(srcA) !== shapeA) return false
          if (variant !== 13) {
            const fnA = (0, eval)(`(${srcA})`) as Function
            const fnB = (0, eval)(`(${srcB})`) as Function
            const idA = Identity.functionIdentity(fnA)
            const idB = Identity.functionIdentity(fnB)
            if (idA.resumeDigest !== idB.resumeDigest) return false
          }
          return true
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("sourceShape is total and deterministic on arbitrary strings and exotic token sequences", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        raw: Schema.String,
        tokens: Schema.Array(
          Schema.Literals([
            "function",
            "async",
            "class",
            "const",
            "let",
            "var",
            "for",
            "of",
            "in",
            "try",
            "catch",
            "if",
            "else",
            "while",
            "switch",
            "case",
            "return",
            "yield",
            "break",
            "continue",
            "throw",
            "get",
            "set",
            "static",
            "extends",
            "new",
            "=>",
            "(",
            ")",
            "{",
            "}",
            "[",
            "]",
            ";",
            ",",
            ":",
            "?",
            ".",
            "...",
            "?.",
            "++",
            "--",
            "===",
            "!==",
            "??=",
            ">>>=",
            "**=",
            "/",
            "/re[a]/g",
            "`a${x}b`",
            "'s'",
            "\"d\"",
            "//c\n",
            "/*b*/",
            "\r\n",
            "\u2028",
            "\u2029",
            "#p",
            "\\u{61}",
            "\\u0062",
            "0x1a",
            "1e-3",
            "42n",
            "a",
            "b",
            "c",
            "Math",
            "this"
          ])
        )
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ raw, tokens }) => {
          const s1 = sourceShape(raw)
          if (typeof s1 !== "string" || sourceShape(raw) !== s1) return false
          const joined = tokens.slice(0, 24).join(" ")
          const s2 = sourceShape(joined)
          if (typeof s2 !== "string" || sourceShape(joined) !== s2) return false
          return true
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
