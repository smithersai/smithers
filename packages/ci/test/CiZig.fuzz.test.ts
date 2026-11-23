import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Graph from "../src/closure/zig/Graph.ts"
import * as Manifest from "../src/closure/zig/Manifest.ts"
import * as Protocol from "../src/closure/zig/Protocol.ts"
import * as Zon from "../src/closure/zig/Zon.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "2000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/ci Zig parsers (ZON, Graph, Manifest, Protocol) fuzz invariants", () => {
  it("Zon.parse and Graph.read never throw defects on arbitrary text or structured ZON documents", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        raw: Schema.String,
        name: Schema.String,
        num: Schema.Int.check(Schema.isBetween({ minimum: -1000, maximum: 1000 })),
        flag: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ raw, name, num, flag }) => {
          const parsedRaw = Zon.parse(raw)
          if (parsedRaw.ok) {
            const _g = Graph.read(parsedRaw.value)
            void _g
          }
          const safeName = name.replace(/[^a-zA-Z0-9_]/g, "a").slice(0, 16) || "step"
          const validZon = `.{ .name = "${safeName}", .count = ${num}, .ok = ${flag}, .items = .{ 1, 2, 3 } }`
          const parsedValid = Zon.parse(validZon)
          if (!parsedValid.ok) return false
          return (
            Zon.field(parsedValid.value, "name") === safeName &&
            Zon.field(parsedValid.value, "count") === num &&
            Zon.field(parsedValid.value, "ok") === flag &&
            Zon.list(Zon.field(parsedValid.value, "items")).length === 3
          )
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Manifest.decode, sipHash128, and Protocol binary decoders never panic on arbitrary byte buffers", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        bytes: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
        key: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ bytes, key }) => {
          const buf = new Uint8Array(bytes.slice(0, 256))
          const k = new Uint8Array(16)
          for (let i = 0; i < 16; i++) k[i] = key[i] ?? i

          const decoded = Manifest.decode(buf)
          if (decoded !== undefined && !Array.isArray(decoded)) return false

          const h1 = Manifest.sipHash128(k, buf)
          const h2 = Manifest.sipHash128(k, buf)
          if (h1.length !== 16 || h2.length !== 16) return false
          for (let i = 0; i < 16; i++) {
            if (h1[i] !== h2[i]) return false
          }

          const b = Protocol.decodeBuild(buf)
          const c = Protocol.decodeCompile(buf)
          return b !== undefined && c !== undefined
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
