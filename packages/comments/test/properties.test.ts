import { describe, expect, it } from "@effect/vitest"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Anchor, Cache, Lexer, Sidecar, VirtualFile } from "../src/index.ts"

const safeIdChar = "abcdefghijklmnopqrstuvwxyz0123456789-_"

const EntrySeedSchema = Schema.Struct({
  id: Schema.String,
  anchorKind: Schema.Literals(["file", "symbol", "line", "pattern"]),
  symbol: Schema.String,
  line: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
  pattern: Schema.String,
  placement: Schema.Literals(["before", "inline", "after"]),
  style: Schema.Literals(["line", "block", "doc"]),
  hasHash: Schema.Boolean,
  hashSeed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffffffff })),
  body: Schema.String
})

const toSidecarEntry = (r: typeof EntrySeedSchema.Type, idx: number): Sidecar.SidecarEntry => {
  const cleanIdBase = r.id.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 16)
  const id = `${/^[a-zA-Z0-9]/.test(cleanIdBase) ? cleanIdBase : "c"}${idx}`
  const symBase = r.symbol.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 14)
  const sym = /^[a-zA-Z_]/.test(symBase) ? symBase : `fn_${idx}`
  const pat = r.pattern.replace(/[\r\n]/g, " ").trim().slice(0, 24) || "const x"
  const anchor: Anchor.AnchorSpec = r.anchorKind === "file"
    ? { kind: "file" }
    : r.anchorKind === "symbol"
    ? { kind: "symbol", symbol: sym }
    : r.anchorKind === "line"
    ? { kind: "line", line: r.line }
    : { kind: "pattern", pattern: pat }
  const body = r.body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim() || "note"
  const hashHex = (r.hashSeed >>> 0).toString(16).padStart(8, "0").slice(0, 8)
  return {
    id,
    anchor,
    ...(r.anchorKind === "symbol" || r.anchorKind === "pattern" ? { line: r.line } : {}),
    placement: r.placement,
    style: r.style,
    ...(r.hasHash ? { codeHash: hashHex } : {}),
    body
  }
}

