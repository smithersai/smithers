import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as ZigDraft from "../src/closure/zig/Draft.ts"
import * as ZigGraph from "../src/closure/zig/Graph.ts"
import * as ZigManifest from "../src/closure/zig/Manifest.ts"
import * as ZigProtocol from "../src/closure/zig/Protocol.ts"
import * as ZigZon from "../src/closure/zig/Zon.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/ci closure/zig ZON parser, binary Protocol, binary Manifest, SipHash-128, Graph & Draft fuzz invariants", () => {
  it("Zon.parse, Protocol.decodeBuild/decodeCompile, Manifest.decode/sipHash128, Graph & Draft never crash on arbitrary ZON or binary inputs", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        zonText: Schema.Literals([
          `.{ .name = "demo", .version = "0.1.0", .paths = .{ "src", "build.zig" }, .flag = true, .n = 42 }`,
          `.{ .steps = .{ .{ .name = "install", .kind = "top_level", .deps = .{} } } }`,
          `.{ .a = 1, .b = null, .c = false }`,
          `"hello\\nworld"`,
          `.{ broken`,
          ""
        ]),
        rawZon: Schema.String.check(Schema.isMaxLength(60)),
        rawBytes: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(
          Schema.isMaxLength(64)
        ),
        steps: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }))).check(
          Schema.isMaxLength(5)
        ),
        hashPath: Schema.Literals([
          "zig-cache/o/0123456789abcdef0123456789abcdef/out",
          "c/fedcba9876543210fedcba9876543210/file.o",
          "plain/file.zig"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ zonText, rawZon, rawBytes, steps, hashPath }) =>
          Effect.sync(() => {
            const p1 = ZigZon.parse(zonText)
            if (p1.ok) {
              ZigZon.field(p1.value, "name")
              ZigZon.list(ZigZon.field(p1.value, "paths"))
              const g = ZigGraph.read(p1.value)
              if (g !== undefined) {
                ZigGraph.find(g, "install")
                if (g.steps.length > 0) {
                  ZigGraph.reach(g, 0)
                  ZigGraph.grouped(g, 0)
                }
              }
            }
            ZigZon.parse(rawZon)

            const req = ZigProtocol.buildRequest(steps)
            if (req.byteLength === 0) return false
            const bytes = Uint8Array.from(rawBytes)
            ZigProtocol.decodeBuild(bytes)
            ZigProtocol.decodeCompile(bytes)
            const joined = ZigProtocol.join([bytes, new Uint8Array([1, 2])])
            if (joined.byteLength !== bytes.byteLength + 2) return false
            ZigProtocol.utf8(bytes)

            ZigManifest.decode(bytes)
            const key = new Uint8Array(16)
            for (let i = 0; i < 16; i++) key[i] = (rawBytes[i] ?? i) & 0xff
            const h1 = ZigManifest.sipHash128(key, bytes)
            const h2 = ZigManifest.sipHash128(key, bytes)
            if (h1.byteLength !== 16) return false
            for (let i = 0; i < 16; i++) {
              if (h1[i] !== h2[i]) return false
            }
            ZigManifest.prefix(steps[0] ?? 0)
            const outId = ZigDraft.outputOf(hashPath)
            if (outId !== undefined && !ZigManifest.isName(outId)) return false
            const d = ZigDraft.make("build")
            const closed = ZigDraft.close("zig", d, new Map())
            return closed.strategy === "zig"
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
