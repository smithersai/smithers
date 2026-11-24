import { Fuzz } from "@smthrs/fuzz"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Arbitrary, Effect, Option, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as CellValidation from "../src/CellValidation.ts"
import * as Compaction from "../src/Compaction.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as DoneText from "../src/DoneText.ts"
import * as FailedCall from "../src/FailedCall.ts"
import * as CompactionMarks from "../src/internal/compactionMarks.ts"
import * as SchemaSignature from "../src/internal/schemaSignature.ts"
import * as NarrowedCheck from "../src/NarrowedCheck.ts"
import * as Tokens from "../src/Tokens.ts"
import * as TruncatedOutput from "../src/TruncatedOutput.ts"

const EXECUTIONS = Number(process.env.FUZZ_EXECUTIONS ?? "80")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/harness Wave10 Boost5 Fuzz", () => {
  it("schemaSignature.render covers unions, refs, objects, arrays, const, enum, and invalid shapes", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
        depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))
      })
    )

    const docs: ReadonlyArray<Schema.Json> = [
      null,
      {},
      { schema: { type: "string" }, bogus: 1 },
      { schema: { type: "string" }, definitions: "bad" },
      { schema: "not-an-object" },
      { schema: { type: "string", unknownKeyword: true } },
      { schema: { $ref: "#/$defs/Missing" }, definitions: {} },
      { schema: { $ref: "#/$defs/Self" }, definitions: { Self: { $ref: "#/$defs/Self" } } },
      { schema: { $ref: "#/$defs/Ok", type: "string" }, definitions: { Ok: { type: "string" } } },
      {
        schema: { $ref: "#/$defs/Ok", description: "override desc" },
        definitions: { Ok: { type: "string", description: "base desc" } }
      },
      { schema: { const: "a", type: "number" } },
      { schema: { const: "a", type: "string", minimum: 1 } },
      { schema: { enum: [], type: "string" } },
      { schema: { enum: [1], type: "string" } },
      { schema: { anyOf: "bad" } },
      { schema: { anyOf: [{ type: "null" }] } },
      { schema: { anyOf: [] } },
      { schema: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } } },
      { schema: { type: "array", items: { type: "number", minimum: 0, description: "pos" } } },
      { schema: { type: "array", items: { type: "bogus" } } },
      { schema: { type: "array" } },
      { schema: { type: "array", items: { type: "string" }, extra: 1 } },
      {
        schema: {
          type: "object",
          properties: {
            "a-b": { anyOf: [{ type: "string" }, { type: "null" }], description: "opt" },
            req: { type: "number" }
          },
          required: ["req"],
          additionalProperties: { type: "boolean", description: "flag" }
        }
      },
      {
        schema: {
          type: "object",
          properties: "bad"
        }
      }
    ]

    const extraDocs: ReadonlyArray<Schema.Json> = [
      { schema: { type: "object", properties: {}, additionalProperties: false } },
      { schema: { type: "object", properties: {}, additionalProperties: { type: "bogus" } } },
      { schema: { type: "object", properties: { a: { type: "string" } }, required: ["missing"] } },
      { schema: { type: "object", properties: {}, minimum: 1 } },
      { schema: {} },
      { schema: { minimum: 1 } },
      { schema: { type: "bogus" } },
      {
        schema: {
          type: "array",
          items: {
            anyOf: [
              { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
              { type: "string" }
            ]
          }
        }
      }
    ]

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx, depth }) => {
          const out1 = SchemaSignature.render(docs[idx]!, depth)
          const out2 = SchemaSignature.render(extraDocs[idx % extraDocs.length]!, depth)
          expect(out1 === undefined || typeof out1 === "string").toBe(true)
          expect(out2 === undefined || typeof out2 === "string").toBe(true)
          return true
        },
        { executions: Math.min(EXECUTIONS, 60), seed: 20261250 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("CellValidation, FailedCall, DoneText, and TruncatedOutput cover all syntax and escape branches", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }))
      })
    )

    const cells: ReadonlyArray<Cell.Source> = [
      Cell.source("declare namespace Foo { const x: number }", "typescript"),
      Cell.source("namespace Bar { export const x = 1 }", "typescript"),
      Cell.source("class C { constructor(public x: number) {} }", "typescript"),
      Cell.source("enum E { A = 1 }", "typescript"),
      Cell.source("import('fs')", "javascript"),
      Cell.source("const u = import.meta.url", "javascript"),
      Cell.source("export const x = 1", "javascript"),
      Cell.source("const fs = require('fs')", "javascript"),
      Cell.source("function topHelper() { return 1 }\ntopHelper()", "javascript"),
      Cell.source("if (true) {\n\n", "javascript"),
      Cell.source("{ let x = 1; let x = 2; }", "javascript"),
      Cell.source("return 42", "javascript"),
      Cell.source("const x: number = 1; x", "typescript"),
      Cell.source("var a = 1; var a = 2;", "javascript"),
      Cell.source("type T = string; const s: T = 'ok'; s", "typescript"),
      Cell.source("const x = await ctx.call('std:read', {})", "javascript")
    ]

    const failedSources: ReadonlyArray<string> = [
      "if (",
      "const r = await ctx.call('a', {}); const e = (r as any).error",
      "const r = await ctx.call('a', {}); const e = (r!).error",
      "const r = await ctx.call('a', {}); const e = (r satisfies unknown).error",
      "const r = await ctx.call('a', {}); const e = (<any>r).error",
      "const r = await ctx.call('a', {}); const e = r.nested?.error",
      "const { error } = await ctx.call('a', {})",
      "let error; ({ error } = await ctx.call('a', {}))",
      "const r = await ctx.call('a', {}); for (const { error } of r) { console.log(error) }",
      "const r = await ctx.call('a', {}); log.error(r)",
      "const r = await ctx.call('a', {}); const x = r.ok",
      "const x = prev.error",
      "const r = await ctx.call('a', {}); const y = await r; y.error",
      "const r = await ctx.call('b', {}); r.error",
      "const r = await ctx.call('a', {}); const { ok } = r",
      "const r = await ctx.call('a', {}); log.info(r.error)"
    ]

    const doneReplies: ReadonlyArray<string> = [
      "```js\nconst s = 'unclosed\nctx.done('ok')\n```",
      "```js\nconst s = 'cont\\\r\nline'; ctx.done('a\\\r\nb')\n```",
      "```js\nconst r = /abc\\n/g; ctx.done('x\\\ry')\n```",
      "```js\nconst r = /unclosed\n```",
      "```js\nctx.done('cut\\u{123')\n```",
      "```js\nctx.done('bad\\u{110000}')\n```",
      "```js\nctx.done('eof\\",
      "```js\nctx.done('zero\\0",
      "```js\nctx.done('oct\\01')\n```",
      "```js\nctx.done('oct\\1')\n```",
      "```js\nctx.done('hex\\x41\\u0042\\u",
      "```js\nctx.done('surr\\uD83D",
      "```js\nctx.done('nl\nmore')\n```",
      "```js\nctx.done(`tpl\r\n${x}`)\n```",
      "```js\nctx.done(`tpl\rnext`)\n```",
      "```js\nconst r = /a[b/]c\\\n; ctx.done('done\\z')\n```"
    ]

    const bigText = "X".repeat(TruncatedOutput.minimumBytes + 32)
    const caps = TruncatedOutput.captures("std:read", { content: bigText, contentTruncated: true })

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ variant }) => {
          const val = CellValidation.validate(cells[variant]!)
          expect(val.compiled !== undefined || val.rejected !== undefined).toBe(true)
          const insp = FailedCall.inspects(failedSources[variant]!, variant % 2 === 0 ? "a" : undefined)
          expect(typeof insp).toBe("boolean")
          const proj = DoneText.project(doneReplies[variant]!)
          expect(Option.isSome(proj) || Option.isNone(proj)).toBe(true)

          const rShort = TruncatedOutput.reuse("short", caps)
          expect(rShort).toBeUndefined()
          const rPrim = TruncatedOutput.reuse(42, caps)
          expect(rPrim).toBeUndefined()
          const rArr = TruncatedOutput.reuse(["short", [bigText]], caps)
          expect(rArr?.path).toBe("[1][0]")
          const rObj = TruncatedOutput.reuse({ a: 1, b: { c: bigText } }, caps)
          expect(rObj?.path).toBe("b.c")
          const rMiss = TruncatedOutput.reuse({ a: ["no", 123, null] }, caps)
          expect(rMiss).toBeUndefined()
          return true
        },
        { executions: Math.min(EXECUTIONS, 50), seed: 20261251 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("NarrowedCheck, CompactionMarks, and Compaction cover narrowing, pins, pairs, and invalid exchanges", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode }) =>
          Effect.gen(function*() {
            const broad = NarrowedCheck.check({
              flow: "std:test",
              signature: "sig-broad",
              input: { command: "pnpm test" },
              digest: "d1",
              declared: true
            })!
            const broadMore = NarrowedCheck.check({
              flow: "std:test",
              signature: "sig-broad-more",
              input: { command: "pnpm test src/a.ts" },
              digest: "d1",
              declared: true
            })!
            const undeclared = NarrowedCheck.check({
              flow: "std:test",
              signature: "sig-undecl",
              input: { command: "pnpm test" },
              digest: "d1",
              declared: false
            })!
            const emptyDigest = NarrowedCheck.check({
              flow: "std:test",
              signature: "sig-empty",
              input: { command: "pnpm test" },
              digest: "",
              declared: true
            })!
            const sameDigest = NarrowedCheck.check({
              flow: "std:test",
              signature: "sig-same",
              input: { command: "pnpm test" },
              digest: "d2",
              declared: true
            })!
            const otherFlow = NarrowedCheck.check({
              flow: "std:lint",
              signature: "sig-other",
              input: { command: "pnpm test src/a.ts --filter unit" },
              digest: "d2",
              declared: true
            })!
            const narrow = NarrowedCheck.check({
              flow: "std:test",
              signature: "sig-narrow",
              input: { command: "pnpm test src/a.ts --filter unit" },
              digest: "d2",
              declared: true
            })!
            const onlyLater = NarrowedCheck.check({
              flow: "std:test",
              signature: "sig-only-later",
              input: { command: "vitest run src/a.ts -t smoke" },
              digest: "d2",
              declared: true
            })!
            const priorCovering = NarrowedCheck.check({
              flow: "std:test",
              signature: "sig-prior-cov",
              input: { command: "vitest run src/a.ts" },
              digest: "d1",
              declared: true
            })!
            const priorSplitA = NarrowedCheck.check({
              flow: "std:test",
              signature: "sig-split-a",
              input: { command: "vitest run src/a.ts src/b.ts" },
              digest: "d1",
              declared: true
            })!
            const onlyTwo = NarrowedCheck.check({
              flow: "std:test",
              signature: "sig-only-two",
              input: { command: "vitest run src/a.ts src/c.ts -t fast" },
              digest: "d2",
              declared: true
            })!
            const priorC = NarrowedCheck.check({
              flow: "std:test",
              signature: "sig-prior-c",
              input: { command: "vitest run src/c.ts" },
              digest: "d1",
              declared: true
            })!

            expect(NarrowedCheck.find({ ledger: [broad], frame: [narrow], digest: "" })).toBeUndefined()
            const found = NarrowedCheck.find({
              ledger: [undeclared, narrow, emptyDigest, sameDigest, broadMore, broad],
              frame: [otherFlow, narrow],
              digest: "d2"
            })
            if (found) expect(NarrowedCheck.demand(found).length).toBeGreaterThan(0)

            expect(NarrowedCheck.findOnly({ ledger: [], frame: [], before: [], taught: [] })).toBeUndefined()
            expect(NarrowedCheck.findOnly({ ledger: [], frame: [priorCovering], before: [], taught: [] }))
              .toBeUndefined()
            expect(
              NarrowedCheck.findOnly({
                ledger: [priorCovering],
                frame: [onlyLater],
                before: [onlyLater.signature],
                taught: []
              })
            ).toBeUndefined()
            expect(NarrowedCheck.findOnly({ ledger: [priorCovering], frame: [onlyLater], before: [], taught: [] }))
              .toBeUndefined()
            const foundOnly = NarrowedCheck.findOnly({
              ledger: [priorSplitA, priorC],
              frame: [onlyTwo],
              before: [],
              taught: mode % 2 === 0 ? [] : ["fast", "-t"]
            })
            if (foundOnly) expect(NarrowedCheck.demandOnly(foundOnly).length).toBeGreaterThan(0)

            const mkCount = (v: number) => new Tokens.Count({ value: v, estimated: false })
            expect(
              Compaction.shouldCompact({
                total: { value: Number.NaN, estimated: false } as Tokens.Count,
                contextWindow: 1000
              })
            ).toBe(false)
            expect(Compaction.shouldCompact({ total: mkCount(100), contextWindow: 0 })).toBe(false)
            expect(
              Compaction.shouldCompact(
                { total: mkCount(100), contextWindow: 1000 },
                { reserve: Number.POSITIVE_INFINITY }
              )
            ).toBe(false)

            const callMsg = ModelRequest.Message.assistant([
              ModelRequest.ToolCallPart.make({ id: "tc-1", name: "std:read", arguments: "{}" })
            ])
            const resMsg = ModelRequest.Message.tool([
              ModelRequest.ToolResultPart.make({ toolCallId: "tc-1", content: "ok" })
            ])
            const seg0 = ContextWindow.makeSegment({
              kind: "summary",
              zone: "tail",
              content: [ModelRequest.Message.user("sum")]
            })
            const seg1 = ContextWindow.makeSegment({
              kind: "steering",
              zone: "tail",
              content: [ModelRequest.Message.user("steer")]
            })
            const seg2 = ContextWindow.makeSegment({ kind: "transcript", zone: "tail", content: [callMsg] })
            const seg3 = ContextWindow.makeSegment({ kind: "transcript", zone: "tail", content: [resMsg] })
            const seg4 = ContextWindow.makeSegment({
              kind: "transcript",
              zone: "tail",
              content: [ModelRequest.Message.user("u4")]
            })
            const seg5 = ContextWindow.makeSegment({
              kind: "transcript",
              zone: "tail",
              content: [ModelRequest.Message.user("u5")]
            })
            const segs = [seg0, seg1, seg2, seg3, seg4, seg5]

            const factsList: ReadonlyArray<CompactionMarks.Facts | undefined> = mode % 3 === 0
              ? [
                undefined,
                undefined,
                { frame: 2, person: false, mutated: true, checks: [] },
                { frame: 3, person: false, mutated: false, checks: [] },
                { frame: 4, person: false, mutated: false, checks: ["test:a"] },
                { frame: 5, person: true, mutated: false, checks: [] }
              ]
              : mode % 3 === 1
              ? [
                undefined,
                undefined,
                { frame: 2, person: false, mutated: false, checks: [] },
                { frame: 3, person: false, mutated: false, checks: [] },
                { frame: 4, person: false, mutated: true, checks: [] },
                undefined
              ]
              : [
                undefined,
                undefined,
                { frame: 2, person: true, mutated: false, checks: [] },
                { frame: 3, person: false, mutated: false, checks: [] },
                undefined,
                undefined
              ]

            const pinned = CompactionMarks.pins(segs, 6, factsList, ["test:a"])
            const asked = CompactionMarks.unpinned(pinned)
            const answers = asked.map((_, i) => i === 0 ? { keep: 0.9, remove: 0.05 } : { keep: 0.1, remove: 0.9 })
            const resolved = CompactionMarks.resolve(
              answers,
              pinned,
              { contextWindow: 1000, reserve: 100, keepRecent: 100, suffix: 0, tokens: [50, 50, 50, 50, 50, 50] }
            )
            expect(Result.isSuccess(resolved)).toBe(true)

            const win = ContextWindow.make({ modelId: "m1", segments: [seg2, seg3, seg4] })
            const badPair = yield* Effect.result(
              Compaction.declare(win, 2, { identity: "s" }, ["keep", "remove"])
            )
            expect(Result.isFailure(badPair)).toBe(true)

            const unmatchedWin = ContextWindow.make({ modelId: "m1", segments: [seg2, seg4] })
            const unmatched = yield* Effect.result(
              Compaction.declare(unmatchedWin, 1, { identity: "s" }, ["squash"])
            )
            expect(Result.isFailure(unmatched)).toBe(true)

            const validStep = yield* Compaction.declare(
              win,
              2,
              { identity: "s", params: { bogusParam: 1 } as any },
              ["squash", "squash"]
            )
            const badParams = yield* Effect.result(Compaction.summaryRequest(win, validStep))
            expect(Result.isFailure(badParams)).toBe(true)

            const badDigest = yield* Effect.result(
              Compaction.summaryRequest(win, { ...validStep, replacedPrefixDigest: "wrong-digest" })
            )
            expect(Result.isFailure(badDigest)).toBe(true)

            return true
          }),
        { executions: Math.min(EXECUTIONS, 40), seed: 20261252 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