describe("Property tests", () => {
  it.effect("Sidecar round-trip: parseSidecar(formatSidecar(doc)) === doc for arbitrary valid documents", () =>
    Effect.gen(function*() {
      const arb = Arbitrary.schema(Schema.Array(EntrySeedSchema))
      const res = yield* Arbitrary.checkEffect(
        arb,
        (rawEntries) =>
          Effect.gen(function*() {
            const entries = rawEntries.slice(0, 8).map(toSidecarEntry)
            const doc: Sidecar.SidecarDocument = {
              source: "src/generated.ts",
              version: 1,
              entries
            }
            const formatted = Sidecar.formatSidecar(doc)
            const parsed = yield* Sidecar.parseSidecar(formatted)
            return JSON.stringify(parsed) === JSON.stringify(doc)
          }),
        { seed: 101, runs: 100 }
      )
      expect(Arbitrary.formatCheckFailure(res)).toBeUndefined()
    }))

  it.effect("Lexer byte-offset invariant: every comment span slices cleanly within source and never overlaps", () =>
    Effect.gen(function*() {
      const LinePiece = Schema.Literals([
        "const x = 1",
        "const s = \"// in string\"",
        "const t = `tpl ${1} /* no */`",
        "// line comment here",
        "/* block comment */",
        "/** doc comment */",
        "// @ts-expect-error keep",
        "export function fn(a: number) { return a + 1 }"
      ])
      const arb = Arbitrary.schema(Schema.Array(LinePiece))
      const res = yield* Arbitrary.checkEffect(
        arb,
        (lines) => {
          const source = lines.slice(0, 15).join("\n") + "\n"
          const lexed = Lexer.lexComments(source, "src/prop.ts")
          let cursor = 0
          for (const c of lexed.comments) {
            if (c.startOffset < cursor) return false
            if (c.endOffset <= c.startOffset || c.endOffset > source.length) return false
            if (source.slice(c.startOffset, c.endOffset) !== c.raw) return false
            cursor = c.endOffset
          }
          return true
        },
        { seed: 202, runs: 120 }
      )
      expect(Arbitrary.formatCheckFailure(res)).toBeUndefined()
    }))

  it.effect("Extract -> VirtualFile projection preserves all non-comment code lines and pragmas", () =>
    Effect.gen(function*() {
      const arb = Arbitrary.schema(
        Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999 })))
      )
      const res = yield* Arbitrary.checkEffect(
        arb,
        (nums) =>
          Effect.gen(function*() {
            const uniqueNums = [...new Set(nums)].slice(0, 5)
            if (uniqueNums.length === 0) return true
            const names = uniqueNums.map((n) => `fn_${n}`)
            const lines: Array<string> = ["// SPDX-License-Identifier: MIT"]
            for (const name of names) {
              lines.push(`// Explains why ${name} exists`)
              lines.push(`export function ${name}() { return 1 }`)
            }
            const original = lines.join("\n") + "\n"
            const stripped = Lexer.stripProseComments(original, "src/mod.ts")
            if (stripped.extracted.length !== names.length) return false
            if (stripped.preservedPragmas.length !== 1) return false
            if (!stripped.code.includes("SPDX-License-Identifier: MIT")) return false
            for (const name of names) {
              if (!stripped.code.includes(`export function ${name}() { return 1 }`)) return false
            }

            const entries: Array<Sidecar.SidecarEntry> = stripped.extracted.map((c, idx) => {
              const inferred = Anchor.inferAnchor(stripped.code, "c-style", c)
              return {
                id: `c_${idx}_${safeIdChar[idx % safeIdChar.length]}`,
                anchor: inferred.anchor,
                line: inferred.line,
                placement: inferred.placement,
                style: c.style,
                codeHash: inferred.codeHash,
                body: c.body
              }
            })

            const vf = yield* VirtualFile.projectFile(
              stripped.code,
              { source: "src/mod.ts", version: 1, entries },
              "src/mod.ts"
            )
            const relexed = Lexer.lexComments(vf.content, "src/mod.ts")
            const extractedBodies = stripped.extracted.map((c) => c.body)
            const relexedBodies = relexed.comments.filter((c) => !c.isPragma).map((c) => c.body)
            return (
              JSON.stringify(relexedBodies) === JSON.stringify(extractedBodies) &&
              relexed.comments.filter((c) => c.isPragma).length === 1
            )
          }),
        { seed: 303, runs: 80 }
      )
      expect(Arbitrary.formatCheckFailure(res)).toBeUndefined()
    }))

  it.effect("Cache key determinism and strict sensitivity to body, code region, and rubric", () =>
    Effect.gen(function*() {
      const TripleSchema = Schema.Struct({
        body: Schema.String,
        code: Schema.String,
        rubric: Schema.String
      })
      const arb = Arbitrary.schema(TripleSchema)
      const res = yield* Arbitrary.checkEffect(
        arb,
        ({ body, code, rubric }) => {
          const base: Cache.CacheKeyInput = {
            path: "src/a.ts",
            language: "c-style",
            mode: "inline",
            commentId: "c1",
            commentStyle: "line",
            commentBody: body,
            anchoredCodeRegion: code,
            rubric,
            modelId: "default"
          }
          const k1 = Cache.computeCacheKey(base)
          const k2 = Cache.computeCacheKey({ ...base })
          if (k1 !== k2 || !/^[0-9a-f]{64}$/.test(k1)) return false
          const kBody = Cache.computeCacheKey({ ...base, commentBody: body + "!" })
          const kCode = Cache.computeCacheKey({ ...base, anchoredCodeRegion: code + "!" })
          const kRubric = Cache.computeCacheKey({ ...base, rubric: rubric + "!" })
          return kBody !== k1 && kCode !== k1 && kRubric !== k1
        },
        { seed: 404, runs: 100 }
      )
      expect(Arbitrary.formatCheckFailure(res)).toBeUndefined()
    }))

  it.effect("VirtualFile.projectFile is deterministic across repeated projections", () =>
    Effect.gen(function*() {
      const code = "export const alpha = 1\nexport const beta = 2\n"
      const doc: Sidecar.SidecarDocument = {
        source: "src/det.ts",
        version: 1,
        entries: [
          { id: "e1", anchor: { kind: "line", line: 1 }, placement: "before", style: "line", body: "Alpha note" },
          { id: "e2", anchor: { kind: "line", line: 2 }, placement: "inline", style: "line", body: "Beta note" }
        ]
      }
      const a = yield* VirtualFile.projectFile(code, doc, "src/det.ts")
      const b = yield* VirtualFile.projectFile(code, doc, "src/det.ts")
      expect(a).toEqual(b)
    }))
})
